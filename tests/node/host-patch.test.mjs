// P0-B gate: synthetic-install composition, removal,
// current-format refusal, locking and official-update behaviour of the Host Composer
// (plan §12.2). All fixtures are synthetic; no live installation is touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  HOST_CAPSULE_FEATURE_MARKER,
  HOST_MANAGED_MARKER,
} from '../../dist/host/bundle/host-composer.mjs';
import {
  capsuleReadiness,
  ensureOriginalBackup,
  getCapsuleStatus,
  installCapsule,
  unpackedHash,
} from '../../scripts/capsule-install.mjs';
import { uninstallCapsule } from '../../scripts/capsule-uninstall.mjs';
import { replaceFileTransaction } from '../../scripts/lib/file-transaction.mjs';
import {
  composer,
  engine,
  hostPatchIo,
  loadLocalizationInputs,
  loadReviewedHostPlan,
} from '../../scripts/lib/host-patch.mjs';

import {
  anchoredMain,
  syntheticLanguageServer,
  writeServedLanguageServer,
} from './helpers/synthetic-ls.mjs';

const require2 = createRequire(import.meta.url);
const capsuleCode = 'globalThis.__capsuleFixture = true;';
const CAPSULE_CODE_V2 = 'globalThis.__capsuleFixture = 2;';

// The composed-feature tests inject the built localization runtime inputs
// (dist/localization/bundle); without that build they have no prerequisite and
// are exercised fully by `npm run test:localization`. A skip is reported, never
// silently passed. Callers must return when this returns true: t.skip() only
// marks the result, it does not stop the test body.
function requireLocalizationBuild(t) {
  if (!fs.existsSync('dist/localization/bundle/host-engine.cjs')) {
    t.skip('dist/localization build is absent; run npm run test:localization');
    return true;
  }
  return false;
}

test('management prepares read-only reviews and commits only the reviewed selection after Host installation', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const prepared = managementPreparationFixture(t);
  const { run, target, stateRoot, runtime, profile } = prepared;
  const before = fs.readFileSync(target.asarPath);
  const status = run('status');
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(
    status.value.localization.status,
    'available',
    JSON.stringify(status.value.localization),
  );
  assert.equal(status.value.localization.installed, false);
  assert.equal(status.value.localization.profileId, profile.profileId);
  assert.equal(fs.existsSync(stateRoot), false);
  const result = run('prepare', '--localization', '--locale', 'zh-Hant-TW');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value.asarPath, target.asarPath);
  assert.equal(result.value.localization.locale, 'zh-Hant-TW');
  assert.equal(result.value.localization.profileId, profile.profileId);
  assert.equal(result.value.localization.status, 'ready');
  assert.equal(result.value.localization.capsule, false);
  const reviewed = JSON.parse(fs.readFileSync(result.value.localizationPlan, 'utf8'));
  assert.equal(reviewed.localizationSelection.artifactId, result.value.localization.artifactId);
  assert.equal(reviewed.localizationSelection.locale, 'zh-Hant-TW');
  assert.equal(reviewed.localizationSelection.expectedSelectionSha256, 'absent');
  assert.equal(fs.existsSync(path.join(stateRoot, 'localization', 'installations')), false);
  assert.equal(result.value.localization.applied[0].hits, 1);
  assert.equal(
    path.dirname(result.value.localizationPlan),
    path.join(stateRoot, 'management', 'plans'),
  );
  const checked = run(
    '--host-preflight',
    '--asar',
    target.asarPath,
    '--localization-plan',
    result.value.localizationPlan,
  );
  assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  assert.equal(checked.value.components.localization.status, 'ready');
  assert.deepEqual(fs.readFileSync(target.asarPath), before);
  assert.equal(fs.existsSync(path.join(stateRoot, 'backups')), false);
  const badLocale = run('prepare', '--localization', '--locale', 'zh-TW');
  assert.equal(badLocale.status, 1);
  assert.match(badLocale.value.error, /canonical --locale/);
  const outside = run('prepare', '--asar', fixture(prepared.root, 'outside').asarPath);
  assert.equal(outside.status, 1);
  assert.match(outside.value.error, /exact discovered/);
  const layoutPath = path.join(runtime, 'compat', 'install-layout.json');
  const layout = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  layout.platforms[process.platform].channels.push({
    ...layout.platforms[process.platform].channels[0],
  });
  fs.writeFileSync(layoutPath, JSON.stringify(layout));
  const ambiguous = run('prepare', '--localization', '--locale', 'ja-JP');
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.value.error, /exactly one discovered/);
  const exact = run('prepare', '--asar', target.asarPath, '--localization', '--locale', 'ja-JP');
  assert.equal(exact.status, 0, exact.stdout + exact.stderr);
  assert.equal(exact.value.localization.locale, 'ja-JP');
  await composer.applyHostPatch(
    baseOptions({
      ...target,
      backupDir: path.join(stateRoot, 'backups'),
      localizationProfiles: [profile],
    }),
    {
      plan: reviewed,
      features: composer.decodeFeatureInputs(reviewed.inputs),
      ensureClientClosed: () => {},
    },
  );
  const installedArchive = fs.readFileSync(target.asarPath);
  const apply = (planPath) =>
    run('--host-apply', '--asar', target.asarPath, '--localization-plan', planPath);
  const applied = apply(result.value.localizationPlan);
  assert.equal(applied.status, 0, applied.stdout + applied.stderr);
  assert.equal(applied.value.components.localization.selected, true);
  assert.equal(applied.value.components.localization.pendingRestart, true);
  const selectionPath = path.join(
    stateRoot,
    'localization',
    'installations',
    reviewed.localizationSelection.installationId,
    'selection.json',
  );
  const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
  assert.equal(selection.artifactId, result.value.localization.artifactId);
  assert.equal(selection.locale, 'zh-Hant-TW');
  const next = run('prepare', '--asar', target.asarPath, '--localization', '--locale', 'ja-JP');
  assert.equal(next.status, 0, next.stdout + next.stderr);
  const selectedBytes = fs.readFileSync(selectionPath);
  fs.appendFileSync(selectionPath, '\n');
  const drifted = apply(next.value.localizationPlan);
  assert.equal(drifted.status, 1);
  assert.match(drifted.value.error, /selection changed since review/);
  assert.deepEqual(fs.readFileSync(target.asarPath), installedArchive);
  fs.writeFileSync(selectionPath, selectedBytes);
  const sourceBytes = fs.readFileSync(target.binaryPath);
  fs.appendFileSync(target.binaryPath, 'source changed after review');
  const changedSource = apply(next.value.localizationPlan);
  assert.equal(changedSource.status, 1);
  assert.match(changedSource.value.error, /Language Server source changed since review/);
  assert.deepEqual(fs.readFileSync(selectionPath), selectedBytes);
  fs.writeFileSync(target.binaryPath, sourceBytes);
  const switched = apply(next.value.localizationPlan);
  assert.equal(switched.status, 0, switched.stdout + switched.stderr);
  assert.equal(JSON.parse(fs.readFileSync(selectionPath, 'utf8')).locale, 'ja-JP');
  assert.deepEqual(fs.readFileSync(target.asarPath), installedArchive);
  const selectedStatus = run('status', '--asar', target.asarPath);
  assert.equal(selectedStatus.value.localization.selected.locale, 'ja-JP');
  assert.equal(selectedStatus.value.localization.pendingRestart, true);
  assert.equal(selectedStatus.value.localization.coverage.partial, true);
  assert.equal(selectedStatus.value.localization.lastKnownRuntime, null);
  const runtimePath = path.join(path.dirname(selectionPath), 'runtime-status.json');
  fs.writeFileSync(
    runtimePath,
    JSON.stringify({
      schemaVersion: 1,
      lastKnown: true,
      runId: 'previous-host-run',
      installationId: selection.installationId,
      artifactId: selection.artifactId,
      locale: selection.locale,
      healthState: 'active',
      logging: 'active',
      startedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      terminal: null,
    }),
  );
  const historical = run('status', '--asar', target.asarPath);
  assert.equal(historical.value.localization.lastKnownRuntime.healthState, 'active');
  assert.equal(historical.value.localization.lastKnownRuntime.locale, 'zh-Hant-TW');
  assert.equal(historical.value.localization.selected.locale, 'ja-JP');
  assert.equal(historical.value.localization.pendingRestart, true);
  fs.writeFileSync(runtimePath, '{');
  const corruptRuntime = run('status', '--asar', target.asarPath);
  assert.equal(corruptRuntime.value.localization.status, 'unavailable');
  assert.match(
    corruptRuntime.value.errors.find((error) => error.component === 'localization').error,
    /runtime-status.json/,
  );
  fs.writeFileSync(selectionPath, 'null');
  const corruptStatus = run('status', '--asar', target.asarPath);
  assert.equal(corruptStatus.value.localization.status, 'unavailable');
  assert.match(
    corruptStatus.value.errors.find((error) => error.component === 'localization').error,
    /must contain one JSON object/,
  );
});

test('automatic localization preparation preserves Capsule and rejects dirty inputs before publication', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const { run, target, stateRoot, profile, runtime } = managementPreparationFixture(t);
  const options = {
    ...target,
    backupDir: path.join(stateRoot, 'backups'),
    localizationProfiles: [profile],
  };
  await composer.applyFeatures(baseOptions(options), {
    features: { capsule: { code: capsuleCode } },
  });
  const archive = fs.readFileSync(target.asarPath);
  const status = composer.getHostStatus(baseOptions(options));
  const savedInputs = path.join(
    options.backupDir,
    'host',
    status.installationId,
    'inputs',
    `${status.receipt.inputsHash}.json`,
  );
  const inputs = fs.readFileSync(savedInputs);
  fs.appendFileSync(savedInputs, '\n');
  const dirty = run('prepare', '--localization', '--locale', 'zh-Hant-TW');
  assert.equal(dirty.status, 1);
  assert.match(dirty.value.error, /receipt hash/);
  assert.equal(fs.existsSync(path.join(stateRoot, 'localization')), false);
  assert.equal(fs.existsSync(path.join(stateRoot, 'management')), false);
  fs.writeFileSync(savedInputs, inputs);
  const binary = fs.readFileSync(target.binaryPath);
  fs.writeFileSync(target.binaryPath, 'dirty language server');
  const sourceMismatch = run('prepare', '--localization', '--locale', 'zh-Hant-TW');
  assert.equal(sourceMismatch.status, 1);
  assert.match(sourceMismatch.value.error, /Truncated client executable header/);
  assert.equal(fs.existsSync(path.join(stateRoot, 'localization')), false);
  assert.equal(fs.existsSync(path.join(stateRoot, 'management')), false);
  fs.writeFileSync(target.binaryPath, binary);
  const result = run('prepare', '--localization', '--locale', 'zh-Hant-TW');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value.capsule, false);
  assert.equal(result.value.planCapsule, true);
  const plan = JSON.parse(fs.readFileSync(result.value.localizationPlan, 'utf8'));
  assert.equal(plan.inputs.capsule.code, capsuleCode);
  const preflight = run(
    '--host-preflight',
    '--asar',
    target.asarPath,
    '--localization-plan',
    result.value.localizationPlan,
  );
  assert.equal(preflight.status, 0, preflight.stdout + preflight.stderr);
  assert.equal(preflight.value.components.localization.status, 'ready');
  assert.equal(preflight.value.components.capsule, undefined);
  assert.deepEqual(fs.readFileSync(target.asarPath), archive);
  const selected = run('prepare', '--capsule', '--localization', '--locale', 'en');
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  const selectedPlan = JSON.parse(fs.readFileSync(selected.value.localizationPlan, 'utf8'));
  assert.notEqual(selectedPlan.inputs.capsule.code, capsuleCode);
  const unchecked = run(
    '--host-preflight',
    '--asar',
    target.asarPath,
    '--localization-plan',
    selected.value.localizationPlan,
  );
  assert.equal(unchecked.status, 1);
  assert.match(unchecked.value.error, /unselected Capsule must retain/);
  const profilesPath = path.join(runtime, 'compat', 'localization', 'profiles.json');
  fs.writeFileSync(
    profilesPath,
    JSON.stringify({ schema: 1, profiles: [{ ...profile, asarSha256: 'a'.repeat(64) }] }),
  );
  fs.appendFileSync(target.binaryPath, 'new binary build with unchanged reviewed assets');
  const unlisted = run('prepare', '--localization', '--locale', 'ja-JP');
  assert.equal(unlisted.status, 0, unlisted.stdout + unlisted.stderr);
  assert.equal(
    unlisted.value.localization.warnings.some((warning) => warning.code === 'IDENTITY_DRIFT'),
    true,
  );
  assert.deepEqual(fs.readFileSync(target.asarPath), archive);
  fs.rmSync(path.join(runtime, 'dist', 'localization'), { recursive: true });
  const independent = run('prepare', '--capsule', '--locale', 'zh-Hant-TW');
  assert.equal(independent.status, 0, independent.stdout + independent.stderr);
  assert.equal(independent.value.localizationPlan, undefined);
  assert.equal(independent.value.localization.status, 'not-selected');
  const limitOnly = run('prepare', '--locale', 'zh-Hant-TW');
  assert.equal(limitOnly.status, 0, limitOnly.stdout + limitOnly.stderr);
  assert.equal(limitOnly.value.asarPath, target.asarPath);
  assert.equal(limitOnly.value.localizationPlan, undefined);
  const unavailable = run('status');
  assert.equal(unavailable.value.localization.status, 'unavailable');
  assert.match(unavailable.value.localization.reason, /build manifest is missing/);
  assert.deepEqual(fs.readFileSync(target.asarPath), archive);
});

function managementPreparationFixture(t) {
  const root = temporary(t);
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  fs.cpSync('scripts', path.join(runtime, 'scripts'), { recursive: true });
  fs.cpSync('src/plugin/lib', path.join(runtime, 'src/plugin/lib'), { recursive: true });
  fs.cpSync('src/capsule', path.join(runtime, 'src/capsule'), { recursive: true });
  fs.cpSync('src/localization/catalogs', path.join(runtime, 'src/localization/catalogs'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(runtime, 'compat/localization'), { recursive: true });
  fs.copyFileSync(
    'compat/localization/native-messages.json',
    path.join(runtime, 'compat/localization/native-messages.json'),
  );
  for (const component of ['host', 'localization']) {
    const manifestPath = `dist/${component}/bundle/build-manifest.json`;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const file of [
      ...Object.keys(manifest.inputs),
      ...Object.keys(manifest.outputs),
      manifestPath,
    ]) {
      const destination = path.join(runtime, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(file, destination);
    }
  }
  const original = fixture(root, 'installation');
  const source = path.join(root, 'installation', 'source');
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'antigravity-insiders',
      productName: 'Antigravity - Insiders',
      version: '1',
    }),
  );
  const anchor =
    'win.loadURL = (targetUrl, options) => hubWcv.webContents.loadURL(targetUrl, options);';
  fs.writeFileSync(path.join(source, 'dist/utils.js'), anchor);
  const resources = path.join(root, 'installation', 'resources');
  fs.mkdirSync(path.join(resources, 'bin'), { recursive: true });
  const asarPath = path.join(resources, 'app.asar');
  engine.createPackageWithOptions(source, asarPath, {});
  const executablePath = path.join(
    root,
    'installation',
    process.platform === 'win32'
      ? 'Antigravity - Insiders.exe'
      : process.platform === 'darwin'
        ? 'MacOS/Antigravity - Insiders'
        : 'antigravity-insiders',
  );
  fs.mkdirSync(path.dirname(executablePath), { recursive: true });
  fs.copyFileSync(original.executablePath, executablePath);
  const binaryPath = path.join(
    resources,
    'bin',
    process.platform === 'win32' ? 'language_server.exe' : 'language_server',
  );
  const main = `const translated = Fu("statusBarBackground", "Background color of the editor hover status bar.");
${anchoredMain()}`;
  const index = '<html></html>';
  const digest = (value) =>
    require2('node:crypto').createHash('sha256').update(value).digest('hex');
  const entries = [
    ['main.js', main],
    ['index.html', index],
  ];
  fs.writeFileSync(
    binaryPath,
    syntheticLanguageServer(entries, { prefix: fs.readFileSync(executablePath) }),
  );
  const profile = {
    profileId: 'automatic-synthetic',
    status: 'probe-only',
    product: 'hub',
    channel: 'insiders',
    platform: process.platform,
    version: '1',
    adapterVersion: '1',
    asarSha256: digest(fs.readFileSync(asarPath)),
    exeSha256: digest(fs.readFileSync(executablePath)),
    lsSha256: digest(fs.readFileSync(binaryPath)),
    nlsHelper: { calleeName: 'Fu' },
    assets: Object.fromEntries(
      entries.map(([name, data]) => [
        name,
        { sha256: digest(data), size: Buffer.byteLength(data) },
      ]),
    ),
    hostAdapter: { file: 'dist/utils.js', sha256: digest(anchor), anchor },
    limits: { maxEntryBytes: 1048576, maxEntries: 64, maxTotalBytes: 10485760 },
  };
  fs.mkdirSync(path.join(runtime, 'compat/localization'), { recursive: true });
  fs.writeFileSync(
    path.join(runtime, 'compat/localization/profiles.json'),
    JSON.stringify({ schema: 1, profiles: [profile] }),
  );
  fs.writeFileSync(
    path.join(runtime, 'compat/localization/usage-points.json'),
    JSON.stringify({
      schema: 1,
      profiles: {
        [profile.profileId]: {
          rules: [
            {
              kind: 'nls-default-string',
              messageId: 'workbench.hover.statusBar.background',
              file: 'main.js',
              upstreamKey: 'statusBarBackground',
              originalText: 'Background color of the editor hover status bar.',
              expectedHits: 1,
            },
          ],
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(runtime, 'compat/install-layout.json'),
    JSON.stringify({
      schema: 1,
      targets: JSON.parse(fs.readFileSync('compat/install-layout.json', 'utf8')).targets,
      platforms: {
        [process.platform]: {
          resources: 'resources',
          language_server: path.basename(binaryPath),
          channels: [
            {
              channel: 'insiders',
              root: path.dirname(resources),
              executable: path.relative(path.dirname(resources), executablePath),
            },
          ],
        },
      },
    }),
  );
  const stateRoot = path.join(root, 'tool-state');
  const run = (...args) => {
    const result = spawnSync(process.execPath, ['scripts/manage.mjs', ...args, '--json'], {
      cwd: runtime,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, AGYCTL_HOME: stateRoot },
    });
    return { ...result, value: JSON.parse(result.stdout) };
  };
  return {
    root,
    runtime,
    target: { asarPath, binaryPath, executablePath },
    profile,
    stateRoot,
    run,
  };
}

test('public capsule mutations preserve complete persisted localization inputs', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'public-preservation');
  const pristineBytes = fs.readFileSync(options.asarPath);
  const localization = localizationInputs(root);
  localization.files = { 'dist/agyctl-localization/extra.js': Buffer.from('module.exports = 42;') };
  await composer.applyFeatures(baseOptions(options), {
    features: { localization },
    baseProvenance: 'official-profile',
    ensureClientClosed: () => {},
  });
  const localizedMain = engine.extractFile(options.asarPath, 'dist/main.js');
  await installCapsule({ ...options, ensureClientClosed: () => {} });
  assert.deepEqual(getCapsuleStatus(options).features, { capsule: true, localization: true });
  assert.deepEqual(engine.extractFile(options.asarPath, 'dist/main.js'), localizedMain);
  const mixedStatus = getCapsuleStatus(options);
  const savedInputsPath = path.join(
    options.backupDir,
    'host',
    mixedStatus.installationId,
    'inputs',
    `${mixedStatus.receipt.inputsHash}.json`,
  );
  const savedInputs = fs.readFileSync(savedInputsPath);
  const mixedBytes = fs.readFileSync(options.asarPath);
  fs.appendFileSync(savedInputsPath, '\n');
  await assert.rejects(
    uninstallCapsule({ ...options, ensureClientClosed: () => {} }),
    (error) => error.code === 'SOURCE_MISMATCH' && /receipt hash/.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(options.asarPath), mixedBytes);
  fs.writeFileSync(savedInputsPath, savedInputs);
  await uninstallCapsule({ ...options, ensureClientClosed: () => {} });
  assert.deepEqual(getCapsuleStatus(options).features, { capsule: false, localization: true });
  assert.deepEqual(engine.extractFile(options.asarPath, 'dist/main.js'), localizedMain);
  assert.equal(
    engine.extractFile(options.asarPath, 'dist/agyctl-localization/extra.js').toString(),
    'module.exports = 42;',
  );
  const currentStatus = getCapsuleStatus(options);
  const currentReceipt = fs.readFileSync(currentStatus.recordPath, 'utf8');
  const oldReceipt = JSON.parse(currentReceipt);
  delete oldReceipt.inputsHash;
  fs.writeFileSync(currentStatus.recordPath, JSON.stringify(oldReceipt));
  const localizedBytes = fs.readFileSync(options.asarPath);
  await assert.rejects(
    installCapsule({ ...options, ensureClientClosed: () => {} }),
    (error) => error.code === 'RECEIPT_INVALID' && /inputsHash/.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(options.asarPath), localizedBytes);
  fs.writeFileSync(currentStatus.recordPath, currentReceipt);
  await composer.removeFeatures(baseOptions(options), {
    remove: ['capsule', 'localization'],
    ensureClientClosed: () => {},
  });
  assert.deepEqual(fs.readFileSync(options.asarPath), pristineBytes);
});

test('capsule preflight and mutations need no localization build, including retained localization', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const clean = fixture(root, 'independent-capsule');
  const mixed = fixture(root, 'retained-localization');
  await composer.applyFeatures(baseOptions(mixed), {
    features: { localization: localizationInputs(root) },
    ensureClientClosed: () => {},
  });
  const localizedMain = engine.extractFile(mixed.asarPath, 'dist/main.js').toString('base64');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(runtime);
  fs.cpSync('scripts', path.join(runtime, 'scripts'), {
    recursive: true,
    filter: (file) =>
      !['localization-build.mjs', 'localization-feature.mjs'].includes(path.basename(file)),
  });
  fs.cpSync('src/capsule', path.join(runtime, 'src/capsule'), { recursive: true });
  for (const name of [
    'metrics-core.mjs',
    'pricing-core.mjs',
    'poll-policy.mjs',
    'upstream-contract.mjs',
    'locale.mjs',
    'locale-state.mjs',
  ]) {
    const destination = path.join(runtime, 'src/plugin/lib', name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join('src/plugin/lib', name), destination);
  }
  const manifestPath = 'dist/host/bundle/build-manifest.json';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const file of [
    ...Object.keys(manifest.inputs),
    ...Object.keys(manifest.outputs),
    manifestPath,
    'compat/install-layout.json',
  ]) {
    const destination = path.join(runtime, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);
  }
  assert.equal(fs.existsSync(path.join(runtime, 'dist/localization')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'src/localization/catalogs')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'compat/localization')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'scripts/lib/localization-build.mjs')), false);
  assert.equal(fs.existsSync(path.join(runtime, 'scripts/lib/localization-feature.mjs')), false);
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { installCapsule, capsuleReadiness, getCapsuleStatus, sha256File } from './scripts/capsule-install.mjs';
    import { uninstallCapsule } from './scripts/capsule-uninstall.mjs';
    import { engine } from './scripts/lib/host-patch.mjs';
    const { targets, localizedMain } = JSON.parse(process.argv[1]);
    for (const [index, target] of targets.entries()) {
      const options = { ...target, capsuleCode: 'globalThis.__independent = true;', ensureClientClosed: () => {} };
      const originalHash = sha256File(options.asarPath);
      assert.equal(capsuleReadiness(options.asarPath, { ...options, preflight: true }).readiness.status, 'ready');
      await installCapsule(options);
      assert.equal(getCapsuleStatus(options).features.capsule, true);
      if (index === 1) assert.equal(engine.extractFile(options.asarPath, 'dist/main.js').toString('base64'), localizedMain);
      await uninstallCapsule(options);
      assert.equal(getCapsuleStatus(options).features.capsule, false);
      if (index === 0) assert.equal(sha256File(options.asarPath), originalHash);
      else {
        assert.equal(getCapsuleStatus(options).features.localization, true);
        assert.equal(engine.extractFile(options.asarPath, 'dist/main.js').toString('base64'), localizedMain);
      }
    }
    console.log('capsule-independent-ok');
  `,
      JSON.stringify({
        targets: [clean, mixed].map(({ asarPath, backupDir, executablePath }) => ({
          asarPath,
          backupDir,
          executablePath,
        })),
        localizedMain,
      }),
    ],
    {
      cwd: runtime,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, AGYCTL_HOME: path.join(root, 'tool-state') },
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /capsule-independent-ok/);
});

test('composer apply and deliberate failures leave locatable structured events', async (t) => {
  const root = temporary(t);
  const options = fixture(root, 'event-log');
  const io = baseOptions(options);
  const events = [];
  const logEvent = (event) => events.push(event);
  const result = await composer.applyFeatures(
    { ...io, logEvent },
    {
      features: { capsule: { code: capsuleCode } },
      ensureClientClosed: () => {},
    },
  );
  assert.equal(events.filter((event) => event.event === 'failed').length, 0);
  assert.equal(events.at(-1).event, 'completed');
  assert.ok(
    events.some((event) => event.detail?.includes(`patched=${result.receipt.patchedHash}`)),
    'the log must locate the committed archive hash',
  );

  // A deliberate binding failure emits exactly one terminal event with its
  // code, and the last completed stage stays identifiable.
  events.length = 0;
  const plan = composer.planHostPatch(
    { ...io, logEvent },
    { features: { capsule: { code: capsuleCode } } },
  );
  assert.ok(events.some((event) => event.stage === 'host.plan' && event.event === 'created'));
  events.length = 0;
  await assert.rejects(
    composer.applyHostPatch(
      { ...io, logEvent },
      { plan, features: { capsule: { code: CAPSULE_CODE_V2 } } },
    ),
    (error) => error.code === 'PLAN_MISMATCH',
  );
  const failed = events.filter((event) => event.event === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].stage, 'host.apply');
  assert.equal(failed[0].code, 'PLAN_MISMATCH');
  assert.equal(failed[0].level, 'error');

  const remove = fs.rmSync;
  const cleanup = t.mock.method(fs, 'rmSync', (file, options) => {
    if (path.basename(file).startsWith('.agyctl-rollback-'))
      throw new Error('rollback cleanup denied');
    return remove(file, options);
  });
  try {
    events.length = 0;
    await composer.applyFeatures(
      { ...io, logEvent },
      { features: { capsule: { code: CAPSULE_CODE_V2 } } },
    );
    const cleanupEvent = events.find((event) => event.stage === 'host.cleanup');
    assert.equal(cleanupEvent.level, 'warn');
    assert.equal(cleanupEvent.code, 'CLEANUP_FAILED');
    assert.match(cleanupEvent.detail, /Archive committed; cleanup failed.*rollback cleanup denied/);
    assert.equal(events.filter((event) => event.event === 'failed').length, 0);
    assert.equal(events.at(-1).event, 'completed');
    assert.equal(
      composer.getHostStatus(io).receipt.features.capsule.codeHash,
      require2('node:crypto').createHash('sha256').update(CAPSULE_CODE_V2).digest('hex'),
    );
  } finally {
    cleanup.mock.restore();
  }
});

test('composer preserves committed outcomes and original errors when cleanup or diagnostics fail', async (t) => {
  const root = temporary(t);
  const remove = fs.rmSync;
  const cleanup = t.mock.method(fs, 'rmSync', (file, options) => {
    if (path.basename(file).startsWith('.agyctl-host-')) throw new Error('staging cleanup denied');
    return remove(file, options);
  });
  try {
    const committed = fixture(root, 'committed-diagnostics');
    const result = await composer.applyFeatures(
      {
        ...baseOptions(committed),
        log() {
          throw new Error('text log denied');
        },
        logEvent(event) {
          if (event.stage === 'host.replace' || event.event === 'completed')
            throw new Error('event log denied');
        },
      },
      { features: { capsule: { code: capsuleCode } } },
    );
    assert.equal(
      composer.getHostStatus(baseOptions(committed)).currentHash,
      result.receipt.patchedHash,
    );
    assert.equal(result.warnings.filter((warning) => warning.code === 'CLEANUP_FAILED').length, 1);
    assert.equal(
      result.warnings.filter((warning) => warning.code === 'LOG_WRITE_FAILED').length,
      3,
    );

    const failed = fixture(root, 'failed-diagnostics');
    const original = fs.readFileSync(failed.asarPath);
    const primaryError = new Error('replacement refused');
    await assert.rejects(
      composer.applyFeatures(
        {
          ...baseOptions(failed),
          logEvent(event) {
            if (event.event === 'failed') throw new Error('failure log denied');
          },
        },
        {
          features: { capsule: { code: capsuleCode } },
          transaction() {
            throw primaryError;
          },
        },
      ),
      (error) => {
        assert.equal(error, primaryError);
        assert.deepEqual(
          error.warnings.map((warning) => warning.code),
          ['CLEANUP_FAILED', 'LOG_WRITE_FAILED'],
        );
        return true;
      },
    );
    assert.deepEqual(fs.readFileSync(failed.asarPath), original);
  } finally {
    cleanup.mock.restore();
  }
});

test('wrong reviewed-plan payload fails before any backup or provenance is created', async (t) => {
  const root = temporary(t);
  const options = fixture(root, 'payload-binding');
  const io = baseOptions(options);
  const before = fs.readFileSync(options.asarPath);
  const plan = composer.planHostPatch(io, { features: { capsule: { code: capsuleCode } } });
  await assert.rejects(
    composer.applyHostPatch(io, { plan, features: { capsule: { code: CAPSULE_CODE_V2 } } }),
    (error) => error.code === 'PLAN_MISMATCH',
  );
  assert.equal(fs.existsSync(options.backupDir), false);
  assert.deepEqual(fs.readFileSync(options.asarPath), before);
});

test('CLI apply uses the reviewed plan target and bundled payload without feature flags', (t) => {
  const root = temporary(t);
  const options = fixture(root, 'cli-plan');
  const codePath = path.join(root, 'capsule.js');
  fs.writeFileSync(codePath, capsuleCode);
  const spawnOptions = {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AGYCTL_HOME: path.join(root, 'tool-state') },
  };
  const planned = spawnSync(
    process.execPath,
    [
      'scripts/host-patch.mjs',
      'plan',
      '--asar',
      options.asarPath,
      '--backup-dir',
      options.backupDir,
      '--executable',
      options.executablePath,
      '--capsule',
      '--capsule-code',
      codePath,
      '--json',
    ],
    spawnOptions,
  );
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal(fs.existsSync(options.backupDir), false);
  assert.equal(JSON.parse(planned.stdout).inputs.capsule.code, capsuleCode);
  const planPath = path.join(root, 'plan.json');
  fs.writeFileSync(planPath, planned.stdout);
  assert.equal(loadReviewedHostPlan(planPath, { asarPath: options.asarPath }).readiness, 'ready');
  const other = fixture(root, 'other-plan-target');
  assert.throws(
    () => loadReviewedHostPlan(planPath, { asarPath: other.asarPath }),
    (error) => error.code === 'PLAN_MISMATCH' && /different installation/.test(error.message),
  );
  const result = spawnSync(
    process.execPath,
    ['scripts/host-patch.mjs', 'apply', '--plan', planPath, '--json'],
    spawnOptions,
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).applied, true);
  assert.equal(loadReviewedHostPlan(planPath, { asarPath: options.asarPath }).readiness, 'current');
  assert.equal(getCapsuleStatus(options).features.capsule, true);
  const removed = spawnSync(
    process.execPath,
    [
      'scripts/host-patch.mjs',
      'remove',
      '--asar',
      options.asarPath,
      '--backup-dir',
      options.backupDir,
      '--executable',
      options.executablePath,
      '--capsule',
      '--json',
    ],
    spawnOptions,
  );
  assert.equal(removed.status, 0, removed.stdout + removed.stderr);
  assert.equal(getCapsuleStatus(options).archiveKind, 'pristine');
});

test('public capsule install refuses unknown or integrity-enforcing Electron binaries without writes', async (t) => {
  const root = temporary(t);
  for (const [name, bytes] of [
    ['unknown', Buffer.from('MZ no fuse qualification')],
    [
      'enabled',
      Buffer.concat([
        Buffer.from('MZdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
        Buffer.from([1, 5]),
        Buffer.from('00001'),
      ]),
    ],
  ]) {
    const options = fixture(root, name);
    const executablePath = options.executablePath;
    fs.writeFileSync(executablePath, bytes);
    const before = fs.readFileSync(options.asarPath);
    await assert.rejects(
      installCapsule({ ...options, executablePath }),
      (error) => error.code === 'UNSUPPORTED_STATE' && /integrity|fuse/i.test(error.message),
    );
    assert.deepEqual(fs.readFileSync(options.asarPath), before);
    assert.equal(fs.existsSync(options.backupDir), false);
  }
  const paired = fixture(root, 'paired');
  const unrelated = fixture(root, 'unrelated');
  await assert.rejects(
    installCapsule({ ...paired, executablePath: unrelated.executablePath }),
    (error) => error.code === 'UNSUPPORTED_STATE' && /paired with this archive/.test(error.message),
  );
  assert.equal(getCapsuleStatus(paired).archiveKind, 'pristine');
});

function fixture(root, name = 'client', { version = '1' } = {}) {
  const directory = path.join(root, name);
  const source = path.join(directory, 'source');
  const asarPath = path.join(directory, 'app.asar');
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'dist', 'preload.js'),
    `const version = ${JSON.stringify(version)};\n`,
  );
  fs.writeFileSync(
    path.join(source, 'dist', 'main.js'),
    `const boot = () => {\n  void win.loadURL(url);\n};\nmodule.exports = { boot };\n`,
  );
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  engine.createPackageWithOptions(source, asarPath, {});
  writeServedLanguageServer(asarPath);
  const executablePath = path.join(directory, 'fixture.exe');
  fs.writeFileSync(
    executablePath,
    Buffer.concat([
      Buffer.from('MZdL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
      Buffer.from([1, 5]),
      Buffer.from('00000'),
    ]),
  );
  const hash = (file) =>
    require2('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const localizationProfiles = [
    {
      profileId: 'hub-win-x64-synthetic',
      status: 'verified',
      asarSha256: hash(asarPath),
      exeSha256: hash(executablePath),
    },
  ];
  return {
    asarPath,
    backupDir: path.join(root, 'backups'),
    engine,
    capsuleCode,
    executablePath,
    localizationProfiles,
  };
}

function localizationInputs(root, { adapterEdits = true } = {}) {
  return loadLocalizationInputs({
    profileId: 'hub-win-x64-synthetic',
    stateRoot: path.join(root, 'localization-state'),
    adapterEdits: adapterEdits
      ? [
          {
            file: 'dist/main.js',
            anchor: 'void win.loadURL(url);',
            insertBefore:
              'require("./agyctl-localization/host-engine.js").init({ origin: "https://127.0.0.1" });\n',
          },
        ]
      : [],
  });
}

function baseOptions(fixtureOptions) {
  return {
    ...hostPatchIo(fixtureOptions),
    asarPath: fixtureOptions.asarPath,
    backupDir: fixtureOptions.backupDir,
    engine,
    transaction: replaceFileTransaction,
    executablePath: fixtureOptions.executablePath,
    localizationProfiles: fixtureOptions.localizationProfiles,
  };
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-host-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('localization profile evidence warns without bypassing its own preflight', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  for (const status of ['verified', 'probe-only']) {
    const options = fixture(root, `profile-${status}`);
    const events = [];
    const profile = options.localizationProfiles[0];
    profile.status = status;
    profile.asarSha256 = 'a'.repeat(64);
    profile.exeSha256 = 'b'.repeat(64);
    const io = { ...baseOptions(options), logEvent: (event) => events.push(event) };
    const features = { localization: localizationInputs(root), capsule: { code: capsuleCode } };
    const plan = composer.planHostPatch(io, { features, baseProvenance: 'official-profile' });
    const result = await composer.applyHostPatch(io, {
      plan,
      features,
      ensureClientClosed: () => {},
    });
    assert.equal(result.receipt.features.localization.profileStatus, status);
    assert.equal(composer.getHostStatus(io).receipt.features.localization.profileStatus, status);
    for (const stage of ['host.plan', 'host.apply']) {
      const warnings = events.filter((event) => event.stage === stage && event.level === 'warn');
      assert.equal(warnings.filter((event) => event.code === 'IDENTITY_DRIFT').length, 2);
      assert.equal(
        warnings.filter((event) => event.code === 'UNTESTED_BUILD').length,
        status === 'probe-only' ? 1 : 0,
      );
    }
    await composer.removeFeatures(io, { remove: ['localization'], ensureClientClosed: () => {} });
    assert.deepEqual(composer.getHostStatus(io).features, { capsule: true, localization: false });
  }
  const unknown = fixture(root, 'unknown-profile');
  const before = fs.readFileSync(unknown.asarPath);
  const features = { localization: { ...localizationInputs(root), profileId: 'unlisted' } };
  await assert.rejects(
    composer.applyFeatures(baseOptions(unknown), { features, ensureClientClosed: () => {} }),
    (error) => error.code === 'UNSUPPORTED_STATE' && /profile/.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(unknown.asarPath), before);

  const adapters = fixture(root, 'adapter-preflight');
  const adapterBytes = fs.readFileSync(adapters.asarPath);
  for (const anchor of ['missing anchor', ' ']) {
    const localization = localizationInputs(root);
    localization.adapterEdits[0].anchor = anchor;
    await assert.rejects(
      composer.applyFeatures(baseOptions(adapters), {
        features: { localization },
        ensureClientClosed: () => {},
      }),
      (error) =>
        error.code === 'SOURCE_MISMATCH' &&
        /Adapter anchor (not found|is not unique)/.test(error.message),
    );
    assert.deepEqual(fs.readFileSync(adapters.asarPath), adapterBytes);
  }

  const reserved = localizationInputs(root);
  reserved.files['dist/agyctl-localization/host-engine.js'] = Buffer.from('conflicting engine');
  assert.throws(
    () => composer.planHostPatch(baseOptions(adapters), { features: { localization: reserved } }),
    (error) => error.code === 'HOST_CONFLICT' && /reserved.*host-engine/.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(adapters.asarPath), adapterBytes);

  const cli = fixture(root, 'cli-profile');
  const profile = JSON.parse(fs.readFileSync('compat/localization/profiles.json', 'utf8'))
    .profiles[0];
  const inputsPath = path.join(root, 'localization-inputs.json');
  fs.writeFileSync(
    inputsPath,
    JSON.stringify(
      composer.encodeFeatureInputs({
        localization: {
          ...localizationInputs(root),
          profileId: profile.profileId,
          // Every reviewed profile carries a host adapter and native member
          // edits now; planning validates that the inputs carry the reviewed
          // edits and the runtime config without touching real member bytes.
          adapterEdits: [
            {
              file: profile.hostAdapter.file,
              anchor: profile.hostAdapter.anchor,
              replaceAnchor:
                "win.loadURL = (targetUrl, options) => require('./agyctl-localization/host-engine.js').loadLocalizedURL(hubWcv.webContents, targetUrl, options);",
            },
            ...(profile.nativeEdits ?? []).map((edit) => ({
              file: edit.file,
              anchor: edit.anchor,
              replaceAnchor: edit.replaceAnchor,
            })),
          ],
          files: {
            'dist/agyctl-localization/runtime-config.json': Buffer.from(
              JSON.stringify({
                schemaVersion: 2,
                stateRoot: 'C:/x',
                installationId: '0'.repeat(64),
              }),
            ),
          },
        },
      }),
    ),
  );
  const planned = spawnSync(
    process.execPath,
    [
      'scripts/host-patch.mjs',
      'plan',
      '--asar',
      cli.asarPath,
      '--executable',
      cli.executablePath,
      '--backup-dir',
      cli.backupDir,
      '--localization',
      '--profile',
      profile.profileId,
      '--localization-inputs',
      inputsPath,
      '--json',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, AGYCTL_HOME: path.join(root, 'tool-state') },
    },
  );
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal(JSON.parse(planned.stdout).features.localization.profileId, profile.profileId);
  assert.match(planned.stderr, /UNTESTED_BUILD/);
  assert.match(planned.stderr, /IDENTITY_DRIFT/);
});

function preloadOf(asarPath) {
  return engine.extractFile(asarPath, 'dist/preload.js').toString('utf8');
}

test('adapter edits compose once per pristine member', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'multiple-adapters');
  const localization = localizationInputs(root);
  localization.adapterEdits = [
    {
      file: 'dist/main.js',
      anchor: 'module.exports = { boot };',
      replaceAnchor: 'module.exports = { boot, patched: true };',
    },
    {
      file: 'dist/main.js',
      anchor: 'void win.loadURL(url);',
      insertBefore: '/* module.exports = { boot }; */\n  ',
    },
    {
      file: 'dist/main.js',
      anchor: 'const boot = () => {',
      insertAfter: '\n  const ready = true;',
    },
    { file: 'dist/main.js', anchor: '\n};\n', insertBefore: '' },
  ];
  await composer.applyFeatures(baseOptions(options), {
    features: { localization },
    ensureClientClosed: () => {},
  });
  assert.equal(
    engine.extractFile(options.asarPath, 'dist/main.js').toString('utf8'),
    'const boot = () => {\n  const ready = true;\n  /* module.exports = { boot }; */\n  void win.loadURL(url);\n};\nmodule.exports = { boot, patched: true };\n',
  );
});

test('adapter edits reject overlapping pristine anchors without replacing the archive', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const localization = localizationInputs(root);
  const overlap = fixture(root, 'overlapping-adapters');
  const original = fs.readFileSync(overlap.asarPath);
  localization.adapterEdits = [
    { file: 'dist/main.js', anchor: 'void win.loadURL(url);', replaceAnchor: 'void 0;' },
    { file: 'dist/main.js', anchor: 'win.loadURL(url)', insertBefore: '/* overlap */' },
  ];
  await assert.rejects(
    composer.applyFeatures(baseOptions(overlap), {
      features: { localization },
      ensureClientClosed: () => {},
    }),
    (error) => error.code === 'SOURCE_MISMATCH' && /overlap.*dist\/main.js/i.test(error.message),
  );
  assert.deepEqual(fs.readFileSync(overlap.asarPath), original);
});

test('mixed compose, single-feature removal, and full restore keep both sides intact', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root);
  const pristineBytes = fs.readFileSync(options.asarPath);

  await installCapsule(options);
  const capsuleOnlyStatus = getCapsuleStatus(baseOptions(options));
  assert.equal(capsuleOnlyStatus.archiveKind, 'host-managed');
  assert.equal(capsuleOnlyStatus.features.capsule, true);
  assert.equal(capsuleOnlyStatus.features.localization, false);
  const legacyRecordPath = path.join(
    options.backupDir,
    'capsule',
    capsuleOnlyStatus.installationId,
    'records',
    `${capsuleOnlyStatus.currentHash}.json`,
  );
  assert.equal(fs.existsSync(legacyRecordPath), false);

  const inputs = localizationInputs(root);
  const mixed = await composer.applyFeatures(baseOptions(options), {
    features: { localization: inputs },
    baseProvenance: 'official-profile',
    ensureClientClosed: () => {},
  });
  assert.equal(
    mixed.receipt.features.capsule.codeHash,
    capsuleOnlyStatus.receipt.features.capsule.codeHash,
  );
  assert.equal(mixed.receipt.features.localization.profileId, 'hub-win-x64-synthetic');
  const mixedStatus = getCapsuleStatus(baseOptions(options));
  assert.equal(mixedStatus.archiveKind, 'host-managed');
  assert.equal(mixedStatus.installed, true);
  assert.equal(mixedStatus.features.localization, true);
  assert.ok(preloadOf(options.asarPath).includes(HOST_MANAGED_MARKER));
  assert.ok(preloadOf(options.asarPath).includes(HOST_CAPSULE_FEATURE_MARKER));
  const patchedMain = engine.extractFile(options.asarPath, 'dist/main.js').toString('utf8');
  assert.match(patchedMain, /host-engine\.js/, 'adapter edit must reach the archive entry');

  // Removing localization keeps the capsule and its current receipt.
  await composer.removeFeatures(baseOptions(options), {
    remove: ['localization'],
    capsule: { code: capsuleCode },
    ensureClientClosed: () => {},
  });
  const capsuleAgain = getCapsuleStatus(baseOptions(options));
  assert.equal(capsuleAgain.archiveKind, 'host-managed');
  assert.equal(capsuleAgain.features.capsule, true);
  assert.equal(capsuleAgain.features.localization, false);
  // Deterministic recomposition reproduces the same bytes and receipt path.
  assert.equal(capsuleAgain.recordPath, capsuleOnlyStatus.recordPath);
  assert.equal(fs.existsSync(legacyRecordPath), false);

  // Re-apply localization, then remove the capsule: localization is preserved
  // and recomposed from the same verified original.
  const mixedAgain = await composer.applyFeatures(baseOptions(options), {
    features: { localization: localizationInputs(root) },
    baseProvenance: 'official-profile',
    ensureClientClosed: () => {},
  });
  assert.equal(
    mixedAgain.receipt.features.capsule.codeHash,
    capsuleOnlyStatus.receipt.features.capsule.codeHash,
  );
  const afterCapsuleRemoval = await composer.removeFeatures(baseOptions(options), {
    remove: ['capsule'],
    localization: localizationInputs(root),
    ensureClientClosed: () => {},
  });
  const localizationOnly = getCapsuleStatus(baseOptions(options));
  assert.equal(localizationOnly.features.capsule, false);
  assert.equal(localizationOnly.features.localization, true);
  assert.equal(localizationOnly.installed, false, 'capsule projection must be inactive');
  assert.ok(afterCapsuleRemoval.receipt.features.localization);
  assert.ok(!afterCapsuleRemoval.receipt.features.capsule);
  assert.equal(
    path.basename(
      path.dirname(path.dirname(path.dirname(afterCapsuleRemoval.receipt.originalBackupRef))),
    ),
    'host',
    'the verified original is shared across recompositions',
  );

  // Full removal restores the exact pristine original.
  await composer.removeFeatures(baseOptions(options), {
    remove: ['localization'],
    ensureClientClosed: () => {},
  });
  assert.deepEqual(fs.readFileSync(options.asarPath), pristineBytes);
  const restored = getCapsuleStatus(baseOptions(options));
  assert.equal(restored.archiveKind, 'pristine');
  assert.equal(restored.installed, false);
});

test('localization-only state is not misreported as capsule and emits only current markers', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'localization-only');
  await installCapsule(options);
  await composer.applyFeatures(baseOptions(options), {
    features: { localization: localizationInputs(root, { adapterEdits: false }) },
    baseProvenance: 'official-profile',
    ensureClientClosed: () => {},
  });
  // Composition carries the capsule forward; remove it explicitly.
  await composer.removeFeatures(baseOptions(options), {
    remove: ['capsule'],
    localization: localizationInputs(root, { adapterEdits: false }),
    ensureClientClosed: () => {},
  });
  const status = getCapsuleStatus(baseOptions(options));
  assert.equal(status.installed, false);
  assert.equal(status.features.localization, true);
  const projected = capsuleReadiness(options.asarPath, { backupDir: options.backupDir });
  assert.equal(projected.installed, false);
  assert.equal(projected.readiness.status, 'ready');
  const legacyRecordPath = path.join(
    options.backupDir,
    'capsule',
    status.installationId,
    'records',
    `${status.currentHash}.json`,
  );
  assert.equal(fs.existsSync(legacyRecordPath), false);
  assert.equal(preloadOf(options.asarPath).includes(composer.CAPSULE_HOOK_MARKER), false);
  const backupsBefore = fs.readdirSync(
    path.join(options.backupDir, 'host', status.installationId, 'originals'),
  );
  // ensureOriginalBackup must not forge a new "original" for a
  // localization archive; it reuses the verified receipt original.
  const ensured = ensureOriginalBackup(options.asarPath, options.backupDir, engine);
  assert.equal(path.basename(path.dirname(path.dirname(path.dirname(ensured.backupPath)))), 'host');
  const backupsAfter = fs.readdirSync(
    path.join(options.backupDir, 'host', status.installationId, 'originals'),
  );
  assert.deepEqual(backupsAfter, backupsBefore);
});

test('schema 1 exact pairs are refused without changing archives or backup history', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'legacy-install');
  const crypto = require2('node:crypto');
  // Hand-compose the exact state an old capsule-only install produced.
  const pristineHash = (() => {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(options.asarPath));
    return hash.digest('hex');
  })();
  const staging = path.join(root, 'legacy-staging');
  fs.mkdirSync(staging);
  const legacyStaged = path.join(staging, 'app.asar');
  const preload = engine.extractFile(options.asarPath, 'dist/preload.js').toString('utf8');
  const hook = '\n' + composer.CAPSULE_HOOK_MARKER + '\n';
  engine.patchArchive(options.asarPath, legacyStaged, {
    'dist/preload.js': Buffer.from(preload + hook),
    'dist/input-capsule.js': Buffer.from(capsuleCode),
  });
  const patchedHash = (() => {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(legacyStaged));
    return hash.digest('hex');
  })();
  const installation = composer.computeInstallationIdentity(options.asarPath);
  const legacyRecord = {
    schemaVersion: 1,
    installationId: installation.installationId,
    asarPath: installation.asarPath,
    channel: installation.channel,
    originalHash: pristineHash,
    patchedHash,
    unpackedHash: unpackedHash(options.asarPath),
    backupName: `original-${pristineHash}-${unpackedHash(options.asarPath) || 'packed'}.asar`,
    capsuleHash: crypto.createHash('sha256').update(capsuleCode).digest('hex'),
  };
  fs.mkdirSync(path.join(options.backupDir, 'capsule', installation.installationId, 'records'), {
    recursive: true,
  });
  fs.copyFileSync(
    options.asarPath,
    path.join(options.backupDir, 'capsule', installation.installationId, legacyRecord.backupName),
    fs.constants.COPYFILE_EXCL,
  );
  fs.writeFileSync(
    path.join(
      options.backupDir,
      'capsule',
      installation.installationId,
      'records',
      `${patchedHash}.json`,
    ),
    JSON.stringify(legacyRecord, null, 2) + '\n',
  );
  fs.copyFileSync(legacyStaged, options.asarPath);

  const installedBytes = fs.readFileSync(options.asarPath);
  await assert.rejects(
    composer.applyFeatures(baseOptions(options), {
      features: { localization: localizationInputs(root, { adapterEdits: false }) },
      baseProvenance: 'official-profile',
      ensureClientClosed: () => {},
    }),
    (error) => error.code === 'UNSUPPORTED_STATE',
  );
  assert.deepEqual(fs.readFileSync(options.asarPath), installedBytes);
  const backupPath = path.join(
    options.backupDir,
    'capsule',
    installation.installationId,
    legacyRecord.backupName,
  );
  assert.equal(
    require2('node:crypto').createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex'),
    pristineHash,
  );
  const oldRecordPath = path.join(
    options.backupDir,
    'capsule',
    installation.installationId,
    'records',
    `${patchedHash}.json`,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(oldRecordPath, 'utf8')), legacyRecord);
});

test('unknown hooks and dirty originals are refused without writing anything', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'foreign');
  const staging = path.join(root, 'foreign-staging');
  fs.mkdirSync(staging);
  const hooked = path.join(staging, 'app.asar');
  engine.patchArchive(options.asarPath, hooked, {
    'dist/preload.js': Buffer.from(
      `${preloadOf(options.asarPath)}${composer.CAPSULE_HOOK_MARKER}\n`,
    ),
  });
  fs.copyFileSync(hooked, options.asarPath);
  const hookedBytes = fs.readFileSync(options.asarPath);
  assert.throws(() => getCapsuleStatus(baseOptions(options)), /Unknown hooked app\.asar/);
  assert.throws(
    () => ensureOriginalBackup(options.asarPath, options.backupDir, engine),
    /Unknown hooked app\.asar/,
  );
  assert.deepEqual(fs.readFileSync(options.asarPath), hookedBytes);
  await assert.rejects(
    composer.applyFeatures(baseOptions(options), {
      features: { localization: localizationInputs(root, { adapterEdits: false }) },
      baseProvenance: 'official-profile',
      ensureClientClosed: () => {},
    }),
    /Unknown hooked app\.asar/,
  );
  assert.deepEqual(fs.readFileSync(options.asarPath), hookedBytes);
  assert.equal(fs.existsSync(options.backupDir), false);
});

test('concurrent host operations serialize; stale and self locks are reclaimed; foreign locks refuse', async (t) => {
  const root = temporary(t);
  const options = fixture(root, 'locking');
  const lockDir = path.join(
    options.backupDir,
    'host',
    composer.computeInstallationIdentity(options.asarPath).installationId,
  );
  fs.mkdirSync(lockDir, { recursive: true });

  // A live-looking foreign lock must refuse immediately.
  fs.writeFileSync(
    path.join(lockDir, 'host.lock'),
    `${JSON.stringify({ schemaVersion: 1, pid: process.pid, exePath: 'C:\\definitely-not-us.exe', startedAt: 'now', token: 't' })}\n`,
  );
  await assert.rejects(
    composer.applyFeatures(baseOptions(options), { features: { capsule: { code: capsuleCode } } }),
    (error) => error.code === 'LOCK_BUSY',
  );
  assert.equal(getCapsuleStatus(baseOptions(options)).installed, false);

  // A dead holder leaves a stale lock that is reclaimed with evidence kept.
  fs.writeFileSync(
    path.join(lockDir, 'host.lock'),
    `${JSON.stringify({ schemaVersion: 1, pid: 999999999, exePath: 'gone.exe', startedAt: 'now', token: 't' })}\n`,
  );
  await composer.applyFeatures(baseOptions(options), {
    features: { capsule: { code: capsuleCode } },
  });
  assert.equal(getCapsuleStatus(baseOptions(options)).installed, true);
  assert.equal(
    fs.readdirSync(lockDir).some((name) => name.startsWith('host.lock.stale-')),
    true,
  );
  fs.rmSync(path.join(lockDir, 'host.lock'), { force: true });

  // Two simultaneous applies serialize; the second plan is bound to the
  // pristine hash and is refused cleanly instead of racing the first commit.
  fs.rmSync(options.asarPath, { force: true });
  fs.rmSync(options.backupDir, { recursive: true, force: true });
  const options2 = fixture(root, 'locking-2');
  const results = await Promise.allSettled([
    composer.applyFeatures(baseOptions(options2), { features: { capsule: { code: capsuleCode } } }),
    composer.applyFeatures(baseOptions(options2), {
      features: { capsule: { code: CAPSULE_CODE_V2 } },
    }),
  ]);
  const outcomes = results.map((entry) => entry.status);
  assert.deepEqual(outcomes.sort(), ['fulfilled', 'rejected']);
  const rejected = results.find((entry) => entry.status === 'rejected').reason;
  assert.equal(rejected.code, 'SOURCE_MISMATCH');
  const finalStatus = getCapsuleStatus(baseOptions(options2));
  assert.equal(finalStatus.installed, true);
  assert.equal(finalStatus.features.capsule, true);
  assert.ok(finalStatus.receipt);
  const winnerCode = results[0].status === 'fulfilled' ? capsuleCode : CAPSULE_CODE_V2;
  assert.equal(
    finalStatus.receipt.features.capsule.codeHash,
    require2('node:crypto').createHash('sha256').update(winnerCode).digest('hex'),
  );
});

test('an official update is not downgraded and a clean reinstall starts a new original chain', async (t) => {
  const root = temporary(t);
  const options = fixture(root, 'update');
  await installCapsule(options);
  const firstBackup = getCapsuleStatus(baseOptions(options)).backupPath;
  const firstBackupBytes = fs.readFileSync(firstBackup);
  const updated = fixture(root, 'updated-client', { version: '2' });
  const updatedHash = require2('node:crypto')
    .createHash('sha256')
    .update(fs.readFileSync(updated.asarPath))
    .digest('hex');
  fs.copyFileSync(updated.asarPath, options.asarPath);
  const statusAfterUpdate = getCapsuleStatus(baseOptions(options));
  assert.equal(statusAfterUpdate.archiveKind, 'pristine');
  assert.equal(statusAfterUpdate.installed, false);
  await installCapsule(options);
  const second = getCapsuleStatus(baseOptions(options));
  assert.equal(second.installed, true);
  assert.notEqual(second.backupPath, firstBackup);
  assert.equal(
    second.receipt.originalHash,
    updatedHash,
    'the new original chain binds the updated archive',
  );
  assert.deepEqual(fs.readFileSync(firstBackup), firstBackupBytes);
});

test('localization applies refuse when the client state is unconfirmed', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'client-gate');
  await installCapsule(options);
  const installedBytes = fs.readFileSync(options.asarPath);
  await assert.rejects(
    composer.applyFeatures(baseOptions(options), {
      features: { localization: localizationInputs(root, { adapterEdits: false }) },
      baseProvenance: 'official-profile',
    }),
    (error) => error.code === 'CLIENT_RUNNING_UNKNOWN',
  );
  await assert.rejects(
    composer.applyFeatures(baseOptions(options), {
      features: { localization: localizationInputs(root, { adapterEdits: false }) },
      baseProvenance: 'official-profile',
      ensureClientClosed: () => {
        throw new composer.ComposerError('CLIENT_RUNNING', 'client is running');
      },
    }),
    (error) => error.code === 'CLIENT_RUNNING',
  );
  assert.deepEqual(fs.readFileSync(options.asarPath), installedBytes);
  const reapplied = await composer.applyFeatures(baseOptions(options), {
    features: { localization: localizationInputs(root, { adapterEdits: false }) },
    baseProvenance: 'original-recorded',
    ensureClientClosed: () => {},
  });
  assert.equal(reapplied.receipt.baseProvenance, 'original-recorded');
  assert.deepEqual(composer.getHostStatus(baseOptions(options)).features, {
    capsule: true,
    localization: true,
  });
});

test('localization apply re-checks the client state inside the lock before replacing the archive', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'client-recheck');
  const original = fs.readFileSync(options.asarPath);
  let checks = 0;
  await assert.rejects(
    composer.applyFeatures(baseOptions(options), {
      features: { localization: localizationInputs(root, { adapterEdits: false }) },
      baseProvenance: 'official-profile',
      ensureClientClosed: () => {
        checks += 1;
        if (checks === 2)
          throw new composer.ComposerError('CLIENT_RUNNING', 'client started during staging');
      },
    }),
    (error) => error.code === 'CLIENT_RUNNING',
  );
  assert.equal(checks, 2);
  assert.deepEqual(fs.readFileSync(options.asarPath), original);
});

test('an unreadable host lock refuses while fresh and is reclaimed once abandoned', async (t) => {
  const root = temporary(t);
  const options = fixture(root, 'unreadable-lock');
  const lockPath = path.join(
    options.backupDir,
    'host',
    composer.computeInstallationIdentity(options.asarPath).installationId,
    'host.lock',
  );
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, '');
  await assert.rejects(
    composer.applyFeatures(baseOptions(options), { features: { capsule: { code: capsuleCode } } }),
    (error) => error.code === 'LOCK_BUSY',
  );
  const abandoned = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, abandoned, abandoned);
  await composer.applyFeatures(baseOptions(options), {
    features: { capsule: { code: capsuleCode } },
  });
  assert.equal(getCapsuleStatus(baseOptions(options)).installed, true);
});

test('plans are identity-bound; corrupted installs are refused before any write', async (t) => {
  const root = temporary(t);
  const options = fixture(root, 'plan-binding');
  const io = baseOptions(options);
  const crypto = require2('node:crypto');
  const plan = composer.planHostPatch(io, { features: { capsule: { code: capsuleCode } } });
  const planAgain = composer.planHostPatch(io, { features: { capsule: { code: capsuleCode } } });
  assert.equal(plan.planId, planAgain.planId, 'the same inputs must yield the same plan id');
  const originalBytes = fs.readFileSync(options.asarPath);
  const tampered = Buffer.from(originalBytes);
  tampered.write('tampered', 0, 'utf8');
  fs.writeFileSync(options.asarPath, tampered);
  await assert.rejects(
    composer.applyFeatures(io, { features: { capsule: { code: capsuleCode } } }),
    /Invalid ASAR header|Truncated ASAR archive|asar/i,
  );
  fs.writeFileSync(options.asarPath, originalBytes);
  const result = await composer.applyFeatures(io, { features: { capsule: { code: capsuleCode } } });
  assert.equal(
    result.receipt.patchedHash,
    crypto.createHash('sha256').update(fs.readFileSync(options.asarPath)).digest('hex'),
  );
});

test('planning is read-only, binds every input, and apply verifies the reviewed plan', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'plan-contract');
  const io = baseOptions(options);
  const inputs = localizationInputs(root);
  const features = { localization: inputs, capsule: { code: capsuleCode } };
  inputs.adapterEdits = [
    {
      file: 'dist/main.js',
      anchor: 'void win.loadURL(url);',
      replaceAnchor: 'void win.loadURL(url + "?fixture");',
    },
  ];
  inputs.observedSource = {
    sourceKind: 'ls-binary',
    lsSha256: 'a'.repeat(64),
    sourceIdentity: 'b'.repeat(64),
    nlsHelperCalleeName: 'Fu',
    matchedProfileId: inputs.profileId,
    warnings: [{ code: 'IDENTITY_DRIFT', message: 'synthetic binary drift' }],
  };
  const plan = composer.planHostPatch(io, { features, baseProvenance: 'official-profile' });
  assert.equal(plan.schemaVersion, 3);
  assert.throws(
    () => composer.validateHostPlan({ ...plan, schemaVersion: 2 }),
    (error) => error.code === 'RECEIPT_INVALID' && /schemaVersion/.test(error.message),
  );
  assert.equal(
    fs.existsSync(options.backupDir),
    false,
    'planning must not create backups or records',
  );

  // Every input content is bound: different payloads, edits, or files can
  // never share a plan id.
  const planOtherBridge = composer.planHostPatch(io, {
    features: {
      localization: {
        ...inputs,
        preloadBridge: Buffer.concat([inputs.preloadBridge, Buffer.from('\n')]),
      },
      capsule: { code: capsuleCode },
    },
    baseProvenance: 'official-profile',
  });
  assert.notEqual(plan.planId, planOtherBridge.planId, 'the preload bridge must be bound');
  const planOtherEdits = composer.planHostPatch(io, {
    features: {
      localization: localizationInputs(root, { adapterEdits: false }),
      capsule: { code: capsuleCode },
    },
    baseProvenance: 'official-profile',
  });
  assert.notEqual(plan.planId, planOtherEdits.planId, 'adapter edits must be bound');
  const planOtherFiles = composer.planHostPatch(io, {
    features: {
      localization: { ...inputs, files: { 'dist/agyctl-localization/extra.js': Buffer.from('x') } },
      capsule: { code: capsuleCode },
    },
    baseProvenance: 'official-profile',
  });
  assert.notEqual(plan.planId, planOtherFiles.planId, 'additional files must be bound');
  await assert.rejects(
    composer.applyHostPatch(io, {
      plan,
      features: {
        ...features,
        localization: {
          ...inputs,
          observedSource: { ...inputs.observedSource, sourceIdentity: 'c'.repeat(64) },
        },
      },
      ensureClientClosed: () => {},
    }),
    (error) => error.code === 'PLAN_MISMATCH' && /Observed-source/.test(error.message),
  );

  // A plan that does not match its own binding identity refuses before any
  // write: no backup, no records, no archive change.
  const before = fs.readFileSync(options.asarPath);
  const tampered = { ...plan, currentHash: 'f'.repeat(64) };
  await assert.rejects(
    composer.applyHostPatch(io, { plan: tampered, features, ensureClientClosed: () => {} }),
    (error) => error.code === 'PLAN_MISMATCH',
  );
  assert.equal(fs.existsSync(options.backupDir), false, 'a refused plan must not create backups');
  assert.deepEqual(fs.readFileSync(options.asarPath), before);

  const result = await composer.applyHostPatch(io, {
    plan,
    features,
    ensureClientClosed: () => {},
  });
  assert.equal(result.receipt.originalHash, plan.originalHash);
  assert.throws(
    () => composer.validateHostReceipt({ ...result.receipt, schemaVersion: 2 }),
    (error) => error.code === 'RECEIPT_INVALID' && /schemaVersion/.test(error.message),
  );
  const status = getCapsuleStatus(io);
  assert.equal(status.features.capsule, true);
  assert.equal(status.features.localization, true);
  assert.match(
    engine.extractFile(options.asarPath, 'dist/main.js').toString('utf8'),
    /win\.loadURL\(url \+ "\?fixture"\)/,
  );
  const installedBytes = fs.readFileSync(options.asarPath);
  const replanned = composer.planHostPatch(io, { features });
  assert.equal(composer.inspectReviewedHostPlan(io, replanned, features).readiness, 'current');
  await composer.applyHostPatch(io, { plan: replanned, features, ensureClientClosed: () => {} });
  assert.deepEqual(fs.readFileSync(options.asarPath), installedBytes);
  assert.equal(composer.inspectReviewedHostPlan(io, replanned, features).readiness, 'current');
});

test('evidence-only input revisions retain immutable receipts and the exact original', async (t) => {
  if (requireLocalizationBuild(t)) return;
  const root = temporary(t);
  const options = fixture(root, 'evidence-revision');
  const io = baseOptions(options);
  const original = fs.readFileSync(options.asarPath);
  const localization = localizationInputs(root);
  localization.observedSource = {
    sourceKind: 'ls-binary',
    lsSha256: 'a'.repeat(64),
    sourceIdentity: 'b'.repeat(64),
    nlsHelperCalleeName: 'Fu',
    matchedProfileId: localization.profileId,
    warnings: [],
  };
  const features = { localization };
  const firstPlan = composer.planHostPatch(io, { features });
  const first = await composer.applyHostPatch(io, {
    plan: firstPlan,
    features,
    ensureClientClosed: () => {},
  });
  const firstStatus = composer.getHostStatus(io);
  const firstReceipt = fs.readFileSync(firstStatus.recordPath);
  const firstInputsPath = path.join(
    options.backupDir,
    'host',
    firstStatus.installationId,
    'inputs',
    `${first.receipt.inputsHash}.json`,
  );
  const firstInputs = fs.readFileSync(firstInputsPath);
  const main = engine.extractFile(options.asarPath, 'dist/main.js');
  const runtime = engine.extractFile(options.asarPath, 'dist/agyctl-localization/host-engine.js');
  const revised = {
    localization: {
      ...localization,
      observedSource: {
        ...localization.observedSource,
        lsSha256: 'c'.repeat(64),
        sourceIdentity: 'd'.repeat(64),
      },
    },
  };
  const secondPlan = composer.planHostPatch(io, { features: revised });
  assert.notEqual(secondPlan.planId, firstPlan.planId);
  const second = await composer.applyHostPatch(io, {
    plan: secondPlan,
    features: revised,
    ensureClientClosed: () => {},
  });
  const secondStatus = composer.getHostStatus(io);
  const secondReceipt = fs.readFileSync(secondStatus.recordPath);
  assert.notEqual(second.receipt.inputsHash, first.receipt.inputsHash);
  assert.notEqual(secondStatus.recordPath, firstStatus.recordPath);
  assert.deepEqual(
    secondStatus.receipt.features.localization.observedSource,
    revised.localization.observedSource,
  );
  assert.equal(composer.inspectReviewedHostPlan(io, secondPlan, revised).readiness, 'current');
  assert.throws(
    () => composer.inspectReviewedHostPlan(io, firstPlan, features),
    (error) => error.code === 'SOURCE_MISMATCH' && /changed since/.test(error.message),
  );
  assert.deepEqual(engine.extractFile(options.asarPath, 'dist/main.js'), main);
  assert.deepEqual(
    engine.extractFile(options.asarPath, 'dist/agyctl-localization/host-engine.js'),
    runtime,
  );
  assert.deepEqual(fs.readFileSync(firstStatus.recordPath), firstReceipt);
  assert.deepEqual(fs.readFileSync(firstInputsPath), firstInputs);
  assert.equal(second.backupPath, first.backupPath);
  assert.deepEqual(fs.readFileSync(first.backupPath), original);
  const secondInputsPath = path.join(
    options.backupDir,
    'host',
    secondStatus.installationId,
    'inputs',
    `${second.receipt.inputsHash}.json`,
  );
  assert.equal(
    require2('node:crypto')
      .createHash('sha256')
      .update(fs.readFileSync(secondInputsPath))
      .digest('hex'),
    second.receipt.inputsHash,
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(secondInputsPath, 'utf8')).localization.observedSource,
    revised.localization.observedSource,
  );
  await composer.removeFeatures(io, { remove: ['localization'], ensureClientClosed: () => {} });
  assert.deepEqual(fs.readFileSync(options.asarPath), original);
  assert.equal(composer.getHostStatus(io).archiveKind, 'pristine');
  assert.deepEqual(fs.readFileSync(firstStatus.recordPath), firstReceipt);
  assert.deepEqual(fs.readFileSync(secondStatus.recordPath), secondReceipt);
});
