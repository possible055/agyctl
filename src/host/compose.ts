// Single Host Composer: composes capsule and localization features onto one
// verified original archive, publishes receipts, and commits through the
// existing file transaction. Every apply rebuilds from the verified original;
// nothing is ever patched on top of an already-modified archive (plan §9).
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  CAPSULE_HOOK_MARKER,
  HOST_CAPSULE_FEATURE_MARKER,
  HOST_MANAGED_MARKER,
  LOCALIZATION_BRIDGE_MARKER,
  ComposerError,
  HOST_RECEIPT_SCHEMA_VERSION,
  HOST_PLAN_SCHEMA_VERSION,
  type BaseProvenance,
  type FeatureName,
  type HostPlan,
  type HostReceipt,
  type ToolingEventInput,
  receiptPathFor,
  validateHostPlan,
  validateHostReceipt,
} from './contracts.js';
import { qualifyArchiveMutation } from './integrity.js';
import type { AsarEngineLike, HostFeature, PreparedFeature } from './features.js';
import {
  type CapsuleFeatureInput, type LocalizationFeatureInput, type FeatureInputs,
  encodeFeatureInputs, decodeFeatureInputs, plannedFeatureStateFor, assertPlanInputs,
} from './inputs.js';
import { sha256, sha256File, stableStringify } from './hash.js';
import { decodeStoredInputs, encodeStoredInputs, retainedFeature } from './payload.js';
import {
  type HostWarning, emitEvent, emitFailure, finishCleanup, markCommitted,
  operationIo, operationWarnings, reportWarning, reportCommittedLog,
} from './diagnostics.js';
export type { HostWarning } from './diagnostics.js';
export { type AsarEngineLike } from './features.js';
export { encodeFeatureInputs, decodeFeatureInputs, assertPlanInputs } from './inputs.js';
export type { CapsuleFeatureInput, LocalizationFeatureInput, FeatureInputs, AdapterEdit } from './inputs.js';

export { ComposerError } from './contracts.js';
export {
  CAPSULE_HOOK_MARKER,
  HOST_CAPSULE_FEATURE_MARKER,
  HOST_MANAGED_MARKER,
  LOCALIZATION_BRIDGE_MARKER,
} from './contracts.js';

export interface ReplaceFileTransactionLike {
  (options: {
    targetPath: string;
    stagedPath: string;
    expectedHash: string;
    validate: (archive: string) => void;
    afterReplace?: () => void;
  }): { outcome: 'committed'; hash: string; cleanupError?: unknown; cleanupPath?: string };
}

function reportTransactionCleanup(
  io: Pick<ComposerIo, 'logEvent'>,
  result: ReturnType<ReplaceFileTransactionLike>,
): void {
  if (!result.cleanupError) return;
  reportWarning(io, {
    code: 'CLEANUP_FAILED',
    path: result.cleanupPath,
    message: `Archive committed; cleanup failed at ${result.cleanupPath}: ${String(result.cleanupError)}`,
  });
}

export interface ComposerIo {
  asarPath: string;
  backupDir: string;
  engine: AsarEngineLike;
  transaction: ReplaceFileTransactionLike;
  executablePath?: string;
  capsuleFeature?: HostFeature<CapsuleFeatureInput>;
  localizationFeature?: () => HostFeature<LocalizationFeatureInput>;
  log?: (message: string) => void;
  /** Structured event sink (continuation plan §4); independent from the text log. */
  logEvent?: (event: ToolingEventInput) => void;
}

function featureProvider<Input>(io: Omit<ComposerIo, 'transaction'>, name: FeatureName): HostFeature<Input> {
  const provider = name === 'capsule' ? io.capsuleFeature : io.localizationFeature?.();
  if (!provider)
    throw new ComposerError('UNSUPPORTED_STATE', `No ${name} feature provider was supplied`);
  return provider as HostFeature<Input>;
}

function validateFeatureInputs(io: Omit<ComposerIo, 'transaction'>, features: FeatureInputs): void {
  for (const name of Object.keys(features))
    if (name !== 'capsule' && name !== 'localization')
      throw new ComposerError('FEATURE_UNKNOWN', `Unknown feature: ${name}`);
  for (const name of ['capsule', 'localization'] as const) {
    const input = features[name];
    if (input && !retainedFeature(input)) featureProvider(io, name).validate(input);
  }
}

function qualifyFeature(io: Omit<ComposerIo, 'transaction'>, name: FeatureName, input: object, originalHash: string) {
  const retained = retainedFeature(input);
  if (retained) return { profileStatus: retained.receiptState && 'profileStatus' in retained.receiptState ? retained.receiptState.profileStatus : undefined, warnings: [] };
  return featureProvider(io, name).qualify?.(input, { originalHash, executablePath: io.executablePath }) ?? { warnings: [] };
}

/** Qualifies the executable paired with this archive, never an unrelated binary. */
export function qualifyHostMutation(io: Pick<ComposerIo, 'asarPath' | 'executablePath' | 'engine'>): void {
  if (!io.executablePath) return qualifyArchiveMutation(undefined);
  const archiveDirectory = path.dirname(fs.realpathSync(io.asarPath));
  const resourcesLayout = path.basename(archiveDirectory).toLowerCase() === 'resources';
  const installRoot = resourcesLayout ? path.dirname(archiveDirectory) : archiveDirectory;
  const pkg = JSON.parse(io.engine.extractFile(io.asarPath, 'package.json').toString('utf8')) as { name?: string; productName?: string };
  const name = pkg.productName ?? pkg.name;
  if (typeof name !== 'string' || !name || /[\\/:]/.test(name) || name === '.' || name === '..')
    throw new ComposerError('UNSUPPORTED_STATE', 'Electron ASAR integrity qualification cannot resolve the archive executable identity');
  const executable = process.platform === 'win32' ? `${name}.exe` : process.platform === 'darwin' && resourcesLayout ? path.join('MacOS', name) : pkg.name;
  if (!executable) throw new ComposerError('UNSUPPORTED_STATE', 'Electron ASAR integrity qualification requires the archive executable name');
  let actual: string;
  try { actual = fs.realpathSync(io.executablePath); }
  catch (error) { throw new ComposerError('UNSUPPORTED_STATE', `Electron ASAR integrity qualification cannot resolve the paired executable: ${io.executablePath}`, { cause: error }); }
  const expected = path.resolve(installRoot, executable);
  const same = process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
  if (!same)
    throw new ComposerError('UNSUPPORTED_STATE', `Electron ASAR integrity qualification requires the executable paired with this archive: ${expected}`);
  qualifyArchiveMutation(actual);
}

function persistedInputsPath(io: Omit<ComposerIo, 'transaction'>, status: Pick<HostStatus, 'installationId'>, hash: string): string {
  return path.join(io.backupDir, 'host', status.installationId, 'inputs', `${hash}.json`);
}

function installedFeatureInputs(io: Omit<ComposerIo, 'transaction'>, status: HostStatus): FeatureInputs {
  if (status.receipt?.inputsHash) {
    const file = persistedInputsPath(io, status, status.receipt.inputsHash);
    let contents: string;
    try { contents = fs.readFileSync(file, 'utf8'); }
    catch (error) { throw new ComposerError('UNSUPPORTED_STATE', `Saved Host inputs are unavailable: ${file}; restore the exact verified original or recover this immutable inputs file from backup`, { cause: error }); }
    if (sha256(contents) !== status.receipt.inputsHash)
      throw new ComposerError('SOURCE_MISMATCH', `Saved Host inputs failed their receipt hash: ${file}; recover the original immutable inputs file before changing features`);
    const features = decodeStoredInputs(JSON.parse(contents));
    const recorded = status.receipt.features;
    if (Boolean(features.capsule) !== Boolean(recorded.capsule) || Boolean(features.localization) !== Boolean(recorded.localization) ||
      (features.capsule && sha256(features.capsule.code) !== recorded.capsule?.codeHash) ||
      (features.localization && (sha256(features.localization.engineFile) !== recorded.localization?.engineHash || features.localization.profileId !== recorded.localization?.profileId || features.localization.stateRoot !== recorded.localization?.stateRoot)))
      throw new ComposerError('RECEIPT_INVALID', 'Saved Host inputs do not match the installed receipt');
    return features;
  }
  throw new ComposerError('RECEIPT_INVALID', 'Installed Host archive is missing its current prepared inputs');
}

function carryFeatureInputs(io: Omit<ComposerIo, 'transaction'>, features: FeatureInputs): FeatureInputs {
  const status = getHostStatus(io);
  const missingCapsule = status.features.capsule && !features.capsule;
  const missingLocalization = status.features.localization && !features.localization;
  if (!missingCapsule && !missingLocalization) return features;
  const installed = installedFeatureInputs(io, status);
  return { ...features, ...(missingCapsule ? { capsule: installed.capsule } : {}), ...(missingLocalization ? { localization: installed.localization } : {}) };
}

export interface HostStatus {
  installationId: string;
  asarPath: string;
  channel: string;
  currentHash: string;
  unpackedHash: string | null;
  archiveKind: 'host-managed' | 'pristine';
  installed: boolean;
  features: { capsule: boolean; localization: boolean };
  receipt: HostReceipt | null;
  recordPath: string | null;
  backupPath: string | null;
  originalHash: string | null;
}

export interface EnsureOriginalBackupResult {
  backupPath: string;
  originalHash: string;
}

const inProcessLocks = new Map<string, Promise<unknown>>();

function serializeOn<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = inProcessLocks.get(key) ?? Promise.resolve();
  const next = previous.then(run, run) as Promise<T>;
  inProcessLocks.set(key, next);
  next.finally(() => {
    if (inProcessLocks.get(key) === next) inProcessLocks.delete(key);
  }).catch(() => {});
  return next;
}

/** Wraps an operation with start and exactly one terminal event. */
async function withOperationEvent<T extends object>(
  io: ComposerIo,
  context: { stage: string; installationId: string; planId?: string; detail?: string },
  run: (io: ComposerIo) => Promise<T>,
): Promise<T & { warnings: HostWarning[] }> {
  io = operationIo(io);
  const started: ToolingEventInput = {
    level: 'info',
    stage: context.stage,
    event: 'started',
    result: 'started',
    installationId: context.installationId,
    ...(context.planId ? { planId: context.planId } : {}),
    ...(context.detail ? { detail: context.detail } : {}),
  };
  emitEvent(io, started);
  try {
    const result = await run(io);
    emitEvent(io, {
      level: 'info',
      stage: context.stage,
      event: 'completed',
      result: 'ok',
      installationId: context.installationId,
      ...(context.planId ? { planId: context.planId } : {}),
    });
    return Object.assign(result, { warnings: operationWarnings(io) });
  } catch (error) {
    emitFailure(io, {
      level: 'error',
      stage: context.stage,
      event: 'failed',
      result: 'failed',
      installationId: context.installationId,
      ...(context.planId ? { planId: context.planId } : {}),
      ...(error instanceof ComposerError ? { code: error.code } : {}),
      detail: error instanceof Error ? error.message : String(error),
    }, error);
    throw error;
  }
}

/** Deterministic JSON for hash inputs and receipts; key order never varies. */
export function computeInstallationIdentity(asarPath: string): {
  asarPath: string;
  installationId: string;
  channel: string;
} {
  let canonical = fs.realpathSync(asarPath);
  if (process.platform === 'win32') canonical = canonical.toLowerCase();
  const normalized = canonical.replaceAll('\\', '/');
  const channel = /antigravity[ -]+insiders?(?:\.app|\/)/i.test(normalized)
    ? 'insiders'
    : /antigravity(?:\.app|\/)/i.test(normalized)
      ? 'stable'
      : 'custom';
  return { asarPath: canonical, installationId: sha256(canonical), channel };
}

export function computeUnpackedManifestHash(asarPath: string): string | null {
  const root = `${asarPath}.unpacked`;
  if (!fs.existsSync(root)) return null;
  const manifest: Array<[string, ...unknown[]]> = [];
  const walk = (directory: string, relative: string): void => {
    if (!fs.lstatSync(directory).isDirectory())
      throw new ComposerError('SOURCE_MISMATCH', `Unsupported unpacked directory: ${directory}`);
    manifest.push(['directory', relative]);
    for (const item of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const child = path.join(directory, item.name);
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) walk(child, name);
      else if (item.isFile())
        manifest.push(['file', name, sha256(fs.readFileSync(child)), fs.statSync(child).mode & 0o111]);
      else throw new ComposerError('SOURCE_MISMATCH', `Unsupported unpacked entry: ${child}`);
    }
  };
  walk(root, '');
  return sha256(Buffer.from(JSON.stringify(manifest), 'utf8'));
}

function readPreloadText(io: Omit<ComposerIo, 'transaction'>, archivePath: string): string {
  return io.engine.extractFile(archivePath, 'dist/preload.js').toString('utf8');
}

function verifyPristineOriginal(io: Omit<ComposerIo, 'transaction'>, backupPath: string, originalHash: string, unpackedHash: string | null): void {
  io.engine.validateArchive(backupPath);
  if (sha256File(backupPath) !== originalHash)
    throw new ComposerError('BACKUP_DIRTY', 'Original backup does not match its recorded archive hash');
  if (computeUnpackedManifestHash(backupPath) !== unpackedHash)
    throw new ComposerError('BACKUP_DIRTY', 'Original backup does not match its recorded unpacked hashes');
  const preload = readPreloadText(io, backupPath);
  if (preload.includes(HOST_MANAGED_MARKER) || preload.includes(HOST_CAPSULE_FEATURE_MARKER) || preload.includes(LOCALIZATION_BRIDGE_MARKER) || preload.includes(CAPSULE_HOOK_MARKER))
    throw new ComposerError('BACKUP_DIRTY', 'Original backup contains a feature hook; refusing a dirty backup');
}

/** Resolves the complete current archive state from receipts, markers and pairing rules. */
export function getHostStatus(io: Omit<ComposerIo, 'transaction'>): HostStatus {
  // Status reads are pure functions of these files' bytes. Keying on stat
  // identity makes an unchanged installation a cache hit while any write or
  // update (which replaces or touches the files) produces a fresh read.
  const unpackedRoot = `${io.asarPath}.unpacked`;
  const key = [
    `${io.asarPath}#${statIdentity(io.asarPath)}`,
    io.executablePath ? `${io.executablePath}#${statIdentity(io.executablePath)}` : 'no-executable',
    `${io.backupDir}#${statIdentity(io.backupDir)}`,
    fs.existsSync(unpackedRoot) ? `${unpackedRoot}#${statIdentity(unpackedRoot)}` : 'no-unpacked',
  ].join('\u0000');
  const cached = hostStatusCache.get(key);
  if (cached) return cached;
  const status = computeHostStatus(io);
  while (hostStatusCache.size >= HOST_STATUS_CACHE_LIMIT) {
    const oldest = hostStatusCache.keys().next();
    if (oldest.done) break;
    hostStatusCache.delete(oldest.value);
  }
  hostStatusCache.set(key, status);
  return status;
}

const HOST_STATUS_CACHE_LIMIT = 8;
const hostStatusCache = new Map<string, HostStatus>();

function statIdentity(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}|${stat.mtimeMs}|${stat.ctimeMs}|${stat.birthtimeMs}|${stat.ino}`;
  } catch {
    return null;
  }
}

function computeHostStatus(io: Omit<ComposerIo, 'transaction'>): HostStatus {
  const { asarPath, backupDir, engine } = io;
  engine.validateArchive(asarPath);
  const installation = computeInstallationIdentity(asarPath);
  const currentHash = sha256File(asarPath);
  const unpackedHash = computeUnpackedManifestHash(asarPath);
  const preload = readPreloadText(io, asarPath);
  const base = {
    installationId: installation.installationId,
    asarPath: installation.asarPath,
    channel: installation.channel,
    currentHash,
    unpackedHash,
  };
  const receiptPath = receiptPathFor(backupDir, installation.installationId, currentHash);
  if (fs.existsSync(receiptPath)) {
    const receipt = validateHostReceipt(JSON.parse(fs.readFileSync(receiptPath, 'utf8')));
    if (
      receipt.installationId !== installation.installationId ||
      receipt.asarPath !== installation.asarPath ||
      receipt.patchedHash !== currentHash ||
      receipt.unpackedHash !== unpackedHash ||
      !preload.includes(HOST_MANAGED_MARKER)
    )
      throw new ComposerError('RECEIPT_INVALID', 'Host receipt does not match the installed archive identity');
    verifyPristineOriginal(io, receipt.originalBackupRef, receipt.originalHash, receipt.unpackedHash);
    const features = receipt.features;
    return {
      ...base,
      archiveKind: 'host-managed',
      installed: features.capsule !== undefined,
      features: { capsule: features.capsule !== undefined, localization: features.localization !== undefined },
      receipt,
      recordPath: receiptPath,
      backupPath: receipt.originalBackupRef,
      originalHash: receipt.originalHash,
    };
  }
  if (preload.includes(HOST_MANAGED_MARKER) || preload.includes(HOST_CAPSULE_FEATURE_MARKER) || preload.includes(LOCALIZATION_BRIDGE_MARKER))
    throw new ComposerError(
      'HOST_CONFLICT',
      'Host-composed archive without a matching receipt; refusing to guess its features',
    );
  if (preload.includes(CAPSULE_HOOK_MARKER))
    throw new ComposerError('UNSUPPORTED_STATE', 'Unknown hooked app.asar: retired Capsule-only state is unsupported; refusing to guess its original');
  return {
    ...base,
    archiveKind: 'pristine',
    installed: false,
    features: { capsule: false, localization: false },
    receipt: null,
    recordPath: null,
    backupPath: null,
    originalHash: null,
  };
}

/** Creates or verifies the immutable original backup for the current archive. */
export function ensureOriginalBackup(io: Omit<ComposerIo, 'transaction'>): EnsureOriginalBackupResult {
  const { asarPath, backupDir, engine } = io;
  const status = getHostStatus(io);
  if (status.backupPath)
    return { backupPath: status.backupPath, originalHash: status.originalHash as string };
  const directory = path.join(backupDir, 'host', status.installationId, 'originals');
  const name = `original-${status.currentHash}-${status.unpackedHash ?? 'packed'}.asar`;
  const backupPath = path.join(directory, name);
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(backupPath)) {
    const staging = fs.mkdtempSync(path.join(directory, '.original-'));
    let operationError: unknown;
    try {
      const staged = path.join(staging, name);
      fs.copyFileSync(asarPath, staged, fs.constants.COPYFILE_EXCL);
      engine.copyUnpacked(asarPath, staged);
      engine.validateArchive(staged);
      if (
        sha256File(staged) !== status.currentHash ||
        computeUnpackedManifestHash(staged) !== status.unpackedHash ||
        sha256File(asarPath) !== status.currentHash ||
        computeUnpackedManifestHash(asarPath) !== status.unpackedHash
      )
        throw new ComposerError('SOURCE_MISMATCH', 'Installation changed while creating original backup');
      if (fs.existsSync(`${staged}.unpacked`)) {
        if (fs.existsSync(`${backupPath}.unpacked`))
          throw new ComposerError('BACKUP_DIRTY', 'Incomplete immutable backup sidecar already exists; refusing overwrite');
        fs.renameSync(`${staged}.unpacked`, `${backupPath}.unpacked`);
      }
      fs.linkSync(staged, backupPath);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      finishCleanup(io, staging, () => fs.rmSync(staging, { recursive: true, force: true }), operationError);
    }
  }
  verifyPristineOriginal(io, backupPath, status.currentHash, status.unpackedHash);
  return { backupPath, originalHash: status.currentHash };
}

/**
 * Resolves the original's provenance without persisting anything: a recorded
 * official-profile always governs; an official-profile declaration on a
 * original-recorded base plans the upgrade, which apply then persists.
 * Planning must stay read-only (plan §10.1).
 */
function plannedOriginalProvenance(
  io: Omit<ComposerIo, 'transaction'>,
  installationId: string,
  originalHash: string,
  declared: BaseProvenance,
): BaseProvenance {
  const recordPath = originalProvenancePath(io.backupDir, installationId, originalHash);
  if (!fs.existsSync(recordPath)) return declared;
  const recorded = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { baseProvenance?: BaseProvenance };
  if (recorded.baseProvenance !== 'official-profile' && recorded.baseProvenance !== 'original-recorded')
    throw new ComposerError('RECEIPT_INVALID', `Invalid recorded original provenance: ${recordPath}`);
  return recorded.baseProvenance === 'official-profile' ? recorded.baseProvenance : declared;
}

/** Recomputes a plan's binding identity from its own fields. */
export function computeHostPlanId(plan: Omit<HostPlan, 'planId'>): string {
  return sha256(
    stableStringify({
      installationId: plan.installationId,
      asarPath: plan.asarPath,
      currentHash: plan.currentHash,
      unpackedHash: plan.unpackedHash,
      originalHash: plan.originalHash,
      baseProvenance: plan.baseProvenance,
      features: plan.features,
    }),
  );
}

/** Creates the identity-bound, read-only plan for adding or keeping features. */
export function planHostPatch(
  io: Omit<ComposerIo, 'transaction'>,
  options: { features: FeatureInputs; baseProvenance?: BaseProvenance; carryInstalled?: boolean },
): HostPlan {
  let installationId: string | undefined;
  try {
    installationId = computeInstallationIdentity(io.asarPath).installationId;
    return planHostPatchInside(io, options);
  } catch (error) {
    emitFailure(io, {
      level: 'error',
      stage: 'host.plan',
      event: 'failed',
      result: 'failed',
      ...(installationId ? { installationId } : {}),
      ...(error instanceof ComposerError ? { code: error.code } : {}),
      detail: error instanceof Error ? error.message : String(error),
    }, error);
    throw error;
  }
}

/** Checks a reviewed plan and its payloads without writing backups or staging. */
export function inspectReviewedHostPlan(io: Omit<ComposerIo, 'transaction'>, reviewed: unknown, requested: FeatureInputs): {
  plan: HostPlan;
  features: FeatureInputs;
  status: HostStatus;
  readiness: 'ready' | 'current';
} {
  const plan = validateHostPlan(reviewed);
  if (computeHostPlanId(plan) !== plan.planId)
    throw new ComposerError('PLAN_MISMATCH', 'The plan file does not match its own binding identity');
  const status = getHostStatus(io);
  if (status.installationId !== plan.installationId || status.asarPath !== plan.asarPath || status.unpackedHash !== plan.unpackedHash || (status.originalHash ?? status.currentHash) !== plan.originalHash)
    throw new ComposerError('SOURCE_MISMATCH', 'Reviewed Host plan does not match the exact installation and original chain');
  const features = carryFeatureInputs(io, requested);
  assertPlanInputs(plan, features);
  validateFeatureInputs(io, features);
  qualifyHostMutation(io);
  for (const name of ['capsule', 'localization'] as const) {
    const input = features[name];
    if (!input || retainedFeature(input)) continue;
    qualifyFeature(io, name, input, plan.originalHash);
    featureProvider(io, name).compose(input, { originalPath: status.backupPath ?? io.asarPath, engine: io.engine });
  }
  if (status.archiveKind !== 'pristine') {
    const installed = installedFeatureInputs(io, status);
    if (stableStringify(encodeFeatureInputs(installed)) === stableStringify(encodeFeatureInputs(features)))
      return { plan, features, status, readiness: 'current' };
  }
  if (status.currentHash === plan.currentHash) return { plan, features, status, readiness: 'ready' };
  throw new ComposerError('SOURCE_MISMATCH', 'Installation changed since the Host plan was reviewed');
}

function planHostPatchInside(
  io: Omit<ComposerIo, 'transaction'>,
  options: { features: FeatureInputs; baseProvenance?: BaseProvenance; carryInstalled?: boolean },
): HostPlan {
  if (options.carryInstalled ?? true) options = { ...options, features: carryFeatureInputs(io, options.features) };
  validateFeatureInputs(io, options.features);
  const declaredProvenance = options.baseProvenance ?? 'original-recorded';
  const status = getHostStatus(io);
  // Read-only planning: a pristine archive IS its original; an installed
  // archive already carries the verified original hash in its receipt.
  // The immutable backup itself is created at apply time.
  const originalHash = status.originalHash ?? status.currentHash;
  // Provenance belongs to the verified original, not to each apply: it is
  // recorded once per original and may only upgrade to official-profile after
  // an explicit profile verification by the adapter (plan §9.2–§9.3). Apply
  // persists the planned value.
  const baseProvenance = plannedOriginalProvenance(io, status.installationId, originalHash, declaredProvenance);
  if (options.features.localization)
    for (const warning of qualifyFeature(io, 'localization', options.features.localization, originalHash).warnings)
      emitEvent(io, {
        level: 'warn',
        stage: 'host.plan',
        event: 'warning',
        result: 'warn',
        installationId: status.installationId,
        code: warning.code,
        detail: warning.message,
      });
  if (options.baseProvenance === 'official-profile' && !options.features.localization)
    throw new ComposerError('UNSUPPORTED_STATE', 'Official-profile provenance requires an explicit localization feature');
  const features = plannedFeatureStateFor(options.features);
  if (Object.keys(features).length === 0)
    throw new ComposerError('HOST_CONFLICT', 'A host plan must request at least one feature; restore goes through removeFeatures');
  const plan: Omit<HostPlan, 'planId'> = {
    schemaVersion: HOST_PLAN_SCHEMA_VERSION,
    installationId: status.installationId,
    asarPath: status.asarPath,
    channel: status.channel,
    currentHash: status.currentHash,
    unpackedHash: status.unpackedHash,
    originalHash,
    baseProvenance,
    features,
    requiresClientClosed: options.features.localization !== undefined,
  };
  const planned = { ...plan, planId: computeHostPlanId(plan) };
  emitEvent(io, {
    level: 'info',
    stage: 'host.plan',
    event: 'created',
    result: 'planned',
    installationId: planned.installationId,
    planId: planned.planId,
    detail: `features=${Object.keys(features).join('+')} original=${planned.originalHash}`,
  });
  return planned;
}

// A holder creates host.lock before it writes its record, so an unreadable
// lock is only abandoned once it has stayed unreadable for this long.
const LOCK_WRITE_GRACE_MS = 10_000;

type LockHolder = { pid?: unknown; exePath?: unknown };

function readLockHolder(lockPath: string): LockHolder | 'vanished' | 'unreadable' {
  let text: string;
  try {
    text = fs.readFileSync(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'vanished';
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' ? (parsed as LockHolder) : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

function withHostLock<T>(io: ComposerIo, installationId: string, run: () => Promise<T>): Promise<T> {
  return serializeOn(`host:${io.backupDir}:${installationId}`, async () => {
    const directory = path.join(io.backupDir, 'host', installationId);
    fs.mkdirSync(directory, { recursive: true });
    const lockPath = path.join(directory, 'host.lock');
    for (;;) {
      let fd: number;
      try {
        fd = fs.openSync(lockPath, 'wx');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = readLockHolder(lockPath);
        if (holder === 'vanished') continue;
        if (holder === 'unreadable') {
          let ageMs: number;
          try {
            ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
          } catch (statError) {
            if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw statError;
          }
          if (ageMs < LOCK_WRITE_GRACE_MS)
            throw new ComposerError('LOCK_BUSY', 'Another Host operation is starting; retry after it finishes');
        }
        const existing: LockHolder = holder === 'unreadable' ? {} : holder;
        const recordedPid = typeof existing.pid === 'number' ? existing.pid : 0;
        if (recordedPid !== 0) {
          // A lock naming our own pid and executable can only be stale: the
          // in-process mutex already excludes concurrent operations here.
          const selfRecorded =
            recordedPid === process.pid && existing.exePath === process.execPath;
          if (!selfRecorded) {
            let holderAlive = true;
            try {
              process.kill(recordedPid, 0);
            } catch (killError) {
              holderAlive = (killError as NodeJS.ErrnoException).code === 'EPERM';
            }
            // PID existence alone never reclaims the lock: a live holder with
            // any identity keeps it; only a vanished holder leaves it stale.
            if (holderAlive)
              throw new ComposerError(
                'LOCK_BUSY',
                `Another Host operation holds the lock (pid ${recordedPid}); retry after it finishes`,
              );
          }
        }
        const stalePath = `${lockPath}.stale-${randomUUID()}`;
        fs.renameSync(lockPath, stalePath);
        continue;
      }
      let lockError: unknown;
      try {
        const token = randomUUID();
        fs.writeFileSync(
          fd,
          `${JSON.stringify({
            schemaVersion: 1,
            pid: process.pid,
            exePath: process.execPath,
            startedAt: new Date().toISOString(),
            token,
          })}\n`,
        );
        let runError: unknown;
        try {
          return await run();
        } catch (error) {
          runError = error;
          throw error;
        } finally {
          finishCleanup(io, lockPath, () => {
            let current: string;
            try {
              current = fs.readFileSync(lockPath, 'utf8');
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
              throw error;
            }
            if (current.includes(token)) fs.rmSync(lockPath, { force: true });
          }, runError);
        }
      } catch (error) {
        lockError = error;
        throw error;
      } finally {
        finishCleanup(io, lockPath, () => fs.closeSync(fd), lockError);
      }
    }
  });
}

async function composeInsideLock(
  io: ComposerIo,
  plan: HostPlan,
  features: FeatureInputs,
  transactionOverride?: ReplaceFileTransactionLike,
  ensureClientClosed?: () => void,
): Promise<{ receipt: HostReceipt | null; backupPath: string; warnings?: HostWarning[] }> {
  validateFeatureInputs(io, features);
  assertPlanInputs(plan, features);
  qualifyHostMutation(io);
  const localizationQualification = features.localization
    ? qualifyFeature(io, 'localization', features.localization, plan.originalHash)
    : null;
  if (localizationQualification)
    for (const warning of localizationQualification.warnings)
      emitEvent(io, {
        level: 'warn',
        stage: 'host.apply',
        event: 'warning',
        result: 'warn',
        installationId: plan.installationId,
        planId: plan.planId,
        code: warning.code,
        detail: warning.message,
      });
  if (sha256File(io.asarPath) !== plan.currentHash)
    throw new ComposerError('SOURCE_MISMATCH', 'Installation changed since the host plan was created');
  if (computeInstallationIdentity(io.asarPath).installationId !== plan.installationId)
    throw new ComposerError('SOURCE_MISMATCH', 'Installation identity changed since the host plan was created');
  if (computeUnpackedManifestHash(io.asarPath) !== plan.unpackedHash)
    throw new ComposerError('SOURCE_MISMATCH', 'Installed unpacked files changed since the host plan was created');
  // Apply resolves the immutable original itself: the plan is read-only and
  // never created a backup, so apply creates or verifies it and re-binds the
  // plan to the exact recorded original bytes.
  const original = ensureOriginalBackup(io);
  if (original.originalHash !== plan.originalHash)
    throw new ComposerError('SOURCE_MISMATCH', 'The verified original does not match the planned original hash');
  const originalBackupRef = original.backupPath;
  verifyPristineOriginal(io, originalBackupRef, plan.originalHash, plan.unpackedHash);
  emitEvent(io, {
    level: 'info',
    stage: 'host.backup',
    event: 'verified',
    result: 'ok',
    installationId: plan.installationId,
    planId: plan.planId,
    detail: `original=${plan.originalHash}`,
  });
  const recordedProvenance = resolveOriginalProvenance(io, plan.installationId, original, plan.baseProvenance);
  if (recordedProvenance !== plan.baseProvenance)
    throw new ComposerError('PLAN_MISMATCH', 'Original provenance changed since the plan was created');
  const featureNames = Object.keys(plan.features);
  const prepared: Partial<Record<FeatureName, PreparedFeature>> = {};
  for (const name of ['capsule', 'localization'] as const) {
    const input = features[name];
    if (!input) continue;
    prepared[name] = retainedFeature(input) ?? featureProvider(io, name).compose(input, {
      originalPath: originalBackupRef,
      engine: io.engine,
    });
    prepared[name].receiptState ??= name === 'localization'
      ? { ...plan.features.localization!, ...(localizationQualification?.profileStatus ? { profileStatus: localizationQualification.profileStatus } : {}) }
      : plan.features.capsule;
  }
  const inputs = `${stableStringify(encodeStoredInputs(features, prepared))}\n`;
  const inputsHash = sha256(inputs);
  const staging = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(io.asarPath)), '.agyctl-host-'));
  let operationError: unknown;
  try {
    const staged = path.join(staging, 'app.asar');
    if (featureNames.length === 0) {
      fs.copyFileSync(originalBackupRef, staged, fs.constants.COPYFILE_EXCL);
      io.engine.copyUnpacked(originalBackupRef, staged);
    } else {
      const replacements: Record<string, Buffer> = {};
      let preloadText = io.engine.extractFile(originalBackupRef, 'dist/preload.js').toString('utf8');
      preloadText += prepared.capsule?.preload ?? '';
      preloadText += `\n${HOST_MANAGED_MARKER}\n`;
      // Bind evidence-only input revisions without changing the feature payloads.
      preloadText += `\n// [agyctl Host Prepared Payloads v1 inputs=${inputsHash}]\n`;
      preloadText += prepared.localization?.preload ?? '';
      vm.compileFunction(preloadText, ['exports', 'require', 'module', '__filename', '__dirname'], {
        filename: 'preload.js',
      });
      replacements['dist/preload.js'] = Buffer.from(preloadText, 'utf8');
      for (const contribution of Object.values(prepared))
        for (const [file, bytes] of Object.entries(contribution.files)) {
          if (!file.startsWith('dist/') || file.split(/[\\/]/).includes('..') || replacements[file])
            throw new ComposerError('HOST_CONFLICT', `Feature contributions conflict at ${file}`);
          replacements[file] = bytes;
        }
      io.engine.patchArchive(originalBackupRef, staged, replacements);
    }
    const patchedHash = sha256File(staged);
    emitEvent(io, {
      level: 'info',
      stage: 'host.staging',
      event: 'composed',
      result: 'ok',
      installationId: plan.installationId,
      planId: plan.planId,
      detail: `patched=${patchedHash}`,
    });
    const validate = (archive: string): void => {
      io.engine.validateArchive(archive);
      if (sha256File(archive) !== patchedHash)
        throw new ComposerError('SOURCE_MISMATCH', 'Staged archive does not match its composed hash');
      if (computeUnpackedManifestHash(archive) !== plan.unpackedHash)
        throw new ComposerError('SOURCE_MISMATCH', 'Staged archive does not preserve the unpacked sidecar');
      if (computeUnpackedManifestHash(io.asarPath) !== plan.unpackedHash)
        throw new ComposerError('SOURCE_MISMATCH', 'Installed unpacked files changed while staging');
      const preload = readPreloadText(io, archive);
      if (featureNames.length === 0) {
        if (
          preload.includes(HOST_MANAGED_MARKER) ||
          preload.includes(CAPSULE_HOOK_MARKER) ||
          preload.includes(LOCALIZATION_BRIDGE_MARKER)
        )
          throw new ComposerError('SOURCE_MISMATCH', 'Restored archive still contains feature hooks');
        return;
      }
      if (!preload.includes(HOST_MANAGED_MARKER))
        throw new ComposerError('SOURCE_MISMATCH', 'Staged archive lost the host marker');
    };
    validate(staged);
    // Staging takes long enough for the client to start, so the check made
    // before the lock is repeated immediately before anything is published.
    ensureClientClosed?.();
    let receipt: HostReceipt | null = null;
    if (featureNames.length > 0) {
      receipt = {
        schemaVersion: HOST_RECEIPT_SCHEMA_VERSION,
        installationId: plan.installationId,
        asarPath: plan.asarPath,
        baseProvenance: plan.baseProvenance,
        originalHash: plan.originalHash,
        patchedHash,
        unpackedHash: plan.unpackedHash,
        originalBackupRef,
        inputsHash,
        features: Object.fromEntries(Object.entries(prepared).map(([name, contribution]) => [name, contribution.receiptState])),
      };
      publishDocument(persistedInputsPath(io, plan, receipt.inputsHash), inputs, 'RECEIPT_INVALID');
      publishReceipt(io.backupDir, plan.installationId, receipt);
      emitEvent(io, {
        level: 'info',
        stage: 'host.receipt',
        event: 'published',
        result: 'ok',
        installationId: plan.installationId,
        planId: plan.planId,
        detail: `patched=${patchedHash} inputs=${receipt.inputsHash}`,
      });
    }
    qualifyHostMutation(io);
    const transactionResult = (transactionOverride ?? io.transaction)({
      targetPath: io.asarPath,
      stagedPath: staged,
      expectedHash: plan.currentHash,
      validate,
    });
    markCommitted(io);
    reportTransactionCleanup(io, transactionResult);
    emitEvent(io, {
      level: 'info',
      stage: 'host.replace',
      event: 'replaced',
      result: 'ok',
      installationId: plan.installationId,
      planId: plan.planId,
      detail: `patched=${patchedHash}`,
    });
    reportCommittedLog(io, `Host archive composed and verified: ${io.asarPath}`);
    return { receipt, backupPath: originalBackupRef };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    finishCleanup(io, staging, () => fs.rmSync(staging, { recursive: true, force: true }), operationError);
  }
}

function originalProvenancePath(backupDir: string, installationId: string, originalHash: string): string {
  return path.join(backupDir, 'host', installationId, 'originals', `${originalHash}.json`);
}

/**
 * Applies a reviewed plan: the plan is validated, its binding identity is
 * recomputed and compared, and only then does apply touch anything. The
 * feature contents must be supplied alongside the plan; they are verified
 * against every binding before a backup is created or a byte is written.
 */
export async function applyHostPatch(
  io: ComposerIo,
  options: {
    plan: HostPlan;
    features: FeatureInputs;
    ensureClientClosed?: () => void;
    transaction?: ReplaceFileTransactionLike;
    log?: (message: string) => void;
  },
): Promise<{ receipt: HostReceipt | null; backupPath: string; warnings?: HostWarning[] }> {
  const plan = validateHostPlan(options.plan);
  if (computeHostPlanId(plan) !== plan.planId)
    throw new ComposerError('PLAN_MISMATCH', 'The plan file does not match its own binding identity');
  return withOperationEvent(io, { stage: 'host.apply', installationId: plan.installationId, planId: plan.planId }, async (io) => {
    const features = carryFeatureInputs(io, options.features);
    validateFeatureInputs(io, features);
    assertPlanInputs(plan, features);
    qualifyHostMutation(io);
    if (features.localization) {
      if (!options.ensureClientClosed)
        throw new ComposerError(
          'CLIENT_RUNNING_UNKNOWN',
          'Client state could not be confirmed; localization apply requires the client to be closed',
        );
      options.ensureClientClosed();
    }
    return withHostLock(io, plan.installationId, () =>
      composeInsideLock(
        io,
        plan,
        features,
        options.transaction,
        features.localization ? options.ensureClientClosed : undefined,
      ),
    );
  });
}

function resolveOriginalProvenance(
  io: Omit<ComposerIo, 'transaction'>,
  installationId: string,
  original: { backupPath: string; originalHash: string },
  declared: BaseProvenance,
): BaseProvenance {
  const recordPath = originalProvenancePath(io.backupDir, installationId, original.originalHash);
  if (!fs.existsSync(recordPath)) {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    fs.writeFileSync(
      recordPath,
      `${stableStringify({
        schemaVersion: 1,
        originalHash: original.originalHash,
        unpackedHash: computeUnpackedManifestHash(original.backupPath),
        baseProvenance: declared,
        backupName: path.basename(original.backupPath),
      })}\n`,
      { flag: 'wx' },
    );
    return declared;
  }
  const recorded = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as { baseProvenance?: BaseProvenance };
  if (recorded.baseProvenance !== 'official-profile' && recorded.baseProvenance !== 'original-recorded')
    throw new ComposerError('RECEIPT_INVALID', `Invalid recorded original provenance: ${recordPath}`);
  if (recorded.baseProvenance === 'official-profile' || declared !== 'official-profile') return recorded.baseProvenance;
  // official-profile is a strictly stronger, explicitly verified declaration.
  fs.writeFileSync(
    recordPath,
    `${stableStringify({
      schemaVersion: 1,
      originalHash: original.originalHash,
      unpackedHash: computeUnpackedManifestHash(original.backupPath),
      baseProvenance: declared,
      backupName: path.basename(original.backupPath),
    })}\n`,
  );
  return declared;
}

function publishDocument(docPath: string, contents: string, conflictCode: 'RECEIPT_INVALID'): void {
  fs.mkdirSync(path.dirname(docPath), { recursive: true });
  if (fs.existsSync(docPath)) {
    if (fs.readFileSync(docPath, 'utf8') !== contents)
      throw new ComposerError(conflictCode, 'Conflicting immutable host receipt');
    return;
  }
  const staging = fs.mkdtempSync(path.join(path.dirname(docPath), '.receipt-'));
  let operationError: unknown;
  try {
    const staged = path.join(staging, 'receipt.json');
    fs.writeFileSync(staged, contents, { flag: 'wx' });
    fs.linkSync(staged, docPath);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    finishCleanup({}, staging, () => fs.rmSync(staging, { recursive: true, force: true }), operationError);
  }
}

function publishReceipt(backupDir: string, installationId: string, receipt: HostReceipt): void {
  const docPath = receiptPathFor(backupDir, installationId, receipt.patchedHash);
  const contents = `${stableStringify(receipt)}\n`;
  if (fs.existsSync(docPath)) {
    const existing = fs.readFileSync(docPath, 'utf8');
    if (existing === contents) return;
    // Deterministic recomposition can reproduce identical bytes after the
    // original's provenance was upgraded; the recorded provenance governs, so
    // the older receipt with the weaker provenance stays authoritative.
    const withoutProvenance = (text: string) => JSON.parse(text) as Record<string, unknown>;
    const previous = withoutProvenance(existing);
    const next = withoutProvenance(contents);
    const stripProvenance = (doc: Record<string, unknown>) => {
      const copy = { ...doc };
      delete copy.baseProvenance;
      return stableStringify(copy);
    };
    if (stripProvenance(previous) === stripProvenance(next)) return;
    throw new ComposerError('RECEIPT_INVALID', 'Conflicting immutable host receipt');
  }
  publishDocument(docPath, contents, 'RECEIPT_INVALID');
}

/** Plans and applies the feature set in one identity-bound transaction. */
export async function applyFeatures(
  io: ComposerIo,
  options: {
    features: FeatureInputs;
    baseProvenance?: BaseProvenance;
    ensureClientClosed?: () => void;
    transaction?: ReplaceFileTransactionLike;
    /** removeFeatures supplies an explicit remaining set. */
    carryInstalled?: boolean;
  },
): Promise<{ receipt: HostReceipt; backupPath: string; warnings?: HostWarning[] }> {
  const features = (options.carryInstalled ?? true) ? carryFeatureInputs(io, options.features) : options.features;
  if (features.localization) {
    if (!options.ensureClientClosed)
      throw new ComposerError(
        'CLIENT_RUNNING_UNKNOWN',
        'Client state could not be confirmed; localization apply requires the client to be closed',
      );
    options.ensureClientClosed();
  }
  const plan = planHostPatch(io, { features, baseProvenance: options.baseProvenance, carryInstalled: options.carryInstalled });
  qualifyHostMutation(io);
  return withOperationEvent(io, { stage: 'host.apply', installationId: plan.installationId, planId: plan.planId }, (io) =>
    withHostLock(io, plan.installationId, () =>
      composeInsideLock(
        io,
        plan,
        features,
        options.transaction,
        features.localization ? options.ensureClientClosed : undefined,
      ),
    ),
  ) as Promise<{ receipt: HostReceipt; backupPath: string; warnings?: HostWarning[] }>;
}

function restoreOriginalArchive(
  io: ComposerIo,
  original: { backupPath: string; originalHash: string; currentHash: string; unpackedHash: string | null },
  ensureClientClosed?: () => void,
): void {
  qualifyHostMutation(io);
  const staging = fs.mkdtempSync(path.join(path.dirname(fs.realpathSync(io.asarPath)), '.agyctl-restore-'));
  let operationError: unknown;
  try {
    const staged = path.join(staging, 'app.asar');
    fs.copyFileSync(original.backupPath, staged, fs.constants.COPYFILE_EXCL);
    io.engine.copyUnpacked(original.backupPath, staged);
    const validate = (archive: string): void => {
      io.engine.validateArchive(archive);
      if (sha256File(archive) !== original.originalHash || computeUnpackedManifestHash(archive) !== original.unpackedHash)
        throw new ComposerError('SOURCE_MISMATCH', 'Original restore archive does not match the recorded original');
      if (readPreloadText(io, archive).includes(CAPSULE_HOOK_MARKER))
        throw new ComposerError('SOURCE_MISMATCH', 'Original restore archive still contains a capsule hook');
      if (computeUnpackedManifestHash(io.asarPath) !== original.unpackedHash)
        throw new ComposerError('SOURCE_MISMATCH', 'Installed unpacked files changed while staging restore');
    };
    ensureClientClosed?.();
    qualifyHostMutation(io);
    const transactionResult = io.transaction({
      targetPath: io.asarPath,
      stagedPath: staged,
      expectedHash: original.currentHash,
      validate,
    });
    markCommitted(io);
    reportTransactionCleanup(io, transactionResult);
    emitEvent(io, {
      level: 'info',
      stage: 'host.restore',
      event: 'replaced',
      result: 'ok',
      installationId: computeInstallationIdentity(io.asarPath).installationId,
      detail: `original=${original.originalHash}`,
    });
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    finishCleanup(io, staging, () => fs.rmSync(staging, { recursive: true, force: true }), operationError);
  }
}

/** Removes features from the current archive, rebuilding the remaining ones from the verified original. */
export async function removeFeatures(
  io: ComposerIo,
  options: {
    remove: FeatureName[];
    capsule?: CapsuleFeatureInput;
    localization?: LocalizationFeatureInput;
    ensureClientClosed?: () => void;
    transaction?: ReplaceFileTransactionLike;
  },
): Promise<{ receipt: HostReceipt | null; backupPath: string | null; warnings?: HostWarning[] }> {
  const invalid = options.remove.find((name) => name !== 'capsule' && name !== 'localization');
  if (invalid) throw new ComposerError('FEATURE_UNKNOWN', `Unknown feature: ${invalid}`);
  const status = getHostStatus(io);
  if (status.archiveKind === 'pristine') return { receipt: null, backupPath: null };
  const remaining: FeatureInputs = {};
  const keepCapsule = status.features.capsule && !options.remove.includes('capsule');
  const keepLocalization = status.features.localization && !options.remove.includes('localization');
  if (keepCapsule || keepLocalization) {
    const installed = installedFeatureInputs(io, status);
    if (keepCapsule) remaining.capsule = installed.capsule;
    if (keepLocalization) remaining.localization = installed.localization;
    if ((options.capsule && stableStringify(encodeFeatureInputs({ capsule: options.capsule })) !== stableStringify(encodeFeatureInputs({ capsule: remaining.capsule }))) ||
        (options.localization && stableStringify(encodeFeatureInputs({ localization: options.localization })) !== stableStringify(encodeFeatureInputs({ localization: remaining.localization }))))
      throw new ComposerError('PLAN_MISMATCH', 'Removal inputs differ from the verified persisted feature; refusing to replace a retained feature');
  }
  if (!options.remove.some((name) => status.features[name as FeatureName]))
    return { receipt: status.receipt, backupPath: status.backupPath };
  if (status.features.localization) {
    if (!options.ensureClientClosed)
      throw new ComposerError('CLIENT_RUNNING_UNKNOWN', 'Removing or preserving localization requires the client to be closed');
    options.ensureClientClosed();
  }
  if (Object.keys(remaining).length === 0) {
    // Nothing remains: restore the exact verified original, publishing no new
    // receipt.
    qualifyHostMutation(io);
    const operation = await withOperationEvent(io, { stage: 'host.remove', installationId: status.installationId, detail: `features=${options.remove.join('+')}` }, (io) =>
      withHostLock(io, status.installationId, async () => {
        restoreOriginalArchive(
          io,
          {
            backupPath: status.backupPath as string,
            originalHash: status.originalHash as string,
            currentHash: status.currentHash,
            unpackedHash: status.unpackedHash,
          },
          status.features.localization ? options.ensureClientClosed : undefined,
        );
        return {};
      }),
    );
    return { receipt: null, backupPath: status.backupPath, warnings: operation.warnings };
  }
  const result = await applyFeatures(io, {
    features: remaining,
    ensureClientClosed: options.ensureClientClosed,
    transaction: options.transaction,
    carryInstalled: false,
  });
  return { receipt: result.receipt, backupPath: result.backupPath, warnings: result.warnings };
}

export { verifyPristineOriginal, sha256File };
