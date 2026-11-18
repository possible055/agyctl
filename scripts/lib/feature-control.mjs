import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeNativeLimitStatus } from '../../src/plugin/lib/limit-status-core.mjs';
import { prepareManagement } from '../manage.mjs';
import { repoRoot, runAgyctl, runAgyctlAsync } from './agyctl.mjs';
import { cleanupOrphanSidecars, inspectOrphanSidecars } from './client-processes.mjs';
import { inspectHostTarget } from './client-target.mjs';
import { agyctlHome, findAsarPath, sha256File, sha256FileCached } from './install-paths.mjs';
import { readModelCatalog } from './model-catalog.mjs';
import { assertNativeExpectation, nativeExpectation } from './native-binding.mjs';

const activeStates = new Set(['waiting', 'preparing', 'applying']);
const locales = new Set(['en', 'zh-Hant-TW', 'zh-Hans-CN', 'ja-JP']);
const COMPACTION_PROMPT_MAX_BYTES = 3937;

function failure(code, message) {
  return Object.assign(new Error(message), { code, safeForPanel: true });
}

function exactObject(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function normalizeFeatureApply(payload) {
  const requiredKeys = ['revision', 'capsule', 'localization', 'limit'];
  const optionalKeys = ['compaction', 'compactionPrompt'].filter((key) =>
    Object.hasOwn(payload ?? {}, key),
  );
  if (
    !exactObject(payload, [...requiredKeys, ...optionalKeys]) ||
    typeof payload.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.revision) ||
    typeof payload.capsule !== 'boolean' ||
    !exactObject(payload.localization, ['enabled', 'locale']) ||
    typeof payload.localization.enabled !== 'boolean' ||
    !locales.has(payload.localization.locale) ||
    !exactObject(payload.limit, ['enabled', 'modelLimits']) ||
    typeof payload.limit.enabled !== 'boolean' ||
    !Array.isArray(payload.limit.modelLimits) ||
    payload.limit.modelLimits.length > 128 ||
    (payload.limit.enabled && payload.limit.modelLimits.length === 0) ||
    (Object.hasOwn(payload, 'compaction') &&
      payload.compaction !== null &&
      typeof payload.compaction !== 'boolean')
  )
    throw failure('INVALID_SELECTION', 'Check the feature selections and model limits');
  const compaction = payload.compaction ?? null;
  let compactionPrompt = payload.compactionPrompt ?? null;
  if (compactionPrompt !== null) {
    compactionPrompt = normalizeCompactionPrompt(compactionPrompt);
    if (compaction !== true)
      throw failure('INVALID_SELECTION', 'Enable compaction before selecting its summary prompt');
  }
  const seen = new Set();
  const modelLimits = payload.limit.modelLimits
    .map((row) => {
      if (
        !exactObject(row, ['id', 'limit']) ||
        !Number.isInteger(row.id) ||
        row.id < 0 ||
        row.id > 2147483647 ||
        !Number.isInteger(row.limit) ||
        row.limit < 1 ||
        row.limit > 2147483647 ||
        seen.has(row.id)
      )
        throw failure('INVALID_SELECTION', 'Use unique model IDs and positive int32 limits');
      seen.add(row.id);
      return { id: row.id, limit: row.limit };
    })
    .sort((a, b) => a.id - b.id);
  return {
    revision: payload.revision,
    capsule: payload.capsule,
    localization: { enabled: payload.localization.enabled, locale: payload.localization.locale },
    limit: { enabled: payload.limit.enabled, modelLimits },
    compaction,
    compactionPrompt,
  };
}

function normalizeCompactionPrompt(prompt) {
  if (
    !exactObject(prompt, ['mode', 'text']) ||
    !['native', 'custom'].includes(prompt.mode) ||
    typeof prompt.text !== 'string' ||
    !prompt.text.isWellFormed() ||
    prompt.text.includes('\0') ||
    (prompt.mode === 'native' && prompt.text !== '') ||
    (prompt.mode === 'custom' && /^[\s\p{White_Space}]*$/u.test(prompt.text)) ||
    Buffer.byteLength(prompt.text, 'utf8') > COMPACTION_PROMPT_MAX_BYTES
  )
    throw failure(
      'INVALID_COMPACTION_PROMPT',
      'Use a non-empty, valid Unicode custom prompt within the UTF-8 byte limit, or an empty native prompt',
    );
  return { mode: prompt.mode, text: prompt.text };
}

export function validateFeatureApply(payload, installedLimits = []) {
  const desired = normalizeFeatureApply(payload);
  for (const row of desired.limit.modelLimits) {
    if (
      (row.limit < 256000 || row.limit > 983040) &&
      !installedLimits.some((installed) => installed.id === row.id && installed.limit === row.limit)
    )
      throw failure(
        'INVALID_SELECTION',
        'Use limits from 256000 to 983040 for new or changed values',
      );
  }
  return desired;
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function operationDirectory(key) {
  if (!/^[a-f0-9]{64}$/.test(key)) throw failure('INVALID_OPERATION', 'Invalid operation');
  return path.join(agyctlHome(), 'management', 'features', key);
}

function draftsDirectory() {
  return path.join(agyctlHome(), 'management', 'drafts');
}

function draftPath(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
    throw failure('INVALID_DRAFT', 'Invalid draft');
  return path.join(draftsDirectory(), `${id}.json`);
}

function readDocument(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function atomicWrite(filename, document) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(document)}\n`, { flag: 'wx', mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(temporary, filename);
      return;
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
        attempt === 5
      )
        throw error;
      // Windows readers can briefly deny delete sharing; retry the same atomic publication.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

// A holder that dies between acquiring and releasing leaves state.lock behind.
// Record enough to identify it and reclaim locks that provably have no live
// holder, so a crashed apply never blocks every future settings operation.
const LOCK_WRITE_GRACE_MS = 10_000;
const LOCK_MAX_AGE_MS = 30 * 60_000;

function holderProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return error.code === 'EPERM';
  }
}

function readLockHolder(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

function lockIsStale(filename) {
  let age;
  try {
    age = Date.now() - fs.statSync(filename).mtimeMs;
  } catch {
    return true; // vanished between attempts; let the retry acquire it
  }
  const holder = readLockHolder(filename);
  if (!holder) return age > LOCK_WRITE_GRACE_MS;
  const alive = holderProcessAlive(holder.pid);
  if (alive === false) return true;
  // A live or unverifiable holder (e.g. another host's pid) can only be
  // evicted by age; an operation should never legitimately hold this long.
  return age > LOCK_MAX_AGE_MS;
}

export function withLock(key, action) {
  const directory = operationDirectory(key);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'state.lock');
  const token = randomUUID();
  let descriptor;
  for (let attempt = 0; ; attempt++) {
    try {
      descriptor = fs.openSync(filename, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt > 0 || !lockIsStale(filename))
        throw failure('OPERATION_BUSY', 'An operation is already being updated; try again');
      try {
        fs.unlinkSync(filename);
      } catch {
        // Another process reclaimed it first; the retry reports the contention.
      }
    }
  }
  try {
    fs.writeFileSync(
      descriptor,
      `${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`,
    );
    return action(path.join(directory, 'state.json'));
  } finally {
    fs.closeSync(descriptor);
    // Unlink only when we still own the lock; after a reclaim race the file
    // belongs to the successor and deleting it would break their exclusion.
    try {
      if (readLockHolder(filename)?.token === token) fs.unlinkSync(filename);
    } catch {
      // Unreadable or already gone; nothing to clean.
    }
  }
}

function operationView(operation) {
  if (!operation) return null;
  return {
    id: operation.id,
    state: operation.state,
    ...(operation.error ? { error: operation.error, code: operation.code } : {}),
  };
}

function draftCommands(id) {
  return {
    preflight: `npm run settings:preflight -- --draft ${id}`,
    apply: `npm run settings:apply -- --draft ${id}`,
    applyWithCleanup: `npm run settings:apply -- --draft ${id} --cleanup-sidecars`,
    status: 'npm run settings:status',
  };
}

function draftView(draft) {
  if (!draft) return null;
  return {
    id: draft.id,
    revision: draft.desired.revision,
    createdAt: draft.createdAt,
    commands: draftCommands(draft.id),
  };
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function readOperation(key) {
  const filename = path.join(operationDirectory(key), 'state.json');
  const operation = readDocument(filename);
  if (!operation || !activeStates.has(operation.state)) return operation;
  if (Date.now() - Date.parse(operation.updatedAt) < 30000 || alive(operation.pid))
    return operation;
  return {
    ...operation,
    state: 'failed',
    code: 'WORKER_STOPPED',
    error: 'The background operation stopped; reload before trying again',
  };
}

function selectionState(target, adapter) {
  const installationId = digest(target.asarPath);
  const filename = path.join(
    adapter.defaultStateRoot(),
    'installations',
    installationId,
    'selection.json',
  );
  const raw = readDocument(filename);
  if (raw === null) return { locale: null, hash: 'absent', format: null };
  const selected = adapter.localizationCli().decodeSelectionSnapshot(raw, filename);
  if (selected.installationId !== installationId)
    throw failure('STATE_UNAVAILABLE', 'Localization state cannot be verified');
  const { manifest } = adapter
    .localizationCli()
    .readValidatedArtifact(
      path.join(adapter.defaultStateRoot(), 'artifacts', selected.artifactId),
      { artifactId: selected.artifactId, locale: selected.locale },
    );
  return {
    locale: selected.locale,
    hash: sha256File(filename),
    format: manifest.schemaVersion === 2 ? 'dom' : 'ast',
  };
}

async function snapshot(asarPath) {
  const target = inspectHostTarget(asarPath ?? findAsarPath());
  const adapter = await import('./host-patch.mjs');
  // The Go status reads are the slowest stages; start them first so the
  // archive verification below overlaps the binary scans.
  const [rawLimit, rawCompaction, host, native] = await Promise.all([
    runAgyctlAsync(['limit', 'status', '--binary', target.binaryPath]),
    runAgyctlAsync(['compaction', 'status', '--binary', target.binaryPath]),
    Promise.resolve().then(() => adapter.hostPatchStatus({ asarPath: target.asarPath })),
    runAgyctlAsync(['native', 'status', '--binary', target.binaryPath]),
  ]);
  const limit = normalizeNativeLimitStatus(rawLimit, new Date().toISOString());
  if (rawCompaction.binary_sha256 !== limit.binarySha256)
    throw failure(
      'REVISION_CHANGED',
      'The Language Server changed while reading settings; reload and try again',
    );
  const nativeBinding = nativeExpectation(native);
  if (native.current_sha256 !== limit.binarySha256)
    throw failure(
      'REVISION_CHANGED',
      'The Language Server changed while reading settings; reload and try again',
    );
  if (native.file_state === 'drift')
    throw failure('STATE_UNAVAILABLE', 'The native patch state cannot be verified');
  if (!['patched', 'original'].includes(limit.patchKind))
    throw failure('STATE_UNAVAILABLE', 'The installed model limits cannot be verified');
  const compactionPending = !!rawCompaction.prepare_record || native.file_state === 'pending';
  const compactionEnabled = compactionPending
    ? null
    : nativeBinding
      ? native.features.compaction
      : rawCompaction.file_state === 'managed-output'
        ? true
        : rawCompaction.file_state === 'registered-input'
          ? false
          : null;
  const recordedPrompt = nativeBinding
    ? native.features.compaction_prompt
    : rawCompaction.compaction_prompt;
  const compactionPrompt =
    compactionEnabled === true && recordedPrompt != null
      ? normalizeCompactionPrompt(recordedPrompt)
      : null;
  const selection = selectionState(target, adapter);
  if (host.features.localization && !selection.locale)
    throw failure('STATE_UNAVAILABLE', 'Localization has no verified language selection');
  const binding = {
    target,
    asar: host.currentHash,
    unpacked: host.unpackedHash,
    receipt: host.receipt,
    executable: sha256FileCached(target.executablePath),
    // The Go status already hashed these exact binary bytes during this read;
    // hashing them again here would add a second full-file pass without new
    // information.
    binary: limit.binarySha256,
    selection: selection.hash,
    savedLimits: limit.savedModelLimits,
    settingsState: limit.settingsState,
    compactionState: rawCompaction.file_state,
    compactionPrepare: rawCompaction.prepare_record ?? null,
    compactionPrompt,
    native: nativeBinding ?? {
      fileState: native.file_state,
      prepare: native.prepare_record ?? null,
    },
  };
  const features = {
    capsule: { enabled: host.features.capsule },
    localization: {
      enabled: host.features.localization,
      locale: host.features.localization ? selection.locale : null,
      format: host.features.localization ? (selection.format ?? null) : null,
    },
    limit: {
      enabled: limit.patchKind === 'patched',
      modelLimits: limit.modelLimits,
      savedModelLimits: limit.savedModelLimits,
    },
    compaction: {
      enabled: compactionEnabled,
      fileState: rawCompaction.file_state,
      pending: compactionPending,
      prompt: compactionPrompt,
      promptMaxBytes:
        native.compaction_prompt_max_bytes ?? rawCompaction.compaction_prompt_max_bytes ?? null,
      retentionBudgetBytes:
        native.compaction_retention_budget_bytes ??
        rawCompaction.compaction_retention_budget_bytes ??
        null,
    },
  };
  return {
    target,
    host,
    rawLimit,
    rawCompaction,
    native,
    features,
    revision: digest(JSON.stringify(binding)),
  };
}

function readDraftDocument(id) {
  const filename = draftPath(id);
  const draft = readDocument(filename);
  if (!draft) throw failure('INVALID_DRAFT', 'No saved settings draft with that id');
  if (
    draft.schema !== 1 ||
    draft.id !== id ||
    typeof draft.root !== 'string' ||
    !draft.target?.asarPath ||
    digest(draft.target.asarPath) !== draft.installationKey
  )
    throw failure('INVALID_DRAFT', 'The saved settings draft cannot be verified');
  normalizeFeatureApply(draft.desired);
  return draft;
}

function readLatestDraft(key) {
  const pointer = readDocument(path.join(operationDirectory(key), 'draft.json'));
  if (!pointer?.id) return null;
  try {
    const draft = readDraftDocument(pointer.id);
    return draft.installationKey === key ? draft : null;
  } catch {
    return null;
  }
}

export async function readFeatures({ asarPath } = {}) {
  const state = await snapshot(asarPath);
  const key = digest(state.target.asarPath);
  return {
    revision: state.revision,
    installation: { version: state.target.version },
    features: state.features,
    catalog: await readModelCatalog(state.target.binaryPath),
    draft: draftView(readLatestDraft(key)),
    operation: operationView(readOperation(key)),
  };
}

function sameLimits(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

function limitChanges(desired, current) {
  return (
    desired.enabled !== current.enabled ||
    (desired.enabled && !sameLimits(desired.modelLimits, current.modelLimits))
  );
}

function samePrompt(first, second) {
  return first?.mode === second?.mode && first?.text === second?.text;
}

function compactionChanges(desired, current) {
  return (
    desired.compaction !== null &&
    (desired.compaction !== current.enabled ||
      (desired.compaction &&
        desired.compactionPrompt !== null &&
        !samePrompt(desired.compactionPrompt, current.prompt)))
  );
}

function validatePatchCombination(desired, features, native) {
  if (
    desired.compactionPrompt?.mode === 'custom' &&
    (!Number.isInteger(features.compaction.promptMaxBytes) ||
      features.compaction.promptMaxBytes < 1 ||
      Buffer.byteLength(desired.compactionPrompt.text, 'utf8') > features.compaction.promptMaxBytes)
  )
    throw failure(
      'COMPACTION_UNAVAILABLE',
      'The installed binary has no verified capacity for this custom summary prompt',
    );
  if (
    features.compaction.pending &&
    (limitChanges(desired.limit, features.limit) || compactionChanges(desired, features.compaction))
  )
    throw failure(
      'COMPACTION_RECOVERY_REQUIRED',
      'Resolve the unfinished compaction operation before trying again',
    );
  if (native.verified) return;
  if (compactionChanges(desired, features.compaction)) {
    if (desired.limit.enabled || features.limit.enabled)
      throw failure(
        'INVALID_SELECTION',
        'Turn model context limits off before changing the compaction patch',
      );
  }
  if (limitChanges(desired.limit, features.limit) && features.compaction.enabled)
    throw failure(
      'INVALID_SELECTION',
      'Restore the compaction patch before changing model context limits',
    );
}

function compactionPreflight(state, desired) {
  if (!compactionChanges(desired, state.features.compaction)) return null;
  if (state.rawCompaction.prepare_record)
    throw failure(
      'COMPACTION_RECOVERY_REQUIRED',
      'Resolve the unfinished compaction operation before trying again',
    );
  const binary = state.target.binaryPath;
  if (desired.compaction === false && state.features.compaction.enabled === null)
    throw failure(
      'COMPACTION_UNAVAILABLE',
      'The compaction state is unknown; leave it unchanged until it can be verified',
    );
  if (desired.compaction) {
    try {
      const preview = runAgyctl([
        'compaction',
        'patch',
        '--binary',
        binary,
        ...compactionPromptArguments(desired),
      ]);
      return preview.binary_sha256_after;
    } catch (error) {
      if (!error.refusal) throw error;
      throw failure(
        'COMPACTION_UNAVAILABLE',
        'The installed binary cannot receive the compaction patch; reload the actual state',
      );
    }
  }
  if (!state.rawCompaction.sibling_backup?.verified && !state.rawCompaction.repo_backup?.verified)
    throw failure(
      'COMPACTION_BACKUP_UNAVAILABLE',
      'The original compaction backup cannot be verified',
    );
  return null;
}

function localizationDesired(desired) {
  return desired.localization.enabled && desired.localization.locale !== 'en';
}

function validateChangedLimits(desired, current) {
  if (
    limitChanges(desired, current) &&
    desired.enabled &&
    desired.modelLimits.some((row) => row.id === 0)
  )
    throw failure('INVALID_SELECTION', 'New model mappings require IDs greater than zero');
}

export async function queueFeatureApply(payload, { asarPath } = {}) {
  const normalized = normalizeFeatureApply(payload);
  const state = await snapshot(asarPath);
  if (normalized.revision !== state.revision)
    throw failure('REVISION_CHANGED', 'The installation changed; reload and try again');
  const desired = validateFeatureApply(normalized, state.features.limit.modelLimits);
  validateChangedLimits(desired.limit, state.features.limit);
  validatePatchCombination(desired, state.features, state.native);
  const key = digest(state.target.asarPath);
  const operation = readOperation(key);
  if (activeStates.has(operation?.state))
    throw failure('OPERATION_BUSY', 'An operation is already waiting or applying');
  const now = new Date().toISOString();
  const draft = {
    schema: 1,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    installationKey: key,
    root: fs.realpathSync(repoRoot),
    target: state.target,
    desired,
  };
  fs.mkdirSync(draftsDirectory(), { recursive: true, mode: 0o700 });
  atomicWrite(draftPath(draft.id), draft);
  fs.mkdirSync(operationDirectory(key), { recursive: true, mode: 0o700 });
  atomicWrite(path.join(operationDirectory(key), 'draft.json'), { schema: 1, id: draft.id });
  return { draft: draftView(draft), operation: operationView(operation) };
}

function updateOperation(key, id, allowed, updates) {
  return withLock(key, (filename) => {
    const operation = readDocument(filename);
    if (operation?.id !== id || !allowed.includes(operation.state)) return null;
    Object.assign(operation, updates, { updatedAt: new Date().toISOString() });
    atomicWrite(filename, operation);
    return operation;
  });
}

export async function cancelFeatureApply(payload, { asarPath } = {}) {
  if (
    !exactObject(payload, ['id']) ||
    typeof payload.id !== 'string' ||
    !/^[a-f0-9-]{36}$/.test(payload.id)
  )
    throw failure('INVALID_OPERATION', 'Invalid operation');
  const target = inspectHostTarget(asarPath ?? findAsarPath());
  const operation = updateOperation(digest(target.asarPath), payload.id, ['waiting', 'preparing'], {
    state: 'cancelled',
  });
  if (!operation) throw failure('CANNOT_CANCEL', 'The operation has already started or finished');
  return { operation: operationView(operation) };
}

function processState(state, adapter) {
  const client = adapter.clientProcessState(state.target.asarPath).state;
  const server = state.rawLimit.language_server_running;
  if (client === 'unknown' || typeof server !== 'boolean')
    throw failure('PROCESS_UNKNOWN', 'Cannot confirm the app has exited; no changes were made');
  return client === 'closed' && server === false;
}

function assertClosed(target, adapter) {
  adapter.ensureClientClosedFor(target.asarPath);
  const raw = runAgyctl(['limit', 'status', '--binary', target.binaryPath]);
  if (typeof raw.language_server_running !== 'boolean')
    throw failure('PROCESS_UNKNOWN', 'Cannot confirm the app has exited');
  if (raw.language_server_running)
    throw failure('CLIENT_RUNNING', 'Quit Antigravity yourself before applying');
}

function modelArguments(values) {
  return ['--model-limits', values.map(({ id, limit }) => `${id}=${limit}`).join(',')];
}

function compactionPromptArguments(desired) {
  if (desired.compactionPrompt === null) return [];
  const { mode, text } = desired.compactionPrompt;
  return ['--prompt-mode', mode, ...(mode === 'custom' ? ['--prompt', text] : [])];
}

function preflightLimits(state, desired) {
  if (!limitChanges(desired, state.features.limit)) return;
  if (state.rawLimit.prepare_record)
    throw failure(
      'LIMIT_RECOVERY_REQUIRED',
      'Resolve the unfinished limit operation before trying again',
    );
  let binary = state.target.binaryPath;
  if (state.features.limit.enabled) {
    if (
      state.rawLimit.settings_state !== 'applied-unrecorded' &&
      !state.rawLimit.sibling_backup?.verified
    )
      throw failure(
        'LIMIT_BACKUP_UNAVAILABLE',
        'The original model-limit backup cannot be verified',
      );
    binary = state.rawLimit.sibling_backup?.verified
      ? state.rawLimit.sibling_backup.path
      : `${binary}.orig`;
    const original = runAgyctl(['limit', 'status', '--binary', binary]);
    if (original.patch_state?.kind !== 'original')
      throw failure(
        'LIMIT_BACKUP_UNAVAILABLE',
        'The original model-limit backup cannot be verified',
      );
    const values = state.features.limit.modelLimits;
    const currentArguments =
      state.rawLimit.patch_state.encoding === 'linked-v2'
        ? modelArguments(values)
        : ['--ids', values.map((row) => row.id).join(','), '--limit', String(values[0].limit)];
    const reproduced = runAgyctl([
      'limit',
      'patch',
      '--binary',
      binary,
      ...currentArguments,
      '--dry-run',
    ]);
    if (reproduced.binary_sha256_after !== state.rawLimit.binary_sha256)
      throw failure(
        'LIMIT_BACKUP_UNAVAILABLE',
        'The original backup does not reproduce the installed limits',
      );
  }
  if (desired.enabled)
    runAgyctl([
      'limit',
      'patch',
      '--binary',
      binary,
      ...modelArguments(desired.modelLimits),
      '--dry-run',
    ]);
  return sha256File(binary);
}

function preflightNative(state, desired) {
  if (!state.native.verified) return null;
  const updates = {};
  if (limitChanges(desired.limit, state.features.limit))
    updates.limit = {
      enabled: desired.limit.enabled,
      model_limits: desired.limit.enabled ? desired.limit.modelLimits : [],
    };
  if (compactionChanges(desired, state.features.compaction)) {
    updates.compaction = desired.compaction;
    if (desired.compaction && desired.compactionPrompt !== null)
      updates.compaction_prompt = desired.compactionPrompt;
  }
  if (!Object.keys(updates).length && !state.native.recipe_update_required) return null;
  const plan = runAgyctl([
    'native',
    'plan',
    '--binary',
    state.target.binaryPath,
    '--desired',
    JSON.stringify(updates),
  ]);
  assertNativeExpectation(state.native, plan.expected);
  return { updates, expected: plan.expected };
}

async function applyHost(state, desired, adapter, prepared, log) {
  const target = state.target;
  const options = {
    asarPath: target.asarPath,
    ensureClientClosed: () => assertClosed(target, adapter),
  };
  const remove = [];
  if (state.features.capsule.enabled && !desired.capsule) remove.push('capsule');
  if (state.features.localization.enabled && !localizationDesired(desired))
    remove.push('localization');
  if (remove.length) {
    assertClosed(target, adapter);
    log('Removing deselected Host features');
    await adapter.hostPatchRemove({ ...options, remove });
  }
  if (prepared) {
    if (remove.length)
      prepared = await prepareManagement({
        asarPath: target.asarPath,
        localization: true,
        locale: desired.localization.locale,
        capsule: desired.capsule && !state.features.capsule.enabled,
      });
    const { runReviewedHostOperation } = await import('./management.mjs');
    assertClosed(target, adapter);
    log('Applying the reviewed localization plan');
    await runReviewedHostOperation(
      {
        asarPath: target.asarPath,
        localizationPlan: prepared.localizationPlan,
        capsule: desired.capsule && !state.features.capsule.enabled,
      },
      true,
    );
  } else if (desired.capsule && !state.features.capsule.enabled) {
    const { assembleCapsule } = await import('../capsule-build.mjs');
    assertClosed(target, adapter);
    log('Applying Capsule');
    await adapter.hostPatchApply({
      ...options,
      features: { capsule: { code: assembleCapsule() } },
    });
  }
}

function beginDraftOperation(draft) {
  const key = draft.installationKey;
  return withLock(key, (filename) => {
    const existing = readOperation(key);
    if (activeStates.has(existing?.state))
      throw failure('OPERATION_BUSY', 'An operation is already waiting or applying');
    const now = new Date().toISOString();
    const value = {
      schema: 1,
      id: randomUUID(),
      state: 'preparing',
      createdAt: now,
      updatedAt: now,
      pid: process.pid,
      root: draft.root,
      target: draft.target,
      desired: draft.desired,
      draftId: draft.id,
    };
    atomicWrite(filename, value);
    return value;
  });
}

async function inspectDraft(draft) {
  const desired = normalizeFeatureApply(draft.desired);
  const adapter = await import('./host-patch.mjs');
  const clientState = adapter.clientProcessState(draft.target.asarPath).state;
  if (clientState === 'unknown')
    throw failure('PROCESS_UNKNOWN', 'Cannot confirm the app has exited; no changes were made');
  if (clientState === 'running')
    throw failure('CLIENT_RUNNING', 'Quit Antigravity yourself before applying');
  const state = await snapshot(draft.target.asarPath);
  if (state.revision !== desired.revision)
    throw failure('REVISION_CHANGED', 'The installation changed; reload and try again');
  validateFeatureApply(desired, state.features.limit.modelLimits);
  if (!processState(state, adapter))
    throw failure('CLIENT_RUNNING', 'Quit Antigravity yourself before applying');
  validateChangedLimits(desired.limit, state.features.limit);
  validatePatchCombination(desired, state.features, state.native);
  const nativePlan = preflightNative(state, desired);
  const originalLimitHash = state.native.verified ? null : preflightLimits(state, desired.limit);
  if (!state.native.verified) compactionPreflight(state, desired);
  const wantLocalization = localizationDesired(desired);
  const hostChanges =
    desired.capsule !== state.features.capsule.enabled ||
    wantLocalization !== state.features.localization.enabled ||
    (wantLocalization && desired.localization.locale !== state.features.localization.locale) ||
    (wantLocalization && state.features.localization.format === 'ast');
  if (hostChanges)
    adapter.composer.qualifyHostMutation(adapter.hostPatchIo({ asarPath: state.target.asarPath }));
  if (desired.capsule && !state.features.capsule.enabled) {
    const { assembleCapsule } = await import('../capsule-build.mjs');
    adapter.capsuleFeature.validate({ code: assembleCapsule() });
    adapter.assertCapsuleAnchors(state.target.asarPath);
  }
  let prepared;
  if (
    wantLocalization &&
    (!state.features.localization.enabled ||
      desired.localization.locale !== state.features.localization.locale ||
      state.features.localization.format === 'ast')
  ) {
    prepared = await prepareManagement({
      asarPath: state.target.asarPath,
      localization: true,
      locale: desired.localization.locale,
      capsule: desired.capsule && !state.features.capsule.enabled,
    });
  }
  const beforeApply = await snapshot(state.target.asarPath);
  if (beforeApply.revision !== desired.revision)
    throw failure('REVISION_CHANGED', 'The installation changed; reload and try again');
  assertClosed(state.target, adapter);
  return { desired, adapter, state, originalLimitHash, prepared, nativePlan };
}

async function executePreparedApply(operation, { cleanupSidecars = false } = {}) {
  const key = digest(operation.target.asarPath);
  const logPath = path.join(operationDirectory(key), `${operation.id}.log`);
  const log = (message) =>
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  let stage = operation.state;
  try {
    if (
      operation.schema !== 1 ||
      fs.realpathSync(repoRoot) !== operation.root ||
      digest(operation.target.asarPath) !== key
    )
      throw failure('INVALID_OPERATION', 'The saved operation cannot be verified');
    let cleanup;
    if (cleanupSidecars) {
      const target = inspectHostTarget(operation.target.asarPath);
      const state = await snapshot(target.asarPath);
      if (state.revision !== operation.desired.revision)
        throw failure(
          'REVISION_CHANGED',
          'The installation changed; reload before cleaning sidecars',
        );
      cleanup = cleanupOrphanSidecars(target);
      log(`Cleaned ${cleanup.cleaned} verified orphan sidecars`);
    }
    const { desired, adapter, state, originalLimitHash, prepared, nativePlan } = await inspectDraft(
      {
        ...operation,
        desired: operation.desired,
        target: operation.target,
      },
    );
    if (prepared) log('Prepared the selected localization artifact');
    if (!updateOperation(key, operation.id, ['preparing'], { state: 'applying' }))
      throw failure('CANNOT_CANCEL', 'The operation has already started or finished');
    stage = 'applying';
    await applyHost(state, desired, adapter, prepared, log);
    if (nativePlan) {
      assertClosed(state.target, adapter);
      log('Applying the reviewed native feature image');
      runAgyctl([
        'native',
        'apply',
        '--binary',
        state.target.binaryPath,
        '--desired',
        JSON.stringify(nativePlan.updates),
        '--expected',
        JSON.stringify(nativePlan.expected),
      ]);
    } else if (!state.native.verified && limitChanges(desired.limit, state.features.limit)) {
      if (sha256File(state.target.binaryPath) !== state.rawLimit.binary_sha256)
        throw failure(
          'REVISION_CHANGED',
          'The Language Server changed; reload before applying limits',
        );
      assertClosed(state.target, adapter);
      if (state.features.limit.enabled) {
        log('Restoring the original Language Server before changing limits');
        runAgyctl(['limit', 'restore', '--binary', state.target.binaryPath]);
      }
      if (desired.limit.enabled) {
        if (sha256File(state.target.binaryPath) !== originalLimitHash)
          throw failure(
            'REVISION_CHANGED',
            'The Language Server changed; reload before applying limits',
          );
        assertClosed(state.target, adapter);
        log('Applying the selected per-model limits');
        runAgyctl([
          'limit',
          'patch',
          '--binary',
          state.target.binaryPath,
          ...modelArguments(desired.limit.modelLimits),
          '--apply',
        ]);
      }
    }
    if (!state.native.verified && compactionChanges(desired, state.features.compaction)) {
      if (sha256File(state.target.binaryPath) !== state.rawCompaction.binary_sha256)
        throw failure(
          'REVISION_CHANGED',
          'The Language Server changed; reload before applying compaction',
        );
      assertClosed(state.target, adapter);
      if (state.features.compaction.enabled) {
        log('Restoring the original summary prompt');
        runAgyctl(['compaction', 'restore', '--binary', state.target.binaryPath]);
      }
      if (desired.compaction) {
        log('Applying the compaction summary patch');
        runAgyctl([
          'compaction',
          'patch',
          '--binary',
          state.target.binaryPath,
          ...compactionPromptArguments(desired),
          '--apply',
        ]);
      }
    }
    const actual = await snapshot(state.target.asarPath);
    if (
      actual.features.capsule.enabled !== desired.capsule ||
      actual.features.localization.enabled !== localizationDesired(desired) ||
      (localizationDesired(desired) &&
        actual.features.localization.locale !== desired.localization.locale) ||
      (localizationDesired(desired) && actual.features.localization.format !== 'dom') ||
      actual.features.limit.enabled !== desired.limit.enabled ||
      (desired.limit.enabled &&
        !sameLimits(actual.features.limit.modelLimits, desired.limit.modelLimits)) ||
      (desired.compaction !== null && actual.features.compaction.enabled !== desired.compaction) ||
      (desired.compaction === true &&
        desired.compactionPrompt !== null &&
        !samePrompt(actual.features.compaction.prompt, desired.compactionPrompt)) ||
      (nativePlan && actual.native.recipe_update_required)
    )
      throw failure('VERIFY_FAILED', 'Some changes did not verify; reload the actual state');
    log('Verified the requested feature changes');
    const succeeded = updateOperation(key, operation.id, ['applying'], {
      state: 'succeeded',
      actual: actual.features,
    });
    return {
      operation: operationView(succeeded),
      features: actual.features,
      ...(cleanup ? { cleanup } : {}),
    };
  } catch (error) {
    log(error.stack ?? String(error));
    let actual;
    try {
      actual = (await snapshot(operation.target.asarPath)).features;
    } catch (readError) {
      log(`Could not read final state: ${readError.stack ?? readError}`);
    }
    updateOperation(key, operation.id, ['waiting', 'preparing', 'applying'], {
      state: 'failed',
      code: error.safeForPanel ? error.code : 'APPLY_FAILED',
      error: error.safeForPanel
        ? error.message
        : stage === 'applying'
          ? 'Apply failed; some changes may remain; reload the actual state'
          : 'Preparation failed; no installation changes were made',
      ...(actual ? { actual } : {}),
    });
    throw error;
  }
}

export async function preflightFeatureDraft(id, options = {}) {
  const draft = readDraftDocument(id);
  let cleanup;
  if (options.cleanupSidecars) {
    const target = inspectHostTarget(draft.target.asarPath);
    const state = await snapshot(target.asarPath);
    if (state.revision !== draft.desired.revision)
      throw failure(
        'REVISION_CHANGED',
        'The installation changed; reload before cleaning sidecars',
      );
    const inspection = inspectOrphanSidecars(target);
    cleanup = {
      cleaned: 0,
      candidates: inspection.candidates.map(({ pid, plugin, sidecar }) => ({
        pid,
        plugin,
        sidecar,
      })),
    };
    if (cleanup.candidates.length)
      return {
        draft: draftView(draft),
        preflight: false,
        cleanup,
        reason: 'Verified orphan sidecars must exit before the remaining preflight checks',
      };
  }
  await inspectDraft(draft);
  return {
    draft: draftView(draft),
    preflight: true,
    ...(cleanup ? { cleanup } : {}),
  };
}

export async function applyFeatureDraft(id, options = {}) {
  const draft = readDraftDocument(id);
  const operation = beginDraftOperation(draft);
  return executePreparedApply(operation, { cleanupSidecars: options.cleanupSidecars });
}

/** Leftover waiting workers no longer wait; they refuse while the client still runs. */
export async function runFeatureOperation(key, id) {
  const operation = updateOperation(key, id, ['waiting'], { pid: process.pid, state: 'preparing' });
  if (!operation) return;
  await executePreparedApply(operation);
}
