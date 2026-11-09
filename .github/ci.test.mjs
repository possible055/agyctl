import assert from 'node:assert/strict';
import test from 'node:test';
import { requireChecks, selectChecks } from './ci.mjs';

test('PR selection keeps documentation cheap without omitting runtime and dependency checks', () => {
  const none = {
    node: false,
    go: false,
    packaging: false,
    dependencies: false,
    govulncheck: false,
  };
  const cases = [
    [['docs/operations.md', 'README.zh-CN.md'], none],
    [['src/plugin/lib/metrics-core.mjs'], { ...none, node: true }],
    [['src/host/compose.ts'], { ...none, node: true }],
    [['src/localization/runtime/preload.ts'], { ...none, node: true }],
    [['compat/localization/profiles.json'], { ...none, node: true, go: true }],
    [['scripts/capsule-build.mjs'], { ...none, node: true }],
    [['src/localization/catalogs/zh-Hant-TW.json'], { ...none, node: true }],
    [['compat/localization/usage-points.json'], { ...none, node: true }],
    [['src/plugin/sidecars/panel/settings.mjs'], { ...none, node: true }],
    [
      ['src/agyctl/internal/check/files.go'],
      { ...none, go: true, packaging: true, govulncheck: true },
    ],
    [['package-lock.json'], { ...none, node: true, packaging: true, dependencies: true }],
    [['scripts/tools-build.mjs'], { ...none, node: true, packaging: true }],
    [
      ['src/plugin/old.mjs', 'src/agyctl/new.go'],
      { ...none, node: true, go: true, packaging: true, govulncheck: true },
    ],
  ];
  for (const [paths, expected] of cases) {
    assert.deepEqual(selectChecks('pull_request', paths), expected, paths.join(', '));
  }
});

test('unknown paths and shared contracts fail closed; schedules only refresh advisories', () => {
  const all = { node: true, go: true, packaging: true, dependencies: true, govulncheck: true };
  for (const file of ['new-runtime/file.dat', 'compat/versions.json', '.github/workflows/ci.yml']) {
    assert.deepEqual(selectChecks('pull_request', [file]), all);
  }
  assert.deepEqual(selectChecks('push'), all);
  assert.deepEqual(selectChecks('workflow_dispatch'), all);
  assert.deepEqual(selectChecks('merge_group'), all);
  assert.deepEqual(selectChecks('schedule'), {
    node: false,
    go: false,
    packaging: false,
    dependencies: true,
    govulncheck: true,
  });
});

test('required gate rejects unsuccessful, missing and unexpectedly skipped jobs', () => {
  const checks = selectChecks('pull_request', ['src/agyctl/internal/check/files.go']);
  const needs = {
    scope: { result: 'success', outputs: { checks: JSON.stringify(checks) } },
    repository: { result: 'success' },
    ...Object.fromEntries(
      Object.entries(checks).map(([name, selected]) => [
        name,
        { result: selected ? 'success' : 'skipped' },
      ]),
    ),
  };
  assert.doesNotThrow(() => requireChecks(needs));
  for (const result of ['failure', 'cancelled', 'skipped', undefined]) {
    assert.throws(() => requireChecks({ ...needs, go: { result } }), /go: expected success/);
  }
  assert.throws(
    () => requireChecks({ ...needs, scope: { result: 'failure' } }),
    /scope did not succeed/,
  );
  assert.throws(
    () => requireChecks({ ...needs, repository: { result: 'skipped' } }),
    /repository did not succeed/,
  );
  assert.throws(
    () => requireChecks({ ...needs, scope: { result: 'success', outputs: { checks: '{}' } } }),
    /Missing selection/,
  );
});
