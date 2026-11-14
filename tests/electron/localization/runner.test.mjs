// P0-A gate runner: spawns the pinned Electron 44.10.2 build for each harness
// scenario and asserts its structured result. The binary comes from
// AGYCTL_ELECTRON_EXECUTABLE, the project's node_modules, or an independent
// install (plan §12.3); missing prerequisites fail when AGYCTL_REQUIRE_ELECTRON=1
// and otherwise report SKIP.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const harness = path.join(here, 'harness.cjs');
const electronPackage = path.resolve(here, '../../../node_modules/electron');

function skipMissingPrerequisite(t, reason) {
  if (process.env.AGYCTL_REQUIRE_ELECTRON === '1') assert.fail(reason);
  t.skip(reason);
}

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

const SCENARIOS = ['production-hook'];
const LOCALES = ['zh-Hant-TW', 'zh-Hans-CN', 'ja-JP'];
const repoRoot = path.resolve(here, '../../..');
let fixtureRoot;
const artifacts = new Map();

after(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
});

function prepareCatalogArtifact(locale) {
  if (artifacts.has(locale)) return artifacts.get(locale);
  if (!fixtureRoot) {
    fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'agyctl-electron-catalogs-'));
    const sample = path.join(fixtureRoot, 'sample');
    mkdirSync(sample);
    const profiles = JSON.parse(
      readFileSync(path.join(repoRoot, 'compat/localization/profiles.json'), 'utf8'),
    ).profiles;
    const profile = profiles.find((entry) => entry.version === '2.31.0');
    assert.ok(profile, 'The 2.31.0 source profile is required for this isolated fixture');
    const usage = JSON.parse(
      readFileSync(path.join(repoRoot, 'compat/localization/usage-points.json'), 'utf8'),
    ).profiles[profile.profileId];
    const main = usage.fallbackRules
      .flatMap((rule) =>
        Array.from({ length: rule.expectedHits }, () => {
          if (rule.kind === 'nls-default-string')
            return `${profile.nlsHelper.calleeName}(${JSON.stringify(rule.upstreamKey)}, ${JSON.stringify(rule.originalText)});`;
          if (rule.kind === 'template-literal')
            return (
              'void `' +
              rule.originalText.replace(/\{(\d+)\}/g, (_, index) => '${value' + index + '}') +
              '`;'
            );
          if (rule.kind === 'element-child')
            return `A.createElement('span', null, ${JSON.stringify(rule.originalText)});`;
          assert.equal(rule.kind, 'literal', `Unhandled fixture rule kind: ${rule.kind}`);
          return rule.withinProperty
            ? `void ({${JSON.stringify(rule.withinProperty)}: ${JSON.stringify(rule.originalText)}});`
            : `void ${JSON.stringify(rule.originalText)};`;
        }),
      )
      .join('\n');
    writeFileSync(path.join(sample, 'main.js'), main);
    writeFileSync(
      path.join(sample, 'index.html'),
      '<!doctype html><html><body>Isolated source fixture</body></html>',
    );
  }
  const prepared = spawnSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts/localization.mjs'),
      'prepare',
      '--format',
      'dom',
      '--locale',
      locale,
      '--sample-dir',
      path.join(fixtureRoot, 'sample'),
      '--json',
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      env: { ...process.env, AGYCTL_HOME: path.join(fixtureRoot, 'tool-state') },
    },
  );
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const artifact = JSON.parse(prepared.stdout);
  assert.equal(
    artifact.installationQualified,
    false,
    'A synthetic sample is not real-client acceptance',
  );
  const manifest = JSON.parse(readFileSync(path.join(artifact.directory, 'manifest.json'), 'utf8'));
  assert.match(manifest.nativeCatalogSha256, /^[a-f0-9]{64}$/);
  artifacts.set(locale, artifact.directory);
  return artifact.directory;
}

const electronExecutable = resolveElectronExecutable();

// The pinned version is evidence, not a comment: the actual binary must match
// the package pin or the run is not the verification it claims to be.
const electronVersion = (() => {
  if (!electronExecutable) return null;
  const probe = spawnSync(electronExecutable, ['--version'], { encoding: 'utf8', timeout: 30_000 });
  return probe.status === 0 ? probe.stdout.trim() : null;
})();

for (const locale of LOCALES) {
  for (const scenario of SCENARIOS) {
    test(`localization delivery harness: ${scenario} (${locale})`, async (t) => {
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
        skipMissingPrerequisite(
          t,
          'localization bundles are not built; run npm run localization:build',
        );
        return;
      }
      if (!electronExecutable) {
        skipMissingPrerequisite(
          t,
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
        [
          harness,
          scenario,
          prepareCatalogArtifact(locale),
          '--disable-gpu',
          '--disable-software-rasterizer',
        ],
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
      assert.equal(payload.locale, locale);
      assert.equal(
        payload.ok,
        true,
        `${scenario} failed checks: ${JSON.stringify(payload.checks ?? [])}`,
      );
      assert.equal(result.status, 0, `${scenario} exited with ${result.status}: ${result.stderr}`);
    });
  }

  test(`localization DOM engine harness (${locale})`, async (t) => {
    const bundlePath = path.join(
      here,
      '..',
      '..',
      '..',
      'dist',
      'localization',
      'bundle',
      'dom-engine.js',
    );
    if (!existsSync(bundlePath)) {
      skipMissingPrerequisite(
        t,
        'localization bundles are not built; run npm run localization:build',
      );
      return;
    }
    if (!electronExecutable) {
      skipMissingPrerequisite(
        t,
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
      [
        path.join(here, 'dom-engine-harness.cjs'),
        prepareCatalogArtifact(locale),
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
      { encoding: 'utf8', timeout: 45_000, windowsHide: true },
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
    assert.equal(payload.locale, locale);
    assert.equal(
      payload.ok,
      true,
      `dom-engine failed checks: ${JSON.stringify(payload.checks ?? [])}`,
    );
    assert.equal(result.status, 0, `dom-engine exited with ${result.status}: ${result.stderr}`);
  });
}
