import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeLocale } from '../../src/plugin/lib/locale.mjs';
import { prepareManagement } from '../manage.mjs';
import { inspectPlugin, installPlugin } from '../plugin-install.mjs';
import { uninstallPlugin } from '../plugin-uninstall.mjs';
import { repoRoot, runAgyctl, runAgyctlAsync } from './agyctl.mjs';
import { cleanupOrphanSidecars } from './client-processes.mjs';
import { inspectHostTarget } from './client-target.mjs';
import { agyctlHome, findAsarPath, sha256File } from './install-paths.mjs';
import { assertNativeExpectation } from './native-binding.mjs';

const featureNames = ['panel', 'capsule', 'localization', 'limit', 'toolOutput', 'compaction'];

function modelLimits(value) {
  if (typeof value !== 'string' || !value)
    throw new Error(
      'Model limits require ID=LIMIT,...; model names and guessed defaults are not accepted',
    );
  const rows = value.split(',').map((entry) => {
    const match = /^([1-9]\d*)=([1-9]\d*)$/.exec(entry);
    if (!match) throw new Error(`Invalid model limit: ${entry}; expected ID=LIMIT`);
    const id = Number(match[1]);
    const limit = Number(match[2]);
    if (
      !Number.isSafeInteger(id) ||
      id > 2147483647 ||
      !Number.isSafeInteger(limit) ||
      limit > 2147483647
    )
      throw new Error('Model IDs and limits must be positive int32 values');
    return { id, limit };
  });
  rows.sort((left, right) => left.id - right.id);
  if (rows.length > 128 || rows.some((row, index) => index > 0 && row.id === rows[index - 1].id))
    throw new Error('Select 1..128 unique model IDs');
  return rows;
}

export function parseInstallerArgs(argv) {
  const [command, ...rest] = argv;
  if (!['install', 'uninstall', 'status', 'models'].includes(command))
    throw new Error(`Unknown command: ${command ?? '(none)'}; run agyctl --help`);
  const options = { command, selected: {}, json: false, dryRun: false };
  const seen = new Set();
  const aliases = { '--limit': '--model-limits' };
  const featureFlags = {
    '--panel': 'panel',
    '--capsule': 'capsule',
    '--localization': 'localization',
    '--tool-output': 'toolOutput',
    '--compaction': 'compaction',
  };
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    const flag = aliases[argument] ?? argument;
    if (seen.has(flag)) throw new Error(`Duplicate argument: ${argument}`);
    seen.add(flag);
    if (flag === '--json') options.json = true;
    else if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--all') options.all = true;
    else if (Object.hasOwn(featureFlags, flag)) options.selected[featureFlags[flag]] = true;
    else if (flag === '--model-limits' && command === 'uninstall' && argument === '--limit')
      options.selected.limit = true;
    else if (['--asar', '--locale', '--model-limits', '--prompt-mode'].includes(flag)) {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      if (flag === '--asar') {
        if (!path.isAbsolute(value)) throw new Error('--asar requires an absolute app.asar path');
        options.asarPath = value;
      } else if (flag === '--locale') {
        if (normalizeLocale(value) !== value)
          throw new Error('Use a canonical locale: en, zh-Hant-TW, zh-Hans-CN, ja-JP');
        options.locale = value;
        options.selected.localization = true;
      } else if (flag === '--model-limits') {
        options.modelLimits = modelLimits(value);
        options.selected.limit = true;
      } else {
        if (value !== 'native') throw new Error('--prompt-mode supports only native');
        options.promptMode = value;
        options.selected.compaction = true;
      }
    } else throw new Error(`Unknown argument: ${argument}; run agyctl --help`);
  }
  if (['status', 'models'].includes(command)) {
    if ([...seen].some((flag) => !['--asar', '--json'].includes(flag)))
      throw new Error(`${command} accepts only --asar and --json`);
    return options;
  }
  if (command === 'uninstall' && (options.modelLimits || options.locale || options.promptMode))
    throw new Error(
      'uninstall accepts feature flags, not model mappings, locales, or prompt modes',
    );
  if (options.all) options.selected = Object.fromEntries(featureNames.map((name) => [name, true]));
  if (Object.keys(options.selected).length === 0) options.selected.panel = true;
  if (options.selected.localization && command === 'install') options.locale ??= 'zh-Hant-TW';
  return options;
}

export function desiredNativeConfig(options, current, savedMapping) {
  if (
    !current ||
    typeof current.tool_output !== 'boolean' ||
    typeof current.compaction !== 'boolean' ||
    typeof current.limit?.enabled !== 'boolean'
  )
    throw new Error(
      'Native feature state is unverified; refusing to replace unknown values with defaults',
    );
  const desired = structuredClone(current);
  const enabled = options.command === 'install';
  if (options.selected.limit) {
    const mapping =
      options.modelLimits ?? (current.limit.enabled ? current.limit.model_limits : savedMapping);
    if (enabled && (!Array.isArray(mapping) || mapping.length === 0))
      throw new Error(
        'No verified model-limit mapping is available. Supply --model-limits ID=LIMIT,...; use agyctl models while the client is running to inspect account choices',
      );
    desired.limit = {
      enabled,
      model_limits: enabled
        ? modelLimits(mapping.map(({ id, limit }) => `${id}=${limit}`).join(','))
        : [],
    };
  }
  if (options.selected.toolOutput) desired.tool_output = enabled;
  if (options.selected.compaction) {
    desired.compaction = enabled;
    if (enabled && (options.promptMode === 'native' || !desired.compaction_prompt))
      desired.compaction_prompt = { mode: 'native', text: '' };
  }
  if (!desired.compaction) delete desired.compaction_prompt;
  return desired;
}

function installationKey(target) {
  return createHash('sha256').update(target.asarPath).digest('hex');
}

function selectionPath(target) {
  return path.resolve(agyctlHome(), 'installer', 'selections', `${installationKey(target)}.json`);
}

function optionalDocument(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read installer state ${filename}: ${error.message}`, { cause: error });
  }
}

function writeDocument(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function savedMapping(target, native) {
  const saved = optionalDocument(selectionPath(target));
  if (!saved) return undefined;
  if (saved.schema !== 1 || saved.asarPath !== target.asarPath || !Array.isArray(saved.modelLimits))
    throw new Error('The saved installer selection is invalid');
  if (native.verified !== true || saved.baseSha256 !== native.base_sha256) return undefined;
  return modelLimits(saved.modelLimits.map(({ id, limit }) => `${id}=${limit}`).join(','));
}

async function snapshot(target) {
  const errors = [];
  const capture = async (component, action) => {
    try {
      return await action();
    } catch (error) {
      errors.push({ component, error: error.message });
      return null;
    }
  };
  const [native, limit, host, panel] = await Promise.all([
    capture('native', () => runAgyctlAsync(['native', 'status', '--binary', target.binaryPath])),
    capture('process', () => runAgyctlAsync(['limit', 'status', '--binary', target.binaryPath])),
    capture('host', async () =>
      (await import('./host-patch.mjs')).hostPatchStatus({ asarPath: target.asarPath }),
    ),
    capture('panel', () => inspectPlugin()),
  ]);
  return {
    target,
    native,
    host,
    panel,
    errors,
    process: { languageServerRunning: limit?.language_server_running ?? null },
    features: {
      panel: { enabled: panel?.installed ?? null, ...(panel ?? {}) },
      capsule: { enabled: host?.features.capsule ?? null },
      localization: { enabled: host?.features.localization ?? null },
      limit:
        native?.verified === true ? native.features.limit : { enabled: null, model_limits: null },
      tool_output: native?.verified === true ? native.features.tool_output : null,
      compaction: native?.verified === true ? native.features.compaction : null,
      compaction_prompt:
        native?.verified === true ? (native.features.compaction_prompt ?? null) : null,
    },
  };
}

function assertStopped(state) {
  if (state.process.languageServerRunning !== false)
    throw new Error(
      state.process.languageServerRunning === true
        ? 'The selected Antigravity client or Language Server is running. Close that installation yourself, then rerun this command; agyctl will not close or restart it'
        : 'Cannot verify that the selected Antigravity client and Language Server are stopped; refusing mutation',
    );
}

function hostCommand(args) {
  const child = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'host-patch.mjs'), ...args, '--json'],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (child.error) throw child.error;
  let result;
  try {
    result = JSON.parse(child.stdout);
  } catch {
    throw new Error(`Host command returned invalid JSON: ${child.stderr || child.stdout}`);
  }
  if (child.status !== 0)
    throw new Error(result.error ?? `Host command failed (${child.status}): ${child.stderr}`);
  return result;
}

async function prepareHost(options, target) {
  const adapter = await import('./host-patch.mjs');
  adapter.composer.qualifyHostMutation(adapter.hostPatchIo({ asarPath: target.asarPath }));
  if (options.command === 'uninstall') {
    const status = adapter.hostPatchStatus({ asarPath: target.asarPath });
    if (status.features.capsule || status.features.localization)
      adapter.hostPatchPlan({ asarPath: target.asarPath, features: {} });
    return { remove: ['capsule', 'localization'].filter((name) => options.selected[name]) };
  }
  if (options.selected.capsule) adapter.assertCapsuleAnchors(target.asarPath);
  if (options.selected.localization) {
    const prepared = await prepareManagement({
      asarPath: target.asarPath,
      localization: true,
      locale: options.locale,
      capsule: options.selected.capsule === true,
    });
    const { runReviewedHostOperation } = await import('./management.mjs');
    await runReviewedHostOperation(
      {
        asarPath: target.asarPath,
        localizationPlan: prepared.localizationPlan,
        capsule: options.selected.capsule === true,
      },
      false,
    );
    return prepared;
  }
  const codePath = path.join(repoRoot, 'dist', 'capsule', 'input-capsule.js');
  const { assembleCapsule } = await import('../capsule-build.mjs');
  if (fs.readFileSync(codePath, 'utf8') !== assembleCapsule())
    throw new Error(
      'The packaged capsule does not match its source inputs; reinstall a complete agyctl package',
    );
  hostCommand(['plan', '--asar', target.asarPath, '--capsule', '--capsule-code', codePath]);
  return { capsuleCode: codePath };
}

function verifyNative(actual, desired, plan) {
  if (actual.verified !== true || actual.current_sha256 !== plan.after_sha256)
    throw new Error('Native post-apply whole-file verification failed');
  for (const key of ['limit', 'tool_output', 'compaction', 'compaction_prompt'])
    if (JSON.stringify(actual.features[key] ?? null) !== JSON.stringify(desired[key] ?? null))
      throw new Error(`Native post-apply verification failed for ${key}`);
  if (
    !desired.limit.enabled &&
    !desired.tool_output &&
    !desired.compaction &&
    actual.current_sha256 !== actual.base_sha256
  )
    throw new Error('Native all-off state did not restore the exact original bytes');
}

export async function executeInstaller(options, onProgress = () => {}) {
  onProgress('Locating the selected Antigravity installation...');
  const target = inspectHostTarget(options.asarPath ?? findAsarPath());
  onProgress(`Target: ${target.asarPath}`);
  if (options.command === 'models') {
    onProgress('Reading the account model catalog...');
    const { readModelCatalog } = await import('./model-catalog.mjs');
    const catalog = await readModelCatalog(target.binaryPath);
    if (catalog.status !== 'available')
      throw new Error(
        'The account model catalog is unavailable. Start the selected Antigravity installation and sign in, then rerun agyctl models',
      );
    return { command: 'models', state: 'read-only', target, features: catalog };
  }
  onProgress('Inspecting current features and client processes...');
  let before = await snapshot(target);
  if (options.command === 'status')
    return {
      command: 'status',
      state: before.errors.length ? 'incomplete' : 'read-only',
      ...before,
    };
  if (
    !options.dryRun &&
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    before.process.languageServerRunning === true
  ) {
    onProgress('Checking for verified orphan sidecars from the closed client...');
    const cleanup = cleanupOrphanSidecars(target);
    onProgress(`Cleaned ${cleanup.cleaned} verified orphan sidecars; rechecking feature state...`);
    before = await snapshot(target);
  }
  const nativeSelected =
    options.selected.limit || options.selected.toolOutput || options.selected.compaction;
  const hostSelected = options.selected.capsule || options.selected.localization;
  let nativePlan;
  let desired;
  if (nativeSelected) {
    onProgress('Planning native feature changes...');
    if (before.native?.verified !== true)
      throw new Error(
        `The native state is unverified (${before.native?.file_state ?? 'unavailable'}); recover or qualify it before installation/removal`,
      );
    if (
      before.native.update_transition_required &&
      !(options.selected.limit && options.selected.toolOutput && options.selected.compaction)
    )
      throw new Error(
        'An app update requires an explicit selection for all three native features. Use --all, or select --limit, --tool-output, and --compaction together',
      );
    desired = desiredNativeConfig(
      options,
      before.native.features,
      savedMapping(target, before.native),
    );
    nativePlan = runAgyctl([
      'native',
      'plan',
      '--binary',
      target.binaryPath,
      '--desired',
      JSON.stringify(desired),
    ]);
    assertNativeExpectation(before.native, nativePlan.expected);
  }
  if (options.selected.panel) {
    if (before.panel === null)
      throw new Error('The current panel installation could not be inspected');
    if (options.command === 'install') inspectPlugin(path.join(repoRoot, 'src', 'plugin'));
  }
  if (!options.dryRun) {
    onProgress('Checking that the client and Language Server are stopped...');
    assertStopped(before);
  }
  if (hostSelected) onProgress('Checking capsule and localization changes...');
  const hostPrepared = hostSelected ? await prepareHost(options, target) : null;
  const planned = {
    native: desired ?? null,
    host: hostPrepared,
    panel: options.selected.panel ? options.command === 'install' : null,
  };
  if (options.dryRun) {
    onProgress('Plan ready; no installed client files were changed.');
    return {
      command: options.command,
      state: 'planned',
      target,
      desired: planned,
      process: before.process,
      errors: before.errors,
    };
  }
  const journalPath = path.resolve(
    agyctlHome(),
    'installer',
    'operations',
    `${installationKey(target)}-${randomUUID()}.json`,
  );
  const journal = {
    schema: 1,
    command: options.command,
    options,
    target,
    state: 'applying',
    phase: 'preflight-complete',
    completed: [],
    startedAt: new Date().toISOString(),
    before,
    desired: planned,
    recovery:
      'Inspect agyctl status --asar for this target, then rerun the same command. Components are independently verified; cross-component changes are not atomic. Backups and user data are retained.',
  };
  const record = (phase, message) => {
    journal.phase = phase;
    journal.updatedAt = new Date().toISOString();
    writeDocument(journalPath, journal);
    if (message) onProgress(message);
  };
  record('preflight-complete', `Preflight complete. Operation journal: ${journalPath}`);
  try {
    if (nativeSelected) {
      record(
        'native-applying',
        options.command === 'install'
          ? 'Applying native feature patches...'
          : 'Restoring native feature patches...',
      );
      runAgyctl([
        'native',
        'apply',
        '--binary',
        target.binaryPath,
        '--desired',
        JSON.stringify(desired),
        '--expected',
        JSON.stringify(nativePlan.expected),
      ]);
      onProgress('Verifying native feature changes...');
      const actual = runAgyctl(['native', 'status', '--binary', target.binaryPath]);
      verifyNative(actual, desired, nativePlan);
      const mapping = desired.limit.enabled
        ? desired.limit.model_limits
        : before.native.features.limit.model_limits;
      if (mapping.length > 0)
        writeDocument(selectionPath(target), {
          schema: 1,
          asarPath: target.asarPath,
          baseSha256: actual.base_sha256,
          modelLimits: mapping,
        });
      journal.completed.push('native');
      record('native-verified', 'Native feature changes verified.');
    }
    if (hostSelected) {
      record('host-preparing', 'Preparing capsule and localization changes...');
      const prepared = nativeSelected ? await prepareHost(options, target) : hostPrepared;
      const adapter = await import('./host-patch.mjs');
      onProgress('Rechecking client processes before capsule and localization changes...');
      assertStopped(await snapshot(target));
      record(
        'host-applying',
        options.command === 'install'
          ? 'Applying capsule and localization changes...'
          : 'Removing the selected capsule and localization features...',
      );
      if (options.command === 'uninstall')
        hostCommand([
          'remove',
          '--asar',
          target.asarPath,
          ...prepared.remove.map((name) => `--${name}`),
        ]);
      else if (options.selected.localization) {
        const { runReviewedHostOperation } = await import('./management.mjs');
        await runReviewedHostOperation(
          {
            asarPath: target.asarPath,
            localizationPlan: prepared.localizationPlan,
            capsule: options.selected.capsule === true,
          },
          true,
        );
      } else
        hostCommand([
          'apply',
          '--asar',
          target.asarPath,
          '--capsule',
          '--capsule-code',
          prepared.capsuleCode,
        ]);
      onProgress('Verifying capsule and localization changes...');
      const host = adapter.hostPatchStatus({ asarPath: target.asarPath });
      for (const name of ['capsule', 'localization']) {
        const expected = options.selected[name]
          ? options.command === 'install'
          : before.host.features[name];
        if (host.features[name] !== expected)
          throw new Error(`Host post-apply verification failed for ${name}`);
      }
      if (
        !host.features.capsule &&
        !host.features.localization &&
        host.originalHash &&
        sha256File(target.asarPath) !== host.originalHash
      )
        throw new Error('Host all-off state did not restore the exact original archive');
      journal.completed.push('host');
      record('host-verified', 'Capsule and localization changes verified.');
    }
    if (options.selected.panel) {
      onProgress('Rechecking client processes before panel changes...');
      assertStopped(await snapshot(target));
      record(
        'panel-applying',
        options.command === 'install' ? 'Installing the panel...' : 'Removing the panel...',
      );
      journal.panel =
        options.command === 'install'
          ? installPlugin({
              repositoryRoot: repoRoot,
              nodeExecutable: process.execPath,
              env: { ...process.env, AGYCTL_APP_DIR: target.installDir },
            })
          : uninstallPlugin();
      if (inspectPlugin().installed !== (options.command === 'install'))
        throw new Error('Panel post-apply verification failed');
      journal.completed.push('panel');
      record('panel-verified', 'Panel changes verified.');
    }
    onProgress('Inspecting the final feature state...');
    journal.after = await snapshot(target);
    journal.state = 'complete';
    record('complete', 'Operation complete.');
    return {
      command: options.command,
      state: 'complete',
      target,
      features: journal.after.features,
      errors: journal.after.errors,
      journal: journalPath,
    };
  } catch (error) {
    journal.state = 'failed';
    journal.error = error.message;
    onProgress('Operation failed; inspecting the current state for recovery...');
    journal.after = await snapshot(target);
    let journalError;
    try {
      record(journal.phase);
    } catch (failure) {
      journalError = failure.message;
    }
    error.message += `; operation may be partially applied. Journal: ${journalPath}. Inspect status, then rerun the same command; completed phases: ${journal.completed.join(', ') || 'none'}`;
    error.installerResult = {
      state: 'failed',
      journal: journalPath,
      completed: journal.completed,
      phase: journal.phase,
      features: journal.after.features,
      ...(journalError ? { journalError } : {}),
    };
    throw error;
  }
}
