import fs from 'node:fs';
import path from 'node:path';
import { endpointFingerprint } from '../../lib/endpoint.mjs';
import { createSessionAgg, mergeGeneratorMetadata } from '../../lib/metrics-core.mjs';
import {
  LS_RPC_METHODS,
  normalizeGeneratorMetadataResponse,
  normalizeTrajectoryStepsResponse,
  normalizeTrajectorySummariesResponse,
} from '../../lib/upstream-contract.mjs';
import { readPricingStatus } from './pricing.mjs';
import { callLanguageServer, discoverLanguageServer } from './telemetry.mjs';

const CACHE_TTL_MS = 120_000;
const FAILURE_TTL_MS = 60_000;
const REFRESH_DEADLINE_MS = 60_000;
const RPC_DEADLINE_MS = 8_000;
const STEP_RPC_DEADLINE_MS = 20_000;
// Step payloads embed full message content (megabytes for long conversations),
// so step reads get a wider provisional budget than the default metadata
// budget in transport.mjs.
const STEP_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const CONCURRENCY = 3;
const DAILY_DAYS = 14;
const MAX_LISTED_CONVERSATIONS = 500;
// Filename filter with the strict canonical UUID shape. Conversation-ID
// validation elsewhere (panel discovery and the capsule) uses the looser
// 36-char hex/dash grammar in plugin/lib/poll-policy.mjs; the two contracts
// must not be swapped — loosening here would fetch RPCs for non-conversation
// files, tightening there would hide conversations that predate canonical
// UUID naming.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A repeatedly failing conversation yields later scans to unvisited ones and
// retries only after this bounded backoff (doubled per consecutive failure).
const RETRY_BACKOFF_BASE_MS = 60_000;
const RETRY_BACKOFF_MAX_MS = 600_000;
/** @type {Map<string, {failedAt: number, consecutive: number}>} */
const retryAfter = new Map();

/** @param {number} consecutive */
function retryDelayMs(consecutive) {
  const shift = Math.min(Math.max(consecutive - 1, 0), 20);
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** shift, RETRY_BACKOFF_MAX_MS);
}

/** @param {string} id @param {number} now */
function retryEligible(id, now) {
  const failed = retryAfter.get(id);
  return !failed || now - failed.failedAt >= retryDelayMs(failed.consecutive);
}

/** @param {string} id @param {number} now */
function recordRetryFailure(id, now) {
  const previous = retryAfter.get(id);
  retryAfter.set(id, { failedAt: now, consecutive: (previous?.consecutive ?? 0) + 1 });
}

// Raw generator metadata is retained across scans only as provisional data
// for a pending date repair, under this byte cap. Eviction drops the rows and
// the success fingerprint, so the next scan refetches instead of trusting a
// partial bucket — eviction keeps a retry marker, never a false success.
const PROVISIONAL_MAX_BYTES = 32 * 1024 * 1024;
/** @type {Map<string, number>} */
const provisionalOrder = new Map();
let provisionalBytes = 0;

/** @param {string} id */
function releaseProvisionalEntries(id) {
  const previous = provisionalOrder.get(id);
  if (previous !== undefined) {
    provisionalOrder.delete(id);
    provisionalBytes -= previous;
  }
}

/** @param {string} id @param {import("../../lib/metrics-core.mjs").GeneratorMetadata[]} entries */
function retainProvisionalEntries(id, entries) {
  releaseProvisionalEntries(id);
  const bytes = Buffer.byteLength(JSON.stringify(entries), 'utf8');
  provisionalOrder.set(id, bytes);
  provisionalBytes += bytes;
}

function evictProvisionalEntriesOverBudget() {
  for (const [id, bytes] of provisionalOrder) {
    if (provisionalBytes <= PROVISIONAL_MAX_BYTES) break;
    provisionalBytes -= bytes;
    provisionalOrder.delete(id);
    const cached = conversations.get(id);
    if (cached) {
      conversations.set(id, { ...cached, entries: undefined, fingerprint: null });
    }
  }
}

function resetProvisionalEntries() {
  provisionalOrder.clear();
  provisionalBytes = 0;
}

/** @type {string|null} */
let endpointKey = null;
/** @type {string|null} */
let product = null;
/** @type {import("./contracts.js").PricingStatus|null} */
let pricing = null;
/** @type {Map<string,import("./contracts.js").ConversationUsage>} */
let conversations = new Map();
/** @type {Map<string,import("./contracts.js").ConversationDetail>} */
let details = new Map();
let scan = emptyScan();
/** @type {number|null} */
let lastAttemptAt = null;
/** @type {Promise<void>|null} */
let inFlight = null;
let generation = 0;
/** @type {AbortController|null} */
let controller = null;

/** @returns {import("./contracts.js").UsageScan} */
function emptyScan() {
  return {
    status: 'loading',
    updatedAt: null,
    discovered: null,
    failed: 0,
    unscanned: 0,
    error: null,
    refreshing: false,
  };
}

/** @param {unknown} value @returns {value is object} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value */
function textOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** @param {string} operation @param {Error} error @param {AbortSignal} signal */
function safeError(operation, error, signal) {
  if (signal?.aborted) return `${operation} exceeded the refresh deadline`;
  if (/^Invalid (trajectory summaries response|trajectory summary)$/.test(error?.message || ''))
    return error.message;
  const status = /^RPC HTTP (\d{3})\b/.exec(error?.message || '')?.[1];
  return `${operation} failed${status ? ` (HTTP ${status})` : ''}`;
}

/** @param {Date} date */
export function dayKey(date) {
  /** @param {number} value */
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** @param {unknown} value */
function parseTime(value) {
  if (typeof value !== 'string') return null;
  // SQLite rows use "YYYY-MM-DD HH:MM:SS.fffffff+00:00", which Date.parse rejects.
  const normalized = value
    .trim()
    .replace(' ', 'T')
    .replace(/(\.\d{3})\d+/, '$1');
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
}

/** @param {unknown} uri */
function workspaceName(uri) {
  if (typeof uri !== 'string') return null;
  try {
    const pathname = decodeURIComponent(new URL(uri).pathname).replace(/[\\/]+$/, '');
    return textOrNull(pathname.split(/[\\/]/).pop());
  } catch {
    return null;
  }
}

/** @param {import("../../lib/metrics-core.mjs").GeneratorMetadata} entry @param {(number|null)[]} stepTimes */
function turnTime(entry, stepTimes) {
  const fromMetadata = parseTime(entry?.chatModel?.chatStartMetadata?.createdAt);
  if (fromMetadata !== null) return fromMetadata;
  const index = Array.isArray(entry?.stepIndices) ? Number(entry.stepIndices[0]) : NaN;
  return Number.isInteger(index) ? (stepTimes[index] ?? null) : null;
}

/**
 * Builds day and model buckets so the UI can filter ranges without rescanning.
 * Generator metadata carries no timestamp in current builds, so each turn takes
 * the createdAt of its first step; that time also selects date-dependent prices.
 */
/** @param {import("../../lib/metrics-core.mjs").GeneratorMetadata[]} entries @param {import("../../lib/pricing-core.mjs").ModelPrice[]} [prices] @param {(number|null)[]} [stepTimes] */
export function bucketGeneratorMetadata(entries, prices = [], stepTimes = []) {
  const groups = new Map();
  let lastTurnAt = null;
  for (const entry of entries) {
    const chatModel = entry?.chatModel;
    const created = turnTime(entry, stepTimes);
    if (created !== null) lastTurnAt = Math.max(lastTurnAt ?? created, created);
    const day = created === null ? null : dayKey(new Date(created));
    const model = textOrNull(chatModel?.responseModel) ?? 'unknown';
    const key = JSON.stringify([day, model]);
    if (!groups.has(key)) groups.set(key, { day, model, entries: [] });
    const dated =
      created === null || !isRecord(chatModel)
        ? entry
        : {
            ...entry,
            chatModel: {
              ...chatModel,
              chatStartMetadata: {
                ...chatModel.chatStartMetadata,
                createdAt: new Date(created).toISOString(),
              },
            },
          };
    groups.get(key).entries.push(dated);
  }
  const buckets = [];
  for (const { day, model, entries: group } of groups.values()) {
    const aggregate = mergeGeneratorMetadata(createSessionAgg(), group, prices);
    if (!aggregate.requestCount) continue;
    buckets.push({
      day,
      model,
      requests: aggregate.requestCount,
      uncachedTokens: aggregate.sumInput,
      cachedTokens: aggregate.sumCache,
      thinkingTokens: aggregate.sumThinking,
      outputTokens: aggregate.sumResponse,
      costUsd: aggregate.sumCostUsd,
      unpricedRequests: aggregate.unpricedRequests,
    });
  }
  return { buckets, lastTurnAt };
}

/** @param {string|undefined} directory @param {string} id */
function fileFingerprint(directory, id) {
  if (!directory) return null;
  const parts = [];
  for (const suffix of ['.db', '.db-wal']) {
    try {
      const stat = fs.statSync(path.join(directory, `${id}${suffix}`));
      parts.push(stat.size, stat.mtimeMs);
    } catch {
      parts.push(null, null);
    }
  }
  return parts;
}

/** @param {string|undefined} directory */
function listConversationFiles(directory) {
  if (!directory) return [];
  try {
    return fs
      .readdirSync(directory)
      .filter((name) => name.endsWith('.db') && UUID_RE.test(name.slice(0, -3)))
      .map((name) => name.slice(0, -3));
  } catch {
    return [];
  }
}

/**
 * Reads titles and workspaces from the client's summary index. The database is
 * opened read-only and closed immediately; a missing module or schema yields no metadata.
 */
/** @param {string|undefined} conversationDir @returns {Promise<Map<string,import("./contracts.js").ConversationDetail>>} */
async function readSummaryIndex(conversationDir) {
  const index = new Map();
  if (!conversationDir) return index;
  let sqlite;
  try {
    sqlite = await import('node:sqlite');
  } catch {
    return index;
  }
  let database;
  try {
    database = new sqlite.DatabaseSync(
      path.join(path.dirname(conversationDir), 'conversation_summaries.db'),
      { readOnly: true },
    );
    const rows = database
      .prepare(
        'SELECT conversation_id, title, workspace_uris, last_modified_time, parent_conversation_id FROM conversation_summaries',
      )
      .all();
    for (const row of rows) {
      const id = textOrNull(row.conversation_id);
      if (!id) continue;
      let uris = [];
      try {
        uris = JSON.parse(typeof row.workspace_uris === 'string' ? row.workspace_uris : '[]');
      } catch {}
      index.set(id, {
        title: textOrNull(row.title),
        workspace: Array.isArray(uris) ? workspaceName(uris[0]) : null,
        modifiedAt: parseTime(row.last_modified_time),
        parentId: textOrNull(row.parent_conversation_id),
      });
    }
  } catch {
    index.clear();
  } finally {
    try {
      database?.close();
    } catch {}
  }
  return index;
}

/** @param {Map<string,import("./contracts.js").ConversationDetail>} index @param {Record<string,import("./contracts.js").TrajectorySummary>} summaries */
function mergeRpcSummaries(index, summaries) {
  for (const [id, summary] of Object.entries(summaries)) {
    if (!isRecord(summary)) throw new Error('Invalid trajectory summary');
    const known = index.get(id) || {};
    const metadata = summary.trajectoryMetadata || {};
    index.set(id, {
      title: known.title ?? textOrNull(summary.summary),
      workspace:
        known.workspace ?? workspaceName(summary.workspaces?.[0]?.workspaceFolderAbsoluteUri),
      modifiedAt: parseTime(summary.lastModifiedTime) ?? known.modifiedAt ?? null,
      parentId:
        known.parentId ??
        textOrNull(metadata.parentConversationId) ??
        textOrNull(metadata.rootConversationId),
      rpcVersion: [summary.lastModifiedTime ?? null, summary.stepCount ?? null],
    });
  }
}

/**
 * Step payloads include full content (megabytes for long conversations), so only
 * steps past the cached count are requested. A failed read throws so the caller
 * leaves the step fingerprint open and retries on the next scan; a success
 * without a steps array means nothing new (Connect JSON omits empty lists).
 */
/** @param {import("./contracts.js").Endpoint} endpoint @param {string} id @param {(number|null)[]} known @param {AbortSignal} signal */
async function readStepTimes(endpoint, id, known, signal) {
  const result = await callLanguageServer(
    endpoint,
    LS_RPC_METHODS.steps,
    {
      cascadeId: id,
      stepOffset: known.length,
    },
    { signal, timeoutMs: STEP_RPC_DEADLINE_MS, maxBytes: STEP_RESPONSE_MAX_BYTES },
  );
  // A present non-array steps field is a contract violation: failing the read
  // keeps the step fingerprint open instead of marking a malformed response as
  // a successful date read.
  const steps = normalizeTrajectoryStepsResponse(result);
  if (steps === null) return known;
  return [...known, ...steps.map((step) => parseTime(step?.metadata?.createdAt))];
}

/** @param {import("./contracts.js").Endpoint} endpoint @param {AbortSignal} signal @param {import("../../lib/pricing-core.mjs").ModelPrice[]} prices @param {string|null} revision @param {()=>boolean} isCurrent */
async function scanConversations(endpoint, signal, prices, revision, isCurrent) {
  const response = await callLanguageServer(
    endpoint,
    LS_RPC_METHODS.allTrajectories,
    {},
    { signal, timeoutMs: RPC_DEADLINE_MS },
  );
  // Shared normalizer: Connect JSON omits empty maps, so a missing field is a
  // legal empty map and a present non-object is a contract violation.
  const summaries = normalizeTrajectorySummariesResponse(response);
  const index = await readSummaryIndex(endpoint.conversationDir);
  mergeRpcSummaries(index, summaries);
  const ids = new Set([
    ...listConversationFiles(endpoint.conversationDir),
    ...Object.keys(summaries),
  ]);
  for (const id of Object.keys(summaries)) {
    const parentId = index.get(id)?.parentId;
    if (parentId) ids.add(parentId);
  }
  if (!isCurrent()) return;
  details = index;
  for (const id of conversations.keys()) {
    if (!ids.has(id)) {
      releaseProvisionalEntries(id);
      conversations.delete(id);
    }
  }

  /** @type {{id:string,fingerprint:string,eligible:boolean}[]} */
  const queue = [];
  const now = Date.now();
  for (const id of ids) {
    const fingerprint = JSON.stringify([
      revision,
      fileFingerprint(endpoint.conversationDir, id),
      index.get(id)?.rpcVersion ?? null,
    ]);
    const cached = conversations.get(id);
    // Metadata success and step-time success commit fingerprints separately, so
    // an unchanged conversation is not refetched while a conversation whose
    // date read failed keeps coming back until it succeeds.
    if (cached?.fingerprint !== fingerprint || cached?.stepFingerprint !== fingerprint) {
      queue.push({ id, fingerprint, eligible: retryEligible(id, now) });
    }
  }
  scan = { ...scan, discovered: ids.size, failed: 0, unscanned: queue.length };
  let next = 0;
  let failed = 0;
  let deferred = 0;

  async function worker() {
    while (next < queue.length && !signal.aborted) {
      const { id, fingerprint, eligible } = queue[next++];
      if (!eligible) {
        // A recently failed conversation yields this scan's budget to
        // unvisited ones; it stays unscanned and retries after its backoff.
        deferred += 1;
        scan = { ...scan, unscanned: queue.length - next + deferred };
        continue;
      }
      try {
        const cached = conversations.get(id);
        let entries;
        if (cached?.fingerprint !== fingerprint) {
          const result = await callLanguageServer(
            endpoint,
            LS_RPC_METHODS.generatorMetadata,
            {
              cascadeId: id,
              generatorMetadataOffset: 0,
              includeMessages: false,
            },
            { signal, timeoutMs: RPC_DEADLINE_MS },
          );
          entries = normalizeGeneratorMetadataResponse(result);
        } else {
          // Date retry with a compact provisional result available: reuse the
          // cached entries instead of refetching unchanged generator metadata.
          entries = cached.entries ?? [];
        }
        let stepTimes = cached?.stepTimes ?? [];
        let datesComplete = false;
        try {
          stepTimes = await readStepTimes(endpoint, id, stepTimes, signal);
          datesComplete = true;
        } catch {}
        if (!isCurrent()) return;
        conversations.set(id, {
          fingerprint,
          revision,
          stepTimes,
          ...bucketGeneratorMetadata(entries, prices, stepTimes),
          ...(datesComplete
            ? { stepFingerprint: fingerprint }
            : // Provisional: keep the entries so the next scan can repair the
              // dates from them once the step read succeeds.
              { entries }),
        });
        if (datesComplete) releaseProvisionalEntries(id);
        else {
          retainProvisionalEntries(id, entries);
          evictProvisionalEntriesOverBudget();
        }
        retryAfter.delete(id);
      } catch {
        failed += 1;
        // Deferred scans (deadline aborts included) must not re-enter on the
        // next scan before unvisited conversations get their turn.
        recordRetryFailure(id, Date.now());
      }
      if (!isCurrent()) return;
      scan = { ...scan, failed, unscanned: queue.length - next + deferred };
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (!isCurrent()) return;
  const unscanned = queue.length - next + deferred;
  const incomplete = failed > 0 || unscanned > 0;
  scan = {
    ...scan,
    status: incomplete ? (conversations.size ? 'partial' : 'error') : 'ready',
    updatedAt: new Date().toISOString(),
    failed,
    unscanned,
    error: incomplete
      ? `${failed + unscanned} of ${ids.size} conversations could not be read`
      : null,
  };
}

/** @param {boolean} force @param {import("../../lib/pricing-core.mjs").ModelPrice[]} prices @param {string|null} revision @param {number} current */
async function refresh(force, prices, revision, current) {
  const isCurrent = () => current === generation;
  const scanController = new AbortController();
  controller = scanController;
  const timer = setTimeout(
    () => scanController.abort(new Error('Usage refresh deadline exceeded')),
    REFRESH_DEADLINE_MS,
  );
  let operation = 'Language Server discovery';
  try {
    const endpoint = await discoverLanguageServer(force, null, scanController.signal);
    if (!isCurrent()) return;
    const nextKey = endpointFingerprint(endpoint);
    if (endpointKey !== null && endpointKey !== nextKey) {
      conversations = new Map();
      resetProvisionalEntries();
      details = new Map();
      retryAfter.clear();
    }
    endpointKey = nextKey;
    product = textOrNull(endpoint.product);
    operation = 'Conversation scan';
    await scanConversations(endpoint, scanController.signal, prices, revision, isCurrent);
  } catch (error) {
    if (!isCurrent()) return;
    scan = {
      ...scan,
      status: conversations.size ? 'partial' : 'error',
      error: safeError(operation, error, scanController.signal),
    };
  } finally {
    clearTimeout(timer);
    if (controller === scanController) controller = null;
    if (isCurrent()) scan = { ...scan, refreshing: false };
  }
}

/** @returns {import("./contracts.js").UsageTotals} */
function emptyTotals() {
  return {
    requests: 0,
    uncachedTokens: 0,
    cachedTokens: 0,
    thinkingTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedRequests: 0,
  };
}

/** @param {import("./contracts.js").UsageTotals} totals @param {import("./contracts.js").UsageBucket} bucket */
function addBucket(totals, bucket) {
  totals.requests += bucket.requests;
  totals.uncachedTokens += bucket.uncachedTokens;
  totals.cachedTokens += bucket.cachedTokens;
  totals.thinkingTokens += bucket.thinkingTokens;
  totals.outputTokens += bucket.outputTokens;
  totals.totalTokens +=
    bucket.uncachedTokens + bucket.cachedTokens + bucket.thinkingTokens + bucket.outputTokens;
  totals.costUsd += bucket.costUsd;
  totals.unpricedRequests += bucket.unpricedRequests;
}

/** @param {string} id */
function rootOf(id) {
  let current = id;
  const visited = new Set();
  while (!visited.has(current)) {
    visited.add(current);
    const parentId = details.get(current)?.parentId;
    if (!parentId || parentId === current) break;
    current = parentId;
  }
  return current;
}

/** @param {number} now */
function rangeStarts(now) {
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - 6);
  return { today: dayKey(new Date(now)), week: dayKey(weekStart), all: null };
}

/** @param {string|null} day @param {string|null} start */
function inRange(day, start) {
  return start === null || (day !== null && day >= start);
}

/** @param {import("./contracts.js").PricingStatus} pricingState */
function buildOverview(pricingState) {
  const revision = pricingState.revision;
  const now = Date.now();
  const starts = rangeStarts(now);
  /** @type {Record<string,import("./contracts.js").UsageTotals & {conversations:number}>} */
  const ranges = {};
  /** @type {Record<string,Map<string,import("./contracts.js").UsageTotals & {model:string}>>} */
  const models = {};
  for (const name of Object.keys(starts)) {
    ranges[name] = { ...emptyTotals(), conversations: 0 };
    models[name] = new Map();
  }
  /** @type {Map<string,{id:string,subagents:number,lastActiveAt:number|null,ranges:Record<string,import("./contracts.js").UsageTotals>}>} */
  const roots = new Map();
  const daily = new Map();
  for (let offset = DAILY_DAYS - 1; offset >= 0; offset--) {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    daily.set(dayKey(date), { day: dayKey(date), ...emptyTotals() });
  }
  // With no trusted price source, every cost must surface as unavailable —
  // null, never zero — even for records that were scanned during the outage.
  let repricing = pricingState.status === 'unavailable';

  for (const [id, conversation] of conversations) {
    if (conversation.revision !== revision) repricing = true;
    const rootId = rootOf(id);
    if (!roots.has(rootId)) {
      const ranges = Object.fromEntries(Object.keys(starts).map((name) => [name, emptyTotals()]));
      roots.set(rootId, { id: rootId, subagents: 0, lastActiveAt: null, ranges });
    }
    const root = /** @type {NonNullable<ReturnType<typeof roots.get>>} */ (roots.get(rootId));
    if (rootId !== id) root.subagents += 1;
    const activeAt = conversation.lastTurnAt ?? details.get(id)?.modifiedAt ?? null;
    if (activeAt !== null) root.lastActiveAt = Math.max(root.lastActiveAt ?? activeAt, activeAt);
    for (const bucket of conversation.buckets) {
      for (const [name, start] of Object.entries(starts)) {
        if (!inRange(bucket.day, start)) continue;
        addBucket(ranges[name], bucket);
        addBucket(root.ranges[name], bucket);
        if (!models[name].has(bucket.model))
          models[name].set(bucket.model, { model: bucket.model, ...emptyTotals() });
        addBucket(
          /** @type {import("./contracts.js").UsageTotals} */ (models[name].get(bucket.model)),
          bucket,
        );
      }
      const day = bucket.day === null ? undefined : daily.get(bucket.day);
      if (day) addBucket(day, bucket);
    }
  }

  /** @template {import("./contracts.js").UsageTotals} T @param {T} totals */
  const priced = (totals) => ({
    ...totals,
    costUsd: repricing ? null : Number(totals.costUsd.toFixed(6)),
  });
  for (const root of roots.values()) {
    for (const name of Object.keys(starts)) {
      if (root.ranges[name].requests > 0) ranges[name].conversations += 1;
    }
  }
  const list = [...roots.values()]
    .filter((root) => root.ranges.all.requests > 0)
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
    .slice(0, MAX_LISTED_CONVERSATIONS)
    .map((root) => ({
      id: root.id,
      title: details.get(root.id)?.title ?? null,
      workspace: details.get(root.id)?.workspace ?? null,
      lastActiveAt: root.lastActiveAt === null ? null : new Date(root.lastActiveAt).toISOString(),
      subagents: root.subagents,
      ranges: Object.fromEntries(
        Object.entries(root.ranges).map(([name, totals]) => [name, priced(totals)]),
      ),
    }));
  const reportedRanges = Object.fromEntries(
    Object.keys(starts).map((name) => [
      name,
      {
        ...priced(ranges[name]),
        models: [...models[name].values()]
          .map(priced)
          .sort((a, b) => b.totalTokens - a.totalTokens),
      },
    ]),
  );

  return {
    status: scan.status,
    product,
    pricingStatus: pricingState.status,
    pricingDamaged: pricingState.pricingDamaged,
    pricingDamage: pricingState.damage,
    updatedAt: scan.updatedAt,
    refreshing: scan.refreshing,
    repricing,
    error: scan.error,
    coverage: {
      discovered: scan.discovered,
      read: conversations.size,
      failed: scan.failed,
      unscanned: scan.unscanned,
      // Date-filtered ranges are partial while any conversation still owes a
      // successful step-time read; all-time totals already include its turns.
      datesPending: [...conversations.values()].filter(
        (conversation) => conversation.stepFingerprint !== conversation.fingerprint,
      ).length,
    },
    ranges: reportedRanges,
    daily: [...daily.values()].map(priced),
    conversations: list,
  };
}

/** Returns cached usage immediately and starts at most one bounded background scan. */
export async function getUsageOverview({ refresh: force = false } = {}) {
  // Damaged persisted prices must not block token metrics: the scan runs with
  // the last verified snapshot (stale) or no prices (unavailable), and the
  // overview reports the pricing state beside the token coverage.
  const latest = readPricingStatus();
  // Only a real price change re-buckets data; losing the price source to
  // damage must not refetch every history — costs are nulled at overview time.
  if (latest.revision !== null && latest.revision !== pricing?.revision) {
    generation += 1;
    controller?.abort();
    inFlight = null;
    lastAttemptAt = null;
  }
  pricing = latest;
  const ttl = scan.status === 'ready' ? CACHE_TTL_MS : FAILURE_TTL_MS;
  if (!inFlight && (force || lastAttemptAt === null || Date.now() - lastAttemptAt >= ttl)) {
    lastAttemptAt = Date.now();
    scan = { ...scan, refreshing: true };
    const pending = refresh(force, pricing.prices, pricing.revision, generation).finally(() => {
      if (inFlight === pending) inFlight = null;
    });
    inFlight = pending;
  }
  return buildOverview(pricing);
}
