import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectFiles, sha256 } from './lib/files.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultPluginDir = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'agyctl');

function readPackage(sourceDir) {
  const entries = new Map(
    collectFiles(sourceDir, ['.']).map((file) => [file.path.replace(/^\.\//, ''), file.content]),
  );
  for (const required of [
    'plugin.json',
    'sidecars/panel/main.mjs',
    'sidecars/panel/sidecar.json',
  ]) {
    if (!entries.has(required)) throw new Error(`Plugin package is missing ${required}`);
  }
  const metadata = JSON.parse(entries.get('plugin.json').toString('utf8'));
  if (metadata.name !== 'agyctl') throw new Error('Unexpected plugin package name');
  const digest = sha256(
    Buffer.from(
      [...entries]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([relative, bytes]) => `${relative}\0${sha256(bytes)}\n`)
        .join(''),
    ),
  );
  return { entries, version: metadata.version, sha256: digest };
}

export function inspectPlugin(directory = defaultPluginDir) {
  const absolute = path.resolve(directory);
  if (!fs.existsSync(absolute)) return { installed: false, path: absolute };
  if (fs.lstatSync(absolute).isSymbolicLink())
    throw new Error('Plugin directory cannot be a symbolic link');
  const { version, sha256: digest } = readPackage(absolute);
  return { installed: true, path: absolute, version, sha256: digest };
}

/**
 * Replaces the plugin directory with the source package. The previous
 * directory is moved aside, never deleted, and restored if the new one does
 * not verify.
 */
export function installPlugin({
  sourceDir = path.join(repoRoot, 'src', 'plugin'),
  targetDir = defaultPluginDir,
} = {}) {
  const source = readPackage(path.resolve(sourceDir));
  const target = path.resolve(targetDir);
  if (target === path.parse(target).root)
    throw new Error('Plugin target cannot be a filesystem root');
  const before = inspectPlugin(target);
  if (before.sha256 === source.sha256) return { ...before, changed: false };
  const backups = path.resolve(path.dirname(target), '..', 'plugin-backups');
  fs.mkdirSync(backups, { recursive: true });
  const staging = fs.mkdtempSync(path.join(backups, '.agyctl-staging-'));
  const previous = path.join(backups, `agyctl.previous-${crypto.randomUUID()}`);
  let movedPrevious = false;
  let movedStaging = false;
  try {
    for (const [relative, bytes] of source.entries) {
      const destination = path.join(staging, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx' });
    }
    if (inspectPlugin(staging).sha256 !== source.sha256)
      throw new Error('Staged plugin verification failed');
    if (inspectPlugin(target).sha256 !== before.sha256)
      throw new Error('Installed plugin changed while staging the update');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (before.installed) {
      fs.renameSync(target, previous);
      movedPrevious = true;
    }
    fs.renameSync(staging, target);
    movedStaging = true;
    if (inspectPlugin(target).sha256 !== source.sha256)
      throw new Error('Installed plugin verification failed');
    return {
      ...inspectPlugin(target),
      changed: true,
      previousPath: movedPrevious ? previous : null,
    };
  } catch (error) {
    if (movedStaging)
      fs.renameSync(target, path.join(backups, `agyctl.failed-${crypto.randomUUID()}`));
    if (movedPrevious && !fs.existsSync(target)) fs.renameSync(previous, target);
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2) throw new Error('plugin:install takes no arguments');
    const result = installPlugin();
    console.log(
      `${result.changed ? 'Installed' : 'Already installed'} plugin ${result.version}: ${result.path}`,
    );
    if (result.previousPath) console.log(`Previous plugin preserved: ${result.previousPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
