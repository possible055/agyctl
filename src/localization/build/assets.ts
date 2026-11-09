import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { parse } from 'acorn';
import { inflateRawSync } from 'node:zlib';

export class BuildError extends Error {
  constructor(
    readonly code:
      | 'CATALOG_INVALID'
      | 'PROFILE_INVALID'
      | 'SOURCE_MISMATCH'
      | 'ARCHIVE_INVALID'
      | 'VENDOR_INVALID'
      | 'CAPABILITY_GAP',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'BuildError';
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface ProfileAsset {
  sha256: string;
  size: number;
}

export interface LocalizationProfile {
  profileId: string;
  status: string;
  product: string;
  channel: string;
  platform: string;
  version: string;
  electron: string;
  adapterVersion: string;
  lsSha256: string;
  asarSha256?: string;
  exeSha256?: string;
  nlsHelper: { calleeName: string };
  assets: Record<string, ProfileAsset>;
  limits: { maxEntryBytes: number; maxEntries: number; maxTotalBytes: number };
}

/** Loads and validates the build profile database; placeholder hashes are refused. */
export function loadProfiles(databasePath: string): LocalizationProfile[] {
  const parsed = JSON.parse(fs.readFileSync(databasePath, 'utf8')) as {
    schema?: number;
    profiles?: unknown;
  };
  if (parsed.schema !== 1 || !Array.isArray(parsed.profiles))
    throw new BuildError('PROFILE_INVALID', `Unsupported profiles database: ${databasePath}`);
  const profiles: LocalizationProfile[] = [];
  for (const raw of parsed.profiles) {
    const profile = raw as LocalizationProfile;
    if (typeof profile.profileId !== 'string' || !profile.profileId)
      throw new BuildError('PROFILE_INVALID', 'Profile is missing its id');
    for (const field of ['lsSha256'] as const) {
      if (typeof profile[field] !== 'string' || !HASH_PATTERN.test(profile[field]))
        throw new BuildError('PROFILE_INVALID', `Profile ${profile.profileId} has an invalid ${field}`);
    }
    for (const field of ['asarSha256', 'exeSha256'] as const) {
      if ((profile.status === 'verified' || profile[field] !== undefined) && !HASH_PATTERN.test(profile[field] ?? ''))
        throw new BuildError('PROFILE_INVALID', `Profile ${profile.profileId} has an invalid ${field}`);
    }
    for (const [name, asset] of Object.entries(profile.assets ?? {})) {
      if (!HASH_PATTERN.test(asset.sha256) || typeof asset.size !== 'number')
        throw new BuildError('PROFILE_INVALID', `Profile ${profile.profileId} asset ${name} has invalid identity fields`);
    }
    if (
      !profile.limits ||
      typeof profile.limits.maxEntryBytes !== 'number' ||
      typeof profile.limits.maxEntries !== 'number' ||
      typeof profile.limits.maxTotalBytes !== 'number'
    )
      throw new BuildError('PROFILE_INVALID', `Profile ${profile.profileId} is missing extraction limits`);
    profiles.push(profile);
  }
  return profiles;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256File(filePath: string): string {
  const handle = fs.openSync(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytesRead));
    return hash.digest('hex');
  } finally {
    fs.closeSync(handle);
  }
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  crc32: number;
  localHeaderOffset: number;
}

interface ExtractionLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

interface LocatedArchive {
  entries: Map<string, ZipEntry>;
  base: number;
  entryCount: number;
  totalUncompressedBytes: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function assertSafeName(name: string): void {
  if (!name || name.includes('\\') || name.includes('//') || name.includes(':'))
    throw new BuildError('ARCHIVE_INVALID', `Unsafe ZIP entry name: ${name}`);
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    throw new BuildError('ARCHIVE_INVALID', `Unsafe ZIP entry name: ${name}`);
}

/** Fully validates one EOCD candidate: the central directory must parse
 * exactly, end precisely at the EOCD, and every entry must keep its local
 * header and data before the central directory. */
function tryLocateAtEocd(data: Buffer, limits: ExtractionLimits, eocd: number): LocatedArchive | null {
  if (eocd < 0 || eocd + 22 > data.length) return null;
  if (data.readUInt32LE(eocd) !== EOCD_SIGNATURE) return null;
  const commentLength = data.readUInt16LE(eocd + 20);
  if (eocd + 22 + commentLength > data.length) return null;
  const entryCount = data.readUInt16LE(eocd + 10);
  if (entryCount > limits.maxEntries) return null;
  const centralStart = data.readUInt32LE(eocd + 16);
  const centralSize = data.readUInt32LE(eocd + 12);
  // ZIP offsets are relative to the archive start; the archive may sit at any
  // offset inside the host binary, so derive the base from the EOCD position
  // (the EOCD begins immediately after the central directory).
  const base = eocd - (centralStart + centralSize);
  if (base < 0 || centralStart + centralSize > eocd) return null;
  let offset = base + centralStart;
  const entries = new Map<string, ZipEntry>();
  let totalUncompressedBytes = 0;
  for (let index = 0; index < entryCount; index++) {
    if (offset + 46 > eocd || data.readUInt32LE(offset) !== CENTRAL_SIGNATURE) return null;
    const method = data.readUInt16LE(offset + 10);
    const crc32Value = data.readUInt32LE(offset + 16);
    const compressedSize = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLengthCentral = data.readUInt16LE(offset + 32);
    const localHeaderOffset = base + data.readUInt32LE(offset + 42);
    if (offset + 46 + nameLength + extraLength + commentLengthCentral > eocd) return null;
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (!name || name.includes('\\') || name.includes(':')) return null;
    const directory = name.endsWith('/');
    if (directory && (size !== 0 || compressedSize !== 0)) return null;
    const parts = (directory ? name.slice(0, -1) : name).split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
    if (entries.has(name)) return null;
    if (size > limits.maxEntryBytes) return null;
    // Every local header and its data must live inside the archive, before
    // the central directory (continuation plan §5.2 boundary evidence).
    if (localHeaderOffset < base || localHeaderOffset + 30 + nameLength + extraLength + compressedSize > base + centralStart)
      return null;
    totalUncompressedBytes += size;
    if (totalUncompressedBytes > limits.maxTotalBytes) return null;
    entries.set(name, { name, method, compressedSize, size, crc32: crc32Value, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLengthCentral;
  }
  if (offset !== base + centralStart + centralSize) return null;
  return { entries, base, entryCount, totalUncompressedBytes };
}

/**
 * Locates the embedded ZIP structurally: every EOCD candidate in the whole
 * binary is validated against its complete central directory, members and
 * boundaries, and exactly one candidate must survive. Neither a hard-coded
 * offset nor "the first PK" is ever trusted (continuation plan §5.2).
 */
function locateArchive(data: Buffer, limits: ExtractionLimits, assetNames: string[]): LocatedArchive {
  const signature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const candidates: number[] = [];
  let searchEnd = data.length - 1;
  for (;;) {
    const index = data.lastIndexOf(signature, searchEnd);
    if (index < 0) break;
    candidates.push(index);
    if (candidates.length > 4096)
      throw new BuildError('ARCHIVE_INVALID', 'Too many embedded ZIP end-of-central-directory candidates');
    if (index === 0) break;
    searchEnd = index - 1;
  }
  const located: LocatedArchive[] = [];
  for (const eocd of candidates) {
    const result = tryLocateAtEocd(data, limits, eocd);
    if (result && assetNames.every((name) => result.entries.has(name))) located.push(result);
  }
  if (located.length === 0)
    throw new BuildError('ARCHIVE_INVALID', 'ZIP end-of-central-directory not found or invalid');
  if (located.length > 1)
    throw new BuildError(
      'ARCHIVE_INVALID',
      `Multiple structurally valid embedded ZIP archives found (${located.length}); the candidate is ambiguous`,
    );
  return located[0];
}

function extractEntry(data: Buffer, entry: ZipEntry): Buffer {
  const localSignature = 0x04034b50;
  const header = entry.localHeaderOffset;
  if (header + 30 > data.length || data.readUInt32LE(header) !== localSignature)
    throw new BuildError('ARCHIVE_INVALID', `ZIP local header missing for ${entry.name}`);
  const nameLength = data.readUInt16LE(header + 26);
  const extraLength = data.readUInt16LE(header + 28);
  const start = header + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > data.length) throw new BuildError('ARCHIVE_INVALID', `ZIP entry ${entry.name} is truncated`);
  const compressed = data.subarray(start, end);
  let bytes: Buffer;
  if (entry.method === 0) bytes = Buffer.from(compressed);
  else if (entry.method === 8) bytes = inflateRawSync(compressed, { maxOutputLength: entry.size + 1 });
  else throw new BuildError('ARCHIVE_INVALID', `Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
  if (bytes.length !== entry.size)
    throw new BuildError('ARCHIVE_INVALID', `ZIP entry ${entry.name} decompressed size mismatch`);
  if (crc32(bytes) !== entry.crc32)
    throw new BuildError('ARCHIVE_INVALID', `ZIP entry ${entry.name} failed its CRC check`);
  return bytes;
}

export interface ExtractedSource {
  bytes: Buffer;
  text: string;
  sha256: string;
}

/** Extracts profile assets; only asset identities gate admission, not the enclosing binary. */
export function extractProfileAssets(lsBinaryPath: string, profile: LocalizationProfile): Record<string, ExtractedSource> {
  const data = fs.readFileSync(lsBinaryPath);
  const located = locateArchive(data, profile.limits, Object.keys(profile.assets));
  const results: Record<string, ExtractedSource> = {};
  for (const name of Object.keys(profile.assets)) {
    const entry = located.entries.get(name);
    if (!entry)
      throw new BuildError('ARCHIVE_INVALID', `Profile asset ${name} is missing from the embedded archive`);
    results[name] = extractObservedAsset(data, entry, name);
  }
  validateProfileAssets(results, profile);
  return results;
}

/** Validates the complete observed asset set without trusting a whole-binary identity. */
export function validateProfileAssets(assets: Record<string, ExtractedSource>, profile: LocalizationProfile): void {
  for (const [name, expected] of Object.entries(profile.assets)) {
    const asset = assets[name];
    if (!asset) throw new BuildError('SOURCE_MISMATCH', `Asset ${name} is missing for profile ${profile.profileId}`);
    if (asset.bytes.length !== expected.size)
      throw new BuildError('SOURCE_MISMATCH', `Asset ${name} size ${asset.bytes.length} does not match the profile`);
    if (asset.sha256 !== expected.sha256)
      throw new BuildError('SOURCE_MISMATCH', `Asset ${name} digest does not match the profile`);
  }
}

function matchesProfileAssets(assets: Record<string, ExtractedSource>, profile: LocalizationProfile): boolean {
  return Object.entries(profile.assets).every(([name, expected]) => {
    const asset = assets[name];
    return asset !== undefined && asset.sha256 === expected.sha256 && asset.bytes.length === expected.size;
  });
}

function decodeAsset(bytes: Buffer, name: string): ExtractedSource {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes))
    throw new BuildError('SOURCE_MISMATCH', `Asset ${name} is not strict UTF-8`);
  return { bytes, text, sha256: sha256Bytes(bytes) };
}

/**
 * Loads one Hub asset from an unpacked sample directory when no LS binary is
 * available. Identity checks are identical to the embedded-archive path.
 */
export function loadSampleAssets(assetDirectory: string, profile: LocalizationProfile): Record<string, ExtractedSource> {
  const results: Record<string, ExtractedSource> = {};
  for (const [name, expected] of Object.entries(profile.assets)) {
    const file = pathJoinSafe(assetDirectory, name);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      throw new BuildError('SOURCE_MISMATCH', `Sample asset ${name} is missing under ${assetDirectory}`);
    }
    if (bytes.length !== expected.size)
      throw new BuildError('SOURCE_MISMATCH', `Sample asset ${name} size ${bytes.length} does not match the profile`);
    const digest = sha256Bytes(bytes);
    if (digest !== expected.sha256)
      throw new BuildError('SOURCE_MISMATCH', `Sample asset ${name} digest does not match the profile`);
    results[name] = decodeAsset(bytes, name);
  }
  return results;
}

function pathJoinSafe(directory: string, relative: string): string {
  assertSafeName(relative);
  const resolved = `${directory}/${relative}`;
  if (!resolved.startsWith(directory))
    throw new BuildError('SOURCE_MISMATCH', `Sample asset path escapes its directory: ${relative}`);
  return resolved;
}

export type SourceWarningCode = 'UNTESTED_BUILD' | 'UNLISTED_BUILD' | 'IDENTITY_DRIFT';

export interface SourceWarning {
  code: SourceWarningCode;
  message: string;
  profileId?: string;
}

export interface ObservedSource {
  sourceKind: 'ls-binary' | 'sample-dir';
  lsSha256: string | null;
  assets: Record<string, ExtractedSource>;
  nlsHelperCalleeName: string | null;
  matchedProfileId: string | null;
  warnings: SourceWarning[];
  /** Deterministic content identity of what was actually read (plan §5.1). */
  sourceIdentity: string;
  archive: { entryCount: number; totalUncompressedBytes: number } | null;
}

export interface ObserveOptions {
  /** Recognition hints only; they never gate extraction (plan §5.1). */
  profiles: LocalizationProfile[];
  limits: ExtractionLimits;
  assetNames: string[];
}

function computeSourceIdentity(source: Omit<ObservedSource, 'sourceIdentity' | 'warnings' | 'matchedProfileId'>): string {
  const canonical = {
    sourceKind: source.sourceKind,
    lsSha256: source.lsSha256,
    nlsHelperCalleeName: source.nlsHelperCalleeName,
    archive: source.archive,
    assets: Object.fromEntries(
      Object.entries(source.assets)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, asset]) => [name, [asset.sha256, asset.bytes.length]]),
    ),
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

interface AcornNode {
  type: string;
  [key: string]: unknown;
}

/** Recognizes the NLS implementation or the reviewed key/default pair, never call frequency. */
export function detectNlsHelperCallee(mainJsText: string): string | null {
  const ast = parse(mainJsText, { ecmaVersion: 'latest', sourceType: 'script' }) as unknown as AcornNode;
  const defaults = new Map<string, Set<string>>();
  const implementations = new Set<string>();
  const visit = (node: AcornNode): void => {
    if (node.type === 'FunctionDeclaration') {
      const id = node.id as AcornNode | undefined;
      const body = node.body as AcornNode | undefined;
      if (id?.type === 'Identifier' && body) {
        const implementation = mainJsText.slice(Number(body.start), Number(body.end));
        if (implementation.includes('globalThis._VSCODE_NLS_MESSAGES') && implementation.includes('NLS MISSING:')) implementations.add(String(id.name));
      }
    }
    if (node.type === 'CallExpression') {
      const callee = node.callee as AcornNode | undefined;
      const args = node.arguments as AcornNode[] | undefined;
      if (callee?.type === 'Identifier' && args && args.length >= 2) {
        const [first, second] = args;
        if (first.type === 'Literal' && first.value === 'statusBarBackground' && second.type === 'Literal' && typeof second.value === 'string') {
          const values = defaults.get(callee.name as string) ?? new Set<string>();
          values.add(second.value);
          defaults.set(callee.name as string, values);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type') continue;
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child === 'object' && typeof (child as AcornNode).type === 'string')
            visit(child as AcornNode);
      } else if (value && typeof value === 'object' && typeof (value as AcornNode).type === 'string') {
        visit(value as AcornNode);
      }
    }
  };
  visit(ast);
  const candidates = new Set(implementations);
  for (const [name, values] of defaults) {
    if (values.has('Background color of the editor hover status bar.') && values.has('Status bar background color when a workspace or folder is opened. The status bar is shown in the bottom of the window.')) candidates.add(name);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function extractObservedAsset(data: Buffer, entry: ZipEntry, name: string): ExtractedSource {
  return decodeAsset(extractEntry(data, entry), name);
}

/**
 * Observes the Hub web assets inside a Language Server binary. The archive is
 * located structurally; a matching profile only adds recognition evidence and
 * strict asset-digest validation. Unknown or untested sources produce
 * warnings, never refusals (continuation plan §5.1).
 */
export function observeLsSource(lsBinaryPath: string, options: ObserveOptions): ObservedSource {
  const data = fs.readFileSync(lsBinaryPath);
  const lsSha256 = sha256Bytes(data);
  const located = locateArchive(data, options.limits, options.assetNames);
  const binaryProfile = options.profiles.find((entry) => entry.lsSha256 === lsSha256) ?? null;
  const assets: Record<string, ExtractedSource> = {};
  for (const name of options.assetNames) {
    const entry = located.entries.get(name);
    if (!entry) continue;
    assets[name] = extractObservedAsset(data, entry, name);
  }
  if (binaryProfile) validateProfileAssets(assets, binaryProfile);
  const profile = binaryProfile ?? options.profiles.find((entry) => matchesProfileAssets(assets, entry)) ?? null;
  const warnings: SourceWarning[] = [];
  if (!profile)
    warnings.push({
      code: 'UNLISTED_BUILD',
      message: `The Language Server source matches no profile assets; observation is not installation qualification (sha256 ${lsSha256})`,
    });
  if (profile && profile.lsSha256 !== lsSha256)
    warnings.push({
      code: 'IDENTITY_DRIFT',
      message: `Profile ${profile.profileId} assets match, but Language Server identity drifted: expected ${profile.lsSha256}, observed ${lsSha256}`,
      profileId: profile.profileId,
    });
  if (profile && profile.status !== 'verified')
    warnings.push({
      code: 'UNTESTED_BUILD',
      message: `Profile ${profile.profileId} is ${profile.status}; proceeding with asset validation and warnings`,
      profileId: profile.profileId,
    });
  const nlsHelperCalleeName = profile?.nlsHelper.calleeName ?? (assets['main.js'] ? detectNlsHelperCallee(assets['main.js'].text) : null);
  const observed = {
    sourceKind: 'ls-binary' as const,
    lsSha256,
    assets,
    nlsHelperCalleeName,
    archive: {
      entryCount: located.entryCount,
      totalUncompressedBytes: located.totalUncompressedBytes,
    },
  };
  return {
    ...observed,
    matchedProfileId: profile?.profileId ?? null,
    warnings,
    sourceIdentity: computeSourceIdentity(observed),
  };
}

/** Enumerates textual web members for offline coverage review without executing them. */
export function inspectEmbeddedWebAssets(lsBinaryPath: string, options: ObserveOptions): Record<string, ExtractedSource> {
  const data = fs.readFileSync(lsBinaryPath);
  const located = locateArchive(data, options.limits, options.assetNames);
  const assets: Record<string, ExtractedSource> = {};
  for (const [name, entry] of located.entries) if (/\.(?:js|css|html)$/.test(name)) assets[name] = extractObservedAsset(data, entry, name);
  return assets;
}

/**
 * Observes Hub web assets from an unpacked sample directory. Profile matching
 * works from the asset digests; unmatched sources carry an UNLISTED_BUILD
 * warning and their own content identity.
 */
export function observeSampleSource(assetDirectory: string, options: ObserveOptions): ObservedSource {
  const assets: Record<string, ExtractedSource> = {};
  for (const name of options.assetNames) {
    const file = pathJoinSafe(assetDirectory, name);
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    assets[name] = decodeAsset(bytes, name);
  }
  const profile =
    options.profiles.find((entry) => matchesProfileAssets(assets, entry)) ?? null;
  const warnings: SourceWarning[] = [];
  if (!profile)
    warnings.push({
      code: 'UNLISTED_BUILD',
      message: `The sample assets match no profile; proceeding on content recognition`,
    });
  else if (profile.status !== 'verified')
    warnings.push({
      code: 'UNTESTED_BUILD',
      message: `Profile ${profile.profileId} is ${profile.status}; proceeding with warnings`,
      profileId: profile.profileId,
    });
  const nlsHelperCalleeName = profile?.nlsHelper.calleeName ?? (assets['main.js'] ? detectNlsHelperCallee(assets['main.js'].text) : null);
  const observed = {
    sourceKind: 'sample-dir' as const,
    lsSha256: null,
    assets,
    nlsHelperCalleeName,
    archive: null,
  };
  return {
    ...observed,
    matchedProfileId: profile?.profileId ?? null,
    warnings,
    sourceIdentity: computeSourceIdentity(observed),
  };
}

/** The profile id for a source that matched no recorded profile. */
export function observedProfileId(sourceIdentity: string): string {
  return `observed-${sourceIdentity.slice(0, 12)}`;
}
