// P0-A delivery harness scenarios (plan §12.3). Each scenario drives the
// real coordinator bundle inside a real Electron 44.10.2 main process against
// the self-made HTTPS service, and returns a list of checks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeTestServer } = require('./server.cjs');

const { SessionDeliveryCoordinator } = require('../../../dist/localization/bundle/host-engine.cjs');

const ARTIFACT_ID =
  'probe-zh-hant-tw-0000000000000000000000000000000000000000000000000000000000000000';
const LOCALE = 'zh-Hant-TW';
const CONFIRMING_VARIANT = `/* agyctl localization variant */
window.__LOCALIZED_BUNDLE_RAN__ = true;
window.__LOCALIZED_ARTIFACT_ID__ = ${JSON.stringify(ARTIFACT_ID)};
window.__CONFIRM_DEBUG__ = (function () {
  try {
    window.agyctlLocalization.confirm({ artifactId: ${JSON.stringify(ARTIFACT_ID)}, locale: ${JSON.stringify(LOCALE)} });
    return 'invoked';
  } catch (error) {
    return 'error: ' + error.message + ' bridge=' + typeof window.agyctlLocalization;
  }
})();
`;
const SILENT_VARIANT = `/* agyctl localization variant (no confirmation) */
window.__LOCALIZED_BUNDLE_RAN__ = true;
`;

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

async function createWorld(name, { confirmationTimeoutMs, variant, onFailure } = {}) {
  const { session } = require('electron');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `agyctl-l10n-${name}-`));
  const server = await makeTestServer(tmpDir);
  const origin = `https://127.0.0.1:${server.port}`;
  const ses = session.fromPartition(`agyctl-harness-${name}-${process.pid}-${Date.now()}`, {
    cache: false,
  });
  ses.setCertificateVerifyProc((request, callback) => {
    callback(request.certificate.fingerprint === server.fingerprint ? 0 : -3);
  });
  const bridgePath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'dist',
    'localization',
    'bundle',
    'preload-bridge.cjs',
  );
  const preloadPath = path.join(tmpDir, 'preload.js');
  const bridge = fs.readFileSync(bridgePath, 'utf8');
  fs.writeFileSync(preloadPath, `window.__HARNESS_PRELOAD_RAN__ = true;\n${bridge}`);
  let servedCount = 0;
  let currentVariant = Buffer.from(variant ?? CONFIRMING_VARIANT, 'utf8');
  const coordinator = new SessionDeliveryCoordinator({
    session: ses,
    binding: {
      origin,
      artifactId: ARTIFACT_ID,
      locale: LOCALE,
      routes: ['/main.js'],
      resolve: async () => {
        servedCount += 1;
        return { body: currentVariant, contentType: 'text/javascript; charset=utf-8' };
      },
    },
    confirmationTimeoutMs: confirmationTimeoutMs ?? 15_000,
    log: () => {},
    onFailure,
  });
  return {
    server,
    origin,
    ses,
    coordinator,
    tmpDir,
    preloadPath,
    servedCount: () => servedCount,
    setVariant: (next) => {
      currentVariant = Buffer.from(next, 'utf8');
    },
    cleanup: async () => {
      coordinator.dispose();
      ses.setCertificateVerifyProc(null);
      await server.close();
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
  if (process.env.AGYCTL_L10N_DEBUG) {
    win.webContents.on('preload-error', (_e, p, error) =>
      console.error('PRELOAD-ERROR:', p, String(error?.stack ?? error)),
    );
    win.webContents.on('console-message', (_event, _level, message) =>
      console.error('page-console:', message),
    );
  }
  return { win, wc: win.webContents };
}

// Arms the navigation exactly like the planned shell hook does: track, arm,
// then loadURL. Returns after the page finished loading.
function loadHub(world, { wc }) {
  world.coordinator.track(wc);
  world.coordinator.beginNavigation(wc);
  return wc.loadURL(`${world.origin}/`);
}

async function waitForActive(world, wc, label) {
  try {
    await waitFor(
      () => world.coordinator.recordsFor(wc.id).some((r) => r.state === 'active'),
      10_000,
      `active record for ${label}`,
    );
  } catch (error) {
    const page = await wc
      .executeJavaScript(
        `JSON.stringify({href: location.href, localized: window.__LOCALIZED_BUNDLE_RAN__ === true, original: window.__ORIGINAL_BUNDLE_RAN__ === true, confirm: window.__CONFIRM_DEBUG__, preload: window.__HARNESS_PRELOAD_RAN__ === true, bridge: typeof window.agyctlLocalization, keys: Object.keys(window).filter(k => k.toLowerCase().includes('agyctl')).join(',')})`,
      )
      .catch(() => 'page-eval-failed');
    throw new Error(
      `${error.message}; served=${world.servedCount()}; page=${page}; status=${JSON.stringify(world.coordinator.status())}`,
    );
  }
}

async function scenarioPreciseDelivery() {
  const { check, checks } = makeChecks();
  const world = await createWorld('precise');
  const { BrowserWindow } = require('electron');
  try {
    const { coordinator, server, origin } = world;
    coordinator.attach();
    check(
      'attach-handled',
      coordinator.status().handled === true,
      'handler should be armed after attach',
    );
    const a = openHubWindow(world, BrowserWindow);
    loadHub(world, a);
    await waitForActive(world, a.wc, 'window A');
    check(
      'variant-executed',
      await a.wc.executeJavaScript('window.__LOCALIZED_BUNDLE_RAN__ === true'),
      'overridden bundle should run',
    );
    check(
      'original-not-executed',
      await a.wc.executeJavaScript('window.__ORIGINAL_BUNDLE_RAN__ !== true'),
      'original /main.js must not run when the variant is served',
    );
    check(
      'preload-bridge-present',
      (await a.wc.executeJavaScript('typeof window.agyctlLocalization')) === 'object',
      'the appended preload bridge must expose the confirmation function',
    );
    check('state-active', coordinator.healthState() === 'active', coordinator.healthState());
    check(
      'auto-unhandled-after-settle',
      coordinator.status().handled === false,
      'handler should be removed once the load contract completed',
    );

    // Window B keeps a pending navigation so the handler stays armed while
    // the forwarding checks below run.
    const b = openHubWindow(world, BrowserWindow);
    coordinator.track(b.wc);
    coordinator.beginNavigation(b.wc);
    b.wc.loadURL(`${origin}/slow`);
    await waitFor(() => coordinator.status().handled === true, 5000, 're-armed handler');
    const otherBody = await a.wc.executeJavaScript(
      `fetch('${origin}/other.js').then(r => r.text())`,
    );
    check(
      'non-route-forwarded',
      otherBody === server.otherJs.toString(),
      'GET /other.js must pass through untouched',
    );
    const echo = await a.wc.executeJavaScript(
      `fetch('${origin}/rpc', { method: 'POST', body: 'ping-payload' }).then(r => r.json())`,
    );
    check(
      'post-forwarded',
      echo.method === 'POST' && echo.body === 'ping-payload',
      JSON.stringify(echo),
    );
    const queryBody = await a.wc.executeJavaScript(
      `fetch('${origin}/main.js?v=1').then(r => r.text())`,
    );
    check(
      'query-not-whitelisted',
      queryBody === server.originalMain.toString(),
      'unknown query must forward',
    );
    const rangeBody = await a.wc.executeJavaScript(
      `fetch('${origin}/main.js', { headers: { Range: 'bytes=0-10' } }).then(r => r.text())`,
    );
    check(
      'range-forwarded',
      rangeBody === server.originalMain.toString(),
      'range requests must forward',
    );
    const redirectBody = await a.wc.executeJavaScript(
      `fetch('${origin}/redirect').then(r => r.text())`,
    );
    check(
      'redirect-native',
      redirectBody === server.originalMain.toString(),
      'redirect must follow through the native stack',
    );
    const csp = await a.wc.executeJavaScript(
      `fetch('${origin}/').then(r => r.headers.get('content-security-policy'))`,
    );
    check(
      'response-headers-preserved',
      typeof csp === 'string' && csp.includes("default-src 'self'"),
      String(csp),
    );
    const forwardedCookies = await a.wc.executeJavaScript(
      `fetch('${origin}/cookie-multi').then(r => r.headers.getSetCookie ? r.headers.getSetCookie().length : -1)`,
    );
    b.win.destroy();
    await waitFor(
      () => coordinator.status().handled === false,
      5000,
      'unhandle after pending settled',
    );
    // Renderer-level consistency: the page must see the same headers with and
    // without the interception.
    const nativeCookies = await a.wc.executeJavaScript(
      `fetch('${origin}/cookie-multi').then(r => r.headers.getSetCookie ? r.headers.getSetCookie().length : -1)`,
    );
    check(
      'multi-set-cookie-matches-native',
      forwardedCookies === nativeCookies,
      `forwarded ${forwardedCookies} vs native ${nativeCookies} cookies`,
    );
    // Header-level verification through the session: the intercepted request
    // (no bypass) forwards via the coordinator, the bypassed one is native.
    const viaHandler = await world.ses
      .fetch(`${origin}/cookie-multi`)
      .then((r) => r.headers.getSetCookie().length);
    const native = await world.ses
      .fetch(`${origin}/cookie-multi`, { bypassCustomProtocolHandlers: true })
      .then((r) => r.headers.getSetCookie().length);
    check(
      'session-cookie-passthrough',
      viaHandler === native && native >= 1,
      `handler ${viaHandler} vs native ${native}`,
    );
    const forwardedMain = server.requestLog.filter((l) => l.path === '/main.js').length;
    check(
      'forwarded-main-count',
      forwardedMain === 3,
      `expected 3 forwarded /main.js hits (query, range, redirect), got ${forwardedMain}`,
    );
    b.win.destroy();
    await waitFor(
      () => coordinator.status().handled === false,
      5000,
      'unhandle after pending settled',
    );
    const directMain = await a.wc.executeJavaScript(
      `fetch('${origin}/main.js').then(r => r.text())`,
    );
    check(
      'after-unhandle-native',
      directMain === server.originalMain.toString(),
      'after unhandle the original asset must be served',
    );
    return { ok: checks.every((c) => c.pass), name: 'precise-delivery', checks };
  } finally {
    await world.cleanup();
  }
}

async function scenarioReloadAndParallel() {
  const { check, checks } = makeChecks();
  const world = await createWorld('parallel');
  const { BrowserWindow } = require('electron');
  try {
    const { coordinator, origin } = world;
    coordinator.attach();
    const a = openHubWindow(world, BrowserWindow);
    loadHub(world, a);
    await waitForActive(world, a.wc, 'window A');
    const b = openHubWindow(world, BrowserWindow);
    loadHub(world, b);
    await waitForActive(world, b.wc, 'window B');
    check('two-windows-served', world.servedCount() === 2, `served ${world.servedCount()}`);
    a.wc.reload();
    await waitFor(() => world.servedCount() >= 3, 10_000, 'reload served variant again');
    await waitForActive(world, a.wc, 'window A after reload');
    check(
      'reload-variant-executed',
      await a.wc.executeJavaScript('window.__LOCALIZED_BUNDLE_RAN__ === true'),
    );
    const c = openHubWindow(world, BrowserWindow);
    coordinator.track(c.wc);
    coordinator.beginNavigation(c.wc);
    c.wc.loadURL(`${origin}/slow`);
    await waitFor(() => coordinator.status().handled === true, 5000, 'armed for window C');
    c.win.destroy();
    await waitFor(
      () => coordinator.status().handled === false,
      5000,
      'unhandle after window C closed',
    );
    const cancelled = coordinator.status().records.find((r) => r.state === 'cancelled');
    check(
      'closed-window-cancelled',
      Boolean(cancelled),
      JSON.stringify(coordinator.status().records),
    );
    check(
      'same-artifact-all-windows',
      coordinator.status().records.every((r) => r.generation === 0),
    );
    check(
      'final-health-reflects-live-windows',
      coordinator.healthState() === 'active' && coordinator.status().handled === false,
      `${coordinator.healthState()} handled=${coordinator.status().handled}`,
    );
    return { ok: checks.every((c) => c.pass), name: 'reload-and-parallel', checks };
  } finally {
    await world.cleanup();
  }
}

async function scenarioForwardingIntegrity() {
  const { check, checks } = makeChecks();
  const world = await createWorld('stream');
  const { BrowserWindow } = require('electron');
  try {
    const { coordinator, origin, server } = world;
    coordinator.attach();
    const a = openHubWindow(world, BrowserWindow);
    loadHub(world, a);
    await waitForActive(world, a.wc, 'window A');
    const b = openHubWindow(world, BrowserWindow);
    coordinator.track(b.wc);
    coordinator.beginNavigation(b.wc);
    b.wc.loadURL(`${origin}/slow`);
    await waitFor(() => coordinator.status().handled === true, 5000, 'armed during stream');
    const streamPromise = a.wc.executeJavaScript(`(async () => {
      const response = await fetch('${origin}/stream');
      const reader = response.body.getReader();
      let text = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text;
    })()`);
    await waitFor(() => server.streamState.started > 0, 5000, 'forwarded stream starts');
    b.win.destroy();
    await waitFor(
      () => coordinator.status().handled === false,
      8000,
      'unhandle while stream in flight',
    );
    const streamText = await streamPromise;
    const chunks = streamText.split(';').filter((s) => s.startsWith('chunk-'));
    check(
      'stream-survives-unhandle',
      streamText.endsWith('stream-end'),
      `stream ended with ${JSON.stringify(streamText.slice(-20))}`,
    );
    check(
      'stream-chunks-complete',
      chunks.length === server.streamChunks,
      `got ${chunks.length} chunks`,
    );
    check(
      'stream-order-intact',
      chunks.join(';') ===
        Array.from({ length: server.streamChunks }, (_, i) => `chunk-${i}`).join(';'),
      'chunk order must be unchanged',
    );
    // Aborting a forwarded stream must reach the origin without corruption.
    const d = openHubWindow(world, BrowserWindow);
    coordinator.track(d.wc);
    coordinator.beginNavigation(d.wc);
    d.wc.loadURL(`${origin}/slow`);
    await waitFor(() => coordinator.status().handled === true, 5000, 'armed for abort case');
    const cancelledBefore = server.streamState.cancelled;
    const startedBefore = server.streamState.started;
    const abortPromise = a.wc.executeJavaScript(`(async () => {
      const controller = new AbortController();
      window.__abortStream = () => controller.abort();
      const pending = fetch('${origin}/stream', { signal: controller.signal });
      try { await pending; return 'completed'; } catch (error) { return error.name; }
    })()`);
    // Abort only after the origin actually saw the stream start; the server's
    // start counter is the real signal, not a fixed delay.
    await waitFor(
      () => server.streamState.started > startedBefore,
      5000,
      'forwarded stream reaches the origin before abort',
    );
    await a.wc.executeJavaScript('window.__abortStream()');
    const abortResult = await abortPromise;
    check('stream-abort-rejected', abortResult === 'AbortError', `abort returned ${abortResult}`);
    await waitFor(
      () => server.streamState.cancelled > cancelledBefore,
      5000,
      'origin saw the cancellation',
    );
    check(
      'origin-saw-cancel',
      server.streamState.cancelled > cancelledBefore,
      JSON.stringify(server.streamState),
    );
    d.win.destroy();
    await waitFor(() => coordinator.status().handled === false, 8000, 'final unhandle');
    check('stream-cancel-no-residue', coordinator.status().handled === false);
    return { ok: checks.every((c) => c.pass), name: 'forwarding-integrity', checks };
  } finally {
    await world.cleanup();
  }
}

async function scenarioRefusals() {
  const { check, checks } = makeChecks();
  const { BrowserWindow } = require('electron');
  // A pre-existing unknown handler must never be taken over.
  const presetSession = require('electron').session.fromPartition(
    `agyctl-preset-${process.pid}-${Date.now()}`,
    { cache: false },
  );
  presetSession.protocol.handle('https', () => new Response('preset'));
  try {
    let code = null;
    try {
      new SessionDeliveryCoordinator({
        session: presetSession,
        binding: {
          origin: 'https://127.0.0.1:1',
          artifactId: ARTIFACT_ID,
          locale: LOCALE,
          routes: ['/main.js'],
          resolve: async () => null,
        },
      }).attach();
    } catch (error) {
      code = error.code;
    }
    check('protocol-in-use-refused', code === 'PROTOCOL_IN_USE', `attach threw ${code}`);
  } finally {
    presetSession.protocol.unhandle('https');
  }

  const failureEvents = [];
  const world = await createWorld('refusals', {
    confirmationTimeoutMs: 600,
    variant: SILENT_VARIANT,
    onFailure: (record) => failureEvents.push(record),
  });
  try {
    const { coordinator, origin } = world;
    coordinator.attach();
    let doubleCode = null;
    try {
      coordinator.attach();
    } catch (error) {
      doubleCode = error.code;
    }
    check('double-attach-refused', doubleCode === 'ALREADY_ATTACHED', `threw ${doubleCode}`);
    const a = openHubWindow(world, BrowserWindow);
    loadHub(world, a);
    await waitFor(() => world.servedCount() >= 1, 10_000, 'variant served');
    await waitFor(
      () => coordinator.recordsFor(a.wc.id).some((r) => r.state === 'failed'),
      8000,
      'confirmation timeout settles the record',
    );
    const failed = coordinator.recordsFor(a.wc.id).find((r) => r.state === 'failed');
    check(
      'timeout-recorded',
      failed?.failure?.code === 'ACTIVATION_TIMEOUT',
      JSON.stringify(failed?.failure ?? null),
    );
    check(
      'timeout-does-not-fake-success',
      coordinator.healthState() === 'degraded' && coordinator.status().handled === false,
      coordinator.healthState(),
    );
    check(
      'timeout-variant-still-ran',
      await a.wc.executeJavaScript('window.__LOCALIZED_BUNDLE_RAN__ === true'),
      'the delivered bundle ran; only confirmation was missing',
    );

    const b = openHubWindow(world, BrowserWindow);
    world.setVariant(CONFIRMING_VARIANT);
    loadHub(world, b);
    await waitForActive(world, b.wc, 'window B');
    const recordsBefore = coordinator.status().records.length;
    await b.wc.executeJavaScript(`history.pushState({}, '', '${origin}/dash')`);
    await new Promise((resolve) => setImmediate(resolve));
    const recordsAfter = coordinator.status().records;
    check(
      'spa-does-not-rearm',
      recordsAfter.length === recordsBefore && coordinator.status().handled === false,
      JSON.stringify(recordsAfter),
    );

    coordinator.beginNavigation(b.wc);
    const armed = coordinator.status().handled;
    b.wc.forcefullyCrashRenderer();
    await waitFor(
      () => coordinator.recordsFor(b.wc.id).some((r) => r.state === 'failed'),
      8000,
      'renderer crash settles the pending record',
    );
    const crashed = coordinator.recordsFor(b.wc.id).find((r) => r.state === 'failed');
    check(
      'crash-recorded',
      armed && crashed?.failure?.code === 'RENDERER_GONE',
      JSON.stringify(crashed?.failure ?? null),
    );
    check('crash-unhandles', coordinator.status().handled === false);
    const {
      createManagedArtifactResolver,
    } = require('../../../dist/localization/bundle/host-engine.cjs');
    const { createHash } = require('node:crypto');
    const artifactDirectory = path.join(world.tmpDir, 'artifacts', ARTIFACT_ID);
    fs.mkdirSync(artifactDirectory, { recursive: true });
    fs.writeFileSync(path.join(artifactDirectory, 'main.js'), 'changed artifact');
    const expectedHash = createHash('sha256').update('approved artifact').digest('hex');
    for (const [name, readFile] of [
      ['hash', undefined],
      [
        'read',
        async () => {
          throw new Error('Artifact read refused');
        },
      ],
    ]) {
      coordinator.rebind({
        origin,
        artifactId: ARTIFACT_ID,
        locale: LOCALE,
        routes: ['/main.js'],
        resolve: createManagedArtifactResolver({
          stateRoot: world.tmpDir,
          artifactId: ARTIFACT_ID,
          files: { '/main.js': expectedHash },
          readFile,
        }),
      });
      const record = coordinator.beginNavigation(a.wc);
      const response = await coordinator.handleRequest(new Request(`${origin}/main.js`));
      check(
        `${name}-failure-forwards-original`,
        response.status === 200 && (await response.text()).includes('__ORIGINAL_BUNDLE_RAN__'),
      );
      check(
        `${name}-failure-settles-before-confirmation`,
        record.state === 'failed' &&
          record.failure?.code === 'ARTIFACT_INVALID' &&
          record.confirmTimer === null,
        JSON.stringify(record.failure),
      );
      check(`${name}-failure-notifies-recovery`, failureEvents.includes(record));
      check(`${name}-failure-removes-interception`, !world.ses.protocol.isProtocolHandled('https'));
    }
    return { ok: checks.every((c) => c.pass), name: 'refusals', checks };
  } finally {
    await world.cleanup();
  }
}

async function scenarioRearm() {
  const { check, checks } = makeChecks();
  const world = await createWorld('rearm');
  const { BrowserWindow } = require('electron');
  try {
    const { coordinator, origin, server } = world;
    coordinator.attach();
    const a = openHubWindow(world, BrowserWindow);
    loadHub(world, a);
    await waitForActive(world, a.wc, 'first load');
    check('first-load-served', world.servedCount() === 1, `served ${world.servedCount()}`);
    await waitFor(() => coordinator.status().handled === false, 5000, 'first unhandle');
    const body = await a.wc.executeJavaScript(`fetch('${origin}/main.js').then(r => r.text())`);
    check(
      'unhandle-clears-interception',
      body === server.originalMain.toString(),
      'after unhandle the origin serves the original bundle',
    );
    a.wc.loadURL(`${origin}/`);
    await waitFor(() => world.servedCount() >= 2, 10_000, 'second load served');
    await waitForActive(world, a.wc, 'second load');
    check(
      'rearm-served-variant',
      await a.wc.executeJavaScript('window.__LOCALIZED_BUNDLE_RAN__ === true'),
    );
    check(
      'rearm-then-settle',
      coordinator.status().handled === false,
      'handler removed again after the second load',
    );
    return { ok: checks.every((c) => c.pass), name: 'rearm', checks };
  } finally {
    await world.cleanup();
  }
}

async function scenarioProductionHook() {
  const { createHash } = require('node:crypto');
  const { BrowserWindow } = require('electron');
  const { check, checks } = makeChecks();
  const world = await createWorld('production');
  const windows = [];
  const runtimes = [];
  try {
    const hash = (body) => createHash('sha256').update(body).digest('hex');
    const { buildArtifact, stableStringify } = await import(
      '../../../dist/localization/bundle/localization-cli.mjs'
    );
    const built = buildArtifact(
      {
        profileId: 'production-fixture',
        adapterVersion: '1',
        toolchainSha256: hash('fixture'),
        locale: LOCALE,
        formatLocale: 'zh-TW',
        source: { file: 'main.js', sha256: hash(world.server.originalMain) },
        catalog: { schemaVersion: 1, messages: {} },
      },
      { text: 'window.__LOCALIZED_BUNDLE_RAN__ = true;', applied: [], probe: true },
    );
    const artifactId = built.manifest.artifactId;
    const stateRoot = path.join(world.tmpDir, 'state');
    const artifactDir = path.join(stateRoot, 'artifacts', artifactId);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, 'main.js'), built.text);
    fs.writeFileSync(path.join(artifactDir, 'manifest.json'), JSON.stringify(built.manifest));
    fs.writeFileSync(
      path.join(artifactDir, 'coverage.json'),
      `${stableStringify(built.coverage)}\n`,
    );
    const installationId = '1'.repeat(64);
    const config = { schemaVersion: 2, stateRoot, installationId };
    const installationDir = path.join(stateRoot, 'installations', installationId);
    const selectionPath = path.join(installationDir, 'selection.json');
    fs.mkdirSync(installationDir, { recursive: true });
    fs.writeFileSync(
      selectionPath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        artifactId,
        locale: LOCALE,
        selectedAt: new Date().toISOString(),
      }),
    );
    const loadRuntime = (runtimeConfig) => {
      // Separate bundle copies model fresh processes without changing global state.
      const directory = path.join(world.tmpDir, `runtime-${runtimes.length}`);
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, 'runtime-config.json'), JSON.stringify(runtimeConfig));
      const runtimePath = path.join(directory, 'host-engine.cjs');
      fs.copyFileSync(
        path.join(__dirname, '../../../dist/localization/bundle/host-engine.cjs'),
        runtimePath,
      );
      const runtime = require(runtimePath);
      runtimes.push(runtime);
      return runtime;
    };
    const open = () => {
      const hub = openHubWindow(world, BrowserWindow);
      windows.push(hub.win);
      return hub;
    };
    const runtime = loadRuntime(config);
    const snapshot = runtime.initializeHostRuntime();
    check(
      'production-startup-snapshot',
      snapshot.artifactId === artifactId && snapshot.locale === LOCALE,
    );
    const first = open();
    await runtime.loadLocalizedURL(first.wc, `${world.origin}/`);
    await waitFor(
      () => !world.ses.protocol.isProtocolHandled('https'),
      5000,
      'production confirmation',
    );
    check(
      'production-variant-executed',
      await first.wc.executeJavaScript(
        'window.__LOCALIZED_BUNDLE_RAN__ === true && window.__ORIGINAL_BUNDLE_RAN__ !== true',
      ),
    );
    const statusPath = path.join(installationDir, 'runtime-status.json');
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
        .readdirSync(path.join(stateRoot, 'logs', 'runtime', installationId))
        .some((name) => /\.jsonl$/.test(name)),
    );

    fs.rmSync(selectionPath);
    const second = open();
    await runtime.loadLocalizedURL(second.wc, `${world.origin}/`);
    await waitFor(
      () => !world.ses.protocol.isProtocolHandled('https'),
      5000,
      'second window confirmation',
    );
    check(
      'production-selection-fixed-for-process',
      runtime.initializeHostRuntime() === snapshot &&
        (await second.wc.executeJavaScript('window.__LOCALIZED_BUNDLE_RAN__ === true')),
    );
    runtime.closeRuntimePersistence();
    check(
      'production-dispose-removes-window-listeners',
      first.wc.listenerCount('did-start-navigation') === 0 &&
        second.wc.listenerCount('did-start-navigation') === 0,
    );

    const missing = loadRuntime(config);
    check('production-next-startup-missing-refused', missing.initializeHostRuntime() === null);
    await missing.loadLocalizedURL(first.wc, `${world.origin}/`);
    const failedStatus = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    check(
      'production-startup-failure-persisted',
      failedStatus.healthState === 'degraded' && failedStatus.terminal.code === 'SELECTION_MISSING',
      JSON.stringify(failedStatus),
    );
    check(
      'production-failure-loads-original',
      await first.wc.executeJavaScript(
        'window.__ORIGINAL_BUNDLE_RAN__ === true && window.__LOCALIZED_BUNDLE_RAN__ !== true',
      ),
    );
    missing.closeRuntimePersistence();

    // Schema-less runtime configs are refused outright (deletion ledger);
    // source drift is expressed with a valid selection whose artifact claims
    // a different source digest than the live Hub serves.
    const driftId = hash('drift-fixture');
    const driftDir = path.join(stateRoot, 'artifacts', driftId);
    fs.mkdirSync(driftDir, { recursive: true });
    fs.writeFileSync(path.join(driftDir, 'main.js'), built.text);
    fs.writeFileSync(
      path.join(driftDir, 'manifest.json'),
      JSON.stringify({ ...built.manifest, artifactId: driftId, sourceMainSha256: '0'.repeat(64) }),
    );
    fs.writeFileSync(
      selectionPath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        artifactId: driftId,
        locale: LOCALE,
        selectedAt: new Date().toISOString(),
      }),
    );
    const drifted = loadRuntime(config);
    let refused = false;
    try {
      await drifted.prepareNavigation(first.wc, `${world.origin}/`);
    } catch (error) {
      refused = error.code === 'SOURCE_MISMATCH';
    }
    check('production-source-drift-refused', refused);
    await drifted.loadLocalizedURL(first.wc, `${world.origin}/`);
    check(
      'production-failure-removes-interception',
      !world.ses.protocol.isProtocolHandled('https'),
    );
    drifted.closeRuntimePersistence();

    const englishBuilt = buildArtifact(
      {
        profileId: 'production-fixture',
        adapterVersion: '1',
        toolchainSha256: hash('fixture'),
        locale: 'en',
        formatLocale: 'en',
        source: { file: 'main.js', sha256: hash(world.server.originalMain) },
        catalog: { schemaVersion: 1, messages: {} },
      },
      { text: 'window.__ORIGINAL_BUNDLE_RAN__ = true;', applied: [], probe: true },
    );
    const englishId = englishBuilt.manifest.artifactId;
    const englishDir = path.join(stateRoot, 'artifacts', englishId);
    fs.mkdirSync(englishDir, { recursive: true });
    fs.writeFileSync(path.join(englishDir, 'main.js'), englishBuilt.text);
    fs.writeFileSync(path.join(englishDir, 'manifest.json'), JSON.stringify(englishBuilt.manifest));
    fs.writeFileSync(
      path.join(englishDir, 'coverage.json'),
      `${stableStringify(englishBuilt.coverage)}\n`,
    );
    fs.writeFileSync(
      selectionPath,
      JSON.stringify({
        schemaVersion: 1,
        installationId,
        artifactId: englishId,
        locale: 'en',
        selectedAt: new Date().toISOString(),
      }),
    );
    const english = loadRuntime(config);
    const sourceRequests = world.server.requestLog.length;
    await english.prepareNavigation(first.wc, `${world.origin}/`);
    check(
      'production-english-no-handler-or-source-probe',
      !world.ses.protocol.isProtocolHandled('https') &&
        world.server.requestLog.length === sourceRequests &&
        english.nativeCatalogLocale() === null,
    );
    english.closeRuntimePersistence();
    return { ok: checks.every((entry) => entry.pass), name: 'production-hook', checks };
  } finally {
    for (const runtime of runtimes) runtime.closeRuntimePersistence();
    for (const win of windows) if (!win.isDestroyed()) win.destroy();
    await world.cleanup();
  }
}

const scenarios = {
  'precise-delivery': scenarioPreciseDelivery,
  'reload-and-parallel': scenarioReloadAndParallel,
  'forwarding-integrity': scenarioForwardingIntegrity,
  refusals: scenarioRefusals,
  rearm: scenarioRearm,
  'production-hook': scenarioProductionHook,
};

module.exports = { scenarios, ARTIFACT_ID, LOCALE, CONFIRMING_VARIANT };
