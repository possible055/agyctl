import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { desiredNativeConfig, parseInstallerArgs } from '../../scripts/lib/installer.mjs';

test('installer CLI reports progress before target validation without contaminating JSON output', () => {
  const cli = fileURLToPath(new URL('../../bin/agyctl.mjs', import.meta.url));
  const asar = path.join(os.tmpdir(), `agyctl-missing-${randomUUID()}`, 'resources', 'app.asar');
  for (const json of [false, true]) {
    const result = spawnSync(
      process.execPath,
      [cli, 'uninstall', '--all', '--asar', asar, ...(json ? ['--json'] : [])],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    if (json) {
      assert.equal(result.stderr, '');
      const refusal = JSON.parse(result.stdout);
      assert.equal(refusal.code, 'ENOENT');
      assert.match(refusal.error, /ENOENT/);
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /^\[\d+\.\ds\] .+\r?\n/);
      assert.match(result.stderr, /ENOENT/);
    }
  }
});

test('installer selection is explicit, canonical, and rejects ambiguous arguments', () => {
  assert.deepEqual(parseInstallerArgs(['install']).selected, { panel: true });
  const selected = parseInstallerArgs([
    'install',
    '--all',
    '--limit',
    '20=500000,10=400000',
    '--locale',
    'zh-Hant-TW',
  ]);
  assert.deepEqual(selected.modelLimits, [
    { id: 10, limit: 400000 },
    { id: 20, limit: 500000 },
  ]);
  assert.deepEqual(selected.selected, {
    panel: true,
    capsule: true,
    localization: true,
    limit: true,
    toolOutput: true,
    compaction: true,
  });
  assert.equal(selected.locale, 'zh-Hant-TW');
  assert.deepEqual(parseInstallerArgs(['uninstall', '--limit']).selected, { limit: true });
  for (const [args, message] of [
    [['install', '--force'], /Unknown argument: --force/],
    [['install', 'xxpanel'], /Unknown argument: xxpanel/],
    [['install', '--toolOutput'], /Unknown argument: --toolOutput/],
    [['install', '--limit'], /Missing value for --limit/],
    [['install', '--limit', '1=5,1=6'], /unique model IDs/],
    [['install', '--locale', 'zh-TW'], /canonical locale/],
    [['install', '--limit', '1=5', '--model-limits', '2=6'], /Duplicate argument/],
    [['uninstall', '--model-limits', '1=5'], /uninstall accepts feature flags/],
    [['status', '--all'], /status accepts only/],
  ])
    assert.throws(() => parseInstallerArgs(args), message);
});

test('installer never guesses model mappings or unknown native state', () => {
  const current = {
    limit: { enabled: false, model_limits: [] },
    tool_output: false,
    compaction: false,
  };
  const options = parseInstallerArgs(['install', '--all']);
  assert.throws(() => desiredNativeConfig(options, current), /No verified model-limit mapping/);
  assert.throws(
    () => desiredNativeConfig(options, { ...current, tool_output: null }),
    /state is unverified/,
  );
  const desired = desiredNativeConfig(options, current, [{ id: 42, limit: 500000 }]);
  assert.deepEqual(desired, {
    limit: { enabled: true, model_limits: [{ id: 42, limit: 500000 }] },
    tool_output: true,
    compaction: true,
    compaction_prompt: { mode: 'native', text: '' },
  });
  assert.deepEqual(current, {
    limit: { enabled: false, model_limits: [] },
    tool_output: false,
    compaction: false,
  });
});

test('uninstall preserves unselected native features and omits disabled compaction prompt', () => {
  const current = {
    limit: { enabled: true, model_limits: [{ id: 42, limit: 500000 }] },
    tool_output: true,
    compaction: true,
    compaction_prompt: { mode: 'custom', text: 'Keep corrections.' },
  };
  assert.deepEqual(desiredNativeConfig(parseInstallerArgs(['uninstall', '--limit']), current), {
    ...current,
    limit: { enabled: false, model_limits: [] },
  });
  assert.deepEqual(
    desiredNativeConfig(parseInstallerArgs(['uninstall', '--compaction']), current),
    {
      limit: current.limit,
      tool_output: true,
      compaction: false,
    },
  );
  assert.deepEqual(desiredNativeConfig(parseInstallerArgs(['uninstall', '--all']), current), {
    limit: { enabled: false, model_limits: [] },
    tool_output: false,
    compaction: false,
  });
  assert.deepEqual(
    desiredNativeConfig(parseInstallerArgs(['install', '--tool-output']), current),
    current,
  );
});
