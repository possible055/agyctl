import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const executable =
  process.env.AGYCTL_ELECTRON_EXECUTABLE ||
  path.join(
    repo,
    'node_modules/electron/dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron',
  );

test('actual Electron capsule and panel share locale before paint, offline and after reinjection', (t) => {
  if (!existsSync(executable)) {
    t.skip('Electron is unavailable; install it locally or set AGYCTL_ELECTRON_EXECUTABLE');
    return;
  }
  const profileRoot = mkdtempSync(path.join(os.tmpdir(), 'agyctl-capsule-electron-'));
  try {
    const result = spawnSync(executable, [path.join(here, 'harness.cjs'), profileRoot], {
      encoding: 'utf8',
      timeout: 45_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.equal(result.error, undefined, output);
    assert.equal(result.signal, null, output);
    assert.equal(result.status, 0, output);
    const line = output.split('\n').find((value) => value.startsWith('#RESULT '));
    assert.notEqual(line, undefined, output);
    const payload = JSON.parse(line.slice('#RESULT '.length));
    assert.equal(payload.ok, true, output);
    assert.deepEqual(Object.keys(payload.checks), [
      'initialHostAuthority',
      'offlineLanguageSwitches',
      'latePanelInheritance',
      'reinjectionAndSingleCycle',
      'viewportAndClickBehavior',
      'standaloneBeforePaint',
    ]);
    for (const [name, value] of Object.entries(payload.checks)) assert.equal(value, true, name);
    assert.match(payload.electron, /^44\./);
    t.diagnostic(`unsaved startup: ${JSON.stringify(payload.observations.unsavedStartup)}`);
    t.diagnostic(`plugin boundary: ${JSON.stringify(payload.observations.pluginBoundary)}`);
  } finally {
    rmSync(profileRoot, { recursive: true, force: true });
  }
});
