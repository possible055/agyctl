/**
 * Upstream Language Server wire contract shared by the Node panel transport
 * and the injected capsule (scripts/capsule-build.mjs inlines this module):
 * the Connect-RPC service path, the method names telemetry reads, and the
 * response normalization applied once at the runtime boundary. Pure checks
 * only — HTTP, DOM, streaming, and fallback handling stay with the callers.
 */

const LANGUAGE_SERVER_SERVICE = 'exa.language_server_pb.LanguageServerService';
const PANEL_SIDECAR_ID = 'agyctl/panel';

// Connect-RPC method names on LanguageServerService that the panel and the
// capsule call.
const LS_RPC_METHODS = Object.freeze({
  generatorMetadata: 'GetCascadeTrajectoryGeneratorMetadata',
  executorMetadatas: 'GetCascadeTrajectoryExecutorMetadatas',
  allTrajectories: 'GetAllCascadeTrajectories',
  steps: 'GetCascadeTrajectorySteps',
  subscribeSidecars: 'SubscribeToSidecars',
});

function languageServerRpcPath(method) {
  return `/${LANGUAGE_SERVER_SERVICE}/${method}`;
}

/**
 * Generator metadata contract: the field is optional in current builds (an
 * empty session answers {}), so a missing field is an empty delta, but a
 * present non-array breaks the offset semantics and must fail the poll with
 * an explicit error instead of being read as empty. Additional optional
 * fields are tolerated; unknown values stay unknown — normalization never
 * fabricates or zero-fills rows.
 */
function normalizeGeneratorMetadataResponse(res) {
  if (!isResponseRecord(res)) {
    throw new Error('Invalid generator metadata response');
  }
  if (res.generatorMetadata !== undefined && !Array.isArray(res.generatorMetadata)) {
    throw new Error('Invalid generator metadata response');
  }
  return res.generatorMetadata || [];
}

/**
 * Same contract as the generator response, returned as a canonical response
 * object because applyExecutorCapacity consumes the response shape directly.
 * Executor entries carry additional optional fields (loadedCustomizations,
 * plannerConfig) that the shared core reads only when present.
 */
function normalizeExecutorMetadataResponse(res) {
  if (!isResponseRecord(res)) {
    throw new Error('Invalid executor metadata response');
  }
  if (res.executorMetadata !== undefined && !Array.isArray(res.executorMetadata)) {
    throw new Error('Invalid executor metadata response');
  }
  return { executorMetadata: res.executorMetadata || [] };
}

function isResponseRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Connect JSON omits empty maps, so a server with no loaded conversations
 * answers {}: a missing trajectorySummaries field is a legal empty map, a
 * present non-object is malformed. The same omission rule shapes the steps
 * normalizer below.
 */
function normalizeTrajectorySummariesResponse(res) {
  if (!isResponseRecord(res)) {
    throw new Error('Invalid trajectory summaries response');
  }
  if (res.trajectorySummaries !== undefined && !isResponseRecord(res.trajectorySummaries)) {
    throw new Error('Invalid trajectory summaries response');
  }
  return res.trajectorySummaries || {};
}

/**
 * Step reads follow the same omission rule: a missing steps field means
 * "nothing new" (the caller keeps its known times), a present non-array is a
 * contract violation and must fail the step read instead of being read as an
 * empty delta.
 */
function normalizeTrajectoryStepsResponse(res) {
  if (!isResponseRecord(res)) {
    throw new Error('Invalid trajectory steps response');
  }
  if (res.steps !== undefined && !Array.isArray(res.steps)) {
    throw new Error('Invalid trajectory steps response');
  }
  return res.steps || null;
}

/**
 * Locates the panel sidecar entry in a SubscribeToSidecars snapshot. A
 * malformed snapshot is a contract violation; a well-formed snapshot without
 * the panel entry yields null — an availability condition the caller reports.
 * Address validation (loopback, no credentials) stays with the caller.
 */
function normalizeSidecarSnapshotResponse(snapshot) {
  if (!isResponseRecord(snapshot)) {
    throw new Error('Invalid sidecar snapshot response');
  }
  if (snapshot.sidecars !== undefined && !Array.isArray(snapshot.sidecars)) {
    throw new Error('Invalid sidecar snapshot response');
  }
  return (snapshot.sidecars || []).find((row) => row?.sidecarId === PANEL_SIDECAR_ID) || null;
}

export {
  LS_RPC_METHODS,
  languageServerRpcPath,
  normalizeExecutorMetadataResponse,
  normalizeGeneratorMetadataResponse,
  normalizeSidecarSnapshotResponse,
  normalizeTrajectoryStepsResponse,
  normalizeTrajectorySummariesResponse,
};
