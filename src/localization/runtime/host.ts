// Hub bootstrap and native catalog runtime. Runs inside the Electron main
// process. Official delivery injects the DOM engine after a restricted IPC
// handshake; it does not intercept HTTPS or rewrite Language Server assets.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { readArtifactDelivery } from '../artifact.js';
import {
  BOOTSTRAP_CHANNEL,
  BOOTSTRAP_RESULT_CHANNEL,
  SYNC_CHANNEL,
  authorizeBootstrapSender,
  bootstrapHealthState,
  decodeBootstrapResult,
  matchHubNavigation,
} from './hub.js';
import { initNativeMessages, resetNativeMessages } from './native.js';
import {
  RuntimePersistence,
  readRuntimeConfig,
  resolveStartupSnapshot,
  StartupError,
  type RuntimeConfig,
  type StartupSnapshot,
} from './startup.js';

export {
  initNativeMessages,
  nativeAgentsRunning,
  nativeCatalogLocale,
  nativeFormat,
  nativeText,
  resetNativeMessages,
} from './native.js';

export {
  RuntimePersistence,
  decodeArtifactManifest,
  decodeRuntimeConfig,
  decodeRuntimeStatus,
  decodeSelectionSnapshot,
  readRuntimeStatus,
  resolveStartupSnapshot,
  StartupError,
} from './startup.js';
export type { RuntimeStatusSnapshot, StartupSnapshot } from './startup.js';

export { BOOTSTRAP_CHANNEL, BOOTSTRAP_RESULT_CHANNEL, SYNC_CHANNEL } from './hub.js';

export type HostErrorCode = 'ARTIFACT_INVALID' | 'HOST_CONFLICT' | 'SOURCE_MISMATCH';

export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'HostError';
  }
}

interface BootstrapDelivery {
  ok: boolean;
  code?: string;
  locale?: string;
  engine?: string;
  index?: unknown;
}

const hubWindows = new Map<
  number,
  {
    webContents: Electron.WebContents;
    origin: string;
    snapshot: StartupSnapshot;
    bootstrapFrame: Electron.WebFrameMain | null;
    dispose(): void;
  }
>();
let bootstrapHandlerInstalled = false;
let startupAttempted = false;
let startupConfig: RuntimeConfig | null = null;
let startupSnapshot: StartupSnapshot | null = null;
let activeSnapshot: StartupSnapshot | null = null;
let startupFailure: unknown;
let runtimePersistence: RuntimePersistence | null = null;
let selectionWatcher: fs.FSWatcher | null = null;
let selectionWatchTimer: ReturnType<typeof setTimeout> | null = null;
let runtimeClosed = false;

function currentSnapshot(): StartupSnapshot | null {
  return activeSnapshot ?? startupSnapshot;
}

function buildBootstrapDelivery(snapshot: StartupSnapshot): BootstrapDelivery {
  if (snapshot.locale === 'en') return { ok: false, code: 'DISABLED' };
  if (snapshot.format !== 'dom') return { ok: false, code: 'AST_DELIVERY' };
  if (!snapshot.engineSha256 || !snapshot.indexSha256)
    return { ok: false, code: 'ARTIFACT_INVALID' };
  try {
    const delivery = readArtifactDelivery(
      path.join(snapshot.stateRoot, 'artifacts', snapshot.artifactId),
      { artifactId: snapshot.artifactId, locale: snapshot.locale },
    );
    const engine = fs.readFileSync(path.join(__dirname, 'dom-engine.js'));
    if (createHash('sha256').update(engine).digest('hex') !== snapshot.engineSha256)
      return { ok: false, code: 'ARTIFACT_INVALID' };
    return {
      ok: true,
      locale: snapshot.locale,
      engine: engine.toString('utf8'),
      index: delivery.index,
    };
  } catch {
    return { ok: false, code: 'ARTIFACT_INVALID' };
  }
}

function hubSenderView(event: Electron.IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  const destroyed = event.sender.isDestroyed();
  return {
    senderId: event.sender.id,
    frameUrl: frame?.url ?? null,
    isMainFrame: frame !== null && frame.parent === null,
    hasParentFrame: frame !== null && frame.parent !== null,
    isCurrentMainFrame: frame !== null && frame === event.sender.mainFrame,
    isDestroyed: destroyed,
    isGuest: !destroyed && event.sender.getType() === 'webview',
  };
}

function handleHubBootstrap(event: Electron.IpcMainInvokeEvent): BootstrapDelivery {
  const snapshot = currentSnapshot();
  if (!snapshot || snapshot.locale === 'en') return { ok: false, code: 'DISABLED' };
  if (snapshot.format !== 'dom') return { ok: false, code: 'AST_DELIVERY' };
  const registered = hubWindows.get(event.sender.id);
  if (!registered) return { ok: false, code: 'UNAUTHORIZED' };
  const authorized = authorizeBootstrapSender(hubSenderView(event), {
    webContentsId: event.sender.id,
    origin: registered.origin,
    locale: snapshot.locale,
  });
  if (!authorized.ok) return authorized;
  registered.snapshot = snapshot;
  registered.bootstrapFrame = event.senderFrame;
  return buildBootstrapDelivery(snapshot);
}

function handleHubBootstrapResult(
  event: Electron.IpcMainInvokeEvent,
  payload: unknown,
): {
  ok: boolean;
  code?: string;
} {
  const registered = hubWindows.get(event.sender.id);
  if (!registered) return { ok: false, code: 'UNAUTHORIZED' };
  const snapshot = currentSnapshot() ?? registered.snapshot;
  const authorized = authorizeBootstrapSender(hubSenderView(event), {
    webContentsId: event.sender.id,
    origin: registered.origin,
    locale: snapshot.locale,
  });
  if (!authorized.ok) return { ok: false, code: authorized.code };
  if (registered.bootstrapFrame !== event.senderFrame) return { ok: false, code: 'UNAUTHORIZED' };
  const result = decodeBootstrapResult(payload);
  runtimePersistence?.sink({
    level: result.ok ? 'info' : 'error',
    stage: 'runtime.bootstrap',
    event: result.ok ? 'started' : 'failed',
    result: result.ok ? 'ok' : 'failed',
    artifactId: snapshot.artifactId,
    locale: snapshot.locale,
    ...(!result.ok && result.code ? { code: result.code } : {}),
    ...(result.stats?.translated !== undefined
      ? { counts: { translated: result.stats.translated } }
      : {}),
  });
  runtimePersistence?.recordStatus({
    artifactId: snapshot.artifactId,
    locale: snapshot.locale,
    healthState: bootstrapHealthState(result),
    ...(!result.ok
      ? { terminal: { code: result.code ?? 'BOOTSTRAP_FAILED', message: 'DOM engine did not start' } }
      : {}),
  });
  return { ok: result.ok, ...(result.code ? { code: result.code } : {}) };
}

function installBootstrapHandler(): void {
  if (bootstrapHandlerInstalled) return;
  bootstrapHandlerInstalled = true;
  ipcMain.handle(BOOTSTRAP_CHANNEL, (event) => handleHubBootstrap(event));
  ipcMain.handle(BOOTSTRAP_RESULT_CHANNEL, (event, payload) =>
    handleHubBootstrapResult(event, payload),
  );
}

function registerHubWindow(
  webContents: Electron.WebContents,
  origin: string,
  snapshot: StartupSnapshot,
): void {
  const previous = hubWindows.get(webContents.id);
  if (previous) {
    if (previous.origin !== origin)
      throw new HostError('SOURCE_MISMATCH', 'The registered Hub origin cannot change');
    previous.snapshot = snapshot;
    return;
  }
  installBootstrapHandler();
  const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (runtimeClosed || !details.isMainFrame || details.isSameDocument) return;
    registered.bootstrapFrame = null;
    const active = currentSnapshot() ?? registered.snapshot;
    const matched = matchHubNavigation(details.url);
    const allowed = matched.ok && matched.origin === registered.origin;
    runtimePersistence?.recordStatus({
      artifactId: active.artifactId,
      locale: active.locale,
      healthState: allowed ? 'ready' : 'degraded',
      ...(!allowed
        ? {
            terminal: {
              code: 'SOURCE_MISMATCH',
              message: 'Hub navigation left the reviewed app documents',
            },
          }
        : {}),
    });
  };
  const onDestroyed = () => {
    registered.dispose();
    hubWindows.delete(webContents.id);
  };
  const registered = {
    webContents,
    origin,
    snapshot,
    bootstrapFrame: null as Electron.WebFrameMain | null,
    dispose() {
      webContents.removeListener('did-start-navigation', onNavigation);
      webContents.removeListener('destroyed', onDestroyed);
    },
  };
  hubWindows.set(webContents.id, registered);
  webContents.on('did-start-navigation', onNavigation);
  webContents.once('destroyed', onDestroyed);
}

function recordRuntimeFailure(error: unknown, stage = 'runtime.startup'): void {
  const active = currentSnapshot();
  const code =
    error instanceof StartupError || error instanceof HostError
      ? error.code
      : 'RUNTIME_CONFIG_INVALID';
  const message = error instanceof Error ? error.message : String(error);
  runtimePersistence?.sink({
    level: 'error',
    stage,
    event: 'failed',
    result: 'failed',
    code,
    artifactId: active?.artifactId,
    locale: active?.locale,
    detail: message,
  });
  runtimePersistence?.recordStatus({
    artifactId: active?.artifactId ?? null,
    locale: active?.locale ?? null,
    healthState: 'degraded',
    terminal: { code, message },
  });
}

function pushLiveLocaleUpdate(snapshot: StartupSnapshot, delivery: BootstrapDelivery): void {
  for (const registered of hubWindows.values()) {
    const wc = registered.webContents;
    if (wc.isDestroyed() || wc.getType() === 'webview') continue;
    const frame = wc.mainFrame;
    if (!frame || frame.parent !== null) continue;
    const matched = matchHubNavigation(frame.url);
    if (!matched.ok || matched.origin !== registered.origin) continue;
    registered.snapshot = snapshot;
    registered.bootstrapFrame = frame;
    try {
      wc.send(SYNC_CHANNEL, delivery);
    } catch {}
  }
}

function installSelectionWatcher(config: RuntimeConfig): void {
  if (selectionWatcher || runtimeClosed) return;
  const selectionDir = path.join(config.stateRoot, 'installations', config.installationId);
  try {
    selectionWatcher = fs.watch(selectionDir, (_eventType, filename) => {
      if (runtimeClosed) return;
      if (filename && String(filename) !== 'selection.json') return;
      if (selectionWatchTimer) clearTimeout(selectionWatchTimer);
      selectionWatchTimer = setTimeout(() => {
        selectionWatchTimer = null;
        refreshHostLocalization();
      }, 40);
      selectionWatchTimer.unref?.();
    });
    selectionWatcher.on('error', () => {});
    selectionWatcher.unref?.();
  } catch {}
}

/**
 * Re-reads selection.json and switches active Hub windows live without restart.
 * Missing or invalid updates keep the current active snapshot intact so
 * process-fixed guarantees still hold if selection.json is removed.
 */
export function refreshHostLocalization(): {
  changed: boolean;
  locale: string | null;
  artifactId?: string;
  code?: string;
} {
  const current = currentSnapshot();
  if (runtimeClosed || !startupConfig || !current) {
    return { changed: false, locale: current?.locale ?? null };
  }
  let next: StartupSnapshot;
  try {
    next = Object.freeze(resolveStartupSnapshot(__dirname, { config: startupConfig }));
  } catch (error) {
    const code = error instanceof StartupError ? error.code : 'SELECTION_INVALID';
    if (code !== 'SELECTION_MISSING') {
      runtimePersistence?.sink({
        level: 'warn',
        stage: 'runtime.switch',
        event: 'rejected',
        result: 'rejected',
        code,
        artifactId: current.artifactId,
        locale: current.locale,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return { changed: false, locale: current.locale, code };
  }
  if (next.artifactId === current.artifactId && next.locale === current.locale) {
    return { changed: false, locale: current.locale, artifactId: current.artifactId };
  }
  const delivery = buildBootstrapDelivery(next);
  if (next.locale !== 'en' && next.format === 'dom' && !delivery.ok) {
    runtimePersistence?.sink({
      level: 'error',
      stage: 'runtime.switch',
      event: 'rejected',
      result: 'failed',
      code: delivery.code ?? 'ARTIFACT_INVALID',
      artifactId: next.artifactId,
      locale: next.locale,
    });
    return { changed: false, locale: current.locale, code: delivery.code ?? 'ARTIFACT_INVALID' };
  }
  activeSnapshot = next;
  if (next.locale === 'en') {
    resetNativeMessages();
  } else {
    const native = initNativeMessages(next);
    runtimePersistence?.sink({
      level: native.ok ? 'info' : 'error',
      stage: 'runtime.native',
      event: native.ok ? 'loaded' : 'failed',
      result: native.ok ? 'ok' : 'failed',
      artifactId: next.artifactId,
      locale: next.locale,
      ...(!native.ok ? { code: native.code, detail: native.message } : {}),
    });
  }
  runtimePersistence?.sink({
    level: 'info',
    stage: 'runtime.switch',
    event: 'resolved',
    result: 'ok',
    artifactId: next.artifactId,
    locale: next.locale,
  });
  runtimePersistence?.recordStatus({
    artifactId: next.artifactId,
    locale: next.locale,
    healthState: next.locale === 'en' ? 'armed' : 'ready',
  });
  pushLiveLocaleUpdate(next, delivery);
  return { changed: true, locale: next.locale, artifactId: next.artifactId };
}

/** Resolves one process-fixed initial Web/native binding and arms live selection updates. */
export function initializeHostRuntime(): StartupSnapshot | null {
  if (startupAttempted || runtimeClosed) return startupSnapshot;
  startupAttempted = true;
  try {
    const config = readRuntimeConfig(__dirname);
    startupConfig = config;
    runtimePersistence = new RuntimePersistence({
      stateRoot: config.stateRoot,
      installationId: config.installationId,
    });
    installBootstrapHandler();
    runtimePersistence.sink({
      level: 'info',
      stage: 'runtime.startup',
      event: 'started',
      result: 'started',
    });
    app?.once('will-quit', closeRuntimePersistence);
    startupSnapshot = Object.freeze(resolveStartupSnapshot(__dirname, { config }));
    activeSnapshot = startupSnapshot;
    if (startupSnapshot.locale === 'en') {
      resetNativeMessages();
    } else {
      const native = initNativeMessages(startupSnapshot);
      runtimePersistence.sink({
        level: native.ok ? 'info' : 'error',
        stage: 'runtime.native',
        event: native.ok ? 'loaded' : 'failed',
        result: native.ok ? 'ok' : 'failed',
        artifactId: startupSnapshot.artifactId,
        locale: startupSnapshot.locale,
        ...(!native.ok ? { code: native.code, detail: native.message } : {}),
      });
    }
    installSelectionWatcher(config);
    runtimePersistence.sink({
      level: 'info',
      stage: 'runtime.startup',
      event: 'resolved',
      result: 'ok',
      artifactId: startupSnapshot.artifactId,
      locale: startupSnapshot.locale,
    });
    runtimePersistence.recordStatus({ ...startupSnapshot, healthState: 'ready' });
    return startupSnapshot;
  } catch (error) {
    startupFailure = error;
    resetNativeMessages();
    recordRuntimeFailure(error);
    console.error(
      '[agyctl localization] startup failed; the original interface is retained',
      error,
    );
    return null;
  }
}

/** Releases every runtime log segment and watcher; used on teardown and by test harnesses. */
export function closeRuntimePersistence(): void {
  if (runtimeClosed) return;
  runtimeClosed = true;
  if (selectionWatchTimer) {
    clearTimeout(selectionWatchTimer);
    selectionWatchTimer = null;
  }
  if (selectionWatcher) {
    try {
      selectionWatcher.close();
    } catch {}
    selectionWatcher = null;
  }
  for (const registered of hubWindows.values()) registered.dispose();
  hubWindows.clear();
  if (bootstrapHandlerInstalled) {
    ipcMain.removeHandler(BOOTSTRAP_CHANNEL);
    ipcMain.removeHandler(BOOTSTRAP_RESULT_CHANNEL);
    bootstrapHandlerInstalled = false;
  }
  runtimePersistence?.close();
  resetNativeMessages();
  app?.removeListener('will-quit', closeRuntimePersistence);
}

/** Arms the reviewed Hub load before the original loadURL starts navigation. */
export async function prepareNavigation(
  webContents: Electron.WebContents,
  targetUrl: string,
): Promise<void> {
  try {
    if (runtimeClosed) throw new HostError('HOST_CONFLICT', 'Localization runtime is closed');
    const initial = initializeHostRuntime();
    if (!initial) throw startupFailure;
    const snapshot = currentSnapshot() ?? initial;
    const matched = matchHubNavigation(targetUrl);
    if (!matched.ok) {
      if (snapshot.locale === 'en' || snapshot.format !== 'dom') return;
      throw new HostError('SOURCE_MISMATCH', 'Unreviewed Hub navigation target');
    }
    if (snapshot.format !== 'dom' && snapshot.locale !== 'en') return;
    registerHubWindow(webContents, matched.origin, snapshot);
  } catch (error) {
    if (startupSnapshot) recordRuntimeFailure(error, 'runtime.prepare');
    throw error;
  }
}

/** A localization failure is reported but must not prevent the original Hub from loading. */
export async function loadLocalizedURL(
  webContents: Electron.WebContents,
  targetUrl: string,
  options?: Electron.LoadURLOptions,
): Promise<void> {
  try {
    await prepareNavigation(webContents, targetUrl);
  } catch (error) {
    console.error(
      '[agyctl localization] preparation failed; loading original untranslated interface',
      error,
    );
  }
  await webContents.loadURL(targetUrl, options);
}
