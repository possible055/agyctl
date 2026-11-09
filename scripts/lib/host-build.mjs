import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
let composer;
let composerHash;

export function verifyHostBuild() {
  const rebuild = 'Run `npm run host:build` before using the Host tools';
  const manifestPath = path.join(root, 'dist', 'host', 'bundle', 'build-manifest.json');
  if (!fs.existsSync(manifestPath))
    throw new Error(`The Host build manifest is missing. ${rebuild}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !manifest.inputs || !manifest.outputs)
    throw new Error(`The Host build manifest is invalid. ${rebuild}`);
  for (const [relative, expected] of Object.entries({ ...manifest.inputs, ...manifest.outputs })) {
    const file = path.resolve(root, relative);
    if (
      !file.startsWith(`${root}${path.sep}`) ||
      !fs.existsSync(file) ||
      createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected
    )
      throw new Error(`The Host build is stale or incomplete (${relative}). ${rebuild}`);
  }
  return manifest;
}

export function loadHostComposer() {
  const manifest = verifyHostBuild();
  const hash = manifest.outputs['dist/host/bundle/host-composer.mjs'];
  if (composer && composerHash !== hash)
    throw new Error(
      'The Host Composer was rebuilt during this process; start a fresh command before reading or changing Host state',
    );
  if (!composer) {
    composer = require('../../dist/host/bundle/host-composer.mjs');
    composerHash = hash;
  }
  return composer;
}

let capsuleFeatureModule;
let capsuleFeatureHash;

export function loadCapsuleFeature() {
  const manifest = verifyHostBuild();
  const hash = manifest.outputs['dist/host/bundle/capsule-feature.mjs'];
  if (capsuleFeatureModule && capsuleFeatureHash !== hash)
    throw new Error(
      'The Host bundle was rebuilt during this process; start a fresh command before reading or changing Host state',
    );
  if (!capsuleFeatureModule) {
    capsuleFeatureModule = require('../../dist/host/bundle/capsule-feature.mjs');
    capsuleFeatureHash = hash;
  }
  return capsuleFeatureModule;
}

let servedBundleModule;
let servedBundleHash;

export function loadCapsuleServedBundle() {
  const manifest = verifyHostBuild();
  const hash = manifest.outputs['dist/host/bundle/capsule-served-bundle.mjs'];
  if (servedBundleModule && servedBundleHash !== hash)
    throw new Error(
      'The Host bundle was rebuilt during this process; start a fresh command before reading or changing Host state',
    );
  if (!servedBundleModule) {
    servedBundleModule = require('../../dist/host/bundle/capsule-served-bundle.mjs');
    servedBundleHash = hash;
  }
  return servedBundleModule;
}
