const { app, BrowserWindow, net, protocol } = require('electron');
const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const repo = path.resolve(__dirname, '../../..');
const windows = [];
const servers = [];
const checks = {};
const observations = {};
let discoveryRequests = 0;
let unavailableRequests = 0;
let pluginRegistered = false;
app.setPath('userData', path.join(process.argv[2], 'profile'));
app.commandLine.appendSwitch('lang', 'ja-JP');
// Keep requested viewport sizes deterministic under fractional desktop scaling.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'plugin',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      allowServiceWorkers: true,
      codeCache: true,
    },
  },
]);

function emit(kind, value) {
  process.stdout.write(`#${kind} ${JSON.stringify(value)}\n`);
}

function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function unavailable(req, res) {
  if (req.url.includes('SubscribeToSidecars')) discoveryRequests++;
  unavailableRequests++;
  res.writeHead(503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Electron fixture: Language Server unavailable' }));
}

function createWindow(preload) {
  const win = new BrowserWindow({
    show: false,
    width: 1200,
    height: 820,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
      preload,
    },
  });
  windows.push(win);
  return win;
}

async function waitFor(frame, expression, label) {
  return frame.executeJavaScript(`new Promise((resolve, reject) => {
    const deadline = performance.now() + 5000;
    const inspect = () => {
      const value = (${expression});
      if (value) return resolve(value);
      if (performance.now() > deadline) return reject(new Error(${JSON.stringify(label)} + ': ' + JSON.stringify({
        origin:location.origin, referrer:document.referrer,
        visible:document.body && getComputedStyle(document.body).visibility,
        body:document.body?.innerText.slice(0,500), peerOrigins:window.__localePeerOrigins
      })));
      requestAnimationFrame(inspect);
    };
    inspect();
  })`);
}

const panelSnapshot = `({
  lang: document.documentElement.lang,
  selected: document.querySelector('#setting-lang')?.value,
  language: document.querySelector('#setting-lang')?.getAttribute('aria-label'),
  refresh: document.querySelector('#btn-refresh')?.title,
  visible: !!document.body && getComputedStyle(document.body).visibility === 'visible'
})`;

function observedPanel(html, saved) {
  const probe = `<script>
    localStorage.setItem('agyctl_lang', ${JSON.stringify(saved)});
    window.__localePeerOrigins=[];
    window.addEventListener('message', event => window.__localePeerOrigins.push(event.origin));
    window.__firstVisiblePanel = null;
    const inspectFirstVisible = () => {
      if (document.body && getComputedStyle(document.body).visibility === 'visible') {
        window.__firstVisiblePanel = ${panelSnapshot};
      } else requestAnimationFrame(inspectFirstVisible);
    };
    requestAnimationFrame(inspectFirstVisible);
  </script>`;
  return html.replace('<head>', `<head>${probe}`);
}

const expected = {
  en: {
    button: 'EN',
    title: 'Session Context Dashboard',
    aria: 'agyctl Dashboard',
    composition: 'Context Usage',
    language: 'Language',
    refresh: 'Refresh now',
    tip: 'Session cache rate:',
  },
  'zh-Hant-TW': {
    button: '繁',
    title: '會話上下文詳細儀表板',
    aria: 'agyctl 儀表板',
    composition: '背景資訊',
    language: '語言',
    refresh: '立即更新',
    tip: '會話快取率:',
  },
  'zh-Hans-CN': {
    button: '简',
    title: '会话上下文详细仪表盘',
    aria: 'agyctl 仪表盘',
    composition: '上下文信息',
    language: '语言',
    refresh: '立即更新',
    tip: '会话缓存率:',
  },
  'ja-JP': {
    button: '日',
    title: 'セッションコンテキストダッシュボード',
    aria: 'agyctl ダッシュボード',
    composition: 'コンテキスト使用量',
    language: '言語',
    refresh: '今すぐ更新',
    tip: 'セッションのキャッシュ率：',
  },
};

async function assertPanel(frame, locale, firstPaint = false) {
  await waitFor(
    frame,
    `window.__firstVisiblePanel && ${panelSnapshot}.visible && document.documentElement.lang === ${JSON.stringify(locale)}`,
    `panel never displayed ${locale}`,
  );
  const snapshot = await frame.executeJavaScript(
    firstPaint ? 'window.__firstVisiblePanel' : panelSnapshot,
  );
  assert.deepEqual(snapshot, {
    lang: locale,
    selected: locale,
    language: expected[locale].language,
    refresh: expected[locale].refresh,
    visible: true,
  });
}

async function assertCapsule(frame, locale) {
  const wanted = expected[locale];
  await waitFor(
    frame,
    `document.querySelector('#cr-pop-lang')?.textContent === ${JSON.stringify(wanted.button)}`,
    `capsule never displayed ${locale}`,
  );
  const snapshot = await frame.executeJavaScript(`({
    button: document.querySelector('#cr-pop-lang').textContent,
    title: document.querySelector('#agyctl-titlebar-btn').title,
    aria: document.querySelector('#agyctl-titlebar-btn').getAttribute('aria-label'),
    composition: document.querySelector('[data-cr-i18n="compTitle"]').textContent,
    tooltip: document.querySelector('#agyctl-input-tooltip')?.textContent,
    tooltipVisible: document.querySelector('#agyctl-input-tooltip')?.classList.contains('visible')
  })`);
  assert.deepEqual(
    {
      button: snapshot.button,
      title: snapshot.title,
      aria: snapshot.aria,
      composition: snapshot.composition,
    },
    {
      button: wanted.button,
      title: wanted.title,
      aria: wanted.aria,
      composition: wanted.composition,
    },
  );
  assert.equal(snapshot.tooltipVisible, true);
  assert.ok(snapshot.tooltip.includes(wanted.tip), snapshot.tooltip);
}

function hostPage(panelOrigin) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
    <script>
      window.__localePeerOrigins=[];
      window.addEventListener('message', event => window.__localePeerOrigins.push(event.origin));
    </script>
    <style>
      body{margin:0;background:#18181c;color:#ddd;font:14px system-ui}
      header{height:48px;display:flex;justify-content:flex-end;padding:0 18px;align-items:center}
      .flex{display:flex}.items-center{align-items:center}.gap-1{gap:4px}.gap-0\\.5{gap:2px}
      iframe{position:absolute;left:0;top:50px;width:360px;height:650px;border:0}
      footer{position:absolute;left:390px;bottom:24px;right:24px;padding:16px;display:flex;justify-content:flex-end}
      aside{position:absolute;right:24px;bottom:90px}#subfooter{position:static}
    </style></head><body>
    <header><div data-testid="pane-titlebar-toolbar"><div class="flex items-center gap-1"><button data-testid="titlebar-more-actions">More</button></div></div></header>
    <iframe data-testid="sidecar-iframe" title="agyctl" src="${panelOrigin}/"></iframe>
    <div data-testid="agent-input-box"><footer class="agy-composer-footer"><div class="shrink-0 flex items-center gap-0.5"><button data-testid="permissions-selector-trigger">Permissions</button></div></footer></div>
    <div data-testid="subagent-tab-conversation" data-cascade-id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"></div>
    <aside data-side-panel-composer><div id="subfooter" class="agy-composer-footer"><div class="shrink-0 flex items-center gap-0.5"><button>Microphone</button></div></div></aside>
    </body></html>`;
}

async function run() {
  const { assembleCapsule } = await import(
    pathToFileURL(path.join(repo, 'scripts/capsule-build.mjs')).href
  );
  const { renderPanelPage } = await import(
    pathToFileURL(path.join(repo, 'src/plugin/sidecars/panel/page.mjs')).href
  );
  const { buildCapsulePreloadHook } = await import(
    pathToFileURL(path.join(repo, 'dist/host/bundle/capsule-feature.mjs')).href
  );
  const bundle = assembleCapsule();
  const preload = path.join(process.argv[2], 'preload.cjs');
  writeFileSync(
    preload,
    `if (location.pathname.startsWith('/c/')) {\n${buildCapsulePreloadHook(bundle)}\n}\n`,
  );
  const html = renderPanelPage();
  const servePanel = (seed) => (req, res) => {
    if (req.url.startsWith('/api/')) return unavailable(req, res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(observedPanel(html, req.url.includes('standalone') ? 'ja-JP' : seed));
  };
  const panelOrigin = await listen(servePanel('ja'));
  const pluginHost = `agyctl--panel-${new URL(panelOrigin).port}`;
  const pluginOrigin = `plugin://${pluginHost}`;
  protocol.handle('plugin', (request) => {
    const url = new URL(request.url);
    assert.equal(url.host, pluginHost, 'only the owned panel may use the fixture protocol');
    assert.equal(request.method, 'GET');
    return net.fetch(new URL(url.pathname + url.search, panelOrigin).href, {
      method: request.method,
      headers: request.headers,
    });
  });
  pluginRegistered = true;
  const lateOrigin = await listen(servePanel('en'));
  const hostOrigin = await listen((req, res) => {
    if (req.url.includes('Service/') || req.url.startsWith('/api/')) return unavailable(req, res);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      req.url === '/seed'
        ? '<!doctype html><title>Seed fixture preferences</title>'
        : hostPage(pluginOrigin),
    );
  });
  const win = createWindow(preload);
  await win.loadURL(`${hostOrigin}/seed`);
  await win.webContents.executeJavaScript(`localStorage.removeItem('agyctl_lang'); true`);
  await win.loadURL(`${hostOrigin}/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
  const unsavedHost = win.webContents.mainFrame;
  const unsavedPanel = unsavedHost.frames.find((frame) => frame.url.startsWith(pluginOrigin));
  assert.notEqual(unsavedPanel, undefined, 'unsaved startup panel frame must exist');
  observations.unsavedStartup = await unsavedHost.executeJavaScript(`({
    declared:document.documentElement.lang, system:navigator.language,
    saved:localStorage.getItem('agyctl_lang'), locale:window.__AGYCTL_LOCALE__?.locale
  })`);
  observations.unsavedStartup.firstVisiblePanel = await waitFor(
    unsavedPanel,
    'window.__firstVisiblePanel',
    'unsaved startup panel never became visible',
  );
  assert.equal(observations.unsavedStartup.saved, null);
  assert.equal(observations.unsavedStartup.declared, 'en');
  assert.match(observations.unsavedStartup.system, /^ja(?:-|$)/);
  assert.equal(
    observations.unsavedStartup.locale,
    'en',
    'an unsaved startup must resolve the parsed Host language before system language',
  );
  await assertPanel(unsavedPanel, 'en', true);
  await win.loadURL(`${hostOrigin}/seed`);
  await win.webContents.executeJavaScript(`localStorage.setItem('agyctl_lang','zh-TW'); true`);
  await win.loadURL(`${hostOrigin}/c/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`);
  const host = win.webContents.mainFrame;
  const panel = host.frames.find((frame) => frame.url.startsWith(pluginOrigin));
  assert.notEqual(panel, undefined, 'embedded panel frame must exist');
  observations.pluginBoundary = await panel.executeJavaScript(`({
    origin:location.origin, urlOrigin:new URL(location.href).origin, referrer:document.referrer
  })`);
  assert.equal(observations.pluginBoundary.origin, pluginOrigin);
  assert.equal(new URL(observations.pluginBoundary.referrer).origin, hostOrigin);
  await assertPanel(panel, 'zh-Hant-TW', true);
  assert.ok((await panel.executeJavaScript('window.__localePeerOrigins')).includes(hostOrigin));
  assert.ok((await host.executeJavaScript('window.__localePeerOrigins')).includes(pluginOrigin));
  await waitFor(
    host,
    `Boolean(document.querySelector('#agyctl-input-capsule') && document.querySelector('#agyctl-subagent-capsule') && document.querySelector('#agyctl-titlebar-btn'))`,
    'capsule surfaces not mounted',
  );
  assert.equal(await panel.executeJavaScript(`localStorage.getItem('agyctl_lang')`), 'ja');
  assert.equal(await host.executeJavaScript(`window.__APP_CONFIG__?.csrfToken ?? null`), null);
  await host.executeJavaScript(
    `document.querySelector('#agyctl-input-capsule').dispatchEvent(new MouseEvent('mouseenter')); true`,
  );
  await assertCapsule(host, 'zh-Hant-TW');
  checks.initialHostAuthority = true;

  await host.executeJavaScript(`document.querySelector('#agyctl-input-capsule').click(); true`);
  assert.equal(
    await host.executeJavaScript(
      `document.querySelector('#agyctl-titlebar-popover').classList.contains('visible')`,
    ),
    false,
  );
  await host.executeJavaScript(`document.querySelector('#agyctl-titlebar-btn').click(); true`);
  assert.equal(
    await host.executeJavaScript(
      `document.querySelector('#agyctl-titlebar-popover').classList.contains('visible')`,
    ),
    true,
  );
  for (const locale of ['zh-Hans-CN', 'ja-JP', 'zh-Hant-TW']) {
    await panel.executeJavaScript(
      `document.querySelector('#setting-lang').value=${JSON.stringify(locale)}; document.querySelector('#setting-lang').dispatchEvent(new Event('change',{bubbles:true})); true`,
    );
    await assertPanel(panel, locale);
    await assertCapsule(host, locale);
    assert.equal(await host.executeJavaScript(`localStorage.getItem('agyctl_lang')`), locale);
    assert.equal(await panel.executeJavaScript(`localStorage.getItem('agyctl_lang')`), 'ja');
  }
  assert.equal(discoveryRequests, 0);
  assert.ok(unavailableRequests > 0, 'panel must have encountered unavailable local RPC');
  checks.offlineLanguageSwitches = true;

  await host.executeJavaScript(`new Promise(resolve => {
    const frame=document.createElement('iframe');
    frame.dataset.testid='sidecar-iframe'; frame.title='agyctl'; frame.style.left='365px';
    frame.addEventListener('load', () => resolve(true), {once:true});
    frame.src=${JSON.stringify(`${lateOrigin}/`)}; document.body.append(frame);
  })`);
  const late = host.frames.find((frame) => frame.url.startsWith(lateOrigin));
  assert.notEqual(late, undefined, 'late panel frame must exist');
  await assertPanel(late, 'zh-Hant-TW', true);
  assert.equal(await late.executeJavaScript(`localStorage.getItem('agyctl_lang')`), 'en');
  checks.latePanelInheritance = true;

  await host.executeJavaScript(`window.__testLocaleState=window.__AGYCTL_LOCALE__; true`);
  await host.executeJavaScript(bundle);
  await waitFor(
    host,
    `document.querySelector('#cr-pop-lang')?.textContent === '繁'`,
    'reinjection lost locale',
  );
  assert.deepEqual(
    await host.executeJavaScript(`({
    main:document.querySelectorAll('#agyctl-input-capsule').length,
    sub:document.querySelectorAll('#agyctl-subagent-capsule').length,
    title:document.querySelectorAll('#agyctl-titlebar-btn').length,
    popover:document.querySelectorAll('#agyctl-titlebar-popover').length,
    sameState:window.__testLocaleState===window.__AGYCTL_LOCALE__
  })`),
    { main: 1, sub: 1, title: 1, popover: 1, sameState: true },
  );
  await host.executeJavaScript(
    `document.querySelector('#cr-pop-lang').click(); document.querySelector('#agyctl-input-capsule').dispatchEvent(new MouseEvent('mouseenter')); true`,
  );
  await assertCapsule(host, 'zh-Hans-CN');
  await assertPanel(panel, 'zh-Hans-CN');
  await assertPanel(late, 'zh-Hans-CN');
  assert.equal(await host.executeJavaScript(`localStorage.getItem('agyctl_lang')`), 'zh-Hans-CN');
  assert.equal(await panel.executeJavaScript(`localStorage.getItem('agyctl_lang')`), 'ja');
  assert.equal(await late.executeJavaScript(`localStorage.getItem('agyctl_lang')`), 'en');
  checks.reinjectionAndSingleCycle = true;

  for (const [width, height, scale] of [
    [1200, 820, 1],
    [1000, 760, 1.25],
  ]) {
    win.setContentSize(width, height);
    win.webContents.setZoomFactor(scale);
    await host.executeJavaScript(
      `if(!document.querySelector('#agyctl-titlebar-popover').classList.contains('visible')) document.querySelector('#agyctl-titlebar-btn').click(); window.dispatchEvent(new Event('resize')); true`,
    );
    const geometry = await waitFor(
      host,
      `(() => {
      const el=document.querySelector('#agyctl-titlebar-popover');
      const r=el.getBoundingClientRect();
      return Math.abs(innerWidth-${width / scale})<=1 && Math.abs(innerHeight-${height / scale})<=1 && el.classList.contains('visible') && r.width>0 && r.height>0 && r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight && {width:innerWidth,height:innerHeight};
    })()`,
      `popover exceeded ${width}x${height} at scale ${scale}`,
    );
    assert.ok(geometry.width <= width && geometry.height <= height);
  }
  assert.equal(discoveryRequests, 0);
  checks.viewportAndClickBehavior = true;

  const standalone = createWindow();
  await standalone.loadURL(`${lateOrigin}/standalone`);
  await assertPanel(standalone.webContents.mainFrame, 'ja-JP', true);
  checks.standaloneBeforePaint = true;
  return { ok: true, electron: process.versions.electron, checks, observations };
}

const watchdog = setTimeout(() => {
  emit('FATAL', { message: 'capsule Electron acceptance deadline exceeded' });
  app.exit(3);
}, 35_000);
watchdog.unref();

app.whenReady().then(async () => {
  let exitCode = 0;
  try {
    emit('RESULT', await run());
  } catch (error) {
    exitCode = 2;
    emit('FATAL', { message: String(error.stack ?? error), checks, observations });
  } finally {
    clearTimeout(watchdog);
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    if (pluginRegistered) protocol.unhandle('plugin');
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections();
          }),
      ),
    );
    app.exit(exitCode);
  }
});
