import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { inspectedClientTarget, installationPaths, supportedTarget } from './install-paths.mjs';

const require = createRequire(import.meta.url);
const { builtinAsar: asar } = require('../vendor/asar-engine.cjs');
const products = {
  antigravity: { product: 'antigravity', name: 'Antigravity' },
  'antigravity-insiders': { product: 'insiders', name: 'Antigravity - Insiders' },
};

function samePath(first, second) {
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function regularFile(filename) {
  if (!fs.lstatSync(filename).isFile())
    throw new Error(`Expected a regular file, not a link or directory: ${filename}`);
  const canonical = fs.realpathSync(filename);
  if (!samePath(canonical, path.resolve(filename)))
    throw new Error(`Installation paths must not redirect through links: ${filename}`);
  return canonical;
}

export function inspectTarget(asarPath, { requireFiles = true } = {}) {
  if (typeof asarPath !== 'string' || !path.isAbsolute(asarPath))
    throw new Error('Select an absolute app.asar path');
  const archive = regularFile(asarPath);
  if (
    path.basename(archive) !== 'app.asar' ||
    path.basename(path.dirname(archive)).toLowerCase() !== 'resources'
  ) {
    throw new Error('The selected file must be the installed resources/app.asar');
  }
  asar.validateArchive(archive);
  const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'));
  const identity = Object.hasOwn(products, pkg.name) ? products[pkg.name] : null;
  if (
    !identity ||
    pkg.productName !== identity.name ||
    typeof pkg.version !== 'string' ||
    !pkg.version
  ) {
    throw new Error('The selected archive has no recognized Antigravity package identity');
  }
  const {
    root: installDir,
    binaryPath,
    executablePath,
  } = installationPaths(path.dirname(archive), identity.product);
  if (requireFiles) {
    regularFile(binaryPath);
    regularFile(executablePath);
  }
  return {
    asarPath: archive,
    binaryPath,
    executablePath,
    installDir,
    product: identity.product,
    version: pkg.version,
  };
}

export function inspectHostTarget(asarPath) {
  const target = inspectTarget(asarPath);
  const clientTarget = inspectedClientTarget(target.binaryPath);
  if (clientTarget.id !== supportedTarget().id)
    throw new Error(`The selected client target ${clientTarget.id} cannot be managed on this host`);
  return target;
}
