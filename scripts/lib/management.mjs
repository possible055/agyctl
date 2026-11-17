import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgyctl } from './agyctl.mjs';
import { agyctlHome, backupDir, sha256File } from './install-paths.mjs';
import {
  assertNativeExpectation,
  localizationContentIdentity,
  nativeExpectation,
} from './native-binding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

async function localizationSource(target) {
  const adapter = await import('./host-patch.mjs');
  const io = adapter.hostPatchIo({ ...target, backupDir: backupDir() });
  const status = adapter.hostPatchStatus(io);
  adapter.composer.qualifyHostMutation(io);
  const originalHash = status.originalHash ?? status.currentHash;
  const original = status.backupPath ?? target.asarPath;
  const { profile, warnings } = adapter.resolveLocalizationProfile({
    originalPath: original,
    originalHash,
    executablePath: io.executablePath,
    appVersion: target.version,
  });
  const cli = adapter.localizationCli();
  if (profile.nativeImageBinding !== undefined && typeof profile.nativeImageBinding !== 'boolean')
    throw new Error('Invalid nativeImageBinding in the localization profile');
  const observeOptions = {
    profiles: adapter.localizationProfiles(),
    limits: profile.limits,
    assetNames: [
      ...new Set(adapter.localizationProfiles().flatMap((entry) => Object.keys(entry.assets))),
    ],
  };
  const nativeStatus = profile.nativeImageBinding
    ? runAgyctl(['native', 'status', '--binary', target.binaryPath])
    : null;
  if (nativeStatus && ['pending', 'drift'].includes(nativeStatus.file_state))
    throw new Error('Recover the native patch state before preparing localization');
  const nativeBinding = nativeStatus ? nativeExpectation(nativeStatus) : null;
  const sourceBinaryPath = nativeBinding ? nativeStatus.base_binary_path : target.binaryPath;
  if (
    nativeBinding &&
    (!path.isAbsolute(sourceBinaryPath ?? '') ||
      sha256File(sourceBinaryPath) !== nativeBinding.base_sha256)
  )
    throw new Error('The verified native patch base cannot be read');
  const observed = cli.observeLsSource(sourceBinaryPath, observeOptions);
  if (nativeBinding && sourceBinaryPath !== target.binaryPath) {
    const currentSource = cli.observeLsSource(target.binaryPath, observeOptions);
    if (
      currentSource.lsSha256 !== nativeBinding.current_sha256 ||
      localizationContentIdentity(currentSource) !== localizationContentIdentity(observed)
    )
      throw new Error(
        'Native patches changed the localization assets or helper; prepare cannot reuse the base',
      );
  }
  if (nativeBinding)
    assertNativeExpectation(
      runAgyctl(['native', 'status', '--binary', target.binaryPath]),
      nativeBinding,
    );
  if (!observed.assets['main.js'])
    throw new Error('The Language Server source has no main.js asset');
  observed.warnings = [...observed.warnings, ...warnings];
  if (status.features.capsule || status.features.localization)
    adapter.hostPatchPlan({ ...io, features: {} });
  return { adapter, io, status, profile, observed, original, sourceBinaryPath, nativeBinding };
}

function readOptionalJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new Error(`Could not read ${filename}: ${error.message}`, { cause: error });
  }
}

function selectionHash(stateRoot, installationId) {
  const filename = path.join(stateRoot, 'installations', installationId, 'selection.json');
  try {
    return sha256File(filename);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

function runLocalization(args) {
  const child = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'localization.mjs'), ...args, '--json'],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (child.error) throw child.error;
  const result = child.stdout ? JSON.parse(child.stdout) : null;
  if (child.status !== 0)
    throw new Error(
      result?.error ?? `Localization operation failed (${child.status}): ${child.stderr}`,
    );
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Localization operation must return one JSON object');
  return result;
}

function summarizeCoverage(coverage) {
  if (!coverage) {
    return {
      locale: null,
      format: 'dom',
      probe: false,
      complete: false,
      partial: true,
      replacedMessages: 0,
      totalReplacements: 0,
      totalMessages: 0,
      totalUsagePoints: null,
      usagePointCounts: {},
      evidence: null,
      untranslated: [],
      unapplied: [],
    };
  }
  const usagePointCounts = {};
  for (const point of coverage.usagePoints ?? [])
    usagePointCounts[point.status] = (usagePointCounts[point.status] ?? 0) + 1;
  return {
    locale: coverage.locale,
    probe: coverage.probe,
    complete: coverage.completeness === 'complete',
    partial: coverage.completeness !== 'complete',
    replacedMessages: coverage.replacedMessages,
    totalReplacements: coverage.totalReplacements,
    totalMessages: coverage.messages.length,
    totalUsagePoints: coverage.usagePoints?.length ?? null,
    usagePointCounts,
    evidence: coverage.evidence,
    untranslated: coverage.messages
      .filter((message) => message.status === 'untranslated')
      .map((message) => message.messageId),
    unapplied: coverage.messages
      .filter((message) => message.status === 'unapplied')
      .map((message) => message.messageId),
  };
}

export async function availableLocalization(target) {
  const adapter = await import('./host-patch.mjs');
  const { status, profile, observed, original } = await localizationSource(target);
  // Selected artifact coverage and the last-known runtime snapshot are
  // separate evidence lines; neither claims live activation (plan §4.5, §6).
  const installationId = createHash('sha256').update(target.asarPath).digest('hex');
  const stateRoot = adapter.defaultStateRoot();
  const selectionPath = path.join(stateRoot, 'installations', installationId, 'selection.json');
  const selectedRaw = readOptionalJson(selectionPath);
  const cli = adapter.localizationCli();
  const selected =
    selectedRaw === undefined ? null : cli.decodeSelectionSnapshot(selectedRaw, selectionPath);
  if (selected && selected.installationId !== installationId)
    throw new Error('Localization selection belongs to a different installation');
  let coverage = null;
  if (selected) {
    const { coverage: parsed } = cli.readValidatedArtifact(
      path.join(stateRoot, 'artifacts', selected.artifactId),
      { artifactId: selected.artifactId, locale: selected.locale },
    );
    coverage = summarizeCoverage(parsed);
  }
  const runtimeStatusPath = path.join(
    stateRoot,
    'installations',
    installationId,
    'runtime-status.json',
  );
  let lastKnownRuntime = null;
  if (readOptionalJson(runtimeStatusPath) !== undefined) {
    const runtime = cli.readRuntimeStatus(runtimeStatusPath);
    if (!('status' in runtime))
      throw new Error(`Invalid localization runtime status: ${runtime.error}`);
    lastKnownRuntime = runtime.status;
    if (lastKnownRuntime.installationId !== installationId)
      throw new Error('Localization runtime status belongs to a different installation');
  }
  return {
    status: 'available',
    installed: !!status.features.localization,
    profileId: profile.profileId,
    profileStatus: profile.status,
    warnings: observed.warnings,
    selected,
    coverage,
    nativeCoverage: {
      qualified: true,
      installed: !!status.features.localization,
      activationVerified: false,
      usagePoints: adapter.localizationNativeInventory(original, profile).length,
    },
    lastKnownRuntime,
    pendingRestart:
      !!selected &&
      (!lastKnownRuntime ||
        lastKnownRuntime.artifactId !== selected.artifactId ||
        lastKnownRuntime.locale !== selected.locale ||
        Date.parse(lastKnownRuntime.startedAt) < Date.parse(selected.selectedAt)),
  };
}

export async function prepareLocalizationHostPlan(target, { locale, capsule = false }) {
  const { adapter, io, status, profile, observed, original, sourceBinaryPath, nativeBinding } =
    await localizationSource(target);
  const installationId = createHash('sha256').update(target.asarPath).digest('hex');
  const stateRoot = adapter.defaultStateRoot();
  const expectedSelectionSha256 = selectionHash(stateRoot, installationId);
  const features = {};
  if (capsule) {
    const { assembleCapsule } = await import('../capsule-build.mjs');
    features.capsule = { code: assembleCapsule() };
    adapter.capsuleFeature.validate(features.capsule);
  }
  const prepared = runLocalization(['prepare', '--ls', sourceBinaryPath, '--locale', locale]);
  if (
    prepared.locale !== locale ||
    !/^[a-f0-9]{64}$/.test(prepared.artifactId ?? '') ||
    prepared.sourceIdentity !== observed.sourceIdentity ||
    prepared.sourceBinarySha256 !== observed.lsSha256 ||
    sha256File(sourceBinaryPath) !== observed.lsSha256
  )
    throw new Error(
      'The prepared localization artifact does not match the selected source and locale',
    );
  if (nativeBinding)
    assertNativeExpectation(
      runAgyctl(['native', 'status', '--binary', target.binaryPath]),
      nativeBinding,
    );
  features.localization = adapter.loadLocalizationInputs({
    profileId: profile.profileId,
    artifactId: prepared.artifactId,
    installationId,
    observedSource: {
      sourceKind: observed.sourceKind,
      lsSha256: observed.lsSha256,
      sourceIdentity: observed.sourceIdentity,
      nlsHelperCalleeName: observed.nlsHelperCalleeName,
      matchedProfileId: observed.matchedProfileId,
      warnings: observed.warnings.map(({ code, message }) => ({ code, message })),
    },
  });
  if (['2', '3'].includes(profile.nativeAdapterVersion))
    features.localization.adapterEdits.push(...adapter.localizationNativeEdits(original, profile));
  const plan = adapter.hostPatchPlan({ ...io, features, baseProvenance: 'official-profile' });
  if (plan.currentHash !== status.currentHash)
    throw new Error('The selected installation changed during preparation');
  const checked = adapter.composer.inspectReviewedHostPlan(io, plan, features);
  const document = {
    ...plan,
    inputs: adapter.composer.encodeFeatureInputs(checked.features),
    backupDir: io.backupDir,
    executablePath: io.executablePath,
    nativeQualification: adapter.localizationNativeInventory(original, profile),
    localizationSelection: {
      schemaVersion: 1,
      asarPath: target.asarPath,
      installationId,
      artifactId: prepared.artifactId,
      locale,
      sourceIdentity: observed.sourceIdentity,
      sourceBinarySha256: observed.lsSha256,
      expectedSelectionSha256,
      ...(nativeBinding ? { nativeBinding } : {}),
    },
  };
  adapter.composer.inspectReviewedHostPlan(
    io,
    document,
    adapter.composer.decodeFeatureInputs(document.inputs),
  );
  const contents = `${JSON.stringify(document, null, 2)}\n`;
  const digest = createHash('sha256').update(contents).digest('hex');
  const directory = path.resolve(agyctlHome(), 'management', 'plans');
  const localizationPlan = path.join(directory, `${digest}-${randomUUID()}.json`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(localizationPlan, contents, { flag: 'wx', mode: 0o600 });
  const loaded = adapter.loadReviewedHostPlan(localizationPlan, { asarPath: target.asarPath });
  if (selectionHash(stateRoot, installationId) !== expectedSelectionSha256)
    throw new Error('Localization selection changed during review; prepare again');
  const { coverage } = adapter
    .localizationCli()
    .readValidatedArtifact(path.join(stateRoot, 'artifacts', prepared.artifactId), {
      artifactId: prepared.artifactId,
      locale,
    });
  return {
    ...target,
    localizationPlan,
    capsule,
    planCapsule: !!loaded.plan.features.capsule,
    planId: loaded.plan.planId,
    localization: {
      status: 'ready',
      readiness: loaded.readiness,
      locale,
      profileId: profile.profileId,
      profileStatus: profile.status,
      artifactId: prepared.artifactId,
      format: prepared.format ?? 'ast',
      applied: prepared.applied ?? null,
      index: prepared.index ?? null,
      warnings: [
        ...new Map(
          [...observed.warnings, ...(prepared.warnings ?? [])].map((warning) => [
            JSON.stringify([warning.code, warning.message]),
            warning,
          ]),
        ).values(),
      ],
      coverage: summarizeCoverage(coverage),
      nativeQualification: document.nativeQualification,
      pendingRestart: true,
      capsule: !!loaded.plan.features.capsule,
    },
  };
}

async function reviewed(options) {
  if (typeof options.localizationPlan !== 'string' || !path.isAbsolute(options.localizationPlan))
    throw new Error('Localization requires an absolute reviewed Host plan path');
  const adapter = await import('./host-patch.mjs');
  const loaded = await adapter.loadReviewedHostPlan(options.localizationPlan, {
    asarPath: options.asarPath,
  });
  if (!loaded.plan.features.localization)
    throw new Error('The reviewed Host plan does not include localization');
  return { adapter, loaded };
}

function verifyLocalizationSource(binaryPath, selection) {
  if (selection.nativeBinding) {
    assertNativeExpectation(
      runAgyctl(['native', 'status', '--binary', binaryPath]),
      selection.nativeBinding,
    );
    if (selection.nativeBinding.base_sha256 !== selection.sourceBinarySha256)
      throw new Error('The reviewed localization source does not match the native patch base');
  } else if (sha256File(binaryPath) !== selection.sourceBinarySha256) {
    throw new Error('The Language Server source changed since review; prepare again');
  }
}

export async function inspectReviewedHostPlan(options) {
  const { loaded } = await reviewed(options);
  return {
    status: loaded.readiness,
    planId: loaded.plan.planId,
    capsule: !!loaded.plan.features.capsule,
    planPath: options.localizationPlan,
    selection: loaded.localizationSelection,
    nativeQualification: loaded.nativeQualification,
  };
}

export async function runReviewedHostOperation(options, apply = false) {
  const { adapter, loaded } = await reviewed(options);
  if (options.capsule && !loaded.plan.features.capsule)
    throw new Error('The reviewed Host plan does not include the selected Capsule feature');
  if (!options.capsule && loaded.plan.features.capsule) {
    const installedHash = loaded.status.receipt?.features.capsule?.codeHash;
    if (!installedHash || loaded.plan.features.capsule.codeHash !== installedHash)
      throw new Error('An unselected Capsule must retain the exact installed Capsule');
  }
  const { plan, features, asarPath, backupDir, executablePath } = loaded;
  const planHash = loaded.planDocumentSha256;
  const selection = loaded.localizationSelection;
  const runtimeConfig =
    features.localization?.files?.['dist/agyctl-localization/runtime-config.json'];
  if (runtimeConfig && JSON.parse(runtimeConfig.toString('utf8')).schemaVersion === 2 && !selection)
    throw new Error(
      'Selection-based localization requires reviewed artifact and locale bindings; prepare again',
    );
  let sourceBinaryPath;
  if (selection) {
    const currentSelectionHash = selectionHash(
      features.localization.stateRoot,
      selection.installationId,
    );
    const current = readOptionalJson(
      path.join(
        features.localization.stateRoot,
        'installations',
        selection.installationId,
        'selection.json',
      ),
    );
    const alreadySelected =
      current?.artifactId === selection.artifactId && current?.locale === selection.locale;
    if (
      currentSelectionHash !== selection.expectedSelectionSha256 &&
      !(loaded.readiness === 'current' && alreadySelected)
    )
      throw new Error('Localization selection changed since review; prepare again');
    sourceBinaryPath = path.join(
      path.dirname(asarPath),
      'bin',
      process.platform === 'win32' ? 'language_server.exe' : 'language_server',
    );
    verifyLocalizationSource(sourceBinaryPath, selection);
  }
  if (sha256File(options.localizationPlan) !== planHash)
    throw new Error('The reviewed Host plan changed before application');
  if (apply && loaded.readiness !== 'current') {
    const log = await adapter.createHostPatchLog({
      installationId: adapter.composer.computeInstallationIdentity(asarPath).installationId,
    });
    try {
      log.markMutating();
      for (const point of loaded.nativeQualification ?? [])
        log.sink({
          level: 'info',
          stage: 'native.edit',
          event: 'qualified',
          result: 'prepared',
          planId: plan.planId,
          member: point.file,
          counts: {
            start: point.start,
            end: point.end,
            expected: point.expectedHits,
            actual: point.actualHits,
          },
          detail: `${point.usageId}: ${point.sourceSha256}`,
        });
      await adapter.hostPatchApply({
        plan,
        features,
        asarPath,
        backupDir,
        executablePath,
        ensureClientClosed: () => adapter.ensureClientClosedFor(asarPath),
        logEvent: log.sink,
      });
    } finally {
      log.close();
    }
  }
  const status = adapter.hostPatchStatus({ asarPath, backupDir, executablePath });
  if (apply) {
    const verified = await adapter.loadReviewedHostPlan(options.localizationPlan, { asarPath });
    if (verified.readiness !== 'current')
      throw new Error('The reviewed Host plan did not verify after application');
  }
  if (sha256File(options.localizationPlan) !== planHash)
    throw new Error('The reviewed Host plan changed during the operation');
  if (apply && selection) {
    verifyLocalizationSource(sourceBinaryPath, selection);
    const stateRoot = features.localization.stateRoot;
    const currentHash = selectionHash(stateRoot, selection.installationId);
    const current = readOptionalJson(
      path.join(stateRoot, 'installations', selection.installationId, 'selection.json'),
    );
    if (currentHash !== selection.expectedSelectionSha256) {
      if (current?.artifactId !== selection.artifactId || current?.locale !== selection.locale)
        throw new Error(
          'Host installed, but localization selection changed during application; prepare again',
        );
    } else {
      runLocalization([
        'select',
        '--artifact',
        selection.artifactId,
        '--installation-id',
        selection.installationId,
        '--expected-selection-sha256',
        selection.expectedSelectionSha256,
      ]);
    }
  }
  const readiness = apply ? 'installed' : loaded.readiness;
  const components = {
    localization: {
      status: readiness,
      activationVerified: false,
      native: {
        installed: apply,
        activationVerified: false,
        qualifiedUsagePoints: loaded.nativeQualification?.length ?? 0,
      },
      ...(selection
        ? {
            artifactId: selection.artifactId,
            locale: selection.locale,
            selected: apply,
            pendingRestart: apply,
          }
        : {}),
    },
  };
  if (options.capsule) components.capsule = { ...components.localization };
  return {
    currentHash: status.currentHash,
    unpackedHash: status.unpackedHash ?? null,
    planHash,
    planId: plan.planId,
    components,
  };
}
