import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '..', '..');
const outDir = path.join(repoRoot, 'dist', 'host', 'bundle');
const inputs = {};
const outputs = {};
const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
mkdirSync(outDir, { recursive: true });

const targets = [
  { entry: 'index.ts', out: 'host-composer.mjs', format: 'esm', platform: 'node', external: [] },
  {
    entry: 'logging.ts',
    out: 'tooling-logging.mjs',
    format: 'esm',
    platform: 'node',
    external: [],
  },
  // The capsule feature is bundled separately so the neutral Host bundle does
  // not embed feature code. This mirrors the localization feature-provider
  // bundle, which also carries its own copy of contracts.js.
  {
    entry: '../capsule/host-feature.ts',
    out: 'capsule-feature.mjs',
    format: 'esm',
    platform: 'node',
    external: [],
  },
  {
    entry: '../capsule/served-bundle.ts',
    out: 'capsule-served-bundle.mjs',
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
    platform: target.platform,
    external: target.external,
    alias: target.alias,
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
  console.log(`host bundle: dist/host/bundle/${target.out}`);
}
inputs['src/host/esbuild.mjs'] = digest(fileURLToPath(import.meta.url));
inputs['package.json'] = digest(path.join(repoRoot, 'package.json'));
writeFileSync(
  path.join(outDir, 'build-manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, inputs, outputs })}\n`,
);
