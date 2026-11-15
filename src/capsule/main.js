// Capsule bootstrap module — bundled with the lib modules, i18n, styles, and
// host-ui into dist/capsule/input-capsule.js by scripts/capsule-build.mjs.
// Shared helpers are imported from the lib modules and UI attachment from
// host-ui — never redefine them here. This module owns state, listeners, and
// timers; the DOM bootstrap statements live in mountCapsule(), which the
// entry defers until the Host document is ready.

import { limitStatusEntries, normalizeLimitStatus } from '../plugin/lib/limit-status-core.mjs';
import { formatLocaleNumber } from '../plugin/lib/locale.mjs';
import {
  applyExecutorCapacity,
  applyFullResync,
  BUFFER_DEFAULT_TOKENS,
  createSessionAgg,
  emptyGenerationSpeed,
  generatorRefreshOffset,
  mergeGeneratorMetadata,
  metricsFromAgg,
} from '../plugin/lib/metrics-core.mjs';
import { splitModelLabel } from '../plugin/lib/model-label.mjs';
import { nextPollDelayMs, refreshSchedule } from '../plugin/lib/poll-policy.mjs';
import { validateCustomPrices } from '../plugin/lib/pricing-core.mjs';
import {
  LS_RPC_METHODS,
  languageServerRpcPath,
  normalizeExecutorMetadataResponse,
  normalizeGeneratorMetadataResponse,
  normalizeSidecarSnapshotResponse,
  normalizeTrajectorySummariesResponse,
} from '../plugin/lib/upstream-contract.mjs';
import { CAPSULE_ANCHORS } from './anchors.js';
import {
  buildEl,
  CAPSULE_ID,
  ensureCapsuleStyleMounted,
  ensurePopoverMounted,
  ensureTooltipMounted,
  formatUiNumber,
  formatUiTokens,
  formatUiUsd,
  getOpenSubagentCascadeId,
  getRouteCascadeId,
  mountCapsuleSurfaces,
  POPOVER_ID,
  RING_CIRC,
  refreshVisibleTooltip,
  removeMountedCapsuleNodes,
  SUB_CAPSULE_ID,
  TITLEBAR_BTN_ID,
} from './host-ui.js';
import { initializeCapsuleLocale, localeState, t } from './i18n.js';

// Filled at mount time once the Host language is readable (initializeCapsuleLocale).
export let currentLang = null;

// 輪詢節奏：浮卡開啟 3s (即時感) / 背景 5s / 視窗隱藏 15s
const POLL_POPOVER_MS = 3000;
const POLL_BACKGROUND_MS = 5000;
const POLL_HIDDEN_MS = 15000;
// Executor 配置 (容量/自訂項) 極少變動，每會話 2 分鐘拉一次即可
const EXECUTOR_TTL_MS = 120_000;
// 定期全量對帳 (offset=0)，防伺服器端清單縮減 (LS 重啟重建) 造成指標凍結
const FULL_RESYNC_MS = 10 * 60_000;
// 每會話增量聚合與顯示快取的保留上限
const AGG_LIMIT = 10;
const PRICING_TTL_MS = 5000;
const PRICING_DISCOVERY_TTL_MS = 60_000;
let diskLimitSnapshot = null;
let diskLimitAttemptAt = null;
let diskLimitInFlight = null;
let diskLimitController = null;

async function syncDiskLimits(endpoint) {
  if (diskLimitInFlight) return diskLimitInFlight;
  if (diskLimitAttemptAt !== null && Date.now() - diskLimitAttemptAt < 60000) return;
  diskLimitAttemptAt = Date.now();
  const controller = new AbortController();
  diskLimitController = controller;
  const timer = setTimeout(() => controller.abort(), 20000);
  const pending = (async () => {
    try {
      const url = new URL(endpoint);
      url.pathname = url.pathname.replace(/\/api\/pricing$/, '/api/limit-status');
      const response = await fetch(url.href, {
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error(`Limit status HTTP ${response.status}`);
      const snapshot = normalizeLimitStatus(await readBoundedJson(response));
      if (!state.disposed) diskLimitSnapshot = snapshot;
    } catch (error) {
      if (!state.disposed)
        diskLimitSnapshot = {
          status: 'unavailable',
          snapshotAt: new Date().toISOString(),
          error: error.message,
        };
    } finally {
      clearTimeout(timer);
      if (diskLimitController === controller) diskLimitController = null;
      updateDisplay(state);
    }
  })().finally(() => {
    if (diskLimitInFlight === pending) diskLimitInFlight = null;
  });
  diskLimitInFlight = pending;
  return pending;
}
const STORAGE_KEY_COLLAPSES = 'agyctl_sections_collapse';
const customPricing = {
  prices: [],
  revision: null,
  status: 'loading',
  lastAttemptAt: null,
  endpoint: null,
  discoveredAt: 0,
  inFlight: null,
  /** @type {AbortController|null} */
  controller: null,
  dirty: false,
};

// 讀取/儲存收折狀態
function loadCollapseState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_COLLAPSES);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        comp: parsed.comp !== false,
        perf: parsed.perf !== false,
        variants: parsed.variants !== false,
        session: parsed.session !== false,
        limits: parsed.limits === true,
      };
    }
  } catch {}
  return { comp: true, perf: true, variants: true, session: true, limits: false };
}

export function saveCollapseState(s) {
  try {
    localStorage.setItem(STORAGE_KEY_COLLAPSES, JSON.stringify(s));
  } catch {}
}

export const collapseState = loadCollapseState();

// 共享狀態
export const state = {
  cascadeId: null,
  totalUsed: 0,
  capacity: null,
  pct: null,
  input: 0,
  output: 0,
  cache: 0,
  thinking: 0,
  free: null,
  convCacheRate: '0.0',
  modelName: null,
  responseModel: null,
  speed: emptyGenerationSpeed(),
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
    bufferTokens: BUFFER_DEFAULT_TOKENS,
    bufferPct: 10.0,
    freeTokens: 0,
    freePct: 0,
  },
  sessionTotals: {
    requests: 0,
    uncachedTokens: 0,
    uncachedPct: 0,
    cachedTokens: 0,
    cachedPct: 0,
    thinkingTokens: 0,
    thinkingPct: 0,
    outputTokens: 0,
    outputPct: 0,
    totalCostUsd: null,
  },
  modelVariants: [],
  rootId: null,
  /** @type {string|null} */
  selectedAgentId: null,
  agentTree: [],
  metricsByCid: new Map(),
  aggs: new Map(),
  popoverOpen: false,
  /** @type {number|null} */
  pollTimer: null,
  disposed: false,
};

// 創建右上角浮動卡片 (Popover) — host-ui 提供容器與內部按鈕接線。
// 實際 DOM 建立在 mountCapsule() 中執行（需待文件就緒）。
let popoverEl = null;

export function togglePopover() {
  if (state.popoverOpen) {
    closePopover();
  } else {
    openPopover();
  }
}

export function openPopover() {
  const btn = document.getElementById(TITLEBAR_BTN_ID);
  if (!btn || !popoverEl) return;
  const r = btn.getBoundingClientRect();

  if (
    !state.selectedAgentId ||
    (state.agentTree.length && !state.agentTree.some((a) => a.id === state.selectedAgentId))
  ) {
    state.selectedAgentId = getOpenSubagentCascadeId() || state.rootId || getRouteCascadeId();
  }

  popoverEl.style.top = `${r.bottom + 8}px`;
  popoverEl.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  popoverEl.classList.add('visible');
  btn.classList.add('active');
  state.popoverOpen = true;
  treeOnPopover = true;
  renderPopoverContent(state);
  reschedulePoll();
  void pollMetrics();
}

export function closePopover() {
  if (!popoverEl) return;
  popoverEl.classList.remove('visible');
  document.getElementById(TITLEBAR_BTN_ID)?.classList.remove('active');
  state.popoverOpen = false;
  reschedulePoll();
}

// 點擊外部自動收起
function onDocumentPointerDown(ev) {
  if (!state.popoverOpen) return;
  const btn = document.getElementById(TITLEBAR_BTN_ID);
  const subCap = document.getElementById(SUB_CAPSULE_ID);
  const mainCap = document.getElementById(CAPSULE_ID);
  if (
    popoverEl &&
    !popoverEl.contains(ev.target) &&
    !btn?.contains(ev.target) &&
    !subCap?.contains(ev.target) &&
    !mainCap?.contains(ev.target)
  ) {
    closePopover();
  }
}

// 按 Escape 收起
function onDocumentKeyDown(ev) {
  if (ev.key === 'Escape' && state.popoverOpen) {
    closePopover();
  }
}

function applyLanguage(lang) {
  currentLang = lang;

  const dict = t();
  const titleBtn = document.getElementById(TITLEBAR_BTN_ID);
  if (titleBtn) {
    titleBtn.title = dict.titlebarTitle;
    titleBtn.setAttribute('aria-label', dict.titlebarAria);
  }

  if (popoverEl) {
    popoverEl.querySelectorAll('[data-cr-i18n]').forEach((el) => {
      const key = el.getAttribute('data-cr-i18n');
      if (key && typeof dict[key] === 'string') {
        el.textContent = dict[key];
      }
    });
    const langBtn = /** @type {HTMLElement|null} */ (popoverEl.querySelector('#cr-pop-lang'));
    if (langBtn) {
      langBtn.textContent = dict.langBtn;
      langBtn.title = dict.langTitle;
    }
    const closeBtn = /** @type {HTMLElement|null} */ (popoverEl.querySelector('#cr-pop-close'));
    if (closeBtn) {
      closeBtn.title = dict.closeTitle;
      closeBtn.setAttribute('aria-label', dict.closeTitle);
    }
    const switchEl = popoverEl.querySelector('#cr-agent-switch');
    if (switchEl) {
      switchEl.setAttribute('aria-label', dict.agentSwitchAria);
    }
  }

  updateDisplay(state);
  refreshVisibleTooltip();
}

function onWindowMessage(ev) {
  if (!ev.data || typeof ev.data.type !== 'string' || !isTrustedMessagePeer(ev)) return;
  if (
    ev.data.type === 'AGYCTL_PRICING_CHANGED' &&
    typeof ev.data.revision === 'string' &&
    /^[a-f\d]{64}$/.test(ev.data.revision) &&
    (ev.data.revision !== customPricing.revision || customPricing.status !== 'ready')
  ) {
    customPricing.lastAttemptAt = null;
    customPricing.dirty = true;
    customPricing.status = 'refreshing';
    invalidatePricingMetrics();
    void pollMetrics();
  }
}

// ---------------------------------------------------------------------------
// 每會話增量聚合：GetCascadeTrajectoryGeneratorMetadata 支援 offset 增量語義，
// 只拉尾差；會話快取率/模型別名統計在本地滾動累加，承載不再隨會話長度成長。
// ---------------------------------------------------------------------------

function protectedAggIds(extra) {
  return new Set([getRouteCascadeId(), getOpenSubagentCascadeId(), state.selectedAgentId, extra]);
}

function touchMap(map, cid, value) {
  map.delete(cid);
  map.set(cid, value);
}

function evictOldestUnprotected(map, extra) {
  const protectedIds = protectedAggIds(extra);
  for (const k of map.keys()) {
    if (!protectedIds.has(k)) {
      state.metricsByCid.delete(k);
      state.aggs.delete(k);
      return;
    }
  }
}

function getAgg(cid) {
  let agg = state.aggs.get(cid);
  if (!agg) {
    while (state.aggs.size >= AGG_LIMIT) {
      const before = state.aggs.size;
      evictOldestUnprotected(state.aggs, cid);
      if (state.aggs.size === before) break;
    }
    agg = createSessionAgg();
    agg.traceId = cid;
  }
  touchMap(state.aggs, cid, agg);
  return agg;
}

function rememberMetrics(cid, metrics) {
  if (!state.metricsByCid.has(cid)) {
    while (state.metricsByCid.size >= AGG_LIMIT) {
      const before = state.metricsByCid.size;
      evictOldestUnprotected(state.metricsByCid, cid);
      if (state.metricsByCid.size === before) break;
    }
  }
  touchMap(state.metricsByCid, cid, metrics);
}

function capsuleMetricsFromCore(core, targetCid) {
  return {
    cascadeId: targetCid,
    totalUsed: core.totalUsed,
    capacity: core.capacity,
    pct: core.usedPercentage,
    input: core.input,
    output: core.output,
    thinking: core.thinking,
    cache: core.cache,
    free: core.freeTokens,
    convCacheRate: Number(core.sessionCacheRate).toFixed(1),
    isWaitingGen: core.isWaitingGen,
    loading: false,
    modelName: core.modelDisplayName || '',
    responseModel: core.responseModel || core.modelId || '',
    speed: core.speed,
    composition: core.composition,
    sessionTotals: core.sessionTotals,
    modelVariants: core.modelVariants,
  };
}

function loadingMetrics(cid) {
  return {
    cascadeId: cid,
    loading: true,
    totalUsed: null,
    capacity: null,
    pct: null,
    input: 0,
    output: 0,
    thinking: 0,
    cache: 0,
    free: null,
    convCacheRate: '0.0',
    isWaitingGen: true,
    modelName: '',
    responseModel: '',
    speed: emptyGenerationSpeed(),
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
      bufferTokens: BUFFER_DEFAULT_TOKENS,
      bufferPct: 10.0,
      freeTokens: null,
      freePct: null,
    },
    sessionTotals: {
      requests: 0,
      uncachedTokens: 0,
      uncachedPct: 0,
      cachedTokens: 0,
      cachedPct: 0,
      thinkingTokens: 0,
      thinkingPct: 0,
      outputTokens: 0,
      outputPct: 0,
      totalCostUsd: null,
    },
    modelVariants: [],
  };
}

let requestGeneration = 0;
const rpcControllers = new Set();
const metricsInFlight = new Map();

function isCurrent(generation) {
  return !state.disposed && generation === requestGeneration;
}

function cancelRequests() {
  requestGeneration += 1;
  for (const controller of rpcControllers) controller.abort();
  rpcControllers.clear();
}

function invalidatePricingMetrics() {
  cancelRequests();
  state.aggs.clear();
  state.metricsByCid.clear();
  state.sessionTotals = { ...state.sessionTotals, totalCostUsd: null };
  updateDisplay(state);
}

// The sidecar panel is the only cross-frame peer: its origin is the loopback
// origin discovered from the same sidecar snapshot that prices are fetched
// from. The other capsule instance shares this window and identifies itself
// as ev.source === window. Unknown origins never receive session identity;
// the host-app frame's own origin stays unresolved until the SDK contract is
// verified, so nothing is sent or accepted from it.
let sidecarOrigin = null;

function isTrustedMessagePeer(ev) {
  if (ev.source === window) return true;
  return typeof sidecarOrigin === 'string' && ev.origin === sidecarOrigin;
}

async function discoverPricingEndpoint(csrf, signal) {
  const response = await fetch(languageServerRpcPath(LS_RPC_METHODS.subscribeSidecars), {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/connect+json',
      'Connect-Protocol-Version': '1',
      'x-codeium-csrf-token': csrf,
    },
    body: new Uint8Array([0, 0, 0, 0, 2, 123, 125]),
  });
  if (
    !response.ok ||
    !response.headers.get('content-type')?.startsWith('application/connect+json')
  ) {
    throw new Error('Sidecar discovery unavailable');
  }
  const reader = response.body.getReader();
  let buffer = new Uint8Array();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error('Sidecar discovery ended without a snapshot');
      const combined = new Uint8Array(buffer.length + value.length);
      combined.set(buffer);
      combined.set(value, buffer.length);
      buffer = combined;
      if (buffer.length < 5) continue;
      const length = new DataView(buffer.buffer).getUint32(1);
      if (length > 1024 * 1024) throw new Error('Sidecar discovery snapshot is too large');
      if (buffer.length < length + 5) continue;
      if (buffer[0] !== 0) throw new Error('Unsupported sidecar discovery envelope');
      const snapshot = JSON.parse(new TextDecoder().decode(buffer.subarray(5, length + 5)));
      const sidecar = normalizeSidecarSnapshotResponse(snapshot);
      if (!sidecar?.baseUrl) throw new Error('agyctl sidecar is unavailable');
      const url = new URL(sidecar.baseUrl);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error('Invalid agyctl sidecar address');
      }
      url.pathname = url.pathname.replace(/\/$/, '') + '/api/pricing';
      sidecarOrigin = url.origin;
      return url.href;
    }
  } finally {
    await reader.cancel();
  }
}

async function syncPricing(csrf) {
  if (customPricing.inFlight) return customPricing.inFlight;
  if (
    customPricing.lastAttemptAt !== null &&
    Date.now() - customPricing.lastAttemptAt < PRICING_TTL_MS
  )
    return;
  customPricing.lastAttemptAt = Date.now();
  customPricing.dirty = false;
  const controller = new AbortController();
  customPricing.controller = controller;
  const timer = setTimeout(() => controller.abort(), 4000);
  const pending = (async () => {
    try {
      if (
        !customPricing.endpoint ||
        Date.now() - customPricing.discoveredAt >= PRICING_DISCOVERY_TTL_MS
      ) {
        customPricing.endpoint = null;
        customPricing.endpoint = await discoverPricingEndpoint(csrf, controller.signal);
        customPricing.discoveredAt = Date.now();
      }
      void syncDiskLimits(customPricing.endpoint);
      const response = await fetch(customPricing.endpoint, {
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      if (!response.ok) throw new Error('Pricing query failed');
      const result = await readBoundedJson(response);
      if (result.error || !/^[a-f\d]{64}$/.test(result.revision || ''))
        throw new Error('Saved pricing unavailable');
      const prices = validateCustomPrices(result.prices);
      if (state.disposed || customPricing.dirty) return;
      const changed = customPricing.revision !== result.revision;
      customPricing.prices = prices;
      customPricing.revision = result.revision;
      customPricing.status = result.pricingDamaged ? 'stale' : 'ready';
      if (changed) {
        invalidatePricingMetrics();
        void pollMetrics();
      }
    } catch (error) {
      if (state.disposed || customPricing.dirty) return;
      if (!customPricing.endpoint)
        diskLimitSnapshot = {
          status: 'unavailable',
          snapshotAt: new Date().toISOString(),
          error: error.message,
        };
      customPricing.endpoint = null;
      customPricing.status = customPricing.revision ? 'stale' : 'unavailable';
    } finally {
      clearTimeout(timer);
      if (customPricing.controller === controller) customPricing.controller = null;
      updateDisplay(state);
    }
  })().finally(() => {
    if (customPricing.inFlight === pending) customPricing.inFlight = null;
    if (customPricing.dirty && !state.disposed) void pollMetrics();
  });
  customPricing.inFlight = pending;
  return pending;
}

// Node transport caps Language Server responses at 8 MiB; the capsule enforces
// the same budget so an upstream change cannot buffer without bound in the page.
const RPC_MAX_BYTES = 8 * 1024 * 1024;

async function readBoundedJson(res) {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('RPC response body unavailable');
  try {
    const declared = Number(res.headers.get('content-length'));
    if (declared > RPC_MAX_BYTES) {
      await reader.cancel();
      throw new Error(`RPC response exceeded the ${RPC_MAX_BYTES}-byte limit`);
    }
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > RPC_MAX_BYTES) {
        await reader.cancel();
        throw new Error(`RPC response exceeded the ${RPC_MAX_BYTES}-byte limit`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    reader.releaseLock();
  }
}

async function rpc(method, payload, csrf, generation) {
  if (!isCurrent(generation)) throw new Error('Obsolete telemetry request');
  const controller = new AbortController();
  rpcControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), 8000);
  let onAbort;
  try {
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new Error('Telemetry request cancelled or timed out'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([
      (async () => {
        const res = await fetch(languageServerRpcPath(method), {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrf,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
        return readBoundedJson(res);
      })(),
      cancelled,
    ]);
    if (!isCurrent(generation)) throw new Error('Obsolete telemetry request');
    return result;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
    rpcControllers.delete(controller);
  }
}

function fetchCascadeMetrics(targetCid, csrf, generation) {
  const pending = metricsInFlight.get(targetCid);
  if (pending?.generation === generation) return pending.promise;
  const promise = fetchCascadeMetricsOnce(targetCid, csrf, generation).finally(() => {
    if (metricsInFlight.get(targetCid)?.promise === promise) metricsInFlight.delete(targetCid);
  });
  metricsInFlight.set(targetCid, { generation, promise });
  return promise;
}

async function fetchCascadeMetricsOnce(targetCid, csrf, generation) {
  const prices = customPricing.prices;
  let agg = getAgg(targetCid);
  const now = Date.now();
  const { executorDue: needExec, fullResync } = refreshSchedule(agg, now, {
    executorTtlMs: EXECUTOR_TTL_MS,
    fullResyncMs: FULL_RESYNC_MS,
  });
  if (needExec) {
    agg.lastExecAttempt = now;
    void rpc(
      LS_RPC_METHODS.executorMetadatas,
      {
        cascadeId: targetCid,
        executorMetadataOffset: 0,
      },
      csrf,
      generation,
    )
      .then((execRes) => {
        if (!isCurrent(generation)) return;
        const current = state.aggs.get(targetCid);
        if (!current) return;
        const confirmed = applyExecutorCapacity(
          current,
          normalizeExecutorMetadataResponse(execRes),
          Date.now(),
        );
        current.executorError = confirmed ? null : 'No checkpoint capacity in executor metadata';
      })
      .catch((err) => {
        if (isCurrent(generation)) agg.executorError = err.message;
      });
  }
  try {
    const offset = fullResync ? 0 : generatorRefreshOffset(agg);
    const genRes = await rpc(
      LS_RPC_METHODS.generatorMetadata,
      {
        cascadeId: targetCid,
        generatorMetadataOffset: offset,
        includeMessages: false,
      },
      csrf,
      generation,
    );
    if (!isCurrent(generation)) return null;
    const entries = normalizeGeneratorMetadataResponse(genRes);
    if (fullResync) {
      agg = applyFullResync(agg, entries, prices);
      agg.lastResyncAt = now;
      touchMap(state.aggs, targetCid, agg);
    } else {
      mergeGeneratorMetadata(agg, entries, prices, offset);
    }
    agg.generatorUpdatedAt = new Date().toISOString();
    return {
      ...capsuleMetricsFromCore(metricsFromAgg(agg, { conversationId: targetCid }), targetCid),
      status: 'live_rpc',
      updatedAt: agg.generatorUpdatedAt,
      capacitySource: agg.capacity
        ? agg.executorError
          ? 'checkpoint_stale'
          : 'checkpoint'
        : 'unknown',
      capacityError: agg.executorError,
      capacityAttemptedAt:
        agg.lastExecAttempt === null ? null : new Date(agg.lastExecAttempt).toISOString(),
      capacityUpdatedAt: agg.lastExecFetch ? new Date(agg.lastExecFetch).toISOString() : null,
    };
  } catch (err) {
    if (!isCurrent(generation)) return null;
    const cached = state.metricsByCid.get(targetCid);
    return {
      ...(cached || loadingMetrics(targetCid)),
      loading: false,
      status: cached ? 'stale_rpc' : 'error',
      warning: err.message,
      updatedAt: cached?.updatedAt || null,
      lastErrorAt: new Date().toISOString(),
    };
  }
}

async function discoverAgentTree(routeCid, csrf, generation) {
  try {
    const res = await rpc(LS_RPC_METHODS.allTrajectories, {}, csrf, generation);
    if (!isCurrent(generation)) return;
    const summaries = normalizeTrajectorySummariesResponse(res);

    const routeSummary = summaries[routeCid];
    const rootId = routeSummary?.trajectoryMetadata?.rootConversationId || routeCid;
    const prevRootId = state.rootId;

    const rootItem = {
      id: rootId,
      label: '',
      role: '',
      typeName: 'root',
      isRoot: true,
      status: summaries[rootId]?.status || 'CASCADE_RUN_STATUS_IDLE',
      createdTime: summaries[rootId]?.createdTime || '',
    };

    const subItems = [];
    for (const [id, s] of Object.entries(summaries)) {
      if (id === rootId) continue;
      const meta = s?.trajectoryMetadata;
      if (meta?.rootConversationId === rootId || meta?.parentConversationId === rootId) {
        const spec = meta?.subagentSpec || {};
        const role =
          spec.role || s?.annotations?.title || spec.typeName || meta?.agentScript?.name || '';
        const typeName = spec.typeName || meta?.agentScript?.name || '';
        subItems.push({
          id,
          label: role,
          role,
          typeName,
          isRoot: false,
          status: s?.status || 'CASCADE_RUN_STATUS_IDLE',
          createdTime: s?.createdTime || '',
        });
      }
    }

    subItems.sort((a, b) => String(a.createdTime).localeCompare(String(b.createdTime)));
    if (!isCurrent(generation) || getRouteCascadeId() !== routeCid) return;
    state.rootId = rootId;
    state.agentTree = [rootItem, ...subItems];

    if (
      prevRootId !== rootId ||
      !state.selectedAgentId ||
      !state.agentTree.some((a) => a.id === state.selectedAgentId)
    ) {
      const openSub = getOpenSubagentCascadeId();
      state.selectedAgentId =
        openSub && state.agentTree.some((a) => a.id === openSub) ? openSub : routeCid;
    }
    state.treeError = null;
    if (state.popoverOpen) renderPopoverContent(state);
  } catch (err) {
    if (isCurrent(generation)) state.treeError = err.message;
  }
}

let pollInFlight = false;
let pollPending = false;
let lastTreeCid = null;
let lastTreeAt = 0;
let treeOnPopover = false;
const TREE_TTL_MS = 30_000;

function showCachedOrLoading(cid) {
  const cached = cid ? state.metricsByCid.get(cid) : null;
  const shown = cached || loadingMetrics(cid);
  Object.assign(state, shown);
  updateDisplay(shown);
}

export async function pollMetrics() {
  if (state.disposed) return;
  if (pollInFlight) {
    pollPending = true;
    return;
  }
  pollInFlight = true;
  try {
    do {
      pollPending = false;
      const csrf = /** @type {any} */ (window).__APP_CONFIG__?.csrfToken;
      if (csrf) void syncPricing(csrf);
      const generation = requestGeneration;
      const cid = getRouteCascadeId();
      if (!cid) {
        updateDisplay(null);
        continue;
      }

      if (!csrf) {
        const unavailable = {
          ...(state.metricsByCid.get(cid) || loadingMetrics(cid)),
          status: 'error',
          warning: 'Missing CSRF token',
          lastErrorAt: new Date().toISOString(),
        };
        Object.assign(state, unavailable);
        updateDisplay(unavailable);
        continue;
      }

      const now = Date.now();
      const openSubCid = getOpenSubagentCascadeId();
      const needTree =
        cid !== lastTreeCid ||
        treeOnPopover ||
        (!document.hidden && (state.popoverOpen || openSubCid) && now - lastTreeAt >= TREE_TTL_MS);
      treeOnPopover = false;
      if (needTree) {
        lastTreeCid = cid;
        lastTreeAt = now;
        void discoverAgentTree(cid, csrf, generation);
      }

      const targets = new Set([cid]);
      if (openSubCid) targets.add(openSubCid);
      if (state.popoverOpen && state.selectedAgentId) {
        targets.add(state.selectedAgentId);
      }

      const results = await Promise.all(
        Array.from(targets).map((id) => fetchCascadeMetrics(id, csrf, generation)),
      );
      if (!isCurrent(generation)) continue;

      for (const m of results) {
        if (m?.cascadeId) {
          rememberMetrics(m.cascadeId, m);
        }
      }

      if (getRouteCascadeId() !== cid) continue;

      const mainMetrics = state.metricsByCid.get(cid);
      if (mainMetrics) {
        Object.assign(state, mainMetrics);
      }

      updateDisplay(state);
    } while (pollPending && !state.disposed);
  } catch (err) {
    if (!state.disposed) console.warn('[agyctl] Polling failed:', err.message);
  } finally {
    pollInFlight = false;
    if (pollPending && !state.disposed) {
      pollPending = false;
      void pollMetrics();
    }
  }
}

function updateCapsuleRing(capsuleEl, metrics) {
  if (!capsuleEl) return;
  if (!metrics?.cascadeId || metrics.loading || metrics.pct == null) {
    capsuleEl.querySelector('.cr-text').textContent = '—%';
    capsuleEl.querySelector('.cr-ring-val').style.strokeDashoffset = String(RING_CIRC);
    return;
  }
  const pctNum = Math.min(100, Math.max(0, metrics.pct || 0));
  const offset = RING_CIRC * (1 - pctNum / 100);

  capsuleEl.querySelector('.cr-text').textContent = formatUiNumber(pctNum) + '%';
  const ring = capsuleEl.querySelector('.cr-ring-val');
  ring.style.strokeDashoffset = String(offset);
  ring.style.stroke = 'var(--accent, var(--primary, #2F71E3))';
}

function updateDisplay(st) {
  if (state.disposed) return;
  const surfaces = mountCapsuleSurfaces();
  refreshVisibleTooltip();

  updateCapsuleRing(surfaces.capsule, st);

  if (surfaces.subCapsule) {
    const subCid = getOpenSubagentCascadeId();
    const subMetrics = subCid ? state.metricsByCid.get(subCid) : null;
    updateCapsuleRing(surfaces.subCapsule, subMetrics);
  }

  // 更新浮動卡片 (若已展開)
  if (state.popoverOpen) {
    renderPopoverContent(st);
  }
}

export function renderPopoverContent(fallbackSt) {
  if (!popoverEl || state.disposed) return;
  /** @type {(id: string) => HTMLElement|null} */
  const $ = (id) => /** @type {HTMLElement|null} */ (popoverEl.querySelector('#' + id));
  const dict = t();
  const limits = limitStatusEntries(diskLimitSnapshot, dict);
  const limitsSum = $('cr-sum-limits');
  if (limitsSum)
    limitsSum.textContent =
      limits.kind === 'patched' ? dict.limitsModels(limits.rows.length) : limits.statusText;
  const limitsStatus = $('cr-limits-status');
  if (limitsStatus) limitsStatus.textContent = limits.statusText;
  const limitsList = $('cr-limits-list');
  const limitsKey = JSON.stringify([
    currentLang,
    limits.rows.map((row) => [row.id, row.name, row.effort, row.limit]),
  ]);
  if (limitsList && limitsList.dataset.renderKey !== limitsKey) {
    limitsList.dataset.renderKey = limitsKey;
    limitsList.textContent = '';
    for (const row of limits.rows) {
      const line = buildEl('div', 'cr-crow cr-limits-row');
      const left = buildEl('div', 'cr-cleft');
      left.append(buildEl('span', 'cr-vname', row.name));
      if (row.effort) left.append(buildEl('span', 'cr-effort-badge', row.effort));
      line.append(left, buildEl('div', 'cr-cright', formatLocaleNumber(row.limit, currentLang)));
      limitsList.appendChild(line);
    }
  }

  const activeId =
    state.selectedAgentId && state.agentTree.some((a) => a.id === state.selectedAgentId)
      ? state.selectedAgentId
      : state.cascadeId || fallbackSt?.cascadeId;

  const cached = activeId ? state.metricsByCid.get(activeId) : null;
  const st = cached || (activeId ? loadingMetrics(activeId) : fallbackSt || state);

  // 渲染頂部代理切換選單 (僅在有子代理時顯示) — 以 DOM API 建構，代理名稱不經 HTML
  const switchEl = $('cr-agent-switch');
  const agentKey = JSON.stringify([
    currentLang,
    state.agentTree.map((a) => [a.id, a.label, a.role, a.isRoot]),
  ]);
  if (switchEl && switchEl.dataset.renderKey !== agentKey) {
    switchEl.dataset.renderKey = agentKey;
    switchEl.textContent = '';
    if (state.agentTree && state.agentTree.length > 1) {
      switchEl.classList.add('visible');
      for (const a of state.agentTree) {
        const isActive = a.id === activeId;
        const isRunning = a.status === 'CASCADE_RUN_STATUS_RUNNING';
        const btn = buildEl('button', `cr-agent-pill${isActive ? ' active' : ''}`);
        btn.type = 'button';
        btn.setAttribute('data-agent-id', a.id);
        btn.title = a.isRoot ? dict.rootAgent : a.role || dict.subAgent;
        btn.append(
          buildEl('span', `cr-agent-pill-dot${isRunning ? ' running' : ''}`),
          buildEl(
            'span',
            'cr-agent-pill-lbl',
            a.isRoot ? dict.rootAgent : a.label || dict.subAgent,
          ),
        );
        switchEl.appendChild(btn);
      }
    } else {
      switchEl.classList.remove('visible');
    }
  }
  if (switchEl) {
    for (const button of switchEl.querySelectorAll('[data-agent-id]')) {
      const agent = state.agentTree.find((a) => a.id === button.getAttribute('data-agent-id'));
      button.classList.toggle('active', agent?.id === activeId);
      button
        .querySelector('.cr-agent-pill-dot')
        ?.classList.toggle('running', agent?.status === 'CASCADE_RUN_STATUS_RUNNING');
    }
  }

  // 模型標題（模型名與思考強度分開顯示）
  const modelLabel = st.isWaitingGen
    ? dict.waitingGen
    : st.modelName || st.responseModel || dict.unknownModel;
  const modelParts = splitModelLabel(modelLabel);
  $('cr-pop-model').textContent = modelParts.base || modelLabel;
  const effortBadge = $('cr-pop-effort');
  if (effortBadge) {
    effortBadge.textContent = modelParts.effort
      ? modelParts.effort[0].toUpperCase() + modelParts.effort.slice(1)
      : '';
    effortBadge.hidden = !modelParts.effort;
  }

  // === 區塊 1: 背景資訊摘要與內容 ===
  const compUsedPctText = st.pct == null ? '—' : `${formatUiNumber(st.pct)}%`;
  const compUsedRatioText = `${formatUiTokens(st.totalUsed)} / ${formatUiTokens(st.capacity)}`;
  $('cr-comp-used-pct').textContent = compUsedPctText;
  $('cr-comp-used-ratio').textContent = compUsedRatioText;
  $('cr-sum-comp').textContent = `${compUsedPctText} · ${compUsedRatioText}`;
  const metadataStatus = [
    st.status || 'unknown',
    st.updatedAt,
    st.capacitySource,
    st.warning,
    st.capacityError,
    state.treeError,
  ]
    .filter(Boolean)
    .join(' · ');
  $('cr-sum-comp').title = metadataStatus;
  $('cr-pop-model').title = metadataStatus;

  const comp = st.composition || {};
  const formatPct = (value) => (value == null ? '—' : formatUiNumber(value) + '%');
  $('cr-cbar-msg').style.width = (comp.messagesPct ?? 0) + '%';
  $('cr-cbar-mcp').style.width = (comp.mcpToolsPct ?? 0) + '%';
  $('cr-cbar-systools').style.width = (comp.systemToolsPct ?? 0) + '%';
  $('cr-cbar-sysprompt').style.width = (comp.systemPromptPct ?? 0) + '%';
  $('cr-cbar-skills').style.width = (comp.skillsPct ?? 0) + '%';
  $('cr-cbar-mem').style.width = (comp.memoryPct ?? 0) + '%';
  $('cr-cbar-buffer').style.width = (comp.bufferPct ?? 10) + '%';

  $('cr-val-msg').textContent = formatUiTokens(comp.messagesTokens);
  $('cr-pct-msg').textContent = formatPct(comp.messagesPct);

  $('cr-val-mcp').textContent = formatUiTokens(comp.mcpToolsTokens);
  $('cr-pct-mcp').textContent = formatPct(comp.mcpToolsPct);

  $('cr-val-systools').textContent = formatUiTokens(comp.systemToolsTokens);
  $('cr-pct-systools').textContent = formatPct(comp.systemToolsPct);

  $('cr-val-sysprompt').textContent = formatUiTokens(comp.systemPromptTokens);
  $('cr-pct-sysprompt').textContent = formatPct(comp.systemPromptPct);

  $('cr-val-skills').textContent = formatUiTokens(comp.skillsTokens);
  $('cr-pct-skills').textContent = formatPct(comp.skillsPct);

  $('cr-val-mem').textContent = formatUiTokens(comp.memoryTokens);
  $('cr-pct-mem').textContent = formatPct(comp.memoryPct);

  $('cr-val-buffer').textContent = formatUiTokens(comp.bufferTokens);
  $('cr-pct-buffer').textContent = formatPct(comp.bufferPct);

  $('cr-val-free').textContent = formatUiTokens(comp.freeTokens);
  $('cr-pct-free').textContent = formatPct(comp.freePct);

  // === 區塊 2: 輸出資訊摘要與內容 ===
  const sp = st.speed || {};
  const fmtMetric = (val, unit) =>
    val !== null && val !== undefined && val !== ''
      ? `${val}<span class="cr-perf-unit">${unit}</span>`
      : '—';
  const pending = !sp.latestComplete;
  const markPending = (el, value) => {
    const unconfirmed = pending && value !== null && value !== undefined;
    el.classList.toggle('cr-perf-pending', unconfirmed);
    return unconfirmed;
  };
  const rateCell = (id, tps, lowConfidence, title, latest = true) => {
    const el = $(id);
    const low = Boolean(lowConfidence) && tps != null;
    el.innerHTML = fmtMetric(tps == null ? null : formatUiNumber(tps), 'tok/s');
    el.classList.toggle('cr-perf-low', low);
    const unconfirmed = latest && markPending(el, tps);
    el.title = [title, low ? dict.tipLowConfidence : '', unconfirmed ? dict.tipPending : '']
      .filter(Boolean)
      .join('\n');
  };
  rateCell('cr-pop-tps', sp.streamingTps, sp.streamingLowConfidence, dict.tipStreamRate);
  rateCell('cr-pop-overall-tps', sp.overallTps, sp.overallLowConfidence, dict.tipOverallRate);
  const recent = sp.recent || {};
  const recentText = (summary) =>
    summary
      ? dict.recentSample(
          formatUiNumber(summary.tps),
          formatUiNumber(summary.samples, 0),
          formatUiNumber(summary.seconds),
        )
      : dict.recentNone;
  rateCell(
    'cr-pop-recent-tps',
    recent.stream?.tps ?? null,
    recent.stream?.lowConfidence,
    dict.tipRecent(
      recent.model || dict.unknownModel,
      recentText(recent.stream),
      recentText(recent.overall),
    ),
    false,
  );
  const tpsText =
    sp.streamingTps !== null && sp.streamingTps !== undefined
      ? `${formatUiNumber(sp.streamingTps)} tok/s`
      : '—';
  const ttftText =
    sp.ttftSec !== null && sp.ttftSec !== undefined ? `${formatUiNumber(sp.ttftSec)}s` : '—';
  const ttftEl = $('cr-pop-ttft');
  ttftEl.innerHTML = fmtMetric(sp.ttftSec == null ? null : formatUiNumber(sp.ttftSec), 's');
  ttftEl.title = markPending(ttftEl, sp.ttftSec) ? dict.tipPending : '';
  const durEl = $('cr-pop-duration');
  durEl.innerHTML = fmtMetric(
    sp.generationSec == null ? null : formatUiNumber(sp.generationSec),
    's',
  );
  durEl.title = [
    dict.durationTitle(
      sp.ttftSec == null ? null : formatUiNumber(sp.ttftSec),
      sp.streamingDurationSec == null ? null : formatUiNumber(sp.streamingDurationSec),
    ),
    markPending(durEl, sp.generationSec) ? dict.tipPending : '',
  ]
    .filter(Boolean)
    .join('\n');
  $('cr-pop-out-tok').innerHTML = fmtMetric(
    st.isWaitingGen === false ? formatUiTokens(st.output) : null,
    'tok',
  );
  const anyLatest = [sp.streamingTps, sp.ttftSec].some(
    (value) => value !== null && value !== undefined,
  );
  $('cr-sum-perf').textContent = [tpsText, ttftText, pending && anyLatest ? dict.pendingShort : '']
    .filter(Boolean)
    .join(' · ');

  // === 區塊 3: 模型別名摘要與內容 — 以 DOM API 建構，別名不經 HTML ===
  const vars = st.modelVariants || [];
  const varParts = vars.map((v) => splitModelLabel(v.name));
  const vlistEl = $('cr-variant-list');
  const varColors = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ec4899'];
  const variantsKey = JSON.stringify([currentLang, vars.map((v) => v.name)]);
  const variantLabel = (index) => {
    const parts = varParts[index];
    return parts.effort
      ? `${parts.base} · ${parts.effort[0].toUpperCase() + parts.effort.slice(1)}`
      : parts.base || vars[index].name;
  };
  if (vlistEl && vlistEl.dataset.renderKey !== variantsKey) {
    vlistEl.dataset.renderKey = variantsKey;
    vlistEl.textContent = '';
    if (!vars.length) {
      const row = buildEl('div', 'cr-vrow');
      row.append(buildEl('span', 'cr-vname', dict.singleModel));
      vlistEl.appendChild(row);
      $('cr-sum-var').textContent = dict.oneModelSum;
    } else {
      $('cr-sum-var').textContent =
        `${variantLabel(0)} · ${formatUiNumber(vars[0].percentage, 0)}%`;
      vars.forEach((v, idx) => {
        const row = buildEl('div', 'cr-vrow');
        const left = buildEl('div', 'cr-vleft');
        const sq = buildEl('span', 'cr-csq');
        sq.style.background = varColors[idx % varColors.length];
        left.append(sq, buildEl('span', 'cr-vname', variantLabel(idx)));
        const right = buildEl('div', 'cr-vright');
        right.append(
          buildEl('span', 'cr-vcount', dict.variantCount(formatUiNumber(v.count, 0))),
          buildEl('span', 'cr-vpct', `${formatUiNumber(v.percentage)}%`),
        );
        row.append(left, right);
        vlistEl.appendChild(row);
      });
    }
  }
  if (vlistEl && vars.length) {
    $('cr-sum-var').textContent = `${variantLabel(0)} · ${formatUiNumber(vars[0].percentage, 0)}%`;
    vars.forEach((v, idx) => {
      const row = vlistEl.children[idx];
      row.querySelector('.cr-vcount').textContent = dict.variantCount(formatUiNumber(v.count, 0));
      row.querySelector('.cr-vpct').textContent = `${formatUiNumber(v.percentage)}%`;
    });
  }

  // === 區塊 4: 會話累計摘要與內容 ===
  const sess = st.sessionTotals || {};
  const reqCnt = sess.requests ?? 0;
  const costAvailable =
    customPricing.revision && !customPricing.dirty && customPricing.status !== 'refreshing';
  const pricingNote =
    customPricing.status === 'ready'
      ? ''
      : customPricing.status === 'stale'
        ? dict.pricingStale
        : customPricing.status === 'refreshing' || customPricing.status === 'loading'
          ? dict.pricingLoading
          : dict.pricingUnavailable;
  const costText = [formatUiUsd(costAvailable ? sess.totalCostUsd : null), pricingNote]
    .filter(Boolean)
    .join(' · ');
  $('cr-sess-req-cnt').textContent = formatLocaleNumber(reqCnt, currentLang);
  $('cr-sess-cost').textContent = costText;
  $('cr-sum-sess').textContent =
    `${formatLocaleNumber(reqCnt, currentLang)} ${dict.sessRequests} · ${costText}`;

  $('cr-sbar-uncached').style.width = (sess.uncachedPct ?? 0) + '%';
  $('cr-sbar-cached').style.width = (sess.cachedPct ?? 0) + '%';
  $('cr-sbar-thinking').style.width = (sess.thinkingPct ?? 0) + '%';
  $('cr-sbar-output').style.width = (sess.outputPct ?? 0) + '%';

  $('cr-val-s-uncached').textContent = formatUiTokens(sess.uncachedTokens ?? 0);
  $('cr-pct-s-uncached').textContent = formatUiNumber(sess.uncachedPct ?? 0) + '%';

  $('cr-val-s-cached').textContent = formatUiTokens(sess.cachedTokens ?? 0);
  $('cr-pct-s-cached').textContent = formatUiNumber(sess.cachedPct ?? 0) + '%';

  $('cr-val-s-thinking').textContent = formatUiTokens(sess.thinkingTokens ?? 0);
  $('cr-pct-s-thinking').textContent = formatUiNumber(sess.thinkingPct ?? 0) + '%';

  $('cr-val-s-output').textContent = formatUiTokens(sess.outputTokens ?? 0);
  $('cr-pct-s-output').textContent = formatUiNumber(sess.outputPct ?? 0) + '%';
}

function tick() {
  mountCapsuleSurfaces();
  void pollMetrics();
}

// 自適應輪詢：浮卡開啟 3s、背景 5s、視窗隱藏 15s；鏈式 setTimeout 取代固定 interval
function nextPollDelay() {
  return nextPollDelayMs({
    popoverOpen: state.popoverOpen,
    documentHidden: document.hidden,
    base: { openMs: POLL_POPOVER_MS, backgroundMs: POLL_BACKGROUND_MS, hiddenMs: POLL_HIDDEN_MS },
  });
}

function tickAndReschedule() {
  if (state.disposed) return;
  tick();
  state.pollTimer = setTimeout(tickAndReschedule, nextPollDelay());
}

// 外部 (如開關浮卡) 要求立即按新節奏重排
function reschedulePoll() {
  if (state.disposed) return;
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(tickAndReschedule, nextPollDelay());
}

function onVisibilityChange() {
  if (!document.hidden && !state.disposed) {
    reschedulePoll();
    void pollMetrics();
  }
}

let lastKnownRouteCid = null;
let lastKnownSubCid = null;
const origPushState = history.pushState.bind(history);
const origReplaceState = history.replaceState.bind(history);
let historyWrapped = false;

function onSessionSwitch() {
  if (state.disposed) return;
  const cid = getRouteCascadeId();
  const subCid = getOpenSubagentCascadeId();
  const routeChanged = cid !== lastKnownRouteCid;
  const subChanged = subCid !== lastKnownSubCid;
  if (!routeChanged && !subChanged) return;
  cancelRequests();
  lastKnownRouteCid = cid;
  lastKnownSubCid = subCid;
  if (routeChanged) {
    state.selectedAgentId = subCid || cid;
    state.agentTree = [];
  } else if (subCid) {
    state.selectedAgentId = subCid;
  }
  if (cid) {
    showCachedOrLoading(cid);
  } else {
    Object.assign(state, loadingMetrics(null));
    updateDisplay(null);
  }
  void pollMetrics();
}

function wrapHistory() {
  if (historyWrapped) return;
  historyWrapped = true;
  history.pushState = (...args) => {
    origPushState(...args);
    onSessionSwitch();
  };
  history.replaceState = (...args) => {
    origReplaceState(...args);
    onSessionSwitch();
  };
}

function unwrapHistory() {
  if (!historyWrapped) return;
  history.pushState = origPushState;
  history.replaceState = origReplaceState;
  historyWrapped = false;
}

/**
 * DOM bootstrap, previously the straight-line tail of the assembled capsule.
 * The entry defers this until the Host document has a head and is ready, so
 * every statement here may touch the DOM.
 */
export function mountCapsule() {
  // Locale first: the mount functions below render locale text immediately.
  initializeCapsuleLocale();
  currentLang = localeState.locale;

  const wasPopoverOpen = Boolean(
    document.getElementById(POPOVER_ID)?.classList.contains('visible'),
  );

  // 避免重複初始化
  const existingCapsule = window.__AGYCTL_CAPSULE__;
  if (existingCapsule) {
    try {
      existingCapsule.dispose();
    } catch {}
  }

  // 注入 Antigravity 原生風格樣式
  ensureCapsuleStyleMounted();

  // 創建底部懸浮提示 DOM
  ensureTooltipMounted();

  // 創建右上角浮動卡片 (Popover)
  popoverEl = ensurePopoverMounted();

  lastKnownRouteCid = getRouteCascadeId();
  lastKnownSubCid = getOpenSubagentCascadeId();

  const stopLocaleSubscription = localeState.subscribe(applyLanguage);
  applyLanguage(localeState.locale);

  if (typeof navigation !== 'undefined' && typeof navigation.addEventListener === 'function') {
    navigation.addEventListener('currententrychange', onSessionSwitch);
  } else {
    wrapHistory();
    window.addEventListener('popstate', onSessionSwitch);
  }

  let sessionSwitchQueued = false;
  const subagentObserver = new MutationObserver((records) => {
    if (state.disposed || sessionSwitchQueued) return;
    const relevant = records.some((record) => {
      const target = record.target instanceof Element ? record.target : null;
      if (!target) return false;
      if (record.type === 'attributes') return target.matches(CAPSULE_ANCHORS.subagentTab);
      if (target.closest?.(CAPSULE_ANCHORS.capsuleOwned)) return false;
      return [...record.addedNodes, ...record.removedNodes].some((node) =>
        node instanceof Element
          ? node.matches(CAPSULE_ANCHORS.subagentTab) ||
            node.querySelector(CAPSULE_ANCHORS.subagentTab) !== null
          : false,
      );
    });
    if (!relevant) return;
    sessionSwitchQueued = true;
    queueMicrotask(() => {
      sessionSwitchQueued = false;
      if (!state.disposed) onSessionSwitch();
    });
  });
  subagentObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-cascade-id'],
  });

  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('message', onWindowMessage);

  tick();
  if (wasPopoverOpen) {
    openPopover();
  }
  state.pollTimer = setTimeout(tickAndReschedule, nextPollDelay());

  window.__AGYCTL_CAPSULE__ = {
    dispose: () => {
      state.disposed = true;
      cancelRequests();
      customPricing.controller?.abort();
      diskLimitController?.abort();
      clearTimeout(state.pollTimer);
      subagentObserver.disconnect();
      if (
        typeof navigation !== 'undefined' &&
        typeof navigation.removeEventListener === 'function'
      ) {
        navigation.removeEventListener('currententrychange', onSessionSwitch);
      } else {
        unwrapHistory();
        window.removeEventListener('popstate', onSessionSwitch);
      }
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('message', onWindowMessage);
      stopLocaleSubscription();
      removeMountedCapsuleNodes();
      delete window.__AGYCTL_CAPSULE__;
    },
  };
}
