export interface ModelPrice {
  model: string;
  input: number;
  cacheRead: number;
  output: number;
  thinking: number;
}
export interface ChatModel {
  responseModel?: string;
  model?: string;
  modelDisplayName?: string;
  chatStartMetadata?: { createdAt?: string };
  usage?: Record<string, string | number>;
}
export function formatUsd(value: number | null | undefined): string;
export function validateCustomPrices(value: unknown): ModelPrice[];
export function getBuiltinModelPrices(at?: number): ModelPrice[];
export function resolveModelPricingFamily(model: ChatModel): string | null;
export function getModelPricing(model: ChatModel, at?: string | number, prices?: ModelPrice[]): Omit<ModelPrice,'model'> | null;
export function computeTurnCostUsd(tokens: {input?: number; cache?: number; thinking?: number; response?: number}, price: Omit<ModelPrice,'model'> | null): number;
