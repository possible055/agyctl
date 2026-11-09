import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decodeManifest, decodeNativeCatalog, type NativeCatalog } from '../artifact.js';
import { formatMessage } from './messages.js';

let catalog: NativeCatalog | null = null;

/**
 * Loads and verifies the native catalog of the startup artifact. Called once
 * per process when the delivery binding is armed; failures keep the catalog
 * unloaded so every helper degrades to the original text.
 */
export function initNativeMessages(options: {
  stateRoot: string;
  artifactId: string;
  locale: string;
}): { ok: true } | { ok: false; code: 'NATIVE_CATALOG_INVALID'; message: string } {
  catalog = null;
  try {
    const artifactDir = path.join(options.stateRoot, 'artifacts', options.artifactId);
    const manifest = decodeManifest(
      JSON.parse(fs.readFileSync(path.join(artifactDir, 'manifest.json'), 'utf8')),
    );
    if (manifest.artifactId !== options.artifactId || manifest.locale !== options.locale)
      throw new Error('Native manifest does not match the startup artifact and locale');
    if (
      typeof manifest.nativeCatalogSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(manifest.nativeCatalogSha256)
    )
      throw new Error('Native catalog hash is missing or invalid');
    const body = fs.readFileSync(path.join(artifactDir, 'native.json'));
    if (createHash('sha256').update(body).digest('hex') !== manifest.nativeCatalogSha256)
      throw new Error('Native catalog does not match its manifest hash');
    const parsed = decodeNativeCatalog(JSON.parse(body.toString('utf8')), options.locale);
    catalog = parsed;
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[agyctl localization] NATIVE_CATALOG_INVALID: ${message}; native interface uses original text`,
    );
    return { ok: false, code: 'NATIVE_CATALOG_INVALID', message };
  }
}

export function nativeCatalogLocale(): string | null {
  return catalog?.locale ?? null;
}

/** Returns the reviewed native text, or the original when not translated. */
export function nativeText(messageId: string, original: string): string {
  const value = catalog?.messages[messageId];
  return typeof value === 'string' && value ? value : original;
}

/** Formats positional display values without reparsing inserted text. */
export function nativeFormat(messageId: string, original: string, values: unknown[]): string {
  const ast = catalog?.compiledMessages?.[messageId];
  if (ast && catalog) {
    try {
      return String(
        formatMessage(
          messageId,
          ast,
          catalog.locale,
          Object.fromEntries(values.map((value, index) => [String(index), value])),
        ),
      );
    } catch {
      console.error(`[agyctl localization] NATIVE_FORMAT_FAILED: ${messageId}; using original text`);
      return original.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
        Number(index) < values.length ? String(values[Number(index)]) : placeholder,
      );
    }
  }
  return nativeText(messageId, original).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const position = Number(index);
    return position < values.length ? String(values[position]) : placeholder;
  });
}

/** Formats the reviewed tray count; legacy artifacts retain positional variants. */
export function nativeAgentsRunning(count: number): string {
  const original =
    count === 0 ? 'No agents running' : `${count} agent${count === 1 ? '' : 's'} running`;
  if (catalog?.compiledMessages?.['tray.agentsRunning'])
    return nativeFormat('tray.agentsRunning', original, [count]);
  const category = count === 0 ? 'zero' : count === 1 ? 'one' : 'other';
  const key = `tray.agentsRunning.${category}`;
  const pattern = catalog?.messages[key] ?? original;
  return pattern.replace('{0}', String(count));
}

/** Test/teardown hook: drops the loaded catalog. */
export function resetNativeMessages(): void {
  catalog = null;
}
