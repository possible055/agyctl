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

export { BOOTSTRAP_CHANNEL, BOOTSTRAP_RESULT_CHANNEL } from './hub.js';

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

const hubWindows = new Map<
  number,
  {
    origin: string;
    snapshot: StartupSnapshot;
    bootstrapFrame: Electron.WebFrameMain | null;
    dispose(): void;
  }
>();
let bootstrapHandlerInstalled = false;
let startupAttempted = false;
let startupSnapshot: StartupSnapshot | null = null;
let startupFailure: unknown;
let runtimePersistence: RuntimePersistence | null = null;
let runtimeClosed = false;

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

function handleHubBootstrap(event: Electron.IpcMainInvokeEvent): {
  ok: boolean;
  code?: string;
  locale?: string;
  engine?: string;
  index?: unknown;
} {
  if (!startupSnapshot || startupSnapshot.locale === 'en') return { ok: false, code: 'DISABLED' };
  if (startupSnapshot.format !== 'dom') return { ok: false, code: 'AST_DELIVERY' };
  const registered = hubWindows.get(event.sender.id);
  if (!registered) return { ok: false, code: 'UNAUTHORIZED' };
  const authorized = authorizeBootstrapSender(hubSenderView(event), {
    webContentsId: event.sender.id,
    origin: registered.origin,
    locale: registered.snapshot.locale,
  });
  if (!authorized.ok) return authorized;
  registered.bootstrapFrame = event.senderFrame;
  if (!registered.snapshot.engineSha256 || !registered.snapshot.indexSha256)
    return { ok: false, code: 'ARTIFACT_INVALID' };
  try {
    const delivery = readArtifactDelivery(
      path.join(registered.snapshot.stateRoot, 'artifacts', registered.snapshot.artifactId),
      { artifactId: registered.snapshot.artifactId, locale: registered.snapshot.locale },
    );
    const engine = fs.readFileSync(path.join(__dirname, 'dom-engine.js'));
    if (createHash('sha256').update(engine).digest('hex') !== registered.snapshot.engineSha256)
      return { ok: false, code: 'ARTIFACT_INVALID' };
    return {
      ok: true,
      locale: registered.snapshot.locale,
      engine: engine.toString('utf8'),
      index: delivery.index,
    };
  } catch {
    return { ok: false, code: 'ARTIFACT_INVALID' };
  }
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
  const authorized = authorizeBootstrapSender(hubSenderView(event), {
    webContentsId: event.sender.id,
    origin: registered.origin,
    locale: registered.snapshot.locale,
  });
  if (!authorized.ok) return { ok: false, code: authorized.code };
  if (registered.bootstrapFrame !== event.senderFrame) return { ok: false, code: 'UNAUTHORIZED' };
  const result = decodeBootstrapResult(payload);
  runtimePersistence?.sink({
    level: result.ok ? 'info' : 'error',
    stage: 'runtime.bootstrap',
    event: result.ok ? 'started' : 'failed',
    result: result.ok ? 'ok' : 'failed',
    artifactId: registered.snapshot.artifactId,
    locale: registered.snapshot.locale,
    ...(!result.ok && result.code ? { code: result.code } : {}),
    ...(result.stats?.translated !== undefined
      ? { counts: { translated: result.stats.translated } }
      : {}),
  });
  runtimePersistence?.recordStatus({
    artifactId: registered.snapshot.artifactId,
    locale: registered.snapshot.locale,
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
    return;
  }
  installBootstrapHandler();
  const onNavigation = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (runtimeClosed || !details.isMainFrame || details.isSameDocument) return;
    registered.bootstrapFrame = null;
    const matched = matchHubNavigation(details.url);
    const allowed = matched.ok && matched.origin === registered.origin;
    runtimePersistence?.recordStatus({
      artifactId: snapshot.artifactId,
      locale: snapshot.locale,
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
    artifactId: startupSnapshot?.artifactId,
    locale: startupSnapshot?.locale,
    detail: message,
  });
  runtimePersistence?.recordStatus({
    artifactId: startupSnapshot?.artifactId ?? null,
    locale: startupSnapshot?.locale ?? null,
    healthState: 'degraded',
    terminal: { code, message },
  });
}

/** Resolves one process-fixed Web/native binding before native display code runs. */
export function initializeHostRuntime(): StartupSnapshot | null {
  if (startupAttempted || runtimeClosed) return startupSnapshot;
  startupAttempted = true;
  try {
    const config = readRuntimeConfig(__dirname);
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

/** Releases every runtime log segment; used on teardown and by test harnesses. */
export function closeRuntimePersistence(): void {
  if (runtimeClosed) return;
  runtimeClosed = true;
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
    const snapshot = initializeHostRuntime();
    if (!snapshot) throw startupFailure;
    if (snapshot.locale === 'en' || snapshot.format !== 'dom') return;
    const matched = matchHubNavigation(targetUrl);
    if (!matched.ok)
      throw new HostError('SOURCE_MISMATCH', 'Unreviewed Hub navigation target');
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
