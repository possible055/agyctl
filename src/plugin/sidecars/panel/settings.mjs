import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDir() {
  return (
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'sidecar_data', 'agyctl', 'panel', 'data')
  );
}

/** @param {string} filename */
export function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} filename @param {unknown} value */
export function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

/** @param {Record<string, unknown>} value @returns {import("./contracts.js").Settings} */
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid settings');
  for (const key of Object.keys(value)) {
    if (key !== 'pollIntervalSeconds') throw new Error(`Unknown setting: ${key}`);
  }
  if (
    typeof value.pollIntervalSeconds !== 'number' ||
    !Number.isInteger(value.pollIntervalSeconds) ||
    value.pollIntervalSeconds < 10 ||
    value.pollIntervalSeconds > 300
  ) {
    throw new Error('Refresh interval must be between 10 and 300 seconds');
  }
  return { pollIntervalSeconds: value.pollIntervalSeconds };
}

export function readSettings() {
  const saved = readJson(path.join(dataDir(), 'settings.json'));
  if (!saved) return { pollIntervalSeconds: 10 };
  if (saved.schema !== 3) throw new Error('Unsupported settings schema');
  // Earlier builds also stored client-modification preferences here; only the interval remains.
  return validateSettings({ pollIntervalSeconds: saved.settings?.pollIntervalSeconds });
}

/** @param {import("./contracts.js").Settings} value */
export function saveSettings(value) {
  const settings = validateSettings({ ...value });
  writeJson(path.join(dataDir(), 'settings.json'), { schema: 3, settings });
  return settings;
}
