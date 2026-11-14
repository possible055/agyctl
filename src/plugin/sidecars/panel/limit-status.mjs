import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { normalizeNativeLimitStatus } from '../../lib/limit-status-core.mjs';
import { readModels } from './feature-control.mjs';
import { readToolLocation } from './tool-location.mjs';

const execute = promisify(execFile);
/** @type {import('../../lib/limit-status-core.mjs').LimitStatus | undefined} */
let cached;
/** @type {Promise<import('../../lib/limit-status-core.mjs').LimitStatus> | null} */
let inFlight;

/** @returns {Promise<import('../../lib/limit-status-core.mjs').LimitStatus>} */
async function readSnapshot() {
  try {
    const { root, executable, env } = await readToolLocation();
    const { stdout } = await execute(executable, ['--root', root, 'limit', 'status', '--json'], {
      cwd: root,
      env,
      shell: false,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 256 * 1024,
    });
    const raw = JSON.parse(stdout);
    if (raw.error) throw new Error(String(raw.error));
    const snapshot = normalizeNativeLimitStatus(raw, new Date().toISOString());
    if (snapshot.status === 'available' && snapshot.patchKind === 'patched') {
      try {
        const catalog = await readModels();
        const entries = catalog.models.filter((model) => model.id !== null);
        const duplicated = new Set(
          entries
            .filter((model) =>
              entries.some(
                (other) =>
                  other !== model &&
                  (other.baseName ?? other.name) === (model.baseName ?? model.name) &&
                  (other.effort ?? null) === (model.effort ?? null),
              ),
            )
            .map((model) => model.id),
        );
        snapshot.modelNames = Object.fromEntries(
          entries.map((model) => [
            String(model.id),
            duplicated.has(model.id)
              ? `${model.baseName ?? model.name} (${model.alias})`
              : (model.baseName ?? model.name),
          ]),
        );
        snapshot.modelEfforts = Object.fromEntries(
          entries.flatMap((model) => (model.effort ? [[String(model.id), model.effort]] : [])),
        );
      } catch (error) {
        console.error('[agyctl] Model names:', error.message);
      }
    }
    return snapshot;
  } catch (error) {
    return { status: 'unavailable', snapshotAt: new Date().toISOString(), error: error.message };
  }
}

export function readLimitStatus() {
  if (inFlight) return inFlight;
  if (cached && Date.now() - Date.parse(cached.snapshotAt) < 60000) return Promise.resolve(cached);
  inFlight = readSnapshot()
    .then((snapshot) => {
      cached = snapshot;
      return snapshot;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
