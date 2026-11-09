import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  asarContainsHook,
  ensureOriginalBackup,
  getCapsuleStatus,
  HOOK_MARKER,
  installCapsule,
  sha256File,
} from '../../scripts/capsule-install.mjs';
import { uninstallCapsule } from '../../scripts/capsule-uninstall.mjs';
import { replaceFileTransaction } from '../../scripts/lib/file-transaction.mjs';
import { inspectPlugin, installPlugin } from '../../scripts/plugin-install.mjs';
import { writeServedLanguageServer } from './helpers/synthetic-ls.mjs';

const require = createRequire(import.meta.url);
const { builtinAsar: engine } = require('../../scripts/vendor/asar-engine.cjs');
const capsuleCode = 'globalThis.__capsuleFixture = true;';

async function fixture(root, name = 'client', { native = false, version = '1' } = {}) {
  const directory = path.join(root, name);
  const source = path.join(directory, 'source');
  const asarPath = path.join(directory, 'app.asar');
  fs.mkdirSync(path.join(source, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(source, 'dist', 'preload.js'),
    `const version = ${JSON.stringify(version)};\n`,
  );
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'fixture', version }));
  if (native) {
    fs.mkdirSync(path.join(source, 'native'));
    fs.writeFileSync(path.join(source, 'native', 'addon.node'), 'native-binary-v1');
  }
  await engine.createPackageWithOptions(
    source,
    asarPath,
    native ? { unpackedPaths: ['native'] } : {},
  );
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
  return {
    asarPath,
    backupDir: path.join(root, 'backups'),
    engine,
    capsuleCode,
    executablePath,
  };
}

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-install-safety-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('restore refuses an unrecorded hooked version and preserves original history', async (t) => {
  const root = temporary(t);
  const options = await fixture(root);
  const installed = await installCapsule(options);
  const backupBytes = fs.readFileSync(installed.backupPath);
  const foreign = await fixture(root, 'foreign', { version: '2' });
  const foreignPatched = path.join(root, 'foreign-patched.asar');
  engine.patchArchive(foreign.asarPath, foreignPatched, {
    'dist/preload.js': Buffer.from(`const version = '2';\n${HOOK_MARKER}`),
  });
  fs.copyFileSync(foreignPatched, options.asarPath);
  const current = fs.readFileSync(options.asarPath);
  await assert.rejects(
    uninstallCapsule({ ...options, backupPath: installed.backupPath }),
    /Host-composed archive without a matching receipt/,
  );
  assert.deepEqual(fs.readFileSync(options.asarPath), current);
  assert.deepEqual(fs.readFileSync(installed.backupPath), backupBytes);
  assert.throws(
    () => ensureOriginalBackup(options.asarPath, options.backupDir),
    /Host-composed archive without a matching receipt/,
  );
});

test('reinstall and clean app updates retain immutable, channel-specific original pairs', async (t) => {
  const root = temporary(t);
  const options = await fixture(root, 'antigravity-insiders');
  const firstHash = sha256File(options.asarPath);
  const first = await installCapsule(options);
  const recordPath = getCapsuleStatus(options).recordPath;
  const recordBytes = fs.readFileSync(recordPath);
  const second = await installCapsule({
    ...options,
    capsuleCode: 'globalThis.__capsuleFixture = 2;',
  });
  assert.equal(second.backupPath, first.backupPath);
  assert.equal(sha256File(first.backupPath), firstHash);
  assert.deepEqual(fs.readFileSync(recordPath), recordBytes);
  const update = await fixture(root, 'clean-update', { version: '2' });
  const updateHash = sha256File(update.asarPath);
  fs.copyFileSync(update.asarPath, options.asarPath);
  const third = await installCapsule(options);
  assert.notEqual(third.backupPath, first.backupPath);
  assert.equal(third.receipt.originalHash, updateHash);
  assert.equal(sha256File(first.backupPath), firstHash);
  const stable = await fixture(root, 'antigravity');
  const stableInstall = await installCapsule(stable);
  assert.notEqual(stableInstall.receipt.installationId, third.receipt.installationId);
  assert.equal(getCapsuleStatus(stable).channel, 'stable');
  assert.equal(getCapsuleStatus(options).channel, 'insiders');
  await uninstallCapsule(options);
  assert.equal(sha256File(options.asarPath), updateHash);
  assert.deepEqual(fs.readFileSync(recordPath), recordBytes);
});

test('reinstalling and removing the capsule never change the original backup', async (t) => {
  const root = temporary(t);
  const options = await fixture(root);
  const originalHash = sha256File(options.asarPath);
  let installed;
  for (let attempt = 0; attempt < 2; attempt++) {
    installed = await installCapsule(options);
    assert.equal(installed.installed, true);
  }
  assert.equal(installed.receipt.originalHash, originalHash);
  assert.equal(sha256File(installed.backupPath), originalHash);
  assert.equal(asarContainsHook(installed.backupPath, engine), false);
  assert.equal(asarContainsHook(options.asarPath, engine), true);

  const removed = await uninstallCapsule({ ...options, backupPath: installed.backupPath });
  assert.equal(removed.installed, false);
  assert.equal(sha256File(options.asarPath), originalHash);
  assert.equal((await uninstallCapsule(options)).installed, false);
});

test('an install interrupted after its record is published is recognizable and retryable', async (t) => {
  const root = temporary(t);
  const options = await fixture(root);
  const originalHash = sha256File(options.asarPath);
  await assert.rejects(
    installCapsule({
      ...options,
      transaction: () => {
        throw new Error('fixture interruption before replacement');
      },
    }),
    /fixture interruption before replacement/,
  );
  const records = fs
    .readdirSync(path.join(options.backupDir, 'host'), { recursive: true })
    .filter((name) => String(name).endsWith('.json'));
  assert.ok(records.length > 0, 'the interrupted install must leave a durable record');
  assert.equal(getCapsuleStatus(options).installed, false);
  assert.equal(sha256File(options.asarPath), originalHash);

  const installed = await installCapsule(options);
  assert.equal(sha256File(options.asarPath), installed.receipt.patchedHash);
  const status = getCapsuleStatus(options);
  assert.equal(status.installed, true);
  assert.equal(sha256File(status.backupPath), originalHash);
});

test('native unpacked files and header flags survive install, reinstall, and restore', async (t) => {
  const root = temporary(t);
  const options = await fixture(root, 'client', { native: true });
  const originalHash = sha256File(options.asarPath);
  const native = path.join(options.asarPath + '.unpacked', 'native', 'addon.node');
  const metadata = engine.statFile(options.asarPath, 'native/addon.node');
  const installed = await installCapsule(options);
  await installCapsule(options);
  assert.equal(fs.readFileSync(native, 'utf8'), 'native-binary-v1');
  assert.deepEqual(engine.statFile(options.asarPath, 'native/addon.node'), metadata);
  assert.equal(
    fs.readFileSync(path.join(installed.backupPath + '.unpacked', 'native', 'addon.node'), 'utf8'),
    'native-binary-v1',
  );
  await uninstallCapsule(options);
  assert.equal(sha256File(options.asarPath), originalHash);
  assert.equal(fs.readFileSync(native, 'utf8'), 'native-binary-v1');
  fs.unlinkSync(native);
  await assert.rejects(installCapsule(options), /Incomplete ASAR file native\/addon\.node/);
  assert.equal(sha256File(options.asarPath), originalHash);
});

test('persisted preload activation does not depend on upstream bundle variable names', async (t) => {
  const options = await fixture(temporary(t));
  await installCapsule(options);
  const activated = [];
  const warnings = [];
  vm.runInNewContext(engine.extractFile(options.asarPath, 'dist/preload.js').toString('utf8'), {
    document: { readyState: 'complete', head: {}, body: {} },
    require(name) {
      assert.equal(name, 'electron');
      return {
        webFrame: {
          executeJavaScript(code) {
            activated.push(code);
            return Promise.resolve();
          },
        },
      };
    },
    console: { warn: (...args) => warnings.push(args) },
  });
  await Promise.resolve();
  assert.deepEqual(activated, [capsuleCode]);
  assert.equal(warnings.length, 0);
});

test('corrupt originals fail before replacement and historical backups remain untouched', async (t) => {
  const root = temporary(t);
  const options = await fixture(root);
  const installed = await installCapsule(options);
  const installedBytes = fs.readFileSync(options.asarPath);
  fs.writeFileSync(installed.backupPath, 'corrupt-backup');
  await assert.rejects(uninstallCapsule(options), /Truncated ASAR archive|Invalid ASAR header/);
  assert.deepEqual(fs.readFileSync(options.asarPath), installedBytes);
  const clean = await fixture(root, 'clean');
  fs.mkdirSync(clean.backupDir, { recursive: true });
  const legacy = path.join(clean.backupDir, 'app-original.asar');
  fs.writeFileSync(legacy, installedBytes);
  const cleanHash = sha256File(clean.asarPath);
  await installCapsule(clean);
  const cleanStatus = getCapsuleStatus(clean);
  assert.equal(cleanStatus.receipt.originalHash, cleanHash);
  fs.writeFileSync(clean.asarPath, 'broken-archive');
  assert.throws(() => getCapsuleStatus(clean), /Truncated ASAR archive|Invalid ASAR header/);
  assert.deepEqual(fs.readFileSync(legacy), installedBytes);
});

test('atomic replacement refuses concurrent changes and rolls back failed validation', (t) => {
  const root = temporary(t);
  const targetPath = path.join(root, 'target');
  const stagedPath = path.join(root, 'staged');
  fs.writeFileSync(targetPath, 'original');
  fs.writeFileSync(stagedPath, 'replacement');
  const expectedHash = sha256File(targetPath);
  fs.writeFileSync(targetPath, 'app update');
  assert.throws(
    () => replaceFileTransaction({ targetPath, stagedPath, expectedHash, validate() {} }),
    /Installation changed while staging/,
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'app update');
  fs.writeFileSync(targetPath, 'original');
  assert.throws(
    () =>
      replaceFileTransaction({
        targetPath,
        stagedPath,
        expectedHash,
        validate(file) {
          if (file === targetPath) throw new Error('post-write validation failure');
        },
      }),
    /post-write validation failure/,
  );
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original');
});

test('invalid supplied capsule JavaScript fails before backup or archive writes', async (t) => {
  const root = temporary(t);
  const options = await fixture(root);
  const originalHash = sha256File(options.asarPath);
  await assert.rejects(
    installCapsule({ ...options, capsuleCode: 'const = invalid;' }),
    SyntaxError,
  );
  assert.equal(sha256File(options.asarPath), originalHash);
  assert.equal(fs.existsSync(options.backupDir), false);
});

test('transaction cleanup errors preserve committed and restored outcomes', (t) => {
  const root = temporary(t);
  const targetPath = path.join(root, 'target');
  const stagedPath = path.join(root, 'staged');
  const remove = fs.rmSync;
  const cleanupFailure = new Error('rollback directory is locked');
  const cleanup = t.mock.method(fs, 'rmSync', (file, options) => {
    if (path.basename(file).startsWith('.agyctl-rollback-')) throw cleanupFailure;
    return remove(file, options);
  });
  try {
    for (const failValidation of [false, true]) {
      fs.writeFileSync(targetPath, 'original');
      fs.writeFileSync(stagedPath, 'replacement');
      const expectedHash = sha256File(targetPath);
      const replacementHash = sha256File(stagedPath);
      const run = () =>
        replaceFileTransaction({
          targetPath,
          stagedPath,
          expectedHash,
          validate(file) {
            if (failValidation && file === targetPath) throw new Error('post-write failure');
          },
        });
      if (failValidation) {
        assert.throws(run, (error) => {
          assert.equal(error.outcome, 'restored');
          assert.match(error.message, /post-write failure/);
          assert.equal(error.cleanupError, cleanupFailure);
          assert.equal(error.recoveryPath, undefined);
          return true;
        });
      } else {
        const result = run();
        assert.equal(result.outcome, 'committed');
        assert.equal(result.hash, replacementHash);
        assert.equal(result.cleanupError, cleanupFailure);
        assert.equal(fs.existsSync(result.cleanupPath), true);
      }
      assert.equal(
        fs.readFileSync(targetPath, 'utf8'),
        failValidation ? 'original' : 'replacement',
      );
    }
  } finally {
    cleanup.mock.restore();
  }
});

test('transaction recovery paths follow rollback rename and verification failures', (t) => {
  const root = temporary(t);
  const targetPath = path.join(root, 'target');
  const stagedPath = path.join(root, 'staged');
  const rename = fs.renameSync;
  const open = fs.openSync;
  let failRestoredRead = false;
  const renameMock = t.mock.method(fs, 'renameSync', (source, destination) => {
    const result = rename(source, destination);
    if (path.basename(source) === 'current') failRestoredRead = true;
    return result;
  });
  const readMock = t.mock.method(fs, 'openSync', (file, ...args) => {
    if (failRestoredRead && file === targetPath) throw new Error('restored file read denied');
    return open(file, ...args);
  });
  try {
    fs.writeFileSync(targetPath, 'original');
    fs.writeFileSync(stagedPath, 'replacement');
    const expectedHash = sha256File(targetPath);
    assert.throws(
      () =>
        replaceFileTransaction({
          targetPath,
          stagedPath,
          expectedHash,
          validate(file) {
            if (file === targetPath) throw new Error('post-write failure');
          },
        }),
      (error) => {
        assert.doesNotMatch(error.message, /recovery copy retained/);
        assert.equal(error.outcome, 'unknown');
        assert.equal(error.recoveryPath, targetPath);
        assert.match(error.message, /restoration.*verification failed/i);
        assert.equal(fs.existsSync(error.recoveryPath), true);
        return true;
      },
    );
  } finally {
    renameMock.mock.restore();
    readMock.mock.restore();
  }
  assert.equal(fs.readFileSync(targetPath, 'utf8'), 'original');
});

test('plugin install replaces the package atomically and preserves the previous directory', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const writePackage = (name, marker) => {
    const directory = path.join(root, name);
    fs.mkdirSync(path.join(directory, 'sidecars', 'panel'), { recursive: true });
    fs.writeFileSync(
      path.join(directory, 'plugin.json'),
      JSON.stringify({ name: 'agyctl', version: '1.0.0' }),
    );
    fs.writeFileSync(path.join(directory, 'sidecars', 'panel', 'main.mjs'), marker);
    fs.writeFileSync(path.join(directory, 'sidecars', 'panel', 'sidecar.json'), '{}');
    return directory;
  };
  const first = writePackage('first', 'export const marker = 1;\n');
  const second = writePackage('second', 'export const marker = 2;\n');
  const target = path.join(root, 'config', 'plugins', 'agyctl');

  assert.equal(installPlugin({ sourceDir: first, targetDir: target }).changed, true);
  assert.equal(installPlugin({ sourceDir: first, targetDir: target }).changed, false);

  const updated = installPlugin({ sourceDir: second, targetDir: target });
  assert.equal(updated.changed, true);
  assert.equal(inspectPlugin(target).sha256, inspectPlugin(second).sha256);
  assert.equal(inspectPlugin(updated.previousPath).sha256, inspectPlugin(first).sha256);

  fs.rmSync(path.join(second, 'plugin.json'));
  assert.throws(
    () => installPlugin({ sourceDir: second, targetDir: target }),
    /missing plugin\.json/,
  );
  assert.equal(inspectPlugin(target).sha256, updated.sha256);
});

test('capsule install refuses a client whose web bundle lost an anchor before any write', async (t) => {
  const root = temporary(t);
  const options = await fixture(root);
  const before = fs.readFileSync(options.asarPath);
  writeServedLanguageServer(options.asarPath, '/* an unrelated bundle */');
  await assert.rejects(installCapsule(options), /no longer contains the capsule anchors/);
  assert.deepEqual(fs.readFileSync(options.asarPath), before);
  assert.equal(fs.existsSync(options.backupDir), false);
});
