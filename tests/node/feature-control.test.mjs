import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { planSidecarCleanup } from '../../scripts/lib/client-processes.mjs';
import { validateFeatureApply, withLock } from '../../scripts/lib/feature-control.mjs';
import { normalizeModelCatalog, readModelEnum } from '../../scripts/lib/model-catalog.mjs';
import {
  assertNativeExpectation,
  localizationContentIdentity,
  nativeExpectation,
} from '../../scripts/lib/native-binding.mjs';

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
  compaction: false,
});

test('native revisions bind mutations while localization content survives verified binary-only changes', () => {
  const status = {
    verified: true,
    base_sha256: 'a'.repeat(64),
    current_sha256: 'b'.repeat(64),
    generation: 2,
    assets_fingerprint: 'c'.repeat(64),
  };
  const expected = nativeExpectation(status);
  assert.deepEqual(expected, {
    base_sha256: status.base_sha256,
    current_sha256: status.current_sha256,
    generation: 2,
    assets_fingerprint: status.assets_fingerprint,
  });
  assert.equal(nativeExpectation({ verified: false }), null);
  assert.doesNotThrow(() => assertNativeExpectation(status, expected));
  for (const changed of [
    { ...status, verified: false },
    { ...status, current_sha256: 'd'.repeat(64) },
    { ...status, base_sha256: 'd'.repeat(64) },
    { ...status, assets_fingerprint: 'd'.repeat(64) },
    { ...status, generation: 3 },
  ])
    assert.throws(() => assertNativeExpectation(changed, expected), /changed since review/);
  assert.throws(() => nativeExpectation({ ...status, generation: -1 }), /Invalid native/);
  const source = {
    lsSha256: status.base_sha256,
    nlsHelperCalleeName: 'Fu',
    archive: { entryCount: 1, totalUncompressedBytes: 5 },
    assets: { 'main.js': { sha256: 'e'.repeat(64), bytes: Buffer.from('hello') } },
  };
  const identity = localizationContentIdentity(source);
  assert.equal(
    localizationContentIdentity({ ...source, lsSha256: status.current_sha256 }),
    identity,
  );
  assert.notEqual(
    localizationContentIdentity({ ...source, nlsHelperCalleeName: 'Other' }),
    identity,
  );
  assert.notEqual(
    localizationContentIdentity({
      ...source,
      assets: { 'main.js': { sha256: 'f'.repeat(64), bytes: Buffer.from('hello') } },
    }),
    identity,
  );
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

test('model catalogs follow the agent selector and join exact enum names without requiring access', () => {
  const modelEnum = readModelEnum(
    'D.Model={UNSPECIFIED:0,PLACEHOLDER_M0:1E3,PLACEHOLDER_M318:1318,PLACEHOLDER_M400:1400};',
  );
  const catalog = normalizeModelCatalog(
    {
      response: {
        agentModelSorts: [
          {
            groups: [
              {
                modelIds: [
                  'flash',
                  'opus',
                  'flash-extra-high',
                  'unknown',
                  'internal',
                  'missing',
                  'flash',
                ],
              },
            ],
          },
        ],
        models: {
          obsolete: { displayName: 'Gemini 3.8 Flash (High)', model: 'MODEL_PLACEHOLDER_M0' },
          flash: { displayName: 'Gemini 3.8 Flash (High)', model: 'MODEL_PLACEHOLDER_M318' },
          opus: {
            displayName: 'Claude Opus 5.5 (Low)',
            model: 'MODEL_PLACEHOLDER_M400',
            disabled: true,
          },
          'flash-extra-high': {
            displayName: 'Gemini 3.8 Flash (Extra High)',
            model: 'MODEL_PLACEHOLDER_M0',
          },
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
        alias: 'flash-extra-high',
        name: 'Gemini 3.8 Flash (Extra High)',
        baseName: 'Gemini 3.8 Flash',
        effort: 'xhigh',
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
  for (const agentModelSorts of [undefined, [], [{ groups: [{ modelIds: 'flash' }] }]]) {
    assert.throws(
      () => normalizeModelCatalog({ response: { models: {}, agentModelSorts } }, modelEnum),
      /Invalid available-model sort/,
    );
  }
});

test('feature selections reject command/path injection and ambiguous model mappings', () => {
  const desired = selection();
  assert.deepEqual(validateFeatureApply(desired).limit.modelLimits, [
    { id: 101, limit: 400000 },
    { id: 102, limit: 750000 },
  ]);
  for (const limit of [256000, 983040]) {
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
    { ...desired, compaction: 'true' },
    { ...desired, compaction: undefined },
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
    { ...desired, limit: { enabled: true, modelLimits: [{ id: 101, limit: 983041 }] } },
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
  assert.equal(validateFeatureApply(desired).compaction, false);
  assert.equal(validateFeatureApply({ ...desired, compaction: true }).compaction, true);
  assert.equal(validateFeatureApply({ ...desired, compaction: null }).compaction, null);
  assert.equal(validateFeatureApply({ ...desired, compaction: true }).compactionPrompt, null);
  const { compaction: _compaction, ...preserved } = desired;
  assert.equal(validateFeatureApply(preserved).compaction, null);
  assert.equal(validateFeatureApply(preserved).compactionPrompt, null);
  const custom = { mode: 'custom', text: `${'界'.repeat(1312)}x` };
  assert.deepEqual(
    validateFeatureApply({ ...desired, compaction: true, compactionPrompt: custom })
      .compactionPrompt,
    custom,
  );
  for (const prompt of [
    { mode: 'native', text: 'ignored' },
    { mode: 'custom', text: ' \n\t' },
    { mode: 'custom', text: '\u0085' },
    { mode: 'custom', text: `${custom.text}x` },
    { mode: 'custom', text: '\ud800' },
    { mode: 'custom', text: 'before\0after' },
    { mode: 'file', text: 'outside.txt' },
  ])
    assert.throws(
      () => validateFeatureApply({ ...desired, compaction: true, compactionPrompt: prompt }),
      { code: 'INVALID_COMPACTION_PROMPT' },
    );
  assert.throws(() => validateFeatureApply({ ...desired, compactionPrompt: custom }), {
    code: 'INVALID_SELECTION',
  });
  const existing = [{ id: 1400, limit: 1048576 }];
  const retained = { ...desired, limit: { enabled: true, modelLimits: existing } };
  assert.deepEqual(validateFeatureApply(retained, existing).limit.modelLimits, existing);
  for (const modelLimits of [[{ id: 1400, limit: 1048577 }], [{ id: 1401, limit: 1048576 }]])
    assert.throws(
      () => validateFeatureApply({ ...desired, limit: { enabled: true, modelLimits } }, existing),
      { code: 'INVALID_SELECTION' },
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

test('summary prompt drafts preserve options through native review and verify the applied prompt', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-prompt-draft-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = {
    asarPath: path.join(directory, 'app.asar'),
    binaryPath: path.join(directory, 'server'),
    executablePath: path.join(directory, 'app'),
    version: 'fixture',
  };
  const native = {
    verified: true,
    base_sha256: 'a'.repeat(64),
    current_sha256: 'b'.repeat(64),
    assets_fingerprint: 'c'.repeat(64),
    generation: 1,
    file_state: 'managed-output',
    features: { compaction: true, compaction_prompt: { mode: 'native', text: '' } },
    compaction_prompt_max_bytes: 3937,
    compaction_retention_budget_bytes: 61440,
  };
  const rawLimit = { binary_sha256: native.current_sha256, language_server_running: false };
  const rawCompaction = { binary_sha256: native.current_sha256, file_state: 'managed-output' };
  const commands = [];
  const adapter = {
    defaultStateRoot: () => directory,
    hostPatchStatus: () => ({
      currentHash: 'host',
      unpackedHash: 'unpacked',
      receipt: null,
      features: { capsule: false, localization: false },
    }),
    clientProcessState: () => ({ state: 'closed' }),
    ensureClientClosedFor() {},
  };
  const source = fs
    .readFileSync(path.join(root, 'scripts/lib/feature-control.mjs'), 'utf8')
    .replace(/^import .* from .*;\r?\n/gm, '')
    .replace(/\bexport /g, '')
    .replaceAll("await import('./host-patch.mjs')", 'featureAdapter');
  const api = vm.runInNewContext(
    `(() => { ${source}; return { readFeatures, queueFeatureApply, preflightFeatureDraft, applyFeatureDraft }; })()`,
    {
      fs,
      path,
      createHash,
      randomUUID,
      Buffer,
      process,
      featureAdapter: adapter,
      repoRoot: root,
      agyctlHome: () => directory,
      inspectHostTarget: () => target,
      findAsarPath: () => target.asarPath,
      sha256FileCached: () => 'executable',
      nativeExpectation,
      assertNativeExpectation,
      readModelCatalog: async () => ({ status: 'available', models: [] }),
      normalizeNativeLimitStatus: () => ({
        binarySha256: native.current_sha256,
        patchKind: 'original',
        modelLimits: [],
        savedModelLimits: [],
        settingsState: 'absent',
      }),
      runAgyctlAsync: async ([feature]) =>
        feature === 'native' ? native : feature === 'limit' ? rawLimit : rawCompaction,
      runAgyctl: (args) => {
        if (args[0] === 'limit') return rawLimit;
        commands.push(args);
        return { expected: nativeExpectation(native) };
      },
    },
  );
  const first = await api.readFeatures();
  const desired = {
    ...selection(),
    revision: first.revision,
    compaction: true,
    compactionPrompt: {
      mode: 'custom',
      text: 'Keep the newest user requests.\n"$(not a shell command)"',
    },
    limit: { enabled: false, modelLimits: [] },
  };
  const queued = await api.queueFeatureApply(desired);
  const saved = JSON.parse(
    fs.readFileSync(path.join(directory, 'management/drafts', `${queued.draft.id}.json`), 'utf8'),
  );
  assert.deepEqual(saved.desired.compactionPrompt, desired.compactionPrompt);
  await api.preflightFeatureDraft(queued.draft.id);
  assert.deepEqual(JSON.parse(commands.at(-1)[commands.at(-1).indexOf('--desired') + 1]), {
    compaction: true,
    compaction_prompt: desired.compactionPrompt,
  });
  native.features.compaction_prompt = { ...desired.compactionPrompt };
  const updated = await api.readFeatures();
  assert.notEqual(updated.revision, first.revision);
  await assert.rejects(api.preflightFeatureDraft(queued.draft.id), { code: 'REVISION_CHANGED' });
  commands.length = 0;
  const unchanged = await api.queueFeatureApply({ ...desired, revision: updated.revision });
  await api.preflightFeatureDraft(unchanged.draft.id);
  assert.deepEqual(commands, []);
  const disabled = await api.queueFeatureApply({
    ...desired,
    revision: updated.revision,
    compaction: false,
    compactionPrompt: null,
  });
  await api.preflightFeatureDraft(disabled.draft.id);
  assert.deepEqual(JSON.parse(commands.at(-1)[commands.at(-1).indexOf('--desired') + 1]), {
    compaction: false,
  });
  const nativeDraft = await api.queueFeatureApply({
    ...desired,
    revision: updated.revision,
    compactionPrompt: { mode: 'native', text: '' },
  });
  await assert.rejects(api.applyFeatureDraft(nativeDraft.draft.id), { code: 'VERIFY_FAILED' });
  assert.deepEqual(JSON.parse(commands.at(-1)[commands.at(-1).indexOf('--desired') + 1]), {
    compaction: true,
    compaction_prompt: { mode: 'native', text: '' },
  });
  native.verified = false;
  delete native.compaction_prompt_max_bytes;
  delete native.compaction_retention_budget_bytes;
  commands.length = 0;
  const legacy = await api.readFeatures();
  assert.equal(legacy.features.compaction.enabled, true);
  assert.equal(legacy.features.compaction.prompt, null);
  for (const option of [{ compactionPrompt: null }, {}]) {
    const preserved = await api.queueFeatureApply({
      ...selection(),
      revision: legacy.revision,
      limit: { enabled: false, modelLimits: [] },
      compaction: true,
      ...option,
    });
    await api.preflightFeatureDraft(preserved.draft.id);
    assert.deepEqual(commands, []);
  }
  rawCompaction.file_state = 'registered-input';
  const original = await api.readFeatures();
  const enabling = await api.queueFeatureApply({
    ...selection(),
    revision: original.revision,
    limit: { enabled: false, modelLimits: [] },
    compaction: true,
    compactionPrompt: null,
  });
  await api.preflightFeatureDraft(enabling.draft.id);
  assert.deepEqual(
    commands.map((args) => Array.from(args)),
    [['compaction', 'patch', '--binary', target.binaryPath]],
  );
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
  assert.deepEqual(first.features.compaction, {
    enabled: null,
    fileState: 'unknown',
    pending: false,
    prompt: null,
    promptMaxBytes: null,
    retentionBudgetBytes: null,
  });
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
    compaction: null,
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
  const savedDraft = JSON.parse(
    fs.readFileSync(path.join(state, 'management/drafts', `${queued.draft.id}.json`), 'utf8'),
  );
  assert.equal(savedDraft.desired.compaction, null);
  assert.equal(savedDraft.desired.compactionPrompt, null);
  const unsupportedCustom = await run('queue', {
    ...desired,
    compaction: true,
    compactionPrompt: { mode: 'custom', text: 'Keep the recent requests.' },
  });
  assert.equal(unsupportedCustom.code, 'COMPACTION_UNAVAILABLE');
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
  await t.test(
    'unsupported compaction keeps its refusal kind without modifying the installation',
    async () => {
      const preview = spawnSync(
        path.join(root, 'dist/bin', native),
        ['--root', root, 'compaction', 'patch', '--binary', binary, '--json'],
        { env, windowsHide: true, encoding: 'utf8', timeout: 20000 },
      );
      assert.equal(preview.status, 1, preview.stderr || preview.stdout);
      assert.equal(JSON.parse(preview.stdout).refusal?.kind, 'unsupported-version');
      for (const compaction of [true, false]) {
        const draft = await run('queue', { ...desired, capsule: false, compaction });
        assert.equal(draft.error, undefined, JSON.stringify(draft));
        const preflight = await run('preflight', { id: draft.draft.id });
        assert.equal(preflight.code, 'COMPACTION_UNAVAILABLE', JSON.stringify(preflight));
      }
      assert.deepEqual(fs.readFileSync(binary), original);
      assert.deepEqual(fs.readFileSync(asarPath), archive);
      assert.equal(fs.existsSync(path.join(state, 'backups')), false);
    },
  );
  await t.test('oversize native status rejects without crashing its caller', () => {
    const resolved = fs.realpathSync(binary);
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const identity = createHash('sha256').update(key).digest('hex').slice(0, 16);
    const backups = path.join(state, 'backups');
    const preparePath = path.join(backups, `compaction-prepare-${identity}.json`);
    fs.mkdirSync(backups, { recursive: true });
    fs.writeFileSync(
      preparePath,
      JSON.stringify({
        schema: 1,
        status: 'prepared',
        target: key,
        binary_sha256_before: 'a'.repeat(64),
        binary_sha256_after: 'b'.repeat(64),
        backups: [{ kind: 'repo', path: 'x'.repeat(9 * 1024 * 1024), sha256: 'a'.repeat(64) }],
      }),
    );
    try {
      const caller = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { runAgyctlAsync } from ${JSON.stringify(pathToFileURL(path.join(root, 'scripts/lib/agyctl.mjs')).href)};
        try {
          await runAgyctlAsync(['compaction', 'status', '--binary', ${JSON.stringify(binary)}]);
          console.log(JSON.stringify({ resolved: true }));
        } catch (error) {
          console.log(JSON.stringify({ code: error.code, message: error.message }));
        }
      `,
        ],
        { env, encoding: 'utf8', windowsHide: true, timeout: 20000 },
      );
      assert.equal(caller.status, 0, caller.stderr || caller.stdout);
      const error = JSON.parse(caller.stdout);
      assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      assert.match(error.message, /stdout.*limit/);
      assert.deepEqual(fs.readFileSync(binary), original);
    } finally {
      fs.rmSync(preparePath);
    }
  });
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
  const legacyPatch = spawnSync(
    path.join(root, 'dist/bin', native),
    [
      '--root',
      root,
      'limit',
      'patch',
      '--json',
      '--binary',
      binary,
      '--model-limits',
      '1400=983040',
      '--apply',
    ],
    { env, windowsHide: true, encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(legacyPatch.status, 0, legacyPatch.stderr || legacyPatch.stdout);
  const legacy = await run('status');
  const patchedBinary = fs.readFileSync(binary);
  const preservedSelection = {
    ...desired,
    revision: legacy.revision,
    capsule: false,
    limit: { enabled: true, modelLimits: [{ id: 1400, limit: 983040 }] },
  };
  const preservedDraft = await run('queue', preservedSelection);
  assert.equal(preservedDraft.error, undefined, JSON.stringify(preservedDraft));
  assert.equal((await run('status')).draft.id, preservedDraft.draft.id);
  const forged = await run('queue', {
    ...preservedSelection,
    limit: { enabled: true, modelLimits: [{ id: 1400, limit: 983041 }] },
  });
  assert.equal(forged.code, 'INVALID_SELECTION');
  const draftFile = path.join(state, 'management/drafts', `${preservedDraft.draft.id}.json`);
  const draftBytes = fs.readFileSync(draftFile);
  const tampered = JSON.parse(draftBytes);
  tampered.desired.limit.modelLimits[0].limit = 983041;
  fs.writeFileSync(draftFile, JSON.stringify(tampered));
  const rejected = await run('preflight', { id: preservedDraft.draft.id });
  assert.equal(rejected.code, 'INVALID_SELECTION');
  fs.writeFileSync(draftFile, draftBytes);
  const preserved = await run('apply-draft', { id: preservedDraft.draft.id });
  assert.equal(preserved.operation.state, 'succeeded', JSON.stringify(preserved));
  assert.deepEqual(fs.readFileSync(binary), patchedBinary);
  const cleanupDraft = await run('queue', {
    ...preservedSelection,
    limit: { enabled: false, modelLimits: [] },
  });
  const cleanup = await run('apply-draft', { id: cleanupDraft.draft.id });
  assert.equal(cleanup.operation.state, 'succeeded', JSON.stringify(cleanup));
  fs.appendFileSync(executable, 'changed');
  const drifted = await run('queue', desired);
  assert.equal(drifted.code, 'REVISION_CHANGED');
  assert.deepEqual(fs.readFileSync(binary), original);
  assert.deepEqual(fs.readFileSync(asarPath), archive);
});

test('the feature operation lock records its holder and reclaims crashed holders', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-lock-'));
  const previousHome = process.env.AGYCTL_HOME;
  process.env.AGYCTL_HOME = home;
  try {
    const key = 'b'.repeat(64);
    const directory = path.join(home, 'management', 'features', key);
    const lockFile = path.join(directory, 'state.lock');
    fs.mkdirSync(directory, { recursive: true });

    // A lock from a process that no longer exists is reclaimed and the action runs.
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({ pid: 999_999_999, token: 'dead', createdAt: new Date().toISOString() })}\n`,
    );
    assert.equal(
      withLock(key, (statePath) => path.basename(statePath)),
      'state.json',
    );
    assert.equal(fs.existsSync(lockFile), false, 'a successful run removes its own lock');

    // A live holder keeps the lock exclusive.
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({ pid: process.pid, token: 'live', createdAt: new Date().toISOString() })}\n`,
    );
    assert.throws(() => withLock(key, () => {}), { code: 'OPERATION_BUSY' });

    // An unparsable lock is only reclaimed after the write grace period.
    fs.writeFileSync(lockFile, '');
    assert.throws(() => withLock(key, () => {}), { code: 'OPERATION_BUSY' });
    const old = Date.now() / 1000 - 60;
    fs.utimesSync(lockFile, old, old);
    assert.equal(
      withLock(key, () => 'reclaimed'),
      'reclaimed',
    );

    // Release never deletes a successor's lock: a holder that lost ownership
    // during the action leaves the replacement lock alone.
    fs.writeFileSync(
      lockFile,
      `${JSON.stringify({ pid: 999_999_999, token: 'ours', createdAt: new Date().toISOString() })}\n`,
    );
    withLock(key, () =>
      fs.writeFileSync(
        lockFile,
        `${JSON.stringify({ pid: process.pid, token: 'successor', createdAt: new Date().toISOString() })}\n`,
      ),
    );
    assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'successor');
  } finally {
    if (previousHome === undefined) delete process.env.AGYCTL_HOME;
    else process.env.AGYCTL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
