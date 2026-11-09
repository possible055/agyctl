'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function safePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      value.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Unsafe ASAR path: ${value}`);
  }
  return value;
}

function readExact(fd, size, position) {
  const buffer = Buffer.alloc(size);
  let read = 0;
  while (read < size) {
    const count = fs.readSync(fd, buffer, read, size - read, position + read);
    if (!count) throw new Error('Truncated ASAR archive');
    read += count;
  }
  return buffer;
}

function readHeader(archivePath) {
  const fd = fs.openSync(archivePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const prefix = readExact(fd, 16, 0);
    const jsonSize = prefix.readUInt32LE(12);
    const alignedSize = jsonSize + (4 - jsonSize % 4) % 4;
    if (prefix.readUInt32LE(0) !== 4 || prefix.readUInt32LE(4) !== alignedSize + 8 ||
        prefix.readUInt32LE(8) !== alignedSize + 4 || jsonSize > 64 * 1024 * 1024 ||
        16 + alignedSize > size) throw new Error('Invalid ASAR header');
    const header = JSON.parse(readExact(fd, jsonSize, 16).toString('utf8'));
    if (!header || typeof header.files !== 'object' || Array.isArray(header.files) || !header.files) {
      throw new Error('Invalid ASAR file tree');
    }
    return { header, baseOffset: 16 + alignedSize, size };
  } finally {
    fs.closeSync(fd);
  }
}

function getNode(header, relPath, followLinks = true, depth = 0) {
  if (depth > 40) throw new Error(`Cyclic ASAR link: ${relPath}`);
  const parts = safePath(relPath).split('/');
  let node = header;
  for (let index = 0; index < parts.length; index += 1) {
    if (!node.files || !Object.hasOwn(node.files, parts[index])) throw new Error(`File not found in ASAR: ${relPath}`);
    node = node.files[parts[index]];
    if (node.link !== undefined && (followLinks || index < parts.length - 1)) {
      return getNode(header, [safePath(node.link), ...parts.slice(index + 1)].join('/'), followLinks, depth + 1);
    }
  }
  return node;
}

function entries(header) {
  const result = [];
  const walk = (tree, prefix) => {
    if (!tree.files || typeof tree.files !== 'object' || Array.isArray(tree.files)) throw new Error('Invalid ASAR directory');
    for (const [name, node] of Object.entries(tree.files)) {
      safePath(name);
      if (name.includes('/') || !node || typeof node !== 'object' || Array.isArray(node)) throw new Error(`Invalid ASAR entry: ${name}`);
      const relative = prefix ? `${prefix}/${name}` : name;
      result.push([relative, node]);
      if (node.files !== undefined) {
        if (node.link !== undefined || node.size !== undefined) throw new Error(`Invalid ASAR directory: ${relative}`);
        walk(node, relative);
      }
    }
  };
  walk(header, '');
  return result;
}

function fileBuffer(archivePath, relative, node, baseOffset) {
  if (node.files || node.link !== undefined) throw new Error(`Not an ASAR file: ${relative}`);
  if (node.unpacked) {
    const unpackedPath = path.join(archivePath + '.unpacked', relative);
    if (!fs.lstatSync(unpackedPath).isFile()) throw new Error(`Invalid unpacked ASAR file: ${relative}`);
    return fs.readFileSync(unpackedPath);
  }
  const fd = fs.openSync(archivePath, 'r');
  try {
    return readExact(fd, node.size, baseOffset + Number(node.offset));
  } finally {
    fs.closeSync(fd);
  }
}

function integrity(buffer, blockSize = 4 * 1024 * 1024) {
  const hash = data => crypto.createHash('sha256').update(data).digest('hex');
  const blocks = [];
  for (let offset = 0; offset < buffer.length; offset += blockSize) blocks.push(hash(buffer.subarray(offset, offset + blockSize)));
  if (!blocks.length) blocks.push(hash(Buffer.alloc(0)));
  return { algorithm: 'SHA256', hash: hash(buffer), blockSize, blocks };
}

function validateArchive(archivePath) {
  const metadata = readHeader(archivePath);
  for (const [relative, node] of entries(metadata.header)) {
    if (node.link !== undefined) {
      safePath(node.link);
      getNode(metadata.header, relative);
      continue;
    }
    if (node.files) continue;
    if (!Number.isSafeInteger(node.size) || node.size < 0) throw new Error(`Invalid ASAR size: ${relative}`);
    if (!node.unpacked && (typeof node.offset !== 'string' || !/^\d+$/.test(node.offset) ||
        !Number.isSafeInteger(Number(node.offset)) || Number(node.offset) + node.size > metadata.size - metadata.baseOffset)) {
      throw new Error(`Invalid ASAR offset: ${relative}`);
    }
    let buffer;
    try {
      buffer = fileBuffer(archivePath, relative, node, metadata.baseOffset);
    } catch (error) {
      throw new Error(`Incomplete ASAR file ${relative}: ${error.message}`, { cause: error });
    }
    if (buffer.length !== node.size) throw new Error(`ASAR size mismatch: ${relative}`);
    if (node.integrity) {
      const expected = node.integrity;
      if (expected.algorithm !== 'SHA256' || !Number.isSafeInteger(expected.blockSize) || expected.blockSize <= 0 ||
          !Array.isArray(expected.blocks)) throw new Error(`Unsupported ASAR integrity: ${relative}`);
      const actual = integrity(buffer, expected.blockSize);
      const emptyBlocks = !buffer.length && expected.blocks.length === 0;
      if (actual.hash !== expected.hash || (!emptyBlocks && JSON.stringify(actual.blocks) !== JSON.stringify(expected.blocks))) {
        throw new Error(`ASAR integrity mismatch: ${relative}`);
      }
    }
  }
  return metadata;
}

function writeArchive(header, chunks, destination) {
  const json = Buffer.from(JSON.stringify(header));
  const padding = (4 - json.length % 4) % 4;
  const prefix = Buffer.alloc(16 + json.length + padding);
  prefix.writeUInt32LE(4, 0);
  prefix.writeUInt32LE(json.length + padding + 8, 4);
  prefix.writeUInt32LE(json.length + padding + 4, 8);
  prefix.writeUInt32LE(json.length, 12);
  json.copy(prefix, 16);
  const fd = fs.openSync(destination, 'wx');
  try {
    for (const buffer of [prefix, ...chunks]) {
      let written = 0;
      while (written < buffer.length) written += fs.writeSync(fd, buffer, written, buffer.length - written);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function copyUnpacked(source, destination) {
  if (!fs.existsSync(source + '.unpacked')) return;
  const walk = (from, to) => {
    if (!fs.lstatSync(from).isDirectory()) throw new Error(`Unsupported unpacked ASAR directory: ${from}`);
    fs.mkdirSync(to, { recursive: true });
    for (const item of fs.readdirSync(from, { withFileTypes: true })) {
      if (item.isDirectory()) walk(path.join(from, item.name), path.join(to, item.name));
      else if (item.isFile()) fs.copyFileSync(path.join(from, item.name), path.join(to, item.name), fs.constants.COPYFILE_EXCL);
      else throw new Error(`Unsupported unpacked ASAR entry: ${item.name}`);
    }
  };
  walk(source + '.unpacked', destination + '.unpacked');
}

function patchArchive(source, destination, replacements) {
  const { header, baseOffset } = validateArchive(source);
  const modified = new Set();
  for (const [relative, value] of Object.entries(replacements)) {
    safePath(relative);
    const parts = relative.split('/');
    let parent = header;
    for (const part of parts.slice(0, -1)) {
      if (!Object.hasOwn(parent.files, part)) parent.files[part] = { files: {} };
      parent = parent.files[part];
      if (!parent.files || parent.unpacked) throw new Error(`Cannot patch an unpacked or linked ASAR directory: ${relative}`);
    }
    const name = parts.at(-1);
    const previous = Object.hasOwn(parent.files, name) ? parent.files[name] : {};
    if (previous.unpacked || previous.files || previous.link !== undefined) throw new Error(`Cannot patch an unpacked or linked ASAR file: ${relative}`);
    const buffer = Buffer.from(value);
    parent.files[name] = { ...previous, size: buffer.length, integrity: integrity(buffer) };
    modified.add(relative);
  }
  const chunks = [];
  let offset = 0;
  for (const [relative, node] of entries(header)) {
    if (node.files || node.link !== undefined || node.unpacked) continue;
    const buffer = modified.has(relative) ? Buffer.from(replacements[relative]) : fileBuffer(source, relative, node, baseOffset);
    node.offset = String(offset);
    offset += buffer.length;
    chunks.push(buffer);
  }
  copyUnpacked(source, destination);
  writeArchive(header, chunks, destination);
  validateArchive(destination);
}

const builtinAsar = {
  validateArchive,
  patchArchive,
  copyUnpacked,
  extractFile(archivePath, relative) {
    const { header, baseOffset } = readHeader(archivePath);
    const node = getNode(header, relative);
    const resolved = entries(header).find(([, candidate]) => candidate === node)?.[0];
    if (!resolved) throw new Error(`File not found in ASAR: ${relative}`);
    return fileBuffer(archivePath, resolved, node, baseOffset);
  },
  statFile(archivePath, relative) {
    return getNode(readHeader(archivePath).header, relative, false);
  },
  listPackage(archivePath) {
    return entries(readHeader(archivePath).header).map(([relative]) => '/' + relative);
  },
  extractAll(archivePath, destination) {
    const { header, baseOffset } = validateArchive(archivePath);
    const files = entries(header);
    if (files.some(([, node]) => node.link !== undefined)) throw new Error('Extracting ASAR symbolic links is unsupported; use patchArchive to preserve them');
    fs.mkdirSync(destination, { recursive: true });
    for (const [relative, node] of files) {
      const target = path.join(destination, relative);
      if (node.files) fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, fileBuffer(archivePath, relative, node, baseOffset));
        if (node.executable) fs.chmodSync(target, 0o755);
      }
    }
  },
  async createPackageWithOptions(source, destination, options = {}) {
    const unsupported = Object.keys(options).filter(key => key !== 'unpackedPaths');
    if (unsupported.length) throw new Error(`Unsupported ASAR packing options: ${unsupported.join(', ')}; use exact unpackedPaths or patchArchive`);
    const unpacked = new Set((options.unpackedPaths || []).map(safePath));
    const chunks = [];
    let offset = 0;
    const walk = (directory, prefix, inheritedUnpacked = false) => {
      const files = Object.create(null);
      for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        safePath(item.name);
        const relative = prefix ? `${prefix}/${item.name}` : item.name;
        const absolute = path.join(directory, item.name);
        const isUnpacked = inheritedUnpacked || unpacked.has(relative);
        if (item.isDirectory()) {
          files[item.name] = { files: walk(absolute, relative, isUnpacked), ...(isUnpacked ? { unpacked: true } : {}) };
        } else if (item.isFile()) {
          const buffer = fs.readFileSync(absolute);
          const node = { size: buffer.length, integrity: integrity(buffer) };
          if (fs.statSync(absolute).mode & 0o100) node.executable = true;
          if (isUnpacked) {
            node.unpacked = true;
            const target = path.join(destination + '.unpacked', relative);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(absolute, target, fs.constants.COPYFILE_EXCL);
          } else {
            node.offset = String(offset);
            offset += buffer.length;
            chunks.push(buffer);
          }
          files[item.name] = node;
        } else throw new Error(`Packing symbolic links and special files is unsupported: ${relative}`);
      }
      return files;
    };
    writeArchive({ files: walk(source, '') }, chunks, destination);
    validateArchive(destination);
  },
};

function loadAsarEngine() {
  return builtinAsar;
}

module.exports = { loadAsarEngine, builtinAsar };
