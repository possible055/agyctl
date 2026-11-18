import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { endpointFingerprint } from '../../src/plugin/lib/endpoint.mjs';
import { createSessionAgg, mergeGeneratorMetadata } from '../../src/plugin/lib/metrics-core.mjs';
import {
  LS_RPC_METHODS,
  normalizeGeneratorMetadataResponse,
  normalizeTrajectoryStepsResponse,
  normalizeTrajectorySummariesResponse,
} from '../../src/plugin/lib/upstream-contract.mjs';

const usageSource = fs
  .readFileSync(new URL('../../src/plugin/sidecars/panel/usage.mjs', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?from '[^']+';\r?\n/gm, '')
  .replace(/^export (async )?function /gm, '$1function ');

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const D = 'dddddddd-0000-4000-8000-000000000004';
const NOW = new Date(2026, 10, 6, 15, 0).getTime();
const at = (day, hour = 12) => new Date(2026, 10, day, hour);
const step = (date) => ({ metadata: { createdAt: date.toISOString() } });
const turn = (input, stepIndex, model = 'gemini-4-argon') => ({
  stepIndices: [stepIndex],
  chatModel: {
    responseModel: model,
    usage: {
      inputTokens: String(input),
      cacheReadTokens: '20',
      outputTokens: '10',
      thinkingOutputTokens: '4',
    },
  },
});

const plain = (value) => JSON.parse(JSON.stringify(value));

async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('Background work did not reach the expected state');
}

function usageHarness() {
  const files = new Map();
  const conversations = new Map();
  const failures = new Map();
  const hanging = new Set();
  const calls = [];
  let summaries = {};
  let pricing = { prices: [], revision: 'builtin' };
  let malformedSteps = false;
  let deadline = null;
  let now = NOW;
  const endpoint = {
    host: '127.0.0.1',
    port: 1234,
    product: 'insiders',
    conversationDir: '/data/conversations',
  };
  const context = vm.createContext({
    createSessionAgg,
    mergeGeneratorMetadata,
    endpointFingerprint,
    LS_RPC_METHODS,
    normalizeGeneratorMetadataResponse,
    normalizeTrajectorySummariesResponse,
    normalizeTrajectoryStepsResponse,
    AbortController,
    Buffer,
    URL,
    fs: {
      readdirSync(directory) {
        assert.equal(directory, '/data/conversations');
        return [...files.keys()].map((id) => `${id}.db`).concat('notes.txt');
      },
      statSync(file) {
        const id = path.posix.basename(file).replace(/\.db(-wal)?$/, '');
        if (file.endsWith('-wal') || !files.has(id))
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return { size: 4096, mtimeMs: files.get(id) };
      },
    },
    path: path.posix,
    readPricingStatus: () => ({
      prices: pricing.prices,
      revision: pricing.revision,
      defaults: [],
      status: pricing.status ?? 'ok',
      pricingDamaged: pricing.pricingDamaged ?? false,
      damage: pricing.damage ?? null,
      recoveryToken: null,
    }),
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout(fn) {
      deadline = fn;
      return fn;
    },
    clearTimeout() {},
    discoverLanguageServer: async () => ({ ...endpoint }),
    async callLanguageServer(_endpoint, method, payload, options) {
      calls.push({ method, ...payload });
      if (method === 'GetAllCascadeTrajectories')
        return summaries === null ? {} : { trajectorySummaries: summaries };
      const id = payload.cascadeId;
      if (hanging.has(id)) {
        return new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason)),
        );
      }
      const failure = failures.get(`${id}:${method}`) ?? failures.get(id);
      if (failure) throw failure;
      const conversation = conversations.get(id) || { entries: [], steps: [] };
      if (method === 'GetCascadeTrajectorySteps') {
        assert.deepEqual(Object.keys(payload).sort(), ['cascadeId', 'stepOffset']);
        return malformedSteps
          ? { steps: 'not-an-array' }
          : { steps: conversation.steps.slice(payload.stepOffset) };
      }
      assert.equal(method, 'GetCascadeTrajectoryGeneratorMetadata');
      assert.equal(payload.includeMessages, false);
      return { generatorMetadata: conversation.entries };
    },
  });
  const get = vm.runInContext(`${usageSource}\ngetUsageOverview;`, context);
  return {
    get,
    calls,
    files,
    conversations,
    failures,
    hanging,
    endpoint,
    advance(ms) {
      now += ms;
    },
    setSummaries(value) {
      summaries = value;
    },
    setPricing(prices, revision) {
      pricing = { prices, revision };
    },
    setPricingStatus(fields) {
      pricing = { ...pricing, ...fields };
    },
    setMalformedSteps(value) {
      malformedSteps = value;
    },
    expire() {
      deadline();
    },
    async settle() {
      await until(async () => !(await get()).refreshing);
      return get();
    },
  };
}

function seed(harness) {
  harness.files.set(A, 1);
  harness.files.set(B, 1);
  harness.files.set(C, 1);
  harness.conversations.set(A, {
    steps: [step(new Date(2026, 9, 29, 12)), step(at(6, 14))],
    entries: [turn(100, 0), turn(200, 1)],
  });
  harness.conversations.set(B, {
    steps: [step(at(5))],
    entries: [turn(300, 0, 'claude-sonnet-5-5-high')],
  });
  harness.conversations.set(C, { steps: [step(at(6, 10))], entries: [turn(400, 0)] });
  harness.setSummaries({
    [A]: {
      summary: 'Alpha',
      workspaces: [{ workspaceFolderAbsoluteUri: 'file:///d%3A/Projects/demo' }],
    },
    [B]: { summary: 'Child', trajectoryMetadata: { parentConversationId: A } },
    [D]: { summary: 'Empty' },
  });
}

test('turns take their first step time, which also selects date-dependent prices', () => {
  const context = vm.createContext({
    createSessionAgg,
    mergeGeneratorMetadata,
    URL,
    path: path.posix,
    fs: {},
  });
  const bucket = vm.runInContext(`${usageSource}\nbucketGeneratorMetadata;`, context);
  const early = new Date('2026-01-02T12:00:00Z');
  const afterRateChange = new Date('2027-02-01T12:00:00Z');
  const { buckets, lastTurnAt } = bucket(
    [turn(200, 0, 'claude-sonnet-5-5-high'), turn(1_000_000, 1), { chatModel: null }, turn(300, 9)],
    [],
    [early.getTime(), afterRateChange.getTime()],
  );
  assert.equal(lastTurnAt, afterRateChange.getTime());
  assert.equal(buckets.length, 3);
  const dated = buckets.find((item) => item.uncachedTokens === 1_000_000);
  const costAt = (date) =>
    mergeGeneratorMetadata(createSessionAgg(), [
      {
        ...turn(1_000_000, 1),
        chatModel: {
          ...turn(1_000_000, 1).chatModel,
          chatStartMetadata: { createdAt: date.toISOString() },
        },
      },
    ]).sumCostUsd;
  assert.notEqual(costAt(early), costAt(afterRateChange));
  assert.equal(dated.costUsd, costAt(afterRateChange));
  assert.equal(buckets.find((item) => item.model === 'claude-sonnet-5-5-high').thinkingTokens, 4);
  assert.equal(buckets.find((item) => item.uncachedTokens === 300).day, null);
});

test('overview reads every conversation on disk, rolls subagents into parents, and splits ranges by day', async () => {
  const harness = usageHarness();
  seed(harness);
  const initial = await harness.get();
  assert.equal(initial.status, 'loading');
  assert.equal(initial.refreshing, true);
  const result = await harness.settle();
  assert.equal(result.status, 'ready');
  assert.equal(result.product, 'insiders');
  assert.deepEqual(plain(result.coverage), {
    discovered: 4,
    read: 4,
    failed: 0,
    unscanned: 0,
    datesPending: 0,
  });
  assert.equal(result.ranges.today.requests, 2);
  assert.equal(result.ranges.week.requests, 3);
  assert.equal(result.ranges.all.requests, 4);
  assert.equal(result.ranges.all.totalTokens, 100 + 200 + 300 + 400 + 4 * 30);
  assert.equal(result.ranges.today.conversations, 2);
  assert.deepEqual(plain(result.ranges.all.models.map((model) => model.model)), [
    'gemini-4-argon',
    'claude-sonnet-5-5-high',
  ]);
  assert.deepEqual(plain(result.conversations.map((item) => item.id)), [A, C]);
  assert.equal(result.conversations[0].title, 'Alpha');
  assert.equal(result.conversations[0].workspace, 'demo');
  assert.equal(result.conversations[0].subagents, 1);
  assert.equal(result.conversations[0].ranges.today.requests, 1);
  assert.equal(result.conversations[0].ranges.all.requests, 3);
  assert.equal(result.daily.length, 14);
  assert.equal(result.daily.at(-1).requests, 2);
  assert.equal('subscription' in result, false);
});

test('a freshly started server with no loaded conversations still reads every conversation on disk', async () => {
  const harness = usageHarness();
  seed(harness);
  harness.setSummaries(null);
  await harness.get();
  const result = await harness.settle();
  assert.equal(result.status, 'ready');
  assert.equal(result.error, null);
  assert.deepEqual(plain(result.coverage), {
    discovered: 3,
    read: 3,
    failed: 0,
    unscanned: 0,
    datesPending: 0,
  });
  assert.equal(result.ranges.all.requests, 4);
  assert.equal(result.conversations.length, 3);
});

test('conversation totals include sessions beyond the displayed list limit', async () => {
  const harness = usageHarness();
  for (let index = 0; index < 501; index++) {
    const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
    harness.files.set(id, 1);
    harness.conversations.set(id, { entries: [turn(1, 0)], steps: [step(at(6))] });
  }
  await harness.get();
  const result = await harness.settle();
  assert.equal(result.coverage.read, 501);
  assert.equal(result.conversations.length, 500);
  for (const range of Object.values(result.ranges)) {
    assert.equal(range.requests, 501);
    assert.equal(range.conversations, 501);
  }
});

test('refreshes reread only changed conversations and fetch only new steps', async () => {
  const harness = usageHarness();
  seed(harness);
  await harness.get();
  await harness.settle();
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  await harness.settle();
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ['GetAllCascadeTrajectories'],
  );

  harness.files.set(A, 2);
  harness.conversations.get(A).steps.push(step(at(6, 15)));
  harness.conversations.get(A).entries.push(turn(500, 2));
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  const result = await harness.settle();
  const reads = harness.calls.filter((call) => call.method !== 'GetAllCascadeTrajectories');
  assert.deepEqual(
    reads.map((call) => [call.method, call.cascadeId, call.stepOffset]),
    [
      ['GetCascadeTrajectoryGeneratorMetadata', A, undefined],
      ['GetCascadeTrajectorySteps', A, 2],
    ],
  );
  assert.equal(result.ranges.today.requests, 3);
});

test('a new endpoint invalidates usage and failed-conversation backoff within the same product', async () => {
  const harness = usageHarness();
  seed(harness);
  harness.failures.set(B, new Error('old server failure'));
  await harness.get();
  const before = await harness.settle();
  assert.equal(before.coverage.failed, 1);
  harness.failures.clear();
  harness.conversations.get(A).entries[0] = turn(900, 0);
  harness.endpoint.port = 1235;
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  const after = await harness.settle();
  assert.equal(after.coverage.failed, 0);
  assert.equal(after.coverage.unscanned, 0);
  assert.equal(after.ranges.all.uncachedTokens, 1800);
  assert.deepEqual(
    harness.calls
      .filter((call) => call.method === 'GetCascadeTrajectoryGeneratorMetadata')
      .map((call) => call.cascadeId)
      .sort(),
    [A, B, C, D],
  );
});

test('a failed step read keeps all-time totals, marks date coverage partial, and retries without refetching metadata', async () => {
  const harness = usageHarness();
  seed(harness);
  harness.failures.set(`${A}:GetCascadeTrajectorySteps`, new Error('step history failed'));
  await harness.get();
  const provisional = await harness.settle();
  assert.equal(provisional.status, 'ready');
  assert.equal(provisional.ranges.all.requests, 4);
  assert.equal(provisional.ranges.today.requests, 1);
  assert.equal(provisional.coverage.datesPending, 1);

  harness.failures.delete(`${A}:GetCascadeTrajectorySteps`);
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  const repaired = await harness.settle();
  assert.deepEqual(
    harness.calls
      .filter((call) => call.method !== 'GetAllCascadeTrajectories')
      .map((call) => [call.method, call.cascadeId]),
    [['GetCascadeTrajectorySteps', A]],
  );
  assert.equal(repaired.ranges.today.requests, 2);
  assert.equal(repaired.ranges.all.requests, 4);
  assert.equal(repaired.coverage.datesPending, 0);
});

test('damaged persisted prices keep token metrics working and report costs unavailable, not zero', async () => {
  const harness = usageHarness();
  seed(harness);
  harness.setPricingStatus({
    prices: [],
    revision: null,
    status: 'unavailable',
    pricingDamaged: true,
    damage: 'Invalid saved pricing',
  });
  await harness.get();
  const result = await harness.settle();
  assert.equal(result.pricingStatus, 'unavailable');
  assert.equal(result.pricingDamaged, true);
  assert.equal(result.pricingDamage, 'Invalid saved pricing');
  assert.equal(result.ranges.all.requests, 4, 'token metrics keep flowing');
  assert.equal(result.ranges.all.costUsd, null, 'unavailable pricing must null costs');
  assert.equal(
    result.daily.every((day) => day.costUsd === null),
    true,
  );
  assert.equal(
    result.conversations.every((conversation) => conversation.ranges.all.costUsd === null),
    true,
  );

  harness.setPricingStatus({
    prices: [],
    revision: 'repaired',
    status: 'ok',
    pricingDamaged: false,
    damage: null,
  });
  await harness.get({ refresh: true });
  const repaired = await harness.settle();
  assert.equal(repaired.pricingStatus, 'ok');
  assert.equal(repaired.pricingDamaged, false);
  assert.notEqual(repaired.ranges.all.costUsd, null, 'repaired pricing restores cost figures');
});

test('a malformed steps array fails the date read instead of marking it successful', async () => {
  const harness = usageHarness();
  seed(harness);
  harness.setMalformedSteps(true);
  await harness.get();
  const provisional = await harness.settle();
  assert.equal(provisional.ranges.all.requests, 4, 'all-time totals survive the bad read');
  assert.equal(provisional.coverage.datesPending, 4, 'no conversation may commit step success');

  harness.setMalformedSteps(false);
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  const repaired = await harness.settle();
  assert.equal(repaired.coverage.datesPending, 0, 'the retried step reads repair the dates');
  const stepCalls = harness.calls.filter((call) => call.method === 'GetCascadeTrajectorySteps');
  assert.equal(stepCalls.length > 0, true, 'the repair must actually reread steps');
});

test('provisional metadata shares a UTF-8 byte budget and eviction preserves totals', async () => {
  const harness = usageHarness();
  // Each response stays below the 8 MiB transport limit; together they exceed
  // the 32 MiB provisional pool, despite having fewer UTF-16 code units.
  for (let index = 0; index < 12; index++) {
    const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`;
    harness.files.set(id, 1);
    harness.conversations.set(id, {
      entries: [turn(10, 0), { filler: '漢'.repeat(1024 * 1024) }],
      steps: [step(at(6))],
    });
    harness.failures.set(`${id}:GetCascadeTrajectorySteps`, new Error('step history failed'));
  }
  await harness.get({ refresh: true });
  const first = await harness.settle();
  assert.equal(first.coverage.datesPending, 12);
  assert.equal(first.ranges.all.requests, 12);

  harness.calls.length = 0;
  harness.failures.clear();
  harness.advance(60_000);
  await harness.get({ refresh: true });
  const second = await harness.settle();
  const metadataCalls = harness.calls
    .filter((call) => call.method === 'GetCascadeTrajectoryGeneratorMetadata')
    .map((call) => call.cascadeId);
  assert.equal(new Set(metadataCalls).size, 2, 'only evicted metadata needs refetching');
  assert.equal(second.coverage.datesPending, 0);
  assert.equal(second.ranges.all.requests, 12);
});

test('unreadable conversations report coverage, keep earlier data, and never expose RPC bodies', async () => {
  const harness = usageHarness();
  seed(harness);
  harness.failures.set(C, new Error('RPC HTTP 401: secret credential'));
  await harness.get();
  const partial = await harness.settle();
  assert.equal(partial.status, 'partial');
  assert.equal(partial.error, '1 of 4 conversations could not be read');
  assert.equal(partial.coverage.failed, 1);
  assert.equal(partial.ranges.all.requests, 3);
  assert.equal(JSON.stringify(partial).includes('secret'), false);

  // The failed conversation backs off before its retry, so advance past the
  // first-failure delay before the repairing scan.
  harness.advance(61_000);
  harness.failures.delete(C);
  harness.failures.set(A, new Error('unavailable'));
  harness.files.set(A, 2);
  await harness.get({ refresh: true });
  const retained = await harness.settle();
  assert.equal(retained.status, 'partial');
  assert.equal(retained.ranges.all.requests, 4);
});

test('price changes hide stale costs until every conversation is repriced', async () => {
  const harness = usageHarness();
  seed(harness);
  await harness.get();
  const builtin = await harness.settle();
  assert.equal(typeof builtin.ranges.all.costUsd, 'number');
  harness.setPricing(
    [{ model: 'gemini-4-argon', input: 1_000_000, cacheRead: 0, output: 0, thinking: 0 }],
    'custom',
  );
  const repricing = await harness.get();
  assert.equal(repricing.repricing, true);
  assert.equal(repricing.ranges.all.costUsd, null);
  const repriced = await harness.settle();
  assert.equal(repriced.repricing, false);
  assert.equal(repriced.conversations.find((item) => item.id === C).ranges.all.costUsd, 400);
});

test('the refresh deadline stops the scan and reports what was left unread', async () => {
  const harness = usageHarness();
  seed(harness);
  for (const id of [A, B, C, D]) harness.hanging.add(id);
  await harness.get();
  await until(
    () =>
      harness.calls.filter((call) => call.method === 'GetCascadeTrajectoryGeneratorMetadata')
        .length === 3,
  );
  harness.expire();
  const result = await harness.settle();
  assert.equal(result.status, 'error');
  assert.deepEqual(plain(result.coverage), {
    discovered: 4,
    read: 0,
    failed: 3,
    unscanned: 1,
    datesPending: 0,
  });
  assert.equal(result.error, '4 of 4 conversations could not be read');
});

test('deadline-starved conversations yield the next scan to unvisited ones and retry after backoff', async () => {
  const harness = usageHarness();
  seed(harness);
  for (const id of [A, B, C]) harness.hanging.add(id);
  await harness.get();
  await until(
    () =>
      harness.calls.filter((call) => call.method === 'GetCascadeTrajectoryGeneratorMetadata')
        .length === 3,
  );
  harness.expire();
  const deadlineScan = await harness.settle();
  assert.equal(deadlineScan.status, 'error');
  assert.deepEqual(plain(deadlineScan.coverage), {
    discovered: 4,
    read: 0,
    failed: 3,
    unscanned: 1,
    datesPending: 0,
  });

  // The next scan must hand the budget to the conversation that never got a
  // turn instead of re-hanging the same three requests.
  harness.hanging.clear();
  await harness.get({ refresh: true });
  const yielded = await harness.settle();
  assert.deepEqual(plain(yielded.coverage), {
    discovered: 4,
    read: 1,
    failed: 0,
    unscanned: 3,
    datesPending: 0,
  });
  assert.equal(yielded.status, 'partial');
  assert.equal(yielded.error, '3 of 4 conversations could not be read');

  // Once the first-failure backoff has elapsed the deferred conversations are
  // retried and complete.
  harness.advance(61_000);
  await harness.get({ refresh: true });
  const recovered = await harness.settle();
  assert.equal(recovered.status, 'ready');
  assert.deepEqual(plain(recovered.coverage), {
    discovered: 4,
    read: 4,
    failed: 0,
    unscanned: 0,
    datesPending: 0,
  });
});

test('a conversation whose reads always fail defers to unscanned work and escalates its backoff', async () => {
  const harness = usageHarness();
  seed(harness);
  harness.failures.set(A, new Error('RPC HTTP 500'));
  await harness.get();
  const first = await harness.settle();
  assert.equal(first.coverage.failed, 1);

  // The immediately following scan must not re-attempt the failure, and the
  // healthy conversations keep their committed fingerprints without refetches.
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  const deferred = await harness.settle();
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ['GetAllCascadeTrajectories'],
  );
  assert.deepEqual(plain(deferred.coverage), {
    discovered: 4,
    read: 3,
    failed: 0,
    unscanned: 1,
    datesPending: 0,
  });
  assert.equal(deferred.status, 'partial');

  // 61s after one failure exceeds the 60s first backoff: one retry, which
  // fails again and doubles the delay.
  harness.advance(61_000);
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  const retried = await harness.settle();
  assert.deepEqual(
    harness.calls.filter((call) => call.cascadeId === A).map((call) => call.method),
    ['GetCascadeTrajectoryGeneratorMetadata'],
  );
  assert.equal(retried.coverage.failed, 1);

  // 61s after the second failure is still inside the doubled 120s backoff.
  harness.advance(61_000);
  harness.calls.length = 0;
  await harness.get({ refresh: true });
  const stillDeferred = await harness.settle();
  assert.deepEqual(
    harness.calls.map((call) => call.method),
    ['GetAllCascadeTrajectories'],
  );
  assert.equal(stillDeferred.coverage.unscanned, 1);

  // 122s after the second failure exceeds the doubled backoff: retried again.
  harness.advance(61_000);
  await harness.get({ refresh: true });
  const retriedAgain = await harness.settle();
  assert.equal(retriedAgain.coverage.failed, 1);
});
