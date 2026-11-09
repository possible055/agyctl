import type { ChatModel, ModelPrice } from './pricing-core.mjs';
export interface GeneratorMetadata {
  chatModel?: ChatModel;
  stepIndices?: number[];
  executionId?: string;
  stopReason?: string;
  error?: unknown;
}
export interface ExecutorMetadata {
  cascadeConfig?: { checkpointConfig?: { maxTokenLimit?: number; tokenThreshold?: number } };
}
export interface RowContribution {
  fingerprint: string;
  input: number;
  cache: number;
  thinking: number;
  response: number;
  costUsd: number;
  priced: boolean;
  variant: string | null;
  eligible: boolean;
}
export interface SessionAgg {
  seen: number;
  lastResyncAt: number;
  sumInput: number;
  sumCache: number;
  sumThinking: number;
  sumResponse: number;
  sumCostUsd: number;
  unpricedRequests: number;
  requestCount: number;
  capacity: number | null;
  lastExecFetch: number;
  lastExecAttempt: number | null;
  executorError: string | null;
  generatorUpdatedAt: string | null;
  traceId: string | null;
  pricingRevision?: string | null;
  contributions: Map<number, RowContribution>;
  reconciliationDue: boolean;
  unresolvedTailRows: number;
}
export interface SessionTotals {
  requests: number;
  uncachedTokens: number;
  cachedTokens: number;
  thinkingTokens: number;
  outputTokens: number;
  totalCostUsd: number | null;
  unpricedRequests: number;
}
export interface CoreMetrics {
  conversationId: string | null;
  isWaitingGen: boolean;
  capacity: number | null;
  totalUsed: number;
  usedPercentage: number | null;
  freeTokens: number | null;
  input: number;
  cache: number;
  thinking: number;
  output: number;
  response: number;
  modelName: string | null;
  modelAlias: string | null;
  responseModel: string | null;
  modelDisplayName: string | null;
  modelId: string | null;
  modelVariants: {name: string; count: number; percentage: number}[];
  sessionTotals: SessionTotals;
  sessionCacheRate: number;
  turnCacheRate: number;
  speed: Record<string, unknown>;
}
export const BUFFER_DEFAULT_TOKENS: number;
export function createSessionAgg(now?: number): SessionAgg;
export function mergeGeneratorMetadata(agg: SessionAgg, entries: GeneratorMetadata[], prices?: ModelPrice[], offset?: number): SessionAgg;
export function applyFullResync(agg: SessionAgg, entries: GeneratorMetadata[], prices?: ModelPrice[]): SessionAgg;
export function applyExecutorCapacity(agg: SessionAgg, response: {executorMetadata?: ExecutorMetadata[]}, now?: number): number | null;
export function generatorRefreshOffset(agg: SessionAgg): number;
export function metricsFromAgg(agg: SessionAgg, options?: {capacity?: number; conversationId?: string}): CoreMetrics;
export function emptyGenerationSpeed(): Record<string, unknown>;
export function formatTokens(value: number | null | undefined): string;
export function parseDuration(value: unknown): number | null;
export function parseTokenCount(value: unknown): number | null;
export function computeGenerationSpeed(model: ChatModel): Record<string, unknown>;
export function recentGenerationSpeed(agg: SessionAgg, model: string | null): Record<string, unknown>;
export function splitUsageTokens(usage: ChatModel['usage']): {input:number;cache:number;output:number;thinking:number;response:number};
