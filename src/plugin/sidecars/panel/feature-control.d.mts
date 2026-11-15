export interface CatalogModel {
  alias: string;
  name: string;
  baseName?: string;
  effort?: 'xhigh' | 'high' | 'medium' | 'low' | null;
  id: number | null;
  available: boolean;
}
export interface ModelCatalog {
  status: 'available' | 'unavailable';
  models: CatalogModel[];
  error: string | null;
}
export function readModels(): Promise<ModelCatalog>;
export function readFeatures(options?: { fresh?: boolean }): Promise<unknown>;
export function queueFeatureApply(payload: unknown): Promise<unknown>;
export function cancelFeatureApply(payload: unknown): Promise<unknown>;
