import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeNativeLimitStatus } from '../../src/plugin/lib/limit-status-core.mjs';
import { prepareManagement } from '../manage.mjs';
import { repoRoot, runAgyctl } from './agyctl.mjs';
import { cleanupOrphanSidecars, inspectOrphanSidecars } from './client-processes.mjs';
import { inspectHostTarget } from './client-target.mjs';
import { agyctlHome, findAsarPath, sha256File, sha256FileCached } from './install-paths.mjs';
import { readModelCatalog } from './model-catalog.mjs';

const activeStates = new Set(['waiting', 'preparing', 'applying']);
const locales = new Set(['en', 'zh-Hant-TW', 'zh-Hans-CN', 'ja-JP']);

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

export function validateFeatureApply(payload) {
  if (
    !exactObject(payload, ['revision', 'capsule', 'localization', 'limit']) ||
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
    (payload.limit.enabled && payload.limit.modelLimits.length === 0)
  )
    throw failure('INVALID_SELECTION', 'Check the feature selections and model limits');
  const seen = new Set();
  const modelLimits = payload.limit.modelLimits
    .map((row) => {
      if (
        !exactObject(row, ['id', 'limit']) ||
        !Number.isInteger(row.id) ||
        row.id < 0 ||
        row.id > 2147483647 ||
        !Number.isInteger(row.limit) ||
        row.limit < 256000 ||
        row.limit > 896000 ||
        seen.has(row.id)
      )
        throw failure('INVALID_SELECTION', 'Use unique model IDs and limits from 256000 to 896000');
      seen.add(row.id);
      return { id: row.id, limit: row.limit };
    })
    .sort((a, b) => a.id - b.id);
  return {
    revision: payload.revision,
    capsule: payload.capsule,
    localization: { enabled: payload.localization.enabled, locale: payload.localization.locale },
    limit: { enabled: payload.limit.enabled, modelLimits },
  };
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

function withLock(key, action) {
  const directory = operationDirectory(key);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'state.lock');
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST')
      throw failure('OPERATION_BUSY', 'An operation is already being updated; try again');
    throw error;
  }
  try {
    return action(path.join(directory, 'state.json'));
  } finally {
    fs.closeSync(descriptor);
    fs.unlinkSync(filename);
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
  const host = adapter.hostPatchStatus({ asarPath: target.asarPath });
  const rawLimit = runAgyctl(['limit', 'status', '--binary', target.binaryPath]);
  const limit = normalizeNativeLimitStatus(rawLimit, new Date().toISOString());
  if (!['patched', 'original'].includes(limit.patchKind))
    throw failure('STATE_UNAVAILABLE', 'The installed model limits cannot be verified');
  const selection = selectionState(target, adapter);
  if (host.features.localization && !selection.locale)
    throw failure('STATE_UNAVAILABLE', 'Localization has no verified language selection');
  const binding = {
    target,
    asar: host.currentHash,
    unpacked: host.unpackedHash,
    receipt: host.receipt,
    executable: sha256FileCached(target.executablePath),
    binary: sha256FileCached(target.binaryPath),
    selection: selection.hash,
    savedLimits: limit.savedModelLimits,
    settingsState: limit.settingsState,
  };
  if (
    binding.binary !== limit.binarySha256 ||
    sha256FileCached(target.asarPath) !== host.currentHash
  )
    throw failure('REVISION_CHANGED', 'The installation changed; reload and try again');
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
  };
  return { target, host, rawLimit, features, revision: digest(JSON.stringify(binding)) };
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
  validateFeatureApply(draft.desired);
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
  const desired = validateFeatureApply(payload);
  const state = await snapshot(asarPath);
  if (desired.revision !== state.revision)
    throw failure('REVISION_CHANGED', 'The installation changed; reload and try again');
  validateChangedLimits(desired.limit, state.features.limit);
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
  const desired = validateFeatureApply(draft.desired);
  const adapter = await import('./host-patch.mjs');
  const clientState = adapter.clientProcessState(draft.target.asarPath).state;
  if (clientState === 'unknown')
    throw failure('PROCESS_UNKNOWN', 'Cannot confirm the app has exited; no changes were made');
  if (clientState === 'running')
    throw failure('CLIENT_RUNNING', 'Quit Antigravity yourself before applying');
  const state = await snapshot(draft.target.asarPath);
  if (state.revision !== desired.revision)
    throw failure('REVISION_CHANGED', 'The installation changed; reload and try again');
  if (!processState(state, adapter))
    throw failure('CLIENT_RUNNING', 'Quit Antigravity yourself before applying');
  validateChangedLimits(desired.limit, state.features.limit);
  const originalLimitHash = preflightLimits(state, desired.limit);
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
  return { desired, adapter, state, originalLimitHash, prepared };
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
    const { desired, adapter, state, originalLimitHash, prepared } = await inspectDraft({
      ...operation,
      desired: operation.desired,
      target: operation.target,
    });
    if (prepared) log('Prepared the selected localization artifact');
    if (!updateOperation(key, operation.id, ['preparing'], { state: 'applying' }))
      throw failure('CANNOT_CANCEL', 'The operation has already started or finished');
    stage = 'applying';
    await applyHost(state, desired, adapter, prepared, log);
    if (limitChanges(desired.limit, state.features.limit)) {
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
    const actual = await snapshot(state.target.asarPath);
    if (
      actual.features.capsule.enabled !== desired.capsule ||
      actual.features.localization.enabled !== localizationDesired(desired) ||
      (localizationDesired(desired) &&
        actual.features.localization.locale !== desired.localization.locale) ||
      (localizationDesired(desired) && actual.features.localization.format !== 'dom') ||
      actual.features.limit.enabled !== desired.limit.enabled ||
      (desired.limit.enabled &&
        !sameLimits(actual.features.limit.modelLimits, desired.limit.modelLimits))
    )
      throw failure('VERIFY_FAILED', 'Some changes did not verify; reload the actual state');
    log('Verified the actual installed features');
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
