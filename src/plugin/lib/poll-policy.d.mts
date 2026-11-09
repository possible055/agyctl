export declare function isValidConversationId(value: unknown): boolean;

export interface PollCadence {
  /** Delay while an interactive surface (popover) is open. */
  openMs: number;
  /** Delay while visible but idle. */
  backgroundMs: number;
  /** Delay while the document is hidden. */
  hiddenMs: number;
}

/**
 * Three-way cadence selection. Hidden wins over open; callers keep their own
 * constants and any extra floors (the panel applies its hidden-window
 * minimum to the returned branch value at the call site).
 */
export declare function nextPollDelayMs(options: {
  popoverOpen: boolean;
  documentHidden: boolean;
  base: PollCadence;
}): number;

export interface RefreshScheduleInput {
  /** null until the first executor attempt, epoch ms afterwards. */
  lastExecAttempt: number | null;
  lastResyncAt: number;
  seen: number;
}

export declare function refreshSchedule(
  agg: RefreshScheduleInput,
  now: number,
  limits: { executorTtlMs: number; fullResyncMs: number },
): { executorDue: boolean; fullResync: boolean };
