import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeLocale } from '../src/plugin/lib/locale.mjs';
import { runAgyctl } from './lib/agyctl.mjs';
import { inspectHostTarget, inspectTarget } from './lib/client-target.mjs';
import { backupDir, installedTargets } from './lib/install-paths.mjs';

export { inspectTarget } from './lib/client-target.mjs';

const require = createRequire(import.meta.url);
const { builtinAsar: asar } = require('./vendor/asar-engine.cjs');
export async function prepareManagement({
  asarPath,
  capsule = false,
  localization = false,
  locale,
} = {}) {
  if (typeof capsule !== 'boolean' || typeof localization !== 'boolean')
    throw new Error('Invalid management preparation feature selection');
  if (
    (localization && locale === undefined) ||
    (locale !== undefined && (typeof locale !== 'string' || normalizeLocale(locale) !== locale))
  )
    throw new Error('Management preparation requires a canonical --locale for localization');
  if (asarPath === undefined) {
    const targets = installedTargets();
    if (targets.length !== 1)
      throw new Error('Select exactly one discovered Antigravity installation');
    asarPath = targets[0].asarPath;
  }
  const target = inspectHostTarget(asarPath);
  if (!localization) return { ...target, capsule, localization: { status: 'not-selected' } };
  const { prepareLocalizationHostPlan } = await import('./lib/management.mjs');
  return prepareLocalizationHostPlan(target, { locale, capsule });
}

export async function managementStatus({ asarPath, localizationPlan, unavailable = {} } = {}) {
  const result = {
    asarPath: null,
    binaryPath: null,
    executablePath: null,
    product: null,
    clientRunning: null,
    capsule: null,
    capsuleAnchors: null,
    localization: {
      status: 'unavailable',
      reason: 'No localization-compatible installation is selected',
    },
    limit: null,
    defaults: { limitIds: null, limitTokens: null },
    targets: [],
    errors: [],
  };
  const capture = (component, action) => {
    try {
      return action();
    } catch (error) {
      result.errors.push({ component, error: error.message });
      return null;
    }
  };
  const call = (args) => runAgyctl(args);
  result.targets = capture('discovery', () => installedTargets({ ignoreAppDir: !!asarPath })) ?? [];
  const defaults = capture('limit', () => call(['limit', 'metadata']));
  if (defaults) result.defaults = defaults;
  if (!asarPath) {
    if (result.targets.length !== 1) {
      result.errors.push({
        component: 'target',
        error:
          result.targets.length > 1
            ? 'Multiple Antigravity products are installed; select an explicit app.asar path'
            : 'No Antigravity installation was found; select an explicit app.asar path',
      });
      return result;
    }
    asarPath = result.targets[0].asarPath;
  }
  const target = capture('target', () => inspectTarget(asarPath, { requireFiles: false }));
  if (!target) return result;
  for (const key of ['asarPath', 'binaryPath', 'executablePath', 'product'])
    result[key] = target[key];
  try {
    if (unavailable.capsule) throw new Error(unavailable.capsule);
    const { loadHostComposer } = await import('./lib/host-build.mjs');
    result.capsule = loadHostComposer().getHostStatus({
      asarPath: target.asarPath,
      backupDir: backupDir(),
      engine: asar,
    });
  } catch (error) {
    result.errors.push({ component: 'capsule', error: error.message });
  }
  result.capsuleAnchors = await (async () => {
    try {
      if (unavailable.capsule) throw new Error(unavailable.capsule);
      const { assertCapsuleAnchors } = await import('./lib/host-patch.mjs');
      return { status: 'present', ...assertCapsuleAnchors(target.asarPath) };
    } catch (error) {
      return { status: 'refused', reason: error.message };
    }
  })();
  result.limit = capture('limit', () => call(['limit', 'status', '--binary', target.binaryPath]));
  if (localizationPlan) {
    try {
      if (unavailable.localization) throw new Error(unavailable.localization);
      const { inspectReviewedHostPlan } = await import('./lib/management.mjs');
      result.localization = await inspectReviewedHostPlan({
        asarPath: target.asarPath,
        localizationPlan,
      });
    } catch (error) {
      result.errors.push({ component: 'localization', error: error.message });
      result.localization = { status: 'unavailable', reason: error.message };
    }
  } else {
    try {
      if (unavailable.localization) throw new Error(unavailable.localization);
      const { availableLocalization } = await import('./lib/management.mjs');
      result.localization = await availableLocalization(target);
    } catch (error) {
      result.errors.push({ component: 'localization', error: error.message });
      result.localization = {
        status: 'unavailable',
        installed: !!result.capsule?.features?.localization,
        reason: error.message,
      };
    }
  }
  const running = await capture('processes', async () => {
    const { clientProcessState } = await import('./lib/host-patch.mjs');
    return clientProcessState(target.asarPath).state;
  });
  if (running) result.clientRunning = running === 'unknown' ? null : running === 'running';
  return result;
}

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (Object.hasOwn(values, flag)) throw new Error(`Duplicate argument: ${flag}`);
    if (['--capsule', '--localization'].includes(flag)) values[flag] = true;
    else if (
      [
        '--asar',
        '--localization-plan',
        '--locale',
        '--unavailable-capsule',
        '--unavailable-localization',
      ].includes(flag)
    ) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing ${flag} value`);
      values[flag] = value;
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  return values;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, ...args] = process.argv.slice(2).filter((arg) => arg !== '--json');
    const flags = parseOptions(args);
    let result;
    if (
      action === 'status' &&
      Object.keys(flags).every((flag) =>
        [
          '--asar',
          '--localization-plan',
          '--unavailable-capsule',
          '--unavailable-localization',
        ].includes(flag),
      )
    )
      result = await managementStatus({
        asarPath: flags['--asar'],
        localizationPlan: flags['--localization-plan'],
        unavailable: {
          capsule: flags['--unavailable-capsule'],
          localization: flags['--unavailable-localization'],
        },
      });
    else if (
      action === 'prepare' &&
      Object.keys(flags).every((flag) =>
        ['--asar', '--capsule', '--localization', '--locale'].includes(flag),
      )
    )
      result = await prepareManagement({
        asarPath: flags['--asar'],
        capsule: !!flags['--capsule'],
        localization: !!flags['--localization'],
        locale: flags['--locale'],
      });
    else if (['--host-preflight', '--host-apply'].includes(action)) {
      if (
        Object.keys(flags).some(
          (flag) => !['--asar', '--localization-plan', '--capsule'].includes(flag),
        )
      )
        throw new Error('Invalid reviewed Host operation');
      const { runReviewedHostOperation } = await import('./lib/management.mjs');
      result = await runReviewedHostOperation(
        {
          asarPath: flags['--asar'],
          localizationPlan: flags['--localization-plan'],
          capsule: !!flags['--capsule'],
        },
        action === '--host-apply',
      );
    } else
      throw new Error(
        'Usage: manage.mjs status [--asar ABS_PATH] [--localization-plan ABS_PATH] | prepare [--asar ABS_PATH] [--capsule] [--localization --locale LOCALE] | --host-preflight|--host-apply [--asar ABS_PATH] --localization-plan ABS_PATH [--capsule]',
      );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  }
}
