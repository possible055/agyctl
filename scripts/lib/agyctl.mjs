import { spawn, spawnSync } from 'node:child_process';
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

function requireExecutable() {
  const executable = agyctlExecutable();
  if (!fs.existsSync(executable))
    throw new Error(`agyctl is not built: run npm run tools:build (expected ${executable})`);
  return executable;
}

function parseResult(stdout, status, stderr) {
  const value = JSON.parse(String(stdout).trim());
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('agyctl must return one JSON object');
  if (status !== 0)
    throw Object.assign(
      new Error(
        typeof value.error === 'string' ? value.error : `agyctl failed (${status}): ${stderr}`,
      ),
      {
        result: value,
        ...(typeof value.refusal?.kind === 'string'
          ? { code: value.refusal.kind, refusal: value.refusal }
          : {}),
      },
    );
  return value;
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Runs the built agyctl and returns its single JSON object; a failing exit code throws. */
export function runAgyctl(args) {
  const executable = requireExecutable();
  const result = spawnSync(executable, ['--root', repoRoot, ...args, '--json'], {
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) throw result.error;
  return parseResult(result.stdout, result.status, result.stderr);
}

/** Async variant of runAgyctl so callers can overlap the spawned scan with their own work. */
export function runAgyctlAsync(args) {
  const executable = requireExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--root', repoRoot, ...args, '--json'], {
      windowsHide: true,
    });
    let stdout = '';
    let stdoutBytes = 0;
    let outputExceeded = false;
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (outputExceeded) return;
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        clearTimeout(timer);
        reject(
          Object.assign(new Error(`agyctl stdout exceeds the ${MAX_OUTPUT_BYTES}-byte limit`), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          }),
        );
        child.kill();
        return;
      }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (outputExceeded) return;
      try {
        resolve(parseResult(stdout, code, stderr));
      } catch (error) {
        reject(error);
      }
    });
  });
}
