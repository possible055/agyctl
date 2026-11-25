// Startup snapshot contract between the CLI tool state and the Host engine
// (plan §4.5): selection.json + artifact manifest drive the runtime binding,
// the ASAR pins only stateRoot/installationId, and runtime status persists as
// last-known evidence. Fixtures are synthetic; nothing here touches an install.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parse } from '@formatjs/icu-messageformat-parser';
import hostEngine, {
  RuntimePersistence,
  readRuntimeStatus,
  resolveStartupSnapshot,
  StartupError,
} from '../../dist/localization/bundle/host-engine.cjs';
import { loadLocalizationInputs } from '../../scripts/lib/host-patch.mjs';

// The engine bundle is CommonJS; node's named-export detection does not cover
// every re-export, so the native helpers come off the default export.
const { initNativeMessages, nativeAgentsRunning, nativeFormat, nativeText, resetNativeMessages } =
  hostEngine;

const HUB_PROFILE_ID = 'hub-win-x64-2.29.0-290e1b7a';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-runtime-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Builds a reviewed-shaped artifact under stateRoot for the real Hub profile. */
function buildArtifact(root, { locale = 'zh-Hant-TW' } = {}) {
  const stateRoot = path.join(root, 'localization');
  const profiles = JSON.parse(fs.readFileSync('compat/localization/profiles.json', 'utf8'));
  const profile = profiles.profiles.find((entry) => entry.profileId === HUB_PROFILE_ID);
  const main = Buffer.from('// synthetic localized bundle\nvoid globalThis.agyctlLocalization;\n');
  const coverage = `${JSON.stringify({ schemaVersion: 2, profileId: HUB_PROFILE_ID, locale, probe: false, hits: [], replacedMessages: 0, totalReplacements: 0, messages: [], excluded: [] })}\n`;
  const artifactId = digest(Buffer.concat([main, Buffer.from(locale)]))
    .slice(0, 64)
    .padEnd(64, '0');
  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      artifactId,
      profileId: HUB_PROFILE_ID,
      locale,
      formatLocale: locale,
      sourceMainSha256: profile.assets['main.js'].sha256,
      sourceIdentity: digest(Buffer.from('fixture-source')).padEnd(64, '0'),
      catalogSha256: digest(Buffer.from('fixture-catalog')),
      adapterVersion: profile.adapterVersion,
      toolchainSha256: digest(Buffer.from('fixture-toolchain')),
      assets: [{ route: '/main.js', file: 'main.js', sha256: digest(main) }],
      nativeCatalogSha256: null,
      coverageSha256: digest(Buffer.from(coverage)),
    },
    null,
    2,
  )}\n`;
  const directory = path.join(stateRoot, 'artifacts', artifactId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'main.js'), main);
  fs.writeFileSync(path.join(directory, 'manifest.json'), manifest);
  fs.writeFileSync(path.join(directory, 'coverage.json'), coverage);
  return {
    stateRoot,
    artifactId,
    locale,
    sourceMainSha256: profile.assets['main.js'].sha256,
    mainSha256: digest(main),
  };
}

/** Installs the v2 runtime config exactly as host-patch composes it, plus selection.json. */
function installSelection(root, artifact, { installationId, locale } = {}) {
  const inputs = loadLocalizationInputs({
    profileId: HUB_PROFILE_ID,
    artifactId: artifact.artifactId,
    installationId,
    stateRoot: artifact.stateRoot,
  });
  const config = inputs.files['dist/agyctl-localization/runtime-config.json'];
  assert.ok(config, 'the reviewed adapter must provide the runtime config');
  const configDir = path.join(root, 'installed', 'dist', 'agyctl-localization');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'runtime-config.json'), config);
  const selectedLocale = locale ?? artifact.locale;
  fs.mkdirSync(path.join(artifact.stateRoot, 'installations', installationId), { recursive: true });
  fs.writeFileSync(
    path.join(artifact.stateRoot, 'installations', installationId, 'selection.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        installationId,
        artifactId: artifact.artifactId,
        locale: selectedLocale,
        selectedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return { configDir, configJson: JSON.parse(config.toString('utf8')) };
}

test('startup resolution follows the reviewed selection snapshot end to end', (t) => {
  const root = temporary(t);
  const artifact = buildArtifact(root);
  const installationId = digest(Buffer.from(path.join(root, 'app.asar')));
  const { configDir, configJson } = installSelection(root, artifact, { installationId });
  assert.deepEqual(configJson, {
    schemaVersion: 2,
    stateRoot: artifact.stateRoot,
    installationId,
  });
  const snapshot = resolveStartupSnapshot(configDir);
  assert.equal(snapshot.mode, 'selection');
  assert.equal(snapshot.format, 'ast');
  assert.equal(snapshot.installationId, installationId);
  assert.equal(snapshot.artifactId, artifact.artifactId);
  assert.equal(snapshot.locale, artifact.locale);
  assert.equal(snapshot.sourceMainSha256, artifact.sourceMainSha256);
  assert.equal(snapshot.mainSha256, artifact.mainSha256);
  assert.equal(snapshot.engineSha256, null);
  assert.equal(snapshot.indexSha256, null);
});

test('a re-selection takes effect without changing the installed config', (t) => {
  const root = temporary(t);
  const first = buildArtifact(root, { locale: 'zh-Hant-TW' });
  const second = buildArtifact(root, { locale: 'ja-JP' });
  assert.notEqual(first.artifactId, second.artifactId);
  const installationId = digest(Buffer.from(path.join(root, 'app.asar')));
  installSelection(root, first, { installationId });
  const configDir = path.join(root, 'installed', 'dist', 'agyctl-localization');
  assert.equal(resolveStartupSnapshot(configDir).artifactId, first.artifactId);
  fs.writeFileSync(
    path.join(first.stateRoot, 'installations', installationId, 'selection.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        installationId,
        artifactId: second.artifactId,
        locale: second.locale,
        selectedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  const rebound = resolveStartupSnapshot(configDir);
  assert.equal(rebound.artifactId, second.artifactId);
  assert.equal(rebound.locale, 'ja-JP');
});

test('a missing selection is a concrete startup error, not a silent fallback', (t) => {
  const root = temporary(t);
  const artifact = buildArtifact(root);
  const inputs = loadLocalizationInputs({
    profileId: HUB_PROFILE_ID,
    artifactId: artifact.artifactId,
    installationId: 'a'.repeat(64),
    stateRoot: artifact.stateRoot,
  });
  const configDir = path.join(root, 'installed', 'dist', 'agyctl-localization');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'runtime-config.json'),
    inputs.files['dist/agyctl-localization/runtime-config.json'],
  );
  assert.throws(
    () => resolveStartupSnapshot(configDir),
    (error) => error instanceof StartupError && error.code === 'SELECTION_MISSING',
  );
});

test('a tampered selected artifact is rejected before serving', (t) => {
  const root = temporary(t);
  const artifact = buildArtifact(root);
  const installationId = 'b'.repeat(64);
  installSelection(root, artifact, { installationId });
  fs.appendFileSync(
    path.join(artifact.stateRoot, 'artifacts', artifact.artifactId, 'main.js'),
    '\n// tampered\n',
  );
  assert.throws(
    () => resolveStartupSnapshot(path.join(root, 'installed', 'dist', 'agyctl-localization')),
    (error) => error instanceof StartupError && error.code === 'ARTIFACT_INVALID',
  );
});

test('selection and artifact manifest must agree on the locale', (t) => {
  const root = temporary(t);
  const artifact = buildArtifact(root);
  const installationId = 'c'.repeat(64);
  installSelection(root, artifact, { installationId, locale: 'zh-Hans-CN' });
  assert.throws(
    () => resolveStartupSnapshot(path.join(root, 'installed', 'dist', 'agyctl-localization')),
    (error) => error instanceof StartupError && error.code === 'SELECTION_INVALID',
  );
});

function buildDomArtifact(root, { locale = 'zh-Hant-TW' } = {}) {
  const stateRoot = path.join(root, 'localization');
  const profiles = JSON.parse(fs.readFileSync('compat/localization/profiles.json', 'utf8'));
  const profile = profiles.profiles.find((entry) => entry.profileId === HUB_PROFILE_ID);
  const index = `${JSON.stringify({
    schemaVersion: 1,
    locale,
    exact: { 'Open Settings': { messageId: 'nav.openSettings', translation: '開啟設定' } },
    templates: [],
  })}\n`;
  const engineSha256 = 'a'.repeat(64);
  const indexSha256 = digest(Buffer.from(index));
  const artifactId = digest(Buffer.concat([Buffer.from(locale), Buffer.from(indexSha256)]))
    .slice(0, 64)
    .padEnd(64, '0');
  const manifest = `${JSON.stringify(
    {
      schemaVersion: 2,
      format: 'dom',
      artifactId,
      profileId: HUB_PROFILE_ID,
      locale,
      formatLocale: locale,
      engineVersion: 1,
      engineSha256,
      scopesVersion: 1,
      indexSha256,
      catalogSha256: digest(Buffer.from('fixture-catalog')),
      adapterVersion: profile.adapterVersion,
      toolchainSha256: digest(Buffer.from('fixture-toolchain')),
      nativeCatalogSha256: null,
      sourceIdentity: digest(Buffer.from('fixture-source')).padEnd(64, '0'),
      sourceMainSha256: profile.assets['main.js'].sha256,
    },
    null,
    2,
  )}\n`;
  const directory = path.join(stateRoot, 'artifacts', artifactId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'index.json'), index);
  fs.writeFileSync(path.join(directory, 'manifest.json'), manifest);
  return { stateRoot, artifactId, locale, engineSha256, indexSha256 };
}

test('a DOM artifact snapshot does not require rewritten main.js', (t) => {
  const root = temporary(t);
  const artifact = buildDomArtifact(root);
  const installationId = digest(Buffer.from(path.join(root, 'app.asar')));
  installSelection(root, artifact, { installationId });
  const snapshot = resolveStartupSnapshot(
    path.join(root, 'installed', 'dist', 'agyctl-localization'),
  );
  assert.equal(snapshot.format, 'dom');
  assert.equal(snapshot.artifactId, artifact.artifactId);
  assert.equal(snapshot.locale, artifact.locale);
  assert.equal(snapshot.mainSha256, null);
  assert.equal(snapshot.engineSha256, artifact.engineSha256);
  assert.equal(snapshot.indexSha256, artifact.indexSha256);
});

test('unknown artifact schema versions are rejected', (t) => {
  const root = temporary(t);
  const artifact = buildArtifact(root);
  const installationId = 'e'.repeat(64);
  installSelection(root, artifact, { installationId });
  const manifestPath = path.join(
    artifact.stateRoot,
    'artifacts',
    artifact.artifactId,
    'manifest.json',
  );
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 3 }));
  assert.throws(
    () => resolveStartupSnapshot(path.join(root, 'installed', 'dist', 'agyctl-localization')),
    (error) => error instanceof StartupError && error.code === 'ARTIFACT_INVALID',
  );
});

test('schema-less runtime configs are rejected instead of loading an embedded binding', (t) => {
  const root = temporary(t);
  const configDir = path.join(root, 'installed', 'dist', 'agyctl-localization');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'runtime-config.json'),
    JSON.stringify({
      stateRoot: path.join(root, 'localization'),
      artifactId: 'd'.repeat(64),
      locale: 'zh-Hant-TW',
      sourceMainSha256: 'e'.repeat(64),
      mainSha256: 'f'.repeat(64),
    }),
  );
  assert.throws(
    () => resolveStartupSnapshot(configDir),
    (error) => error instanceof StartupError && error.code === 'RUNTIME_CONFIG_INVALID',
  );
});

test('runtime config is decoded field by field, not cast', (t) => {
  const root = temporary(t);
  const configDir = path.join(root, 'installed', 'dist', 'agyctl-localization');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'runtime-config.json'),
    JSON.stringify({
      schemaVersion: 2,
      stateRoot: path.join(root, 'localization'),
      installationId: 'not-hex',
    }),
  );
  assert.throws(
    () => resolveStartupSnapshot(configDir),
    (error) => error instanceof StartupError && error.code === 'RUNTIME_CONFIG_INVALID',
  );
});

test('runtime persistence records events and the last-known status snapshot', (t) => {
  const root = temporary(t);
  const stateRoot = path.join(root, 'localization');
  const installationId = '1'.repeat(64);
  const persistence = new RuntimePersistence({ stateRoot, installationId });
  persistence.sink({
    level: 'info',
    stage: 'runtime.navigation',
    event: 'armed',
    result: 'armed',
    artifactId: '2'.repeat(64),
    locale: 'zh-Hant-TW',
  });
  persistence.recordStatus({
    artifactId: '2'.repeat(64),
    locale: 'zh-Hant-TW',
    healthState: 'active',
  });
  const statusPath = path.join(stateRoot, 'installations', installationId, 'runtime-status.json');
  const recorded = readRuntimeStatus(statusPath);
  assert.ok('status' in recorded, JSON.stringify(recorded));
  assert.equal(recorded.status.healthState, 'active');
  assert.equal(recorded.status.logging, 'active');
  assert.equal(recorded.status.installationId, installationId);
  assert.equal(recorded.status.terminal, null);
  persistence.recordStatus({
    artifactId: '2'.repeat(64),
    locale: 'zh-Hant-TW',
    healthState: 'degraded',
    terminal: { code: 'ACTIVATION_TIMEOUT', message: 'timed out' },
  });
  const degraded = readRuntimeStatus(statusPath);
  assert.ok('status' in degraded);
  assert.equal(degraded.status.terminal.code, 'ACTIVATION_TIMEOUT');
  assert.equal(degraded.status.healthState, 'degraded');
  const logFiles = fs.readdirSync(path.join(stateRoot, 'logs', 'runtime', installationId));
  assert.equal(logFiles.length, 1);
  const events = fs
    .readFileSync(path.join(stateRoot, 'logs', 'runtime', installationId, logFiles[0]), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(events[0].stage, 'runtime.navigation');
  assert.equal(events[0].component, 'localization-runtime');
  assert.equal(events[0].installationId, installationId);
  assert.equal(events[0].runId, degraded.status.runId);
  assert.equal(events[0].operationId, degraded.status.runId);
});

test('runtime persistence degrades to diagnostics instead of failing the host', (t) => {
  const root = temporary(t);
  const stateRoot = path.join(root, 'localization');
  const installationId = '3'.repeat(64);
  fs.mkdirSync(path.join(stateRoot, 'logs', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(stateRoot, 'logs', 'runtime', installationId), 'not a directory');
  const persistence = new RuntimePersistence({ stateRoot, installationId });
  assert.equal(persistence.logging, 'unavailable');
  assert.doesNotThrow(() =>
    persistence.sink({
      level: 'info',
      stage: 'runtime.attach',
      event: 'attached',
      result: 'armed',
    }),
  );
  persistence.recordStatus({ artifactId: null, locale: null, healthState: 'ready' });
  const recorded = readRuntimeStatus(
    path.join(stateRoot, 'installations', installationId, 'runtime-status.json'),
  );
  assert.ok('status' in recorded, JSON.stringify(recorded));
  assert.equal(recorded.status.logging, 'unavailable');
});

test('runtime status reads report absence explicitly instead of guessing', (t) => {
  const root = temporary(t);
  const missing = readRuntimeStatus(path.join(root, 'none', 'runtime-status.json'));
  assert.ok('error' in missing && /no runtime status/.test(missing.error));
  const brokenPath = path.join(root, 'broken.json');
  fs.writeFileSync(brokenPath, '{ not json');
  const broken = readRuntimeStatus(brokenPath);
  assert.ok('error' in broken);
  assert.ok(!('status' in broken));
});

test('native helpers translate from the verified catalog and fall back to the original', (t) => {
  // Type: unit / Contract: native.json is hash-verified against the artifact
  // manifest before use; without it (or on mismatch) every helper returns the
  // original text / Fails when: a tampered catalog is applied, the plural
  // selection picks the wrong variant, or the untranslated fallback breaks
  // / Not covered by: any earlier test (runtime/native.ts is new).
  t.after(() => resetNativeMessages());
  const root = temporary(t);
  const { stateRoot, artifactId } = buildArtifact(root);
  const artifactDir = path.join(stateRoot, 'artifacts', artifactId);
  const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8'));
  const catalog = {
    schemaVersion: 1,
    locale: 'zh-Hant-TW',
    messages: {
      'session.quit': '結束',
      'tray.agentsRunning.zero': '沒有執行中的 Agent',
      'tray.agentsRunning.one': '{0} 個 Agent 執行中',
      'tray.agentsRunning.other': '{0} 個 Agent 執行中',
    },
  };
  let nativeBytes = `${JSON.stringify(catalog, null, 2)}\n`;
  fs.writeFileSync(path.join(artifactDir, 'native.json'), nativeBytes);
  fs.writeFileSync(
    path.join(artifactDir, 'manifest.json'),
    JSON.stringify({ ...manifest, nativeCatalogSha256: digest(Buffer.from(nativeBytes)) }),
  );
  assert.deepEqual(initNativeMessages({ stateRoot, artifactId, locale: catalog.locale }), {
    ok: true,
  });
  assert.equal(nativeText('session.quit', 'Quit'), '結束');
  assert.equal(nativeText('session.unknown', 'Original'), 'Original');
  assert.equal(nativeAgentsRunning(0), '沒有執行中的 Agent');
  assert.equal(nativeAgentsRunning(1), '1 個 Agent 執行中');
  assert.equal(nativeAgentsRunning(3), '3 個 Agent 執行中');
  // Contract: native dynamic messages use the artifact's compiled ICU with the
  // original values, not a second parser or repeated positional replacement.
  catalog.messages['tray.agentsRunning'] =
    '{0, plural, =0 {沒有執行中的 Agent} other {# 個 Agent 執行中}}';
  catalog.messages['session.agentExited'] = 'Agent {0} 已結束';
  catalog.compiledMessages = {
    'tray.agentsRunning': parse(catalog.messages['tray.agentsRunning']),
    'session.agentExited': parse(catalog.messages['session.agentExited']),
  };
  nativeBytes = `${JSON.stringify(catalog)}\n`;
  fs.writeFileSync(path.join(artifactDir, 'native.json'), nativeBytes);
  fs.writeFileSync(
    path.join(artifactDir, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      nativeCatalogSha256: digest(Buffer.from(nativeBytes)),
    }),
  );
  assert.deepEqual(initNativeMessages({ stateRoot, artifactId, locale: catalog.locale }), {
    ok: true,
  });
  assert.equal(nativeAgentsRunning(0), '沒有執行中的 Agent');
  assert.equal(nativeAgentsRunning(3), '3 個 Agent 執行中');
  assert.equal(
    nativeFormat('session.agentExited', 'Agent {0} exited', ['{0}']),
    'Agent {0} 已結束',
  );
  for (const invalid of [
    { artifactId: '0'.repeat(64) },
    { locale: 'ja-JP' },
    { nativeCatalogSha256: '0'.repeat(64) },
  ]) {
    fs.writeFileSync(
      path.join(artifactDir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        nativeCatalogSha256: digest(Buffer.from(nativeBytes)),
      }),
    );
    assert.deepEqual(initNativeMessages({ stateRoot, artifactId, locale: catalog.locale }), {
      ok: true,
    });
    fs.writeFileSync(
      path.join(artifactDir, 'manifest.json'),
      JSON.stringify({
        ...manifest,
        nativeCatalogSha256: digest(Buffer.from(nativeBytes)),
        ...invalid,
      }),
    );
    const result = initNativeMessages({ stateRoot, artifactId, locale: catalog.locale });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'NATIVE_CATALOG_INVALID');
    assert.equal(nativeText('session.quit', 'Quit'), 'Quit');
  }
});

test('a tampered native catalog is refused and helpers keep the original text', (t) => {
  t.after(() => resetNativeMessages());
  const root = temporary(t);
  const { stateRoot, artifactId } = buildArtifact(root, { locale: 'ja-JP' });
  const artifactDir = path.join(stateRoot, 'artifacts', artifactId);
  const manifest = JSON.parse(fs.readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8'));
  fs.writeFileSync(
    path.join(artifactDir, 'native.json'),
    JSON.stringify({ schemaVersion: 1, locale: 'ja-JP', messages: { 'session.quit': '偽' } }),
  );
  fs.writeFileSync(
    path.join(artifactDir, 'manifest.json'),
    JSON.stringify({
      ...manifest,
      nativeCatalogSha256: 'c'.repeat(64),
    }),
  );
  initNativeMessages({ stateRoot, artifactId, locale: 'ja-JP' });
  assert.equal(nativeText('session.quit', 'Quit'), 'Quit');
  assert.equal(nativeAgentsRunning(2), '2 agents running');
});

test('refreshHostLocalization rejects invalid or deleted selections without dropping the active binding', (t) => {
  const root = temporary(t);
  const first = buildDomArtifact(root, { locale: 'zh-Hant-TW' });
  const second = buildDomArtifact(root, { locale: 'ja-JP' });
  const installationId = digest(Buffer.from(path.join(root, 'app.asar')));
  const { configDir } = installSelection(root, first, { installationId });
  const runtimeCopy = path.join(configDir, 'host-engine.cjs');
  fs.copyFileSync('dist/localization/bundle/host-engine.cjs', runtimeCopy);
  const domEnginePath = path.join(configDir, 'dom-engine.js');
  const engineBytes = fs.readFileSync('dist/localization/bundle/dom-engine.js');
  fs.writeFileSync(domEnginePath, engineBytes);
  const realEngineSha = digest(engineBytes);
  for (const item of [first, second]) {
    const mPath = path.join(item.stateRoot, 'artifacts', item.artifactId, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mPath, 'utf8'));
    m.engineSha256 = realEngineSha;
    fs.writeFileSync(mPath, JSON.stringify(m));
  }
  const Module = globalThis.process.getBuiltinModule('node:module');
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { once() {}, removeListener() {} },
        ipcMain: { handle() {}, removeHandler() {} },
      };
    }
    return origLoad.call(this, request, parent, isMain);
  };
  t.after(() => {
    Module._load = origLoad;
  });
  const req = Module.createRequire(import.meta.url);
  const hostRuntime = req(runtimeCopy);
  t.after(() => hostRuntime.closeRuntimePersistence());
  const initial = hostRuntime.initializeHostRuntime();
  assert.equal(initial?.locale, 'zh-Hant-TW');

  const selectionPath = path.join(
    first.stateRoot,
    'installations',
    installationId,
    'selection.json',
  );
  fs.rmSync(selectionPath);
  const afterDelete = hostRuntime.refreshHostLocalization();
  assert.equal(afterDelete.changed, false);
  assert.equal(afterDelete.locale, 'zh-Hant-TW');
  assert.equal(afterDelete.code, 'SELECTION_MISSING');

  fs.writeFileSync(selectionPath, '{ bad json');
  const afterBroken = hostRuntime.refreshHostLocalization();
  assert.equal(afterBroken.changed, false);
  assert.equal(afterBroken.locale, 'zh-Hant-TW');
  assert.equal(afterBroken.code, 'SELECTION_INVALID');

  fs.writeFileSync(
    selectionPath,
    JSON.stringify({
      schemaVersion: 1,
      installationId,
      artifactId: second.artifactId,
      locale: second.locale,
      selectedAt: new Date().toISOString(),
    }),
  );
  const afterSwitch = hostRuntime.refreshHostLocalization();
  assert.deepEqual(afterSwitch, {
    changed: true,
    locale: 'ja-JP',
    artifactId: second.artifactId,
  });
});
