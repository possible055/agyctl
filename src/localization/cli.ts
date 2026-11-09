import fs from 'node:fs';
import { ArtifactError, readValidatedArtifact } from './artifact.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import {
  BuildError,
  loadProfiles,
  observeLsSource,
  observeSampleSource,
  observedProfileId,
  sha256File,
  validateProfileAssets,
  inspectEmbeddedWebAssets,
  type LocalizationProfile,
  type ObservedSource,
} from './build/assets.js';
import {
  buildArtifact,
  sha256Text,
  stableStringify,
  transformAsset,
  type SourceCatalog,
  type UsageRule,
} from './build/transform.js';
import { buildInventory, type InventoryReport } from './build/inventory.js';
import {
  diffVendorLocaleCatalogs,
  importVendorDictionaries,
  summarizeVendorImport,
  type VendorImportSummary,
  type VendorLocale,
  type VendorLocaleCatalog,
} from './build/vendor.js';
import {
  LocalizationCommandLog,
  LoggingError,
  type CommandLogInfo,
} from './logging.js';
import { decodeSelectionSnapshot, readRuntimeStatus } from './runtime/startup.js';
import { agyctlHome, installedTargets } from '../../scripts/lib/install-paths.mjs';

export {
  BuildError,
  inspectEmbeddedWebAssets,
  extractProfileAssets,
  loadProfiles,
  loadSampleAssets,
  observeLsSource,
  observeSampleSource,
  sha256File,
  validateProfileAssets,
} from './build/assets.js';
export {
  buildArtifact,
  sha256Text,
  stableStringify,
  transformAsset,
  validateIcuMessage,
  validateSourceCatalog,
  validateTranslations,
} from './build/transform.js';
export {
  diffVendorLocaleCatalogs,
  importVendorDictionaries,
  summarizeVendorImport,
  parseVendorJsonDictionary,
} from './build/vendor.js';
export { buildInventory } from './build/inventory.js';
export { readValidatedArtifact } from './artifact.js';
export { decodeSelectionSnapshot, readRuntimeStatus } from './runtime/startup.js';
export type { InventoryReport } from './build/inventory.js';
export { LoggingError } from './logging.js';

// Works both from the TypeScript source layout and from the bundled output
// under dist/localization/bundle: walk up to the directory that owns the
// compat profile database.
const REPO_ROOT = (() => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth++) {
    if (fs.existsSync(path.join(dir, 'compat', 'localization', 'profiles.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new BuildError('PROFILE_INVALID', 'Could not locate the repository root from the localization tool');
})();

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveProfile(
  profileId: string | undefined,
  source?: { ls?: string; sampleDir?: string },
): LocalizationProfile {
  const profiles = loadProfiles(path.join(REPO_ROOT, 'compat', 'localization', 'profiles.json'));
  if (profileId === undefined) {
    if (profiles.length !== 1) {
      const options = {
        profiles,
        limits: profiles[0].limits,
        assetNames: [...new Set(profiles.flatMap((entry) => Object.keys(entry.assets)))],
      };
      const observed = source?.ls
        ? observeLsSource(source.ls, options)
        : source?.sampleDir
          ? observeSampleSource(source.sampleDir, options)
          : null;
      const candidates = profiles.filter((entry) =>
        observed?.matchedProfileId === entry.profileId ||
        observed?.matchedProfileId === null && observed.nlsHelperCalleeName === entry.nlsHelper.calleeName,
      );
      if (candidates.length === 1) return candidates[0];
      if (observed?.assets['main.js']) {
        const compatible = candidates.filter((candidate) => {
          try {
            transformAsset({ source: observed.assets['main.js'].text, file: 'main.js', rules: resolveUsageRules(candidate, observed.assets['main.js'].sha256), helperCalleeName: observed.nlsHelperCalleeName ?? candidate.nlsHelper.calleeName });
            return true;
          } catch (error) {
            if (error instanceof BuildError && error.code === 'SOURCE_MISMATCH') return false;
            throw error;
          }
        });
        const signatures = new Map(compatible.map((candidate) => [candidate, new Set(resolveUsageRules(candidate, observed.assets['main.js'].sha256).map((rule) => stableStringify(rule)))]));
        const maximal = compatible.filter((candidate) => compatible.every((other) => [...signatures.get(other)!].every((rule) => signatures.get(candidate)!.has(rule))));
        if (maximal.length > 0 && maximal.every((candidate) => candidate.adapterVersion === maximal[0].adapterVersion)) return maximal[0];
      }
      throw new BuildError('PROFILE_INVALID', 'Multiple profiles exist and the source does not identify one; select --profile explicitly');
    }
    return profiles[0];
  }
  const profile = profiles.find((entry) => entry.profileId === profileId);
  if (!profile) throw new BuildError('PROFILE_INVALID', `Unknown profile: ${profileId}`);
  return profile;
}

function resolveUsageRules(profile: LocalizationProfile, sourceSha256?: string): UsageRule[] {
  const database = readJson(path.join(REPO_ROOT, 'compat', 'localization', 'usage-points.json')) as {
    schema?: number;
    profiles?: Record<string, { rules?: UsageRule[]; fallbackRules?: UsageRule[]; rulesFrom?: string }>;
  };
  if (database.schema !== 1) throw new BuildError('PROFILE_INVALID', 'Unsupported usage-points database schema');
  let entry = database.profiles?.[profile.profileId];
  for (let hops = 0; entry?.rulesFrom && hops < 8; hops++) {
    const next = database.profiles?.[entry.rulesFrom];
    if (!next || next === entry) break;
    entry = next;
  }
  const reviewed = entry?.rules ?? [];
  const specific = reviewed.filter((rule) => rule.sourceSha256 === sourceSha256);
  const rules = sourceSha256 === undefined ? reviewed : specific.length ? reviewed.filter((rule) => !rule.sourceSha256 || rule.sourceSha256 === sourceSha256) : entry?.fallbackRules ?? reviewed.filter((rule) => !rule.sourceSha256);
  for (const rule of rules) if (rule.file !== 'main.js')
    throw new BuildError('PROFILE_INVALID', `Usage point targets an unexpected file: ${rule.file}`);
  return rules;
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Observes the current source structurally: profiles act as recognition hints
 * only, so unlisted or untested sources proceed with recorded warnings
 * (continuation plan §5.1).
 */
function observeSource(options: { ls?: string; sampleDir?: string }, hint: LocalizationProfile): ObservedSource {
  const observeOptions = {
    profiles: loadProfiles(path.join(REPO_ROOT, 'compat', 'localization', 'profiles.json')),
    limits: hint.limits,
    assetNames: Object.keys(hint.assets),
  };
  if (options.ls) return observeLsSource(options.ls, observeOptions);
  if (options.sampleDir) return observeSampleSource(options.sampleDir, observeOptions);
  const targets = installedTargets();
  if (targets.length === 1) return observeLsSource(targets[0].binaryPath, observeOptions);
  throw new BuildError(
    'SOURCE_MISMATCH',
    'No source selected: pass --ls PATH or --sample-dir PATH (multiple installations exist)',
  );
}

/** The adapter identity for a transform: recorded evidence when the profile
 * matched, otherwise the structural detection result. */
function resolveHelperCallee(observed: ObservedSource, hint: LocalizationProfile): string {
  if (observed.matchedProfileId === hint.profileId) return hint.nlsHelper.calleeName;
  if (observed.nlsHelperCalleeName) return observed.nlsHelperCalleeName;
  throw new BuildError(
    'CAPABILITY_GAP',
    `The NLS helper callee could not be recognized structurally in this source (profile hint: ${hint.nlsHelper.calleeName}); no reviewed rule can be located`,
  );
}

/** The installation a command operates on, when the source resolves to one. */
function resolveSourceInstallation(options: { ls?: string; sampleDir?: string }): string | null {
  const targets = installedTargets();
  if (options.ls) {
    const match = targets.find((target) => samePath(target.binaryPath, options.ls as string));
    return match ? sha256Text(match.asarPath) : null;
  }
  if (options.sampleDir) return null;
  if (targets.length === 1) return sha256Text(targets[0].asarPath);
  return null;
}

function loadCatalog(): SourceCatalog {
  const catalog = readJson(path.join(REPO_ROOT, 'src', 'localization', 'catalogs', 'source.json')) as SourceCatalog;
  if (catalog.schemaVersion !== 1) throw new BuildError('CATALOG_INVALID', 'Unsupported source catalog schemaVersion');
  for (const message of nativeMessages()) {
    const existing = catalog.messages[message.id];
    if (existing && existing.defaultMessage !== message.original) throw new BuildError('CATALOG_INVALID', `Native/Web message ${message.id} has conflicting source text`);
    catalog.messages[message.id] = existing ? { ...existing, native: true } : {
      messageId: message.id, format: message.format ?? 'plain', defaultMessage: message.original,
      surface: `native.${message.id.split('.')[0]}`, native: true, description: `${message.escapeContext}; ${message.contexts.map((context) => context.file).join(', ')}`,
    };
  }
  return catalog;
}

interface NativeMessageDefinition {
  id: string;
  original: string;
  format?: 'plain' | 'icu';
  translations: Record<string, string>;
  contexts: Array<{ file: string; anchor: string }>;
  escapeContext: string;
}

function nativeMessages(): NativeMessageDefinition[] {
  const database = readJson(path.join(REPO_ROOT, 'compat', 'localization', 'native-messages.json')) as { schemaVersion?: number; messages?: NativeMessageDefinition[] };
  if (database.schemaVersion !== 1 || !Array.isArray(database.messages)) throw new BuildError('CATALOG_INVALID', 'Invalid native message database');
  const ids = new Set<string>();
  for (const message of database.messages) {
    if (!message.id || ids.has(message.id) || typeof message.original !== 'string' || !Array.isArray(message.contexts)) throw new BuildError('CATALOG_INVALID', 'Invalid or duplicate native message');
    ids.add(message.id);
    for (const locale of ['zh-Hant-TW', 'zh-Hans-CN', 'ja-JP']) if (!message.translations?.[locale]) throw new BuildError('CATALOG_INVALID', `Native message ${message.id} has no ${locale} translation`);
  }
  return database.messages;
}

function loadLocale(locale: string): { locale: string; formatLocale?: string; messages: Record<string, { value: string; reviewed?: boolean }> } {
  const safe = /^[\w-]+$/.test(locale) ? locale : null;
  if (!safe) throw new BuildError('CATALOG_INVALID', `Invalid locale id: ${locale}`);
  const file = path.join(REPO_ROOT, 'src', 'localization', 'catalogs', `${locale}.json`);
  let parsed: unknown;
  try {
    parsed = readJson(file);
  } catch (error) {
    throw new BuildError('CATALOG_INVALID', `Locale ${locale} has no readable catalog file: ${(error as Error).message}`, {
      cause: error,
    });
  }
  const translations = parsed as { locale: string; formatLocale?: string; messages: Record<string, { value: string; reviewed?: boolean }> };
  if (translations.locale !== locale || !translations.messages) throw new BuildError('CATALOG_INVALID', 'Locale catalog identity or messages mismatch');
  for (const message of nativeMessages()) translations.messages[message.id] = { value: message.translations[locale], reviewed: true };
  return translations;
}

function toolchainSha256(): string {
  return sha256File(path.join(REPO_ROOT, 'dist', 'localization', 'bundle', 'build-manifest.json'));
}

const VENDOR_LOCALES = ['zh-Hant-TW', 'zh-Hans-CN', 'ja-JP'] as const;

function loadVendorCatalogs(): Partial<Record<VendorLocale, VendorLocaleCatalog>> {
  const catalogs: Partial<Record<VendorLocale, VendorLocaleCatalog>> = {};
  for (const locale of VENDOR_LOCALES) {
    const file = path.join(REPO_ROOT, 'src', 'localization', 'catalogs', 'vendor', `${locale}.json`);
    if (!fs.existsSync(file)) continue;
    const parsed = readJson(file) as VendorLocaleCatalog;
    if (parsed.schemaVersion !== 1 || parsed.locale !== locale)
      throw new BuildError('CATALOG_INVALID', `Vendor catalog ${locale} is invalid`);
    catalogs[locale] = parsed;
  }
  return catalogs;
}

function applyInventoryReviews(inventory: InventoryReport): void {
  const filename = path.join(REPO_ROOT, 'compat', 'localization', 'reviews.json');
  if (!fs.existsSync(filename)) return;
  const database = readJson(filename) as { schemaVersion?: number; decisions?: Array<{ sourceSha256: string; start: number; end: number; decision: 'adopt' | 'exclude' | 'unresolved'; reason: string; messageId?: string }> };
  if (database.schemaVersion !== 1 || !Array.isArray(database.decisions)) throw new BuildError('CATALOG_INVALID', 'Invalid usage review database');
  const decisions = new Map<string, NonNullable<InventoryReport['usagePoints'][number]['review']>>();
  for (const row of database.decisions) {
    if (row.sourceSha256 !== inventory.sourceSha256) continue;
    if (!['adopt', 'exclude', 'unresolved'].includes(row.decision) || !row.reason) throw new BuildError('CATALOG_INVALID', 'Invalid usage review decision');
    const key = `${row.start}:${row.end}`;
    const previous = decisions.get(key);
    if (!previous || previous.decision !== 'adopt') decisions.set(key, { decision: row.decision, reason: row.reason, ...(row.messageId ? { messageId: row.messageId } : {}) });
  }
  for (const point of inventory.usagePoints) {
    const review = decisions.get(`${point.start}:${point.end}`);
    if (review) point.review = review;
  }
}

function inventoryReportPath(sourceIdentity: string): string {
  if (!/^[a-f0-9]{64}$/.test(sourceIdentity)) throw new BuildError('SOURCE_MISMATCH', 'Invalid source identity for inventory');
  return path.join(agyctlHome(), 'localization', 'inventory', `${sourceIdentity}.json`);
}

function artifactDirectory(artifactId: string): string {
  return path.join(agyctlHome(), 'localization', 'artifacts', artifactId);
}

function writeArtifactDirectory(
  artifactId: string,
  files: Record<string, string>,
): string {
  const directory = artifactDirectory(artifactId);
  const existing = fs.existsSync(directory);
  if (existing) {
    for (const [name, contents] of Object.entries(files)) {
      const file = path.join(directory, name);
      if (!fs.existsSync(file)) throw new BuildError('SOURCE_MISMATCH', `Artifact ${artifactId} is incomplete: ${name} missing`);
      if (fs.readFileSync(file, 'utf8') !== contents)
        throw new BuildError('SOURCE_MISMATCH', `Artifact ${artifactId} already exists with different content; refusing overwrite`);
    }
    return directory;
  }
  const staging = `${directory}.staging-${process.pid}-${Date.now()}`;
  fs.mkdirSync(staging, { recursive: true });
  try {
    for (const [name, contents] of Object.entries(files))
      fs.writeFileSync(path.join(staging, name), contents, { flag: 'wx' });
    // Only an artifact that passes the same verification as select and the runtime is published.
    readValidatedArtifact(staging, { artifactId });
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    fs.renameSync(staging, directory);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return directory;
}

export type CliLogInfo = CommandLogInfo;

/**
 * Per-command JSONL log (continuation plan §4.1). Mutating commands require
 * the writer up front: when it cannot be created the command fails with
 * LOG_WRITE_FAILED before writing anything. Read-only commands continue
 * without a log and report `log: null`.
 */
class CliLog extends LocalizationCommandLog {
  constructor(installationId: string | null, required: boolean) {
    super({
      directory: path.join(agyctlHome(), 'localization', 'logs', installationId ?? 'offline'),
      component: 'cli',
      installationId: installationId ?? undefined,
      required,
    });
  }
}

function logFailureField(log: CliLog): { logWriteFailed?: true } {
  return log.failure() ? { logWriteFailed: true } : {};
}

/** Deterministic, review-friendly JSON: recursively sorted keys, 2-space indent. */
function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize);
    if (typeof input === 'object' && input !== null) {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, canonicalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(canonicalize(value), null, 2);
}

export async function runLocalizationCommand(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  const value = (flag: string): string | undefined => {
    const index = rest.indexOf(flag);
    if (index < 0) return undefined;
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    return next;
  };
  const has = (flag: string): boolean => rest.includes(flag);
  let activeLog: CliLog | null = null;
  try {
    if (command === 'inspect') {
      const sourceHint = { ls: value('--ls'), sampleDir: value('--sample-dir') };
      const log = new CliLog(resolveSourceInstallation(sourceHint), false);
      activeLog = log;
      log.sink({ level: 'info', stage: 'source.observe', event: 'started', result: 'started' });
      const profile = resolveProfile(value('--profile'), sourceHint);
      const observed = observeSource(sourceHint, profile);
      const matchedProfile = observed.matchedProfileId ? resolveProfile(observed.matchedProfileId) : null;
      for (const warning of observed.warnings)
        log.sink({ level: 'warn', stage: 'source.observe', event: 'warning', result: 'warn', code: warning.code, detail: warning.message });
      log.sink({
        level: 'info',
        stage: 'source.observe',
        event: 'completed',
        result: 'ok',
        sourceIdentity: observed.sourceIdentity,
        counts: { assets: Object.keys(observed.assets).length },
      });
      log.close();
      const report = {
        // Capability, test evidence and warnings are reported separately;
        // version evidence is not installation qualification (plan §5.1).
        selectedProfileId: profile.profileId,
        profileStatus: profile.status,
        installationQualified: observed.matchedProfileId === profile.profileId,
        matchedProfileId: observed.matchedProfileId,
        sourceKind: observed.sourceKind,
        sourceIdentity: observed.sourceIdentity,
        lsSha256: observed.lsSha256,
        expectedLsSha256: profile.lsSha256,
        identityDrift: observed.lsSha256 !== null && observed.lsSha256 !== profile.lsSha256,
        sources: Object.fromEntries(Object.entries(observed.assets).map(([name, entry]) => [name, entry.sha256])),
        archive: observed.archive,
        nlsHelperCalleeName: observed.nlsHelperCalleeName,
        capabilities: {
          extract: Object.keys(observed.assets).length > 0,
          transform: observed.nlsHelperCalleeName !== null || observed.matchedProfileId !== null,
          usagePoints: resolveUsageRules(profile, observed.assets['main.js']?.sha256).length,
        },
        testEvidence: {
          profileStatus: matchedProfile?.status ?? null,
          verified: matchedProfile?.status === 'verified',
        },
        warnings: observed.warnings,
        log: log.describe(),
        ...logFailureField(log),
      };
      console.log(JSON.stringify(report, null, 2));
      return 0;
    }
    if (command === 'prepare') {
      const sourceHint = { ls: value('--ls'), sampleDir: value('--sample-dir') };
      const locale = value('--locale') ?? (has('--probe') ? 'en' : undefined);
      if (!locale) throw new Error('prepare requires --locale LOCALE or --probe');
      const probe = has('--probe') || locale === 'en';
      const log = new CliLog(resolveSourceInstallation(sourceHint), true);
      activeLog = log;
      log.sink({ level: 'info', stage: 'source.observe', event: 'started', result: 'started' });
      const profile = resolveProfile(value('--profile'), sourceHint);
      const observed = observeSource(sourceHint, profile);
      if (value('--profile') !== undefined) validateProfileAssets(observed.assets, profile);
      for (const warning of observed.warnings)
        log.sink({ level: 'warn', stage: 'source.observe', event: 'warning', result: 'warn', code: warning.code, detail: warning.message });
      const main = observed.assets['main.js'];
      if (!main)
        throw new BuildError(
              'CAPABILITY_GAP',
              'The observed source has no main.js asset; this build cannot be prepared',
            );
      const helperCalleeName = resolveHelperCallee(observed, profile);
      log.sink({
        level: 'info',
        stage: 'source.observe',
        event: 'completed',
        result: 'ok',
        sourceIdentity: observed.sourceIdentity,
        member: 'main.js',
        counts: { assets: Object.keys(observed.assets).length },
      });
        const rules = resolveUsageRules(profile, main.sha256);
        const catalog = loadCatalog();
        const translations = probe ? undefined : loadLocale(locale);
        let localeId = 'en';
        let formatLocaleId = 'en';
        if (!probe) {
          if (!translations) throw new BuildError('CATALOG_INVALID', 'Locale data is missing');
          localeId = translations.locale;
          formatLocaleId = translations.formatLocale ?? translations.locale;
        }
        log.sink({
          level: 'info',
          stage: 'transform',
          event: 'started',
          result: 'started',
          locale: localeId,
          counts: { rules: rules.length },
          detail: probe ? 'probe artifact: identity text, zero edits' : undefined,
        });
        const inventory = buildInventory({ file: 'main.js', source: main.text, sourceIdentity: observed.sourceIdentity, sourceBinarySha256: observed.lsSha256, helperCalleeName, vendors: loadVendorCatalogs() });
        applyInventoryReviews(inventory);
        const result = transformAsset({ source: main.text, file: 'main.js', rules, helperCalleeName, translations, catalog,
          formatterRuntime: fs.readFileSync(path.join(REPO_ROOT, 'dist', 'localization', 'bundle', 'message-runtime.js'), 'utf8'),
        });
        for (const row of result.applied) {
          const expected = rules
            .filter((rule) => rule.messageId === row.messageId)
            .reduce((sum, rule) => sum + rule.expectedHits, 0);
          log.sink({
            level: 'info',
            stage: 'transform',
            event: 'applied',
            result: 'applied',
            locale: localeId,
            messageId: row.messageId,
            member: 'main.js',
            counts: { expected, actual: row.hits },
          });
        }
        for (const edit of result.edits ?? []) log.sink({
          level: 'debug', stage: 'transform.edit', event: 'applied', result: probe ? 'probe' : 'applied',
          locale: localeId, messageId: edit.messageId, member: 'main.js', sourceIdentity: observed.sourceIdentity,
          counts: { start: edit.start, end: edit.end, expected: 1, actual: 1 },
        });
        log.sink({
          level: 'info',
          stage: 'transform',
          event: 'completed',
          result: probe ? 'probe' : 'ok',
          locale: localeId,
          counts: { messages: result.applied.length, replacements: result.applied.reduce((sum, row) => sum + row.hits, 0) },
        });
        // The generated artifact must still be strictly parseable JavaScript.
        parse(result.text.replace(/globalThis\.__AGYCTL_[A-Z_]+__ = '[^']*';/g, ''), { ecmaVersion: 'latest', sourceType: 'script' });
        const built = buildArtifact(
          {
            profileId: observed.matchedProfileId ?? observedProfileId(observed.sourceIdentity),
            adapterVersion: profile.adapterVersion,
            toolchainSha256: toolchainSha256(),
            locale: localeId,
            formatLocale: formatLocaleId,
            source: { file: 'main.js', sha256: main.sha256 },
            sourceBinarySha256: observed.lsSha256,
            sourceIdentity: observed.sourceIdentity,
            catalog,
            translations,
            inventory,
            rules,
          },
          result,
        );
        log.markMutating();
        const artifactFiles: Record<string, string> = {
          'main.js': built.text,
          'manifest.json': `${stableStringify(built.manifest)}\n`,
          'coverage.json': `${stableStringify(built.coverage)}\n`,
          'inventory.json': `${stableStringify(inventory)}\n`,
          'rules.json': `${stableStringify(rules)}\n`,
        };
        if (built.nativeJson !== null) artifactFiles['native.json'] = built.nativeJson;
        const directory = writeArtifactDirectory(built.manifest.artifactId, artifactFiles);
        log.sink({
          level: 'info',
          stage: 'artifact.publish',
          event: 'completed',
          result: 'published',
          artifactId: built.manifest.artifactId,
          locale: localeId,
          counts: { files: Object.keys(artifactFiles).length },
        });
        log.close();
        const report = {
          artifactId: built.manifest.artifactId,
          directory,
          probe: built.coverage.probe,
          applied: result.applied,
          locale: built.manifest.locale,
          profileStatus: profile.status,
          installationQualified: observed.matchedProfileId === profile.profileId,
          sourceBinarySha256: observed.lsSha256,
          sourceIdentity: observed.sourceIdentity,
          warnings: observed.warnings,
          log: log.describe(),
          ...logFailureField(log),
        };
        console.log(JSON.stringify(report, null, 2));
        return 0;
    }
    if (command === 'validate') {
      const directory = value('--artifact-dir');
      if (!directory) throw new Error('validate requires --artifact-dir PATH');
      const log = new CliLog(null, false);
      activeLog = log;
        log.sink({ level: 'info', stage: 'artifact.validate', event: 'started', result: 'started' });
        const { manifest, assets } = readValidatedArtifact(directory);
        for (const body of assets.values()) parse(body.toString('utf8'), { ecmaVersion: 'latest', sourceType: 'script' });
        log.sink({
          level: 'info',
          stage: 'artifact.validate',
          event: 'completed',
          result: 'ok',
          artifactId: manifest.artifactId,
        });
        log.close();
        const report = { artifactId: manifest.artifactId, valid: true, log: log.describe(), ...logFailureField(log) };
        console.log(JSON.stringify(report, null, 2));
        return 0;
    }
    if (command === 'inventory') {
      const sourceHint = { ls: value('--ls'), sampleDir: value('--sample-dir') };
      const log = new CliLog(resolveSourceInstallation(sourceHint), true);
      activeLog = log;
      log.sink({ level: 'info', stage: 'inventory', event: 'started', result: 'started' });
      const profile = resolveProfile(value('--profile'), sourceHint);
      const observed = observeSource(sourceHint, profile);
      for (const warning of observed.warnings)
        log.sink({ level: 'warn', stage: 'source.observe', event: 'warning', result: 'warn', code: warning.code, detail: warning.message });
      const main = observed.assets['main.js'];
      if (!main)
        throw new BuildError(
          'CAPABILITY_GAP',
          'The observed source has no main.js asset; the web inventory cannot be built',
        );
      const helperCalleeName = observed.nlsHelperCalleeName ?? (observed.matchedProfileId === profile.profileId ? profile.nlsHelper.calleeName : null);
      log.sink({
        level: 'info',
        stage: 'inventory',
        event: 'parsing',
        result: 'started',
        sourceIdentity: observed.sourceIdentity,
        member: 'main.js',
        detail: `helper=${helperCalleeName ?? 'none'}`,
      });
      const report = buildInventory({
        file: 'main.js',
        source: main.text,
        sourceIdentity: observed.sourceIdentity,
        sourceBinarySha256: observed.lsSha256,
        helperCalleeName,
        vendors: loadVendorCatalogs(),
      });
      applyInventoryReviews(report);
      log.markMutating();
      const outPath = value('--out') ?? inventoryReportPath(observed.sourceIdentity);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      const reportText = `${stableStringify(report)}\n`;
      if (fs.existsSync(outPath)) {
        if (fs.readFileSync(outPath, 'utf8') !== reportText) throw new BuildError('SOURCE_MISMATCH', 'Inventory output already exists with different content');
      } else fs.writeFileSync(outPath, reportText, { flag: 'wx' });
      log.sink({
        level: 'info',
        stage: 'inventory',
        event: 'completed',
        result: 'ok',
        sourceIdentity: observed.sourceIdentity,
        counts: {
          uniqueLiterals: report.totals.uniqueLiterals,
          vendorMatchedEntries: report.totals.vendorMatchedEntries,
          nlsDistinctDefaults: report.totals.nlsDistinctDefaults,
        },
      });
      log.close();
      const summary = {
        schemaVersion: report.schemaVersion,
        file: report.file,
        sourceIdentity: report.sourceIdentity,
        sourceBinarySha256: report.sourceBinarySha256,
        helperCalleeName: report.helperCalleeName,
        totals: report.totals,
        reportPath: outPath,
        warnings: observed.warnings,
        log: log.describe(),
        ...logFailureField(log),
      };
      console.log(JSON.stringify(summary, null, 2));
      return 0;
    }
    if (command === 'select') {
      const artifactId = value('--artifact');
      if (!artifactId) throw new Error('select requires --artifact ARTIFACT_ID');
      if (!/^[a-f0-9]{64}$/.test(artifactId)) throw new Error('select requires a 64-hex artifact id');
      const directory = artifactDirectory(artifactId);
      const { manifest } = readValidatedArtifact(directory, { artifactId });
      const installation = value('--installation');
      const explicitInstallationId = value('--installation-id');
      let installationId: string;
      if (explicitInstallationId) {
        if (installation || !/^[a-f0-9]{64}$/.test(explicitInstallationId)) throw new Error('--installation-id requires a 64-hex id and cannot be combined with --installation');
        installationId = explicitInstallationId;
      } else if (installation) {
        const targets = installedTargets();
        const match = targets.find((target) => target.asarPath === installation);
        if (!match) throw new Error(`Unknown installation: ${installation}`);
        installationId = sha256Text(match.asarPath);
      } else {
        const targets = installedTargets();
        if (targets.length !== 1) throw new Error('Multiple installations exist; pass --installation ABS_ASAR_PATH');
        installationId = sha256Text(targets[0].asarPath);
      }
      const log = new CliLog(installationId, true);
      activeLog = log;
        log.sink({
          level: 'info',
          stage: 'selection',
          event: 'started',
          result: 'started',
          artifactId,
          locale: manifest.locale,
          installationId,
        });
        log.markMutating();
        const selectionPath = path.join(agyctlHome(), 'localization', 'installations', installationId, 'selection.json');
        const expectedSelection = value('--expected-selection-sha256');
        if (expectedSelection !== undefined && expectedSelection !== 'absent' && !/^[a-f0-9]{64}$/.test(expectedSelection)) throw new Error('Invalid expected selection digest');
        const selection = {
          schemaVersion: 1,
          installationId,
          artifactId: manifest.artifactId,
          locale: manifest.locale,
          selectedAt: new Date().toISOString(),
        };
        fs.mkdirSync(path.dirname(selectionPath), { recursive: true });
        const staging = `${selectionPath}.staging-${process.pid}`;
        const lock = `${selectionPath}.lock`;
        let descriptor: number;
        try { descriptor = fs.openSync(lock, 'wx'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new BuildError('SOURCE_MISMATCH', `Another selection operation owns ${lock}; selection was not changed`);
          throw error;
        }
        try {
          const actual = fs.existsSync(selectionPath) ? sha256File(selectionPath) : 'absent';
          if (expectedSelection !== undefined && actual !== expectedSelection) throw new BuildError('SOURCE_MISMATCH', 'Localization selection changed after review');
          fs.writeFileSync(staging, `${stableStringify(selection)}\n`, { flag: 'wx' });
          fs.renameSync(staging, selectionPath);
        } finally {
          fs.closeSync(descriptor);
          fs.rmSync(staging, { force: true });
          fs.rmSync(lock);
        }
        log.sink({
          level: 'info',
          stage: 'selection',
          event: 'completed',
          result: 'selected',
          artifactId: manifest.artifactId,
          locale: manifest.locale,
          installationId,
        });
        log.close();
        const report = { selected: true, selectionPath, locale: manifest.locale, log: log.describe(), ...logFailureField(log) };
        console.log(JSON.stringify(report, null, 2));
        return 0;
    }
    if (command === 'status') {
      const installation = value('--installation');
      const targets = installedTargets();
      const target = installation
        ? targets.find((entry) => entry.asarPath === installation)
        : targets.length === 1 ? targets[0] : undefined;
      if (!installation && targets.length > 1) throw new Error('Multiple installations exist; pass --installation ABS_ASAR_PATH');
      if (!target) throw new Error('No Antigravity installation found');
      const installationId = sha256Text(target.asarPath);
      const log = new CliLog(installationId, false);
      activeLog = log;
        const selectionPath = path.join(agyctlHome(), 'localization', 'installations', installationId, 'selection.json');
        const selection = fs.existsSync(selectionPath)
          ? decodeSelectionSnapshot(JSON.parse(fs.readFileSync(selectionPath, 'utf8')), selectionPath)
          : null;
        if (selection && selection.installationId !== installationId) throw new Error('Selection belongs to another installation');
        // Last-known runtime evidence from the Host process; never a live claim.
        const lastKnownRuntime = readRuntimeStatus(
          path.join(agyctlHome(), 'localization', 'installations', installationId, 'runtime-status.json'),
        );
        log.sink({
          level: 'info',
          stage: 'status',
          event: 'completed',
          result: selection ? 'selected' : 'none',
          installationId,
          ...(selection ? { artifactId: selection.artifactId, locale: selection.locale } : {}),
        });
        log.close();
        const report = {
          installationId,
          asarPath: target.asarPath,
          selected: selection,
          artifactDirectory: selection ? artifactDirectory(selection.artifactId) : null,
          lastKnownRuntime: 'status' in lastKnownRuntime ? lastKnownRuntime.status : null,
          ...('status' in lastKnownRuntime ? {} : { lastKnownRuntimeNote: lastKnownRuntime.error }),
          log: log.describe(),
          ...logFailureField(log),
        };
        console.log(JSON.stringify(report, null, 2));
        return 0;
    }
    if (command === 'vendor:import') {
      const vendorRoot = value('--vendor-root') ?? path.join(REPO_ROOT, 'vendor-src');
      const out = value('--out') ?? path.join(REPO_ROOT, 'src', 'localization', 'catalogs', 'vendor');
      const previous = value('--previous');
      const log = new CliLog(null, true);
      activeLog = log;
      log.sink({
        level: 'info',
        stage: 'vendor.import',
        event: 'started',
        result: 'started',
        detail: `vendorRoot=${vendorRoot}`,
      });
      const imported = importVendorDictionaries({ vendorRoot });
      const summary = summarizeVendorImport(imported);
      const diffs: Partial<Record<VendorLocale, ReturnType<typeof diffVendorLocaleCatalogs>>> = {};
      if (previous) {
        for (const locale of Object.keys(imported.localeCatalogs) as VendorLocale[]) {
          const previousFile = path.join(previous, `${locale}.json`);
          if (!fs.existsSync(previousFile)) continue;
          diffs[locale] = diffVendorLocaleCatalogs(
            JSON.parse(fs.readFileSync(previousFile, 'utf8')) as VendorLocaleCatalog,
            imported.localeCatalogs[locale],
          );
        }
      }
      for (const source of summary.jsonSources)
        log.sink({
          level: 'info',
          stage: 'vendor.import',
          event: 'source.completed',
          result: 'ok',
          locale: source.locale,
          counts: {
            files: source.files,
            physicalPairs: source.physicalPairs,
            uniqueKeys: source.uniqueKeys,
            crossFileConflicts: source.crossFileConflictingKeys,
          },
        });
      log.markMutating();
      fs.mkdirSync(out, { recursive: true });
      const manifest = {
        ...summary,
        ...(previous ? { previousComparison: diffs } : {}),
      };
      const written: string[] = [];
      for (const locale of Object.keys(imported.localeCatalogs) as VendorLocale[]) {
        const file = path.join(out, `${locale}.json`);
        fs.writeFileSync(file, `${canonicalJson(imported.localeCatalogs[locale])}\n`);
        written.push(file);
      }
      const manifestPath = path.join(out, 'import-manifest.json');
      fs.writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`);
      written.push(manifestPath);
      log.sink({
        level: 'info',
        stage: 'vendor.import',
        event: 'completed',
        result: 'ok',
        counts: { unionKeys: summary.union.keys, written: written.length },
      });
      log.close();
      console.log(
        JSON.stringify(
          {
            written,
            summary: manifest as VendorImportSummary,
            log: log.describe(),
            ...logFailureField(log),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    throw new Error('Usage: localization.mjs inspect|prepare|validate|inventory|select|status|vendor:import [--json] ...');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof BuildError || error instanceof LoggingError || error instanceof ArtifactError ? error.code : undefined;
    if (activeLog) {
      try {
        activeLog.sink({
          level: 'error',
          stage: 'command',
          event: 'failed',
          result: 'failed',
          ...(code ? { code } : {}),
          detail: message,
        });
      } catch {
        /* best-effort terminal event; the original error governs */
      }
      activeLog.close();
    }
    console.log(JSON.stringify({ error: message, ...(code ? { code } : {}), ...(activeLog ? { log: activeLog.describe(), ...logFailureField(activeLog) } : {}) }));
    if (!json) console.error(`Error: ${message}`);
    return 1;
  }
}
