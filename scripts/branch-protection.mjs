#!/usr/bin/env node
/**
 * Setzt den Standard-Branch-Schutz auf dem Default-Branch eines Repos
 * (README.md, Abschnitt Branch-Schutz):
 *
 *   - Required-Status-Check `ci`, gebunden an GitHub Actions
 *   - kein Force-Push, kein Loeschen
 *   - Reviews: wie bisher im Repo (oder --reviews N). Sind Reviews Pflicht,
 *     bekommen die Apps github-actions und dependabot den Review-Bypass, damit
 *     der zentrale Dependabot-Workflow mergen kann. Menschen brauchen weiterhin
 *     ihre Reviews.
 *
 * Klassischer Branch-Schutz statt Ruleset, weil Rulesets GitHub Actions nicht
 * als Bypass-Akteur akzeptieren (HTTP 422).
 *
 * Aufruf:  node scripts/branch-protection.mjs supsign/<repo> [--reviews N] [--apply]
 * Ohne --apply wird nur angezeigt, was gesetzt wuerde.
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const GITHUB_ACTIONS_APP_ID = 15368;

function gh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}

function ghJson(path) {
  try {
    return JSON.parse(gh(['api', path]));
  }
  catch (error) {
    if (String(error.stderr).includes('HTTP 404')) {
      return null;
    }

    throw error;
  }
}

function parseArguments(argv) {
  const [repo, ...rest] = argv;

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
    throw new Error('Aufruf: node scripts/branch-protection.mjs <owner>/<repo> [--reviews N] [--apply]');
  }

  const reviewsIndex = rest.indexOf('--reviews');
  const reviews = reviewsIndex === -1 ? null : Number(rest[reviewsIndex + 1]);

  if (reviews !== null && !(Number.isInteger(reviews) && reviews >= 0 && reviews <= 6)) {
    throw new Error('--reviews muss eine Zahl von 0 bis 6 sein');
  }

  return { repo, reviews, apply: rest.includes('--apply') };
}

function protectionPayload(current, reviews) {
  const currentReviews = current?.required_pull_request_reviews;
  const count = reviews ?? currentReviews?.required_approving_review_count ?? 0;
  const restrictions = current?.restrictions;

  return {
    required_status_checks: { strict: false, checks: [{ context: 'ci', app_id: GITHUB_ACTIONS_APP_ID }] },
    enforce_admins: current?.enforce_admins?.enabled ?? false,
    required_pull_request_reviews: count === 0
      ? null
      : {
          required_approving_review_count: count,
          require_code_owner_reviews: currentReviews?.require_code_owner_reviews ?? false,
          dismiss_stale_reviews: currentReviews?.dismiss_stale_reviews ?? false,
          require_last_push_approval: currentReviews?.require_last_push_approval ?? false,
          bypass_pull_request_allowances: { apps: ['github-actions', 'dependabot'] },
        },
    restrictions: restrictions
      ? {
          users: restrictions.users.map(user => user.login),
          teams: restrictions.teams.map(team => team.slug),
          apps: restrictions.apps.map(app => app.slug),
        }
      : null,
    required_conversation_resolution: current?.required_conversation_resolution?.enabled ?? false,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

function main() {
  const { repo, reviews, apply } = parseArguments(process.argv.slice(2));
  const { default_branch: branch } = ghJson(`repos/${repo}`);
  const current = ghJson(`repos/${repo}/branches/${branch}/protection`);
  const payload = protectionPayload(current, reviews);

  console.log(`${repo} (${branch}): ${current ? 'bestehender Schutz wird angeglichen' : 'bisher kein Schutz'}`);
  console.log(JSON.stringify(payload, null, 2));

  // Repo-eigene Rulesets mit Review- oder Check-Regeln greifen zusaetzlich und
  // lassen sich nicht fuer github-actions oeffnen. Sie gehoeren in den
  // klassischen Schutz ueberfuehrt, das entscheidet ein Mensch.
  for (const { id, name, source_type: source, enforcement } of ghJson(`repos/${repo}/rulesets`) ?? []) {
    const ruleset = ghJson(`repos/${repo}/rulesets/${id}`);
    const blocking = ruleset.rules.filter(rule => ['pull_request', 'required_status_checks'].includes(rule.type)).map(rule => rule.type);

    if (source === 'Repository' && enforcement === 'active' && blocking.length > 0) {
      console.warn(`WARNUNG: Ruleset "${name}" (${id}) enthaelt ${blocking.join(', ')}. Bitte in den klassischen Schutz ueberfuehren.`);
    }
  }

  if (!apply) {
    console.log('\nNur Vorschau. Mit --apply setzen.');

    return;
  }

  gh(['api', '-X', 'PUT', `repos/${repo}/branches/${branch}/protection`, '--input', '-'], JSON.stringify(payload));
  console.log('\nGesetzt.');
}

main();
