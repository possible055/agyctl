import { ComposerError, type FeatureName } from './contracts.js';
import type { PreparedFeature } from './features.js';
import { decodeFeatureInputs, encodeFeatureInputs, type FeatureInputs } from './inputs.js';

const retained = new WeakMap<object, PreparedFeature>();

export function retainedFeature(input: object): PreparedFeature | undefined {
  return retained.get(input);
}

function decodeBytes(value: unknown): Buffer {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value)
    throw new ComposerError('RECEIPT_INVALID', 'Invalid prepared feature bytes');
  return Buffer.from(value, 'base64');
}

export function decodeStoredInputs(value: unknown): FeatureInputs {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new ComposerError('RECEIPT_INVALID', 'Saved Host payload must be an object');
  const { prepared, ...raw } = value as Record<string, unknown>;
  const features = decodeFeatureInputs(raw);
  if (typeof prepared !== 'object' || prepared === null || Array.isArray(prepared))
    throw new ComposerError('RECEIPT_INVALID', 'Invalid prepared Host contributions');
  for (const name of ['capsule', 'localization'] as const) {
    const input = features[name];
    if (!input) continue;
    const row = (prepared as Record<string, unknown>)[name];
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      throw new ComposerError('RECEIPT_INVALID', `Invalid prepared ${name} contribution`);
    const fields = row as Record<string, unknown>;
    if (typeof fields.preload !== 'string' || typeof fields.files !== 'object' || fields.files === null || Array.isArray(fields.files))
      throw new ComposerError('RECEIPT_INVALID', `Incomplete prepared ${name} contribution`);
    retained.set(input, {
      preload: fields.preload,
      files: Object.fromEntries(Object.entries(fields.files).map(([file, bytes]) => [file, decodeBytes(bytes)])),
      ...(fields.receiptState ? { receiptState: fields.receiptState as PreparedFeature['receiptState'] } : {}),
    });
  }
  return features;
}

export function encodeStoredInputs(features: FeatureInputs, prepared: Partial<Record<FeatureName, PreparedFeature>>): object {
  return {
    ...encodeFeatureInputs(features),
    prepared: Object.fromEntries(Object.entries(prepared).map(([name, contribution]) => [name, {
      ...contribution,
      files: Object.fromEntries(Object.entries(contribution.files).map(([file, bytes]) => [file, bytes.toString('base64')])),
    }])),
  };
}
