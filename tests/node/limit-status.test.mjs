import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { installPlugin } from '../../scripts/plugin-install.mjs';
import {
  normalizeLimitStatus,
  normalizeNativeLimitStatus,
} from '../../src/plugin/lib/limit-status-core.mjs';

const snapshotAt = '2026-11-11T00:00:00.000Z';
const values = [
  { id: 101, limit: 500000 },
  { id: 102, limit: 750000 },
];
const nativeStatus = () => ({
  binary: 'C:/fixture/language_server.exe',
  binary_sha256: 'a'.repeat(64),
  patch_state: { kind: 'patched', model_limits: values },
  settings_state: 'changed',
  saved_settings: { model_limits: [{ id: 101, limit: 400000 }] },
});

test('disk status keeps decoded limits separate from saved settings and rejects malformed claims', () => {
  const snapshot = normalizeNativeLimitStatus(nativeStatus(), snapshotAt);
  assert.deepEqual(snapshot.modelLimits, values);
  assert.deepEqual(snapshot.savedModelLimits, [{ id: 101, limit: 400000 }]);
  assert.equal(snapshot.settingsState, 'changed');
  const legacyLimits = [{ id: 0, limit: 500000 }];
  const legacy = normalizeNativeLimitStatus(
    {
      ...nativeStatus(),
      patch_state: { kind: 'patched', ids: [0], limit: 500000, model_limits: legacyLimits },
      saved_settings: { ids: [0], limit: 500000, model_limits: legacyLimits },
      settings_state: 'applied',
    },
    snapshotAt,
  );
  assert.deepEqual(legacy.modelLimits, legacyLimits);
  assert.deepEqual(legacy.savedModelLimits, legacyLimits);
  assert.deepEqual(
    normalizeNativeLimitStatus(
      {
        ...nativeStatus(),
        patch_state: { kind: 'original', model_limits: null },
        settings_state: 'not-applied',
      },
      snapshotAt,
    ).modelLimits,
    [],
  );
  for (const change of [
    { binary_sha256: 'not-a-hash' },
    { patch_state: { kind: 'patched', model_limits: [{ id: -1, limit: 500000 }] } },
    { patch_state: { kind: 'patched', model_limits: [...values, values[0]] } },
    { patch_state: { kind: 'patched', model_limits: [{ id: 1, limit: 2147483648 }] } },
    { patch_state: { kind: 'original', model_limits: values } },
    { patch_state: { kind: 'patched', ids: [101], limit: 500000 } },
    { settings_state: 'applied' },
    { saved_settings: {} },
  ])
    assert.throws(
      () => normalizeNativeLimitStatus({ ...nativeStatus(), ...change }, snapshotAt),
      /Invalid|Inconsistent/,
    );
  assert.deepEqual(
    normalizeLimitStatus({ ...snapshot, status: 'unavailable', error: 'native read failed' }),
    {
      status: 'unavailable',
      snapshotAt,
      error: 'native read failed',
    },
  );
});

test('installed sidecar reads decoded limits through the native CLI without mutating the selected installation', async (t) => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const targets = {
    'win32-x64': 'windows-amd64/agyctl.exe',
    'linux-x64': 'linux-amd64/agyctl',
    'darwin-arm64': 'darwin-arm64/agyctl',
  };
  const executable = targets[`${process.platform}-${process.arch}`];
  if (!executable || !fs.existsSync(path.join(root, 'dist/bin', executable))) {
    t.skip('Native CLI is not built for this supported target');
    return;
  }
  if (!['win32', 'linux'].includes(process.platform)) {
    t.skip('No recorded native limit fixture for this architecture');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-limit-status-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDir = path.join(directory, 'selected client');
  const stateDir = path.join(directory, 'tool-state');
  const binary = path.join(
    appDir,
    'resources/bin',
    process.platform === 'win32' ? 'language_server.exe' : 'language_server',
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const original = fs.readFileSync(
    path.join(
      root,
      'src/agyctl/testdata/limit',
      process.platform === 'win32' ? 'original.bin' : 'original-elf.bin',
    ),
  );
  fs.writeFileSync(binary, original);
  fs.writeFileSync(path.join(appDir, 'resources/app.asar'), 'fixture');
  fs.writeFileSync(
    path.join(appDir, process.platform === 'win32' ? 'Antigravity.exe' : 'antigravity'),
    'fixture',
  );
  const targetDir = path.join(directory, 'plugins/agyctl');
  installPlugin({ targetDir, env: { AGYCTL_APP_DIR: appDir, AGYCTL_HOME: stateDir } });
  const script = `import { readLimitStatus } from ${JSON.stringify(pathToFileURL(path.join(targetDir, 'sidecars/panel/limit-status.mjs')).href)};
    const a = readLimitStatus(), b = readLimitStatus();
    const snapshot = await a;
    console.log(JSON.stringify({ shared: a === b, cached: snapshot === await readLimitStatus(), snapshot }));`;
  const env = { ...process.env };
  delete env.AGYCTL_APP_DIR;
  delete env.AGYCTL_HOME;
  const run = async (overrides = {}) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
          cwd: root,
          env: { ...env, ...overrides },
          timeout: 20000,
          maxBuffer: 65536,
          windowsHide: true,
        })
      ).stdout,
    );
  const result = await run();
  assert.equal(result.shared, true);
  assert.equal(result.cached, true);
  assert.equal(result.snapshot.status, 'available', result.snapshot.error);
  assert.equal(result.snapshot.binary, binary);
  assert.equal(result.snapshot.patchKind, 'original');
  assert.equal(result.snapshot.settingsState, 'not-configured');
  assert.deepEqual(result.snapshot.modelLimits, []);
  assert.deepEqual(fs.readFileSync(binary), original);
  assert.equal(fs.existsSync(stateDir), false);
  const output = path.join(directory, 'patched.bin');
  await promisify(execFile)(
    path.join(root, 'dist/bin', executable),
    [
      '--root',
      root,
      'limit',
      'patch',
      '--json',
      '--binary',
      binary,
      '--ids',
      '101,102',
      '--limit',
      '500000',
      '--out',
      output,
    ],
    {
      env: { ...env, AGYCTL_APP_DIR: appDir, AGYCTL_HOME: stateDir },
      timeout: 20000,
      windowsHide: true,
    },
  );
  const patched = fs.readFileSync(output);
  fs.writeFileSync(binary, patched);
  const patchedResult = await run();
  assert.equal(patchedResult.snapshot.status, 'available', patchedResult.snapshot.error);
  assert.equal(patchedResult.snapshot.patchKind, 'patched');
  assert.equal(patchedResult.snapshot.settingsState, 'applied-unrecorded');
  assert.deepEqual(patchedResult.snapshot.modelLimits, [
    { id: 101, limit: 500000 },
    { id: 102, limit: 500000 },
  ]);
  assert.deepEqual(patchedResult.snapshot.savedModelLimits, []);
  assert.deepEqual(fs.readFileSync(binary), patched);
  const unavailable = await run({ AGYCTL_APP_DIR: path.join(directory, 'missing client') });
  assert.equal(unavailable.snapshot.status, 'unavailable');
  assert.match(unavailable.snapshot.error, /AGYCTL_APP_DIR/);
  assert.equal('modelLimits' in unavailable.snapshot, false);
});
