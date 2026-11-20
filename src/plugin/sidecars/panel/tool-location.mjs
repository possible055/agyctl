import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = fileURLToPath(new URL('../../', import.meta.url));
/** @type {Record<string, string>} */
const targets = {
  'win32-x64': 'windows-amd64/agyctl.exe',
  'linux-x64': 'linux-amd64/agyctl',
  'darwin-arm64': 'darwin-arm64/agyctl',
};

export async function readToolLocation() {
  let locator;
  try {
    locator = JSON.parse(await fs.readFile(path.join(pluginRoot, 'agyctl-tools.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    locator = { repositoryRoot: path.resolve(pluginRoot, '../..') };
    if (path.resolve(locator.repositoryRoot, 'src/plugin') !== path.resolve(pluginRoot))
      throw new Error('Tool locator missing; reinstall the panel with agyctl install');
  }
  if (
    !locator ||
    typeof locator.repositoryRoot !== 'string' ||
    !path.isAbsolute(locator.repositoryRoot)
  )
    throw new Error('Invalid tool package locator; reinstall the panel');
  const root = await fs.realpath(locator.repositoryRoot);
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  if (metadata.name !== 'agyctl' || metadata.type !== 'module')
    throw new Error('Tool package identity mismatch');
  let nodeExecutable = process.execPath;
  if (locator.nodeExecutable !== undefined) {
    if (typeof locator.nodeExecutable !== 'string' || !path.isAbsolute(locator.nodeExecutable))
      throw new Error('Invalid saved Node.js executable; reinstall the panel');
    nodeExecutable = await fs.realpath(locator.nodeExecutable);
    if (!(await fs.stat(nodeExecutable)).isFile())
      throw new Error('Saved Node.js executable is not a regular file');
  }
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error('Unsupported native tool target');
  const env = { ...process.env };
  for (const key of ['AGYCTL_APP_DIR', 'AGYCTL_HOME']) {
    if (locator[key] !== undefined) {
      if (typeof locator[key] !== 'string' || !path.isAbsolute(locator[key]))
        throw new Error(`Invalid saved ${key}`);
      if (env[key] === undefined) env[key] = locator[key];
    }
  }
  return { root, executable: path.join(root, 'dist', 'bin', target), nodeExecutable, env };
}
