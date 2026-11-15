import { spawn } from 'node:child_process';
import path from 'node:path';
import { readToolLocation } from './tool-location.mjs';

const REQUEST_TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

let toolLocationPromise = null;
function toolLocation() {
  // The locator only changes on a plugin reinstall, which restarts this
  // sidecar; reading it once per process is sufficient.
  if (!toolLocationPromise) toolLocationPromise = readToolLocation();
  return toolLocationPromise;
}

/** @type {{ child: import('node:child_process').ChildProcess } | null} */
let worker = null;
/** @type {Promise<unknown> | null} */
let starting = null;
let nextId = 1;
/** @type {Map<string, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
const pending = new Map();

function unavailable(message) {
  return Object.assign(
    new Error(
      message ?? 'Feature control is unavailable; rebuild the tools and reinstall the panel',
    ),
    { code: 'FEATURE_UNAVAILABLE' },
  );
}

function discardWorker() {
  const handle = worker;
  worker = null;
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(unavailable());
  }
  pending.clear();
  if (handle) handle.child.kill();
}

function startWorker() {
  return toolLocation().then(
    ({ root, env }) =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [path.join(root, 'scripts', 'feature-control-worker.mjs')],
          { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
        );
        const handle = { child };
        let buffer = '';
        // The worker must not keep a short-lived importer alive (scripts that
        // only read one status): it exits on its own once stdin closes, which
        // happens when this process exits.
        child.unref();
        child.stdin.unref();
        child.stdout.unref();
        child.stderr.unref();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          buffer += chunk;
          for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (!line.trim()) continue;
            if (Buffer.byteLength(line) > MAX_RESPONSE_BYTES) {
              discardWorker();
              return;
            }
            let message;
            try {
              message = JSON.parse(line);
            } catch {
              discardWorker();
              return;
            }
            const id = String(message.id);
            const entry = pending.get(id);
            if (!entry) continue;
            pending.delete(id);
            clearTimeout(entry.timer);
            if (message.ok) entry.resolve(message.result);
            else
              entry.reject(
                Object.assign(new Error(message.error ?? 'Feature control is unavailable'), {
                  code: message.code ?? 'FEATURE_UNAVAILABLE',
                }),
              );
          }
        });
        child.on('error', (error) => {
          if (worker === handle) discardWorker();
          reject(error);
        });
        child.on('close', () => {
          if (worker === handle) discardWorker();
        });
        worker = handle;
        resolve(handle);
      }),
  );
}

process.on('exit', () => {
  // The worker watches stdin and exits on its own; this only reaps it when the
  // sidecar dies outright, so no plugin thread lingers behind the panel.
  if (worker) worker.child.kill();
});

async function request(action, payload) {
  if (!worker) {
    if (!starting) starting = startWorker().finally(() => (starting = null));
    try {
      await starting;
    } catch (error) {
      throw unavailable(error.message);
    }
  }
  const id = String(nextId++);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        discardWorker();
        reject(unavailable('Feature control is unavailable; the request timed out'));
      }
    }, REQUEST_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      worker.child.stdin.write(
        `${JSON.stringify({ id, action, ...(payload === undefined ? {} : { payload }) })}\n`,
      );
    } catch {
      pending.delete(id);
      clearTimeout(timer);
      discardWorker();
      reject(unavailable());
    }
  });
}

function cachedAction(action, ttlMs) {
  /** @type {{ at: number, value: any } | null} */
  let cache = null;
  /** @type {Promise<any> | null} */
  let inFlight = null;
  return ({ fresh = false } = {}) => {
    if (!fresh && cache && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.value);
    if (inFlight) return inFlight;
    inFlight = request(action)
      .then((value) => {
        cache = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
}

export const readFeatures = cachedAction('status', 15000);
export const readModels = cachedAction('models', 120000);

export function queueFeatureApply(payload) {
  return request('queue', payload);
}

export function cancelFeatureApply(payload) {
  return request('cancel', payload);
}
