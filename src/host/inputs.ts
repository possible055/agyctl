import { ComposerError, type HostPlan, type PlannedObservedSource } from './contracts.js';
import { sha256, stableStringify } from './hash.js';

export interface AdapterEdit {
  file: string;
  anchor: string;
  insertBefore?: string;
  insertAfter?: string;
  /** When set, the anchor span itself is replaced by this text (plan §5.3). */
  replaceAnchor?: string;
}

export interface CapsuleFeatureInput {
  code: string;
}

export interface LocalizationFeatureInput {
  engineFile: Buffer;
  preloadBridge: Buffer;
  profileId: string;
  stateRoot: string;
  adapterEdits?: AdapterEdit[];
  files?: Record<string, Buffer>;
  /** Observed-source evidence bound into the plan (continuation plan §5.1). */
  observedSource?: PlannedObservedSource | null;
}

export interface FeatureInputs {
  capsule?: CapsuleFeatureInput;
  localization?: LocalizationFeatureInput;
}

export function encodeFeatureInputs(features: FeatureInputs): object {
  return {
    ...(features.capsule ? { capsule: { code: features.capsule.code } } : {}),
    ...(features.localization ? { localization: {
      ...features.localization,
      observedSource: features.localization.observedSource ?? null,
      engineFile: features.localization.engineFile.toString('base64'),
      preloadBridge: features.localization.preloadBridge.toString('base64'),
      adapterEdits: features.localization.adapterEdits ?? [],
      files: Object.fromEntries(Object.entries(features.localization.files ?? {}).map(([name, bytes]) => [name, bytes.toString('base64')])),
    } } : {}),
  };
}

export function decodeFeatureInputs(value: unknown): FeatureInputs {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComposerError('RECEIPT_INVALID', 'Feature inputs must be an object');
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((name) => name !== 'capsule' && name !== 'localization'))
    throw new ComposerError('FEATURE_UNKNOWN', 'Unknown persisted feature input');
  const result: FeatureInputs = {};
  if (raw.capsule !== undefined) {
    const capsule = raw.capsule as CapsuleFeatureInput;
    if (typeof capsule?.code !== 'string')
      throw new ComposerError('RECEIPT_INVALID', 'Invalid persisted capsule code');
    result.capsule = { code: capsule.code };
  }
  if (raw.localization !== undefined) {
    const localization = raw.localization as Record<string, unknown>;
    if (!localization || typeof localization.profileId !== 'string' || typeof localization.stateRoot !== 'string' || !Array.isArray(localization.adapterEdits) || typeof localization.files !== 'object' || localization.files === null || Array.isArray(localization.files))
      throw new ComposerError('RECEIPT_INVALID', 'Incomplete persisted localization inputs');
    const decode = (value: unknown): Buffer => {
      if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value)
        throw new ComposerError('RECEIPT_INVALID', 'Invalid persisted feature bytes');
      return Buffer.from(value, 'base64');
    };
    const observedSource = localization.observedSource;
    if (
      observedSource !== undefined &&
      observedSource !== null &&
      (typeof observedSource !== 'object' ||
        (observedSource as Record<string, unknown>).sourceKind !== 'ls-binary' &&
        (observedSource as Record<string, unknown>).sourceKind !== 'sample-dir')
    )
      throw new ComposerError('RECEIPT_INVALID', 'Invalid persisted observed source');
    result.localization = {
      profileId: localization.profileId,
      stateRoot: localization.stateRoot,
      engineFile: decode(localization.engineFile),
      preloadBridge: decode(localization.preloadBridge),
      adapterEdits: localization.adapterEdits as AdapterEdit[],
      files: Object.fromEntries(Object.entries(localization.files).map(([name, bytes]) => [name, decode(bytes)])),
      observedSource: (observedSource as PlannedObservedSource | null | undefined) ?? null,
    };
  }
  return result;
}

export function plannedFeatureStateFor(features: FeatureInputs): HostPlan['features'] {
  const result: HostPlan['features'] = {};
  if (features.capsule) result.capsule = { codeHash: sha256(features.capsule.code) };
  if (features.localization) {
    result.localization = {
      engineHash: sha256(features.localization.engineFile),
      preloadBridgeHash: sha256(features.localization.preloadBridge),
      profileId: features.localization.profileId,
      stateRoot: features.localization.stateRoot,
      adapterEdits: (features.localization.adapterEdits ?? []).map((edit) => ({
        file: edit.file,
        anchor: edit.anchor,
        ...(edit.insertBefore !== undefined ? { insertBefore: edit.insertBefore } : {}),
        ...(edit.insertAfter !== undefined ? { insertAfter: edit.insertAfter } : {}),
        ...(edit.replaceAnchor !== undefined ? { replaceAnchor: edit.replaceAnchor } : {}),
      })),
      files: Object.fromEntries(
        Object.entries(features.localization.files ?? {}).map(([name, content]) => [
          name,
          sha256(content),
        ]),
      ),
      observedSource: features.localization.observedSource ?? null,
    };
  }
  return result;
}

export function assertPlanInputs(plan: HostPlan, features: FeatureInputs): void {
  const featureNames = Object.keys(plan.features);
  for (const name of featureNames) {
    if (name !== 'capsule' && name !== 'localization')
      throw new ComposerError('FEATURE_UNKNOWN', `Unknown feature: ${name}`);
  }
  if (plan.requiresClientClosed && features.localization === undefined)
    throw new ComposerError('PLAN_MISMATCH', 'Plan requires localization inputs');
  if (Boolean(features.capsule) !== Boolean(plan.features.capsule) || Boolean(features.localization) !== Boolean(plan.features.localization))
    throw new ComposerError('PLAN_MISMATCH', 'Feature inputs do not match the plan');
  if (features.capsule && plan.features.capsule && sha256(features.capsule.code) !== plan.features.capsule.codeHash)
    throw new ComposerError('PLAN_MISMATCH', 'Capsule code does not match the planned hash');
  if (features.localization && plan.features.localization) {
    const planned = plan.features.localization;
    if (
      sha256(features.localization.engineFile) !== planned.engineHash ||
      sha256(features.localization.preloadBridge) !== planned.preloadBridgeHash ||
      features.localization.profileId !== planned.profileId ||
      features.localization.stateRoot !== planned.stateRoot
    )
      throw new ComposerError('PLAN_MISMATCH', 'Localization inputs do not match the planned state');
    const plannedEdits = stableStringify(planned.adapterEdits);
    const loadedEdits = stableStringify(
      (features.localization.adapterEdits ?? []).map((edit) => ({
        file: edit.file,
        anchor: edit.anchor,
        ...(edit.insertBefore !== undefined ? { insertBefore: edit.insertBefore } : {}),
        ...(edit.insertAfter !== undefined ? { insertAfter: edit.insertAfter } : {}),
        ...(edit.replaceAnchor !== undefined ? { replaceAnchor: edit.replaceAnchor } : {}),
      })),
    );
    if (plannedEdits !== loadedEdits)
      throw new ComposerError('PLAN_MISMATCH', 'Adapter edits do not match the planned state');
    const loadedFiles = Object.fromEntries(
      Object.entries(features.localization.files ?? {}).map(([name, content]) => [name, sha256(content)]),
    );
    if (stableStringify(planned.files) !== stableStringify(loadedFiles))
      throw new ComposerError('PLAN_MISMATCH', 'Localization files do not match the planned state');
    if (stableStringify(planned.observedSource ?? null) !== stableStringify(features.localization.observedSource ?? null))
      throw new ComposerError('PLAN_MISMATCH', 'Observed-source evidence does not match the planned state');
  }
}
