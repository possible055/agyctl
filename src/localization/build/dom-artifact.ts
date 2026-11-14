import fs from 'node:fs';
import {
  DOM_ARTIFACT_SCHEMA_VERSION,
  DOM_ENGINE_VERSION,
  SCOPES_VERSION,
} from '../runtime/contract.js';
import { BuildError } from './assets.js';
import { buildDomIndex, isDomIndexMessage, type DomIndex, type DomIndexConflict } from './dom-index.js';
import {
  buildNativeJson,
  sha256Text,
  stableStringify,
  validateSourceCatalog,
  validateTranslations,
  type LocaleTranslations,
  type SourceCatalog,
} from './transform.js';

export interface DomManifest {
  schemaVersion: 2;
  format: 'dom';
  artifactId: string;
  profileId: string;
  locale: string;
  formatLocale: string;
  engineVersion: number;
  engineSha256: string;
  scopesVersion: number;
  indexSha256: string;
  catalogSha256: string;
  adapterVersion: string;
  toolchainSha256: string;
  nativeCatalogSha256: string | null;
  sourceIdentity?: string;
  sourceBinarySha256?: string | null;
  sourceMainSha256?: string;
}

export interface DomArtifactInputs {
  profileId: string;
  adapterVersion: string;
  toolchainSha256: string;
  locale: string;
  formatLocale: string;
  catalog: SourceCatalog;
  translations: LocaleTranslations;
  engineSource: string;
  sourceIdentity?: string;
  sourceBinarySha256?: string | null;
  sourceMainSha256?: string;
}

export interface BuiltDomArtifact {
  manifest: DomManifest;
  index: DomIndex;
  indexJson: string;
  nativeJson: string | null;
  conflicts: DomIndexConflict[];
}

export function readDomEngineSource(enginePath: string): { source: string; sha256: string } {
  let source: string;
  try {
    source = fs.readFileSync(enginePath, 'utf8');
  } catch (error) {
    throw new BuildError(
      'CAPABILITY_GAP',
      `DOM engine bundle is missing at ${enginePath}; run npm run localization:build`,
      { cause: error },
    );
  }
  if (!source.includes('__AGYCTL_DOM_ENGINE__') || !source.includes('createDomEngine'))
    throw new BuildError('CAPABILITY_GAP', `DOM engine bundle at ${enginePath} is not a localization engine`);
  return { source, sha256: sha256Text(source) };
}

export function buildDomArtifact(inputs: DomArtifactInputs): BuiltDomArtifact {
  if (inputs.locale === 'en')
    throw new BuildError('CATALOG_INVALID', 'English is an explicit disable; do not prepare a DOM artifact for en');
  validateSourceCatalog(inputs.catalog);
  validateTranslations(inputs.catalog, inputs.translations);
  if (inputs.locale !== inputs.translations.locale)
    throw new BuildError('CATALOG_INVALID', 'DOM artifact locale does not match the translation locale');
  for (const message of Object.values(inputs.catalog.messages)) {
    if (!isDomIndexMessage(message) && !message.native && !message.surface.startsWith('native.')) continue;
    if (!inputs.translations.messages[message.messageId])
      throw new BuildError('CATALOG_INVALID', `DOM/native message ${message.messageId} has no translation`);
  }
  const { index, conflicts } = buildDomIndex(inputs.catalog, inputs.translations);
  if (conflicts.length > 0)
    throw new BuildError(
      'CATALOG_INVALID',
      `Unresolved same-English conflicts: ${conflicts
        .map((row) => `${JSON.stringify(row.source)} (${row.messageIds.join(', ')})`)
        .join('; ')}`,
    );
  const engineSha256 = sha256Text(inputs.engineSource);
  const indexJson = `${stableStringify(index)}\n`;
  const native = buildNativeJson(inputs.catalog, inputs.translations);
  const nativeJson = native === null ? null : `${stableStringify(native)}\n`;
  const nativeSha = nativeJson === null ? null : sha256Text(nativeJson);
  const catalogSha256 = sha256Text(
    stableStringify({ source: inputs.catalog, translations: inputs.translations }),
  );
  const artifactId = sha256Text(
    stableStringify({
      schemaVersion: DOM_ARTIFACT_SCHEMA_VERSION,
      format: 'dom',
      profileId: inputs.profileId,
      adapterVersion: inputs.adapterVersion,
      toolchainSha256: inputs.toolchainSha256,
      locale: inputs.locale,
      formatLocale: inputs.formatLocale,
      engineVersion: DOM_ENGINE_VERSION,
      engineSha256,
      scopesVersion: SCOPES_VERSION,
      indexSha256: sha256Text(indexJson),
      catalogSha256,
      ...(nativeSha !== null ? { nativeCatalogSha256: nativeSha } : {}),
      ...(inputs.sourceIdentity !== undefined ? { sourceIdentity: inputs.sourceIdentity } : {}),
      ...(inputs.sourceBinarySha256 !== undefined
        ? { sourceBinarySha256: inputs.sourceBinarySha256 }
        : {}),
      ...(inputs.sourceMainSha256 !== undefined ? { sourceMainSha256: inputs.sourceMainSha256 } : {}),
    }),
  );
  const manifest: DomManifest = {
    schemaVersion: 2,
    format: 'dom',
    artifactId,
    profileId: inputs.profileId,
    locale: inputs.locale,
    formatLocale: inputs.formatLocale,
    engineVersion: DOM_ENGINE_VERSION,
    engineSha256,
    scopesVersion: SCOPES_VERSION,
    indexSha256: sha256Text(indexJson),
    catalogSha256,
    adapterVersion: inputs.adapterVersion,
    toolchainSha256: inputs.toolchainSha256,
    nativeCatalogSha256: nativeSha,
    ...(inputs.sourceIdentity !== undefined ? { sourceIdentity: inputs.sourceIdentity } : {}),
    ...(inputs.sourceBinarySha256 !== undefined
      ? { sourceBinarySha256: inputs.sourceBinarySha256 }
      : {}),
    ...(inputs.sourceMainSha256 !== undefined ? { sourceMainSha256: inputs.sourceMainSha256 } : {}),
  };
  return { manifest, index, indexJson, nativeJson, conflicts };
}
