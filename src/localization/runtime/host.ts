// Session delivery coordinator for reviewed localization artifacts (plan §7).
// Runs inside the Electron main process. One coordinator per session: it owns
// the temporary https interception used to deliver approved assets and the
// per-navigation confirmation lifecycle, and nothing else.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { app, ipcMain, net, webContents as electronWebContents } from 'electron';
import type { LocalizationEventInput } from '../contracts.js';
import {
  RuntimePersistence,
  readRuntimeConfig,
  resolveStartupSnapshot,
  StartupError,
  type StartupSnapshot,
} from './startup.js';
import { initNativeMessages, resetNativeMessages } from './native.js';

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

export const CONFIRM_CHANNEL = 'agyctl:localization:confirm';

export type HostErrorCode =
  | 'ACTIVATION_TIMEOUT'
  | 'ALREADY_ATTACHED'
  | 'ARTIFACT_INVALID'
  | 'CONFIRMATION_INVALID'
  | 'HOST_CONFLICT'
  | 'PROTOCOL_IN_USE'
  | 'SOURCE_MISMATCH';

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

export type RecordState = 'active' | 'cancelled' | 'executed' | 'failed' | 'pending' | 'served';

export interface NavigationRecord {
  webContentsId: number;
  navigationId: number | null;
  generation: number;
  origin: string;
  nonce: string;
  artifactId: string;
  locale: string;
  state: RecordState;
  startedAt: number;
  settledAt: number | null;
  pageLoaded: boolean;
  failure: { code: string; message: string } | null;
  confirmTimer: ReturnType<typeof setTimeout> | null;
}

export interface ServedAsset {
  body: Uint8Array;
  contentType: string;
}

export interface AssetBinding {
  origin: string;
  artifactId: string;
  locale: string;
  routes: readonly string[];
  resolve: (route: string) => Promise<ServedAsset | null>;
}

export interface CoordinatorOptions {
  session: Electron.Session;
  binding: AssetBinding;
  confirmationTimeoutMs?: number;
  log?: (message: string) => void;
  /** Structured event sink (continuation plan §4); independent from the text log. */
  logEvent?: (event: LocalizationEventInput) => void;
  onFailure?: (record: NavigationRecord) => void;
}

export interface CoordinatorStatus {
  handled: boolean;
  generation: number;
  binding: { origin: string; artifactId: string; locale: string };
  records: Array<{
    webContentsId: number;
    navigationId: number | null;
    generation: number;
    state: RecordState;
    failure: { code: string; message: string } | null;
  }>;
}

const RECORD_ACTIVE_STATES: ReadonlySet<RecordState> = new Set(['pending', 'served', 'executed']);
const DELIVERY_CHUNK_BYTES = 1 << 16;
const FORWARD_QUEUE_LIMIT = 8;
const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);

// The confirmation channel is app-wide; the registry dispatches each
// invocation to the coordinator that owns the sending webContents.
const registry = new Map<number, SessionDeliveryCoordinator>();
const attachedCoordinators = new Set<SessionDeliveryCoordinator>();
let confirmHandlerInstalled = false;

function installConfirmHandler(): void {
  if (confirmHandlerInstalled) return;
  confirmHandlerInstalled = true;
  ipcMain.handle(CONFIRM_CHANNEL, (event, payload) => {
    const coordinator = registry.get(event.sender.id);
    if (!coordinator) return { ok: false, code: 'CONFIRMATION_INVALID' as const };
    return coordinator.handleConfirmation(event, payload);
  });
}

function assertHttpsOrigin(origin: string, code: HostErrorCode = 'HOST_CONFLICT'): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new HostError(code, `Invalid delivery origin: ${origin}`, { cause: error });
  }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search !== '' || url.hash !== '')
    throw new HostError(
      code,
      `Delivery binding must be an https origin without path/query: ${origin}`,
    );
  return url;
}

interface TrackedWebContents {
  webContents: Electron.WebContents;
  listeners: Array<[string, (...args: never[]) => void]>;
}

export class SessionDeliveryCoordinator {
  readonly #session: Electron.Session;
  #binding: AssetBinding;
  readonly #confirmationTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #logEvent: (event: LocalizationEventInput) => void;
  readonly #onFailure: (record: NavigationRecord) => void;
  readonly #records = new Map<number, NavigationRecord>();
  readonly #tracked = new Map<number, TrackedWebContents>();
  readonly #deadWebContents = new Set<number>();
  #generation = 0;
  #attached = false;
  #handled = false;
  #inFlightDeliveries = 0;
  #degraded = false;
  #nextRecordId = 1;
  #webRequestAttached = false;
  #webRequestSeq = 0;
  readonly #pendingWebRequestIds = new Map<string, Array<{ id: number; seq: number }>>();
  readonly #forwardAbortTargets = new Map<number, () => void>();

  constructor(options: CoordinatorOptions) {
    this.#session = options.session;
    this.#binding = options.binding;
    this.#confirmationTimeoutMs = Math.max(1, options.confirmationTimeoutMs ?? 15_000);
    this.#log = options.log ?? (() => {});
    this.#logEvent = options.logEvent ?? (() => {});
    this.#onFailure = options.onFailure ?? (() => {});
    for (const route of this.#binding.routes) {
      if (!route.startsWith('/') || route.includes('?') || route.includes('#'))
        throw new HostError(
          'HOST_CONFLICT',
          `Delivery route must be an origin-absolute path: ${route}`,
        );
    }
    assertHttpsOrigin(this.#binding.origin);
  }

  /** Emits one structured runtime event with the current binding context. */
  #emit(event: LocalizationEventInput): void {
    this.#logEvent({
      ...event,
      artifactId: event.artifactId ?? this.#binding.artifactId,
      locale: event.locale ?? this.#binding.locale,
    });
  }

  #rejectConfirmation(detail: string): { ok: false; code: 'CONFIRMATION_INVALID' } {
    this.#emit({
      level: 'warn',
      stage: 'runtime.confirm',
      event: 'rejected',
      result: 'rejected',
      code: 'CONFIRMATION_INVALID',
      detail,
    });
    return { ok: false, code: 'CONFIRMATION_INVALID' };
  }

  /** Installs the temporary https interception. Refuses an unknown existing handler. */
  attach(): void {
    if (this.#attached)
      throw new HostError('ALREADY_ATTACHED', 'Coordinator is already attached to this session');
    if (this.#session.protocol.isProtocolHandled('https'))
      throw new HostError(
        'PROTOCOL_IN_USE',
        'Session already has an https interception; refusing to take it over',
      );
    installConfirmHandler();
    this.#session.protocol.handle('https', (request) => this.handleRequest(request));
    this.#attached = true;
    attachedCoordinators.add(this);
    this.#handled = true;
    this.#emit({ level: 'info', stage: 'runtime.attach', event: 'attached', result: 'armed' });
    this.#log('localization coordinator attached');
  }

  /** Tracks a Hub webContents so user reloads, crashes and closes settle their records. */
  track(webContents: Electron.WebContents): void {
    const owner = registry.get(webContents.id);
    if (owner && owner !== this)
      throw new HostError(
        'HOST_CONFLICT',
        `webContents ${webContents.id} is already tracked by another coordinator`,
      );
    if (this.#tracked.has(webContents.id)) return;
    const listeners: TrackedWebContents['listeners'] = [];
    const on = (channel: string, handler: (...args: never[]) => void) => {
      webContents.on(channel as never, handler as never);
      listeners.push([channel, handler]);
    };
    on(
      'did-start-navigation',
      (event: Electron.Event<object>, url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (!isMainFrame || isInPlace) return;
        let origin: string;
        try {
          origin = new URL(url).origin;
        } catch {
          return;
        }
        if (origin !== this.#binding.origin) {
          this.release(webContents);
          return;
        }
        const navigationId = (event as { navigationId?: number }).navigationId ?? null;
        this.beginNavigation(webContents, navigationId);
      },
    );
    on('did-finish-load', () => {
      for (const record of this.recordsFor(webContents.id)) {
        record.pageLoaded = true;
        if (record.state === 'executed') this.#activate(record);
      }
    });
    on('render-process-gone', () => {
      for (const record of this.recordsFor(webContents.id)) {
        if (RECORD_ACTIVE_STATES.has(record.state) || record.state === 'active')
          this.#settle(record, 'failed', {
            code: 'RENDERER_GONE',
            message: 'Renderer process is gone',
          });
      }
    });
    on('destroyed', () => {
      for (const record of this.recordsFor(webContents.id)) {
        if (RECORD_ACTIVE_STATES.has(record.state) || record.state === 'active')
          this.#settle(record, 'cancelled', {
            code: 'WEB_CONTENTS_GONE',
            message: 'WebContents destroyed',
          });
      }
      this.#deadWebContents.add(webContents.id);
      for (const [channel, handler] of listeners)
        webContents.removeListener(channel as never, handler as never);
      this.#tracked.delete(webContents.id);
      if (registry.get(webContents.id) === this) registry.delete(webContents.id);
    });
    this.#tracked.set(webContents.id, { webContents, listeners });
    registry.set(webContents.id, this);
    this.#emit({
      level: 'debug',
      stage: 'runtime.track',
      event: 'tracked',
      result: 'ok',
      detail: `webContents=${webContents.id}`,
    });
  }

  /**
   * Arms one main-frame navigation before its loadURL. Also called from the
   * did-start-navigation listener, which adopts a record armed explicitly for
   * the same navigation instead of duplicating it.
   */
  beginNavigation(
    webContents: Electron.WebContents,
    navigationId: number | null = null,
  ): NavigationRecord {
    if (!this.#attached)
      throw new HostError('HOST_CONFLICT', 'attach() must run before arming a navigation');
    for (const record of this.recordsFor(webContents.id)) {
      if (!RECORD_ACTIVE_STATES.has(record.state) && record.state !== 'active') continue;
      if (navigationId !== null && record.navigationId === navigationId) return record;
      if (record.navigationId === null && record.state === 'pending') {
        record.navigationId = navigationId;
        return record;
      }
      // A new main-frame navigation supersedes an unfinished one.
      this.#settle(record, 'cancelled', {
        code: 'NAVIGATION_SUPERSEDED',
        message: 'Superseded by a newer main-frame navigation',
      });
    }
    const record: NavigationRecord = {
      webContentsId: webContents.id,
      navigationId,
      generation: this.#generation,
      origin: this.#binding.origin,
      nonce: randomUUID(),
      artifactId: this.#binding.artifactId,
      locale: this.#binding.locale,
      state: 'pending',
      startedAt: Date.now(),
      settledAt: null,
      pageLoaded: false,
      failure: null,
      confirmTimer: null,
    };
    this.#records.set(this.#nextRecordId++, record);
    this.#ensureHandled();
    this.#emit({
      level: 'info',
      stage: 'runtime.navigation',
      event: 'armed',
      result: 'armed',
      detail: `webContents=${webContents.id}${navigationId !== null ? ` navigation=${navigationId}` : ''}`,
    });
    return record;
  }

  /** Cancels the old generation and rebinds origin/artifact after an LS port change. */
  rebind(binding: AssetBinding): void {
    assertHttpsOrigin(binding.origin);
    this.#generation += 1;
    for (const record of this.#records.values()) {
      if (!RECORD_ACTIVE_STATES.has(record.state)) continue;
      this.#settle(record, 'cancelled', {
        code: 'GENERATION_SUPERSEDED',
        message: 'Superseded by a newer source generation',
      });
    }
    this.#binding = binding;
    this.#emit({
      level: 'info',
      stage: 'runtime.rebind',
      event: 'rebound',
      result: 'ok',
      detail: `origin=${binding.origin} generation=${this.#generation}`,
    });
  }

  /**
   * Removes the interception once every navigation is terminal and no own
   * delivery is still streaming. Refuses otherwise; never force-drops.
   */
  unhandle(): void {
    if (!this.#handled) return;
    if (this.pendingCount() > 0)
      throw new HostError('HOST_CONFLICT', 'Pending navigations must settle before unhandling');
    if (this.#inFlightDeliveries > 0)
      throw new HostError('HOST_CONFLICT', 'Own deliveries are still streaming; unhandle refused');
    this.#session.protocol.unhandle('https');
    this.#handled = false;
    this.#emit({ level: 'info', stage: 'runtime.attach', event: 'unhandled', result: 'ok' });
    this.#log('localization handler removed');
  }

  pendingCount(): number {
    let count = 0;
    for (const record of this.#records.values())
      if (RECORD_ACTIVE_STATES.has(record.state)) count += 1;
    return count;
  }

  release(webContents: Electron.WebContents): void {
    for (const record of this.recordsFor(webContents.id)) {
      if (RECORD_ACTIVE_STATES.has(record.state) || record.state === 'active')
        this.#settle(record, 'cancelled', {
          code: 'LOCALIZATION_DISABLED',
          message: 'Loading the original untranslated interface',
        });
    }
    const tracked = this.#tracked.get(webContents.id);
    for (const [channel, handler] of tracked?.listeners ?? [])
      webContents.removeListener(channel as never, handler as never);
    this.#tracked.delete(webContents.id);
    if (registry.get(webContents.id) === this) registry.delete(webContents.id);
  }

  status(): CoordinatorStatus {
    return {
      handled: this.#handled,
      generation: this.#generation,
      binding: {
        origin: this.#binding.origin,
        artifactId: this.#binding.artifactId,
        locale: this.#binding.locale,
      },
      records: [...this.#records.values()].map((record) => ({
        webContentsId: record.webContentsId,
        navigationId: record.navigationId,
        generation: record.generation,
        state: record.state,
        failure: record.failure,
      })),
    };
  }

  /** Coarse health state per plan §5.4; `active` means this load contract passed. */
  healthState(): 'ready' | 'armed' | 'served' | 'active' | 'degraded' {
    if (this.#degraded) return 'degraded';
    let state: 'ready' | 'armed' | 'active' = 'ready';
    for (const record of this.#records.values()) {
      if (this.#deadWebContents.has(record.webContentsId)) continue;
      if (record.state === 'active') {
        state = 'active';
        continue;
      }
      if (!RECORD_ACTIVE_STATES.has(record.state)) continue;
      if (record.state === 'served') return 'served';
      if (record.state === 'executed') state = 'armed';
      if (record.state === 'pending' && state === 'ready') state = 'armed';
    }
    return state;
  }

  dispose(): void {
    if (!this.#attached) return;
    for (const record of this.#records.values()) {
      if (RECORD_ACTIVE_STATES.has(record.state))
        this.#settle(record, 'cancelled', {
          code: 'COORDINATOR_DISPOSED',
          message: 'Coordinator disposed',
        });
    }
    this.#records.clear();
    if (this.#handled) {
      this.#session.protocol.unhandle('https');
      this.#handled = false;
    }
    if (this.#webRequestAttached) {
      const filter = { urls: ['https://*/*'] };
      this.#session.webRequest.onBeforeRequest(filter, null);
      this.#session.webRequest.onCompleted(filter, null);
      this.#session.webRequest.onErrorOccurred(filter, null);
      this.#webRequestAttached = false;
    }
    this.#forwardAbortTargets.clear();
    this.#pendingWebRequestIds.clear();
    for (const { webContents, listeners } of this.#tracked.values()) {
      for (const [channel, handler] of listeners)
        webContents.removeListener(channel as never, handler as never);
      if (registry.get(webContents.id) === this) registry.delete(webContents.id);
    }
    this.#tracked.clear();
    this.#attached = false;
    attachedCoordinators.delete(this);
    if (attachedCoordinators.size === 0 && confirmHandlerInstalled) {
      ipcMain.removeHandler(CONFIRM_CHANNEL);
      confirmHandlerInstalled = false;
    }
    this.#emit({ level: 'info', stage: 'runtime.lifecycle', event: 'disposed', result: 'ok' });
  }

  handleConfirmation(
    event: Electron.IpcMainInvokeEvent,
    payload: unknown,
  ): { ok: boolean; code?: string; artifactId?: string; locale?: string } {
    const frame = event.senderFrame;
    if (frame === null || frame.parent !== null || frame !== event.sender.mainFrame)
      return this.#rejectConfirmation(
        `non-current main-frame confirmation from webContents=${event.sender.id}`,
      );
    try {
      if (new URL(frame.url).origin !== this.#binding.origin)
        return this.#rejectConfirmation(
          `wrong-origin confirmation from webContents=${event.sender.id}`,
        );
    } catch {
      return this.#rejectConfirmation(
        `invalid-origin confirmation from webContents=${event.sender.id}`,
      );
    }
    if (typeof payload !== 'object' || payload === null)
      return this.#rejectConfirmation('confirmation payload is not an object');
    const { artifactId, locale } = payload as { artifactId?: unknown; locale?: unknown };
    if (typeof artifactId !== 'string' || typeof locale !== 'string')
      return this.#rejectConfirmation('confirmation payload is missing artifactId or locale');
    let confirmed: NavigationRecord | null = null;
    for (const record of this.recordsFor(event.sender.id)) {
      if (record.state !== 'served') continue;
      if (record.artifactId === artifactId && record.locale === locale) confirmed = record;
    }
    if (!confirmed)
      return this.#rejectConfirmation(
        `no served record matches artifactId=${artifactId} locale=${locale} webContents=${event.sender.id}`,
      );
    this.#clearTimer(confirmed);
    confirmed.state = 'executed';
    this.#emit({
      level: 'info',
      stage: 'runtime.confirm',
      event: 'accepted',
      result: 'accepted',
      detail: `webContents=${event.sender.id}`,
    });
    if (confirmed.pageLoaded) this.#activate(confirmed);
    return { ok: true, artifactId: confirmed.artifactId, locale: confirmed.locale };
  }

  async handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.origin !== this.#binding.origin ||
      request.method !== 'GET' ||
      url.search !== '' ||
      request.headers.get('range') !== null ||
      !this.#binding.routes.includes(url.pathname)
    )
      return this.#forward(request);
    const record = this.currentArmedRecord();
    if (!record) return this.#forward(request);
    let asset: ServedAsset | null = null;
    let resolveError: Error | null = null;
    try {
      asset = await this.#binding.resolve(url.pathname);
    } catch (error) {
      resolveError = error instanceof Error ? error : new Error(String(error));
    }
    // The read is asynchronous: the record may have been cancelled, failed or
    // superseded meanwhile, and a settled record must never be revived.
    if (!RECORD_ACTIVE_STATES.has(record.state) || record.generation !== this.#generation)
      return this.#forward(request);
    if (resolveError) {
      this.#settle(record, 'failed', {
        code: 'ARTIFACT_INVALID',
        message: `Managed asset ${url.pathname} could not be read or verified: ${resolveError.message}`,
      });
      return this.#forward(request);
    }
    if (!asset) {
      this.#settle(record, 'failed', {
        code: 'SOURCE_MISMATCH',
        message: `Managed asset missing for ${url.pathname}; request forwarded untranslated`,
      });
      return this.#forward(request);
    }
    this.#inFlightDeliveries += 1;
    if (record.state === 'pending') {
      record.state = 'served';
      this.#emit({
        level: 'info',
        stage: 'runtime.delivery',
        event: 'served',
        result: 'served',
        detail: `route=${url.pathname} webContents=${record.webContentsId}`,
      });
      record.confirmTimer = setTimeout(() => {
        if (record.state === 'served')
          this.#settle(record, 'failed', {
            code: 'ACTIVATION_TIMEOUT',
            message: `Bundle confirmation timed out after ${this.#confirmationTimeoutMs} ms`,
          });
      }, this.#confirmationTimeoutMs);
    }
    return new Response(this.#trackedBody(asset.body), {
      status: 200,
      headers: {
        'content-type': asset.contentType,
        'content-length': String(asset.body.byteLength),
        'cache-control': 'no-store',
      },
    });
  }

  recordsFor(webContentsId: number): NavigationRecord[] {
    return [...this.#records.values()].filter((record) => record.webContentsId === webContentsId);
  }

  currentArmedRecord(): NavigationRecord | null {
    for (const record of this.#records.values()) {
      if (record.generation === this.#generation && RECORD_ACTIVE_STATES.has(record.state))
        return record;
    }
    return null;
  }

  async #forward(request: Request): Promise<Response> {
    // net.request bound to the same session keeps the session's certificate
    // trust (the LS cert) and network context while supporting an explicit
    // abort: a cancelled page load must not leak an upstream stream (plan
    // §7.1, §12.3). Bodies stream through; nothing is read or buffered.
    this.#attachWebRequestHooks();
    const headers: Record<string, string | string[]> = {};
    request.headers.forEach((value, key) => {
      if (HOP_BY_HOP_HEADERS.has(key)) return;
      const existing = headers[key];
      if (existing === undefined) headers[key] = value;
      else if (Array.isArray(existing)) existing.push(value);
      else headers[key] = [existing, value];
    });
    const originId = this.#takeOriginRequestId(request.method, request.url);
    const client = net.request({
      method: request.method,
      url: request.url,
      session: this.#session,
      bypassCustomProtocolHandlers: true,
      redirect: 'follow',
      useSessionCookies: request.credentials !== 'omit',
      headers,
    });
    if (originId !== null) {
      this.#forwardAbortTargets.set(originId, () => {
        client.abort();
      });
    }
    const opened = new Promise<Response>((resolve, reject) => {
      client.on('response', (incoming) => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value === undefined) continue;
          for (const part of Array.isArray(value) ? value : [value])
            responseHeaders.append(key, part);
        }
        const source = Readable.toWeb(
          incoming as unknown as import('node:stream').Readable,
        ) as unknown as ReadableStream<Uint8Array>;
        const reader = source.getReader();
        const passThrough = new ReadableStream<Uint8Array>({
          pull: async (pullController) => {
            try {
              const { done, value } = await reader.read();
              if (done) pullController.close();
              else pullController.enqueue(value);
            } catch (error) {
              pullController.error(error);
            }
          },
          cancel: () => client.abort(),
        });
        resolve(
          new Response(passThrough, {
            status: incoming.statusCode ?? 200,
            statusText: incoming.statusMessage ?? '',
            headers: responseHeaders,
          }),
        );
      });
      client.on('error', (error) => reject(error));
    });
    if (request.body) {
      const upstreamBody = Readable.fromWeb(request.body as never);
      upstreamBody.on('error', () => client.abort());
      upstreamBody.pipe(client as never);
    } else {
      client.end();
    }
    return opened;
  }

  #attachWebRequestHooks(): void {
    if (this.#webRequestAttached) return;
    this.#webRequestAttached = true;
    const filter = { urls: ['https://*/*'] };
    this.#session.webRequest.onBeforeRequest(filter, (details, callback) => {
      // Only renderer-issued requests correlate to handler invocations; the
      // bypass upstream requests have no webContents and would poison the FIFO.
      if (details.webContentsId === undefined) {
        callback({});
        return;
      }
      const key = `${details.method} ${details.url}`;
      const queue = this.#pendingWebRequestIds.get(key) ?? [];
      queue.push({ id: details.id, seq: this.#webRequestSeq++ });
      // Bounded: served-own-asset requests leave entries behind.
      while (queue.length > FORWARD_QUEUE_LIMIT) queue.shift();
      this.#pendingWebRequestIds.set(key, queue);
      callback({});
    });
    const settle = (details: { id: number; url?: string; error?: string }) => {
      this.#removeQueuedRequestId(details.id);
      // The renderer-level request id is the abort-binding key. A completed
      // original only retires the binding; an aborted one tears the upstream
      // down with it, matching native cancel semantics (plan §12.3).
      const abort = this.#forwardAbortTargets.get(details.id);
      this.#forwardAbortTargets.delete(details.id);
      if (details.error !== 'net::ERR_ABORTED' || !abort) return;
      abort();
    };
    this.#session.webRequest.onCompleted(filter, settle);
    this.#session.webRequest.onErrorOccurred(filter, settle);
  }

  /**
   * Pairs an intercepted request with the webRequest id the renderer-level
   * request was assigned (FIFO per method+URL, restricted to ids registered
   * before this handler call so upstream bypass requests never match).
   */
  #takeOriginRequestId(method: string, url: string): number | null {
    const seqBefore = this.#webRequestSeq;
    const queue = this.#pendingWebRequestIds.get(`${method} ${url}`);
    while (queue && queue.length > 0) {
      const candidate = queue.shift();
      if (candidate && candidate.seq < seqBefore) return candidate.id;
    }
    return null;
  }

  #removeQueuedRequestId(id: number): void {
    for (const [key, queue] of this.#pendingWebRequestIds) {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        queue.splice(index, 1);
        if (queue.length === 0) this.#pendingWebRequestIds.delete(key);
      }
    }
  }

  /**
   * Streams the asset while observing consumption. The pull source is only
   * called when the network service consumed the previous chunk, so the
   * final pull proves the whole body was read; cancel proves an abort.
   * Either way the own delivery is finished and unhandle becomes possible.
   */
  #trackedBody(body: Uint8Array): ReadableStream<Uint8Array> {
    let offset = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.#inFlightDeliveries -= 1;
      this.#maybeUnhandle();
    };
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (offset >= body.byteLength) {
          finish();
          controller.close();
          return;
        }
        const end = Math.min(offset + DELIVERY_CHUNK_BYTES, body.byteLength);
        controller.enqueue(body.subarray(offset, end));
        offset = end;
      },
      cancel: () => finish(),
    });
  }

  #ensureHandled(): void {
    if (this.#handled) return;
    if (this.#session.protocol.isProtocolHandled('https'))
      throw new HostError(
        'PROTOCOL_IN_USE',
        'Another https interception appeared; refusing to re-arm',
      );
    this.#session.protocol.handle('https', (request) => this.handleRequest(request));
    this.#handled = true;
    this.#log('localization handler armed');
  }

  #activate(record: NavigationRecord): void {
    this.#degraded = false;
    record.state = 'active';
    record.settledAt = Date.now();
    this.#emit({
      level: 'info',
      stage: 'runtime.lifecycle',
      event: 'active',
      result: 'active',
      detail: `webContents=${record.webContentsId}`,
    });
    this.#log(`navigation active for webContents ${record.webContentsId}`);
    this.#maybeUnhandle();
  }

  #settle(
    record: NavigationRecord,
    state: 'failed' | 'cancelled',
    failure: { code: string; message: string },
  ): void {
    this.#clearTimer(record);
    record.state = state;
    record.failure = failure;
    record.settledAt = Date.now();
    if (state === 'failed') this.#degraded = true;
    this.#emit({
      level: state === 'failed' ? 'error' : 'warn',
      stage: 'runtime.lifecycle',
      event: state,
      result: state,
      code: failure.code,
      detail: `webContents=${record.webContentsId}: ${failure.message}`,
    });
    this.#log(`${state}: ${failure.code} ${failure.message}`);
    this.#maybeUnhandle();
    if (state === 'failed') this.#onFailure(record);
  }

  #clearTimer(record: NavigationRecord): void {
    if (record.confirmTimer) {
      clearTimeout(record.confirmTimer);
      record.confirmTimer = null;
    }
  }

  #maybeUnhandle(): void {
    if (!this.#handled) return;
    if (this.pendingCount() > 0 || this.#inFlightDeliveries > 0) return;
    this.#session.protocol.unhandle('https');
    this.#handled = false;
    this.#emit({ level: 'info', stage: 'runtime.attach', event: 'unhandled', result: 'ok' });
    this.#log('localization handler removed');
  }
}

export interface ManagedArtifactOptions {
  stateRoot: string;
  artifactId: string;
  files: Readonly<Record<string, string>>;
  readFile?: (filePath: string) => Promise<Buffer>;
}

/**
 * Resolves managed artifact files from the tool state root. Reads only
 * regular files whose content hash matches the manifest; refuses symlinks,
 * junctions and any path that escapes the artifact directory (plan §5.4).
 */
export function createManagedArtifactResolver(
  options: ManagedArtifactOptions,
): AssetBinding['resolve'] {
  const readFile = options.readFile ?? ((filePath: string) => fs.promises.readFile(filePath));
  const contentTypes: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  };
  return async (route: string) => {
    const expected = options.files[route];
    if (!expected) return null;
    const root = path.join(options.stateRoot, 'artifacts', options.artifactId);
    const file = path.join(root, path.basename(route));
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(file);
    } catch {
      return null;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return null;
    let realRoot: string;
    let realFile: string;
    try {
      realRoot = fs.realpathSync(root);
      realFile = fs.realpathSync(file);
    } catch {
      return null;
    }
    if (path.dirname(realFile) !== realRoot) return null;
    const body = await readFile(file);
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== expected)
      throw new HostError(
        'ARTIFACT_INVALID',
        `Artifact file ${route} does not match its manifest hash`,
      );
    return {
      body,
      contentType: contentTypes[path.extname(route)] ?? 'application/octet-stream',
    };
  };
}

const productionCoordinators = new Map<
  Electron.Session,
  { coordinator: SessionDeliveryCoordinator; origin: string }
>();
let startupAttempted = false;
let startupSnapshot: StartupSnapshot | null = null;
let startupFailure: unknown;
let runtimePersistence: RuntimePersistence | null = null;
let runtimeClosed = false;

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
  for (const { coordinator } of productionCoordinators.values()) coordinator.dispose();
  productionCoordinators.clear();
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
    if (snapshot.locale === 'en') return;
    const url = new URL(targetUrl);
    if (url.protocol !== 'https:' || url.hostname !== '127.0.0.1' || url.pathname !== '/')
      throw new HostError(
        'SOURCE_MISMATCH',
        `Unreviewed Hub navigation target: ${url.origin}${url.pathname}`,
      );
    const source = await webContents.session.fetch(`${url.origin}/main.js`, {
      bypassCustomProtocolHandlers: true,
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
    if (
      !source.ok ||
      createHash('sha256')
        .update(Buffer.from(await source.arrayBuffer()))
        .digest('hex') !== snapshot.sourceMainSha256
    )
      throw new HostError(
        'SOURCE_MISMATCH',
        'Live Hub main.js does not match the reviewed source hash',
      );
    const binding: AssetBinding = {
      origin: url.origin,
      artifactId: snapshot.artifactId,
      locale: snapshot.locale,
      routes: ['/main.js'],
      resolve: createManagedArtifactResolver({
        stateRoot: snapshot.stateRoot,
        artifactId: snapshot.artifactId,
        files: { '/main.js': snapshot.mainSha256 },
      }),
    };
    if (!(await binding.resolve('/main.js')))
      throw new HostError('ARTIFACT_INVALID', 'Managed localization artifact is missing');
    const persistence = runtimePersistence;
    let entry = productionCoordinators.get(webContents.session);
    if (!entry) {
      const coordinator = new SessionDeliveryCoordinator({
        session: webContents.session,
        binding,
        log: (message) => console.log(`[agyctl localization] ${message}`),
        logEvent: (event) => {
          persistence?.sink(event);
          if (event.stage.startsWith('runtime.'))
            persistence?.recordStatus({
              ...coordinator.status().binding,
              healthState: coordinator.healthState(),
            });
        },
        onFailure: (record) => {
          if (
            !['ACTIVATION_TIMEOUT', 'ARTIFACT_INVALID', 'SOURCE_MISMATCH'].includes(
              record.failure?.code ?? '',
            )
          )
            return;
          const tracked = electronWebContents.fromId(record.webContentsId);
          if (!tracked || tracked.isDestroyed()) return;
          coordinator.release(tracked);
          // The navigation already started, so the page is left exactly as it
          // is: no reload, no second navigation, no body splicing (plan §4.5).
          persistence?.recordStatus({
            ...coordinator.status().binding,
            healthState: coordinator.healthState(),
            terminal: record.failure,
          });
          console.error(
            '[agyctl localization] degraded; the running page is left untouched (no reload is triggered)',
            record.failure,
          );
        },
      });
      coordinator.attach();
      entry = { coordinator, origin: url.origin };
      productionCoordinators.set(webContents.session, entry);
    } else if (entry.origin !== url.origin) {
      entry.coordinator.rebind(binding);
      entry.origin = url.origin;
    }
    entry.coordinator.track(webContents);
    entry.coordinator.beginNavigation(webContents);
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
    productionCoordinators.get(webContents.session)?.coordinator.release(webContents);
    console.error(
      '[agyctl localization] preparation failed; loading original untranslated interface',
      error,
    );
  }
  await webContents.loadURL(targetUrl, options);
}
