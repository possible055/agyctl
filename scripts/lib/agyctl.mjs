import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supportedTarget } from './install-paths.mjs';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export function agyctlExecutable() {
  const { goos, goarch } = supportedTarget();
  return path.join(
    repoRoot,
    'dist',
    'bin',
    `${goos}-${goarch}`,
    goos === 'windows' ? 'agyctl.exe' : 'agyctl',
  );
}

/** Runs the built agyctl and returns its single JSON object; a failing exit code throws. */
export function runAgyctl(args) {
  const executable = agyctlExecutable();
  if (!fs.existsSync(executable))
    throw new Error(`agyctl is not built: run npm run tools:build (expected ${executable})`);
  const result = spawnSync(executable, ['--root', repoRoot, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const value = JSON.parse(String(result.stdout).trim());
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('agyctl must return one JSON object');
  if (result.status !== 0)
    throw new Error(
      typeof value.error === 'string'
        ? value.error
        : `agyctl failed (${result.status}): ${result.stderr}`,
    );
  return value;
}
