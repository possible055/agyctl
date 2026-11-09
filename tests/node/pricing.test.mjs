import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createSessionAgg,
  mergeGeneratorMetadata,
  metricsFromAgg,
} from '../../src/plugin/lib/metrics-core.mjs';
import { getModelPricing } from '../../src/plugin/lib/pricing-core.mjs';
import {
  readPricing,
  readPricingStatus,
  repairPricing,
  savePricing,
} from '../../src/plugin/sidecars/panel/pricing.mjs';

const price = { model: 'custom-agent', input: 2, cacheRead: 3, output: 5, thinking: 7 };

test('damaged pricing keeps token metrics usable: last-good stays stale, no snapshot reports unavailable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-pricing-dmg-'));
  try {
    const options = { directory };
    const saved = savePricing(
      { prices: [price], revision: readPricing(options).revision },
      options,
    );
    const ok = readPricingStatus(options);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.pricingDamaged, false);
    fs.writeFileSync(path.join(directory, 'pricing.json'), '{broken');
    const stale = readPricingStatus(options);
    assert.equal(stale.status, 'stale');
    assert.equal(stale.pricingDamaged, true);
    assert.deepEqual(stale.prices, [price]);
    assert.equal(stale.revision, saved.revision);
    assert.equal(stale.defaults.find((row) => row.model === 'gemini-3-flash').input, 0.5);
    assert.match(stale.recoveryToken, /^[a-f\d]{64}$/);
    const damagedBytes = fs.readFileSync(path.join(directory, 'pricing.json'));
    assert.equal(
      crypto.createHash('sha256').update(damagedBytes).digest('hex'),
      stale.recoveryToken,
    );
    const freshDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-pricing-dmg2-'));
    try {
      const noSnapshot = { directory: freshDirectory };
      fs.writeFileSync(path.join(freshDirectory, 'pricing.json'), '{also-broken');
      const unavailable = readPricingStatus(noSnapshot);
      assert.equal(unavailable.status, 'unavailable');
      assert.equal(unavailable.pricingDamaged, true);
      assert.deepEqual(unavailable.prices, []);
      assert.equal(unavailable.revision, null);
    } finally {
      fs.rmSync(freshDirectory, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('repair quarantines the exact damaged bytes, rejects concurrent changes, and publishes atomically', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-pricing-fix-'));
  try {
    const options = { directory };
    const saved = savePricing(
      { prices: [price], revision: readPricing(options).revision },
      options,
    );
    const damaged = JSON.stringify({ schema: 1, prices: [{ ...price, output: null }] });
    fs.writeFileSync(path.join(directory, 'pricing.json'), damaged);
    const status = readPricingStatus(options);
    const token = status.recoveryToken;
    assert.throws(
      () => repairPricing({ prices: [price], recoveryToken: '0'.repeat(64) }, options),
      /changed|reload|token/i,
    );
    let quarantined = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith('pricing.corrupt.'));
    assert.equal(quarantined.length, 0);
    const repaired = repairPricing(
      { prices: [{ ...price, input: 9 }], recoveryToken: token },
      options,
    );
    assert.deepEqual(repaired.prices, [{ ...price, input: 9 }]);
    assert.equal(repaired.status ?? 'ok', 'ok');
    quarantined = fs.readdirSync(directory).filter((name) => name.startsWith('pricing.corrupt.'));
    assert.equal(quarantined.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, quarantined[0])).toString(), damaged);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'pricing.json'), 'utf8')), {
      schema: 1,
      prices: [{ ...price, input: 9 }],
    });
    assert.notEqual(repaired.revision, saved.revision);
    assert.throws(
      () => repairPricing({ prices: [price], recoveryToken: token }, options),
      /changed|reload|token/i,
    );
    assert.equal(
      fs.readdirSync(directory).filter((name) => name.startsWith('pricing.corrupt.')).length,
      1,
    );
    for (const request of [
      { prices: [price] },
      { recoveryToken: token },
      { prices: [price], recoveryToken: token, extra: 1 },
      { prices: [{ ...price, model: ' ' }], recoveryToken: token },
    ]) {
      assert.throws(() => repairPricing(request, options), /Invalid|Unknown/i);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('repair refuses missing or unreadable damaged files instead of resetting user data', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-pricing-eio-'));
  try {
    const options = { directory };
    assert.throws(
      () => repairPricing({ prices: [], recoveryToken: '0'.repeat(64) }, options),
      /present|reload|missing/i,
    );
    assert.equal(fs.existsSync(path.join(directory, 'pricing.json')), false);
    fs.writeFileSync(path.join(directory, 'pricing.json'), '{broken');
    const status = readPricingStatus(options);
    assert.match(status.recoveryToken, /^[a-f\d]{64}$/);
    fs.rmSync(path.join(directory, 'pricing.json'));
    assert.throws(
      () => repairPricing({ prices: [price], recoveryToken: status.recoveryToken }, options),
      /present|reload|missing/i,
    );
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.startsWith('pricing.')),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('missing pricing file is a valid empty state while unreadable files surface damage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-pricing-io-'));
  try {
    const options = { directory };
    const missing = readPricingStatus(options);
    assert.equal(missing.status, 'ok');
    assert.deepEqual(missing.prices, []);
    assert.equal(missing.revision, readPricing(options).revision);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('pricing persists validated overrides atomically and rejects stale revisions or corrupt storage', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-pricing-'));
  try {
    const options = { directory };
    const initial = readPricing(options);
    assert.deepEqual(initial.prices, []);
    assert.equal(initial.defaults.find((row) => row.model === 'gemini-3-flash').input, 0.5);
    const saved = savePricing(
      { prices: [{ ...price, model: ' custom-agent ' }], revision: initial.revision },
      options,
    );
    assert.deepEqual(saved.prices, [price]);
    assert.deepEqual(readPricing(options).prices, [price]);
    assert.throws(
      () => savePricing({ prices: [], revision: initial.revision }, options),
      /changed.*reload/i,
    );
    assert.deepEqual(readPricing(options).prices, [price]);
    for (const prices of [
      [{ ...price, input: -1 }],
      [{ ...price, cacheRead: Infinity }],
      [{ ...price, output: '2' }],
      [{ ...price, thinking: NaN }],
      [{ ...price, extra: 1 }],
      [{ model: 'missing' }],
      [{ ...price, model: '\ninvalid' }],
      [{ ...price, model: ' ' }],
      [{ ...price, model: 'x'.repeat(129) }],
      [price, { ...price, model: 'CUSTOM-agent' }],
      Array.from({ length: 51 }, (_, index) => ({ ...price, model: `model-${index}` })),
    ]) {
      assert.throws(
        () => savePricing({ prices, revision: saved.revision }, options),
        /Invalid|Duplicate|maximum|Unknown/i,
      );
    }
    assert.throws(
      () => savePricing({ prices: [], revision: saved.revision, extra: true }, options),
      /Invalid|Unknown/i,
    );
    const empty = savePricing({ prices: [], revision: saved.revision }, options);
    assert.deepEqual(empty.prices, []);
    assert.equal(empty.revision, initial.revision);
    assert.deepEqual(fs.readdirSync(directory), ['pricing.json']);
    for (const corrupt of [
      null,
      { schema: 2, prices: [] },
      { schema: 1, prices: [], secret: true },
      { schema: 1, prices: [{ ...price, output: null }] },
    ]) {
      fs.writeFileSync(path.join(directory, 'pricing.json'), JSON.stringify(corrupt));
      assert.throws(() => readPricing(options), /Invalid|Unsupported|Unknown/i);
    }
  } finally {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.equal(path.basename(directory).startsWith('agyctl-pricing-'), true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('shared pricing uses exact aliases before built-in families without guessing unknown prefixes', () => {
  const custom = [
    price,
    { ...price, model: 'gemini-4-argon', input: 11 },
    { ...price, model: 'MODEL_PLACEHOLDER_M417', input: 13 },
  ];
  assert.equal(getModelPricing({ responseModel: ' CUSTOM-agent ' }, null, custom).input, 2);
  assert.equal(getModelPricing({ model: 'MODEL_PLACEHOLDER_M417' }, null, custom).input, 13);
  assert.equal(getModelPricing({ model: 'MODEL_PLACEHOLDER_M418' }, null, custom).input, 11);
  assert.equal(getModelPricing({ responseModel: 'custom-agent-new' }, null, custom), null);
  const entry = {
    chatModel: {
      responseModel: 'custom-agent',
      usage: {
        inputTokens: '1000000',
        cacheReadTokens: '1000000',
        thinkingOutputTokens: '1000000',
        outputTokens: '2000000',
        responseOutputTokens: '1000000',
      },
    },
  };
  const aggregate = createSessionAgg();
  mergeGeneratorMetadata(aggregate, [entry], custom);
  assert.equal(metricsFromAgg(aggregate).sessionTotals.totalCostUsd, 17);
  const removed = createSessionAgg();
  mergeGeneratorMetadata(removed, [entry], []);
  assert.equal(metricsFromAgg(removed).sessionTotals.totalCostUsd, null);
  assert.equal(getModelPricing({ model: 'gemini-4-argon' }, '2026-11-01', []).input, 2);
  assert.equal(getModelPricing({ model: 'gemini-4-argon' }, '2026-12-01', []).input, 4);
});
