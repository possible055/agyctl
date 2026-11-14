import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { planSidecarCleanup } from '../../scripts/lib/client-processes.mjs';
import { validateFeatureApply } from '../../scripts/lib/feature-control.mjs';
import { normalizeModelCatalog, readModelEnum } from '../../scripts/lib/model-catalog.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const { builtinAsar: asar } = require('../../scripts/vendor/asar-engine.cjs');
const selection = () => ({
  revision: 'a'.repeat(64),
  capsule: false,
  localization: { enabled: false, locale: 'en' },
  limit: {
    enabled: true,
    modelLimits: [
      { id: 102, limit: 750000 },
      { id: 101, limit: 400000 },
    ],
  },
});

test('orphan cleanup verifies the selected installation, role, creation times, and launcher', {
  skip: process.platform !== 'win32' && 'Windows x86-64 sidecar launch layouts',
}, () => {
  const target = {
    executablePath: 'C:\\Apps\\Antigravity\\Antigravity.exe',
    binaryPath: 'C:\\Apps\\Antigravity\\resources\\bin\\language_server.exe',
  };
  const directory = path.join(os.homedir(), '.gemini/config/plugins/agyctl/sidecars/panel');
  const loader = pathToFileURL(
    path.join(os.homedir(), '.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js'),
  ).href;
  const shell = path.join(process.env.SystemRoot, 'System32/cmd.exe');
  const wrapper = path.join(process.env.APPDATA, 'Antigravity/bin/agy-node.cmd');
  const record = {
    pid: 102,
    parentPid: 101,
    path: target.executablePath,
    created: '134389370618278392',
    kind: 'sidecar',
    directory,
    command: `"${target.executablePath}" --import=${loader} main.mjs`,
    parent: {
      pid: 101,
      parentPid: 100,
      path: shell,
      created: '134389370617455684',
      directory,
      command: `${shell} /c ""${wrapper}" --import=${loader} main.mjs"`,
    },
    owner: null,
  };
  assert.deepEqual(planSidecarCleanup(target, [record]), [
    { plugin: 'agyctl', sidecar: 'panel', directory, pid: 102 },
  ]);
  assert.deepEqual(planSidecarCleanup(target, []), []);
  for (const [changed, code] of [
    [{ ...record, kind: 'client' }, 'CLIENT_RUNNING'],
    [{ ...record, kind: 'server', path: target.binaryPath }, 'CLIENT_RUNNING'],
    [{ ...record, path: 'D:\\Other\\Antigravity.exe' }, 'PROCESS_UNKNOWN'],
    [{ ...record, directory: path.join(os.homedir(), 'unknown') }, 'PROCESS_UNKNOWN'],
    [{ ...record, command: `${record.command} --eval=untrusted` }, 'PROCESS_UNKNOWN'],
    [{ ...record, parent: { ...record.parent, created: record.created } }, 'PROCESS_UNKNOWN'],
    [{ ...record, parent: { ...record.parent, directory: 'C:\\Other' } }, 'PROCESS_UNKNOWN'],
    [
      {
        ...record,
        owner: { pid: 100, parentPid: 99, path: target.binaryPath, created: '134389370610000000' },
      },
      'PROCESS_UNKNOWN',
    ],
    [{ ...record, created: 'invalid' }, 'PROCESS_UNKNOWN'],
  ])
    assert.throws(() => planSidecarCleanup(target, [changed]), { code });
  assert.throws(() => planSidecarCleanup(target, [record, record]), { code: 'PROCESS_UNKNOWN' });
});

test('model catalogs join exact installed enum names without guessing IDs or requiring access', () => {
  const modelEnum = readModelEnum(
    'D.Model={UNSPECIFIED:0,PLACEHOLDER_M0:1E3,PLACEHOLDER_M318:1318,PLACEHOLDER_M400:1400};',
  );
  const catalog = normalizeModelCatalog(
    {
      response: {
        models: {
          flash: { displayName: 'Gemini 3.8 Flash (High)', model: 'MODEL_PLACEHOLDER_M318' },
          opus: {
            displayName: 'Claude Opus 5.5 (Low)',
            model: 'MODEL_PLACEHOLDER_M400',
            disabled: true,
          },
          duplicateName: { displayName: 'Gemini 3.8 Flash (High)', model: 'MODEL_PLACEHOLDER_M0' },
          unknown: { displayName: 'New model', model: 'MODEL_PLACEHOLDER_M999' },
          internal: { model: 'MODEL_PLACEHOLDER_M0' },
        },
      },
    },
    modelEnum,
  );
  assert.deepEqual(catalog, {
    status: 'available',
    error: null,
    models: [
      {
        alias: 'flash',
        name: 'Gemini 3.8 Flash (High)',
        baseName: 'Gemini 3.8 Flash',
        effort: 'high',
        id: 1318,
        available: true,
      },
      {
        alias: 'opus',
        name: 'Claude Opus 5.5 (Low)',
        baseName: 'Claude Opus 5.5',
        effort: 'low',
        id: 1400,
        available: false,
      },
      {
        alias: 'duplicateName',
        name: 'Gemini 3.8 Flash (High)',
        baseName: 'Gemini 3.8 Flash',
        effort: 'high',
        id: 1000,
        available: true,
      },
      {
        alias: 'unknown',
        name: 'New model',
        baseName: 'New model',
        effort: null,
        id: null,
        available: true,
      },
    ],
  });
  assert.throws(
    () => readModelEnum('D.Model={UNSPECIFIED:0,PLACEHOLDER_M318:1000+318};'),
    /cannot be identified/,
  );
  assert.throws(
    () => readModelEnum('D.Model={UNSPECIFIED:0};E.Model={UNSPECIFIED:0};'),
    /cannot be identified/,
  );
  assert.throws(() => normalizeModelCatalog({}, modelEnum), /Invalid available-model response/);
});

test('feature selections reject command/path injection and ambiguous model mappings', () => {
  const desired = selection();
  assert.deepEqual(validateFeatureApply(desired).limit.modelLimits, [
    { id: 101, limit: 400000 },
    { id: 102, limit: 750000 },
  ]);
  for (const limit of [256000, 896000]) {
    assert.deepEqual(
      validateFeatureApply({
        ...desired,
        limit: { enabled: true, modelLimits: [{ id: 101, limit }] },
      }).limit.modelLimits,
      [{ id: 101, limit }],
    );
  }
  for (const payload of [
    { ...desired, asarPath: 'outside/app.asar' },
    { ...desired, capsule: 'true' },
    { ...desired, localization: { enabled: true, locale: '../outside' } },
    { ...desired, limit: { enabled: true, modelLimits: [] } },
    {
      ...desired,
      limit: {
        enabled: true,
        modelLimits: [
          { id: 101, limit: 1 },
          { id: 101, limit: 2 },
        ],
      },
    },
    { ...desired, limit: { enabled: true, modelLimits: [{ id: '101', limit: 1 }] } },
    { ...desired, limit: { enabled: true, modelLimits: [{ id: 101, limit: 2147483648 }] } },
    { ...desired, limit: { enabled: true, modelLimits: [{ id: 101, limit: 255999 }] } },
    { ...desired, limit: { enabled: true, modelLimits: [{ id: 101, limit: 896001 }] } },
    {
      ...desired,
      limit: { enabled: true, modelLimits: [{ id: 101, limit: 1, command: 'ignored' }] },
    },
  ])
    assert.throws(() => validateFeatureApply(payload), { code: 'INVALID_SELECTION' });
  assert.deepEqual(
    validateFeatureApply({ ...desired, limit: { enabled: false, modelLimits: [] } }).limit,
    { enabled: false, modelLimits: [] },
  );
});

test('production patch actions refuse a host without a UI token', async () => {
  const source = fs
    .readFileSync(path.join(root, 'src/plugin/sidecars/panel/main.mjs'), 'utf8')
    .replace(/^import .* from .*;\r?\n/gm, '')
    .replace("await import('sidecar_sdk')", 'fixtureSdk');
  for (const token of [undefined, 'fixture-token']) {
    const handlers = new Map();
    let writes = 0;
    class SidecarApp {
      api(route, handler) {
        handlers.set(route, handler);
      }
      page() {}
      run() {}
    }
    await vm.runInNewContext(`(async () => { ${source} })()`, {
      fixtureSdk: { SidecarApp, Response: class {} },
      process: { env: token ? { ANTIGRAVITY_SIDECAR_UI_TOKEN: token } : {} },
      queueFeatureApply: () => {
        writes++;
        return {
          draft: { id: '00000000-0000-4000-8000-000000000001' },
          operation: null,
        };
      },
      cancelFeatureApply: () => {
        writes++;
        return { operation: { state: 'cancelled' } };
      },
    });
    for (const route of ['/api/features/apply', '/api/features/cancel']) {
      const result = await handlers.get(route)({});
      if (token)
        assert.equal(
          route.endsWith('apply') ? result.draft.id : result.operation.state,
          route.endsWith('apply') ? '00000000-0000-4000-8000-000000000001' : 'cancelled',
        );
      else assert.equal(result.code, 'FEATURE_UNAVAILABLE');
    }
    assert.equal(writes, token ? 2 : 0);
  }
});

test('feature drafts bind revisions, refuse a running client, and apply/restore actual model limits', async (t) => {
  const native = process.platform === 'win32' ? 'windows-amd64/agyctl.exe' : 'linux-amd64/agyctl';
  if (
    !['win32', 'linux'].includes(process.platform) ||
    process.arch !== 'x64' ||
    !fs.existsSync(path.join(root, 'dist/bin', native))
  ) {
    t.skip('A built native CLI and a recorded x86-64 installation fixture are required');
    return;
  }
  if (!fs.existsSync(path.join(root, 'dist/host/bundle/build-manifest.json'))) {
    t.skip('The Host build is required for reading the installation receipt');
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-feature-control-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const appDir = path.join(directory, 'client');
  const source = path.join(directory, 'source');
  const state = path.join(directory, 'state');
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'antigravity', productName: 'Antigravity', version: 'fixture-2.31' }),
  );
  fs.writeFileSync(path.join(source, 'dist/preload.js'), 'export {};');
  const binary = path.join(
    appDir,
    'resources/bin',
    process.platform === 'win32' ? 'language_server.exe' : 'language_server',
  );
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const original = fs.readFileSync(
    path.join(
      root,
      'src/agyctl/testdata/limit',
      process.platform === 'win32' ? 'original.bin' : 'original-elf.bin',
    ),
  );
  fs.writeFileSync(binary, original);
  const executable = path.join(
    appDir,
    process.platform === 'win32' ? 'Antigravity.exe' : 'antigravity',
  );
  fs.writeFileSync(executable, original);
  const asarPath = path.join(appDir, 'resources/app.asar');
  await asar.createPackageWithOptions(source, asarPath, {});
  const archive = fs.readFileSync(asarPath);
  const probe = path.join(directory, 'probe.mjs');
  fs.writeFileSync(
    probe,
    `import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const real = childProcess.execFileSync;
    childProcess.execFileSync = (command, args, options) => command === 'tasklist'
      ? '"Antigravity.exe","123","Console","1","1 K"'
      : command === 'ps' ? (args[0] === '-p' ? ${JSON.stringify(executable)} : '123 antigravity') : real(command, args, options);
    syncBuiltinESMExports();`,
  );
  const env = {
    ...process.env,
    AGYCTL_APP_DIR: appDir,
    AGYCTL_HOME: state,
    NODE_OPTIONS: `--import=${pathToFileURL(probe).href}`,
  };
  let completedWorkerPid;
  const run = async (action, payload, executable = process.execPath) => {
    const childEnv = { ...env };
    if (executable !== process.execPath) {
      childEnv.ELECTRON_RUN_AS_NODE = '1';
      delete childEnv.ELECTRON_NO_ASAR;
    }
    const child = execFile(
      executable,
      [path.join(root, 'scripts/feature-control-worker.mjs'), action],
      { cwd: root, env: childEnv, windowsHide: true, timeout: 20000 },
      () => {},
    );
    const completion = new Promise((resolve) => child.once('close', resolve));
    let output = '';
    let diagnostics = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      diagnostics += chunk;
    });
    child.stdin.end(payload === undefined ? '' : JSON.stringify(payload));
    await completion;
    completedWorkerPid = child.pid;
    assert.ok(output.trim(), diagnostics);
    return JSON.parse(output);
  };
  const first = await run('status');
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.equal(first.installation.version, 'fixture-2.31');
  assert.deepEqual(first.features.limit, { enabled: false, modelLimits: [], savedModelLimits: [] });
  assert.deepEqual(first.features.localization, { enabled: false, locale: null, format: null });
  assert.equal(first.operation, null);
  assert.equal(first.draft, null);
  const electronPackage = path.join(root, 'node_modules/electron');
  const electronPath = path.join(electronPackage, 'path.txt');
  const electron = fs.existsSync(electronPath)
    ? path.join(electronPackage, 'dist', fs.readFileSync(electronPath, 'utf8').trim())
    : null;
  let electronRuntime;
  await t.test(
    'the Electron sidecar runtime reads the same physical installation',
    {
      skip: (!electron || !fs.existsSync(electron)) && 'Electron executable is unavailable',
    },
    async (t) => {
      const probe = spawnSync(electron, ['-e', ''], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 10000,
      });
      if (probe.error || probe.status !== 0) {
        t.skip(`Electron cannot run: ${probe.error?.message ?? probe.stderr.trim()}`);
        return;
      }
      electronRuntime = electron;
      const electronStatus = await run('status', undefined, electron);
      assert.equal(electronStatus.error, undefined, JSON.stringify(electronStatus));
      assert.equal(electronStatus.revision, first.revision);
      assert.deepEqual(electronStatus.features, first.features);
    },
  );
  const desired = {
    ...selection(),
    revision: first.revision,
    capsule: true,
    limit: { enabled: false, modelLimits: [] },
  };
  const stale = await run('queue', { ...desired, revision: '0'.repeat(64) });
  assert.equal(stale.code, 'REVISION_CHANGED');
  assert.equal(fs.existsSync(path.join(state, 'management/features')), false);
  const queued = await run('queue', desired);
  assert.equal(queued.operation, null);
  assert.equal(typeof queued.draft.id, 'string');
  assert.match(queued.draft.commands.apply, /settings:apply -- --draft /);
  const operations = path.join(state, 'management/features');
  const staleOperationPath = path.join(operations, fs.readdirSync(operations)[0], 'state.json');
  const staleOperation = JSON.stringify({
    schema: 1,
    id: '00000000-0000-4000-8000-000000000001',
    state: 'preparing',
    updatedAt: '2020-01-01T00:00:00.000Z',
    pid: completedWorkerPid,
  });
  fs.writeFileSync(staleOperationPath, staleOperation);
  const waiting = await run('status');
  assert.equal(waiting.draft.id, queued.draft.id);
  assert.equal(waiting.revision, first.revision);
  assert.equal(waiting.operation.state, 'failed');
  assert.equal(waiting.operation.code, 'WORKER_STOPPED');
  assert.equal(fs.readFileSync(staleOperationPath, 'utf8'), staleOperation);
  assert.deepEqual(fs.readFileSync(binary), original);
  assert.deepEqual(fs.readFileSync(asarPath), archive);
  assert.equal(fs.existsSync(path.join(state, 'backups')), false);
  const writeProbe = (output) =>
    fs.writeFileSync(
      probe,
      `import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.execFileSync = () => ${JSON.stringify(output)};
    syncBuiltinESMExports();`,
    );
  const limits = { enabled: true, modelLimits: [{ id: 101, limit: 400000 }] };
  const runningDraft = await run('queue', { ...desired, capsule: false, limit: limits });
  const running = await run('apply-draft', { id: runningDraft.draft.id });
  assert.equal(running.code, 'CLIENT_RUNNING');
  assert.deepEqual(fs.readFileSync(binary), original);
  writeProbe('invalid process output');
  const unknownDraft = await run('queue', { ...desired, capsule: false, limit: limits });
  const unknown = await run('apply-draft', { id: unknownDraft.draft.id });
  assert.equal(unknown.code, 'PROCESS_UNKNOWN');
  assert.deepEqual(fs.readFileSync(binary), original);
  writeProbe(
    process.platform === 'win32' ? '"unrelated.exe","123","Console","1","1 K"' : '123 unrelated',
  );
  const appliedDraft = await run('queue', { ...desired, capsule: false, limit: limits });
  const applied = await run('apply-draft', { id: appliedDraft.draft.id }, electronRuntime);
  assert.equal(applied.error, undefined, JSON.stringify(applied));
  assert.equal(applied.operation.state, 'succeeded');
  const operationDir = path.join(operations, fs.readdirSync(operations)[0]);
  const actual = await run('status');
  assert.equal(actual.features.limit.enabled, true);
  assert.deepEqual(actual.features.limit.modelLimits, limits.modelLimits);
  const modifiedLimits = { enabled: true, modelLimits: [{ id: 101, limit: 600000 }] };
  const changedDraft = await run('queue', {
    ...desired,
    revision: actual.revision,
    capsule: false,
    limit: modifiedLimits,
  });
  const changed = await run('apply-draft', { id: changedDraft.draft.id });
  assert.equal(
    changed.operation.state,
    'succeeded',
    fs.readFileSync(path.join(operationDir, `${changed.operation.id}.log`), 'utf8'),
  );
  const modified = await run('status');
  assert.deepEqual(modified.features.limit.modelLimits, modifiedLimits.modelLimits);
  const restoredDraft = await run('queue', {
    ...desired,
    revision: modified.revision,
    capsule: false,
  });
  const restored = await run('apply-draft', { id: restoredDraft.draft.id });
  assert.equal(
    restored.operation.state,
    'succeeded',
    fs.readFileSync(path.join(operationDir, `${restored.operation.id}.log`), 'utf8'),
  );
  const restoredState = await run('status');
  assert.deepEqual(restoredState.features.limit, {
    enabled: false,
    modelLimits: [],
    savedModelLimits: modifiedLimits.modelLimits,
  });
  fs.appendFileSync(executable, 'changed');
  const drifted = await run('queue', desired);
  assert.equal(drifted.code, 'REVISION_CHANGED');
  assert.deepEqual(fs.readFileSync(binary), original);
  assert.deepEqual(fs.readFileSync(asarPath), archive);
});
