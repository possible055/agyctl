import { inspectEmbeddedWebAssets } from '../localization/build/assets.js';

// Same bounds as the localization profiles apply to the embedded web archive.
const WEB_ASSET_LIMITS = { maxEntryBytes: 26_214_400, maxEntries: 4096, maxTotalBytes: 536_870_912 };

/**
 * Reads the JavaScript members of the web bundle embedded in a Language Server
 * binary. Bounded and read-only: the binary is parsed, never executed.
 */
export function readServedScripts(languageServerPath: string): Record<string, string> {
  const assets = inspectEmbeddedWebAssets(languageServerPath, {
    profiles: [],
    limits: WEB_ASSET_LIMITS,
    assetNames: ['main.js'],
  });
  return Object.fromEntries(
    Object.entries(assets)
      .filter(([name]) => name.endsWith('.js'))
      .map(([name, asset]) => [name, asset.text]),
  );
}
