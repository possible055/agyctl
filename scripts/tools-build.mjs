import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installLayout, supportedTarget } from './lib/install-paths.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hostTarget = supportedTarget();
const targetId = `${process.env.GOOS || hostTarget.goos}/${process.env.GOARCH || hostTarget.goarch}`;
const target = installLayout().targets[targetId];
if (!target) throw new Error(`Unsupported build target: ${targetId}`);
const bin = path.join(root, 'dist', 'bin', targetId.replace('/', '-'));
fs.mkdirSync(bin, { recursive: true });
const executable = path.join(bin, target.goos === 'windows' ? 'agyctl.exe' : 'agyctl');
const go =
  process.env.GO ||
  (process.platform === 'win32' && fs.existsSync('C:/Program Files/Go/bin/go.exe')
    ? 'C:/Program Files/Go/bin/go.exe'
    : 'go');
const buildCommit = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
})();
const result = spawnSync(
  go,
  [
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-o',
    executable,
    '-ldflags',
    `-X main.buildCommit=${buildCommit}`,
    './cmd/agyctl',
  ],
  {
    cwd: path.join(root, 'src', 'agyctl'),
    env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
    stdio: 'inherit',
    windowsHide: true,
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Built ${executable}`);
