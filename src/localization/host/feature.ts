import path from 'node:path';
import { ComposerError, LOCALIZATION_BRIDGE_MARKER, isSha256 } from '../../host/contracts.js';
import { sha256, sha256File } from '../../host/hash.js';
import type { AdapterEdit, LocalizationFeatureInput } from '../../host/inputs.js';
import type { AsarEngineLike, HostFeature } from '../../host/features.js';
import { buildReviewedNativeEdits, engineRequirePath } from './native-adapters.js';
export { buildReviewedNativeEdits, engineRequirePath } from './native-adapters.js';

export interface LocalizationProfile {
  profileId: string;
  status: string;
  version?: string;
  platform?: string;
  asarSha256?: string;
  exeSha256?: string;
  hostAdapter?: { file: string; sha256: string; anchor: string };
  nativeAdapterVersion?: '2' | '3';
  nativeImageBinding?: boolean;
}

export function buildNativeInventory(engine: AsarEngineLike, originalPath: string, profile: LocalizationProfile) {
  if (profile.nativeAdapterVersion === undefined) return [];
  return buildReviewedNativeEdits(engine, originalPath, profile.nativeAdapterVersion).filter((edit) => edit.messageIds.length).map((edit) => ({
    usageId: sha256(Buffer.from(`${edit.sourceSha256}\0${edit.file}\0${edit.start}\0${edit.end}`)),
    file: edit.file,
    start: edit.start,
    end: edit.end,
    messageIds: edit.messageIds,
    sourceSha256: edit.sourceSha256,
    expectedHits: 1,
    actualHits: 1,
    status: 'unapplied',
  }));
}

/** Reads package data only; no archive member is executed. */
export function readLocalizationAppVersion(engine: AsarEngineLike, originalPath: string): string {
  let version: unknown;
  try {
    version = (JSON.parse(engine.extractFile(originalPath, 'package.json').toString('utf8')) as { version?: unknown }).version;
  } catch (error) {
    throw new ComposerError('SOURCE_MISMATCH', `Cannot read localization application version: ${String(error)}`);
  }
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
    throw new ComposerError('SOURCE_MISMATCH', 'Application package has no valid localization version');
  return version;
}

/** Selects an exact application version, then verifies its reviewed adapter contract. */
export function resolveLocalizationProfile<T extends LocalizationProfile>(
  profiles: T[],
  context: { engine: AsarEngineLike; originalPath: string; originalHash: string; executablePath?: string; profileId?: string; appVersion?: string },
): { profile: T; warnings: LocalizationQualificationWarning[] } {
  const appVersion = context.profileId ? undefined : context.appVersion ?? readLocalizationAppVersion(context.engine, context.originalPath);
  const platform = `${process.platform}-${process.arch}`;
  const candidates = profiles.filter((profile) => context.profileId ? profile.profileId === context.profileId : profile.version === appVersion && (profile.platform === undefined || profile.platform === platform));
  if (!candidates.length)
    throw new ComposerError('SOURCE_MISMATCH', context.profileId ? `Unknown localization profile: ${context.profileId}` : `No reviewed localization profile for application version ${appVersion} on ${platform}`);
  const qualified: T[] = [];
  const failures: string[] = [];
  for (const profile of candidates) {
    try {
      const adapter = profile.hostAdapter;
      if (!adapter) throw new Error('Missing reviewed Host delivery adapter');
      const source = context.engine.extractFile(context.originalPath, adapter.file).toString('utf8');
      const start = source.indexOf(adapter.anchor);
      if (start < 0 || source.indexOf(adapter.anchor, start + 1) >= 0) throw new Error(`Host delivery anchor missing or ambiguous in ${adapter.file}`);
      if (profile.nativeAdapterVersion !== undefined) buildReviewedNativeEdits(context.engine, context.originalPath, profile.nativeAdapterVersion);
      qualified.push(profile);
    } catch (error) { failures.push(`${profile.profileId}: ${String(error)}`); }
  }
  const contracts = new Map<string, T[]>();
  for (const profile of qualified) {
    const key = JSON.stringify({ adapter: { file: profile.hostAdapter?.file, anchor: profile.hostAdapter?.anchor }, nativeAdapterVersion: profile.nativeAdapterVersion });
    contracts.set(key, [...(contracts.get(key) ?? []), profile]);
  }
  if (contracts.size !== 1) throw new ComposerError('SOURCE_MISMATCH', contracts.size ? 'Ambiguous reviewed localization adapter contracts' : `No structurally qualified localization adapter: ${failures.join('; ') || 'no reviewed profiles'}`);
  const matching = [...contracts.values()][0];
  const profile = matching.find((entry) => entry.asarSha256 === context.originalHash) ?? matching[0];
  return { profile, ...qualifyLocalizationOriginal(profiles, context, context.originalHash, profile.profileId) };
}

function validateLocalizationInput(input: LocalizationFeatureInput): void {
  const { engineFile, preloadBridge, profileId, stateRoot } = input;
  if (!Buffer.isBuffer(engineFile) || engineFile.byteLength === 0)
    throw new ComposerError('HOST_CONFLICT', 'Localization engine bundle must be a nonempty buffer');
  if (!Buffer.isBuffer(preloadBridge) || preloadBridge.byteLength === 0)
    throw new ComposerError('HOST_CONFLICT', 'Localization preload bridge must be a nonempty buffer');
  if (typeof profileId !== 'string' || !profileId)
    throw new ComposerError('HOST_CONFLICT', 'Localization requires a profile id');
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot))
    throw new ComposerError('HOST_CONFLICT', 'Localization requires an absolute tool state root');
  for (const edit of input.adapterEdits ?? []) {
    if (typeof edit.file !== 'string' || !edit.file.startsWith('dist/'))
      throw new ComposerError('HOST_CONFLICT', `Adapter edit target must be an archive path: ${String(edit.file)}`);
    if (typeof edit.anchor !== 'string' || edit.anchor.length === 0)
      throw new ComposerError('HOST_CONFLICT', 'Adapter edit anchor must be a nonempty byte signature');
    const actions = [edit.insertBefore, edit.insertAfter, edit.replaceAnchor].filter(
      (action) => typeof action === 'string',
    ).length;
    if (actions !== 1)
      throw new ComposerError('HOST_CONFLICT', 'Adapter edit needs exactly one of insertBefore, insertAfter or replaceAnchor');
  }
  for (const name of Object.keys(input.files ?? {})) {
    if (!name.startsWith('dist/agyctl-localization/'))
      throw new ComposerError('HOST_CONFLICT', `Localization file entry escapes its directory: ${name}`);
    if (name === 'dist/agyctl-localization/host-engine.js')
      throw new ComposerError('HOST_CONFLICT', `Localization file entry conflicts with the reserved engine: ${name}`);
  }
  const observed = input.observedSource;
  if (observed !== undefined && observed !== null) {
    if (observed.sourceKind !== 'ls-binary' && observed.sourceKind !== 'sample-dir')
      throw new ComposerError('HOST_CONFLICT', 'Observed source has an invalid sourceKind');
    if (!isSha256(observed.sourceIdentity))
      throw new ComposerError('HOST_CONFLICT', 'Observed source has an invalid identity');
    if (!Array.isArray(observed.warnings))
      throw new ComposerError('HOST_CONFLICT', 'Observed source has invalid warnings');
  }

}

export interface LocalizationQualificationWarning {
  code: 'UNTESTED_BUILD' | 'IDENTITY_DRIFT';
  message: string;
}

/**
 * A profile supplies the adapter contract. Test status and enclosing file
 * identities are evidence only; structural and transaction gates still apply.
 */
function qualifyLocalizationOriginal(
  profiles: LocalizationProfile[],
  io: { executablePath?: string },
  originalHash: string,
  profileId?: string,
): { profileStatus: string; warnings: LocalizationQualificationWarning[] } {
  const profile = profiles.find((entry) => profileId === undefined ? entry.asarSha256 === originalHash : entry.profileId === profileId);
  if (!profile)
    throw new ComposerError('UNSUPPORTED_STATE', `No localization profile supplies a reviewed adapter contract for ${profileId ?? `archive ${originalHash}`}`);
  const warnings: LocalizationQualificationWarning[] = [];
  if (profile.status !== 'verified')
    warnings.push({
      code: 'UNTESTED_BUILD',
      message: `Profile ${profile.profileId} is ${profile.status}; installation still requires asset and structural preflight`,
    });
  if (profile.asarSha256 !== originalHash)
    warnings.push({
      code: 'IDENTITY_DRIFT',
      message: `Profile ${profile.profileId} archive identity differs: expected ${profile.asarSha256 ?? '(not recorded)'}, observed ${originalHash}; structural preflight remains required`,
    });
  const executableHash = io.executablePath ? sha256File(io.executablePath) : null;
  if (!executableHash || profile.exeSha256 !== executableHash)
    warnings.push({
      code: 'IDENTITY_DRIFT',
      message: `Profile ${profile.profileId} paired executable identity differs: expected ${profile.exeSha256 ?? '(not recorded)'}, observed ${executableHash ?? '(not provided)'}; paired executable and fuse qualification remain required`,
    });
  return { profileStatus: profile.status, warnings };
}

function applyAdapterEdits(
  io: { engine: AsarEngineLike },
  originalPath: string,
  edits: AdapterEdit[],
): Array<[string, Buffer]> {
  const byFile = new Map<string, AdapterEdit[]>();
  for (const edit of edits) {
    const fileEdits = byFile.get(edit.file) ?? [];
    fileEdits.push(edit);
    byFile.set(edit.file, fileEdits);
  }
  const applied: Array<[string, Buffer]> = [];
  for (const [file, fileEdits] of byFile) {
    const source = io.engine.extractFile(originalPath, file).toString('utf8');
    const resolved = fileEdits.map((edit) => {
      const start = source.indexOf(edit.anchor);
      if (start < 0)
        throw new ComposerError('SOURCE_MISMATCH', `Adapter anchor not found in ${file}: ${edit.anchor.slice(0, 80)}`);
      if (source.indexOf(edit.anchor, start + 1) >= 0)
        throw new ComposerError('SOURCE_MISMATCH', `Adapter anchor is not unique in ${file}: ${edit.anchor.slice(0, 80)}`);
      const insertion = edit.insertBefore ?? (edit.insertAfter as string);
      const text = edit.replaceAnchor ?? (edit.insertBefore !== undefined
        ? `${insertion}${edit.anchor}`
        : `${edit.anchor}${insertion}`);
      return { start, end: start + edit.anchor.length, text };
    }).sort((left, right) => left.start - right.start);
    let end = 0;
    const chunks: string[] = [];
    for (const edit of resolved) {
      if (edit.start < end)
        throw new ComposerError('SOURCE_MISMATCH', `Adapter anchors overlap in ${file}`);
      chunks.push(source.slice(end, edit.start), edit.text);
      end = edit.end;
    }
    chunks.push(source.slice(end));
    applied.push([file, Buffer.from(chunks.join(''), 'utf8')]);
  }
  return applied;
}

export function createLocalizationFeature(profiles: LocalizationProfile[]): HostFeature<LocalizationFeatureInput> {
  return {
    validate(input) {
      validateLocalizationInput(input);
      const profile = profiles.find((entry) => entry.profileId === input.profileId);
      const adapter = profile?.hostAdapter;
      if (adapter && (
        !input.adapterEdits?.some((edit) => edit.file === adapter.file && edit.anchor === adapter.anchor) ||
        !input.files?.['dist/agyctl-localization/runtime-config.json']
      ))
        throw new ComposerError('HOST_CONFLICT', 'This profile requires its reviewed runtime adapter and artifact configuration');
    },
    qualify: (input, context) => qualifyLocalizationOriginal(profiles, context, context.originalHash, input.profileId),
    compose(input, context) {
      const profile = profiles.find((entry) => entry.profileId === input.profileId);
      if (profile?.hostAdapter) resolveLocalizationProfile(profiles, { ...context, originalHash: sha256File(context.originalPath), profileId: input.profileId });
      const files = Object.fromEntries(applyAdapterEdits(context, context.originalPath, input.adapterEdits ?? []));
      for (const [file, bytes] of Object.entries(input.files ?? {})) {
        if (files[file]) throw new ComposerError('HOST_CONFLICT', 'Localization contributions overlap at ' + file);
        files[file] = bytes;
      }
      files['dist/agyctl-localization/host-engine.js'] = input.engineFile;
      return { preload: '\n' + LOCALIZATION_BRIDGE_MARKER + '\n' + input.preloadBridge.toString('utf8'), files };
    },
  };
}
