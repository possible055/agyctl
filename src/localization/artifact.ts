import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Coverage, Manifest } from './build/transform.js';
import type { MessageFormatElement } from '@formatjs/icu-messageformat-parser';

const HASH = /^[a-f0-9]{64}$/;
const LOCALES = new Set(['en', 'zh-Hant-TW', 'zh-Hans-CN', 'ja-JP']);

export class ArtifactError extends Error {
  readonly code = 'ARTIFACT_INVALID';
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ArtifactError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new ArtifactError(`${name} must be a nonempty string`);
  return value;
}

function hash(value: unknown, name: string): string {
  const result = string(value, name);
  if (!HASH.test(result)) throw new ArtifactError(`${name} must be a SHA-256 digest`);
  return result;
}

export function decodeManifest(value: unknown): Manifest {
  const raw = object(value, 'manifest');
  if (raw.schemaVersion !== 1) throw new ArtifactError('Unsupported artifact manifest schema');
  const locale = string(raw.locale, 'locale');
  if (!LOCALES.has(locale)) throw new ArtifactError(`Unsupported artifact locale: ${locale}`);
  if (!Array.isArray(raw.assets) || raw.assets.length === 0) throw new ArtifactError('Artifact has no assets');
  const routes = new Set<string>();
  const files = new Set<string>();
  const assets = raw.assets.map((value) => {
    const entry = object(value, 'asset');
    const file = string(entry.file, 'asset.file');
    const route = string(entry.route, 'asset.route');
    if (!/^[\w.-]+\.js$/.test(file) || route !== `/${file}` || files.has(file) || routes.has(route))
      throw new ArtifactError(`Invalid or duplicate artifact asset: ${file}`);
    files.add(file);
    routes.add(route);
    return { file, route, sha256: hash(entry.sha256, 'asset.sha256') };
  });
  if (!files.has('main.js')) throw new ArtifactError('Artifact has no main.js entry');
  return {
    schemaVersion: 1,
    artifactId: hash(raw.artifactId, 'artifactId'),
    profileId: string(raw.profileId, 'profileId'),
    locale,
    formatLocale: string(raw.formatLocale, 'formatLocale'),
    sourceMainSha256: hash(raw.sourceMainSha256, 'sourceMainSha256'),
    ...(raw.sourceBinarySha256 === undefined ? {} : { sourceBinarySha256: raw.sourceBinarySha256 === null ? null : hash(raw.sourceBinarySha256, 'sourceBinarySha256') }),
    ...(raw.sourceIdentity === undefined ? {} : { sourceIdentity: hash(raw.sourceIdentity, 'sourceIdentity') }),
    catalogSha256: hash(raw.catalogSha256, 'catalogSha256'),
    adapterVersion: string(raw.adapterVersion, 'adapterVersion'),
    toolchainSha256: hash(raw.toolchainSha256, 'toolchainSha256'),
    assets,
    nativeCatalogSha256: raw.nativeCatalogSha256 === null ? null : hash(raw.nativeCatalogSha256, 'nativeCatalogSha256'),
    coverageSha256: hash(raw.coverageSha256, 'coverageSha256'),
    ...(raw.inventorySha256 === undefined ? {} : { inventorySha256: hash(raw.inventorySha256, 'inventorySha256') }),
    ...(raw.rulesSha256 === undefined ? {} : { rulesSha256: hash(raw.rulesSha256, 'rulesSha256') }),
  };
}

export interface NativeCatalog {
  schemaVersion: 1;
  locale: string;
  messages: Record<string, string>;
  compiledMessages?: Record<string, MessageFormatElement[]>;
}

export function decodeNativeCatalog(value: unknown, locale: string): NativeCatalog {
  const raw = object(value, 'native catalog');
  if (raw.schemaVersion !== 1 || raw.locale !== locale) throw new ArtifactError('Native catalog schema or locale mismatch');
  const messages: Record<string, string> = Object.create(null);
  for (const [id, value] of Object.entries(object(raw.messages, 'native messages'))) messages[id] = string(value, `native message ${id}`);
  const compiledMessages: Record<string, MessageFormatElement[]> = Object.create(null);
  if (raw.compiledMessages !== undefined) {
    for (const [id, ast] of Object.entries(object(raw.compiledMessages, 'native compiled messages'))) {
      if (!Object.hasOwn(messages, id) || !Array.isArray(ast)) throw new ArtifactError(`Invalid native compiled message ${id}`);
      const validateElements = (elements: unknown[]): void => {
        for (const value of elements) {
          const element = object(value, 'ICU element');
          if (!Number.isInteger(element.type) || Number(element.type) < 0 || Number(element.type) > 8) throw new ArtifactError('Invalid precompiled ICU element');
          if (element.type !== 7) string(element.value, 'ICU element.value');
          if ([5, 6].includes(Number(element.type))) {
            for (const option of Object.values(object(element.options, 'ICU options'))) {
              const children = object(option, 'ICU option').value;
              if (!Array.isArray(children)) throw new ArtifactError('Invalid ICU option body');
              validateElements(children);
            }
          }
          if (element.type === 8) {
            if (!Array.isArray(element.children)) throw new ArtifactError('Invalid ICU tag children');
            validateElements(element.children);
          }
        }
      };
      validateElements(ast);
      compiledMessages[id] = ast as MessageFormatElement[];
    }
  }
  return { schemaVersion: 1, locale, messages, ...(raw.compiledMessages === undefined ? {} : { compiledMessages }) };
}

export function decodeCoverage(value: unknown, manifest: Manifest): Coverage {
  const raw = object(value, 'coverage');
  if (![2, 3].includes(Number(raw.schemaVersion)) || raw.profileId !== manifest.profileId || raw.locale !== manifest.locale || typeof raw.probe !== 'boolean')
    throw new ArtifactError('Coverage schema, profile, locale or probe mismatch');
  if (!Array.isArray(raw.hits) || !Array.isArray(raw.messages) || !Array.isArray(raw.excluded)) throw new ArtifactError('Coverage lists are missing');
  const seen = new Set<string>();
  let replacements = 0;
  let replacedMessages = 0;
  for (const value of raw.hits) {
    const hit = object(value, 'coverage hit');
    const id = string(hit.messageId, 'hit.messageId');
    if (seen.has(id) || !Number.isSafeInteger(hit.hits) || Number(hit.hits) < 0) throw new ArtifactError('Duplicate or invalid coverage hit');
    seen.add(id);
    replacements += Number(hit.hits);
    if (Number(hit.hits) > 0) replacedMessages += 1;
  }
  if (raw.totalReplacements !== replacements || raw.replacedMessages !== replacedMessages) throw new ArtifactError('Coverage replacement totals are inconsistent');
  const ids = new Set<string>();
  for (const value of raw.messages) {
    const message = object(value, 'coverage message');
    const id = string(message.messageId, 'coverage.messageId');
    if (ids.has(id) || !['translated', 'unapplied', 'untranslated', 'probe'].includes(String(message.status)) || typeof message.critical !== 'boolean')
      throw new ArtifactError('Invalid coverage message');
    ids.add(id);
    string(message.surface, 'message.surface');
    if (message.status === 'translated' && !raw.hits.some((row) => object(row, 'hit').messageId === id && Number(object(row, 'hit').hits) > 0))
      throw new ArtifactError(`Translated message ${id} has no replacement evidence`);
  }
  for (const id of seen) if (!ids.has(id)) throw new ArtifactError(`Coverage hit ${id} has no message`);
  for (const excluded of raw.excluded) string(excluded, 'excluded reason');
  return raw as unknown as Coverage;
}

/** Verifies every manifest-owned file before an artifact is selected or delivered. */
export function readValidatedArtifact(directory: string, expected: { artifactId?: string; locale?: string } = {}) {
  const delivery = readArtifactDelivery(directory, expected);
  const { manifest, assets, nativeCatalog } = delivery;
  if ((expected.artifactId && manifest.artifactId !== expected.artifactId) || (expected.locale && manifest.locale !== expected.locale))
    throw new ArtifactError('Artifact identity or locale does not match the approved selection');
  const read = (file: string, expectedHash: string): Buffer => readHashedFile(directory, file, expectedHash);
  const coverage = decodeCoverage(JSON.parse(read('coverage.json', manifest.coverageSha256).toString('utf8')), manifest);
  if (manifest.inventorySha256) {
    const inventory = object(JSON.parse(read('inventory.json', manifest.inventorySha256).toString('utf8')), 'inventory');
    if (inventory.schemaVersion !== 2 || !Array.isArray(inventory.usagePoints) || !Array.isArray(coverage.usagePoints) || coverage.inventorySha256 !== manifest.inventorySha256)
      throw new ArtifactError('Inventory evidence is missing or incompatible');
    const points = new Map(inventory.usagePoints.map((point) => {
      const entry = object(point, 'inventory usage point');
      return [string(entry.usageId, 'usageId'), entry];
    }));
    if (points.size !== inventory.usagePoints.length || coverage.usagePoints.length !== points.size) throw new ArtifactError('Coverage does not enumerate the complete inventory');
    const covered = new Set<string>();
    const translatedEdits = new Map<string, Set<string>>();
    const approvedEdits = new Map<string, string>();
    if (!manifest.rulesSha256) throw new ArtifactError('Usage-point artifact has no reviewed rule digest');
    const rules = JSON.parse(read('rules.json', manifest.rulesSha256).toString('utf8'));
    if (!Array.isArray(rules)) throw new ArtifactError('Reviewed rules must be an array');
    const expectedHits = new Map<string, number>();
    for (const value of rules) {
      const rule = object(value, 'reviewed rule');
      const id = string(rule.messageId, 'rule.messageId');
      if (!Number.isSafeInteger(rule.expectedHits) || Number(rule.expectedHits) < 0 || rule.file !== inventory.file) throw new ArtifactError('Invalid reviewed rule contract');
      if (rule.sourceSha256 !== undefined && rule.sourceSha256 !== inventory.sourceSha256) throw new ArtifactError('Reviewed ranges belong to a different source');
      expectedHits.set(id, (expectedHits.get(id) ?? 0) + Number(rule.expectedHits));
      if (Array.isArray(rule.ranges)) for (const value of rule.ranges) {
        const range = object(value, 'rule range');
        const key = `${rule.file}:${range.start}:${range.end}`;
        if (approvedEdits.has(key)) throw new ArtifactError('Reviewed rules overlap at the same range');
        approvedEdits.set(key, id);
      }
    }
    for (const point of coverage.usagePoints) {
      const source = points.get(point.usageId);
      if (covered.has(point.usageId) || !source || source.file !== point.file || source.start !== point.start || source.end !== point.end || !['translated', 'unresolved', 'excluded', 'probe'].includes(point.status))
        throw new ArtifactError('Coverage contains a duplicate, invented or displaced usage point');
      covered.add(point.usageId);
      if (point.status === 'translated') {
        if (!point.messageId || !coverage.hits.some((hit) => hit.messageId === point.messageId && hit.hits > 0)) throw new ArtifactError('Translated usage point has no edit evidence');
        if (!Number.isInteger(point.editStart) || !Number.isInteger(point.editEnd) || point.editStart! > point.start || point.editEnd! < point.end) throw new ArtifactError('Usage point has invalid edit evidence range');
        if (approvedEdits.size && approvedEdits.get(`${point.file}:${point.editStart}:${point.editEnd}`) !== point.messageId) throw new ArtifactError('Usage point does not match a reviewed edit');
        const edits = translatedEdits.get(point.messageId) ?? new Set<string>();
        edits.add(`${point.file}:${point.editStart}:${point.editEnd}`);
        translatedEdits.set(point.messageId, edits);
      }
      if (point.status === 'excluded' && (!point.reason || object(source.review, 'inventory review').decision !== 'exclude')) throw new ArtifactError('Excluded usage point has no reviewed reason');
    }
    for (const hit of coverage.hits) if (!coverage.probe && hit.hits !== (translatedEdits.get(hit.messageId)?.size ?? 0)) throw new ArtifactError(`Usage point evidence does not match replacement count for ${hit.messageId}`);
    if (expectedHits.size !== coverage.hits.length || coverage.hits.some((hit) => expectedHits.get(hit.messageId) !== hit.hits)) throw new ArtifactError('Coverage hit totals do not match reviewed rules');
    if (coverage.completeness === 'complete' && coverage.usagePoints.some((point) => point.status === 'unresolved')) throw new ArtifactError('Artifact claims completeness with unresolved usage points');
  } else if (coverage.schemaVersion === 3) throw new ArtifactError('Usage-point coverage has no inventory hash');
  return { manifest, coverage, assets, body: assets.get('main.js')!.toString('utf8'), nativeCatalog };
}

function readHashedFile(directory: string, file: string, expectedHash: string): Buffer {
  const filename = path.join(directory, file);
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || path.dirname(fs.realpathSync(filename)) !== fs.realpathSync(directory)) throw new ArtifactError(`Artifact ${file} must be a regular managed file`);
  const bytes = fs.readFileSync(filename);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new ArtifactError(`Artifact ${file} does not match its manifest hash`);
  return bytes;
}

/** Runtime verifies delivered executable/native bytes; full offline review stays in validate/select. */
export function readArtifactDelivery(directory: string, expected: { artifactId?: string; locale?: string } = {}) {
  const manifest = decodeManifest(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')));
  if ((expected.artifactId && manifest.artifactId !== expected.artifactId) || (expected.locale && manifest.locale !== expected.locale)) throw new ArtifactError('Artifact identity or locale does not match the approved selection');
  const assets = new Map(manifest.assets.map((entry) => [entry.file, readHashedFile(directory, entry.file, entry.sha256)]));
  const nativeCatalog = manifest.nativeCatalogSha256 === null ? null : decodeNativeCatalog(JSON.parse(readHashedFile(directory, 'native.json', manifest.nativeCatalogSha256).toString('utf8')), manifest.locale);
  return { manifest, assets, nativeCatalog };
}
