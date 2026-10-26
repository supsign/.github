import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  classifyVersionChange,
  collectLockChanges,
  evaluateEnvironment,
  evaluatePolicy,
  parseDependencies,
  readComposerLock,
  readNpmLock,
} from './policy.mjs';

const NO_LOCK = { changes: [], errors: [], files: [] };
const NPM = { ecosystem: 'npm_and_yarn', maxUpdate: 'minor' };
const NPM_PATCH = { ecosystem: 'npm_and_yarn', maxUpdate: 'patch' };
const ACTIONS = { ecosystem: 'github_actions', maxUpdate: 'patch' };

function dependency(name, updateType, from = '1.0.0', to = '1.0.1') {
  return { dependencyName: name, updateType: `version-update:semver-${updateType}`, prevVersion: from, newVersion: to };
}

function deps(...entries) {
  return parseDependencies(JSON.stringify(entries));
}

function composerLock(packages, packagesDev = []) {
  return JSON.stringify({ packages, 'packages-dev': packagesDev });
}

function npmLock(packages) {
  return JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'app' }, ...packages } });
}

/** Legt Base- und Head-Verzeichnis mit den angegebenen Lockfiles an. */
function lockDirs(base, head) {
  const root = mkdtempSync(join(tmpdir(), 'policy-'));

  for (const [side, files] of [['base', base], ['head', head]]) {
    mkdirSync(join(root, side));

    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(root, side, file), content);
    }
  }

  return { base: join(root, 'base'), head: join(root, 'head') };
}

describe('Metadaten', () => {
  it('merged patch und minor automatisch', () => {
    const result = evaluatePolicy(deps(dependency('laravel/framework', 'minor'), dependency('axios', 'patch')), NO_LOCK, NPM);

    assert.equal(result.autoMerge, true);
    assert.match(result.reason, /laravel\/framework \(minor\), axios \(patch\)/);
  });

  it('haelt minor zurueck, wenn das Repo nur patch erlaubt', () => {
    const result = evaluatePolicy(deps(dependency('axios', 'minor')), NO_LOCK, NPM_PATCH);

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /axios: minor, dieses Repo merged nur patch/);
  });

  it('haelt Majors zurueck, auch wenn nur ein Paket der Gruppe betroffen ist', () => {
    const result = evaluatePolicy(deps(dependency('vite', 'patch'), dependency('@inertiajs/vue3', 'major', '2.3.21', '3.7.1')), NO_LOCK, NPM);

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /@inertiajs\/vue3: Major/);
  });

  it('merged GitHub-Actions-Updates jeder Stufe, auch in einem Repo mit max-update patch', () => {
    const result = evaluatePolicy(deps(dependency('actions/checkout', 'major', '6', '7'), dependency('shivammathur/setup-php', 'minor')), NO_LOCK, ACTIONS);

    assert.equal(result.autoMerge, true);
    assert.match(result.reason, /actions\/checkout \(major\), shivammathur\/setup-php \(minor\)/);
  });

  it('haelt einen unbekannten Update-Typ zurueck, auch bei GitHub Actions', () => {
    const result = evaluatePolicy(parseDependencies(JSON.stringify([{ dependencyName: 'actions/checkout', updateType: '' }])), NO_LOCK, ACTIONS);

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /actions\/checkout: Update-Typ unbekannt/);
  });

  it('wendet die Actions-Ausnahme nicht auf Pakete an', () => {
    assert.equal(evaluatePolicy(deps(dependency('vite', 'major', '7.3.7', '8.0.0')), NO_LOCK, NPM).autoMerge, false);
  });

  it('lehnt Metadaten ohne Liste oder ohne Namen an der Grenze ab', () => {
    assert.throws(() => parseDependencies('[]'), /keine Liste/);
    assert.throws(() => parseDependencies('{}'), /keine Liste/);
    assert.throws(() => parseDependencies('[{"updateType":"version-update:semver-patch"}]'), /ohne dependencyName/);
    assert.throws(() => parseDependencies('kein json'));
  });
});

describe('Versionsvergleich', () => {
  it('ordnet Aenderungen nach Semver ein', () => {
    assert.equal(classifyVersionChange('1.2.3', '1.2.4'), 'patch');
    assert.equal(classifyVersionChange('1.2.3', '1.3.0'), 'minor');
    assert.equal(classifyVersionChange('v7.4.0', 'v8.0.0'), 'major');
    assert.equal(classifyVersionChange('v8.0.1', 'v7.4.9'), 'downgrade');
    assert.equal(classifyVersionChange('0.131.0', '0.153.0'), 'zero-major');
    assert.equal(classifyVersionChange('0.0.3', '0.0.4'), 'zero-major');
    assert.equal(classifyVersionChange('0.4.1', '0.4.2'), 'patch');
    assert.equal(classifyVersionChange('1.0.0-rc.1', '1.0.0-rc.3'), 'unversioned');
    assert.equal(classifyVersionChange('dev-main@abc', 'dev-main@abc'), 'unchanged');
    assert.equal(classifyVersionChange('1.2.3', '1.2.3'), 'unchanged');
  });
});

describe('Lock-Diff', () => {
  it('blockiert einen transitiven Downgrade (symfony/console v8 -> v7 in einem Patch-PR)', () => {
    const dirs = lockDirs(
      { 'composer.lock': composerLock([{ name: 'laravel/framework', version: 'v12.1.0' }, { name: 'symfony/console', version: 'v8.0.1' }]) },
      { 'composer.lock': composerLock([{ name: 'laravel/framework', version: 'v12.1.1' }, { name: 'symfony/console', version: 'v7.4.9' }]) },
    );
    const result = evaluatePolicy(deps(dependency('laravel/framework', 'patch', '12.1.0', '12.1.1')), collectLockChanges(dirs.base, dirs.head), NPM);

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /symfony\/console v8\.0\.1 -> v7\.4\.9 \(Downgrade\)/);
    assert.ok(result.report.some(line => line.startsWith('composer.lock: laravel/framework') && line.endsWith('[aus den Metadaten]')));
  });

  it('blockiert mitgezogene Majors und Downgrades (nx 22 -> 23, undici 8 -> 7 in einem Security-PR)', () => {
    const dirs = lockDirs(
      { 'package-lock.json': npmLock({ 'node_modules/nx': { version: '22.7.12' }, 'node_modules/undici': { version: '8.10.0' }, 'node_modules/fflate': { version: '0.8.2' } }) },
      { 'package-lock.json': npmLock({ 'node_modules/nx': { version: '23.3.0' }, 'node_modules/undici': { version: '7.29.0' }, 'node_modules/fflate': { version: '0.8.3' } }) },
    );
    const result = evaluatePolicy(deps(dependency('fflate', 'patch', '0.8.2', '0.8.3')), collectLockChanges(dirs.base, dirs.head), NPM);

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /nx 22\.7\.12 -> 23\.3\.0 \(Major\)/);
    assert.match(result.reason, /undici 8\.10\.0 -> 7\.29\.0 \(Downgrade\)/);
    assert.doesNotMatch(result.reason, /fflate/);
  });

  it('laesst transitive 0.x-Spruenge, Vorabversionen, Dev-Branches, neue und entfernte Pakete durch', () => {
    const dirs = lockDirs(
      {
        'composer.lock': composerLock([{ name: 'spatie/laravel-medialibrary-pro', version: 'dev-main', source: { reference: 'aaaaaaaaaaaa' } }]),
        'package-lock.json': npmLock({ 'node_modules/esbuild': { version: '0.25.0' }, 'node_modules/rolldown': { version: '1.0.0-rc.1' }, 'node_modules/old': { version: '1.0.0' } }),
      },
      {
        'composer.lock': composerLock([{ name: 'spatie/laravel-medialibrary-pro', version: 'dev-main', source: { reference: 'bbbbbbbbbbbb' } }]),
        'package-lock.json': npmLock({ 'node_modules/esbuild': { version: '0.27.0' }, 'node_modules/rolldown': { version: '1.0.0-rc.3' }, 'node_modules/new': { version: '2.0.0' } }),
      },
    );
    const result = evaluatePolicy(deps(dependency('vite', 'minor')), collectLockChanges(dirs.base, dirs.head), NPM);

    assert.equal(result.autoMerge, true);
    assert.equal(result.report.length, 5);
    assert.ok(result.report.every(line => !line.startsWith('BLOCKER')));
  });

  it('bewertet ein angefordertes Paket nach den Metadaten, auch wenn der Lock einen Major zeigt', () => {
    const dirs = lockDirs(
      { 'package-lock.json': npmLock({ 'node_modules/vitest': { version: '4.1.11' } }) },
      { 'package-lock.json': npmLock({ 'node_modules/vitest': { version: '5.0.4' } }) },
    );
    const result = evaluatePolicy(deps(dependency('vitest', 'major', '4.1.11', '5.0.4')), collectLockChanges(dirs.base, dirs.head), NPM);

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /vitest: Major/);
    assert.doesNotMatch(result.reason, /transitiv/);
  });

  it('nennt hoechstens zehn Lock-Blocker einzeln', () => {
    const base = {};
    const head = {};

    for (let i = 0; i < 12; i++) {
      base[`node_modules/paket-${String(i).padStart(2, '0')}`] = { version: '1.0.0' };
      head[`node_modules/paket-${String(i).padStart(2, '0')}`] = { version: '2.0.0' };
    }

    const dirs = lockDirs({ 'package-lock.json': npmLock(base) }, { 'package-lock.json': npmLock(head) });
    const result = evaluatePolicy(deps(dependency('axios', 'patch')), collectLockChanges(dirs.base, dirs.head), NPM);

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /2 weitere Blocker/);
    assert.doesNotMatch(result.reason, /paket-10/);
  });

  it('ueberspringt Lockfiles, die es auf keiner Seite gibt', () => {
    const dirs = lockDirs({}, {});
    const result = evaluatePolicy(deps(dependency('actions/checkout', 'minor')), collectLockChanges(dirs.base, dirs.head), NPM);

    assert.equal(result.autoMerge, true);
    assert.match(result.reason, /kein Lockfile im Update-Verzeichnis/);
  });

  it('blockiert, wenn ein Lockfile nur auf einer Seite liegt oder unlesbar ist', () => {
    const oneSided = lockDirs({ 'composer.lock': composerLock([]) }, {});
    const broken = lockDirs({ 'package-lock.json': '{' }, { 'package-lock.json': npmLock({}) });

    assert.match(evaluatePolicy(deps(dependency('a', 'patch')), collectLockChanges(oneSided.base, oneSided.head), NPM).reason, /composer\.lock gibt es nur im Base-Stand/);
    assert.match(evaluatePolicy(deps(dependency('a', 'patch')), collectLockChanges(broken.base, broken.head), NPM).reason, /package-lock\.json nicht lesbar/);
  });
});

describe('Lockfiles lesen', () => {
  it('liest composer.lock samt packages-dev und Commit von Dev-Branches', () => {
    const packages = readComposerLock(composerLock(
      [{ name: 'spatie/pro', version: 'dev-main', source: { reference: '0123456789abcdef' } }],
      [{ name: 'pestphp/pest', version: 'v4.1.0' }],
    ));

    assert.deepEqual(packages.get('spatie/pro'), { name: 'spatie/pro', version: 'dev-main@0123456789' });
    assert.deepEqual(packages.get('pestphp/pest'), { name: 'pestphp/pest', version: 'v4.1.0' });
  });

  it('liest package-lock.json pro Installationspfad, ohne Projekt und Workspaces', () => {
    const packages = readNpmLock(npmLock({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/b': { version: '2.0.0' },
      'packages/ui': { version: '0.0.0' },
    }));

    assert.deepEqual([...packages.keys()], ['a', 'a/node_modules/b']);
    assert.equal(packages.get('a/node_modules/b').name, 'b');
  });

  it('lehnt ein package-lock.json ohne packages-Map ab (lockfileVersion 1)', () => {
    assert.throws(() => readNpmLock(JSON.stringify({ lockfileVersion: 1, dependencies: {} })), /lockfileVersion 2 oder 3/);
  });
});

describe('Aufruf aus der Action', () => {
  it('bricht bei falsch verdrahteten Eingaben ab', () => {
    const dirs = lockDirs({}, {});

    assert.throws(() => evaluateEnvironment({ MAX_UPDATE: 'major', LOCKFILE_BASE_DIR: dirs.base, LOCKFILE_HEAD_DIR: dirs.head }), /MAX_UPDATE muss patch oder minor sein/);
    assert.throws(() => evaluateEnvironment({ MAX_UPDATE: 'minor' }), /LOCKFILE_BASE_DIR und LOCKFILE_HEAD_DIR/);
  });

  it('verlangt manuelles Review, wenn die Metadaten unlesbar sind', () => {
    const dirs = lockDirs({}, {});
    const result = evaluateEnvironment({ MAX_UPDATE: 'minor', LOCKFILE_BASE_DIR: dirs.base, LOCKFILE_HEAD_DIR: dirs.head, UPDATED_DEPENDENCIES_JSON: '' });

    assert.equal(result.autoMerge, false);
    assert.match(result.reason, /Dependabot-Metadaten nicht lesbar/);
  });

  it('wertet einen echten Aufruf durch', () => {
    const dirs = lockDirs(
      { 'package-lock.json': npmLock({ 'node_modules/follow-redirects': { version: '1.16.0' } }) },
      { 'package-lock.json': npmLock({ 'node_modules/follow-redirects': { version: '1.16.1' } }) },
    );
    const result = evaluateEnvironment({
      MAX_UPDATE: 'minor',
      LOCKFILE_BASE_DIR: dirs.base,
      LOCKFILE_HEAD_DIR: dirs.head,
      UPDATED_DEPENDENCIES_JSON: JSON.stringify([dependency('follow-redirects', 'patch', '1.16.0', '1.16.1')]),
    });

    assert.equal(result.autoMerge, true);
    assert.deepEqual(result.report, ['package-lock.json: follow-redirects 1.16.0 -> 1.16.1 (patch) [aus den Metadaten]']);
  });
});
