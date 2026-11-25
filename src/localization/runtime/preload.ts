// Hub preload bridge: restricted bootstrap that injects the Host-authorized
// DOM engine into the current main frame and listens for Host-pushed locale
// switches. Sandboxed-preload safe: only ipcRenderer/webFrame, no Node builtins,
// no generic channels, no management surface (plan §7.4).
import { ipcRenderer, webFrame } from 'electron';

const BOOTSTRAP_CHANNEL = 'agyctl:localization:bootstrap';
const BOOTSTRAP_RESULT_CHANNEL = 'agyctl:localization:bootstrap-result';
const SYNC_CHANNEL = 'agyctl:localization:sync';

let documentActive = true;
let bootstrapComplete = false;
let bootstrapRetries = 0;

function reportBootstrap(result: { ok: boolean; code?: string; stats?: unknown }): void {
  if (!documentActive) return;
  void ipcRenderer.invoke(BOOTSTRAP_RESULT_CHANNEL, result).catch(() => {});
}

async function applyDomPayload(record: Record<string, unknown>): Promise<void> {
  if (!documentActive) return;
  if (record.ok === false) {
    if (record.code === 'DISABLED') {
      await webFrame
        .executeJavaScript(
          `;(() => {
          const previous = globalThis.__agyctlDomEngine__;
          if (previous && typeof previous.dispose === 'function') previous.dispose();
          globalThis.__agyctlDomEngine__ = undefined;
          return { ok: true, code: 'DISABLED' };
        })()`,
          true,
        )
        .catch(() => {});
    }
    return;
  }
  if (typeof record.engine !== 'string' || typeof record.locale !== 'string' || !record.index)
    return;
  const starter = `;(() => {
    const factory = globalThis.__AGYCTL_DOM_ENGINE__;
    if (!factory || typeof factory.createDomEngine !== 'function') {
      return { ok: false, code: 'ENGINE_MISSING' };
    }
    const previous = globalThis.__agyctlDomEngine__;
    if (previous && typeof previous.dispose === 'function') previous.dispose();
    const engine = factory.createDomEngine({
      document,
      index: ${JSON.stringify(record.index)},
      locale: ${JSON.stringify(record.locale)},
    });
    globalThis.__agyctlDomEngine__ = engine;
    const started = engine.start();
    return { ok: started.ok, code: started.code, stats: started.stats };
  })()`;
  const result = await webFrame.executeJavaScript(`${record.engine}${starter}`, true);
  if (!result || !documentActive) return;
  const started =
    result && typeof result === 'object'
      ? (result as { ok: boolean; code?: string; stats?: unknown })
      : { ok: false, code: 'BOOTSTRAP_RESULT_INVALID' };
  reportBootstrap(started);
  if (!started.ok || started.code !== 'NO_WRITABLE_ROOT') return;
  const ready = await webFrame.executeJavaScript(
    `;(() => {
    const engine = globalThis.__agyctlDomEngine__;
    if (!engine || typeof engine.whenWritable !== 'function')
      return { ok: false, code: 'ENGINE_MISSING' };
    return engine.whenWritable().then(() => {
      if (globalThis.__agyctlDomEngine__ !== engine)
        return { ok: false, code: 'DISPOSED' };
      return engine.whenWritable();
    });
  })()`,
    true,
  );
  if (ready && typeof ready === 'object' && documentActive)
    reportBootstrap(ready as { ok: boolean; code?: string; stats?: unknown });
}

const onSync = (_event: unknown, payload: unknown) => {
  if (!documentActive || !payload || typeof payload !== 'object') return;
  bootstrapComplete = true;
  void applyDomPayload(payload as Record<string, unknown>).catch(() => {
    reportBootstrap({ ok: false, code: 'BOOTSTRAP_FAILED' });
  });
};

ipcRenderer.on(SYNC_CHANNEL, onSync);

window.addEventListener(
  'pagehide',
  () => {
    documentActive = false;
    ipcRenderer.removeListener(SYNC_CHANNEL, onSync);
  },
  { once: true },
);

function requestBootstrap(): Promise<void> {
  if (bootstrapComplete) return Promise.resolve();
  return ipcRenderer
    .invoke(BOOTSTRAP_CHANNEL)
    .then((payload: unknown) => {
      if (!payload || typeof payload !== 'object') return;
      const record = payload as Record<string, unknown>;
      if (record.ok === false) {
        if (record.code === 'DISABLED' || record.code === 'AST_DELIVERY') {
          bootstrapComplete = true;
          return;
        }
        if (record.code === 'DOCUMENT_NOT_READY' && bootstrapRetries < 40) {
          bootstrapRetries += 1;
          setTimeout(() => {
            void requestBootstrap();
          }, 50);
          return;
        }
        bootstrapComplete = true;
        reportBootstrap({
          ok: false,
          code: typeof record.code === 'string' ? record.code : 'UNAUTHORIZED',
        });
        return;
      }
      if (typeof record.engine !== 'string' || typeof record.locale !== 'string' || !record.index)
        return;
      bootstrapComplete = true;
      return applyDomPayload(record);
    })
    .catch(() => {
      reportBootstrap({ ok: false, code: 'BOOTSTRAP_FAILED' });
    });
}

void requestBootstrap();
