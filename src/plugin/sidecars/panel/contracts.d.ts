import type { TrajectoryStep, TrajectorySummary } from '../../lib/upstream-contract.mjs';

export type { TrajectorySummary } from '../../lib/upstream-contract.mjs';

export interface Settings {
  pollIntervalSeconds: number;
}

export interface LimitDiagnostic {
  id: string;
  limits: number[];
  error: string | null;
}

export interface LimitDiagnostics {
  source: 'local-executor-metadata';
  conversations: LimitDiagnostic[];
  error: string | null;
}

export interface Endpoint {
  host: string;
  port: number;
  protocol: string;
  csrfToken: string;
  source: string;
  product?: string;
  conversationDir?: string;
}

export interface RpcResponses {
  GetAvailableModels: { response?: { models?: Record<string, { displayName?: string; model?: string; disabled?: boolean }> } };
  GetAllCascadeTrajectories: { trajectorySummaries?: Record<string, TrajectorySummary> };
  GetCascadeTrajectoryGeneratorMetadata: { generatorMetadata?: import('../../lib/metrics-core.mjs').GeneratorMetadata[] };
  GetCascadeTrajectoryExecutorMetadatas: { executorMetadata?: import('../../lib/metrics-core.mjs').ExecutorMetadata[] };
  GetCascadeTrajectorySteps: { steps?: TrajectoryStep[] };
}

export interface ConversationDetail {
  title?: string | null;
  workspace?: string | null;
  modifiedAt?: number | null;
  parentId?: string | null;
  rpcVersion?: [string | null, number | null];
}

export interface UsageTotals {
  requests: number;
  uncachedTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  unpricedRequests: number;
}

export interface UsageBucket extends Omit<UsageTotals,'totalTokens'> {
  day: string | null;
  model: string;
}

export interface ConversationUsage {
  /** null marks a provisionally evicted conversation that must refetch */
  fingerprint: string | null;
  /** Committed only when the step-time read succeeded; left open for retry otherwise. */
  stepFingerprint?: string;
  revision: string | null;
  stepTimes: (number | null)[];
  /** Kept only on provisional records so a date retry can re-bucket without refetching. */
  entries?: import('../../lib/metrics-core.mjs').GeneratorMetadata[];
  buckets: UsageBucket[];
  lastTurnAt: number | null;
}

export interface UsageScan {
  status: string;
  updatedAt: string | null;
  discovered: number | null;
  failed: number;
  unscanned: number;
  error: string | null;
  refreshing: boolean;
}

export interface Pricing {
  prices: import('../../lib/pricing-core.mjs').ModelPrice[];
  revision: string;
  defaults: import('../../lib/pricing-core.mjs').ModelPrice[];
}

export interface PricingStatus {
  prices: import('../../lib/pricing-core.mjs').ModelPrice[];
  defaults: import('../../lib/pricing-core.mjs').ModelPrice[];
  status: 'ok' | 'stale' | 'unavailable';
  pricingDamaged: boolean;
  damage: string | null;
  recoveryToken: string | null;
  revision: string | null;
}
