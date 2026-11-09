import {
  CAPSULE_ID,
  POPOVER_ID,
  RING_CIRC,
  SUB_CAPSULE_ID,
  TITLEBAR_BTN_ID,
  TOOLTIP_ID,
} from './host-ui.js';

export function capsuleStyles() {
  return `
      /* 底部膠囊 (主視窗與子代理視窗共用樣式) */
      #${CAPSULE_ID}, #${SUB_CAPSULE_ID} {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 0 7px;
        border-radius: 9999px;
        font-family: "Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 12px;
        font-weight: 350;
        line-height: 16px;
        letter-spacing: normal;
        user-select: none;
        cursor: pointer;
        background: transparent;
        color: var(--secondary-foreground, #bcbdc6);
        transition: background-color 0.15s ease;
        margin-right: 4px;
        height: 28px;
        box-sizing: border-box;
        white-space: nowrap;
        flex-shrink: 0;
      }
      #${CAPSULE_ID}:hover, #${SUB_CAPSULE_ID}:hover {
        background: var(--secondary, rgba(255, 255, 255, 0.075));
      }
      #${CAPSULE_ID} .cr-ring-svg, #${SUB_CAPSULE_ID} .cr-ring-svg {
        width: 14px;
        height: 14px;
        transform: rotate(-90deg);
        flex-shrink: 0;
      }
      #${CAPSULE_ID} .cr-ring-bg, #${SUB_CAPSULE_ID} .cr-ring-bg {
        fill: none;
        stroke: rgba(255, 255, 255, 0.18);
        stroke-width: 2;
      }
      #${CAPSULE_ID} .cr-ring-val, #${SUB_CAPSULE_ID} .cr-ring-val {
        fill: none;
        stroke: var(--accent, var(--primary, #2F71E3));
        stroke-width: 2;
        stroke-linecap: round;
        stroke-dasharray: ${RING_CIRC};
        stroke-dashoffset: ${RING_CIRC};
        transition: stroke-dashoffset 0.3s ease, stroke 0.3s ease;
      }
      #${CAPSULE_ID} .cr-text, #${SUB_CAPSULE_ID} .cr-text {
        font-weight: 350;
      }

      /* 底部懸浮提示 (簡明 2 行) */
      #${TOOLTIP_ID} {
        position: fixed;
        bottom: 68px;
        z-index: 2147483647;
        padding: 6px 12px;
        border-radius: 8px;
        background: var(--card, #131317);
        color: var(--secondary-foreground, #bcbdc6);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        font-family: "Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-size: 12px;
        line-height: 1.5;
        pointer-events: none;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.15s ease, transform 0.15s ease;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        white-space: nowrap;
      }
      #${TOOLTIP_ID}.visible {
        opacity: 1;
        transform: translateY(0);
      }
      #${TOOLTIP_ID} .cr-tip-row {
        color: var(--secondary-foreground, #bcbdc6);
        font-size: 12px;
        font-weight: 350;
        line-height: 1.4;
      }

      /* 右上角工具列按鈕 (純圖標按鈕，不重複顯示狀態) */
      #${TITLEBAR_BTN_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 28px;
        width: 28px;
        padding: 0;
        border-radius: 8px;
        user-select: none;
        cursor: pointer;
        background: transparent;
        color: var(--secondary-foreground, #bcbdc6);
        border: none;
        outline: none;
        transition: background-color 0.15s ease, color 0.15s ease;
        box-sizing: border-box;
        white-space: nowrap;
        flex-shrink: 0;
        app-region: no-drag;
      }
      #${TITLEBAR_BTN_ID}:hover, #${TITLEBAR_BTN_ID}.active {
        background: var(--secondary, rgba(255, 255, 255, 0.075));
        color: var(--foreground, #ececef);
      }

      /* 右上角會話專屬浮動卡片 (Popover) */
      #${POPOVER_ID} {
        position: fixed;
        z-index: 2147483647;
        width: 348px;
        max-height: calc(100vh - 80px);
        overflow-y: auto;
        background: var(--card, #141418);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: 12px;
        box-shadow: 0 20px 48px -8px rgba(0, 0, 0, 0.72), 0 4px 12px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.05);
        font-family: "Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        font-variant-numeric: tabular-nums;
        -webkit-font-smoothing: antialiased;
        color: var(--foreground, #ececef);
        padding: 12px;
        display: none;
        flex-direction: column;
        gap: 8px;
        box-sizing: border-box;
        user-select: none;
        app-region: no-drag;
        animation: crPopIn 0.14s cubic-bezier(0.16, 1, 0.3, 1);
      }
      #${POPOVER_ID}.visible {
        display: flex;
      }
      #${POPOVER_ID}::-webkit-scrollbar {
        width: 4px;
      }
      #${POPOVER_ID}::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.14);
        border-radius: 4px;
      }
      @keyframes crPopIn {
        from { opacity: 0; transform: translateY(-4px) scale(0.985); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }

      .cr-pop-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 2px 4px 8px 4px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      }
      .cr-pop-title-wrap {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .cr-pop-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #10b981;
        box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.16);
        flex-shrink: 0;
      }
      .cr-pop-model {
        font-size: 13px;
        font-weight: 500;
        color: var(--foreground, #ececef);
        letter-spacing: -0.01em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cr-pop-actions {
        display: flex;
        align-items: center;
        gap: 4px;
        flex-shrink: 0;
      }
      .cr-pop-lang-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 22px;
        min-width: 24px;
        padding: 0 6px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 5px;
        color: #BCBDC6;
        font-family: inherit;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        user-select: none;
        transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
      }
      .cr-pop-lang-btn:hover {
        background: var(--secondary, rgba(255, 255, 255, 0.08));
        color: var(--foreground, #ececef);
        border-color: rgba(255, 255, 255, 0.14);
      }
      .cr-pop-close-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        background: transparent;
        border: none;
        color: #8E8F9B;
        cursor: pointer;
        padding: 0;
        border-radius: 6px;
        flex-shrink: 0;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .cr-pop-close-btn:hover {
        background: var(--secondary, rgba(255, 255, 255, 0.075));
        color: var(--foreground, #ececef);
      }

      /* 頂部主代理 / 子代理切換器 (Segmented Control) */
      .cr-agent-switch {
        display: none;
        align-items: center;
        gap: 3px;
        padding: 3px;
        background: rgba(255, 255, 255, 0.024);
        border: 1px solid rgba(255, 255, 255, 0.055);
        border-radius: 8px;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .cr-agent-switch.visible {
        display: flex;
      }
      .cr-agent-switch::-webkit-scrollbar {
        display: none;
      }
      .cr-agent-pill {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 24px;
        padding: 0 9px;
        border-radius: 6px;
        border: none;
        background: transparent;
        color: #8E8F9B;
        font-family: inherit;
        font-size: 12px;
        font-weight: 450;
        line-height: 1;
        cursor: pointer;
        white-space: nowrap;
        flex-shrink: 0;
        transition: background-color 0.15s ease, color 0.15s ease;
      }
      .cr-agent-pill:hover {
        color: #D4D5DD;
        background: rgba(255, 255, 255, 0.035);
      }
      .cr-agent-pill.active {
        background: rgba(255, 255, 255, 0.085);
        color: var(--foreground, #ececef);
        font-weight: 500;
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
      }
      .cr-agent-pill-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: rgba(255, 255, 255, 0.22);
        flex-shrink: 0;
      }
      .cr-agent-pill.active .cr-agent-pill-dot {
        background: #8E8F9B;
      }
      .cr-agent-pill-dot.running {
        background: #10b981 !important;
        box-shadow: 0 0 0 2px rgba(16, 185, 129, 0.18);
      }
      .cr-agent-pill-lbl {
        max-width: 136px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* 可收折卡片通用容器 */
      .cr-collapsible-card {
        background: rgba(255, 255, 255, 0.022);
        border: 1px solid rgba(255, 255, 255, 0.055);
        border-radius: 9px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      .cr-collapsible-card.collapsed:hover {
        background: rgba(255, 255, 255, 0.038);
        border-color: rgba(255, 255, 255, 0.08);
      }
      .cr-card-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        cursor: pointer;
        user-select: none;
        min-height: 20px;
      }
      .cr-card-head:hover .cr-chevron {
        color: var(--foreground, #ececef);
      }
      .cr-card-title {
        font-size: 13px;
        font-weight: 500;
        color: #D4D5DD;
        letter-spacing: -0.01em;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .cr-head-right {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
        min-width: 0;
        flex: 1;
      }
      .cr-head-sum {
        font-size: 12px;
        color: #8E8F9B;
        display: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cr-collapsible-card.collapsed .cr-head-sum {
        display: block;
      }
      .cr-chevron {
        color: #8E8F9B;
        transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1), color 0.15s ease;
        flex-shrink: 0;
      }
      .cr-collapsible-card.collapsed .cr-chevron {
        transform: rotate(-90deg);
      }
      .cr-card-body {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 10px;
        padding-top: 10px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
      }
      .cr-collapsible-card.collapsed .cr-card-body {
        display: none;
      }

      /* 背景資訊內部樣式 */
      .cr-comp-header {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
      }
      .cr-comp-used-wrap {
        display: flex;
        align-items: baseline;
        gap: 5px;
      }
      .cr-comp-used-pct {
        font-size: 16px;
        font-weight: 600;
        letter-spacing: -0.02em;
        color: var(--foreground, #ececef);
      }
      .cr-comp-used-lbl {
        font-size: 12px;
        color: #8E8F9B;
      }
      .cr-comp-used-ratio {
        font-size: 12px;
        color: #8E8F9B;
      }
      .cr-sess-cost-val {
        font-size: 13.5px;
        font-weight: 500;
        color: var(--foreground, #ececef);
        margin-left: 4px;
      }
      .cr-est-note {
        font-size: 11px;
        line-height: 1.4;
        color: #8E8F9B;
      }

      /* 多色堆疊進度條 */
      .cr-comp-bar {
        height: 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.07);
        display: flex;
        overflow: hidden;
      }
      .cr-cseg {
        height: 100%;
        transition: width 0.3s ease;
      }
      .cr-cseg-msg { background: #3b82f6; }       /* 藍色 Messages */
      .cr-cseg-mcp { background: #f97316; }       /* 橘色 MCP tools */
      .cr-cseg-systools { background: #10b981; }  /* 綠色 System tools */
      .cr-cseg-sysprompt { background: #eab308; } /* 黃色 System prompt */
      .cr-cseg-skills { background: #8b5cf6; }    /* 紫色 Skills */
      .cr-cseg-mem { background: #ec4899; }       /* 粉紫 Memory files */
      .cr-cseg-buffer { background: rgba(255, 255, 255, 0.22); } /* 淺灰 Autocompact buffer */
      .cr-sseg-uncached { background: #3b82f6; }  /* 藍色 未緩存輸入 */
      .cr-sseg-cached { background: #8b5cf6; }    /* 紫色 緩存輸入 */
      .cr-sseg-thinking { background: #06b6d4; }  /* 青色 思考 */
      .cr-sseg-output { background: #10b981; }    /* 綠色 輸出 */

      /* 細部成分列表 */
      .cr-comp-list {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .cr-crow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12.5px;
        line-height: 1.4;
      }
      .cr-cleft {
        display: flex;
        align-items: center;
        gap: 8px;
        color: #BCBDC6;
        min-width: 0;
      }
      .cr-csq {
        width: 7px;
        height: 7px;
        border-radius: 2px;
        flex-shrink: 0;
      }
      .cr-cright {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        color: var(--foreground, #ececef);
        flex-shrink: 0;
      }
      .cr-cval {
        min-width: 48px;
        text-align: right;
      }
      .cr-cpct {
        min-width: 42px;
        text-align: right;
        color: #8E8F9B;
        font-size: 12px;
      }

      /* 輸出資訊內部 */
      .cr-perf-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
      }
      .cr-perf-item {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cr-perf-item:nth-child(odd) {
        padding-right: 12px;
        border-right: 1px solid rgba(255, 255, 255, 0.05);
      }
      .cr-perf-item:nth-child(even) {
        padding-left: 12px;
      }
      .cr-perf-item:nth-child(n+3) {
        padding-top: 9px;
      }
      .cr-perf-item:nth-last-child(n+3) {
        padding-bottom: 9px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      .cr-perf-lbl {
        font-size: 11.5px;
        color: #8E8F9B;
        line-height: 1.3;
      }
      .cr-perf-val {
        font-size: 15px;
        font-weight: 500;
        letter-spacing: -0.01em;
        color: var(--foreground, #ececef);
        line-height: 1.35;
      }
      .cr-perf-unit {
        font-size: 11.5px;
        font-weight: 400;
        color: #8E8F9B;
        margin-left: 3px;
      }
      .cr-perf-val.cr-perf-low,
      .cr-perf-val.cr-perf-pending {
        opacity: 0.55;
        text-decoration: underline dotted;
      }
      .cr-perf-val.cr-perf-pending {
        font-style: italic;
      }
      .cr-perf-grid + .cr-est-note {
        margin-top: 8px;
      }

      /* 模型別名內部 */
      .cr-variant-list {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .cr-vrow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12.5px;
        line-height: 1.4;
      }
      .cr-vleft {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      .cr-vname {
        color: #BCBDC6;
        font-size: 12.5px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cr-vright {
        display: flex;
        align-items: center;
        gap: 10px;
        flex-shrink: 0;
      }
      .cr-vcount {
        color: var(--foreground, #ececef);
        min-width: 48px;
        text-align: right;
      }
      .cr-vpct {
        color: #8E8F9B;
        font-size: 12px;
        min-width: 42px;
        text-align: right;
      }
    `;
}
