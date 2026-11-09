import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function verifyLocalizationBuild() {
  const rebuild = 'Run `npm run localization:build` before using the localization tools';
  const manifestPath = path.join(root, 'dist', 'localization', 'bundle', 'build-manifest.json');
  if (!fs.existsSync(manifestPath))
    throw new Error(`The localization build manifest is missing. ${rebuild}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.inputs || !manifest.outputs)
    throw new Error(`The localization build manifest is invalid. ${rebuild}`);
  for (const [relative, expected] of Object.entries({ ...manifest.inputs, ...manifest.outputs })) {
    const file = path.resolve(root, relative);
    if (
      !file.startsWith(`${root}${path.sep}`) ||
      !fs.existsSync(file) ||
      createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected
    )
      throw new Error(`The localization build is stale or incomplete (${relative}). ${rebuild}`);
  }
  return manifest;
}
