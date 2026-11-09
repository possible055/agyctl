import fs from 'node:fs';
import path from 'node:path';
import { capsuleAnchorTokens } from '../../../scripts/lib/capsule-anchors.mjs';
import { languageServerPath } from '../../../scripts/lib/install-paths.mjs';

/**
 * Builds a Language Server stand-in: a platform executable header, optional
 * trailing bytes, then a stored (uncompressed) ZIP of `entries` as the
 * client embeds its web assets.
 * @param {[string, string][]} entries
 * @param {{ prefix?: Buffer }} [options]
 */
export function syntheticLanguageServer(entries, { prefix = Buffer.alloc(0) } = {}) {
  const header = Buffer.alloc(128);
  if (process.platform === 'win32') {
    header.write('MZ');
    header.writeUInt32LE(64, 60);
    header.write('PE\0\0', 64);
    header.writeUInt16LE(0x8664, 68);
  } else if (process.platform === 'darwin') {
    header.writeUInt32LE(0xfeedfacf);
    header.writeUInt32LE(0x0100000c, 4);
  } else {
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    header.writeUInt16LE(62, 18);
  }
  const lead = Buffer.concat([header, prefix]);
  const local = [];
  const central = [];
  let offset = lead.length;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const data = Buffer.from(value);
    let crc = -1;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    crc = (crc ^ -1) >>> 0;
    const localHeader = Buffer.alloc(30 + filename.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(filename.length, 26);
    filename.copy(localHeader, 30);
    local.push(localHeader, data);
    const record = Buffer.alloc(46 + filename.length);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt32LE(offset, 42);
    filename.copy(record, 46);
    central.push(record);
    offset += localHeader.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([lead, ...local, directory, end]);
}

/** A web bundle that carries every anchor token the capsule mounts on. */
export function anchoredMain() {
  return `/* ${capsuleAnchorTokens().join(' ')} */`;
}

/** Writes a Language Server whose served bundle satisfies the capsule anchor gate. */
export function writeServedLanguageServer(asarPath, mainJs = anchoredMain()) {
  const binaryPath = languageServerPath(asarPath);
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
  fs.writeFileSync(binaryPath, syntheticLanguageServer([['main.js', mainJs]]));
  return binaryPath;
}
