import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '..', '..');
const outDir = path.join(repoRoot, 'dist', 'localization', 'bundle');
const inputs = {};
const outputs = {};
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
mkdirSync(outDir, { recursive: true });
for (const obsolete of ['host-composer.mjs', 'localization-logging.mjs'])
  rmSync(path.join(outDir, obsolete), { force: true });

const targets = [
  {
    entry: 'runtime/messages.ts',
    out: 'message-runtime.js',
    format: 'iife',
    platform: 'browser',
    external: [],
    globalName: '__AGYCTL_MESSAGE_FORMATTER__',
    alias: {
      '@formatjs/icu-messageformat-parser': '@formatjs/icu-messageformat-parser/no-parser.js',
    },
  },
  {
    entry: 'runtime/host.ts',
    out: 'host-engine.cjs',
    format: 'cjs',
    platform: 'node',
    external: ['electron'],
    alias: {
      '@formatjs/icu-messageformat-parser': '@formatjs/icu-messageformat-parser/no-parser.js',
    },
  },
  {
    entry: 'runtime/preload.ts',
    out: 'preload-bridge.cjs',
    format: 'cjs',
    platform: 'browser',
    external: ['electron'],
  },
  {
    entry: 'runtime/engine.ts',
    out: 'dom-engine.js',
    format: 'iife',
    platform: 'browser',
    external: [],
    globalName: '__AGYCTL_DOM_ENGINE__',
  },
  {
    entry: 'host/feature.ts',
    out: 'feature-provider.mjs',
    format: 'esm',
    platform: 'node',
    external: [],
  },
  {
    entry: 'cli.ts',
    out: 'localization-cli.mjs',
    format: 'esm',
    platform: 'node',
    external: [],
  },
];

for (const target of targets) {
  const entry = path.join(root, target.entry);
  const result = await build({
    absWorkingDir: repoRoot,
    entryPoints: [entry],
    outfile: path.join(outDir, target.out),
    bundle: true,
    format: target.format,
    ...(target.globalName ? { globalName: target.globalName } : {}),
    ...(target.alias ? { alias: target.alias } : {}),
    platform: target.platform,
    external: target.external,
    target: 'es2023',
    sourcemap: false,
    minify: false,
    keepNames: true,
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    // Dependencies are bundled, not shipped as node_modules in the Go runtime.
    if (!input.startsWith('node_modules/')) inputs[input] = digest(path.resolve(repoRoot, input));
  }
  for (const output of Object.keys(result.metafile.outputs))
    outputs[output] = digest(path.resolve(repoRoot, output));
  console.log(`localization bundle: dist/localization/bundle/${target.out}`);
}
inputs['src/localization/esbuild.mjs'] = digest(fileURLToPath(import.meta.url));
inputs['package.json'] = digest(path.join(repoRoot, 'package.json'));
writeFileSync(
  path.join(outDir, 'build-manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, inputs, outputs })}\n`,
);
