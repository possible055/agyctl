/**
 * Shared poll and refresh policy for the Node sidecar and the injected
 * capsule (scripts/capsule-build.mjs inlines this module next to
 * metrics-core.mjs). Pure decisions only: callers pass their own constants
 * and clocks; no DOM, timers, or I/O here.
 */

// Conversation-ID contract shared by the capsule route/tab checks and panel
// discovery: exactly 36 characters drawn from hex digits and dashes,
// case-insensitive. This is intentionally looser than a canonical UUID and
// must stay that way — conversation files and routes that predate canonical
// UUID formatting would otherwise silently disappear from the UI.
const CONVERSATION_ID_RE = /^[a-f\d-]{36}$/i;

function isValidConversationId(value) {
  return typeof value === 'string' && CONVERSATION_ID_RE.test(value);
}

/**
 * Cadence decision shared with capsule polling (3s popover / 5s background /
 * 15s hidden). The panel maps its configurable interval onto the same
 * three-way decision and applies its own hidden-window minimum at the call
 * site, so only the branch selection is shared.
 */
function nextPollDelayMs({
  popoverOpen,
  documentHidden,
  base: { openMs, backgroundMs, hiddenMs },
}) {
  if (documentHidden) return hiddenMs;
  return popoverOpen ? openMs : backgroundMs;
}

/**
 * Per-conversation refresh decision kept byte-for-byte identical in both
 * callers: executor capacity is refetched once its TTL elapses, and the
 * rolling aggregate reconciles against a full offset-0 list on a longer
 * period. An aggregate that has seen nothing never schedules a resync.
 */
function refreshSchedule(agg, now, { executorTtlMs, fullResyncMs }) {
  return {
    executorDue: agg.lastExecAttempt === null || now - agg.lastExecAttempt >= executorTtlMs,
    fullResync: agg.seen > 0 && now - agg.lastResyncAt > fullResyncMs,
  };
}

export { isValidConversationId, nextPollDelayMs, refreshSchedule };
