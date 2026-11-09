import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getBuiltinModelPrices, validateCustomPrices } from '../../lib/pricing-core.mjs';
import { dataDir, readJson, writeJson } from './settings.mjs';

/** @param {import("../../lib/pricing-core.mjs").ModelPrice[]} prices */
function revision(prices) {
  return crypto.createHash('sha256').update(JSON.stringify(prices)).digest('hex');
}

// In-process last-known-good pricing, keyed by data directory. A restart loses
// it on purpose: stale custom prices must never be invented from memory.
/** @type {{directory: string, prices: import("../../lib/pricing-core.mjs").ModelPrice[], revision: string} | null} */
let lastGood = null;

/** @param {string} directory */
function pricingFilename(directory) {
  return path.join(directory, 'pricing.json');
}

/** @param {string} directory */
function fileDigestToken(directory) {
  try {
    const bytes = fs.readFileSync(pricingFilename(directory));
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch {
    // The damaged bytes cannot be read, so no repair evidence token exists.
    return null;
  }
}

export function readPricing({ directory = dataDir() } = {}) {
  const filename = pricingFilename(directory);
  const saved = readJson(filename);
  /** @type {import("../../lib/pricing-core.mjs").ModelPrice[]} */
  let prices = [];
  if (saved !== null || fs.existsSync(filename)) {
    if (
      !saved ||
      typeof saved !== 'object' ||
      Array.isArray(saved) ||
      Object.keys(saved).some((key) => !['schema', 'prices'].includes(key))
    ) {
      throw new Error('Invalid saved pricing');
    }
    if (saved.schema !== 1) throw new Error('Unsupported pricing schema');
    prices = validateCustomPrices(saved.prices);
  }
  const result = { prices, revision: revision(prices), defaults: getBuiltinModelPrices() };
  lastGood = { directory, prices: result.prices, revision: result.revision };
  return result;
}

/**
 * Telemetry-entry pricing read: a malformed pricing.json must not block token
 * metrics, but it must never surface as an empty override list or a plain
 * built-in-price result. Returns status 'ok' | 'stale' | 'unavailable' plus
 * damage metadata; stale carries the last verified snapshot from this process.
 * @returns {import('./contracts.js').PricingStatus}
 */
export function readPricingStatus({ directory = dataDir() } = {}) {
  try {
    return {
      ...readPricing({ directory }),
      status: 'ok',
      pricingDamaged: false,
      damage: null,
      recoveryToken: null,
    };
  } catch (error) {
    const damaged = { pricingDamaged: true, damage: error.message };
    if (lastGood?.directory === directory) {
      return {
        prices: lastGood.prices,
        revision: lastGood.revision,
        defaults: getBuiltinModelPrices(),
        status: 'stale',
        ...damaged,
        recoveryToken: fileDigestToken(directory),
      };
    }
    return {
      prices: [],
      revision: null,
      defaults: getBuiltinModelPrices(),
      recoveryToken: fileDigestToken(directory),
      ...damaged,
      status: 'unavailable',
    };
  }
}

/** @param {{prices:unknown,revision:string}} request */
export function savePricing(request, { directory = dataDir() } = {}) {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !['prices', 'revision'].includes(key)) ||
    typeof request.revision !== 'string' ||
    !/^[a-f\d]{64}$/.test(request.revision)
  ) {
    throw new Error('Invalid pricing request');
  }
  const prices = validateCustomPrices(request.prices);
  let current;
  try {
    current = readPricing({ directory });
  } catch {
    throw new Error('Saved pricing is damaged or unreadable; repair it before saving');
  }
  if (current.revision !== request.revision) {
    throw new Error('Prices changed; reload before saving again');
  }
  writeJson(pricingFilename(directory), { schema: 1, prices });
  return readPricing({ directory });
}

/**
 * Explicit repair of a damaged pricing.json. The request must carry the
 * recovery token issued with the damage report; it is recomputed from the
 * current file so concurrent changes are rejected. The exact damaged bytes are
 * preserved in a uniquely named, exclusively created quarantine file before an
 * atomic replacement. Prior quarantines are never overwritten.
 * @param {{prices: unknown, recoveryToken: string}} request
 */
export function repairPricing(request, { directory = dataDir() } = {}) {
  if (
    !request ||
    typeof request !== 'object' ||
    Array.isArray(request) ||
    Object.keys(request).some((key) => !['prices', 'recoveryToken'].includes(key)) ||
    typeof request.recoveryToken !== 'string' ||
    !/^[a-f\d]{64}$/.test(request.recoveryToken)
  ) {
    throw new Error('Invalid pricing repair request');
  }
  const prices = validateCustomPrices(request.prices);
  const filename = pricingFilename(directory);
  let damagedBytes;
  try {
    damagedBytes = fs.readFileSync(filename);
  } catch (error) {
    throw new Error(
      error.code === 'ENOENT'
        ? 'Damaged pricing file is no longer present; reload prices before repairing'
        : 'Damaged pricing file cannot be read for evidence preservation; fix access first',
    );
  }
  const token = crypto.createHash('sha256').update(damagedBytes).digest('hex');
  if (token !== request.recoveryToken) {
    throw new Error('Saved pricing changed since the damage was reported; reload before repairing');
  }
  quarantineDamagedPricing(directory, damagedBytes);
  writeJson(filename, { schema: 1, prices });
  return { ...readPricing({ directory }), status: 'ok', pricingDamaged: false, damage: null };
}

/** @param {string} directory @param {Buffer} bytes */
function quarantineDamagedPricing(directory, bytes) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = crypto.randomBytes(4).toString('hex');
    const quarantine = path.join(directory, `pricing.corrupt.${stamp}-${suffix}.json`);
    try {
      fs.writeFileSync(quarantine, bytes, { flag: 'wx', mode: 0o600 });
      return quarantine;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not create a unique quarantine file for the damaged pricing data');
}
