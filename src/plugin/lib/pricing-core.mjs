/**
 * Shared pricing core: model-family resolution and USD cost computation used
 * by BOTH the Node sidecar (plugin/sidecars/panel/pricing.mjs) and the
 * injected capsule. Pure data and functions with no I/O; metrics-core
 * consumes it per turn, so any price change must keep both callers in sync.
 */

const ARGON_RATE_CHANGE_MS = Date.parse('2026-12-01T00:00:00Z');
const ARGON_INTRO_PRICING = { input: 2, output: 10, cacheRead: 0.1, thinking: 10 };
const ARGON_STANDARD_PRICING = { input: 4, output: 20, cacheRead: 0.2, thinking: 20 };

const FLASH_RATE_CHANGE_MS = Date.parse('2027-01-01T00:00:00Z');
const FLASH_INTRO_PRICING = { input: 0.75, output: 3.75, cacheRead: 0.075, thinking: 3.75 };
const FLASH_STANDARD_PRICING = { input: 1.5, output: 7.5, cacheRead: 0.15, thinking: 7.5 };

const PLACEHOLDER_FAMILY_MAP = {
  MODEL_PLACEHOLDER_M417: 'gemini-4-argon',
  MODEL_PLACEHOLDER_M418: 'gemini-4-argon',
  MODEL_PLACEHOLDER_M419: 'gemini-4-argon',
  MODEL_PLACEHOLDER_M318: 'gemini-3.8-flash',
  MODEL_PLACEHOLDER_M319: 'gemini-3.8-flash',
  MODEL_PLACEHOLDER_M320: 'gemini-3.8-flash',
  MODEL_PLACEHOLDER_M322: 'gemini-3.8-flash',
  MODEL_PLACEHOLDER_M298: 'gemini-3.7-flash',
  MODEL_PLACEHOLDER_M299: 'gemini-3.7-flash',
  MODEL_PLACEHOLDER_M300: 'gemini-3.7-flash',
  MODEL_PLACEHOLDER_M71: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M72: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M73: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M264: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M265: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M266: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M196: 'gemini-3.6-flash',
  MODEL_PLACEHOLDER_M84: 'gemini-3.5-flash',
  MODEL_PLACEHOLDER_M20: 'gemini-3.5-flash',
  MODEL_PLACEHOLDER_M187: 'gemini-3.5-flash',
  MODEL_PLACEHOLDER_M133: 'gemini-3-flash',
  MODEL_PLACEHOLDER_M132: 'gemini-3-flash',
  MODEL_PLACEHOLDER_M47: 'gemini-3-flash',
  MODEL_PLACEHOLDER_M18: 'gemini-3-flash',
  MODEL_PLACEHOLDER_M16: 'gemini-3.1-pro',
  MODEL_PLACEHOLDER_M37: 'gemini-3.1-pro',
  MODEL_PLACEHOLDER_M36: 'gemini-3.1-pro',
  MODEL_PLACEHOLDER_M400: 'claude-opus-5-5',
  MODEL_PLACEHOLDER_M401: 'claude-opus-5-5',
  MODEL_PLACEHOLDER_M402: 'claude-opus-5-5',
  MODEL_PLACEHOLDER_M403: 'claude-sonnet-5-5',
  MODEL_PLACEHOLDER_M404: 'claude-sonnet-5-5',
  MODEL_PLACEHOLDER_M405: 'claude-sonnet-5-5',
  MODEL_PLACEHOLDER_M26: 'claude-opus-4-6',
  MODEL_PLACEHOLDER_M35: 'claude-sonnet-4-6',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'gpt-oss-120b',
};

const STATIC_PRICING_MAP = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, thinking: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, thinking: 10 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, thinking: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, thinking: 15 },
  'gemini-3.1-pro': { input: 2, output: 12, cacheRead: 0.2, thinking: 12 },
  'gemini-3.6-flash': { input: 1.5, output: 7.5, cacheRead: 0.15, thinking: 7.5 },
  'gemini-3.5-flash': { input: 1.5, output: 9, cacheRead: 0.15, thinking: 9 },
  'gemini-3-flash': { input: 0.5, output: 3, cacheRead: 0.05, thinking: 3 },
  'gpt-oss-120b': { input: 0.09, output: 0.36, cacheRead: 0, thinking: 0.36 },
};

function resolvePricingTimestamp(at) {
  if (typeof at === 'number' && Number.isFinite(at)) return at;
  if (typeof at === 'string' && at.trim()) {
    const parsed = Date.parse(at.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function resolveModelPricingFamily(chatModel) {
  if (!chatModel || typeof chatModel !== 'object') return null;
  const candidates = [
    chatModel.responseModel,
    chatModel.model,
    chatModel.usage?.model,
    chatModel.modelDisplayName,
  ];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (Object.hasOwn(PLACEHOLDER_FAMILY_MAP, trimmed)) {
      return PLACEHOLDER_FAMILY_MAP[trimmed];
    }
    const lower = trimmed.toLowerCase();
    if (/^gemini[\s_-]*4[\s_-]*argon(?:$|[\s_(-])/.test(lower)) return 'gemini-4-argon';
    if (/^gemini[\s_-]*3[._-]8[\s_-]*flash(?:$|[\s_(-])/.test(lower)) return 'gemini-3.8-flash';
    if (/^gemini[\s_-]*3[._-]7[\s_-]*flash(?:$|[\s_(-])/.test(lower)) return 'gemini-3.7-flash';
    if (/^gemini[\s_-]*3[._-]6[\s_-]*flash(?:$|[\s_(-])/.test(lower)) return 'gemini-3.6-flash';
    if (/^gemini[\s_-]*3[._-]5[\s_-]*flash(?:$|[\s_(-])/.test(lower)) return 'gemini-3.5-flash';
    if (lower === 'gemini-3-flash-agent') return 'gemini-3.5-flash';
    if (/^gemini[\s_-]*3[\s_-]*flash(?:$|[\s_(-])/.test(lower)) return 'gemini-3-flash';
    if (/^gemini[\s_-]*(?:3[._-]1[\s_-]*)?pro(?:$|[\s_(-])/.test(lower)) return 'gemini-3.1-pro';
    if (/^claude[\s_-]*opus[\s_-]*5[._-]5(?:$|[\s_(-])/.test(lower)) return 'claude-opus-5-5';
    if (/^claude[\s_-]*sonnet[\s_-]*5[._-]5(?:$|[\s_(-])/.test(lower)) return 'claude-sonnet-5-5';
    if (/^claude[\s_-]*opus[\s_-]*4[._-]6(?:$|[\s_(-])/.test(lower)) return 'claude-opus-4-6';
    if (/^claude[\s_-]*sonnet[\s_-]*4[._-]6(?:$|[\s_(-])/.test(lower)) return 'claude-sonnet-4-6';
    if (/^gpt[\s_-]*oss[\s_-]*120b(?:$|[\s_(-])/.test(lower)) return 'gpt-oss-120b';
  }
  return null;
}

function validateCustomPrices(value) {
  if (!Array.isArray(value) || value.length > 50)
    throw new Error('Invalid prices: maximum 50 entries');
  const models = new Set();
  return value.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      throw new Error('Invalid price record');
    const keys = ['model', 'input', 'cacheRead', 'output', 'thinking'];
    if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error('Unknown price field');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control characters in model IDs
    if (typeof row.model !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(row.model)) {
      throw new Error('Invalid price model');
    }
    const model = row.model.trim();
    if (!model || model.length > 128) throw new Error('Invalid price model');
    const key = model.toLowerCase();
    if (models.has(key)) throw new Error(`Duplicate price model: ${model}`);
    models.add(key);
    for (const field of keys.slice(1)) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) {
        throw new Error(`Invalid price: ${field}`);
      }
    }
    return {
      model,
      input: row.input,
      cacheRead: row.cacheRead,
      output: row.output,
      thinking: row.thinking,
    };
  });
}

function getModelPricing(chatModel, at, customPrices = []) {
  const candidates = [
    chatModel?.responseModel,
    chatModel?.model,
    chatModel?.usage?.model,
    chatModel?.modelDisplayName,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const exact = customPrices.find(
      (row) => row.model.toLowerCase() === candidate.trim().toLowerCase(),
    );
    if (exact) return exact;
  }
  const family = resolveModelPricingFamily(chatModel);
  if (!family) return null;
  const custom = customPrices.find((row) => row.model.toLowerCase() === family);
  if (custom) return custom;
  if (family === 'gemini-4-argon') {
    return resolvePricingTimestamp(at) < ARGON_RATE_CHANGE_MS
      ? ARGON_INTRO_PRICING
      : ARGON_STANDARD_PRICING;
  }
  if (family === 'gemini-3.8-flash' || family === 'gemini-3.7-flash') {
    return resolvePricingTimestamp(at) < FLASH_RATE_CHANGE_MS
      ? FLASH_INTRO_PRICING
      : FLASH_STANDARD_PRICING;
  }
  return Object.hasOwn(STATIC_PRICING_MAP, family) ? STATIC_PRICING_MAP[family] : null;
}

function getBuiltinModelPrices(at = Date.now()) {
  return [
    'gemini-4-argon',
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    ...Object.keys(STATIC_PRICING_MAP),
  ].map((model) => ({ model, ...getModelPricing({ model }, at) }));
}

function computeTurnCostUsd(tokens, pricing) {
  if (!pricing || !tokens) return 0;
  const input = tokens.input || 0;
  const cache = tokens.cache || 0;
  const thinking = tokens.thinking || 0;
  const response = tokens.response || 0;
  return (
    (input * pricing.input +
      cache * pricing.cacheRead +
      thinking * pricing.thinking +
      response * pricing.output) /
    1_000_000
  );
}

function formatUsd(num) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return '—';
  const n = Math.max(0, Number(num));
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export {
  computeTurnCostUsd,
  formatUsd,
  getBuiltinModelPrices,
  getModelPricing,
  resolveModelPricingFamily,
  validateCustomPrices,
};
