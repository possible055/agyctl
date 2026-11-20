import { createHash } from 'node:crypto';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const unixExecutables = new Set([
  'package/dist/bin/darwin-arm64/agyctl',
  'package/dist/bin/linux-amd64/agyctl',
]);

/** Restores Unix executable modes lost when npm packs files on Windows. */
export function portableNpmTarball(archive, expectedFiles) {
  const tar = gunzipSync(archive);
  const found = new Set();
  const names = new Set();
  const verified = new Set();
  let terminated = false;
  for (let offset = 0; offset < tar.length; ) {
    if (offset + 512 > tar.length) throw new Error('Truncated npm tar header');
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (tar.subarray(offset).some((byte) => byte !== 0))
        throw new Error('Unexpected data after npm tar terminator');
      terminated = true;
      break;
    }
    const string = (start, end) => header.toString('utf8', start, end).split('\0')[0];
    const prefix = string(345, 500);
    const name = `${prefix ? `${prefix}/` : ''}${string(0, 100)}`;
    if (
      !name.startsWith('package/') ||
      name.includes('\\') ||
      name.split('/').includes('..') ||
      path.posix.normalize(name) !== name ||
      names.has(name)
    )
      throw new Error(`Unsafe or duplicate npm tar path: ${name}`);
    names.add(name);
    const type = string(156, 157);
    if (!['0', '', '5'].includes(type)) throw new Error(`Unsupported npm tar entry: ${name}`);
    const number = (start, end) => {
      const value = string(start, end).trim();
      if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid npm tar numeric field: ${name}`);
      return Number.parseInt(value, 8);
    };
    const storedChecksum = number(148, 156);
    const checksum = () =>
      header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (storedChecksum !== checksum()) throw new Error(`Invalid npm tar checksum: ${name}`);
    const size = number(124, 136);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(next) || next > tar.length)
      throw new Error(`Truncated npm tar entry: ${name}`);
    if (['0', ''].includes(type)) {
      const relative = name.slice('package/'.length);
      if (!Object.hasOwn(expectedFiles, relative))
        throw new Error(`Unexpected npm tar file: ${name}`);
      const actual = createHash('sha256')
        .update(tar.subarray(offset + 512, offset + 512 + size))
        .digest('hex');
      if (actual !== expectedFiles[relative])
        throw new Error(`Npm tar payload changed while packing: ${name}`);
      verified.add(relative);
    }
    if (unixExecutables.has(name)) {
      if (!['0', ''].includes(type) || size === 0)
        throw new Error(`Invalid Unix executable: ${name}`);
      header.write('0000755\0', 100, 8, 'ascii');
      header.write(`${checksum().toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
      found.add(name);
    }
    offset = next;
  }
  if (!terminated) throw new Error('Npm tar terminator is missing');
  if (verified.size !== Object.keys(expectedFiles).length)
    throw new Error('Npm tarball is missing a verified package file');
  if (found.size !== unixExecutables.size)
    throw new Error('Npm tarball is missing a Unix executable');
  return gzipSync(tar, { level: 9 });
}
