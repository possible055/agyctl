import { execFile } from 'node:child_process';
import path from 'node:path';
import { readToolLocation } from './tool-location.mjs';

async function request(action, payload) {
  const { root, env } = await readToolLocation();
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [path.join(root, 'scripts', 'feature-control-worker.mjs'), action],
      { cwd: root, env, shell: false, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        try {
          const result = JSON.parse(stdout);
          if (error || result.error) {
            const failure = new Error(result.error ?? 'Feature control is unavailable');
            failure.code = result.code ?? 'FEATURE_UNAVAILABLE';
            reject(failure);
          } else resolve(result);
        } catch {
          reject(
            new Error('Feature control is unavailable; rebuild the tools and reinstall the panel'),
          );
        }
      },
    );
    child.stdin.on('error', reject);
    child.stdin.end(payload === undefined ? '' : JSON.stringify(payload));
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
