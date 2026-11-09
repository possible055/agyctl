import type { ExecutorMetadata, GeneratorMetadata } from './metrics-core.mjs';

export interface TrajectorySummary {
  summary?: string;
  lastModifiedTime?: string;
  createdTime?: string;
  status?: string;
  stepCount?: number;
  annotations?: { title?: string };
  workspaces?: { workspaceFolderAbsoluteUri?: string }[];
  trajectoryMetadata?: {
    parentConversationId?: string;
    rootConversationId?: string;
    subagentSpec?: { role?: string; typeName?: string };
    agentScript?: { name?: string };
  };
}

export interface TrajectoryStep {
  metadata?: { createdAt?: string };
}

/** Connect-RPC method names on exa.language_server_pb.LanguageServerService. */
export const LS_RPC_METHODS: {
  readonly generatorMetadata: 'GetCascadeTrajectoryGeneratorMetadata';
  readonly executorMetadatas: 'GetCascadeTrajectoryExecutorMetadatas';
  readonly allTrajectories: 'GetAllCascadeTrajectories';
  readonly steps: 'GetCascadeTrajectorySteps';
  readonly subscribeSidecars: 'SubscribeToSidecars';
};

/** Request path "/exa.language_server_pb.LanguageServerService/<method>". */
export declare function languageServerRpcPath(method: string): string;

/**
 * Validates a GetCascadeTrajectoryGeneratorMetadata response at the runtime
 * boundary: returns the metadata rows ([] when the field is absent), throws
 * "Invalid generator metadata response" for a non-object response or a
 * present non-array field. Additional optional fields are tolerated and
 * unknown values are never zero-filled.
 */
export declare function normalizeGeneratorMetadataResponse(
  response: unknown,
): GeneratorMetadata[];

/**
 * Validates a GetCascadeTrajectoryExecutorMetadatas response with the same
 * rules, returning a canonical response object consumable by
 * applyExecutorCapacity.
 */
export declare function normalizeExecutorMetadataResponse(response: unknown): {
  executorMetadata: ExecutorMetadata[];
};

/**
 * Validates a GetAllCascadeTrajectories response: a missing
 * trajectorySummaries field is a legal empty map (Connect JSON omits empty
 * maps), a present non-object throws "Invalid trajectory summaries response".
 */
export declare function normalizeTrajectorySummariesResponse(
  response: unknown,
): Record<string, TrajectorySummary>;

/**
 * Validates a GetCascadeTrajectorySteps response with the same omission rule:
 * returns the steps array, or null when the field is absent ("nothing new");
 * a present non-array throws "Invalid trajectory steps response".
 */
export declare function normalizeTrajectoryStepsResponse(
  response: unknown,
): TrajectoryStep[] | null;

export interface SidecarSnapshotEntry {
  sidecarId?: string;
  baseUrl?: string;
}

/**
 * Locates the agyctl/panel sidecar entry in a SubscribeToSidecars
 * snapshot; null when the snapshot is well-formed but the panel is absent,
 * "Invalid sidecar snapshot response" error when the snapshot is malformed.
 */
export declare function normalizeSidecarSnapshotResponse(
  snapshot: unknown,
): SidecarSnapshotEntry | null;
