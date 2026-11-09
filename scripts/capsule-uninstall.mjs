import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCapsuleStatus } from './capsule-install.mjs';
import {
  composer,
  engine as composerEngine,
  ensureClientClosedFor,
  hostPatchIo,
} from './lib/host-patch.mjs';
import { backupDir as defaultBackupDir, findAsarPath, sha256File } from './lib/install-paths.mjs';

export async function uninstallCapsule({
  asarPath = findAsarPath(),
  backupPath,
  backupDir = defaultBackupDir(),
  engine = composerEngine,
  force = false,
  executablePath,
  localizationProfiles,
  ensureClientClosed = () => ensureClientClosedFor(asarPath),
} = {}) {
  if (force)
    throw new Error(
      'Force cannot bypass exact capsule backup pairing; use a verified matching original',
    );
  asarPath = fs.realpathSync(asarPath);
  const status = getCapsuleStatus({ asarPath, backupDir, engine });
  if (!status.installed) {
    if (backupPath && sha256File(backupPath) !== status.currentHash) {
      const error = new Error(
        'Current app.asar has no matching installed Host receipt; stale restore refused',
      );
      error.code = 'STALE_BACKUP';
      throw error;
    }
    return { installed: false };
  }
  if (backupPath && fs.realpathSync(backupPath) !== fs.realpathSync(status.backupPath)) {
    const error = new Error('Requested backup does not match the exact installed Host receipt');
    error.code = 'STALE_BACKUP';
    throw error;
  }
  const result = await composer.removeFeatures(
    hostPatchIo({ asarPath, backupDir, engine, executablePath, localizationProfiles }),
    { remove: ['capsule'], ensureClientClosed },
  );
  const warnings = result.warnings ?? [];
  console.log(
    result.receipt
      ? 'Capsule removed; remaining Host features were preserved and verified.'
      : 'Original app.asar restored and verified; immutable backup history retained.',
  );
  return { installed: false, warnings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await uninstallCapsule({ force: process.argv.includes('--force') });
  } catch (error) {
    console.error('Error:', error.message);
    process.exitCode = 1;
  }
}
