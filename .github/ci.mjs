import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const checkNames = ['node', 'go', 'packaging', 'dependencies', 'govulncheck'];

export function selectChecks(event, paths = []) {
  const checks = Object.fromEntries(checkNames.map((name) => [name, false]));
  if (event === 'schedule') return { ...checks, dependencies: true, govulncheck: true };
  if (event !== 'pull_request') return Object.fromEntries(checkNames.map((name) => [name, true]));

  for (const file of paths) {
    if (
      file.startsWith('docs/') ||
      file.startsWith('vendor-src/') ||
      /^(README(?:\.[\w-]+)?\.md|AGENTS\.md|LICENSE)$/.test(file) ||
      file === '.github/CI.md'
    ) {
      continue;
    }
    if (file.startsWith('src/agyctl/')) {
      checks.go = true;
      checks.packaging = true;
      checks.govulncheck = true;
    } else if (file === 'compat/localization/profiles.json') {
      // The checker reads the profile store, so its Go tests must run too.
      checks.node = true;
      checks.go = true;
      checks.packaging = true;
    } else if (file.startsWith('compat/localization/')) {
      checks.node = true;
      checks.packaging = true;
    } else if (
      /^(scripts\/(tools-build|agyctl)\.mjs|scripts\/lib\/(agyctl|install-paths)\.mjs|package(-lock)?\.json|\.npmrc|\.nvmrc)$/.test(
        file,
      )
    ) {
      checks.node = true;
      checks.packaging = true;
      if (/^package(-lock)?\.json$/.test(file)) checks.dependencies = true;
    } else if (
      /^(bin\/|src\/(host|localization|capsule|plugin)\/|scripts\/|tests\/(node|electron)\/|tsconfig.*\.json$|biome\.jsonc$)/.test(
        file,
      )
    ) {
      checks.node = true;
      checks.packaging = true;
    } else {
      // Shared contracts, CI configuration and unclassified paths must not silently lose coverage.
      for (const name of checkNames) checks[name] = true;
    }
  }
  return checks;
}

export function requireChecks(needs) {
  for (const name of ['scope', 'repository']) {
    if (needs[name]?.result !== 'success') throw new Error(`${name} did not succeed`);
  }
  const checks = JSON.parse(needs.scope.outputs.checks);
  for (const name of checkNames) {
    if (typeof checks[name] !== 'boolean') throw new Error(`Missing selection for ${name}`);
    const expected = checks[name] ? 'success' : 'skipped';
    if (needs[name]?.result !== expected) {
      throw new Error(`${name}: expected ${expected}, got ${needs[name]?.result ?? 'missing'}`);
    }
  }
}

if (import.meta.main) {
  if (process.argv[2] === 'scope') {
    const event = process.env.GITHUB_EVENT_NAME;
    let paths = [];
    if (event === 'pull_request') {
      const base = process.env.PR_BASE_SHA;
      const head = process.env.PR_HEAD_SHA;
      if (![base, head].every((sha) => /^[a-f0-9]{40}$/.test(sha ?? ''))) {
        throw new Error('PR base and head must be full commit SHAs');
      }
      // No rename detection: both the old and new paths must select their checks.
      paths = execFileSync(
        'git',
        ['diff', '--name-only', '--no-renames', '-z', `${base}...${head}`],
        {
          encoding: 'utf8',
        },
      )
        .split('\0')
        .filter(Boolean);
    }
    const checks = selectChecks(event, paths);
    const output = Object.entries({ ...checks, checks: JSON.stringify(checks) })
      .map(([name, value]) => `${name}=${value}\n`)
      .join('');
    appendFileSync(process.env.GITHUB_OUTPUT, output);
    console.log(JSON.stringify({ event, paths, checks }, null, 2));
  } else if (process.argv[2] === 'gate') {
    requireChecks(JSON.parse(process.env.NEEDS_JSON));
    console.log('Every selected CI check succeeded.');
  } else {
    throw new Error('Usage: node .github/ci.mjs <scope|gate>');
  }
}
