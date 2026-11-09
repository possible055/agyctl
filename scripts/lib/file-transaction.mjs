import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from './install-paths.mjs';

/**
 * Replaces one file by same-volume rename, reverting on failed post-write
 * validation.
 *
 * Supported guarantee: recovery from PROCESS interruption. Publication order
 * is verify staging -> verify current target -> copy rollback -> rename. The
 * rename is atomic within one volume on Windows (MoveFileEx semantics) and
 * POSIX (rename(2)), so an observer sees either the old or the new file.
 * Durability beyond process death (power loss, unsupported filesystems) is
 * NOT guaranteed: bytes are not fsynced before publication.
 * Returns the committed hash and any cleanup error separately. Thrown errors
 * carry an outcome (unchanged, restored, or unknown); recoveryPath identifies
 * the remaining recovery copy, or the target when restoration cannot be verified.
 */
export function replaceFileTransaction({
  targetPath,
  stagedPath,
  expectedHash,
  validate,
  afterReplace,
}) {
  let stagedHash;
  let rollbackDirectory;
  let rollbackPath;
  let outcome = 'unchanged';
  let keepRollback = false;
  let failure;
  try {
    stagedHash = sha256File(stagedPath);
    validate(stagedPath);
    if (sha256File(targetPath) !== expectedHash)
      throw new Error('Installation changed while staging; refusing replacement');
    rollbackDirectory = fs.mkdtempSync(path.join(path.dirname(targetPath), '.agyctl-rollback-'));
    rollbackPath = path.join(rollbackDirectory, 'current');
    fs.copyFileSync(targetPath, rollbackPath, fs.constants.COPYFILE_EXCL);
    if (sha256File(rollbackPath) !== expectedHash || sha256File(targetPath) !== expectedHash) {
      throw new Error('Installation changed while preparing rollback; refusing replacement');
    }
    try {
      fs.renameSync(stagedPath, targetPath);
    } catch (error) {
      throw new Error(
        `Cannot atomically replace ${targetPath}; close the app and retry (no files were forced or deleted): ${error.message}`,
        { cause: error },
      );
    }
    outcome = 'unknown';
    if (sha256File(targetPath) !== stagedHash)
      throw new Error('Installed file hash does not match validated staging');
    validate(targetPath);
    afterReplace?.();
    outcome = 'committed';
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    if (outcome === 'unknown') {
      let rollbackMoved = false;
      try {
        if (sha256File(targetPath) !== stagedHash)
          throw new Error('Installed file changed again; automatic rollback refused');
        fs.renameSync(rollbackPath, targetPath);
        rollbackMoved = true;
        if (sha256File(targetPath) !== expectedHash)
          throw new Error('Rollback hash verification failed');
        outcome = 'restored';
      } catch (rollbackError) {
        keepRollback = !rollbackMoved;
        failure = new AggregateError(
          [error, rollbackError],
          rollbackMoved
            ? `Replacement failed; original moved back to ${targetPath}, but restoration verification failed; inspect the target (no separate recovery copy remains)`
            : `Replacement failed; recovery copy retained at ${rollbackPath}`,
        );
        failure.recoveryPath = rollbackMoved ? targetPath : rollbackPath;
      }
    }
  }
  let cleanupError;
  if (rollbackDirectory && !keepRollback) {
    try {
      fs.rmSync(rollbackDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupError = error;
    }
  }
  const cleanup = cleanupError ? { cleanupError, cleanupPath: rollbackDirectory } : {};
  if (failure) throw Object.assign(failure, { outcome, ...cleanup });
  return { outcome: 'committed', hash: stagedHash, ...cleanup };
}
