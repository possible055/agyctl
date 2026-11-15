// Capsule host-UI module — evaluated before main.js, which imports the mount
// functions below. Owns everything about where the UI attaches: element ids,
// host anchors, route accessors, and the mount/teardown functions.
// Declarations and functions only; main.js owns state, listeners, DOM timing,
// and timers, so this module's bindings to main.js are resolved lazily from
// event handlers and never at module-evaluation time.

import { formatLocaleNumber, LOCALES } from '../plugin/lib/locale.mjs';
import { isValidConversationId } from '../plugin/lib/poll-policy.mjs';
import { CAPSULE_ANCHORS } from './anchors.js';
import { localeState, t } from './i18n.js';
import {
  closePopover,
  collapseState,
  currentLang,
  openPopover,
  pollMetrics,
  renderPopoverContent,
  saveCollapseState,
  state,
  togglePopover,
} from './main.js';
import { capsuleStyles } from './styles.js';

export const CAPSULE_ID = 'agyctl-input-capsule';
export const SUB_CAPSULE_ID = 'agyctl-subagent-capsule';
export const TOOLTIP_ID = 'agyctl-input-tooltip';
export const TITLEBAR_BTN_ID = 'agyctl-titlebar-btn';
export const POPOVER_ID = 'agyctl-titlebar-popover';
const CAPSULE_STYLE_ID = 'agyctl-capsule-style';

const RING_R = 5;
export const RING_CIRC = 2 * Math.PI * RING_R;
let tooltipTarget = null;

export function formatUiTokens(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return formatLocaleNumber(Number(value), localeState.locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  });
}

export function formatUiNumber(value, digits = 1) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return formatLocaleNumber(Number(value), localeState.locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

export function formatUiUsd(value) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const amount = Math.max(0, Number(value));
  const digits = amount > 0 && amount < 0.01 ? 4 : amount > 0 && amount < 1 ? 3 : 2;
  return formatLocaleNumber(amount, localeState.locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function refreshVisibleTooltip() {
  if (!tooltipTarget?.el.isConnected) return;
  const { getTargetCid, isSubagent } = tooltipTarget;
  const cid = getTargetCid();
  const metrics = (cid && state.metricsByCid.get(cid)) || (isSubagent ? null : state);
  const dict = t();
  const tooltipEl = ensureTooltipMounted();
  tooltipEl.innerHTML = `
    <div class="cr-tip-row">${dict.tipUsed(formatUiTokens(metrics?.totalUsed), formatUiTokens(metrics?.capacity))}</div>
    <div class="cr-tip-row">${dict.tipCache(formatUiNumber(metrics?.convCacheRate ?? 0))}</div>
  `;
  const rect = tooltipTarget.el.getBoundingClientRect();
  const width = tooltipEl.getBoundingClientRect().width;
  tooltipEl.style.left = `${Math.max(10, Math.min(window.innerWidth - width - 10, rect.left + (rect.width - width) / 2))}px`;
  tooltipEl.style.bottom = `${window.innerHeight - rect.top + 6}px`;
}

export function getRouteCascadeId() {
  return location.pathname.match(/^\/c\/([a-f\d-]{36})/i)?.[1] || null;
}

export function getOpenSubagentCascadeId() {
  const el = document.querySelector(`${CAPSULE_ANCHORS.subagentTab}[data-cascade-id]`);
  const cid = el?.getAttribute('data-cascade-id');
  return cid && isValidConversationId(cid) ? cid : null;
}

export function buildEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined && text !== null) el.textContent = text;
  return el;
}

export function ensureTooltipMounted() {
  let el = document.getElementById(TOOLTIP_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = TOOLTIP_ID;
    document.body.appendChild(el);
  }
  return el;
}

export function ensureCapsuleStyleMounted() {
  let el = document.getElementById(CAPSULE_STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = CAPSULE_STYLE_ID;
    el.textContent = capsuleStyles();
    document.head.appendChild(el);
  }
  return el;
}

export function removeMountedCapsuleNodes() {
  document.getElementById(CAPSULE_ID)?.remove();
  document.getElementById(SUB_CAPSULE_ID)?.remove();
  document.getElementById(TOOLTIP_ID)?.remove();
  document.getElementById(TITLEBAR_BTN_ID)?.remove();
  document.getElementById(POPOVER_ID)?.remove();
  document.getElementById(CAPSULE_STYLE_ID)?.remove();
}

// 創建底部膠囊 (支援主視窗與子代理視窗)
function createCapsuleEl(
  capsuleId = CAPSULE_ID,
  getTargetCid = getRouteCascadeId,
  isSubagent = false,
) {
  const el = document.createElement('div');
  el.id = capsuleId;
  el.innerHTML = `
      <svg class="cr-ring-svg" viewBox="0 0 14 14">
        <circle class="cr-ring-bg" cx="7" cy="7" r="${RING_R}" />
        <circle class="cr-ring-val" cx="7" cy="7" r="${RING_R}" />
      </svg>
      <span class="cr-text">—%</span>
    `;

  el.addEventListener('mouseenter', () => {
    const tooltipEl = ensureTooltipMounted();
    tooltipTarget = { el, getTargetCid, isSubagent };
    refreshVisibleTooltip();
    tooltipEl.classList.add('visible');
  });

  el.addEventListener('mouseleave', () => {
    tooltipTarget = null;
    ensureTooltipMounted().classList.remove('visible');
  });

  el.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const cid = getTargetCid();
    if (cid) {
      state.selectedAgentId = cid;
    }
    if (isSubagent && !state.popoverOpen) {
      openPopover();
    } else if (state.popoverOpen) {
      renderPopoverContent(state);
    }
    void pollMetrics();
  });

  return el;
}

// 創建右上角標題列純圖標按鈕
function createTitlebarBtnEl() {
  const dict = t();
  const btn = document.createElement('button');
  btn.id = TITLEBAR_BTN_ID;
  btn.className =
    'agy-button agy-button-icon-lg inline-flex items-center font-medium transition-colors select-none outline-none cursor-pointer justify-center disabled:opacity-50 h-7 w-7 shrink-0 flex items-center justify-center rounded-lg group bg-transparent text-secondary-foreground hover:text-foreground hover:bg-secondary focus-visible:text-foreground focus-visible:bg-secondary';
  btn.title = dict.titlebarTitle;
  btn.setAttribute('aria-label', dict.titlebarAria);
  btn.innerHTML = `
      <span class="relative flex items-center justify-center" style="width: 18px; height: 18px;">
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" class="pointer-events-none outline-none">
          <path d="M480-160q-133 0-226.5-93.5T160-480q0-133 93.5-226.5T480-800q133 0 226.5 93.5T800-480q0 133-93.5 226.5T480-160Zm0-60q108 0 184-76t76-184q0-108-76-184t-184-76q-108 0-184 76t-76 184q0 108 76 184t184 76Zm20-220 120-120-42-42-138 138v164h60v-140Z"/>
        </svg>
      </span>
    `;

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    togglePopover();
  });

  return btn;
}

// 創建右上角浮動卡片 (Popover)
function createPopoverEl() {
  const dict = t();
  const el = document.createElement('div');
  el.id = POPOVER_ID;
  el.innerHTML = `
      <div class="cr-pop-header">
        <div class="cr-pop-title-wrap">
          <span class="cr-pop-dot"></span>
          <span id="cr-pop-model" class="cr-pop-model">${dict.waitingConn}</span>
          <span id="cr-pop-effort" class="cr-effort-badge" hidden></span>
        </div>
        <div class="cr-pop-actions">
          <button id="cr-pop-lang" class="cr-pop-lang-btn" type="button" title="${dict.langTitle}">${dict.langBtn}</button>
          <button id="cr-pop-close" class="cr-pop-close-btn" title="${dict.closeTitle}" aria-label="${dict.closeTitle}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6 6 18"/><path d="m6 6 12 12"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- 主代理 / 子代理切換選單 (有子代理時自動顯示) -->
      <div id="cr-agent-switch" class="cr-agent-switch" role="tablist" aria-label="${dict.agentSwitchAria}"></div>

      <!-- 區塊 0: 上下文上限 (可收折，預設收合) -->
      <div class="cr-collapsible-card collapsed" id="cr-card-limits">
        <div class="cr-card-head" id="cr-head-limits">
          <span class="cr-card-title" data-cr-i18n="diskLimitTitle">${dict.diskLimitTitle}</span>
          <div class="cr-head-right">
            <span class="cr-head-sum" id="cr-sum-limits">—</span>
            <svg class="cr-chevron" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor">
              <path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z"/>
            </svg>
          </div>
        </div>

        <div class="cr-card-body">
          <div class="cr-limits-status" id="cr-limits-status"></div>
          <div class="cr-comp-list" id="cr-limits-list"></div>
          <div class="cr-est-note" data-cr-i18n="diskLimitScope">${dict.diskLimitScope}</div>
        </div>
      </div>

      <!-- 區塊 1: 背景資訊 (可收折) -->
      <div class="cr-collapsible-card" id="cr-card-comp">
        <div class="cr-card-head" id="cr-head-comp">
          <span class="cr-card-title" data-cr-i18n="compTitle">${dict.compTitle}</span>
          <div class="cr-head-right">
            <span class="cr-head-sum" id="cr-sum-comp">—</span>
            <svg class="cr-chevron" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor">
              <path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z"/>
            </svg>
          </div>
        </div>

        <div class="cr-card-body">
          <div class="cr-comp-header">
            <div class="cr-comp-used-wrap">
              <span class="cr-comp-used-pct" id="cr-comp-used-pct">0.0%</span>
              <span class="cr-comp-used-lbl" data-cr-i18n="usedLabel">${dict.usedLabel}</span>
            </div>
            <span class="cr-comp-used-ratio" id="cr-comp-used-ratio">— / —</span>
          </div>

          <!-- 多色堆疊進度條 -->
          <div class="cr-comp-bar">
            <div id="cr-cbar-msg" class="cr-cseg cr-cseg-msg" style="width: 0%"></div>
            <div id="cr-cbar-mcp" class="cr-cseg cr-cseg-mcp" style="width: 0%"></div>
            <div id="cr-cbar-systools" class="cr-cseg cr-cseg-systools" style="width: 0%"></div>
            <div id="cr-cbar-sysprompt" class="cr-cseg cr-cseg-sysprompt" style="width: 0%"></div>
            <div id="cr-cbar-skills" class="cr-cseg cr-cseg-skills" style="width: 0%"></div>
            <div id="cr-cbar-mem" class="cr-cseg cr-cseg-mem" style="width: 0%"></div>
            <div id="cr-cbar-buffer" class="cr-cseg cr-cseg-buffer" style="width: 10%"></div>
          </div>

          <!-- Composition values are estimates; see the note below. -->
          <div class="cr-comp-list">
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-cseg-msg"></span> <span data-cr-i18n="compMessages">${dict.compMessages}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-msg">0</span><span class="cr-cpct" id="cr-pct-msg">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-cseg-mcp"></span> <span data-cr-i18n="compMcpTools">${dict.compMcpTools}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-mcp">0</span><span class="cr-cpct" id="cr-pct-mcp">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-cseg-systools"></span> <span data-cr-i18n="compSystemTools">${dict.compSystemTools}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-systools">0</span><span class="cr-cpct" id="cr-pct-systools">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-cseg-sysprompt"></span> <span data-cr-i18n="compSystemPrompt">${dict.compSystemPrompt}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-sysprompt">0</span><span class="cr-cpct" id="cr-pct-sysprompt">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-cseg-skills"></span> <span data-cr-i18n="compSkills">${dict.compSkills}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-skills">0</span><span class="cr-cpct" id="cr-pct-skills">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-cseg-mem"></span> <span data-cr-i18n="compMemoryFiles">${dict.compMemoryFiles}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-mem">0</span><span class="cr-cpct" id="cr-pct-mem">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-cseg-buffer"></span> <span data-cr-i18n="compSafetyBuffer">${dict.compSafetyBuffer}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-buffer">50k</span><span class="cr-cpct" id="cr-pct-buffer">10.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq" style="background: rgba(255,255,255,0.08);"></span> <span data-cr-i18n="compFree">${dict.compFree}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-free">—</span><span class="cr-cpct" id="cr-pct-free">—</span></div>
            </div>
          </div>

          <!-- 誠實標註：成分拆解為估算值，非服務端精確分詞 -->
          <div class="cr-est-note" data-cr-i18n="compEstNote">${dict.compEstNote}</div>
        </div>
      </div>

      <!-- 區塊 2: 輸出資訊 (可收折) -->
      <div class="cr-collapsible-card" id="cr-card-perf">
        <div class="cr-card-head" id="cr-head-perf">
          <span class="cr-card-title" data-cr-i18n="perfTitle">${dict.perfTitle}</span>
          <div class="cr-head-right">
            <span class="cr-head-sum" id="cr-sum-perf">—</span>
            <svg class="cr-chevron" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor">
              <path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z"/>
            </svg>
          </div>
        </div>

        <div class="cr-card-body">
          <div class="cr-perf-grid">
            <div class="cr-perf-item">
              <div class="cr-perf-lbl" data-cr-i18n="lblTps">${dict.lblTps}</div>
              <div class="cr-perf-val" id="cr-pop-tps">—</div>
            </div>
            <div class="cr-perf-item">
              <div class="cr-perf-lbl" data-cr-i18n="lblOverallTps">${dict.lblOverallTps}</div>
              <div class="cr-perf-val" id="cr-pop-overall-tps">—</div>
            </div>
            <div class="cr-perf-item">
              <div class="cr-perf-lbl" data-cr-i18n="lblTtft">${dict.lblTtft}</div>
              <div class="cr-perf-val" id="cr-pop-ttft">—</div>
            </div>
            <div class="cr-perf-item">
              <div class="cr-perf-lbl" data-cr-i18n="lblDuration">${dict.lblDuration}</div>
              <div class="cr-perf-val" id="cr-pop-duration">—</div>
            </div>
            <div class="cr-perf-item">
              <div class="cr-perf-lbl" data-cr-i18n="lblRecentTps">${dict.lblRecentTps}</div>
              <div class="cr-perf-val" id="cr-pop-recent-tps">—</div>
            </div>
            <div class="cr-perf-item">
              <div class="cr-perf-lbl" data-cr-i18n="lblOutTok">${dict.lblOutTok}</div>
              <div class="cr-perf-val" id="cr-pop-out-tok">—</div>
            </div>
          </div>
          <div class="cr-est-note" data-cr-i18n="perfEstNote">${dict.perfEstNote}</div>
        </div>
      </div>

      <!-- 區塊 3: 模型別名 (可收折) -->
      <div class="cr-collapsible-card" id="cr-card-var">
        <div class="cr-card-head" id="cr-head-var">
          <span class="cr-card-title" data-cr-i18n="varTitle">${dict.varTitle}</span>
          <div class="cr-head-right">
            <span class="cr-head-sum" id="cr-sum-var">—</span>
            <svg class="cr-chevron" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor">
              <path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z"/>
            </svg>
          </div>
        </div>

        <div class="cr-card-body">
          <div class="cr-variant-list" id="cr-variant-list">
            <div class="cr-vrow"><span class="cr-vname">${dict.waitingData}</span></div>
          </div>
        </div>
      </div>

      <!-- 區塊 4: 會話累計 (可收折，參考背景資訊設計) -->
      <div class="cr-collapsible-card" id="cr-card-sess">
        <div class="cr-card-head" id="cr-head-sess">
          <span class="cr-card-title" data-cr-i18n="sessTitle">${dict.sessTitle}</span>
          <div class="cr-head-right">
            <span class="cr-head-sum" id="cr-sum-sess">—</span>
            <svg class="cr-chevron" width="14" height="14" viewBox="0 -960 960 960" fill="currentColor">
              <path d="M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z"/>
            </svg>
          </div>
        </div>

        <div class="cr-card-body">
          <div class="cr-comp-header">
            <div class="cr-comp-used-wrap">
              <span class="cr-comp-used-pct" id="cr-sess-req-cnt">0</span>
              <span class="cr-comp-used-lbl" data-cr-i18n="sessRequests">${dict.sessRequests}</span>
            </div>
            <div class="cr-comp-used-ratio">
              <span data-cr-i18n="sessCostLbl">${dict.sessCostLbl}</span>
              <span class="cr-sess-cost-val" id="cr-sess-cost">$0.00</span>
            </div>
          </div>

          <div class="cr-comp-bar">
            <div id="cr-sbar-uncached" class="cr-cseg cr-sseg-uncached" style="width: 0%"></div>
            <div id="cr-sbar-cached" class="cr-cseg cr-sseg-cached" style="width: 0%"></div>
            <div id="cr-sbar-thinking" class="cr-cseg cr-sseg-thinking" style="width: 0%"></div>
            <div id="cr-sbar-output" class="cr-cseg cr-sseg-output" style="width: 0%"></div>
          </div>

          <div class="cr-comp-list">
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-sseg-uncached"></span> <span data-cr-i18n="sessUncached">${dict.sessUncached}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-s-uncached">0</span><span class="cr-cpct" id="cr-pct-s-uncached">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-sseg-cached"></span> <span data-cr-i18n="sessCached">${dict.sessCached}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-s-cached">0</span><span class="cr-cpct" id="cr-pct-s-cached">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-sseg-thinking"></span> <span data-cr-i18n="sessThinking">${dict.sessThinking}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-s-thinking">0</span><span class="cr-cpct" id="cr-pct-s-thinking">0.0%</span></div>
            </div>
            <div class="cr-crow">
              <div class="cr-cleft"><span class="cr-csq cr-sseg-output"></span> <span data-cr-i18n="sessOutput">${dict.sessOutput}</span></div>
              <div class="cr-cright"><span class="cr-cval" id="cr-val-s-output">0</span><span class="cr-cpct" id="cr-pct-s-output">0.0%</span></div>
            </div>
          </div>
        </div>
      </div>
    `;

  // 語系切換按鈕點擊
  el.querySelector('#cr-pop-lang')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const nextIdx = (LOCALES.indexOf(currentLang) + 1) % LOCALES.length;
    localeState.select(LOCALES[nextIdx]);
  });

  // 關閉按鈕點擊
  el.querySelector('#cr-pop-close')?.addEventListener('click', () => {
    closePopover();
  });

  // 代理切換選單點擊
  el.querySelector('#cr-agent-switch')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const pill = /** @type {Element} */ (ev.target).closest('.cr-agent-pill[data-agent-id]');
    if (!pill) return;
    const targetId = pill.getAttribute('data-agent-id');
    if (!targetId || state.selectedAgentId === targetId) return;
    state.selectedAgentId = targetId;
    renderPopoverContent(state);
    void pollMetrics();
  });

  function bindCardToggle(headId, cardId, key) {
    const head = el.querySelector('#' + headId);
    const card = el.querySelector('#' + cardId);
    if (!head || !card) return;

    // 初始化 DOM 樣式 (依據儲存狀態)
    if (collapseState[key] === false) {
      card.classList.add('collapsed');
    } else {
      card.classList.remove('collapsed');
    }

    head.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const isCollapsed = card.classList.toggle('collapsed');
      collapseState[key] = !isCollapsed;
      saveCollapseState(collapseState);
    });
  }

  bindCardToggle('cr-head-limits', 'cr-card-limits', 'limits');
  bindCardToggle('cr-head-comp', 'cr-card-comp', 'comp');
  bindCardToggle('cr-head-perf', 'cr-card-perf', 'perf');
  bindCardToggle('cr-head-var', 'cr-card-var', 'variants');
  bindCardToggle('cr-head-sess', 'cr-card-sess', 'session');
  return el;
}

export function ensurePopoverMounted() {
  let el = document.getElementById(POPOVER_ID);
  if (!el) {
    el = createPopoverEl();
    document.body.appendChild(el);
  }
  return el;
}

// 掛載主視窗底部膠囊：嚴格作為獨立元件掛載於 permissions-selector-trigger 的外側左方
function ensureCapsuleMounted() {
  let el = document.getElementById(CAPSULE_ID);
  const permBtn = document.querySelector(CAPSULE_ANCHORS.permissionsTrigger);

  if (el?.isConnected) {
    if (permBtn?.contains(el)) {
      permBtn.parentElement?.insertBefore(el, permBtn);
    }
    return el;
  }

  if (!el) {
    el = createCapsuleEl(CAPSULE_ID, getRouteCascadeId, false);
  }

  if (permBtn?.parentElement) {
    permBtn.parentElement.insertBefore(el, permBtn);
    return el;
  }

  const inputRoot = document.querySelector(CAPSULE_ANCHORS.composer);
  if (!inputRoot) return null;
  const composerFooter = inputRoot.querySelector(CAPSULE_ANCHORS.composerFooter) || inputRoot;
  const rightCluster =
    composerFooter.querySelector(CAPSULE_ANCHORS.composerCluster) ||
    composerFooter.querySelector(CAPSULE_ANCHORS.composerClusterLast);
  if (!rightCluster) return null;

  rightCluster.insertBefore(el, rightCluster.firstElementChild);
  return el;
}

// 掛載子代理分割視窗底部膠囊：當右側開啟子代理面板時自動掛載於麥克風按鈕左側
function ensureSubagentCapsuleMounted() {
  const subCid = getOpenSubagentCascadeId();
  const subComposer = document.querySelector(CAPSULE_ANCHORS.subComposer);
  let el = document.getElementById(SUB_CAPSULE_ID);

  if (!subCid || !subComposer) {
    if (el) el.remove();
    return null;
  }

  const composerFooter = subComposer.querySelector(CAPSULE_ANCHORS.composerFooter);
  const rightCluster =
    composerFooter?.querySelector(CAPSULE_ANCHORS.composerCluster) ||
    composerFooter?.querySelector(CAPSULE_ANCHORS.composerClusterLast);
  if (!rightCluster) return null;

  if (el?.isConnected && rightCluster.contains(el)) {
    return el;
  }

  if (!el) {
    el = createCapsuleEl(SUB_CAPSULE_ID, getOpenSubagentCascadeId, true);
  }
  rightCluster.insertBefore(el, rightCluster.firstElementChild);
  return el;
}

// 掛載頂部標題列按鈕：純圖標按鈕，掛在 titlebar-more-actions 左側
function ensureTitlebarMounted() {
  let btn = document.getElementById(TITLEBAR_BTN_ID);
  if (btn?.isConnected) return btn;

  const toolbar = document.querySelector(CAPSULE_ANCHORS.titlebarToolbar);
  if (!toolbar) return null;

  const moreBtn = toolbar.querySelector(CAPSULE_ANCHORS.titlebarMoreActions);
  if (!moreBtn) return null;

  if (!btn) {
    btn = createTitlebarBtnEl();
  }
  toolbar.insertBefore(btn, moreBtn);
  return btn;
}

// 錨點缺席的診斷只在狀態變化時回報一次，不在每個 tick 重複。
let lastMissingAnchorKey = null;

/**
 * Mounts every capsule surface and returns the capability result. A missing
 * anchor leaves only the affected surface unmounted; polling and token
 * normalization keep running. The capability diagnostic is emitted at most
 * once per missing-anchor transition (never per tick) and carries anchor
 * names only — never tokens, message bodies, or session secrets.
 */
export function mountCapsuleSurfaces() {
  const capsule = ensureCapsuleMounted();
  const subCapsule = ensureSubagentCapsuleMounted();
  const titlebar = ensureTitlebarMounted();
  const missingAnchors = [];
  if (!capsule) missingAnchors.push('composer');
  if (!titlebar) missingAnchors.push('titlebar');
  const key = missingAnchors.join(',');
  if (key !== lastMissingAnchorKey) {
    lastMissingAnchorKey = key;
    if (missingAnchors.length) {
      console.warn(
        `[agyctl] capsule anchors unavailable (${missingAnchors.join(', ')}); capsule UI stays unmounted`,
      );
    }
  }
  return { capsule, subCapsule, titlebar, missingAnchors };
}
