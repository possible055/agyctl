// Shared contracts for the single Host patch transaction (plan §9). The
// receipt schema is versioned; validators treat external JSON as unknown and
// fail with stable codes instead of guessing.

export const HOST_RECEIPT_SCHEMA_VERSION = 3;
export const HOST_PLAN_SCHEMA_VERSION = 3;
export const TOOLING_EVENT_SCHEMA_VERSION = 1;

export type ToolingLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Structured localization event (continuation plan §4.2). Node tooling appends
 * these as JSONL; preload/renderer code only ever sees the type, never the
 * writer. `detail` carries a bounded summary — never full sources, payloads or
 * secrets.
 */
export interface ToolingEvent {
  schemaVersion: number;
  /** UTC ISO 8601. */
  timestamp: string;
  level: ToolingLogLevel;
  runId: string;
  operationId: string;
  component: string;
  stage: string;
  event: string;
  result: string;
  installationId?: string;
  planId?: string;
  artifactId?: string;
  locale?: string;
  adapterId?: string;
  sourceIdentity?: string;
  messageId?: string;
  member?: string;
  durationMs?: number;
  code?: string;
  counts?: Record<string, number>;
  detail?: string;
}

/** Caller-supplied event fields; the emitter adds the envelope fields. */
export type ToolingEventInput = Omit<
  ToolingEvent,
  'schemaVersion' | 'timestamp' | 'runId' | 'operationId' | 'component'
>;

/** Refusal detector for retired Capsule-only archives; never emitted. */
export const CAPSULE_HOOK_MARKER = '// [agyctl Input Capsule Hook]';
/** Distinct markers for features actually composed by the Host Composer. */
export const HOST_MANAGED_MARKER = '// [agyctl Host Managed Archive]';
export const HOST_CAPSULE_FEATURE_MARKER = '// [agyctl Host Capsule Feature]';
export const LOCALIZATION_BRIDGE_MARKER = '// [agyctl Localization Bridge]';

export type FeatureName = 'capsule' | 'localization';
export type BaseProvenance = 'official-profile' | 'original-recorded';

export interface CapsuleFeatureState {
  codeHash: string;
}

export interface PlannedAdapterEdit {
  file: string;
  anchor: string;
  insertBefore?: string;
  insertAfter?: string;
  /** When set, the anchor span itself is replaced by this text (plan §5.3). */
  replaceAnchor?: string;
}

/** What the tool actually read from the current installation source: content
 * identity, structural recognition and warnings. It records evidence, never
 * installation qualification (continuation plan §5.1). */
export interface PlannedObservedSource {
  sourceKind: 'ls-binary' | 'sample-dir';
  lsSha256: string | null;
  sourceIdentity: string;
  nlsHelperCalleeName: string | null;
  matchedProfileId: string | null;
  warnings: Array<{ code: string; message: string }>;
}

export interface LocalizationFeatureState {
  engineHash: string;
  profileId: string;
  profileStatus?: string;
  stateRoot: string;
  observedSource?: PlannedObservedSource | null;
}

/** Plan features bind every input: adapter edits verbatim, payloads by hash. */
export interface PlannedLocalizationFeatureState {
  engineHash: string;
  preloadBridgeHash: string;
  profileId: string;
  stateRoot: string;
  /** Bound verbatim so a reviewer sees exactly what will be inserted. */
  adapterEdits: PlannedAdapterEdit[];
  /** Large payloads bind by content hash: name -> sha256. */
  files: Record<string, string>;
  observedSource: PlannedObservedSource | null;
}

export interface HostReceipt {
  schemaVersion: typeof HOST_RECEIPT_SCHEMA_VERSION;
  installationId: string;
  asarPath: string;
  baseProvenance: BaseProvenance;
  originalHash: string;
  patchedHash: string;
  unpackedHash: string | null;
  originalBackupRef: string;
  inputsHash: string;
  features: {
    capsule?: CapsuleFeatureState;
    localization?: LocalizationFeatureState;
  };
}

/**
 * A plan is a reviewable, read-only snapshot: it binds every input content and
 * the target identity, but never a backup path — apply resolves (and creates,
 * if missing) the immutable original itself and re-verifies every binding.
 */
export interface HostPlan {
  schemaVersion: typeof HOST_PLAN_SCHEMA_VERSION;
  planId: string;
  installationId: string;
  asarPath: string;
  channel: string;
  currentHash: string;
  unpackedHash: string | null;
  originalHash: string;
  baseProvenance: BaseProvenance;
  features: {
    capsule?: CapsuleFeatureState;
    localization?: PlannedLocalizationFeatureState;
  };
  requiresClientClosed: boolean;
}

export type ComposerErrorCode =
  | 'BACKUP_DIRTY'
  | 'CLIENT_RUNNING'
  | 'CLIENT_RUNNING_UNKNOWN'
  | 'FEATURE_UNKNOWN'
  | 'HOST_CONFLICT'
  | 'LOCK_BUSY'
  | 'PLAN_MISMATCH'
  | 'RECEIPT_INVALID'
  | 'SOURCE_MISMATCH'
  | 'UNSUPPORTED_STATE';

export class ComposerError extends Error {
  constructor(
    readonly code: ComposerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ComposerError';
  }
}

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function reject(code: ComposerErrorCode, message: string): never {
  throw new ComposerError(code, message);
}

function validateFeatures(value: unknown): HostReceipt['features'] {
  if (typeof value !== 'object' || value === null) reject('RECEIPT_INVALID', 'Receipt features must be an object');
  const features = value as Record<string, unknown>;
  const result: HostReceipt['features'] = {};
  for (const key of Object.keys(features)) {
    if (key !== 'capsule' && key !== 'localization')
      reject('RECEIPT_INVALID', `Unknown receipt feature: ${key}`);
    const state = features[key];
    if (typeof state !== 'object' || state === null)
      reject('RECEIPT_INVALID', `Receipt feature ${key} must be an object`);
    const fields = state as Record<string, unknown>;
    const checked: Record<string, unknown> = {};
    for (const [field, expected] of Object.entries(
      key === 'capsule' ? { codeHash: true } : { engineHash: true, profileId: false, stateRoot: false },
    )) {
      const raw = fields[field];
      if (expected ? !isSha256(raw) : typeof raw !== 'string' || raw.length === 0)
        reject('RECEIPT_INVALID', `Receipt feature ${key} has an invalid ${field}`);
      checked[field] = raw;
    }
    if (key === 'localization')
      checked.observedSource = validateObservedSource(fields.observedSource ?? null) ?? undefined;
    if (key === 'localization' && fields.profileStatus !== undefined) {
      if (typeof fields.profileStatus !== 'string' || fields.profileStatus.length === 0)
        reject('RECEIPT_INVALID', 'Receipt feature localization has an invalid profileStatus');
      checked.profileStatus = fields.profileStatus;
    }
    result[key as FeatureName] = checked as never;
  }
  if (Object.keys(result).length === 0)
    reject('RECEIPT_INVALID', 'Receipt must list at least one feature');
  return result;
}

function validateObservedSource(value: unknown): PlannedObservedSource | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object')
    reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource');
  const fields = value as Record<string, unknown>;
  if (fields.sourceKind !== 'ls-binary' && fields.sourceKind !== 'sample-dir')
    reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource sourceKind');
  if (!isSha256(fields.sourceIdentity))
    reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource identity');
  if (fields.lsSha256 !== null && fields.lsSha256 !== undefined && !isSha256(fields.lsSha256))
    reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource lsSha256');
  if (
    fields.nlsHelperCalleeName !== null &&
    fields.nlsHelperCalleeName !== undefined &&
    typeof fields.nlsHelperCalleeName !== 'string'
  )
    reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource helper');
  if (
    fields.matchedProfileId !== null &&
    fields.matchedProfileId !== undefined &&
    typeof fields.matchedProfileId !== 'string'
  )
    reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource profile');
  if (!Array.isArray(fields.warnings))
    reject('RECEIPT_INVALID', 'Plan feature localization has invalid observedSource warnings');
  const warnings = (fields.warnings as unknown[]).map((warning) => {
    if (typeof warning !== 'object' || warning === null)
      reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource warning');
    const row = warning as Record<string, unknown>;
    if (typeof row.code !== 'string' || typeof row.message !== 'string')
      reject('RECEIPT_INVALID', 'Plan feature localization has an invalid observedSource warning');
    return { code: row.code, message: row.message };
  });
  return {
    sourceKind: fields.sourceKind as PlannedObservedSource['sourceKind'],
    lsSha256: (fields.lsSha256 as string | null | undefined) ?? null,
    sourceIdentity: fields.sourceIdentity as string,
    nlsHelperCalleeName: (fields.nlsHelperCalleeName as string | null | undefined) ?? null,
    matchedProfileId: (fields.matchedProfileId as string | null | undefined) ?? null,
    warnings,
  };
}

/** Plan features bind every input: large payloads by hash, adapter edits verbatim. */
function validatePlanFeatures(value: unknown): HostPlan['features'] {
  if (typeof value !== 'object' || value === null)
    reject('RECEIPT_INVALID', 'Plan features must be an object');
  const features = value as Record<string, unknown>;
  const result: HostPlan['features'] = {};
  for (const key of Object.keys(features)) {
    if (key !== 'capsule' && key !== 'localization')
      reject('RECEIPT_INVALID', `Unknown plan feature: ${key}`);
    const fields = features[key] as Record<string, unknown>;
    if (typeof fields !== 'object' || fields === null)
      reject('RECEIPT_INVALID', `Plan feature ${key} must be an object`);
    if (key === 'capsule') {
      if (!isSha256(fields.codeHash))
        reject('RECEIPT_INVALID', 'Plan feature capsule has an invalid codeHash');
      result.capsule = { codeHash: fields.codeHash as string };
      continue;
    }
    if (!isSha256(fields.engineHash) || !isSha256(fields.preloadBridgeHash))
      reject('RECEIPT_INVALID', 'Plan feature localization has an invalid input hash');
    if (typeof fields.profileId !== 'string' || fields.profileId.length === 0)
      reject('RECEIPT_INVALID', 'Plan feature localization has an invalid profileId');
    if (typeof fields.stateRoot !== 'string' || fields.stateRoot.length === 0)
      reject('RECEIPT_INVALID', 'Plan feature localization has an invalid stateRoot');
    if (!Array.isArray(fields.adapterEdits))
      reject('RECEIPT_INVALID', 'Plan feature localization has invalid adapterEdits');
    const adapterEdits = (fields.adapterEdits as unknown[]).map((edit) => {
      if (typeof edit !== 'object' || edit === null)
        reject('RECEIPT_INVALID', 'Plan feature localization has an invalid adapter edit');
      const row = edit as Record<string, unknown>;
      if (typeof row.file !== 'string' || row.file.length === 0 || typeof row.anchor !== 'string' || row.anchor.length === 0)
        reject('RECEIPT_INVALID', 'Plan feature localization has an invalid adapter edit');
      const actions = [row.insertBefore, row.insertAfter, row.replaceAnchor].filter(
        (action) => typeof action === 'string',
      ).length;
      if (actions !== 1)
        reject('RECEIPT_INVALID', 'Plan feature localization has an invalid adapter edit');
      return {
        file: row.file as string,
        anchor: row.anchor as string,
        ...(typeof row.insertBefore === 'string' ? { insertBefore: row.insertBefore } : {}),
        ...(typeof row.insertAfter === 'string' ? { insertAfter: row.insertAfter } : {}),
        ...(typeof row.replaceAnchor === 'string' ? { replaceAnchor: row.replaceAnchor } : {}),
      };
    });
    if (typeof fields.files !== 'object' || fields.files === null)
      reject('RECEIPT_INVALID', 'Plan feature localization has invalid files');
    const files: Record<string, string> = {};
    for (const [name, hash] of Object.entries(fields.files as Record<string, unknown>)) {
      if (!isSha256(hash))
        reject('RECEIPT_INVALID', `Plan feature localization has an invalid file hash for ${name}`);
      files[name] = hash as string;
    }
    const observedSource = validateObservedSource(fields.observedSource ?? null);
    result.localization = {
      engineHash: fields.engineHash as string,
      preloadBridgeHash: fields.preloadBridgeHash as string,
      profileId: fields.profileId as string,
      stateRoot: fields.stateRoot as string,
      adapterEdits,
      files,
      observedSource,
    };
  }
  if (Object.keys(result).length === 0)
    reject('RECEIPT_INVALID', 'Plan must list at least one feature');
  return result;
}

/** Validates an external plan document; tampered or stale-schema plans are refused. */
export function validateHostPlan(value: unknown): HostPlan {
  if (typeof value !== 'object' || value === null)
    reject('RECEIPT_INVALID', 'Host plan must be a JSON object');
  const plan = value as Record<string, unknown>;
  const schemaVersion = plan.schemaVersion;
  if (schemaVersion !== HOST_PLAN_SCHEMA_VERSION)
    reject('RECEIPT_INVALID', `Unsupported host plan schemaVersion: ${String(schemaVersion)}`);
  for (const field of ['planId', 'installationId', 'currentHash', 'originalHash'] as const) {
    if (!isSha256(plan[field])) reject('RECEIPT_INVALID', `Host plan has an invalid ${field}`);
  }
  if (typeof plan.asarPath !== 'string' || plan.asarPath.length === 0)
    reject('RECEIPT_INVALID', 'Host plan has an invalid asarPath');
  if (typeof plan.channel !== 'string' || plan.channel.length === 0)
    reject('RECEIPT_INVALID', 'Host plan has an invalid channel');
  if (plan.baseProvenance !== 'official-profile' && plan.baseProvenance !== 'original-recorded')
    reject('RECEIPT_INVALID', `Unknown baseProvenance: ${String(plan.baseProvenance)}`);
  if (plan.unpackedHash !== null && !isSha256(plan.unpackedHash))
    reject('RECEIPT_INVALID', 'Host plan has an invalid unpackedHash');
  if (typeof plan.requiresClientClosed !== 'boolean')
    reject('RECEIPT_INVALID', 'Host plan has an invalid requiresClientClosed');
  const features = validatePlanFeatures(plan.features);
  if (plan.requiresClientClosed !== Boolean(features.localization))
    reject('RECEIPT_INVALID', 'Host plan client-closed requirement does not match its features');
  return {
    schemaVersion: schemaVersion as HostPlan['schemaVersion'],
    planId: plan.planId as string,
    installationId: plan.installationId as string,
    asarPath: plan.asarPath as string,
    channel: plan.channel as string,
    currentHash: plan.currentHash as string,
    unpackedHash: plan.unpackedHash as string | null,
    originalHash: plan.originalHash as string,
    baseProvenance: plan.baseProvenance as BaseProvenance,
    features,
    requiresClientClosed: plan.requiresClientClosed as boolean,
  };
}

/** Validates an external receipt document; tampered or placeholder values are refused. */
export function validateHostReceipt(value: unknown): HostReceipt {
  if (typeof value !== 'object' || value === null)
    reject('RECEIPT_INVALID', 'Host receipt must be a JSON object');
  const receipt = value as Record<string, unknown>;
  const schemaVersion = receipt.schemaVersion;
  if (schemaVersion !== HOST_RECEIPT_SCHEMA_VERSION)
    reject('RECEIPT_INVALID', `Unsupported host receipt schemaVersion: ${String(schemaVersion)}`);
  for (const field of ['installationId', 'originalHash', 'patchedHash'] as const) {
    if (!isSha256(receipt[field])) reject('RECEIPT_INVALID', `Host receipt has an invalid ${field}`);
  }
  if (typeof receipt.asarPath !== 'string' || receipt.asarPath.length === 0)
    reject('RECEIPT_INVALID', 'Host receipt has an invalid asarPath');
  if (receipt.baseProvenance !== 'official-profile' && receipt.baseProvenance !== 'original-recorded')
    reject('RECEIPT_INVALID', `Unknown baseProvenance: ${String(receipt.baseProvenance)}`);
  if (receipt.unpackedHash !== null && !isSha256(receipt.unpackedHash))
    reject('RECEIPT_INVALID', 'Host receipt has an invalid unpackedHash');
  if (typeof receipt.originalBackupRef !== 'string' || receipt.originalBackupRef.length === 0)
    reject('RECEIPT_INVALID', 'Host receipt has an invalid originalBackupRef');
  if (!isSha256(receipt.inputsHash))
    reject('RECEIPT_INVALID', 'Host receipt has an invalid inputsHash');
  return {
    schemaVersion: schemaVersion as HostReceipt['schemaVersion'],
    installationId: receipt.installationId as string,
    asarPath: receipt.asarPath as string,
    baseProvenance: receipt.baseProvenance,
    originalHash: receipt.originalHash as string,
    patchedHash: receipt.patchedHash as string,
    unpackedHash: receipt.unpackedHash as string | null,
    originalBackupRef: receipt.originalBackupRef as string,
    inputsHash: receipt.inputsHash as string,
    features: validateFeatures(receipt.features),
  };
}

export function receiptPathFor(backupDir: string, installationId: string, patchedHash: string): string {
  return `${backupDir}/host/${installationId}/records/${patchedHash}.json`.replaceAll('\\', '/');
}
