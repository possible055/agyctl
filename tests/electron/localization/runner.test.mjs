// P0-A gate runner: spawns the pinned Electron 44.10.2 build for each harness
// scenario and asserts its structured result. The binary comes from
// AGYCTL_ELECTRON_EXECUTABLE, the project's node_modules, or an independent
// install (plan §12.3); tests report SKIP when none is available.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(here, 'harness.cjs');
const electronPackage = path.resolve(here, '../../../node_modules/electron');

// The package records its binary's location relative to dist/ in path.txt; the
// file is absent when install scripts are disabled and no binary was fetched.
function installedElectronExecutable() {
  try {
    const relative = readFileSync(path.join(electronPackage, 'path.txt'), 'utf8').trim();
    const candidate = path.join(electronPackage, 'dist', relative);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveElectronExecutable() {
  if (process.env.AGYCTL_ELECTRON_EXECUTABLE) return process.env.AGYCTL_ELECTRON_EXECUTABLE;
  const installed = installedElectronExecutable();
  if (installed) return installed;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return null;
  const candidate = path.join(
    localAppData,
    'agyctl',
    'electron-test',
    'node_modules',
    'electron',
    'dist',
    'electron.exe',
  );
  return existsSync(candidate) ? candidate : null;
}

const SCENARIOS = [
  'precise-delivery',
  'reload-and-parallel',
  'forwarding-integrity',
  'refusals',
  'rearm',
  'production-hook',
];

const electronExecutable = resolveElectronExecutable();

// The pinned version is evidence, not a comment: the actual binary must match
// the package pin or the run is not the verification it claims to be.
const electronVersion = (() => {
  if (!electronExecutable) return null;
  const probe = spawnSync(electronExecutable, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return probe.status === 0 ? probe.stdout.trim() : null;
})();

for (const scenario of SCENARIOS) {
  test(`localization delivery harness: ${scenario}`, async (t) => {
    const bundlePath = path.join(
      here,
      '..',
      '..',
      '..',
      'dist',
      'localization',
      'bundle',
      'host-engine.cjs',
    );
    if (!existsSync(bundlePath)) {
      t.skip('localization bundles are not built; run npm run localization:build');
      return;
    }
    if (!electronExecutable) {
      t.skip(
        'official Electron 44.10.2 is not available; install it in node_modules or set AGYCTL_ELECTRON_EXECUTABLE',
      );
      return;
    }
    t.diagnostic(
      `electron executable: ${electronExecutable} (${electronVersion ?? 'version unknown'})`,
    );
    assert.equal(
      electronVersion,
      'v44.10.2',
      `The pinned Electron 44.10.2 is required; the executable reports ${electronVersion}`,
    );
    const result = spawnSync(
      electronExecutable,
      [harness, scenario, '--disable-gpu', '--disable-software-rasterizer'],
      { encoding: 'utf8', timeout: 150_000, windowsHide: true },
    );
    const lines = (result.stdout ?? '').split('\n').filter((line) => line.startsWith('#'));
    const resultLine = lines.find((line) => line.startsWith('#RESULT '));
    const fatalLine = lines.find((line) => line.startsWith('#FATAL '));
    if (!resultLine) {
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.slice(-4000);
      assert.fail(`harness produced no result (exit ${result.status}): ${fatalLine ?? output}`);
    }
    const payload = JSON.parse(resultLine.slice('#RESULT '.length));
    assert.equal(payload.electronVersion, '44.10.2');
    assert.equal(
      payload.ok,
      true,
      `${scenario} failed checks: ${JSON.stringify(payload.checks ?? [])}`,
    );
    assert.equal(result.status, 0, `${scenario} exited with ${result.status}: ${result.stderr}`);
  });
}
