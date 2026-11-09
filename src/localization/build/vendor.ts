// Deterministic vendor dictionary import (continuation plan §3). Vendor files
// are read as data only: JSON dictionaries are parsed with in-file
// duplicate-key detection before any overwrite, and the inline menu/tray maps
// are extracted statically with Acorn from the engine sources — vendor
// JavaScript is never executed. Generated catalogs carry the project's MIT
// delivery marking; source tracking stays for updates and debugging only
// (plan §3.4).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'acorn';
import { BuildError } from './assets.js';

export type VendorLocale = 'zh-Hans-CN' | 'zh-Hant-TW' | 'ja-JP';

export interface VendorJsonSourceSpec {
  project: string;
  commit: string;
  directory: string;
  locale: VendorLocale;
  /** The reviewed candidate source; supplements only fill gaps (plan §3.3). */
  role: 'primary' | 'supplement';
}

export interface VendorInlineSourceSpec {
  project: string;
  commit: string;
  file: string;
  locale: VendorLocale;
}

/** Snapshot identities recorded by the continuation-plan inventory (§3.1). */
export const VENDOR_JSON_SOURCES: VendorJsonSourceSpec[] = [
  {
    project: 'antigravity2-cn',
    commit: 'e412cba67f813b1c77c217b41fd553a755553ce3',
    directory: 'dicts',
    locale: 'zh-Hans-CN',
    role: 'primary',
  },
  {
    project: 'antigravity2-cn',
    commit: 'e412cba67f813b1c77c217b41fd553a755553ce3',
    directory: 'dicts_tw',
    locale: 'zh-Hant-TW',
    role: 'supplement',
  },
  {
    project: 'antigravity2.0-zh-tw',
    commit: 'd33f9c81294050019d8d056904fb336bb7e536c8',
    directory: 'dicts',
    locale: 'zh-Hant-TW',
    role: 'primary',
  },
  {
    project: 'antigravity2.0-ja-jp',
    commit: '43b80071268e0ce405f02938d3e82bfdb340601d',
    directory: 'dicts',
    locale: 'ja-JP',
    role: 'primary',
  },
];

export const VENDOR_INLINE_SOURCES: VendorInlineSourceSpec[] = [
  {
    project: 'antigravity2-cn',
    commit: 'e412cba67f813b1c77c217b41fd553a755553ce3',
    file: 'localization_engine.js',
    locale: 'zh-Hans-CN',
  },
  {
    project: 'antigravity2-cn',
    commit: 'e412cba67f813b1c77c217b41fd553a755553ce3',
    file: 'localization_engine.js',
    locale: 'zh-Hant-TW',
  },
  {
    project: 'antigravity2.0-zh-tw',
    commit: 'd33f9c81294050019d8d056904fb336bb7e536c8',
    file: 'localization_engine.js',
    locale: 'zh-Hant-TW',
  },
  {
    project: 'antigravity2.0-ja-jp',
    commit: '43b80071268e0ce405f02938d3e82bfdb340601d',
    file: 'localization_engine.js',
    locale: 'ja-JP',
  },
];

/** Curated dynamic-rule anchors (plan §3.2). Presence is verified against the
 * engine source text at import time; a missing anchor is a reported gap, never
 * a silent skip. */
const DYNAMIC_RULE_ANCHORS = [
  { id: 'greeting', anchor: 'what can we get done today' },
  { id: 'delete-project', anchor: 'Permanently delete' },
  { id: 'active-conversations', anchor: 'active conversations' },
  { id: 'archived-conversations', anchor: 'archived conversations' },
  { id: 'select-environment', anchor: 'Select Environment' },
  { id: 'tray-open-prefix', anchor: ".startsWith('Open ')" },
] as const;

interface AcornNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function walk(node: AcornNode, visit: (node: AcornNode) => void): void {
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === 'object' && typeof (child as AcornNode).type === 'string')
          walk(child as AcornNode, visit);
      }
    } else if (value && typeof value === 'object' && typeof (value as AcornNode).type === 'string') {
      walk(value as AcornNode, visit);
    }
  }
}

function propertyKey(node: AcornNode): string | null {
  const key = node.key as AcornNode | undefined;
  if (!key) return null;
  if (key.type === 'Identifier') return key.name as string;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value as string;
  return null;
}

/** Extracts ordered string→string pairs from an object-literal node, or null
 * when the node is not a flat string dictionary. */
function objectStringPairs(node: AcornNode): Array<[string, string]> | null {
  if (node.type !== 'ObjectExpression') return null;
  const pairs: Array<[string, string]> = [];
  for (const property of node.properties as AcornNode[]) {
    if (property.type !== 'Property') return null;
    const key = propertyKey(property);
    const value = property.value as AcornNode | undefined;
    if (key === null || !value || value.type !== 'Literal' || typeof value.value !== 'string')
      return null;
    pairs.push([key, value.value as string]);
  }
  return pairs;
}

function parseScript(text: string): AcornNode {
  return parse(text, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AcornNode;
}

/**
 * Parses one vendor JSON dictionary preserving physical pair order, so
 * duplicate keys are detected before any overwrite could hide them.
 */
export function parseVendorJsonDictionary(bytes: Buffer, file: string): Array<[string, string]> {
  let text = bytes.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let expression: AcornNode;
  try {
    const program = parseScript(`(${text})`);
    const statement = (program.body as AcornNode[])[0];
    if (!statement || statement.type !== 'ExpressionStatement')
      throw new Error('not an expression');
    expression = statement.expression as AcornNode;
  } catch (cause) {
    throw new BuildError('VENDOR_INVALID', `Vendor dictionary ${file} is not a parseable JSON object`, {
      cause,
    });
  }
  const pairs = objectStringPairs(expression);
  if (pairs === null)
    throw new BuildError('VENDOR_INVALID', `Vendor dictionary ${file} is not a flat string map`);
  return pairs;
}

export interface VendorFileAudit {
  file: string;
  sha256: string;
  physicalPairs: number;
  parsedEntries: number;
  withinFileDuplicates: Array<{ key: string; values: string[] }>;
}

export interface VendorCandidateRef {
  value: string;
  project: string;
  /** Every file in this source that carries the value for the key. */
  files: string[];
}

export interface VendorSourceAudit {
  source: VendorJsonSourceSpec;
  files: VendorFileAudit[];
  /** Plan §8.2 digest: sorted filename + NUL + sha256 + LF, concatenated. */
  manifestSha256: string;
  uniqueKeys: number;
  crossFileConflicts: Array<{ key: string; values: Array<{ file: string; value: string }> }>;
  /** key -> distinct candidates in file order. */
  entries: Map<string, VendorCandidateRef[]>;
}

function auditJsonSource(vendorRoot: string, spec: VendorJsonSourceSpec): VendorSourceAudit {
  const directory = path.join(vendorRoot, spec.project, spec.directory);
  let names: string[];
  try {
    names = fs.readdirSync(directory).filter((name) => name.endsWith('.json')).sort();
  } catch (cause) {
    throw new BuildError('VENDOR_INVALID', `Vendor dictionary directory is unavailable: ${directory}`, {
      cause,
    });
  }
  if (names.length === 0)
    throw new BuildError('VENDOR_INVALID', `Vendor dictionary directory has no catalogs: ${directory}`);
  const files: VendorFileAudit[] = [];
  const manifestParts: string[] = [];
  const entries = new Map<string, VendorCandidateRef[]>();
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(directory, name));
    manifestParts.push(`${name}\0${sha256Bytes(bytes)}\n`);
    const pairs = parseVendorJsonDictionary(bytes, `${spec.project}/${spec.directory}/${name}`);
    const duplicates: Array<{ key: string; values: string[] }> = [];
    const seen = new Map<string, string>();
    for (const [key, value] of pairs) {
      if (seen.has(key)) {
        const existing = duplicates.find((entry) => entry.key === key);
        if (existing && !existing.values.includes(value)) existing.values.push(value);
        else if (!existing) duplicates.push({ key, values: [seen.get(key) as string, value] });
        continue;
      }
      seen.set(key, value);
    }
    files.push({
      file: name,
      sha256: sha256Bytes(bytes),
      physicalPairs: pairs.length,
      parsedEntries: seen.size,
      withinFileDuplicates: duplicates,
    });
    for (const [key, value] of seen) {
      const current = entries.get(key) ?? [];
      const existing = current.find((candidate) => candidate.value === value);
      if (existing) existing.files.push(name);
      else current.push({ value, project: spec.project, files: [name] });
      entries.set(key, current);
    }
  }
  const crossFileConflicts = [...entries.entries()]
    .filter(([, candidates]) => candidates.length > 1)
    .map(([key, candidates]) => ({
      key,
      values: candidates.flatMap((candidate) =>
        candidate.files.map((file) => ({ file, value: candidate.value })),
      ),
    }))
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return {
    source: spec,
    files,
    manifestSha256: sha256Bytes(Buffer.from(manifestParts.join(''), 'utf8')),
    uniqueKeys: entries.size,
    crossFileConflicts,
    entries,
  };
}

export interface InlineMapExtraction {
  classification: 'menu' | 'tray' | 'inline-map';
  locale: VendorLocale;
  project: string;
  entries: Array<[string, string]>;
}

export interface VendorInlineAudit {
  source: VendorInlineSourceSpec;
  file: string;
  sha256: string;
  maps: InlineMapExtraction[];
  dynamicRules: Array<{ id: string; occurrences: number }>;
}

function collectEmbeddedMaps(text: string): AcornNode[] {
  const found: AcornNode[] = [];
  let program: AcornNode | null = null;
  try {
    program = parseScript(text);
  } catch {
    try {
      const wrapped = parseScript(`(${text})`);
      const statement = (wrapped.body as AcornNode[])[0];
      if (statement?.type === 'ExpressionStatement')
        found.push(statement.expression as AcornNode);
      program = null;
    } catch {
      program = null;
    }
  }
  if (program)
    walk(program, (node) => {
      if (objectStringPairs(node)) found.push(node);
    });
  else if (found.length === 0) {
    // Patch fragments can be unbalanced function bodies (they replace a
    // matched region), so whole-fragment parsing fails. Fall back to
    // brace-balanced islands, skipping string-literal contents.
    for (const island of balancedObjectIslands(text)) {
      try {
        const wrapped = parseScript(`(${island})`);
        const statement = (wrapped.body as AcornNode[])[0];
        const expression =
          statement?.type === 'ExpressionStatement'
            ? (statement.expression as AcornNode)
            : null;
        if (expression && objectStringPairs(expression)) found.push(expression);
      } catch {
        /* not an object literal island */
      }
    }
  }
  return found;
}

/** Every balanced `{...}` substring of a fragment, ignoring brace characters
 * inside quoted strings; nested regions are returned as their own islands. */
function balancedObjectIslands(text: string): string[] {
  const islands: string[] = [];
  const starts: number[] = [];
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (quote !== null) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') starts.push(index);
    else if (ch === '}' && starts.length > 0) {
      const start = starts.pop() as number;
      islands.push(text.slice(start, index + 1));
    }
  }
  return islands;
}

function classifyInlineMap(pairs: Array<[string, string]>): 'menu' | 'tray' | 'inline-map' {
  const keys = new Set(pairs.map(([key]) => key));
  if (keys.has('File') && keys.has('Edit') && keys.has('View') && keys.has('Help')) return 'menu';
  if (keys.has('No agents running')) return 'tray';
  return 'inline-map';
}

function dedupeMaps(maps: InlineMapExtraction[]): InlineMapExtraction[] {
  const seen = new Set<string>();
  const result: InlineMapExtraction[] = [];
  for (const map of maps) {
    const identity = JSON.stringify([
      map.classification,
      map.locale,
      map.project,
      map.entries,
    ]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(map);
  }
  return result;
}

function auditInlineSource(spec: VendorInlineSourceSpec, text: string, sha: string, maps: InlineMapExtraction[]): VendorInlineAudit {
  const dynamicRules = DYNAMIC_RULE_ANCHORS.map((rule) => {
    let occurrences = 0;
    let index = text.indexOf(rule.anchor);
    while (index >= 0) {
      occurrences += 1;
      index = text.indexOf(rule.anchor, index + rule.anchor.length);
    }
    return { id: rule.id, occurrences };
  });
  return {
    source: spec,
    file: `${spec.project}/${spec.file}`,
    sha256: sha,
    maps,
    dynamicRules,
  };
}

/**
 * Extracts the inline menu/tray maps from one engine source. The CN engine
 * carries both locale variants selected by `USE_TW ? … : …` ternaries; branch
 * position assigns the locale, never evaluation.
 */
function extractInlineMaps(text: string, spec: VendorInlineSourceSpec): InlineMapExtraction[] {
  const maps: InlineMapExtraction[] = [];
  const pushMap = (pairs: Array<[string, string]>, locale: VendorLocale) => {
    if (pairs.length < 3) return;
    maps.push({
      classification: classifyInlineMap(pairs),
      locale,
      project: spec.project,
      entries: pairs,
    });
  };
  let program: AcornNode;
  try {
    program = parseScript(text);
  } catch (cause) {
    throw new BuildError('VENDOR_INVALID', `Vendor engine source is not parseable: ${spec.project}/${spec.file}`, {
      cause,
    });
  }
  // Texts already consumed by a USE_TW branch carry their branch locale; the
  // generic fragment scan must not re-read them under the declared locale.
  const branchTexts = new Set<string>();
  const templateTexts = new Set<string>();
  const claimedNodes = new Set<AcornNode>();
  walk(program, (node) => {
    // USE_TW ternaries: the consequent is the zh-Hant variant, the alternate
    // is zh-Hans (vendor structure, plan §3.2).
    if (node.type === 'ConditionalExpression') {
      const test = node.test as AcornNode | undefined;
      if (test?.type === 'Identifier' && (test.name as string) === 'USE_TW') {
        for (const [branch, locale] of [
          [node.consequent as AcornNode, 'zh-Hant-TW'],
          [node.alternate as AcornNode, 'zh-Hans-CN'],
        ] as Array<[AcornNode, VendorLocale]>) {
          const branchText = templateCookedText(branch);
          if (branchText === null) continue;
          branchTexts.add(branchText);
          for (const candidate of collectEmbeddedMaps(branchText))
            pushMap(objectStringPairs(candidate) as Array<[string, string]>, locale);
        }
      }
    }
    // USE_TW if-statements carry the same split: the consequent block holds
    // the zh-Hant variant, the else block the zh-Hans one.
    if (node.type === 'IfStatement') {
      const test = node.test as AcornNode | undefined;
      if (test?.type === 'Identifier' && (test.name as string) === 'USE_TW') {
        for (const [branch, locale] of [
          [node.consequent as AcornNode, 'zh-Hant-TW'],
          [node.alternate as AcornNode, 'zh-Hans-CN'],
        ] as Array<[AcornNode, VendorLocale]>) {
          if (!branch) continue;
          walk(branch, (inner) => {
            const direct = objectStringPairs(inner);
            if (direct) {
              claimedNodes.add(inner);
              pushMap(direct, locale);
            }
          });
        }
      }
    }
    // Direct object literals plus template/string fragments that embed patch
    // code for the declared locale.
    const direct = objectStringPairs(node);
    if (direct && !claimedNodes.has(node)) pushMap(direct, spec.locale);
    if (node.type === 'TemplateLiteral') {
      for (const quasi of node.quasis as AcornNode[]) {
        const cooked = (quasi.value as { cooked?: unknown } | undefined)?.cooked;
        if (typeof cooked === 'string' && cooked.length > 8) templateTexts.add(cooked);
      }
    }
    if (node.type === 'Literal' && typeof node.value === 'string' && (node.value as string).length > 8)
      templateTexts.add(node.value as string);
  });
  for (const fragment of templateTexts) {
    if (branchTexts.has(fragment)) continue;
    for (const candidate of collectEmbeddedMaps(fragment))
      pushMap(objectStringPairs(candidate) as Array<[string, string]>, spec.locale);
  }
  return dedupeMaps(maps);
}

function templateCookedText(node: AcornNode): string | null {
  if (node.type === 'TemplateLiteral') {
    const parts: string[] = [];
    for (const quasi of node.quasis as AcornNode[]) {
      const cooked = (quasi.value as { cooked?: unknown } | undefined)?.cooked;
      if (typeof cooked !== 'string') return null;
      parts.push(cooked);
    }
    return parts.join('${…}');
  }
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value as string;
  return null;
}

export interface VendorLocaleKeyEntry {
  candidates: VendorCandidateRef[];
  conflict: boolean;
  empty: boolean;
  identical: boolean;
}

export interface VendorLocaleCatalog {
  schemaVersion: number;
  license: 'MIT';
  locale: VendorLocale;
  sources: Array<{
    project: string;
    commit: string;
    directory: string;
    role: 'primary' | 'supplement';
    manifestSha256: string;
  }>;
  keys: Record<string, VendorLocaleKeyEntry>;
  inline: Record<'menu' | 'tray', Record<string, VendorLocaleKeyEntry>>;
}

export interface VendorImportResult {
  jsonSources: VendorSourceAudit[];
  inlineSources: VendorInlineAudit[];
  localeCatalogs: Record<VendorLocale, VendorLocaleCatalog>;
  /** Union of every distinct JSON dictionary key across all sources. */
  unionKeys: string[];
}

export interface VendorImportOptions {
  vendorRoot: string;
}

export function importVendorDictionaries(options: VendorImportOptions): VendorImportResult {
  const jsonSources = VENDOR_JSON_SOURCES.map((spec) => auditJsonSource(options.vendorRoot, spec));
  const inlineSources: VendorInlineAudit[] = [];
  const inlineExtracted = new Map<string, { spec: VendorInlineSourceSpec; text: string; sha: string; maps: InlineMapExtraction[] }>();
  for (const spec of VENDOR_INLINE_SOURCES) {
    const file = path.join(options.vendorRoot, spec.project, spec.file);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch (cause) {
      throw new BuildError('VENDOR_INVALID', `Vendor engine source is unavailable: ${file}`, { cause });
    }
    const text = bytes.toString('utf8');
    const sha = sha256Bytes(bytes);
    const cached = inlineExtracted.get(`${spec.project}\0${spec.file}`);
    if (cached) {
      inlineSources.push(auditInlineSource(spec, cached.text, cached.sha, cached.maps.filter((map) => map.locale === spec.locale)));
      continue;
    }
    const maps = extractInlineMaps(text, spec);
    inlineExtracted.set(`${spec.project}\0${spec.file}`, { spec, text, sha, maps });
    inlineSources.push(auditInlineSource(spec, text, sha, maps.filter((map) => map.locale === spec.locale)));
  }

  const localeCatalogs = {} as Record<VendorLocale, VendorLocaleCatalog>;
  for (const locale of ['zh-Hans-CN', 'zh-Hant-TW', 'ja-JP'] as VendorLocale[]) {
    // Primary-source candidates come first (the reviewed Taiwan-usage
    // candidate); supplements only add values the primary did not provide —
    // but conflicting supplement values are kept as candidates, never
    // silently dropped (plan §3.3.2).
    const sources = jsonSources
      .filter((audit) => audit.source.locale === locale)
      .sort((left, right) =>
        left.source.role === right.source.role ? 0 : left.source.role === 'primary' ? -1 : 1,
      );
    // Dictionary keys are untrusted text: a prototype-less map keeps "__proto__" and "constructor" ordinary keys.
    const keys: Record<string, VendorLocaleKeyEntry> = Object.create(null);
    for (const audit of sources) {
      for (const [key, candidates] of audit.entries) {
        const existing = keys[key] ?? { candidates: [], conflict: false, empty: false, identical: false };
        for (const candidate of candidates) {
          if (!existing.candidates.some((row) => row.value === candidate.value && row.project === candidate.project))
            existing.candidates.push(candidate);
        }
        keys[key] = existing;
      }
    }
    for (const [key, entry] of Object.entries(keys)) {
      const values = new Set(entry.candidates.map((candidate) => candidate.value));
      entry.conflict = values.size > 1;
      entry.empty = values.has('');
      // Original text equal to the translation is a candidate-only signal
      // (brands, product names, paths); it is never auto-marked missing.
      entry.identical = entry.candidates.some((candidate) => candidate.value === key);
    }
    const inline: Record<'menu' | 'tray', Record<string, VendorLocaleKeyEntry>> = {
      menu: Object.create(null),
      tray: Object.create(null),
    };
    for (const audit of inlineSources) {
      if (audit.source.locale !== locale) continue;
      for (const map of audit.maps) {
        if (map.classification === 'inline-map') continue;
        for (const [key, value] of map.entries) {
          const existing = inline[map.classification][key] ?? { candidates: [], conflict: false, empty: false, identical: false };
          const match = existing.candidates.find((row) => row.value === value && row.project === map.project);
          if (match) match.files.push(audit.file);
          else existing.candidates.push({ value, project: map.project, files: [audit.file] });
          inline[map.classification][key] = existing;
        }
      }
    }
    for (const group of [inline.menu, inline.tray]) {
      for (const [key, entry] of Object.entries(group)) {
        entry.conflict = new Set(entry.candidates.map((candidate) => candidate.value)).size > 1;
        entry.identical = entry.candidates.some((candidate) => candidate.value === key);
      }
    }
    localeCatalogs[locale] = {
      schemaVersion: 1,
      license: 'MIT',
      locale,
      sources: sources.map((audit) => ({
        project: audit.source.project,
        commit: audit.source.commit,
        directory: audit.source.directory,
        role: audit.source.role,
        manifestSha256: audit.manifestSha256,
      })),
      keys: Object.fromEntries(Object.entries(keys).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))),
      inline,
    };
  }
  const union = new Set<string>();
  for (const audit of jsonSources) for (const key of audit.entries.keys()) union.add(key);
  return {
    jsonSources,
    inlineSources,
    localeCatalogs,
    unionKeys: [...union].sort(),
  };
}

export interface VendorImportSummary {
  schemaVersion: number;
  license: 'MIT';
  jsonSources: Array<{
    project: string;
    directory: string;
    locale: VendorLocale;
    role: 'primary' | 'supplement';
    commit: string;
    manifestSha256: string;
    files: number;
    physicalPairs: number;
    parsedEntries: number;
    uniqueKeys: number;
    withinFileDuplicateKeys: number;
    crossFileConflictingKeys: number;
  }>;
  union: {
    keys: number;
    perLocale: Record<VendorLocale, { present: number; missing: number }>;
    combinedTw: { keys: number; missingFromUnion: string[] };
    twMerge: {
      commonKeys: number;
      independentOnly: number;
      cnSupplementOnly: number;
      conflictingValues: number;
    };
  };
  inline: Array<{
    project: string;
    locale: VendorLocale;
    file: string;
    sha256: string;
    maps: Array<{ classification: string; keys: number }>;
    dynamicRules: Array<{ id: string; occurrences: number }>;
  }>;
  dispositions: Record<
    VendorLocale,
    { pending: number; conflictPending: number; emptyValue: number; identicalValue: number }
  >;
}

export function summarizeVendorImport(result: VendorImportResult): VendorImportSummary {
  const byLocale = (locale: VendorLocale) => result.jsonSources.filter((audit) => audit.source.locale === locale);
  const keySetOf = (locale: VendorLocale) =>
    new Set(byLocale(locale).flatMap((audit) => [...audit.entries.keys()]));
  const hans = keySetOf('zh-Hans-CN');
  const hant = keySetOf('zh-Hant-TW');
  const ja = keySetOf('ja-JP');
  const union = new Set([...hans, ...hant, ...ja]);
  const independentTw = result.jsonSources.find(
    (audit) => audit.source.project === 'antigravity2.0-zh-tw',
  ) as VendorSourceAudit;
  const cnTw = result.jsonSources.find(
    (audit) => audit.source.project === 'antigravity2-cn' && audit.source.directory === 'dicts_tw',
  ) as VendorSourceAudit;
  let common = 0;
  let conflicting = 0;
  for (const key of independentTw.entries.keys()) {
    if (!cnTw.entries.has(key)) continue;
    common += 1;
    // The plan's conflict metric is value-set inequality: any difference in
    // the candidate value sets counts, not just disjoint ones (§3.1: 487).
    const left = new Set((independentTw.entries.get(key) as VendorCandidateRef[]).map((row) => row.value));
    const right = new Set((cnTw.entries.get(key) as VendorCandidateRef[]).map((row) => row.value));
    if (left.size !== right.size || [...left].some((value) => !right.has(value))) conflicting += 1;
  }
  const dispositions = {} as VendorImportSummary['dispositions'];
  for (const locale of ['zh-Hans-CN', 'zh-Hant-TW', 'ja-JP'] as VendorLocale[]) {
    let pending = 0;
    let conflictPending = 0;
    let emptyValue = 0;
    let identicalValue = 0;
    for (const entry of Object.values(result.localeCatalogs[locale].keys)) {
      if (entry.conflict) conflictPending += 1;
      else if (entry.empty) emptyValue += 1;
      else if (entry.identical) identicalValue += 1;
      else pending += 1;
    }
    dispositions[locale] = { pending, conflictPending, emptyValue, identicalValue };
  }
  const combinedTw = new Set([...hant]);
  return {
    schemaVersion: 1,
    license: 'MIT',
    jsonSources: result.jsonSources.map((audit) => ({
      project: audit.source.project,
      directory: audit.source.directory,
      locale: audit.source.locale,
      role: audit.source.role,
      commit: audit.source.commit,
      manifestSha256: audit.manifestSha256,
      files: audit.files.length,
      physicalPairs: audit.files.reduce((sum, file) => sum + file.physicalPairs, 0),
      parsedEntries: audit.files.reduce((sum, file) => sum + file.parsedEntries, 0),
      uniqueKeys: audit.uniqueKeys,
      withinFileDuplicateKeys: audit.files.reduce((sum, file) => sum + file.withinFileDuplicates.length, 0),
      crossFileConflictingKeys: audit.crossFileConflicts.length,
    })),
    union: {
      keys: union.size,
      perLocale: {
        'zh-Hans-CN': { present: hans.size, missing: union.size - hans.size },
        'zh-Hant-TW': { present: hant.size, missing: union.size - hant.size },
        'ja-JP': { present: ja.size, missing: union.size - ja.size },
      },
      combinedTw: {
        keys: combinedTw.size,
        missingFromUnion: [...union].filter((key) => !combinedTw.has(key)),
      },
      twMerge: {
        commonKeys: common,
        independentOnly: independentTw.uniqueKeys - common,
        cnSupplementOnly: cnTw.uniqueKeys - common,
        conflictingValues: conflicting,
      },
    },
    inline: result.inlineSources.map((audit) => ({
      project: audit.source.project,
      locale: audit.source.locale,
      file: audit.file,
      sha256: audit.sha256,
      maps: audit.maps.map((map) => ({ classification: map.classification, keys: map.entries.length })),
      dynamicRules: audit.dynamicRules,
    })),
    dispositions,
  };
}

export interface VendorCatalogDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/** Compares two generated locale catalogs so a vendor update shows its
 * added/removed/changed keys instead of a full manual re-merge (plan S1). */
export function diffVendorLocaleCatalogs(
  previous: VendorLocaleCatalog,
  next: VendorLocaleCatalog,
): VendorCatalogDiff {
  if (previous.locale !== next.locale)
    throw new BuildError('VENDOR_INVALID', 'Cannot diff catalogs of different locales');
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const key of Object.keys(next.keys)) {
    if (!(key in previous.keys)) added.push(key);
    else if (
      JSON.stringify(previous.keys[key].candidates.map((candidate) => [candidate.project, candidate.value])) !==
      JSON.stringify(next.keys[key].candidates.map((candidate) => [candidate.project, candidate.value]))
    )
      changed.push(key);
  }
  for (const key of Object.keys(previous.keys)) if (!(key in next.keys)) removed.push(key);
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}
