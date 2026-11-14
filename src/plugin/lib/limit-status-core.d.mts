export interface ModelLimit { id: number; limit: number }
export interface AvailableLimitStatus {
  status: 'available';
  snapshotAt: string;
  error: null;
  binary: string;
  binarySha256: string;
  patchKind: string;
  settingsState: string;
  modelLimits: ModelLimit[];
  savedModelLimits: ModelLimit[];
  modelNames?: Record<string, string>;
  modelEfforts?: Record<string, 'high' | 'medium' | 'low'>;
}
export type LimitStatus = AvailableLimitStatus | { status: 'unavailable'; snapshotAt: string; error: string };
export interface DiskLimitMessages {
  diskLimitTitle: string;
  diskLimitScope: string;
  diskLimitUnavailable: string;
  diskLimitPatched: string;
  diskLimitUnpatched: string;
  diskLimitSaved: string;
  diskLimitHint: string;
  diskLimitTarget: string;
  diskLimitSnapshot: string;
  diskLimitStates: Record<string, string>;
}
export interface LimitStatusRow {
  id: number;
  name: string;
  effort: string | null;
  limit: number;
}
export interface LimitStatusEntries {
  kind: 'patched' | 'disabled' | 'unknown' | 'unavailable';
  statusText: string;
  rows: LimitStatusRow[];
}
export function normalizeModelLimits(value: unknown): ModelLimit[];
export function normalizeLimitStatus(value: unknown): LimitStatus;
export function normalizeNativeLimitStatus(value: unknown, snapshotAt: string): LimitStatus;
export function limitStatusEntries(
  snapshot: LimitStatus | null,
  dict: DiskLimitMessages,
): LimitStatusEntries;
export function limitStatusLines(snapshot: LimitStatus | null, dict: DiskLimitMessages): string[];
