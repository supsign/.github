/**
 * Zentrale Auto-Merge-Policy fuer Dependabot-PRs aller supsign-Repos.
 * Aufgerufen von action.yml im selben Verzeichnis, Regeln siehe README.md.
 *
 * Ein PR wird nur automatisch gemergt, wenn beide Pruefungen bestehen:
 *
 * A) Die Metadaten aus fetch-metadata. Das sind die Pakete, die Dependabot
 *    angefordert hat, jedes wird einzeln geprueft:
 *    - patch                                   -> ok
 *    - minor                                   -> ok, ausser MAX_UPDATE=patch
 *    - major oder unbekannter Update-Typ       -> manuelles Review
 *
 * B) Der Lock-Diff: composer.lock und package-lock.json im Update-Verzeichnis,
 *    Base-Branch gegen Test-Merge-Commit, also genau das, was der Merge in
 *    main aendert. Beim Neuaufloesen zieht Composer bzw. npm im
 *    transitiven Baum Dinge mit, die in keinen Metadaten stehen (gesehen:
 *    symfony/console v8 -> v7 in einem "Patch"-PR, undici 8 -> 7 und
 *    nx 22 -> 23 in einem Security-PR). Fuer jedes
 *    Paket, das A nicht mit genau diesen Versionen gemeldet hat:
 *    - Major, Downgrade                        -> manuelles Review
 *    - 0.x-Sprung, Vorabversion, Dev-Branch,
 *      minor, patch, neu, entfernt             -> ok, steht im Protokoll
 *    - Lockfile nur auf einer Seite, unlesbar  -> manuelles Review
 *
 * 0.x-Spruenge und Vorabversionen blockieren bewusst nicht: transitiv sind sie
 * in jedem npm-Baum (esbuild, oxc, rolldown ...), und als Blocker machten sie
 * fast jede Gruppe reviewpflichtig. Was davon den Build bricht, faengt die CI.
 *
 * Aufruf:
 *   UPDATED_DEPENDENCIES_JSON='[...]' MAX_UPDATE=minor \
 *   LOCKFILE_BASE_DIR=lock-base LOCKFILE_HEAD_DIR=lock-head node policy.mjs
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const MAX_UPDATES = ['patch', 'minor'];
export const LOCKFILES = ['composer.lock', 'package-lock.json'];

const UPDATE_TYPES = {
  'version-update:semver-patch': 'patch',
  'version-update:semver-minor': 'minor',
  'version-update:semver-major': 'major',
};

const BLOCKING_LOCK_CHANGES = ['major', 'downgrade'];

const LOCK_CHANGE_LABELS = {
  added: 'neu',
  downgrade: 'Downgrade',
  major: 'Major',
  minor: 'minor',
  patch: 'patch',
  removed: 'entfernt',
  unversioned: 'nicht nach Semver vergleichbar',
  'zero-major': '0.x-Sprung',
};

/** So viele Lock-Blocker nennt der Grund einzeln, der Rest steht im Protokoll. */
const LISTED_LOCK_BLOCKERS = 10;

/**
 * Die Grenze zu fetch-metadata: alles Weitere arbeitet mit diesem Format.
 *
 * @param {string} raw Output `updated-dependencies-json` von fetch-metadata.
 * @returns {Array<{name: string, updateType: string | null, from: string, to: string}>}
 */
export function parseDependencies(raw) {
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new TypeError('keine Liste mit Dependencies');
  }

  return parsed.map((entry) => {
    if (typeof entry?.dependencyName !== 'string' || entry.dependencyName === '') {
      throw new TypeError('Eintrag ohne dependencyName');
    }

    return {
      name: entry.dependencyName,
      updateType: UPDATE_TYPES[entry.updateType] ?? null,
      from: String(entry.prevVersion ?? ''),
      to: String(entry.newVersion ?? ''),
    };
  });
}

function evaluateMetadata(dependencies, maxUpdate) {
  const approved = [];
  const blockers = [];

  for (const { name, updateType } of dependencies) {
    if (updateType === 'patch' || (updateType === 'minor' && maxUpdate === 'minor')) {
      approved.push(`${name} (${updateType})`);
    }
    else if (updateType === 'minor') {
      blockers.push(`${name}: minor, dieses Repo merged nur patch automatisch`);
    }
    else if (updateType === 'major') {
      blockers.push(`${name}: Major`);
    }
    else {
      blockers.push(`${name}: Update-Typ unbekannt`);
    }
  }

  return { approved, blockers };
}

const SEMVER = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;

/** @returns {number[] | null} Vier Stellen, oder null fuer Vorabversionen, Dev-Branches und Unlesbares. */
function parseVersion(version) {
  const match = SEMVER.exec(version.trim());

  if (!match || match[5]) {
    return null;
  }

  return match.slice(1, 5).map(part => Number(part ?? 0));
}

/**
 * @param {string} from Version im Base-Stand.
 * @param {string} to Version im Merge-Stand.
 * @returns {string} unchanged, patch, minor, major, zero-major, downgrade oder unversioned.
 */
export function classifyVersionChange(from, to) {
  const before = parseVersion(from);
  const after = parseVersion(to);

  if (!before || !after) {
    return from === to ? 'unchanged' : 'unversioned';
  }

  const index = before.findIndex((part, position) => part !== after[position]);

  if (index === -1) {
    return 'unchanged';
  }

  if (after[index] < before[index]) {
    return 'downgrade';
  }

  if (index === 0) {
    return 'major';
  }

  // Nach Semver ist bei 0.x jede Aenderung der ersten Stelle ungleich null
  // breaking: 0.14 -> 0.18 genauso wie 0.0.3 -> 0.0.4.
  if (before[0] === 0 && (index === 1 || before[1] === 0)) {
    return 'zero-major';
  }

  return index === 1 ? 'minor' : 'patch';
}

/**
 * @param {string} content Inhalt einer composer.lock.
 * @returns {Map<string, {name: string, version: string}>} Pakete aus packages und packages-dev.
 */
export function readComposerLock(content) {
  const lock = JSON.parse(content);

  if (!Array.isArray(lock.packages)) {
    throw new TypeError('keine "packages"-Liste');
  }

  const packages = new Map();

  for (const entry of [...lock.packages, ...(lock['packages-dev'] ?? [])]) {
    const reference = entry.source?.reference ?? entry.dist?.reference;
    const isDevBranch = /^dev-|-dev$/.test(entry.version);

    // Dev-Branches (dev-main, 4.x-dev) behalten ihren Versionsnamen, es aendert
    // sich nur der Commit. Der gehoert deshalb mit in den Vergleich.
    packages.set(entry.name, {
      name: entry.name,
      version: isDevBranch && reference ? `${entry.version}@${reference.slice(0, 10)}` : entry.version,
    });
  }

  return packages;
}

/**
 * @param {string} content Inhalt einer package-lock.json (lockfileVersion 2 oder 3).
 * @returns {Map<string, {name: string, version: string}>} Pakete nach Installationspfad, dasselbe Paket kann verschachtelt mehrfach vorkommen.
 */
export function readNpmLock(content) {
  const lock = JSON.parse(content);

  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new TypeError('keine "packages"-Map, lockfileVersion 2 oder 3 noetig');
  }

  const packages = new Map();

  for (const [path, entry] of Object.entries(lock.packages)) {
    // '' ist das Projekt selbst, Pfade ohne node_modules/ sind Workspaces.
    if (!path.startsWith('node_modules/')) {
      continue;
    }

    packages.set(path.slice('node_modules/'.length), {
      name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.link ? `link:${entry.resolved}` : String(entry.version ?? ''),
    });
  }

  return packages;
}

const LOCK_READERS = {
  'composer.lock': readComposerLock,
  'package-lock.json': readNpmLock,
};

/**
 * @returns {Array<{key: string, name: string, from?: string, to?: string, kind: string}>} Jede Versionsaenderung, nach Schluessel sortiert.
 */
export function diffLockPackages(base, head) {
  const changes = [];

  for (const key of new Set([...base.keys(), ...head.keys()])) {
    const before = base.get(key);
    const after = head.get(key);

    if (!before || !after) {
      changes.push({ key, name: (after ?? before).name, from: before?.version, to: after?.version, kind: before ? 'removed' : 'added' });

      continue;
    }

    const kind = classifyVersionChange(before.version, after.version);

    if (kind !== 'unchanged') {
      changes.push({ key, name: after.name, from: before.version, to: after.version, kind });
    }
  }

  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Ein Lockfile, das auf keiner Seite existiert, gehoert nicht zum Repo und
 * wird uebersprungen. Fehlt es nur auf einer Seite, ist das ein Befund.
 *
 * @param {string} baseDirectory Lockfiles des Base-Stands.
 * @param {string} headDirectory Lockfiles des Test-Merge-Commits.
 * @returns {{changes: Array<object>, errors: string[], files: string[]}}
 */
export function collectLockChanges(baseDirectory, headDirectory) {
  const changes = [];
  const errors = [];
  const files = [];

  for (const file of LOCKFILES) {
    const basePath = join(baseDirectory, file);
    const headPath = join(headDirectory, file);
    const inBase = existsSync(basePath);
    const inHead = existsSync(headPath);

    if (!inBase && !inHead) {
      continue;
    }

    files.push(file);

    if (inBase !== inHead) {
      errors.push(`${file} gibt es nur im ${inBase ? 'Base-Stand' : 'Merge-Stand'}`);

      continue;
    }

    try {
      const base = LOCK_READERS[file](readFileSync(basePath, 'utf8'));
      const head = LOCK_READERS[file](readFileSync(headPath, 'utf8'));

      changes.push(...diffLockPackages(base, head).map(change => ({ file, ...change })));
    }
    catch (error) {
      errors.push(`${file} nicht lesbar (${error.message})`);
    }
  }

  return { changes, errors, files };
}

function normalizeVersion(version) {
  return String(version ?? '').trim().replace(/^v/i, '');
}

function isReportedByMetadata(change, dependencies) {
  return dependencies.some(dependency => dependency.name === change.name
    && dependency.from !== '' && dependency.to !== ''
    && normalizeVersion(dependency.from) === normalizeVersion(change.from)
    && normalizeVersion(dependency.to) === normalizeVersion(change.to));
}

export function describeLockChange(change) {
  return `${change.file}: ${change.key} ${change.from ?? '-'} -> ${change.to ?? '-'} (${LOCK_CHANGE_LABELS[change.kind]})`;
}

/**
 * @returns {{blockers: string[], report: string[], summary: string}} Blocker fuer den Grund, Protokoll und Kurzfassung.
 */
export function evaluateLockDiff(lockDiff, dependencies) {
  const blocking = [];
  const report = [];
  let reported = 0;

  for (const change of lockDiff.changes) {
    const isReported = isReportedByMetadata(change, dependencies);
    const isBlocking = !isReported && BLOCKING_LOCK_CHANGES.includes(change.kind);

    reported += isReported ? 1 : 0;

    if (isBlocking) {
      blocking.push(change);
    }

    report.push(`${isBlocking ? 'BLOCKER ' : ''}${describeLockChange(change)}${isReported ? ' [aus den Metadaten]' : ''}`);
  }

  const blockers = [
    ...lockDiff.errors.map(error => `Lock-Diff: ${error}`),
    ...blocking.slice(0, LISTED_LOCK_BLOCKERS).map(change => `transitiv ${describeLockChange(change)}`),
  ];

  if (blocking.length > LISTED_LOCK_BLOCKERS) {
    blockers.push(`Lock-Diff: ${blocking.length - LISTED_LOCK_BLOCKERS} weitere Blocker, siehe Job-Zusammenfassung`);
  }

  const summary = lockDiff.files.length === 0
    ? 'kein Lockfile im Update-Verzeichnis'
    : `Lock-Diff ohne Befund (${lockDiff.changes.length} Aenderung(en), davon ${reported} aus den Metadaten)`;

  return { blockers, report, summary };
}

/**
 * @param {Array<{name: string, updateType: string | null, from: string, to: string}>} dependencies Ergebnis von parseDependencies.
 * @param {{changes: Array<object>, errors: string[], files: string[]}} lockDiff Ergebnis von collectLockChanges.
 * @param {string} maxUpdate patch oder minor.
 * @returns {{autoMerge: boolean, reason: string, report: string[]}}
 */
export function evaluatePolicy(dependencies, lockDiff, maxUpdate) {
  const { approved, blockers } = evaluateMetadata(dependencies, maxUpdate);
  const lock = evaluateLockDiff(lockDiff, dependencies);

  blockers.push(...lock.blockers);

  if (blockers.length > 0) {
    return { autoMerge: false, reason: `Manuelles Review noetig: ${blockers.join('; ')}`, report: lock.report };
  }

  return { autoMerge: true, reason: `Policy erfuellt: ${approved.join(', ')}. ${lock.summary}`, report: lock.report };
}

/**
 * Der Weg aus der Action. Falsch verdrahtete Eingaben (MAX_UPDATE, fehlende
 * Verzeichnisse) sind ein Fehler im Aufruf und brechen ab. Unlesbare
 * Dependabot-Metadaten fuehren dagegen zu manuellem Review.
 *
 * @param {Record<string, string | undefined>} env Umgebungsvariablen.
 */
export function evaluateEnvironment(env) {
  const maxUpdate = env.MAX_UPDATE ?? '';

  if (!MAX_UPDATES.includes(maxUpdate)) {
    throw new Error(`MAX_UPDATE muss ${MAX_UPDATES.join(' oder ')} sein, ist "${maxUpdate}"`);
  }

  if (!env.LOCKFILE_BASE_DIR || !env.LOCKFILE_HEAD_DIR) {
    throw new Error('LOCKFILE_BASE_DIR und LOCKFILE_HEAD_DIR muessen gesetzt sein');
  }

  const lockDiff = collectLockChanges(env.LOCKFILE_BASE_DIR, env.LOCKFILE_HEAD_DIR);
  let dependencies;

  try {
    dependencies = parseDependencies(env.UPDATED_DEPENDENCIES_JSON ?? '');
  }
  catch (error) {
    return {
      autoMerge: false,
      reason: `Dependabot-Metadaten nicht lesbar (${error.message}), manuelles Review.`,
      report: evaluateLockDiff(lockDiff, []).report,
    };
  }

  return evaluatePolicy(dependencies, lockDiff, maxUpdate);
}

function main() {
  const { autoMerge, reason, report } = evaluateEnvironment(process.env);

  console.log(`auto-merge=${autoMerge}`);
  console.log(reason);
  console.log(`\nLock-Diff Base -> Merge (${report.length} Aenderung(en)):`);

  for (const line of report) {
    console.log(`  ${line}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `auto-merge=${autoMerge}\nreason=${reason.replace(/\r?\n/g, ' ')}\n`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = report.length > 0 ? report.map(line => `- \`${line}\``) : ['- keine Aenderungen im Lockfile'];

    appendFileSync(process.env.GITHUB_STEP_SUMMARY, [
      `### Dependabot-Policy: ${autoMerge ? 'Auto-Merge' : 'manuelles Review'}`,
      '',
      reason,
      '',
      '<details><summary>Lock-Diff</summary>',
      '',
      ...lines,
      '',
      '</details>',
      '',
    ].join('\n'));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
