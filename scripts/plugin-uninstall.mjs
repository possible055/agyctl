import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPluginDir } from './plugin-install.mjs';

/**
 * Moves the installed plugin directory aside into plugin-backups; the
 * directory is never deleted, matching the install-time preservation policy.
 */
export function uninstallPlugin({ targetDir = defaultPluginDir } = {}) {
  const target = path.resolve(targetDir);
  if (target === path.parse(target).root)
    throw new Error('Plugin target cannot be a filesystem root');
  if (!fs.existsSync(target)) return { installed: false, path: target, changed: false };
  if (fs.lstatSync(target).isSymbolicLink())
    throw new Error('Plugin directory cannot be a symbolic link');
  const backups = path.resolve(path.dirname(target), '..', 'plugin-backups');
  fs.mkdirSync(backups, { recursive: true });
  const removedPath = path.join(backups, `agyctl.removed-${crypto.randomUUID()}`);
  fs.renameSync(target, removedPath);
  return { installed: false, path: target, changed: true, removedPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('plugin:uninstall takes no arguments');
    const result = uninstallPlugin();
    console.log(
      result.changed
        ? `Removed plugin: ${result.removedPath}`
        : `Plugin is not installed: ${result.path}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
