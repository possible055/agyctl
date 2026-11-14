import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helper = fileURLToPath(new URL('./client-processes.ps1', import.meta.url));

function failure(code, message) {
  return Object.assign(new Error(message), { code, safeForPanel: true });
}

function samePath(first, second) {
  return (
    typeof first === 'string' &&
    typeof second === 'string' &&
    path.win32.normalize(first).replace(/\\$/, '').toLowerCase() ===
      path.win32.normalize(second).replace(/\\$/, '').toLowerCase()
  );
}

function validIdentity(record) {
  return (
    record &&
    Number.isSafeInteger(record.pid) &&
    record.pid > 0 &&
    Number.isSafeInteger(record.parentPid) &&
    record.parentPid > 0 &&
    typeof record.created === 'string' &&
    /^[1-9]\d{15,19}$/.test(record.created) &&
    typeof record.path === 'string' &&
    path.win32.isAbsolute(record.path)
  );
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Classifies only the two inspected Hub sidecar layouts; unknown processes refuse cleanup. */
export function planSidecarCleanup(target, records) {
  if (!Array.isArray(records)) throw failure('PROCESS_UNKNOWN', 'Invalid process inventory');
  const home = os.homedir();
  const locations = [
    {
      plugin: 'agyctl',
      sidecar: 'panel',
      directory: path.join(home, '.gemini/config/plugins/agyctl/sidecars/panel'),
    },
    {
      plugin: 'swarm',
      sidecar: 'swarm_board',
      directory: path.join(home, '.gemini/antigravity/builtin/plugins/swarm/sidecars/swarm_board'),
    },
  ];
  const loader = pathToFileURL(
    path.join(home, '.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js'),
  ).href;
  const wrapper = path.join(process.env.APPDATA ?? '', 'Antigravity/bin/agy-node.cmd');
  const shell = path.join(process.env.SystemRoot ?? '', 'System32/cmd.exe');
  if (!path.win32.isAbsolute(wrapper) || !path.win32.isAbsolute(shell))
    throw failure('PROCESS_UNKNOWN', 'Cannot resolve the Hub launcher paths');
  const childCommand = new RegExp(
    `^"${escaped(target.executablePath)}"\\s+--import=${escaped(loader)}\\s+main\\.mjs$`,
    'i',
  );
  const parentCommand = new RegExp(
    `^"?${escaped(shell)}"?\\s+(?:/d\\s+)?(?:/s\\s+)?/c\\s+""${escaped(wrapper)}"\\s+--import=${escaped(loader)}\\s+main\\.mjs"$`,
    'i',
  );
  const candidates = [];
  const seen = new Set();
  for (const record of records) {
    if (!validIdentity(record) || seen.has(record.pid))
      throw failure('PROCESS_UNKNOWN', 'Cannot verify process identities');
    seen.add(record.pid);
    if (!samePath(record.path, target.executablePath) && !samePath(record.path, target.binaryPath))
      throw failure('PROCESS_UNKNOWN', 'The process belongs to another installation');
    if (record.kind === 'client' || record.kind === 'server')
      throw failure('CLIENT_RUNNING', 'Quit Antigravity before cleaning sidecars');
    const location = locations.find((entry) => samePath(record.directory, entry.directory));
    const parent = record.parent;
    if (
      record.kind !== 'sidecar' ||
      !location ||
      !validIdentity(parent) ||
      record.parentPid !== parent.pid ||
      !samePath(parent.path, shell) ||
      !samePath(parent.directory, record.directory) ||
      BigInt(parent.created) >= BigInt(record.created) ||
      typeof record.command !== 'string' ||
      !childCommand.test(record.command) ||
      typeof parent.command !== 'string' ||
      !parentCommand.test(parent.command) ||
      (record.owner !== null &&
        (!validIdentity(record.owner) ||
          record.owner.pid !== parent.parentPid ||
          BigInt(record.owner.created) <= BigInt(parent.created)))
    )
      throw failure('PROCESS_UNKNOWN', 'Cannot verify an orphan sidecar and its launcher');
    candidates.push({ ...location, pid: record.pid });
  }
  return candidates;
}

function runProcessHelper(target, action, expected) {
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw failure('CLEANUP_UNSUPPORTED', 'Sidecar cleanup requires Windows x86-64');
  let result;
  try {
    result = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', fs.readFileSync(helper, 'utf8')],
      {
        input: JSON.stringify({
          action,
          executablePath: target.executablePath,
          binaryPath: target.binaryPath,
          expected,
        }),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    let reason = error.message;
    if (error.stdout) {
      try {
        reason = JSON.parse(String(error.stdout).replace(/^\uFEFF/, '')).error ?? reason;
      } catch {
        reason = 'The process helper returned an invalid response';
      }
    }
    throw failure('PROCESS_UNKNOWN', `Cannot verify sidecars: ${reason}`);
  }
  let value;
  try {
    value = JSON.parse(result.replace(/^\uFEFF/, ''));
  } catch {
    throw failure('PROCESS_UNKNOWN', 'The process helper returned an invalid response');
  }
  if (!Array.isArray(value.processes))
    throw failure('PROCESS_UNKNOWN', 'Invalid process inventory');
  return value.processes;
}

export function inspectOrphanSidecars(target) {
  const records = runProcessHelper(target, 'inspect');
  return { records, candidates: planSidecarCleanup(target, records) };
}

/** Stops only an explicitly requested, identity-bound plan; original client checks must run afterwards. */
export function cleanupOrphanSidecars(target, inspection = inspectOrphanSidecars(target)) {
  const candidates = planSidecarCleanup(target, inspection.records);
  if (candidates.length) runProcessHelper(target, 'cleanup', inspection.records);
  const remaining = runProcessHelper(target, 'inspect');
  if (remaining.length)
    throw failure('CLIENT_RUNNING', 'Processes remain; no client files were changed');
  return {
    cleaned: candidates.length,
    sidecars: candidates.map(({ pid, plugin, sidecar }) => ({ pid, plugin, sidecar })),
  };
}
