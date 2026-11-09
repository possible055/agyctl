import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { assembleCapsule } from './capsule-build.mjs';
import { replaceFileTransaction } from './lib/file-transaction.mjs';
import {
  assertCapsuleAnchors,
  buildCapsulePreloadHook,
  capsuleFeature,
  composer,
  engine as composerEngine,
  ensureClientClosedFor,
  hostPatchIo,
} from './lib/host-patch.mjs';
import { backupDir as defaultBackupDir, findAsarPath, sha256File } from './lib/install-paths.mjs';

export { buildCapsulePreloadHook };
export const HOOK_MARKER = composer.HOST_CAPSULE_FEATURE_MARKER;
export { findAsarPath, sha256File };
export const unpackedHash = composer.computeUnpackedManifestHash;

export function asarContainsHook(asarPath, engine = composerEngine) {
  return engine.extractFile(asarPath, 'dist/preload.js').toString('utf8').includes(HOOK_MARKER);
}

/** Reads capsule feature state from the current Host receipt. */
export function getCapsuleStatus({
  asarPath = findAsarPath(),
  backupDir = defaultBackupDir(),
  engine = composerEngine,
} = {}) {
  return composer.getHostStatus({ asarPath, backupDir, engine });
}

/** Creates an immutable, complete original backup, or verifies a recorded patched/original pair. */
export function ensureOriginalBackup(asarPath, backupDir, engine = composerEngine) {
  const result = composer.ensureOriginalBackup({ asarPath, backupDir, engine });
  return { ...getCapsuleStatus({ asarPath, backupDir, engine }), ...result };
}

export async function installCapsule({
  asarPath = findAsarPath(),
  backupDir,
  engine = composerEngine,
  capsuleCode = assembleCapsule(),
  transaction = replaceFileTransaction,
  log = console.log,
  executablePath,
  localizationProfiles,
  ensureClientClosed = () => ensureClientClosedFor(asarPath),
  verifyAnchors = () => assertCapsuleAnchors(asarPath),
} = {}) {
  // Validated first so a syntax error or a client without the anchors never creates backup state.
  capsuleFeature.validate({ code: capsuleCode });
  verifyAnchors();
  backupDir ??= defaultBackupDir();
  const result = await composer.applyFeatures(
    {
      ...hostPatchIo({ asarPath, backupDir, engine, executablePath, localizationProfiles }),
      transaction,
    },
    {
      features: { capsule: { code: capsuleCode } },
      ensureClientClosed,
    },
  );
  log('Capsule installation persisted and verified:', asarPath);
  return {
    installed: true,
    receipt: result.receipt,
    backupPath: result.backupPath,
    warnings: result.warnings ?? [],
  };
}

function writableDirectory(directory) {
  let existing = directory;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`No writable parent directory: ${directory}`);
    existing = parent;
  }
  if (!fs.statSync(existing).isDirectory()) throw new Error(`Expected directory: ${existing}`);
  fs.accessSync(existing, fs.constants.W_OK);
}

export function capsuleReadiness(asarPath, { preflight = false, backupDir, executablePath } = {}) {
  const status = getCapsuleStatus({ asarPath, backupDir: backupDir ?? defaultBackupDir() });
  const capsuleCode = assembleCapsule();
  const capsuleHash = createHash('sha256').update(capsuleCode).digest('hex');
  if (preflight) {
    composer.qualifyHostMutation(hostPatchIo({ asarPath, executablePath }));
    writableDirectory(path.dirname(asarPath));
    writableDirectory(backupDir ?? defaultBackupDir());
    fs.accessSync(asarPath, fs.constants.W_OK);
    capsuleFeature.validate({ code: capsuleCode });
    vm.compileFunction(
      composerEngine.extractFile(status.backupPath ?? asarPath, 'dist/preload.js').toString('utf8'),
      ['exports', 'require', 'module', '__filename', '__dirname'],
      { filename: 'preload.js' },
    );
  }
  return {
    ...status,
    capsuleHash,
    hookPresent: asarContainsHook(asarPath),
    readiness: {
      status: status.receipt?.features.capsule?.codeHash === capsuleHash ? 'current' : 'ready',
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('capsule:install takes no arguments');
    await installCapsule();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
