import fs from 'node:fs';
import path from 'node:path';
import {
  composer,
  createHostPatchLog,
  ensureClientClosedFor,
  hostPatchApply,
  hostPatchIo,
  hostPatchPlan,
  hostPatchRemove,
  hostPatchStatus,
  loadReviewedHostPlan,
  localizationProfiles,
} from './lib/host-patch.mjs';

/** Prints the command result JSON on stdout with the log correlation ids. */
function printResult(payload, log) {
  console.log(
    JSON.stringify(
      {
        ...payload,
        log: log.describe(),
        ...(log.failure() ? { logWriteFailed: true } : {}),
      },
      null,
      2,
    ),
  );
}

function usage() {
  return [
    'Usage:',
    '  host-patch.mjs status [--asar ABS_PATH] [--json]',
    '  host-patch.mjs plan [--asar ABS_PATH] [--executable ABS_PATH] [--backup-dir ABS_PATH] --capsule --capsule-code ABS_FILE [--json]',
    '  host-patch.mjs plan ... --localization --profile ID --localization-inputs ABS_JSON',
    '  host-patch.mjs apply --plan ABS_PLAN_FILE [--json]',
    '  host-patch.mjs apply <the same feature options as plan>',
    '  host-patch.mjs remove [--asar ABS_PATH] [--backup-dir ABS_PATH] [--executable ABS_PATH] --capsule|--localization|--all [--json]',
    'Plans include their payloads and exact target; apply --plan accepts no target or feature overrides.',
  ].join('\n');
}

function parseArgs(argv, allowed) {
  const values = new Map();
  const withValue = new Set([
    '--asar',
    '--plan',
    '--capsule-code',
    '--executable',
    '--backup-dir',
    '--profile',
    '--localization-inputs',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!allowed.has(flag) || values.has(flag))
      throw new Error(`Unknown or duplicate argument: ${flag}`);
    values.set(flag, true);
    if (withValue.has(flag)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
      values.set(flag, value);
    }
  }
  return values;
}

function requireAbsolute(value, flag) {
  if (typeof value !== 'string' || !path.isAbsolute(value))
    throw new Error(`${flag} requires an absolute path; received: ${String(value)}`);
  return value;
}

function featureInputs(args) {
  if (!args.has('--capsule') && !args.has('--localization'))
    throw new Error('Select at least one feature: --capsule or --localization');
  const features = {};
  if (args.has('--capsule-code') && !args.has('--capsule'))
    throw new Error('--capsule-code requires --capsule');
  if (args.has('--capsule')) {
    const codePath = requireAbsolute(args.get('--capsule-code'), '--capsule-code');
    features.capsule = { code: fs.readFileSync(codePath, 'utf8') };
  }
  if ((args.has('--profile') || args.has('--localization-inputs')) && !args.has('--localization'))
    throw new Error('--profile and --localization-inputs require --localization');
  if (args.has('--localization')) {
    const profiles = localizationProfiles();
    const profile = profiles.find((entry) => entry.profileId === args.get('--profile'));
    if (!profile)
      throw new Error(
        `Select --profile ID from: ${profiles.map((entry) => `${entry.profileId} (${entry.status})`).join(', ')}`,
      );
    if (profile.status !== 'verified')
      console.error(
        `UNTESTED_BUILD: Localization profile ${profile.profileId} is ${profile.status}; installation requires asset and structural preflight`,
      );
    const inputPath = requireAbsolute(args.get('--localization-inputs'), '--localization-inputs');
    const loaded = composer.decodeFeatureInputs(JSON.parse(fs.readFileSync(inputPath, 'utf8')));
    if (
      !loaded.localization ||
      loaded.capsule ||
      loaded.localization.profileId !== profile.profileId
    )
      throw new Error(
        'Localization inputs must contain only the complete selected localization feature',
      );
    features.localization = loaded.localization;
  }
  return features;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  let activeLog = null;
  try {
    if (command === 'status') {
      const args = parseArgs(rest, new Set(['--asar', '--json']));
      const asarPath = args.has('--asar')
        ? requireAbsolute(args.get('--asar'), '--asar')
        : undefined;
      console.log(JSON.stringify(hostPatchStatus({ asarPath }), null, 2));
      return;
    }
    if (command === 'remove') {
      const args = parseArgs(
        rest,
        new Set([
          '--asar',
          '--backup-dir',
          '--executable',
          '--capsule',
          '--localization',
          '--all',
          '--json',
        ]),
      );
      const remove = args.has('--all')
        ? ['capsule', 'localization']
        : ['capsule', 'localization'].filter((name) => args.has(`--${name}`));
      if (!remove.length) throw new Error('Select --capsule, --localization, or --all to remove');
      const io = hostPatchIo({
        asarPath: args.has('--asar') ? requireAbsolute(args.get('--asar'), '--asar') : undefined,
        backupDir: args.has('--backup-dir')
          ? requireAbsolute(args.get('--backup-dir'), '--backup-dir')
          : undefined,
        executablePath: args.has('--executable')
          ? requireAbsolute(args.get('--executable'), '--executable')
          : undefined,
      });
      const installationId = composer.computeInstallationIdentity(io.asarPath).installationId;
      const log = await createHostPatchLog({ installationId });
      activeLog = log;
      try {
        // The writer exists, so recording has started; from here a log write
        // failure must not misreport an already-committed transaction.
        log.markMutating();
        const result = await hostPatchRemove({
          ...io,
          remove,
          ensureClientClosed: () => ensureClientClosedFor(io.asarPath),
          logEvent: log.sink,
        });
        printResult(
          { removed: remove, receipt: result.receipt, warnings: result.warnings ?? [] },
          log,
        );
      } finally {
        log.close();
      }
      return;
    }
    if (command !== 'plan' && command !== 'apply') throw new Error(usage());
    const args = parseArgs(
      rest,
      new Set([
        '--asar',
        '--capsule',
        '--capsule-code',
        '--localization',
        '--localization-inputs',
        '--profile',
        '--json',
        '--plan',
        '--executable',
        '--backup-dir',
      ]),
    );
    if (args.has('--plan')) {
      if (
        command !== 'apply' ||
        [...args.keys()].some((flag) => flag !== '--plan' && flag !== '--json')
      )
        throw new Error(
          'apply --plan accepts only --plan FILE and --json; target and payloads come from the reviewed document',
        );
      const reviewed = loadReviewedHostPlan(requireAbsolute(args.get('--plan'), '--plan'));
      const asarPath = reviewed.asarPath;
      const installationId = composer.computeInstallationIdentity(asarPath).installationId;
      const log = await createHostPatchLog({ installationId });
      activeLog = log;
      try {
        log.markMutating();
        const result = await hostPatchApply({
          asarPath,
          backupDir: reviewed.backupDir,
          executablePath: reviewed.executablePath,
          plan: reviewed.plan,
          features: reviewed.features,
          ensureClientClosed: () => ensureClientClosedFor(asarPath),
          logEvent: log.sink,
        });
        printResult(
          { applied: true, receipt: result.receipt, warnings: result.warnings ?? [] },
          log,
        );
      } finally {
        log.close();
      }
      return;
    }
    const features = featureInputs(args);
    const io = hostPatchIo({
      asarPath: args.has('--asar') ? requireAbsolute(args.get('--asar'), '--asar') : undefined,
      backupDir: args.has('--backup-dir')
        ? requireAbsolute(args.get('--backup-dir'), '--backup-dir')
        : undefined,
      executablePath: args.has('--executable')
        ? requireAbsolute(args.get('--executable'), '--executable')
        : undefined,
    });
    const installationId = composer.computeInstallationIdentity(io.asarPath).installationId;
    const log = await createHostPatchLog({ installationId, required: command === 'apply' });
    activeLog = log;
    try {
      if (command === 'apply') log.markMutating();
      const plan = hostPatchPlan({
        ...io,
        features,
        baseProvenance: features.localization ? 'official-profile' : undefined,
        logEvent: log.sink,
      });
      if (command === 'plan') {
        printResult(
          {
            ...plan,
            inputs: composer.encodeFeatureInputs(features),
            backupDir: io.backupDir,
            executablePath: io.executablePath,
            integrity: hostPatchStatus(io).integrity,
          },
          log,
        );
        return;
      }
      const result = await hostPatchApply({
        ...io,
        plan,
        features,
        ensureClientClosed: () => ensureClientClosedFor(io.asarPath),
        logEvent: log.sink,
      });
      printResult({ applied: true, receipt: result.receipt, warnings: result.warnings ?? [] }, log);
    } finally {
      log.close();
    }
  } catch (error) {
    if (activeLog) {
      try {
        activeLog.sink({
          level: 'error',
          stage: 'command',
          event: 'failed',
          result: 'failed',
          detail: error.message,
        });
      } catch (logError) {
        console.error(
          `LOG_WRITE_FAILED: preserving the original command error; ${logError.message}`,
        );
      }
      activeLog.close();
    }
    console.log(
      JSON.stringify({
        error: error.message,
        ...(activeLog ? { log: activeLog.describe() } : {}),
      }),
    );
    if (!json) console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
