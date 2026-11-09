import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { agyctlExecutable, repoRoot } from './lib/agyctl.mjs';

const executable = agyctlExecutable();
if (!fs.existsSync(executable)) {
  console.error(`agyctl is not built: run npm run tools:build (expected ${executable})`);
  process.exit(1);
}
const args = process.argv.slice(2);
const result = spawnSync(
  executable,
  ['--root', repoRoot, ...args, ...(args.includes('--json') ? [] : ['--json'])],
  { stdio: 'inherit', windowsHide: true },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
