/**
 * Shared telemetry metrics core: pure token/duration/speed functions and
 * session aggregates used by BOTH the Node sidecar
 * (plugin/sidecars/panel/telemetry.mjs) and the injected capsule.
 * Cost computation lives in pricing-core.mjs; metrics-core only consumes it.
 */

import { computeTurnCostUsd, getModelPricing } from './pricing-core.mjs';

const BUFFER_DEFAULT_TOKENS = 50000;

// Presentation-only heuristic, not statistically validated: under one second a
// single buffered delivery can dominate the LS window, so rates with a shorter
// denominator are still shown but flagged as low confidence.
const SHORT_WINDOW_SEC = 1;
// Completed generations kept per model and metric for the recent Σtokens / Σseconds.
const RECENT_SPEED_SAMPLES = 20;
// Rows not yet confirmed complete are re-read on the next poll from the earliest
// one, but only within the last rows of the list, so a build that never reports
// a recognized stopReason costs a bounded tail instead of full-history polling.
const PENDING_TAIL_ROWS = 8;
// Terminal values seen in a third-party reference parser
// (vendor-src/Antigravity-Context-Window-Monitor), not a published LS schema.
// Any other or missing value, including possible tool-call stops, is unconfirmed.
const TERMINAL_STOP_REASONS = new Set(['STOP_REASON_END_TURN', 'STOP_REASON_STOP_PATTERN']);

/**
 * Canonical token formatting shared by panel and capsule.
 * Returns '—' for missing values, '0' for zero, trimmed 1.5k / 2.5M forms.
 */
function formatTokens(num) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return '—';
  const n = Number(num);
  if (n === 0) return '0';
  if (n >= 1_000_000) {
    const m = (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '');
    return `${m}M`;
  }
  if (n >= 1_000) {
    const k = (n / 1_000).toFixed(1).replace(/\.?0+$/, '');
    return `${k}k`;
  }
  return String(n);
}

function parseTokenCount(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = parseInt(String(value), 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse a protobuf Duration string (e.g. "4.940422s") without rounding.
 */
function parseDuration(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  const m = String(value)
    .trim()
    .match(/^([0-9.]+)\s*s?$/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return Number.isFinite(val) && val >= 0 ? val : null;
}

/**
 * Token/duration pairs behind the two LS-derived rates of one generation:
 * stream = visible response tokens / streamingDuration, and
 * overall = all output tokens (thinking included) / (timeToFirstToken + streamingDuration).
 * Neither substitutes for the other; a pair whose inputs are missing stays null.
 */
function generationSpeedParts(chatModel) {
  const usage = chatModel?.usage || {};
  const outputTokens = parseTokenCount(usage.outputTokens) ?? 0;
  const thinkingTokens = parseTokenCount(usage.thinkingOutputTokens) ?? 0;
  const responseTokens = parseTokenCount(usage.responseOutputTokens);
  const ttft = parseDuration(chatModel?.timeToFirstToken);
  const stream = parseDuration(chatModel?.streamingDuration);
  const generation = ttft !== null && stream !== null ? ttft + stream : null;

  let visibleTokens = null;
  if (responseTokens !== null && responseTokens > 0) {
    visibleTokens = responseTokens;
  } else if (responseTokens === null && thinkingTokens === 0 && outputTokens > 0) {
    visibleTokens = outputTokens;
  }

  return {
    outputTokens,
    thinkingTokens,
    responseTokens,
    ttft,
    stream,
    generation,
    streamPair:
      stream !== null && stream > 0 && visibleTokens !== null
        ? { tokens: visibleTokens, seconds: stream }
        : null,
    overallPair:
      generation !== null && generation > 0 && outputTokens > 0
        ? { tokens: outputTokens, seconds: generation }
        : null,
  };
}

function pairRate(pair) {
  return Number((pair.tokens / pair.seconds).toFixed(1));
}

function emptyGenerationSpeed() {
  return {
    streamingTps: null,
    streamingLowConfidence: false,
    overallTps: null,
    overallLowConfidence: false,
    ttftSec: null,
    streamingDurationSec: null,
    generationSec: null,
    latestComplete: false,
    recent: null,
  };
}

/**
 * Latest-generation rates from LS timings. These are estimates of delivery as
 * the LS reports it, not engine-side decoding speed, and the overall rate is
 * one request, not a whole agent task with tool waits.
 */
function computeGenerationSpeed(chatModel) {
  const parts = generationSpeedParts(chatModel);
  const round2 = (value) => (value === null ? null : Number(value.toFixed(2)));
  return {
    ...emptyGenerationSpeed(),
    streamingTps: parts.streamPair ? pairRate(parts.streamPair) : null,
    streamingLowConfidence:
      Boolean(parts.streamPair) && parts.streamPair.seconds < SHORT_WINDOW_SEC,
    overallTps: parts.overallPair ? pairRate(parts.overallPair) : null,
    overallLowConfidence:
      Boolean(parts.overallPair) && parts.overallPair.seconds < SHORT_WINDOW_SEC,
    ttftSec: round2(parts.ttft),
    streamingDurationSec: round2(parts.stream),
    generationSec: round2(parts.generation),
    latestOutputTokens: parts.outputTokens,
    thinkingTokens: parts.thinkingTokens,
    responseTokens: parts.responseTokens ?? 0,
  };
}

/**
 * Complete means an error-free row whose stopReason is a recognized terminal
 * value. Nothing is guessed from polling silence or a nonzero duration, so a
 * build that omits stopReason leaves the recent aggregate unavailable.
 */
function isCompletedGeneration(turn) {
  if (!turn || turn.error) return false;
  const reason = turn.chatModel?.stopReason;
  return typeof reason === 'string' && TERMINAL_STOP_REASONS.has(reason.trim());
}

function speedSampleModel(chatModel) {
  for (const raw of [chatModel?.responseModel, chatModel?.model]) {
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
  }
  return null;
}

/**
 * A sample is keyed by trace and metadata position, and also matched by
 * executionId, so re-reading a row replaces or removes its earlier sample in
 * whichever model it was filed under. Aggregates without a trace (cross-trace
 * usage buckets) record no samples because positions would collide.
 */
function recordSpeedSample(agg, turn, position) {
  if (!agg.traceId) return;
  const key = `${agg.traceId}#${position}`;
  const executionId = typeof turn?.executionId === 'string' ? turn.executionId.trim() : '';
  agg.speedSamples = agg.speedSamples.filter(
    (sample) => sample.key !== key && !(executionId && sample.executionId === executionId),
  );
  if (!isCompletedGeneration(turn)) return;
  const model = speedSampleModel(turn.chatModel);
  if (!model) return;
  const parts = generationSpeedParts(turn.chatModel);
  if (!parts.streamPair && !parts.overallPair) return;
  agg.speedSamples.push({
    key,
    executionId,
    model,
    stream: parts.streamPair,
    overall: parts.overallPair,
  });
  const sameModel = agg.speedSamples.filter((sample) => sample.model === model);
  if (sameModel.length > RECENT_SPEED_SAMPLES) {
    agg.speedSamples.splice(agg.speedSamples.indexOf(sameModel[0]), 1);
  }
}

function trackPendingGeneration(agg, turn, position) {
  agg.pendingPositions = agg.pendingPositions.filter((pending) => pending !== position);
  if (turn?.chatModel && !turn.error && !isCompletedGeneration(turn))
    agg.pendingPositions.push(position);
}

/**
 * generatorMetadataOffset for the next incremental poll: the earliest
 * unconfirmed row within the pending tail, otherwise the start of the tail —
 * the last PENDING_TAIL_ROWS rows are always re-read so rows whose counts or
 * models change after being counted converge, at bounded payload cost.
 */
function generatorRefreshOffset(agg) {
  const floor = Math.max(0, agg.seen - PENDING_TAIL_ROWS);
  const pending = agg.pendingPositions.filter((position) => position >= floor);
  return pending.length ? Math.min(...pending) : floor;
}

/**
 * Σtokens / Σseconds over one model's recent completed generations, per metric.
 * Each generation weighs by its duration, so one very short window cannot
 * dominate as it would in a mean of per-generation rates. With concurrent
 * requests this is a per-request average, not wall-clock service throughput.
 */
function recentGenerationSpeed(agg, model) {
  const samples =
    model && Array.isArray(agg?.speedSamples)
      ? agg.speedSamples.filter((sample) => sample.model === model)
      : [];
  const summarize = (pairs) => {
    if (!pairs.length) return null;
    let tokens = 0;
    let seconds = 0;
    for (const pair of pairs) {
      tokens += pair.tokens;
      seconds += pair.seconds;
    }
    return {
      tps: pairRate({ tokens, seconds }),
      samples: pairs.length,
      tokens,
      seconds: Number(seconds.toFixed(2)),
      lowConfidence: seconds < SHORT_WINDOW_SEC,
    };
  };
  return {
    model: model || null,
    stream: summarize(samples.map((sample) => sample.stream).filter(Boolean)),
    overall: summarize(samples.map((sample) => sample.overall).filter(Boolean)),
  };
}

// ---------------------------------------------------------------------------
// Session-level rolling aggregates shared by panel and capsule.
// GetCascadeTrajectoryGeneratorMetadata supports offset semantics: fetching
// with generatorMetadataOffset=N returns only entries after N (a no-op poll
// is ~0 KB). Each conversation keeps one rolling aggregate; polls pull only
// the tail delta, so payload no longer grows with session length.
// ---------------------------------------------------------------------------

/**
 * 新建空白聚合。lastResyncAt 以建立當下為基準，避免第二次輪詢就觸發全量對帳。
 */
function createSessionAgg(now = Date.now()) {
  return {
    seen: 0,
    lastResyncAt: now,
    sumInput: 0,
    sumCache: 0,
    sumThinking: 0,
    sumResponse: 0,
    sumCostUsd: 0,
    unpricedRequests: 0,
    requestCount: 0,
    totalValidTurns: 0,
    variants: {},
    latestTurn: null,
    latestPosition: -1,
    traceId: null,
    speedSamples: [],
    pendingPositions: [],
    contributions: new Map(),
    reconciliationDue: false,
    unresolvedTailRows: 0,
    capacity: null,
    bufferTokens: null,
    latestExec: null,
    lastExecFetch: 0,
    lastExecAttempt: null,
    executorError: null,
    generatorUpdatedAt: null,
  };
}

/**
 * Identity of the usage-relevant fields of one observed row. Values are
 * normalized so equivalent re-encodings ('100' vs 100, whitespace) do not
 * look like revisions. Pricing candidates are covered because any of them
 * can select the price applied to the row.
 */
function contributionFingerprint(turn, cm, usage) {
  const text = (value) => (typeof value === 'string' ? value.trim() : null);
  return JSON.stringify([
    parseTokenCount(usage?.inputTokens),
    parseTokenCount(usage?.cacheReadTokens),
    parseTokenCount(usage?.outputTokens),
    parseTokenCount(usage?.thinkingOutputTokens),
    parseTokenCount(usage?.responseOutputTokens),
    Boolean(turn?.error),
    text(cm?.stopReason),
    text(cm?.responseModel),
    text(cm?.model),
    text(usage?.model),
    text(cm?.modelDisplayName),
    text(cm?.chatStartMetadata?.createdAt),
    text(turn?.executionId),
  ]);
}

function rowContribution(turn, customPrices) {
  const cm = turn?.chatModel;
  const usage = cm?.usage || null;
  const split = usage
    ? splitUsageTokens(usage)
    : { input: 0, cache: 0, output: 0, thinking: 0, response: 0 };
  const eligible = Boolean(usage) && split.input + split.cache > 0;
  const variant = typeof cm?.responseModel === 'string' ? cm.responseModel.trim() : '';
  let costUsd = 0;
  let priced = false;
  if (eligible) {
    const pricing = getModelPricing(cm, cm.chatStartMetadata?.createdAt, customPrices);
    if (pricing) {
      costUsd = computeTurnCostUsd(split, pricing);
      priced = true;
    }
  }
  return {
    fingerprint: contributionFingerprint(turn, cm, usage),
    input: split.input,
    cache: split.cache,
    thinking: split.thinking,
    response: split.response,
    costUsd,
    priced,
    variant: variant || null,
    eligible,
  };
}

function addContribution(agg, contribution) {
  if (!contribution.eligible) return;
  agg.sumInput += contribution.input;
  agg.sumCache += contribution.cache;
  agg.sumThinking += contribution.thinking;
  agg.sumResponse += contribution.response;
  agg.requestCount += 1;
  if (contribution.priced) agg.sumCostUsd += contribution.costUsd;
  else agg.unpricedRequests += 1;
  if (contribution.variant) {
    agg.variants[contribution.variant] = (agg.variants[contribution.variant] || 0) + 1;
    agg.totalValidTurns += 1;
  }
}

function removeContribution(agg, contribution) {
  if (!contribution.eligible) return;
  agg.sumInput -= contribution.input;
  agg.sumCache -= contribution.cache;
  agg.sumThinking -= contribution.thinking;
  agg.sumResponse -= contribution.response;
  agg.requestCount -= 1;
  if (contribution.priced) agg.sumCostUsd -= contribution.costUsd;
  else agg.unpricedRequests -= 1;
  if (contribution.variant) {
    const remaining = (agg.variants[contribution.variant] || 0) - 1;
    if (remaining > 0) agg.variants[contribution.variant] = remaining;
    else delete agg.variants[contribution.variant];
    agg.totalValidTurns -= 1;
  }
}

/**
 * 將一批 generatorMetadata 增量合併進聚合。
 * 契約：merge(merge(empty, batch[0..k]), batch[k..n]) 與 merge(empty, batch[0..n]) 等價。
 * seen 計數的是「位置」而非有效輪次，與伺服器端 offset 語義對齊。
 * Each position keeps a bounded contribution ledger entry. A re-read whose
 * fingerprint changed replaces the earlier contribution — token sums, cost
 * under the current prices, variant counts, requestCount on eligibility
 * changes — while an unchanged fingerprint is a no-op, so re-polled rows
 * never double count.
 */
function mergeGeneratorMetadata(agg, entries, customPrices = [], offset = agg?.seen) {
  if (!agg || !Array.isArray(entries)) return agg;
  const start = Number.isInteger(offset) && offset >= 0 && offset <= agg.seen ? offset : agg.seen;
  for (let index = 0; index < entries.length; index++) {
    const turn = entries[index];
    const position = start + index;
    trackPendingGeneration(agg, turn, position);
    recordSpeedSample(agg, turn, position);
    const contribution = rowContribution(turn, customPrices);
    const previous = agg.contributions.get(position);
    if (!previous) {
      // A re-read below the ledger window has no recorded prior contribution;
      // it was already counted when first observed, so adding it again would
      // double count. Only genuine first observations are accounted.
      if (position >= agg.seen) {
        agg.contributions.set(position, contribution);
        addContribution(agg, contribution);
      }
    } else if (previous.fingerprint !== contribution.fingerprint) {
      removeContribution(agg, previous);
      agg.contributions.set(position, contribution);
      addContribution(agg, contribution);
    }

    const cm = turn?.chatModel;
    const usage = cm?.usage;
    if (!cm || !usage) continue;
    const { input, cache, output } = splitUsageTokens(usage);
    if (input + cache === 0) continue;
    const variant = typeof cm.responseModel === 'string' ? cm.responseModel.trim() : '';
    if ((turn.error || !variant) && output === 0) {
      // The server may re-read a row it previously delivered as a valid turn.
      // The contribution swap above already corrected the aggregates; drop the
      // now-invalid latest snapshot too, or the display keeps stale data until
      // the next full resync.
      if (position === agg.latestPosition) agg.latestTurn = null;
      continue;
    }

    if (position >= agg.latestPosition) {
      agg.latestTurn = turn;
      agg.latestPosition = position;
    }
  }
  agg.seen = Math.max(agg.seen, start + entries.length);
  const floor = agg.seen - PENDING_TAIL_ROWS;
  const dropped = agg.pendingPositions.filter((position) => position < floor);
  if (dropped.length) {
    // Unresolved rows that leave the window are invisible to the tail poll
    // until the next full resync; surface that gap instead of dropping the
    // pending markers silently.
    agg.reconciliationDue = true;
    agg.unresolvedTailRows += dropped.length;
  }
  agg.pendingPositions = agg.pendingPositions.filter((position) => position >= floor);
  for (const position of agg.contributions.keys()) {
    if (position < floor) agg.contributions.delete(position);
  }
  return agg;
}

/**
 * 定期全量對帳：以 offset=0 取回的完整清單校正滾動聚合。
 * The server may replace entries without changing the list length. Rebuild
 * from its authoritative full list, retaining only per-conversation metadata.
 */
function applyFullResync(agg, entries, customPrices = []) {
  const fresh = createSessionAgg();
  fresh.traceId = agg.traceId;
  fresh.capacity = agg.capacity;
  fresh.bufferTokens = agg.bufferTokens;
  fresh.latestExec = agg.latestExec;
  fresh.lastExecFetch = agg.lastExecFetch;
  fresh.lastExecAttempt = agg.lastExecAttempt;
  fresh.executorError = agg.executorError;
  fresh.generatorUpdatedAt = agg.generatorUpdatedAt;
  mergeGeneratorMetadata(fresh, entries, customPrices);
  return entries.length < agg.seen ? fresh : Object.assign(agg, fresh);
}

function splitUsageTokens(usage) {
  const input = parseTokenCount(usage?.inputTokens) ?? 0;
  const cache = parseTokenCount(usage?.cacheReadTokens) ?? 0;
  const output = parseTokenCount(usage?.outputTokens) ?? 0;
  const rawResp = parseTokenCount(usage?.responseOutputTokens);
  let thinking = parseTokenCount(usage?.thinkingOutputTokens);
  if (thinking === null && rawResp !== null) {
    thinking = Math.max(0, output - rawResp);
  } else if (thinking === null) {
    thinking = 0;
  }
  const response = rawResp !== null ? rawResp : Math.max(0, output - thinking);
  return { input, cache, output, thinking, response };
}

function applyExecutorCapacity(agg, execRes, now = Date.now()) {
  if (!agg || !execRes?.executorMetadata) return null;
  let found = null;
  for (let i = execRes.executorMetadata.length - 1; i >= 0; i--) {
    const exec = execRes.executorMetadata[i];
    const cp = exec?.cascadeConfig?.checkpointConfig;
    if (cp && typeof cp.maxTokenLimit === 'number' && cp.maxTokenLimit > 0) {
      agg.capacity = cp.maxTokenLimit;
      if (typeof cp.tokenThreshold === 'number') agg.bufferTokens = cp.tokenThreshold;
      agg.latestExec = exec;
      found = cp.maxTokenLimit;
      break;
    }
  }
  if (found) agg.lastExecFetch = now;
  return found;
}

function pctOfCapacity(tokens, capacity) {
  if (!capacity || tokens == null) return null;
  return Number(((tokens / capacity) * 100).toFixed(1));
}

function sessionTotalsFromAgg(agg) {
  const sumTotalTok = agg.sumInput + agg.sumCache + agg.sumThinking + agg.sumResponse;
  const calcSessPct = (tok) =>
    sumTotalTok > 0 ? Number(((tok / sumTotalTok) * 100).toFixed(1)) : 0;
  return {
    requests: agg.requestCount,
    uncachedTokens: agg.sumInput,
    uncachedPct: calcSessPct(agg.sumInput),
    cachedTokens: agg.sumCache,
    cachedPct: calcSessPct(agg.sumCache),
    thinkingTokens: agg.sumThinking,
    thinkingPct: calcSessPct(agg.sumThinking),
    outputTokens: agg.sumResponse,
    outputPct: calcSessPct(agg.sumResponse),
    totalCostUsd: agg.unpricedRequests ? null : agg.sumCostUsd,
    unpricedRequests: agg.unpricedRequests,
  };
}

function modelVariantsFromAgg(agg) {
  return Object.entries(agg.variants)
    .map(([name, count]) => ({
      name,
      count,
      percentage:
        agg.totalValidTurns > 0 ? Number(((count / agg.totalValidTurns) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

function estimateComposition(agg, input, cache, capacity) {
  const calcPct = (tok) => pctOfCapacity(tok, capacity);
  const latestExec = agg.latestExec;
  const customs = latestExec?.loadedCustomizations?.customizations || [];
  const skillsItems = customs.filter((c) => c.type === 'REFRESH_CUSTOMIZATION_TYPE_SKILL');
  const rulesItems = customs.filter((c) => c.type === 'REFRESH_CUSTOMIZATION_TYPE_RULE');
  const mcpItems = customs.filter((c) => c.type === 'REFRESH_CUSTOMIZATION_TYPE_MCP');
  const toolsItems = latestExec?.cascadeConfig?.plannerConfig?.declarativeMixinConfig?.tools || [];
  const promptSecs =
    latestExec?.cascadeConfig?.plannerConfig?.declarativeMixinConfig?.promptSections || [];

  const skillsTok = Math.max(1200, skillsItems.length * 2000);
  const memoryTok = Math.max(500, rulesItems.length * 1500);
  const mcpToolsTok = Math.max(1800, mcpItems.length * 1800 + 1400);
  const systemToolsTok = Math.max(3000, toolsItems.length * 350);
  const systemPromptTok = Math.max(4000, promptSecs.length * 450);
  const bufferTokens = agg.bufferTokens ?? BUFFER_DEFAULT_TOKENS;
  const messagesTok = Math.max(
    0,
    input + cache - (skillsTok + memoryTok + mcpToolsTok + systemToolsTok + systemPromptTok),
  );

  return {
    messagesTokens: messagesTok,
    messagesPct: calcPct(messagesTok),
    mcpToolsTokens: mcpToolsTok,
    mcpToolsPct: calcPct(mcpToolsTok),
    systemToolsTokens: systemToolsTok,
    systemToolsPct: calcPct(systemToolsTok),
    systemPromptTokens: systemPromptTok,
    systemPromptPct: calcPct(systemPromptTok),
    skillsTokens: skillsTok,
    skillsPct: calcPct(skillsTok),
    memoryTokens: memoryTok,
    memoryPct: calcPct(memoryTok),
    bufferTokens,
    bufferPct: calcPct(bufferTokens),
    freeTokens: 0,
    freePct: 0,
  };
}

function metricsFromAgg(
  agg,
  {
    capacity,
    conversationId,
  } = /** @type {{ capacity?: unknown, conversationId?: unknown }} */ ({}),
) {
  const cap = capacity || agg.capacity || null;
  const sessionTotals = sessionTotalsFromAgg(agg);
  const modelVariants = modelVariantsFromAgg(agg);
  const totalSessionPrompt = agg.sumInput + agg.sumCache;
  const sessionCacheRate =
    totalSessionPrompt > 0 ? Number(((agg.sumCache / totalSessionPrompt) * 100).toFixed(1)) : 0;

  if (!agg.latestTurn) {
    const bufferTokens = agg.bufferTokens ?? BUFFER_DEFAULT_TOKENS;
    return {
      conversationId: conversationId || null,
      isWaitingGen: true,
      capacity: cap,
      totalUsed: 0,
      usedPercentage: cap ? 0 : null,
      input: 0,
      cache: 0,
      thinking: 0,
      output: 0,
      response: 0,
      freeTokens: cap,
      sessionCacheRate,
      turnCacheRate: 0,
      modelName: null,
      modelAlias: null,
      responseModel: null,
      modelDisplayName: null,
      modelId: null,
      speed: { ...emptyGenerationSpeed(), latestOutputTokens: 0 },
      composition: {
        messagesTokens: 0,
        messagesPct: 0,
        mcpToolsTokens: 0,
        mcpToolsPct: 0,
        systemToolsTokens: 0,
        systemToolsPct: 0,
        systemPromptTokens: 0,
        systemPromptPct: 0,
        skillsTokens: 0,
        skillsPct: 0,
        memoryTokens: 0,
        memoryPct: 0,
        bufferTokens,
        bufferPct: pctOfCapacity(bufferTokens, cap),
        freeTokens: cap,
        freePct: cap ? 100 : null,
      },
      sessionTotals,
      modelVariants,
    };
  }

  const latestChat = agg.latestTurn.chatModel || {};
  const tokens = splitUsageTokens(latestChat.usage || {});
  const totalUsed = tokens.input + tokens.cache + tokens.output;
  const freeTokens = cap ? Math.max(0, cap - totalUsed) : null;
  const turnPrompt = tokens.input + tokens.cache;
  const turnCacheRate = turnPrompt > 0 ? Number(((tokens.cache / turnPrompt) * 100).toFixed(1)) : 0;
  const speed = computeGenerationSpeed(latestChat);
  speed.latestComplete = isCompletedGeneration(agg.latestTurn);
  speed.recent = recentGenerationSpeed(agg, speedSampleModel(latestChat));
  const responseModel = latestChat.responseModel || null;
  const modelDisplayName = latestChat.modelDisplayName || null;
  const modelId = latestChat.model || null;
  const modelAlias = responseModel || modelId;
  const composition = estimateComposition(agg, tokens.input, tokens.cache, cap);
  composition.freeTokens = freeTokens;
  composition.freePct = pctOfCapacity(freeTokens, cap);

  return {
    conversationId: conversationId || null,
    isWaitingGen: false,
    capacity: cap,
    totalUsed,
    usedPercentage: pctOfCapacity(totalUsed, cap),
    input: tokens.input,
    cache: tokens.cache,
    thinking: tokens.thinking,
    output: tokens.output,
    response: tokens.response,
    freeTokens,
    sessionCacheRate,
    turnCacheRate,
    modelName: modelAlias || modelDisplayName,
    modelAlias,
    responseModel,
    modelDisplayName,
    modelId,
    speed,
    composition,
    sessionTotals,
    modelVariants,
  };
}

export {
  applyExecutorCapacity,
  applyFullResync,
  BUFFER_DEFAULT_TOKENS,
  computeGenerationSpeed,
  createSessionAgg,
  emptyGenerationSpeed,
  formatTokens,
  generatorRefreshOffset,
  mergeGeneratorMetadata,
  metricsFromAgg,
  parseDuration,
  parseTokenCount,
  recentGenerationSpeed,
  splitUsageTokens,
};
