// Isolated Host bootstrap scenarios. The test session may intercept https to
// stand in for the Hub origin; localization itself must not take over that
// handler or rewrite /main.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const preparedArtifactDir = process.argv[3];
const preparedManifest = JSON.parse(
  fs.readFileSync(path.join(preparedArtifactDir, 'manifest.json'), 'utf8'),
);
const LOCALE = preparedManifest.locale;
const EXPECTED = {
  'zh-Hant-TW': {
    settings: '開啟設定',
    customizations: '自訂設定',
    newWindow: '新增視窗',
    cancel: '取消',
    checkUpdates: '檢查更新',
    restart: '重新啟動以更新',
    agents: '2 個代理執行中',
    wsl: 'WSL 發行版「Ubuntu {0}」已不再安裝於此電腦。',
  },
  'zh-Hans-CN': {
    settings: '打开设置',
    customizations: '自定义设置',
    newWindow: '新建窗口',
    cancel: '取消',
    checkUpdates: '检查更新',
    restart: '重启以更新',
    agents: '2 个代理运行中',
    wsl: 'WSL 发行版“Ubuntu {0}”已不再安装于此电脑。',
  },
  'ja-JP': {
    settings: '設定を開く',
    customizations: 'カスタマイズ',
    newWindow: '新しいウィンドウ',
    cancel: 'キャンセル',
    checkUpdates: 'アップデートを確認',
    restart: '再起動して更新',
    agents: '2 件のエージェントが実行中',
    wsl: 'WSL ディストリビューション「Ubuntu {0}」はインストールされていません。',
  },
}[LOCALE];
if (!EXPECTED) throw new Error('Unrecognized catalog fixture locale');
const HUB_ORIGIN = 'https://127.0.0.1';
const HUB_URL = `${HUB_ORIGIN}/`;
const HUB_HTML = `<!doctype html>
<html><body>
<nav><button id="settings">Open Settings</button></nav>
<div data-testid="aux-pane-split"><h1 id="page-title" class="text-xl font-medium text-foreground select-none m-0">Customizations</h1></div>
<div data-testid="planner-response-text" id="ai">Open Settings</div>
</body></html>`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(poll, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await poll()) return;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(50);
  }
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeChecks() {
  const checks = [];
  return {
    checks,
    check(name, pass, detail) {
      checks.push({ name, pass: Boolean(pass), detail: pass ? undefined : String(detail) });
      return Boolean(pass);
    },
  };
}

async function createWorld(name) {
  const { session } = require('electron');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agyctl-l10n-${name}-`));
  const ses = session.fromPartition(`agyctl-harness-${name}-${process.pid}-${Date.now()}`, {
    cache: false,
  });
  let firstDocument = true;
  ses.protocol.handle('https', (request) => {
    const url = new URL(request.url);
    if (
      url.origin !== HUB_ORIGIN ||
      !['/', '/customizations', '/sidecars', '/c/conversation-1'].includes(url.pathname)
    )
      return new Response('not found', { status: 404 });
    const html = firstDocument
      ? '<!doctype html><html><body><div data-testid="planner-response-text" id="ai">Open Settings</div></body></html>'
      : HUB_HTML;
    firstDocument = false;
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  });
  const engineSource = fs.readFileSync(
    path.join(__dirname, '../../../dist/localization/bundle/dom-engine.js'),
  );
  const bridge = fs.readFileSync(
    path.join(__dirname, '../../../dist/localization/bundle/preload-bridge.cjs'),
    'utf8',
  );
  const preloadPath = path.join(tmpDir, 'preload.js');
  fs.writeFileSync(preloadPath, `window.__HARNESS_PRELOAD_RAN__ = true;\n${bridge}`);
  return {
    ses,
    tmpDir,
    preloadPath,
    engineSource,
    engineSha256: digest(engineSource),
    cleanup: async () => {
      ses.protocol.unhandle('https');
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function openHubWindow(world, BrowserWindow) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: world.preloadPath,
      session: world.ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  return { win, wc: win.webContents };
}

function snapshot(wc) {
  return wc.executeJavaScript(`JSON.stringify({
    settings: document.getElementById('settings') && document.getElementById('settings').textContent,
    ai: document.getElementById('ai') && document.getElementById('ai').textContent,
    preload: window.__HARNESS_PRELOAD_RAN__ === true,
    factory: typeof window.__AGYCTL_DOM_ENGINE__?.createDomEngine === 'function',
    engine: typeof window.__agyctlDomEngine__?.stats === 'function',
    marked: window.__RELOAD_MARKER__ === true,
    pathname: location.pathname,
    search: location.search,
    heading: document.getElementById('page-title')?.textContent ?? null
  })`);
}

async function waitForPage(wc, predicate, label) {
  await waitFor(
    async () => {
      const page = JSON.parse(await snapshot(wc));
      return predicate(page);
    },
    10_000,
    label,
  );
}

function writeDomArtifact(world) {
  const stateRoot = path.join(world.tmpDir, 'state');
  const artifactId = preparedManifest.artifactId;
  const artifactDir = path.join(stateRoot, 'artifacts', artifactId);
  fs.mkdirSync(artifactDir, { recursive: true });
  for (const file of ['manifest.json', 'index.json', 'native.json'])
    fs.copyFileSync(path.join(preparedArtifactDir, file), path.join(artifactDir, file));
  if (preparedManifest.engineSha256 !== world.engineSha256)
    throw new Error('Prepared artifact engine does not match the harness bundle');
  return { stateRoot, artifactId, locale: LOCALE };
}

function writeAstArtifact(world) {
  const stateRoot = path.join(world.tmpDir, 'state');
  const main = Buffer.from('window.__LOCALIZED_BUNDLE_RAN__ = true;\n');
  const artifactId = digest(main).padEnd(64, '0');
  const coverage = `${JSON.stringify({
    schemaVersion: 2,
    profileId: 'production-fixture',
    locale: LOCALE,
    probe: true,
    hits: [],
    replacedMessages: 0,
    totalReplacements: 0,
    messages: [],
    excluded: [],
  })}\n`;
  const manifest = {
    schemaVersion: 1,
    artifactId,
    profileId: 'production-fixture',
    locale: LOCALE,
    formatLocale: 'zh-TW',
    sourceMainSha256: digest(Buffer.from('source')),
    catalogSha256: digest(Buffer.from('fixture-catalog')),
    adapterVersion: '1',
    toolchainSha256: digest(Buffer.from('fixture')),
    assets: [{ route: '/main.js', file: 'main.js', sha256: digest(main) }],
    nativeCatalogSha256: null,
    coverageSha256: digest(Buffer.from(coverage)),
  };
  const artifactDir = path.join(stateRoot, 'artifacts', artifactId);
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'main.js'), main);
  fs.writeFileSync(path.join(artifactDir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(artifactDir, 'coverage.json'), coverage);
  return { stateRoot, artifactId, locale: LOCALE };
}

function writeSelection(stateRoot, installationId, artifact) {
  const installationDir = path.join(stateRoot, 'installations', installationId);
  fs.mkdirSync(installationDir, { recursive: true });
  fs.writeFileSync(
    path.join(installationDir, 'selection.json'),
    JSON.stringify({
      schemaVersion: 1,
      installationId,
      artifactId: artifact.artifactId,
      locale: artifact.locale,
      selectedAt: new Date().toISOString(),
    }),
  );
  return path.join(installationDir, 'selection.json');
}

function loadRuntime(world, runtimes, runtimeConfig) {
  const directory = path.join(world.tmpDir, `runtime-${runtimes.length}`);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'runtime-config.json'), JSON.stringify(runtimeConfig));
  fs.copyFileSync(
    path.join(__dirname, '../../../dist/localization/bundle/host-engine.cjs'),
    path.join(directory, 'host-engine.cjs'),
  );
  fs.writeFileSync(path.join(directory, 'dom-engine.js'), world.engineSource);
  const runtime = require(path.join(directory, 'host-engine.cjs'));
  runtimes.push(runtime);
  return runtime;
}

async function scenarioProductionHook() {
  const { BrowserWindow, Menu } = require('electron');
  const { check, checks } = makeChecks();
  const world = await createWorld('production');
  const windows = [];
  const runtimes = [];
  try {
    const artifact = writeDomArtifact(world);
    const installationId = '1'.repeat(64);
    const config = { schemaVersion: 2, stateRoot: artifact.stateRoot, installationId };
    const selectionPath = writeSelection(artifact.stateRoot, installationId, artifact);
    const statusPath = path.join(
      artifact.stateRoot,
      'installations',
      installationId,
      'runtime-status.json',
    );
    const open = () => {
      const hub = openHubWindow(world, BrowserWindow);
      windows.push(hub.win);
      return hub;
    };
    const runtime = loadRuntime(world, runtimes, config);
    const snapshotStart = runtime.initializeHostRuntime();
    check(
      'production-startup-snapshot',
      snapshotStart &&
        snapshotStart.format === 'dom' &&
        snapshotStart.artifactId === artifact.artifactId &&
        snapshotStart.locale === LOCALE,
      JSON.stringify(snapshotStart),
    );
    check(
      'production-native-locale',
      runtime.nativeCatalogLocale() === LOCALE,
      runtime.nativeCatalogLocale(),
    );
    check(
      'production-native-cancel',
      runtime.nativeText('common.cancel', 'Cancel') === EXPECTED.cancel,
    );
    check(
      'production-native-icu-count',
      runtime.nativeAgentsRunning(2) === EXPECTED.agents,
      runtime.nativeAgentsRunning(2),
    );
    check(
      'production-native-dynamic-value-preserved',
      runtime.nativeFormat(
        'startup.wslMissingMessage',
        'The WSL distro "{0}" is no longer installed.',
        ['Ubuntu {0}'],
      ) === EXPECTED.wsl,
    );
    const actions = [];
    const menu = Menu.buildFromTemplate([
      {
        id: 'new-window',
        label: runtime.nativeText('nav.newWindow', 'New Window'),
        accelerator: 'CmdOrCtrl+N',
        click: (item) => actions.push(item.id),
      },
      {
        id: 'update',
        label: runtime.nativeText('update.checkForUpdates', 'Check for Updates'),
        click: (item) => actions.push(item.id),
      },
    ]);
    const newWindow = menu.getMenuItemById('new-window');
    const update = menu.getMenuItemById('update');
    check(
      'production-native-menu-labels',
      newWindow.label === EXPECTED.newWindow && update.label === EXPECTED.checkUpdates,
    );
    update.label = runtime.nativeText('update.restart', 'Restart to Update');
    newWindow.click(newWindow, undefined, {});
    update.click(update, undefined, {});
    check(
      'production-native-action-identity',
      JSON.stringify(actions) === JSON.stringify(['new-window', 'update']) &&
        update.label === EXPECTED.restart &&
        newWindow.accelerator === 'CmdOrCtrl+N',
      JSON.stringify(actions),
    );
    check('production-test-hub-keeps-https-handler', world.ses.protocol.isProtocolHandled('https'));

    const first = open();
    await runtime.loadLocalizedURL(first.wc, HUB_URL);
    await waitFor(
      () =>
        fs.existsSync(statusPath) &&
        JSON.parse(fs.readFileSync(statusPath, 'utf8')).healthState === 'armed',
      10_000,
      'initial bootstrap armed without writable roots',
    );
    check(
      'production-delayed-root-armed',
      JSON.parse(fs.readFileSync(statusPath, 'utf8')).healthState === 'armed',
    );
    await first.wc.executeJavaScript(`
      const wrapper = document.createElement('div');
      wrapper.innerHTML = '<nav><button id="settings">Open Settings</button></nav>';
      document.body.appendChild(wrapper);
    `);
    await waitForPage(
      first.wc,
      (page) => page.settings === EXPECTED.settings && page.ai === 'Open Settings',
      'translated Hub chrome',
    );
    check('production-https-handler-untouched', world.ses.protocol.isProtocolHandled('https'));
    await waitFor(
      () => JSON.parse(fs.readFileSync(statusPath, 'utf8')).healthState === 'active',
      10_000,
      'writable-root readiness reported to Host',
    );
    const lastKnown = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    check(
      'production-selection-status-last-known',
      lastKnown.lastKnown === true &&
        lastKnown.healthState === 'active' &&
        lastKnown.terminal === null,
      JSON.stringify(lastKnown),
    );
    check(
      'production-selection-runtime-log',
      fs
        .readdirSync(path.join(artifact.stateRoot, 'logs', 'runtime', installationId))
        .some((name) => /\.jsonl$/.test(name)),
    );

    const routed = open();
    for (const route of [
      '/?project=reserved-project',
      '/?project=reserved-project&settingsOpen=true&settingsScreen=General&settingsProjectId=project-2',
      '/customizations?project=reserved-project',
      '/sidecars?project=reserved-project',
      '/c/conversation-1?project=reserved-project&tab=overview',
    ]) {
      const expectedHeading =
        new URL(HUB_ORIGIN + route).pathname === '/customizations'
          ? EXPECTED.customizations
          : 'Customizations';
      await runtime.loadLocalizedURL(routed.wc, HUB_ORIGIN + route);
      await waitForPage(
        routed.wc,
        (page) =>
          page.factory &&
          page.engine &&
          page.settings === EXPECTED.settings &&
          page.heading === expectedHeading,
        'preload and route-scoped heading on reviewed app document',
      );
      for (let reload = 0; reload < 2; reload++) {
        await routed.wc.executeJavaScript('window.__RELOAD_MARKER__ = true');
        let navigationHealth;
        routed.wc.once('did-start-navigation', () => {
          navigationHealth = JSON.parse(fs.readFileSync(statusPath, 'utf8')).healthState;
        });
        const finished = new Promise((resolve) => routed.wc.once('did-finish-load', resolve));
        routed.wc.reload();
        await finished;
        await waitForPage(
          routed.wc,
          (page) =>
            page.factory &&
            page.engine &&
            !page.marked &&
            page.settings === EXPECTED.settings &&
            page.heading === expectedHeading,
          'fresh engine and route-scoped heading after app document reload',
        );
        const page = JSON.parse(await snapshot(routed.wc));
        check(
          'production-reviewed-route-reload-' + route + '-' + reload,
          routed.wc.getURL() === HUB_ORIGIN + route &&
            page.ai === 'Open Settings' &&
            navigationHealth === 'ready',
          JSON.stringify({ page, navigationHealth }),
        );
      }
    }
    let portChangeRefused = false;
    try {
      await runtime.prepareNavigation(
        routed.wc,
        'https://127.0.0.1:4443/?project=reserved-project',
      );
    } catch (error) {
      portChangeRefused = error.code === 'SOURCE_MISMATCH';
    }
    check('production-registered-port-cannot-change', portChangeRefused);
    for (const url of [
      HUB_ORIGIN + '/api',
      HUB_ORIGIN + '/?unreviewed=1',
      'https://127.0.0.1:4443/?project=reserved-project',
      'https://127.0.0.2/?project=reserved-project',
    ]) {
      await routed.wc.loadURL(url);
      const page = JSON.parse(await snapshot(routed.wc));
      const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      check(
        'production-unreviewed-document-no-bootstrap-' + url,
        !page.factory &&
          !page.engine &&
          status.healthState === 'degraded' &&
          status.terminal?.code === 'SOURCE_MISMATCH',
        JSON.stringify({ page, status }),
      );
    }
    await routed.wc.loadURL(HUB_URL);
    await waitForPage(
      routed.wc,
      (page) => page.engine && page.settings === EXPECTED.settings,
      'return to original registered origin',
    );

    // Live zero-restart switching: alternate DOM locale -> en restore -> original LOCALE.
    const altLocale = LOCALE === 'ja-JP' ? 'zh-Hant-TW' : 'ja-JP';
    const altExpectedSettings = altLocale === 'ja-JP' ? '設定を開く' : '開啟設定';
    const altNativeQuit = altLocale === 'ja-JP' ? '終了' : '結束';
    const altIndex = `${JSON.stringify({
      schemaVersion: 1,
      locale: altLocale,
      exact: {
        'Open Settings': { messageId: 'nav.openSettings', translation: altExpectedSettings },
      },
      templates: [],
    })}\n`;
    const altNative = `${JSON.stringify({
      schemaVersion: 1,
      locale: altLocale,
      messages: { 'session.quit': altNativeQuit },
    })}\n`;
    const altIndexSha = digest(Buffer.from(altIndex));
    const altNativeSha = digest(Buffer.from(altNative));
    const altArtifactId = digest(Buffer.from(`alt-${altLocale}-${altIndexSha}`));
    const altDir = path.join(artifact.stateRoot, 'artifacts', altArtifactId);
    fs.mkdirSync(altDir, { recursive: true });
    fs.writeFileSync(path.join(altDir, 'index.json'), altIndex);
    fs.writeFileSync(path.join(altDir, 'native.json'), altNative);
    fs.writeFileSync(
      path.join(altDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: 2,
        format: 'dom',
        artifactId: altArtifactId,
        profileId: preparedManifest.profileId,
        locale: altLocale,
        formatLocale: altLocale,
        engineVersion: preparedManifest.engineVersion,
        engineSha256: world.engineSha256,
        scopesVersion: preparedManifest.scopesVersion,
        indexSha256: altIndexSha,
        catalogSha256: preparedManifest.catalogSha256,
        adapterVersion: preparedManifest.adapterVersion,
        toolchainSha256: preparedManifest.toolchainSha256,
        nativeCatalogSha256: altNativeSha,
      }),
    );
    await routed.wc.executeJavaScript('window.__LIVE_SWITCH_MARKER__ = true');
    writeSelection(artifact.stateRoot, installationId, {
      artifactId: altArtifactId,
      locale: altLocale,
    });
    const switchedToAlt = runtime.refreshHostLocalization();
    await waitForPage(
      routed.wc,
      (page) => page.settings === altExpectedSettings && page.ai === 'Open Settings',
      'live switch to alternate DOM locale without reload',
    );
    const liveSwitchedMarker = await routed.wc.executeJavaScript(
      'window.__LIVE_SWITCH_MARKER__ === true',
    );
    check(
      'production-live-switch-to-alternate-locale',
      switchedToAlt.changed === true &&
        switchedToAlt.locale === altLocale &&
        runtime.nativeCatalogLocale() === altLocale &&
        runtime.nativeText('session.quit', 'Quit') === altNativeQuit &&
        liveSwitchedMarker === true,
      JSON.stringify({
        switchedToAlt,
        nativeLocale: runtime.nativeCatalogLocale(),
        liveSwitchedMarker,
      }),
    );
    const enAst = writeAstArtifact(world);
    const enManifestPath = path.join(
      enAst.stateRoot,
      'artifacts',
      enAst.artifactId,
      'manifest.json',
    );
    const enManifest = JSON.parse(fs.readFileSync(enManifestPath, 'utf8'));
    enManifest.locale = 'en';
    enManifest.formatLocale = 'en';
    fs.writeFileSync(enManifestPath, JSON.stringify(enManifest));
    writeSelection(artifact.stateRoot, installationId, {
      artifactId: enAst.artifactId,
      locale: 'en',
    });
    const switchedToEn = runtime.refreshHostLocalization();
    await waitForPage(
      routed.wc,
      (page) => page.settings === 'Open Settings' && !page.engine,
      'live restore to original English without reload',
    );
    const markerAfterEn = await routed.wc.executeJavaScript(
      'window.__LIVE_SWITCH_MARKER__ === true',
    );
    check(
      'production-live-switch-to-english-restores',
      switchedToEn.changed === true &&
        switchedToEn.locale === 'en' &&
        runtime.nativeCatalogLocale() === null &&
        markerAfterEn === true,
      JSON.stringify({ switchedToEn, nativeLocale: runtime.nativeCatalogLocale(), markerAfterEn }),
    );
    writeSelection(artifact.stateRoot, installationId, artifact);
    const switchedBack = runtime.refreshHostLocalization();
    await waitForPage(
      routed.wc,
      (page) => page.settings === EXPECTED.settings && page.engine,
      'live switch back to initial locale',
    );
    check(
      'production-live-switch-restores-initial-locale',
      switchedBack.changed === true &&
        switchedBack.locale === LOCALE &&
        runtime.nativeCatalogLocale() === LOCALE,
      JSON.stringify(switchedBack),
    );

    fs.rmSync(selectionPath);
    const second = open();
    await runtime.loadLocalizedURL(second.wc, HUB_URL);
    await waitForPage(
      second.wc,
      (page) => page.settings === EXPECTED.settings,
      'process-fixed snapshot',
    );
    check(
      'production-selection-fixed-for-process',
      runtime.initializeHostRuntime() === snapshotStart,
    );
    runtime.closeRuntimePersistence();

    const missing = loadRuntime(world, runtimes, config);
    check('production-next-startup-missing-refused', missing.initializeHostRuntime() === null);
    const missingWin = open();
    await missing.loadLocalizedURL(missingWin.wc, HUB_URL);
    const failedStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    check(
      'production-startup-failure-persisted',
      failedStatus.healthState === 'degraded' && failedStatus.terminal.code === 'SELECTION_MISSING',
      JSON.stringify(failedStatus),
    );
    await waitForPage(
      missingWin.wc,
      (page) => page.settings === 'Open Settings' && page.ai === 'Open Settings',
      'original Hub after missing selection',
    );
    missing.closeRuntimePersistence();

    const leftover = writeAstArtifact(world);
    writeSelection(leftover.stateRoot, installationId, leftover);
    const leftoverRuntime = loadRuntime(world, runtimes, {
      schemaVersion: 2,
      stateRoot: leftover.stateRoot,
      installationId,
    });
    const leftoverSnap = leftoverRuntime.initializeHostRuntime();
    check(
      'production-leftover-ast-snapshot',
      leftoverSnap && leftoverSnap.format === 'ast',
      JSON.stringify(leftoverSnap),
    );
    const leftoverWin = open();
    await leftoverRuntime.loadLocalizedURL(leftoverWin.wc, HUB_URL);
    await waitForPage(
      leftoverWin.wc,
      (page) => page.settings === 'Open Settings',
      'leftover AST leaves original Hub',
    );
    check('production-leftover-ast-no-takeover', world.ses.protocol.isProtocolHandled('https'));
    leftoverRuntime.closeRuntimePersistence();

    const englishAst = writeAstArtifact(world);
    const englishId = englishAst.artifactId;
    const englishManifestPath = path.join(
      englishAst.stateRoot,
      'artifacts',
      englishId,
      'manifest.json',
    );
    const englishManifest = JSON.parse(fs.readFileSync(englishManifestPath, 'utf8'));
    englishManifest.locale = 'en';
    englishManifest.formatLocale = 'en';
    fs.writeFileSync(englishManifestPath, JSON.stringify(englishManifest));
    writeSelection(englishAst.stateRoot, installationId, {
      artifactId: englishId,
      locale: 'en',
    });
    const englishRuntime = loadRuntime(world, runtimes, {
      schemaVersion: 2,
      stateRoot: englishAst.stateRoot,
      installationId,
    });
    await englishRuntime.prepareNavigation(first.wc, HUB_URL);
    check('production-english-no-native-catalog', englishRuntime.nativeCatalogLocale() === null);
    englishRuntime.closeRuntimePersistence();

    writeSelection(artifact.stateRoot, installationId, artifact);
    let refused = false;
    const drift = loadRuntime(world, runtimes, config);
    try {
      await drift.prepareNavigation(first.wc, 'https://localhost/');
    } catch (error) {
      refused = error.code === 'SOURCE_MISMATCH';
    }
    check('production-unreviewed-url-refused', refused);
    drift.closeRuntimePersistence();

    return {
      ok: checks.every((entry) => entry.pass),
      name: 'production-hook',
      locale: LOCALE,
      checks,
    };
  } finally {
    for (const runtime of runtimes) runtime.closeRuntimePersistence();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    await world.cleanup();
  }
}

const scenarios = {
  'production-hook': scenarioProductionHook,
};

module.exports = { scenarios, LOCALE };
