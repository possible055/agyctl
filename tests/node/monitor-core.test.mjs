import test from 'node:test';
import { endpointFingerprint, parseHostPort } from '../../src/plugin/lib/endpoint.mjs';
import {
  applyExecutorCapacity,
  applyFullResync,
  computeGenerationSpeed,
  createSessionAgg,
  formatTokens,
  generatorRefreshOffset,
  mergeGeneratorMetadata,
  metricsFromAgg,
  parseDuration,
  recentGenerationSpeed,
} from '../../src/plugin/lib/metrics-core.mjs';
import {
  isValidConversationId,
  nextPollDelayMs,
  refreshSchedule,
} from '../../src/plugin/lib/poll-policy.mjs';
import { formatUsd } from '../../src/plugin/lib/pricing-core.mjs';
import {
  LS_RPC_METHODS,
  languageServerRpcPath,
  normalizeExecutorMetadataResponse,
  normalizeGeneratorMetadataResponse,
  normalizeSidecarSnapshotResponse,
  normalizeTrajectoryStepsResponse,
  normalizeTrajectorySummariesResponse,
} from '../../src/plugin/lib/upstream-contract.mjs';
import { parseSeconds } from '../../src/plugin/sidecars/panel/telemetry.mjs';

test('helpers: formatTokens / parseSeconds / parseDuration', () => {
  if (formatTokens(1500) !== '1.5k') throw new Error(`formatTokens(1500) => ${formatTokens(1500)}`);
  if (formatTokens(2500000) !== '2.5M')
    throw new Error(`formatTokens(2500000) => ${formatTokens(2500000)}`);
  if (formatTokens(1234567) !== '1.23M')
    throw new Error(`formatTokens(1234567) => ${formatTokens(1234567)}`);
  if (formatTokens(null) !== '—') throw new Error(`formatTokens(null) => ${formatTokens(null)}`);
  if (parseSeconds('4.056s') !== 4.06)
    throw new Error(`parseSeconds("4.056s") => ${parseSeconds('4.056s')}`);
  if (parseDuration('4.940422s') !== 4.940422)
    throw new Error('parseDuration must keep full precision');
});

test('generation speed pairing keeps stream and overall rates separate', () => {
  const screenshot = computeGenerationSpeed({
    timeToFirstToken: '4.940422s',
    streamingDuration: '0.154252400s',
    usage: {
      outputTokens: '132',
      thinkingOutputTokens: '27',
      responseOutputTokens: '105',
    },
  });
  if (screenshot.streamingTps !== 680.7)
    throw new Error(`streamingTps ${screenshot.streamingTps} !== 680.7`);
  if (!screenshot.streamingLowConfidence || screenshot.overallLowConfidence) {
    throw new Error('only the 0.15 s streaming window is short enough to flag');
  }
  if (screenshot.generationSec !== 5.09)
    throw new Error(`generationSec ${screenshot.generationSec} !== 5.09`);
  if (screenshot.overallTps !== 25.9)
    throw new Error(`overallTps ${screenshot.overallTps} !== 25.9`);
  if (screenshot.ttftSec !== 4.94) throw new Error(`ttftSec ${screenshot.ttftSec} !== 4.94`);
  if (screenshot.streamingDurationSec !== 0.15)
    throw new Error(`streamingDurationSec ${screenshot.streamingDurationSec} !== 0.15`);

  const legacy = computeGenerationSpeed({
    timeToFirstToken: '4.940422s',
    streamingDuration: '0.154252400s',
    usage: { outputTokens: '132' },
  });
  if (legacy.streamingTps !== 855.7)
    throw new Error(`legacy fallback streamingTps ${legacy.streamingTps} !== 855.7`);

  const streamOnly = computeGenerationSpeed({
    streamingDuration: '2s',
    usage: { outputTokens: '40', responseOutputTokens: '40' },
  });
  if (
    streamOnly.streamingTps !== 20 ||
    streamOnly.overallTps !== null ||
    streamOnly.generationSec !== null
  ) {
    throw new Error('missing TTFT must leave overall throughput and generation time unavailable');
  }

  const thinkingOnly = computeGenerationSpeed({
    timeToFirstToken: '4.940422s',
    streamingDuration: '0.154252400s',
    usage: {
      outputTokens: '132',
      thinkingOutputTokens: '27',
      responseOutputTokens: '0',
    },
  });
  if (thinkingOnly.streamingTps !== null)
    throw new Error('thinking-only visible rate must be null');
  if (thinkingOnly.overallTps !== 25.9)
    throw new Error(`thinking-only overallTps ${thinkingOnly.overallTps} !== 25.9`);
  if ('effectiveTps' in thinkingOnly)
    throw new Error('no merged rate field may substitute overall for stream');
  if (thinkingOnly.generationSec !== 5.09)
    throw new Error(`thinking-only generationSec ${thinkingOnly.generationSec} !== 5.09`);

  const toolCall = computeGenerationSpeed({
    timeToFirstToken: '1.200000s',
    streamingDuration: '0.040000s',
    usage: {
      outputTokens: '62',
      thinkingOutputTokens: '0',
      responseOutputTokens: '0',
    },
  });
  if (toolCall.streamingTps !== null) throw new Error('tool call streamingTps must be null');
  if (toolCall.overallTps !== 50.0)
    throw new Error(`tool call overallTps ${toolCall.overallTps} !== 50.0`);
});

test('recent speed aggregate: confirmed-complete rows, trace-scoped identity, per model, tokens over seconds', () => {
  const gen = (
    model,
    { executionId, stopReason = 'STOP_REASON_END_TURN', error, response, stream, ttft = '1s' },
  ) => ({
    ...(executionId ? { executionId } : {}),
    ...(error ? { error } : {}),
    chatModel: {
      responseModel: model,
      ...(stopReason ? { stopReason } : {}),
      timeToFirstToken: ttft,
      streamingDuration: stream,
      usage: {
        inputTokens: '10',
        outputTokens: String(response),
        thinkingOutputTokens: '0',
        responseOutputTokens: String(response),
      },
    },
  });
  const traced = () => Object.assign(createSessionAgg(), { traceId: 'trace-1' });
  const agg = mergeGeneratorMetadata(traced(), [
    gen('model-b', { executionId: 'b1', response: 40, stream: '2s' }),
    gen('model-a', { executionId: 'a1', response: 100, stream: '1s' }),
    gen('model-a', { executionId: 'a2', response: 10, stream: '0.01s' }),
    gen('model-a', { executionId: 'a3', stopReason: null, response: 9000, stream: '1s' }),
    gen('model-a', {
      executionId: 'a4',
      stopReason: 'STOP_REASON_SOMETHING_NEW',
      response: 9000,
      stream: '1s',
    }),
    gen('model-a', { executionId: 'a5', response: 50, stream: '0s', ttft: '0.5s' }),
  ]);
  let modelA = recentGenerationSpeed(agg, 'model-a');
  // 110 tokens / 1.01 s, not the 550 tok/s mean of the 100 and 1000 tok/s samples
  if (modelA.stream.samples !== 2 || modelA.stream.tps !== 108.9) {
    throw new Error(`model-a stream ${JSON.stringify(modelA.stream)}`);
  }
  if (modelA.overall.samples !== 3 || modelA.overall.tps !== 45.6) {
    throw new Error(`model-a overall ${JSON.stringify(modelA.overall)}`);
  }
  if (recentGenerationSpeed(agg, 'model-b').stream.tps !== 20)
    throw new Error('models must not share samples');

  mergeGeneratorMetadata(agg, [gen('model-b', { executionId: 'a1', response: 100, stream: '2s' })]);
  modelA = recentGenerationSpeed(agg, 'model-a');
  const modelB = recentGenerationSpeed(agg, 'model-b');
  if (modelA.stream.samples !== 1 || modelB.stream.samples !== 2 || modelB.stream.tps !== 35) {
    throw new Error(
      `a re-read executionId must move, not duplicate: ${JSON.stringify([modelA.stream, modelB.stream])}`,
    );
  }
  const recent = metricsFromAgg(agg).speed.recent;
  if (recent.model !== 'model-b' || recent.stream.samples !== 2)
    throw new Error('metrics must use the latest model bucket');
  mergeGeneratorMetadata(agg, [
    gen('model-a', {
      executionId: 'a2',
      error: 'context canceled',
      response: 10,
      stream: '0.01s',
    }),
  ]);
  if (recentGenerationSpeed(agg, 'model-a').stream !== null)
    throw new Error('a row revised to an error must drop its sample');

  const live = traced();
  mergeGeneratorMetadata(live, [
    gen('model-p', { executionId: 'p0', response: 10, stream: '1s' }),
    gen('model-p', { executionId: 'p1', stopReason: null, response: 30, stream: '2s' }),
  ]);
  if (generatorRefreshOffset(live) !== 1)
    throw new Error('the next poll must re-read the pending row');
  let speed = metricsFromAgg(live).speed;
  if (speed.latestComplete || speed.streamingTps !== 15 || speed.recent.stream.samples !== 1) {
    throw new Error(
      `pending latest must be marked and kept out of the aggregate: ${JSON.stringify(speed)}`,
    );
  }
  const totals = [live.sumInput, live.sumResponse, live.requestCount];
  mergeGeneratorMetadata(
    live,
    [gen('model-p', { executionId: 'p1', response: 60, stream: '2s' })],
    [],
    1,
  );
  speed = metricsFromAgg(live).speed;
  if (
    !speed.latestComplete ||
    speed.streamingTps !== 30 ||
    speed.recent.stream.samples !== 2 ||
    speed.recent.stream.tps !== 23.3
  ) {
    throw new Error(
      `a pending row observed complete must replace its latest values: ${JSON.stringify(speed)}`,
    );
  }
  if (
    live.sumInput !== totals[0] ||
    live.sumResponse !== totals[1] + 30 ||
    live.requestCount !== totals[2] ||
    live.totalValidTurns !== 2 ||
    live.variants['model-p'] !== 2 ||
    live.seen !== 2
  ) {
    throw new Error('re-read rows must replace their contribution, not accumulate or stay stale');
  }
  if (generatorRefreshOffset(live) !== 0)
    throw new Error('the tail stays scheduled for re-read even without pending rows');

  const stuck = traced();
  mergeGeneratorMetadata(
    stuck,
    Array.from({ length: 20 }, () =>
      gen('model-s', { stopReason: null, response: 5, stream: '1s' }),
    ),
  );
  if (generatorRefreshOffset(stuck) !== 12)
    throw new Error('pending refresh must stay within the bounded tail');

  const positional = [gen('model-c', { response: 30, stream: '0.5s' })];
  const resynced = applyFullResync(mergeGeneratorMetadata(traced(), positional), positional);
  const modelC = recentGenerationSpeed(resynced, 'model-c');
  if (modelC.stream.samples !== 1)
    throw new Error('full resync must not double count positional samples');
  if (!modelC.stream.lowConfidence)
    throw new Error('a 0.5 s total window must be flagged low confidence');
  const untraced = mergeGeneratorMetadata(createSessionAgg(), positional);
  if (recentGenerationSpeed(untraced, 'model-c').stream !== null) {
    throw new Error('aggregates without a trace must not key samples by position');
  }
});

test('incremental aggregation equals full scan (mergeGeneratorMetadata)', () => {
  const fakeTurn = (i) => ({
    chatModel: {
      responseModel: i % 3 === 0 ? 'gemini-test-n' : 'claude-test-low',
      usage: {
        inputTokens: String(100 + i),
        cacheReadTokens: String(10 * i),
        outputTokens: '5',
      },
    },
  });
  const all = Array.from({ length: 7 }, (_, i) => fakeTurn(i));

  const full = mergeGeneratorMetadata(createSessionAgg(), all);
  const split = mergeGeneratorMetadata(
    mergeGeneratorMetadata(createSessionAgg(), all.slice(0, 3)),
    all.slice(3),
  );
  const emptyBatch = mergeGeneratorMetadata(split, []);
  if (emptyBatch !== split) throw new Error('empty batch must be a no-op on the same agg');

  if (full.sumInput !== split.sumInput)
    throw new Error(`sumInput drift: ${full.sumInput} vs ${split.sumInput}`);
  if (full.sumCache !== split.sumCache)
    throw new Error(`sumCache drift: ${full.sumCache} vs ${split.sumCache}`);
  if (full.sumThinking !== split.sumThinking) throw new Error('sumThinking drift');
  if (full.sumResponse !== split.sumResponse) throw new Error('sumResponse drift');
  if (full.requestCount !== split.requestCount || full.requestCount !== 7)
    throw new Error(`requestCount drift: ${full.requestCount}`);
  if (full.totalValidTurns !== split.totalValidTurns) throw new Error('totalValidTurns drift');
  if (full.seen !== split.seen) throw new Error(`seen drift: ${full.seen} vs ${split.seen}`);
  if (full.latestTurn !== split.latestTurn) throw new Error('latestTurn drift');
  if (
    JSON.stringify(Object.entries(full.variants).sort()) !==
    JSON.stringify(Object.entries(split.variants).sort())
  ) {
    throw new Error('variants drift');
  }
  if (full.latestTurn !== all[6])
    throw new Error('latestTurn must be the last turn carrying usage');

  // 失敗/中斷空殼紀錄 (無 token 用量、無 responseModel，僅有 modelDisplayName/model)
  // 不得污染 variants、不得累加 totalValidTurns、不得覆蓋 latestTurn，但 seen 仍須推進
  const erroredShell = {
    error: 'NOT_FOUND (code 404): Requested entity was not found.',
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M418',
      modelDisplayName: 'Gemini 4 Argon (Medium)',
      usage: { model: 'MODEL_PLACEHOLDER_M418' },
    },
  };
  // 中途取消紀錄 (已有 prompt 用量但無輸出、無 responseModel)
  const canceledMidFlight = {
    error: 'context canceled',
    chatModel: {
      model: 'MODEL_PLACEHOLDER_M418',
      modelDisplayName: 'Gemini 4 Argon (Medium)',
      usage: { model: 'MODEL_PLACEHOLDER_M418', inputTokens: '50', cacheReadTokens: '25' },
    },
  };
  const prevLatest = full.latestTurn;
  const prevValid = full.totalValidTurns;
  const prevSumInput = full.sumInput;
  const prevSumCache = full.sumCache;
  mergeGeneratorMetadata(full, [erroredShell, canceledMidFlight]);
  if (full.seen !== 9)
    throw new Error(`seen must advance across skipped/aborted entries, got ${full.seen}`);
  if (full.requestCount !== 8)
    throw new Error(`requestCount must include turn with prompt usage, got ${full.requestCount}`);
  if (full.totalValidTurns !== prevValid)
    throw new Error(
      'aborted/errored entries without responseModel must not increment totalValidTurns',
    );
  if ('Gemini 4 Argon (Medium)' in full.variants || 'MODEL_PLACEHOLDER_M418' in full.variants) {
    throw new Error('variants must not fall back to modelDisplayName or model enum');
  }
  if (full.latestTurn !== prevLatest)
    throw new Error('zero-output aborted turn must not clobber latestTurn');
  if (full.sumInput !== prevSumInput + 50 || full.sumCache !== prevSumCache + 25) {
    throw new Error('canceled turn with prompt usage must still account prompt/cache tokens');
  }
});

test('session totals: thinking/response split and model pricing cost', () => {
  const agg = createSessionAgg();
  mergeGeneratorMetadata(agg, [
    {
      chatModel: {
        model: 'MODEL_PLACEHOLDER_M418',
        responseModel: 'gemini-4-argon-trial',
        chatStartMetadata: { createdAt: '2026-11-05T00:00:00Z' },
        usage: {
          inputTokens: '1000000',
          cacheReadTokens: '1000000',
          outputTokens: '1000000',
          thinkingOutputTokens: '250000',
          responseOutputTokens: '750000',
        },
      },
    },
  ]);
  if (agg.requestCount !== 1) throw new Error(`expected 1 request, got ${agg.requestCount}`);
  if (agg.sumInput !== 1000000 || agg.sumCache !== 1000000) throw new Error('prompt sum mismatch');
  if (agg.sumThinking !== 250000 || agg.sumResponse !== 750000)
    throw new Error('thinking/response sum mismatch');
  if (Math.abs(agg.sumCostUsd - 12.1) > 1e-9)
    throw new Error(`expected $12.10 Argon intro cost, got ${agg.sumCostUsd}`);
  if (formatUsd(agg.sumCostUsd) !== '$12.10')
    throw new Error(`formatUsd(12.1) => ${formatUsd(agg.sumCostUsd)}`);
  if (formatUsd(0.0045) !== '$0.0045') throw new Error(`formatUsd(0.0045) => ${formatUsd(0.0045)}`);
  const metrics = metricsFromAgg(agg, { capacity: 5_000_000, conversationId: 'sess' });
  if (metrics.thinking !== 250000 || metrics.response !== 750000) {
    throw new Error('metricsFromAgg thinking/response split mismatch');
  }
  if (
    metrics.sessionTotals.requests !== 1 ||
    Math.abs(metrics.sessionTotals.totalCostUsd - 12.1) > 1e-9
  ) {
    throw new Error('metricsFromAgg sessionTotals mismatch');
  }
  if (
    metrics.modelVariants.length !== 1 ||
    metrics.modelVariants[0].name !== 'gemini-4-argon-trial'
  ) {
    throw new Error('metricsFromAgg modelVariants mismatch');
  }
  if (metrics.usedPercentage !== 60) {
    throw new Error(`metricsFromAgg usedPercentage ${metrics.usedPercentage} !== 60`);
  }
});

test('full resync reconciles growth without double counting and rebuilds on shrink', () => {
  const fakeTurn = (_i) => ({
    chatModel: {
      responseModel: 'model-a',
      usage: { inputTokens: '10', cacheReadTokens: '1', outputTokens: '2' },
    },
  });

  // 增長路徑：seen=3 的聚合對上 7 條全量清單 → 只併尾段，等同全掃
  const grown = createSessionAgg();
  mergeGeneratorMetadata(
    grown,
    Array.from({ length: 3 }, (_, i) => fakeTurn(i)),
  );
  const fullList = Array.from({ length: 7 }, (_, i) => fakeTurn(i));
  const reconciled = applyFullResync(grown, fullList);
  if (reconciled !== grown) throw new Error('grow path must reconcile in place');
  if (reconciled.seen !== 7) throw new Error(`grow path seen ${reconciled.seen} !== 7`);
  if (reconciled.totalValidTurns !== 7) throw new Error('grow path double-counted turns');
  if (reconciled.sumInput !== 70)
    throw new Error(`grow path sumInput ${reconciled.sumInput} !== 70`);

  // 縮減路徑：seen=10 的陳舊聚合對上 4 條清單 (LS 重建) → 重建聚合，保留 executor 快取
  const stale = createSessionAgg();
  mergeGeneratorMetadata(
    stale,
    Array.from({ length: 10 }, (_, i) => fakeTurn(i)),
  );
  stale.capacity = 500000;
  stale.bufferTokens = 4321;
  stale.lastExecFetch = 123456;
  const shrunk = applyFullResync(
    stale,
    Array.from({ length: 4 }, (_, i) => fakeTurn(i)),
  );
  if (shrunk === stale) throw new Error('shrink path must rebuild the aggregate');
  if (shrunk.seen !== 4) throw new Error(`shrink path seen ${shrunk.seen} !== 4`);
  if (shrunk.sumInput !== 40) throw new Error(`shrink path sumInput ${shrunk.sumInput} !== 40`);
  if (shrunk.capacity !== 500000 || shrunk.lastExecFetch !== 123456) {
    throw new Error('shrink path must preserve capacity/executor cache');
  }
});

test('revisited rows replace their contribution in totals, cost, variants, and requestCount', () => {
  const prices = [{ model: 'model-x', input: 2, output: 10, cacheRead: 0.1, thinking: 10 }];
  const row = (response) => ({
    executionId: 'exec-1',
    chatModel: {
      responseModel: 'model-x',
      stopReason: 'STOP_REASON_END_TURN',
      usage: {
        inputTokens: '100',
        cacheReadTokens: '20',
        outputTokens: String(response),
        thinkingOutputTokens: '0',
        responseOutputTokens: String(response),
      },
    },
  });
  const costUsd = (response) => (100 * 2 + 20 * 0.1 + response * 10) / 1e6;

  const agg = createSessionAgg();
  mergeGeneratorMetadata(agg, [row(10)], prices);
  if (agg.requestCount !== 1 || agg.sumResponse !== 10)
    throw new Error('first observation must count exactly once');
  if (Math.abs(agg.sumCostUsd - costUsd(10)) > 1e-12)
    throw new Error(`first cost ${agg.sumCostUsd} !== ${costUsd(10)}`);

  mergeGeneratorMetadata(agg, [row(100)], prices, 0);
  if (agg.requestCount !== 1 || agg.sumInput !== 100 || agg.sumCache !== 20) {
    throw new Error(
      `growth must not re-add the request: ${JSON.stringify([agg.requestCount, agg.sumInput, agg.sumCache])}`,
    );
  }
  if (agg.sumResponse !== 100)
    throw new Error(`grown output must update cumulative totals, got ${agg.sumResponse}`);
  if (Math.abs(agg.sumCostUsd - costUsd(100)) > 1e-9)
    throw new Error(`cost must recompute with current prices, got ${agg.sumCostUsd}`);
  if (agg.totalValidTurns !== 1 || JSON.stringify(agg.variants) !== '{"model-x":1}') {
    throw new Error(
      `variants must not double count on replacement: ${JSON.stringify(agg.variants)}`,
    );
  }
  const metrics = metricsFromAgg(agg);
  if (metrics.response !== 100 || metrics.sessionTotals.outputTokens !== 100) {
    throw new Error('latest metrics and session totals must both reflect the revision');
  }

  const ledgerFields = () =>
    JSON.stringify([
      agg.sumInput,
      agg.sumCache,
      agg.sumThinking,
      agg.sumResponse,
      agg.sumCostUsd,
      agg.requestCount,
      agg.totalValidTurns,
      agg.unpricedRequests,
      agg.variants,
    ]);
  const snapshot = ledgerFields();
  mergeGeneratorMetadata(agg, [row(100)], prices, 0);
  if (ledgerFields() !== snapshot)
    throw new Error('an identical re-observation must be a no-op on accounting');

  mergeGeneratorMetadata(
    agg,
    [
      {
        executionId: 'exec-1',
        chatModel: {
          responseModel: 'model-x',
          stopReason: 'STOP_REASON_END_TURN',
          usage: { outputTokens: '50', responseOutputTokens: '50' },
        },
      },
    ],
    prices,
    0,
  );
  if (agg.requestCount !== 0 || agg.sumInput !== 0 || agg.sumCache !== 0 || agg.sumResponse !== 0) {
    throw new Error(
      `losing prompt usage must retire the contribution: ${JSON.stringify([
        agg.requestCount,
        agg.sumInput,
        agg.sumCache,
        agg.sumResponse,
      ])}`,
    );
  }
  if (agg.sumCostUsd !== 0 || agg.totalValidTurns !== 0 || JSON.stringify(agg.variants) !== '{}') {
    throw new Error('retired contribution must release cost and variant counts');
  }
  mergeGeneratorMetadata(agg, [row(100)], prices, 0);
  if (agg.requestCount !== 1 || agg.sumResponse !== 100)
    throw new Error('regained usage must count again exactly once');
});

test('a pending row leaving the bounded tail marks the aggregate reconciliation-due', () => {
  const pending = {
    chatModel: { responseModel: 'm', usage: { inputTokens: '1', outputTokens: '5' } },
  };
  const done = {
    chatModel: {
      responseModel: 'm',
      stopReason: 'STOP_REASON_END_TURN',
      usage: { inputTokens: '1', outputTokens: '2' },
    },
  };
  const agg = createSessionAgg();
  mergeGeneratorMetadata(agg, [pending]);
  if (agg.reconciliationDue) throw new Error('a fresh pending row must not mark reconciliation');
  mergeGeneratorMetadata(
    agg,
    Array.from({ length: 9 }, () => done),
  );
  if (agg.seen !== 10) throw new Error(`seen ${agg.seen} !== 10`);
  if (agg.reconciliationDue !== true)
    throw new Error('the unresolved row left the tail without marking reconciliation');
  if (agg.unresolvedTailRows !== 1)
    throw new Error(`unresolvedTailRows ${agg.unresolvedTailRows} !== 1`);
  if (agg.pendingPositions.length !== 0)
    throw new Error('pending tracking must stay bounded to the tail window');
  const resynced = applyFullResync(
    agg,
    Array.from({ length: 10 }, () => done),
  );
  if (resynced.reconciliationDue !== false || resynced.unresolvedTailRows !== 0) {
    throw new Error('full resync must rebuild the reconciliation state');
  }
});

test('poll-policy: capsule cadence, panel branch mapping, and the shared refresh schedule', () => {
  const capsuleBase = { openMs: 3000, backgroundMs: 5000, hiddenMs: 15000 };
  const capsuleDelay = (popoverOpen, documentHidden) =>
    nextPollDelayMs({ popoverOpen, documentHidden, base: capsuleBase });
  if (capsuleDelay(true, false) !== 3000) throw new Error('popover-open cadence must stay 3s');
  if (capsuleDelay(false, false) !== 5000) throw new Error('background cadence must stay 5s');
  if (capsuleDelay(true, true) !== 15000 || capsuleDelay(false, true) !== 15000) {
    throw new Error('hidden cadence must stay 15s and win over an open popover');
  }
  // The panel maps its fast/configurable interval onto the same decision and
  // applies its hidden-window minimum to the branch value at the call site.
  const panelDelay = nextPollDelayMs({
    popoverOpen: false,
    documentHidden: false,
    base: { openMs: 2000, backgroundMs: 10000, hiddenMs: Math.max(30000, 10000) },
  });
  if (panelDelay !== 10000) throw new Error(`panel visible delay ${panelDelay} !== 10000`);

  const limits = { executorTtlMs: 120_000, fullResyncMs: 600_000 };
  const schedule = (agg, now) => refreshSchedule(agg, now, limits);
  if (!schedule({ lastExecAttempt: null, lastResyncAt: 0, seen: 0 }, 0).executorDue) {
    throw new Error('a never-executed aggregate must be immediately executor-due');
  }
  if (schedule({ lastExecAttempt: 0, lastResyncAt: 0, seen: 5 }, 119_999).executorDue) {
    throw new Error('executor must not be due one ms before its TTL');
  }
  if (!schedule({ lastExecAttempt: 0, lastResyncAt: 0, seen: 5 }, 120_000).executorDue) {
    throw new Error('executor must be due exactly at its TTL');
  }
  if (schedule({ lastExecAttempt: 0, lastResyncAt: 0, seen: 5 }, 599_999).fullResync) {
    throw new Error('resync must not fire one ms before its period');
  }
  if (schedule({ lastExecAttempt: 0, lastResyncAt: 0, seen: 5 }, 600_000).fullResync) {
    throw new Error('resync must not fire at exactly its period (strict > comparison)');
  }
  if (!schedule({ lastExecAttempt: 0, lastResyncAt: 0, seen: 5 }, 600_001).fullResync) {
    throw new Error('resync must fire once its period is exceeded');
  }
  if (schedule({ lastExecAttempt: 0, lastResyncAt: 0, seen: 0 }, 10_000_000).fullResync) {
    throw new Error('an aggregate without rows must never schedule a resync');
  }
});

test('poll-policy: isValidConversationId keeps the loose 36-char hex/dash grammar', () => {
  const accepted = [
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    '123456789012345678901234567890123456',
    'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA',
    '-'.repeat(36),
  ];
  for (const value of accepted) {
    if (!isValidConversationId(value)) throw new Error(`must accept ${JSON.stringify(value)}`);
  }
  const rejected = [
    null,
    undefined,
    42,
    '',
    'a'.repeat(35),
    'a'.repeat(37),
    'z'.repeat(36),
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaaa',
  ];
  for (const value of rejected) {
    if (isValidConversationId(value)) throw new Error(`must reject ${JSON.stringify(value)}`);
  }
});

test('endpoint grammar: parseHostPort accepts the documented LS address forms', () => {
  const v4 = parseHostPort('127.0.0.1:59999');
  if (v4.host !== '127.0.0.1' || v4.port !== 59999) {
    throw new Error(`env example 127.0.0.1:59999 => ${JSON.stringify(v4)}`);
  }
  if (parseHostPort('127.0.0.1:59901').port !== 59901) {
    throw new Error('env example 127.0.0.1:59901 must keep parsing');
  }
  if (parseHostPort('localhost:6000').host !== 'localhost') {
    throw new Error('hostname:port must parse');
  }
  const v6 = parseHostPort('[::1]:6000');
  if (v6.host !== '::1' || v6.port !== 6000) {
    throw new Error(`bracketed IPv6 must unbracket for node:http, got ${JSON.stringify(v6)}`);
  }
  if (parseHostPort(':6000').host !== '127.0.0.1') {
    throw new Error('an empty host must default to 127.0.0.1 as discovery always did');
  }
  if (parseHostPort(' 127.0.0.1:6000 ').port !== 6000) {
    throw new Error('surrounding whitespace must be trimmed');
  }
  const rejected = [
    ['::1:6000', /bracketed/],
    ['fe80::1:6000', /bracketed/],
    ['127.0.0.1', /host:port/],
    ['127.0.0.1:', /host:port/],
    ['', /non-empty/],
    ['   ', /non-empty/],
    ['http://127.0.0.1:6000', /scheme/],
    ['127.0.0.1:0', /1 and 65535/],
    ['127.0.0.1:70000', /1 and 65535/],
    ['127.0.0.1:6000abc', /host:port/],
    ['[::1]:0', /1 and 65535/],
  ];
  for (const [value, pattern] of rejected) {
    let message = null;
    try {
      parseHostPort(value);
    } catch (err) {
      message = err.message;
    }
    if (!message || !pattern.test(message)) {
      throw new Error(`"${value}" must be rejected with ${pattern}, got ${message}`);
    }
  }
});

test('endpoint identity: port and product changes distinguish servers', () => {
  const hub = { host: '127.0.0.1', port: 1111, product: 'hub' };
  const fingerprint = endpointFingerprint(hub);
  if (fingerprint !== '127.0.0.1:1111:hub') throw new Error(`fingerprint ${fingerprint}`);
  if (endpointFingerprint({ ...hub, port: 2222 }) === fingerprint)
    throw new Error('a new port (LS restart) must change the identity');
  if (endpointFingerprint({ ...hub, product: 'insiders' }) === fingerprint)
    throw new Error('a product switch must change the identity');
});

test('upstream contract: generator metadata normalization pins optional-field tolerance', () => {
  const row = {
    chatModel: {
      responseModel: 'model-opt',
      usage: { inputTokens: '10', cacheReadTokens: '5', outputTokens: '2' },
    },
  };
  const decorated = {
    generatorMetadata: [row],
    futureField: { anything: ['goes'] },
    anotherFutureField: 42,
  };
  const entries = normalizeGeneratorMetadataResponse(decorated);
  if (entries.length !== 1 || entries[0] !== row) {
    throw new Error('unknown optional fields must be ignored without touching rows');
  }

  const withOptional = mergeGeneratorMetadata(createSessionAgg(), entries);
  const baseline = mergeGeneratorMetadata(createSessionAgg(), [row]);
  if (
    withOptional.seen !== baseline.seen ||
    withOptional.sumInput !== baseline.sumInput ||
    withOptional.sumCache !== baseline.sumCache ||
    withOptional.requestCount !== baseline.requestCount
  ) {
    throw new Error('a decorated response must produce identical accounting');
  }
  if (metricsFromAgg(withOptional).sessionTotals.totalCostUsd !== null) {
    throw new Error('unknown model values must stay unknown (never zero-filled or priced)');
  }

  if (JSON.stringify(normalizeGeneratorMetadataResponse({})) !== '[]') {
    throw new Error('a missing generatorMetadata field is an empty delta');
  }
  if (
    JSON.stringify(normalizeGeneratorMetadataResponse({ generatorMetadata: undefined })) !== '[]'
  ) {
    throw new Error('an explicitly undefined generatorMetadata field is an empty delta');
  }
  for (const bad of [
    null,
    [],
    undefined,
    7,
    'rows',
    { generatorMetadata: 'nope' },
    { generatorMetadata: 7 },
  ]) {
    let message = null;
    try {
      normalizeGeneratorMetadataResponse(bad);
    } catch (err) {
      message = err.message;
    }
    if (!message || !/Invalid generator metadata response/.test(message)) {
      throw new Error(
        `invalid response ${JSON.stringify(bad)} must fail explicitly, got ${message}`,
      );
    }
  }
});

test('upstream contract: executor, trajectory, and sidecar shapes validate once at the boundary', () => {
  const empty = normalizeExecutorMetadataResponse({});
  if (JSON.stringify(empty) !== '{"executorMetadata":[]}') {
    throw new Error(
      `missing executorMetadata must normalize to an empty list, got ${JSON.stringify(empty)}`,
    );
  }

  const decorated = {
    executorMetadata: [
      { cascadeConfig: { checkpointConfig: { maxTokenLimit: 12345, tokenThreshold: 1000 } } },
    ],
    futureField: true,
  };
  const agg = createSessionAgg();
  const confirmed = applyExecutorCapacity(agg, normalizeExecutorMetadataResponse(decorated), 0);
  if (confirmed !== 12345 || agg.capacity !== 12345 || agg.bufferTokens !== 1000) {
    throw new Error('unknown optional fields must not block checkpoint capacity');
  }

  for (const bad of [null, [], 7, { executorMetadata: 'x' }, { executorMetadata: 9 }]) {
    let message = null;
    try {
      normalizeExecutorMetadataResponse(bad);
    } catch (err) {
      message = err.message;
    }
    if (!message || !/Invalid executor metadata response/.test(message)) {
      throw new Error(
        `invalid executor response ${JSON.stringify(bad)} must fail explicitly, got ${message}`,
      );
    }
  }

  const summaries = { a: { status: 'CASCADE_RUN_STATUS_IDLE' } };
  if (normalizeTrajectorySummariesResponse({ trajectorySummaries: summaries }) !== summaries) {
    throw new Error('summaries must pass through by reference');
  }
  if (Object.keys(normalizeTrajectorySummariesResponse({})).length !== 0) {
    throw new Error('an omitted map is a legal empty summaries response');
  }
  for (const bad of [
    null,
    [],
    { trajectorySummaries: [] },
    { trajectorySummaries: null },
    { trajectorySummaries: 5 },
  ]) {
    let message = null;
    try {
      normalizeTrajectorySummariesResponse(bad);
    } catch (err) {
      message = err.message;
    }
    if (!message || !/Invalid trajectory summaries response/.test(message)) {
      throw new Error(
        `invalid summaries response ${JSON.stringify(bad)} must fail explicitly, got ${message}`,
      );
    }
  }

  if (normalizeTrajectoryStepsResponse({}) !== null) {
    throw new Error('an omitted steps field means nothing new');
  }
  if (normalizeTrajectoryStepsResponse({ steps: [] })?.length !== 0) {
    throw new Error('an empty steps array stays empty');
  }
  for (const bad of [null, 'x', { steps: 'nope' }, { steps: {} }]) {
    let message = null;
    try {
      normalizeTrajectoryStepsResponse(bad);
    } catch (err) {
      message = err.message;
    }
    if (!message || !/Invalid trajectory steps response/.test(message)) {
      throw new Error(
        `invalid steps response ${JSON.stringify(bad)} must fail explicitly, got ${message}`,
      );
    }
  }

  const entry = { sidecarId: 'agyctl/panel', baseUrl: 'http://127.0.0.1:46123/?token=x' };
  if (
    normalizeSidecarSnapshotResponse({ sidecars: [{ sidecarId: 'other' }, entry], future: 1 }) !==
    entry
  ) {
    throw new Error('the panel sidecar entry must be located inside decorated snapshots');
  }
  if (normalizeSidecarSnapshotResponse({}) !== null) {
    throw new Error('a snapshot without sidecars yields no entry (availability, not corruption)');
  }
  for (const bad of [null, [], 7, { sidecars: 'x' }, { sidecars: 5 }]) {
    let message = null;
    try {
      normalizeSidecarSnapshotResponse(bad);
    } catch (err) {
      message = err.message;
    }
    if (!message || !/Invalid sidecar snapshot response/.test(message)) {
      throw new Error(
        `invalid snapshot ${JSON.stringify(bad)} must fail explicitly, got ${message}`,
      );
    }
  }

  if (
    languageServerRpcPath('SubscribeToSidecars') !==
    '/exa.language_server_pb.LanguageServerService/SubscribeToSidecars'
  ) {
    throw new Error('RPC path builder must reproduce the Connect-RPC route');
  }
  if (
    LS_RPC_METHODS.subscribeSidecars !== 'SubscribeToSidecars' ||
    LS_RPC_METHODS.generatorMetadata !== 'GetCascadeTrajectoryGeneratorMetadata'
  ) {
    throw new Error('method constants drifted from the wire names');
  }
});
