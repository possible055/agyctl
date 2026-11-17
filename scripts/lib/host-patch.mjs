// Thin adapter between the existing Node callers and the built Host Composer.
// It loads the asar engine and file transaction, resolves localization bundle
// inputs, and implements the client-closed probe for mixed applies. All
// archive logic lives in the composer (plan §4).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { capsuleAnchorTokens, missingAnchorTokens } from './capsule-anchors.mjs';
import { inspectHostTarget } from './client-target.mjs';
import { replaceFileTransaction } from './file-transaction.mjs';
import { loadCapsuleFeature, loadCapsuleServedBundle, loadHostComposer } from './host-build.mjs';
import {
  agyctlHome,
  backupDir as defaultBackupDir,
  findAsarPath,
  languageServerPath,
} from './install-paths.mjs';
import { validateNativeExpectation } from './native-binding.mjs';

const require = createRequire(import.meta.url);
const requireLocalization = createRequire(import.meta.url);
const { loadAsarEngine } = require('../../scripts/vendor/asar-engine.cjs');
const composer = loadHostComposer();
const capsuleFeatureModule = loadCapsuleFeature();

export { composer };

export const capsuleFeature = capsuleFeatureModule.capsuleFeature;
export const buildCapsulePreloadHook = capsuleFeatureModule.buildCapsulePreloadHook;

export const engine = loadAsarEngine();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function defaultEngineBundlePath() {
  return path.join(REPO_ROOT, 'dist', 'localization', 'bundle', 'host-engine.cjs');
}

export function defaultPreloadBridgePath() {
  return path.join(REPO_ROOT, 'dist', 'localization', 'bundle', 'preload-bridge.cjs');
}

export function defaultDomEnginePath() {
  return path.join(REPO_ROOT, 'dist', 'localization', 'bundle', 'dom-engine.js');
}

export function defaultStateRoot() {
  return path.join(agyctlHome(), 'localization');
}

export function localizationProfiles() {
  const database = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'compat', 'localization', 'profiles.json'), 'utf8'),
  );
  if (database.schema !== 1 || !Array.isArray(database.profiles))
    throw new Error('Invalid localization profile database');
  return database.profiles;
}

/**
 * Refuses a client whose served web bundle lacks an anchor the capsule mounts
 * on. Read-only: the Language Server is parsed with bounded extraction and
 * never executed.
 */
export function assertCapsuleAnchors(asarPath) {
  const binaryPath = languageServerPath(asarPath);
  const scripts = loadCapsuleServedBundle().readServedScripts(binaryPath);
  if (!Object.hasOwn(scripts, 'main.js'))
    throw new Error(`The Language Server at ${binaryPath} serves no main.js web bundle`);
  const missing = missingAnchorTokens(Object.values(scripts));
  if (missing.length > 0)
    throw new Error(
      `The client's web bundle no longer contains the capsule anchors: ${missing.join(', ')}; update src/capsule/anchors.js before installing the capsule`,
    );
  return { tokens: capsuleAnchorTokens().length, bundles: Object.keys(scripts).length };
}

export function localizationCli() {
  requireLocalization('./localization-build.mjs').verifyLocalizationBuild();
  return requireLocalization('../../dist/localization/bundle/localization-cli.mjs');
}

export function resolveLocalizationProfile(options) {
  requireLocalization('./localization-build.mjs').verifyLocalizationBuild();
  const { resolveLocalizationProfile: resolve } = requireLocalization(
    '../../dist/localization/bundle/feature-provider.mjs',
  );
  return resolve(localizationProfiles(), { engine, ...options });
}

export function localizationNativeInventory(originalPath, profile) {
  requireLocalization('./localization-build.mjs').verifyLocalizationBuild();
  const { buildNativeInventory } = requireLocalization(
    '../../dist/localization/bundle/feature-provider.mjs',
  );
  return buildNativeInventory(engine, originalPath, profile);
}

export function localizationNativeEdits(originalPath, profile) {
  const adapterVersion = profile?.nativeAdapterVersion;
  if (!['2', '3'].includes(adapterVersion))
    throw new Error(`Unsupported native localization adapter version: ${adapterVersion}`);
  requireLocalization('./localization-build.mjs').verifyLocalizationBuild();
  const { buildReviewedNativeEdits } = requireLocalization(
    '../../dist/localization/bundle/feature-provider.mjs',
  );
  return buildReviewedNativeEdits(engine, originalPath, adapterVersion).map(
    ({ file, anchor, replaceAnchor }) => ({
      file,
      anchor,
      replaceAnchor,
    }),
  );
}

/** Loads the localization runtime inputs from the built bundles. */
export function loadLocalizationInputs({
  enginePath = defaultEngineBundlePath(),
  preloadBridgePath = defaultPreloadBridgePath(),
  profileId,
  stateRoot = defaultStateRoot(),
  adapterEdits = [],
  files = {},
  artifactId,
  installationId,
  observedSource,
} = {}) {
  const { readFileSync } = require('node:fs');
  if (!profileId) throw new Error('Localization inputs require a profileId');
  const profile = localizationProfiles().find((entry) => entry.profileId === profileId);
  if (profile?.hostAdapter) {
    if (!/^[a-f0-9]{64}$/.test(artifactId ?? ''))
      throw new Error('This localization adapter requires an explicit artifactId');
    if (!/^[a-f0-9]{64}$/.test(installationId ?? ''))
      throw new Error(
        'This localization adapter requires the selection installationId (sha256 of the asar path)',
      );
    if (adapterEdits.length || Object.keys(files).length)
      throw new Error(
        'Reviewed runtime inputs cannot be combined with caller adapter edits or files',
      );
    const directory = path.join(stateRoot, 'artifacts', artifactId);
    const { manifest } = localizationCli().readValidatedArtifact(directory, { artifactId });
    if (!manifest.sourceIdentity)
      throw new Error('Localization artifact has no observed source identity');
    adapterEdits = [
      {
        file: profile.hostAdapter.file,
        anchor: profile.hostAdapter.anchor,
        replaceAnchor:
          "win.loadURL = (targetUrl, options) => require('./agyctl-localization/host-engine.js').loadLocalizedURL(hubWcv.webContents, targetUrl, options);",
      },
    ];
    files = {
      // schemaVersion 2 binds only the tool state root and the selection
      // installation; artifact and locale resolve from selection.json on each
      // launch, so `agyctl select` takes effect without re-patching (plan §4.5).
      'dist/agyctl-localization/runtime-config.json': Buffer.from(
        JSON.stringify({
          schemaVersion: 2,
          stateRoot,
          installationId,
        }),
      ),
      'dist/agyctl-localization/dom-engine.js': readFileSync(defaultDomEnginePath()),
    };
    if (
      observedSource &&
      (observedSource.sourceIdentity !== manifest.sourceIdentity ||
        observedSource.lsSha256 !== (manifest.sourceBinarySha256 ?? null))
    )
      throw new Error('Localization artifact does not match the observed source');
    observedSource = observedSource ?? {
      sourceKind: manifest.sourceBinarySha256 ? 'ls-binary' : 'sample-dir',
      lsSha256: manifest.sourceBinarySha256 ?? null,
      sourceIdentity: manifest.sourceIdentity,
      nlsHelperCalleeName: profile.nlsHelper.calleeName,
      matchedProfileId: profile.profileId,
      warnings:
        profile.status === 'verified'
          ? []
          : [
              {
                code: 'UNTESTED_BUILD',
                message: `Profile ${profile.profileId} remains ${profile.status}; real-client acceptance is unverified`,
              },
            ],
    };
    if (manifest.sourceBinarySha256 && manifest.sourceBinarySha256 !== profile.lsSha256)
      observedSource.warnings.push({
        code: 'IDENTITY_DRIFT',
        message: `The prepared source binary differs from profile ${profile.profileId}; the reviewed asset hashes match`,
      });
  }
  return {
    engineFile: readFileSync(enginePath),
    preloadBridge: readFileSync(preloadBridgePath),
    profileId,
    stateRoot,
    adapterEdits,
    files,
    observedSource: observedSource ?? null,
  };
}

function clientRunningWindows(imageName) {
  let stdout;
  try {
    stdout = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return 'unknown';
  }
  const lines = stdout.trim().split(/\r?\n/);
  let invalid = false;
  for (const line of lines) {
    const row = /^"([^"]+)","\d+","[^"]*","\d+","[^"]*"$/.exec(line.trim());
    if (!row) invalid = true;
    else if (row[1].toLowerCase() === imageName.toLowerCase()) return 'running';
  }
  return invalid ? 'unknown' : 'closed';
}

function clientRunningPosix(executablePath) {
  let stdout;
  try {
    // Linux comm may be truncated; candidates need a separate exe lookup.
    // Darwin comm is argv[0] without arguments. -ww disables width limits.
    stdout = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,comm='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return 'unknown';
  }
  if (!stdout.trim()) return 'unknown';
  const imageName = path.basename(executablePath);
  let unknown = false;
  for (const line of stdout.trim().split(/\r?\n/)) {
    const row = /^(0|[1-9]\d*)\s+(.+)$/.exec(line.trim());
    if (!row) {
      unknown = true;
      continue;
    }
    const [, pid, command] = row;
    if (process.platform === 'linux') {
      if (command !== imageName && command !== imageName.slice(0, 15)) continue;
      try {
        const executable = execFileSync('ps', ['-p', pid, '-ww', '-o', 'exe='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (executable === executablePath) return 'running';
        if (!path.isAbsolute(executable) || /[\r\n]/.test(executable)) unknown = true;
      } catch {
        unknown = true;
      }
    } else {
      if (command === executablePath || command === imageName) return 'running';
      if (
        command === `(${imageName})` ||
        command === `(${imageName.slice(0, 16)})` ||
        command === '<defunct>'
      )
        unknown = true;
    }
  }
  return unknown ? 'unknown' : 'closed';
}

/** 'running' | 'closed' | 'unknown' for the client of the installation owning `asarPath`. */
export function clientProcessState(asarPath) {
  let target;
  try {
    target = inspectHostTarget(asarPath);
  } catch {
    return { state: 'unknown', imageName: null };
  }
  const imageName = path.basename(target.executablePath);
  return {
    state:
      process.platform === 'win32'
        ? clientRunningWindows(imageName)
        : clientRunningPosix(target.executablePath),
    imageName,
  };
}

/**
 * Confirms the Antigravity client for this installation is not running.
 * Refuses instead of guessing when the executable cannot be resolved or the
 * process check is unavailable (plan §9.2).
 */
export function ensureClientClosedFor(asarPath) {
  const { state, imageName } = clientProcessState(asarPath);
  if (state === 'running')
    throw new composer.ComposerError(
      'CLIENT_RUNNING',
      `${imageName} is running; close the client yourself before applying localization`,
    );
  if (state === 'unknown')
    throw new composer.ComposerError(
      'CLIENT_RUNNING_UNKNOWN',
      'The client process state could not be confirmed; refusing a localization apply',
    );
}

export function hostPatchIo({
  asarPath = findAsarPath(),
  backupDir = defaultBackupDir(),
  engine: engineOverride,
  executablePath,
  localizationProfiles: profileOverrides,
  logEvent,
} = {}) {
  const target = executablePath === undefined ? inspectHostTarget(asarPath) : null;
  return {
    asarPath: path.resolve(asarPath),
    backupDir: path.resolve(backupDir),
    engine: engineOverride ?? engine,
    transaction: replaceFileTransaction,
    capsuleFeature: loadCapsuleFeature().capsuleFeature,
    localizationFeature: () =>
      requireLocalization('./localization-feature.mjs').loadLocalizationFeature(
        profileOverrides ?? localizationProfiles(),
      ),
    executablePath: executablePath ?? target?.executablePath,
    ...(logEvent ? { logEvent } : {}),
  };
}

/**
 * Per-command JSONL log for the Host CLI (continuation plan §4.1). The writer
 * is created before any mutating composer call: creation failure aborts with
 * LOG_WRITE_FAILED. Write failures after a successful creation are tolerated
 * and reported separately so a committed transaction is never misreported
 * (plan §4.4).
 */
export async function createHostPatchLog({ installationId, required = true } = {}) {
  const logging = await import('../../dist/host/bundle/tooling-logging.mjs');
  return new logging.ToolingCommandLog({
    directory: path.join(agyctlHome(), 'localization', 'logs', installationId ?? 'offline'),
    component: 'host-cli',
    installationId,
    required,
  });
}

export function hostPatchStatus(options = {}) {
  const io = hostPatchIo(options);
  const status = composer.getHostStatus(io);
  let integrity;
  try {
    composer.qualifyHostMutation(io);
    integrity = { qualified: true, executablePath: io.executablePath };
  } catch (error) {
    if (error.code !== 'UNSUPPORTED_STATE') throw error;
    integrity = { qualified: false, executablePath: io.executablePath, reason: error.message };
  }
  return { ...status, integrity };
}

export function hostPatchPlan(options = {}) {
  const { features, baseProvenance, ...rest } = options;
  const io = hostPatchIo(rest);
  if (features?.capsule) assertCapsuleAnchors(io.asarPath);
  return composer.planHostPatch(io, {
    features: features ?? {},
    baseProvenance,
  });
}

export async function hostPatchApply(options = {}) {
  const { plan, features, baseProvenance, ensureClientClosed, transaction, log, ...rest } = options;
  const io = hostPatchIo(rest);
  if (features?.capsule) assertCapsuleAnchors(io.asarPath);
  if (plan) {
    // Plan-bound apply: the reviewed plan drives the operation and every
    // feature input is verified against its bindings before any write.
    return composer.applyHostPatch(io, {
      plan,
      features: features ?? {},
      ensureClientClosed,
      transaction,
      log,
    });
  }
  return composer.applyFeatures(io, {
    features: features ?? {},
    baseProvenance,
    ensureClientClosed,
    transaction,
    log,
  });
}

export async function hostPatchRemove(options = {}) {
  const { remove, ensureClientClosed, transaction, log, ...rest } = options;
  return composer.removeFeatures(hostPatchIo(rest), {
    remove,
    ensureClientClosed,
    transaction,
    log,
  });
}

export function loadReviewedHostPlan(planPath, { asarPath } = {}) {
  if (!path.isAbsolute(planPath)) throw new Error('Reviewed Host plan requires an absolute path');
  const documentBytes = fs.readFileSync(planPath);
  const document = JSON.parse(documentBytes.toString('utf8'));
  if (!document.inputs) throw new Error('Reviewed Host plan is missing its bundled feature inputs');
  for (const field of ['asarPath', 'backupDir'])
    if (typeof document[field] !== 'string' || !path.isAbsolute(document[field]))
      throw new Error(`Reviewed Host plan requires an absolute ${field}`);
  if (
    document.executablePath !== undefined &&
    (typeof document.executablePath !== 'string' || !path.isAbsolute(document.executablePath))
  )
    throw new Error('Reviewed Host plan requires an absolute executablePath');
  const target = composer.computeInstallationIdentity(document.asarPath);
  if (
    asarPath &&
    composer.computeInstallationIdentity(asarPath).installationId !== target.installationId
  )
    throw new composer.ComposerError(
      'PLAN_MISMATCH',
      'Reviewed Host plan targets a different installation',
    );
  const io = hostPatchIo({
    asarPath: document.asarPath,
    backupDir: document.backupDir,
    executablePath: document.executablePath,
  });
  const features = composer.decodeFeatureInputs(document.inputs);
  const reviewed = composer.inspectReviewedHostPlan(io, document, features);
  let localizationSelection = null;
  if (document.localizationSelection !== undefined) {
    const selection = document.localizationSelection;
    const input = features.localization;
    const configBytes = input?.files?.['dist/agyctl-localization/runtime-config.json'];
    const config = configBytes ? JSON.parse(configBytes.toString('utf8')) : null;
    if (
      typeof selection?.asarPath !== 'string' ||
      !path.isAbsolute(selection.asarPath) ||
      composer.computeInstallationIdentity(selection.asarPath).installationId !==
        target.installationId
    )
      throw new composer.ComposerError(
        'PLAN_MISMATCH',
        'Reviewed selection targets a different installation',
      );
    const installationId = createHash('sha256').update(selection.asarPath).digest('hex');
    if (selection.nativeBinding !== undefined) {
      validateNativeExpectation(selection.nativeBinding);
      if (selection.nativeBinding.base_sha256 !== selection.sourceBinarySha256)
        throw new composer.ComposerError(
          'PLAN_MISMATCH',
          'Reviewed native revision does not match the localization source',
        );
    }
    if (
      selection?.schemaVersion !== 1 ||
      !['en', 'zh-Hant-TW', 'zh-Hans-CN', 'ja-JP'].includes(selection.locale) ||
      !/^[a-f0-9]{64}$/.test(selection.artifactId ?? '') ||
      !/^[a-f0-9]{64}$/.test(selection.sourceIdentity ?? '') ||
      !/^[a-f0-9]{64}$/.test(selection.sourceBinarySha256 ?? '') ||
      !/^(?:[a-f0-9]{64}|absent)$/.test(selection.expectedSelectionSha256 ?? '') ||
      selection.installationId !== installationId ||
      config?.schemaVersion !== 2 ||
      config.installationId !== installationId ||
      config.stateRoot !== input?.stateRoot ||
      input.stateRoot !== defaultStateRoot() ||
      selection.sourceIdentity !== input.observedSource?.sourceIdentity ||
      selection.sourceBinarySha256 !== input.observedSource?.lsSha256
    )
      throw new composer.ComposerError(
        'PLAN_MISMATCH',
        'Reviewed localization selection does not match the Host inputs',
      );
    const { manifest } = localizationCli().readValidatedArtifact(
      path.join(input.stateRoot, 'artifacts', selection.artifactId),
      { artifactId: selection.artifactId, locale: selection.locale },
    );
    if (
      manifest.sourceIdentity !== selection.sourceIdentity ||
      manifest.sourceBinarySha256 !== selection.sourceBinarySha256
    )
      throw new composer.ComposerError(
        'PLAN_MISMATCH',
        'Reviewed artifact does not match the Host source',
      );
    localizationSelection = selection;
  }
  let nativeQualification;
  if (document.nativeQualification !== undefined) {
    const profile = localizationProfiles().find(
      (entry) => entry.profileId === features.localization?.profileId,
    );
    if (!profile)
      throw new composer.ComposerError(
        'PLAN_MISMATCH',
        'Reviewed native qualification requires a known adapter contract',
      );
    nativeQualification = localizationNativeInventory(
      reviewed.status.backupPath ?? io.asarPath,
      profile,
    );
    if (JSON.stringify(document.nativeQualification) !== JSON.stringify(nativeQualification))
      throw new composer.ComposerError(
        'PLAN_MISMATCH',
        'Reviewed native qualification changed since preparation',
      );
  }
  return {
    ...reviewed,
    planDocumentSha256: createHash('sha256').update(documentBytes).digest('hex'),
    localizationSelection,
    nativeQualification,
    asarPath: io.asarPath,
    backupDir: io.backupDir,
    executablePath: io.executablePath,
  };
}
