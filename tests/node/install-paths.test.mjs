import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectedClientTarget } from '../../scripts/lib/install-paths.mjs';

test('client bytes admit only the three supported format and architecture pairs', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-install-paths-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'client-binary');
  const pe = Buffer.alloc(128);
  pe.write('MZ');
  pe.writeUInt32LE(64, 60);
  pe.write('PE\0\0', 64);
  pe.writeUInt16LE(0x8664, 68);
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(62, 18);
  const macho = Buffer.alloc(64);
  macho.writeUInt32LE(0xfeedfacf);
  macho.writeUInt32LE(0x0100000c, 4);
  for (const [bytes, id] of [
    [pe, 'windows/amd64'],
    [elf, 'linux/amd64'],
    [macho, 'darwin/arm64'],
  ]) {
    fs.writeFileSync(filename, bytes);
    assert.equal(inspectedClientTarget(filename).id, id);
  }
  pe.writeUInt16LE(0xaa64, 68);
  elf.writeUInt16LE(183, 18);
  macho.writeUInt32LE(0x01000007, 4);
  for (const bytes of [pe, elf, macho]) {
    fs.writeFileSync(filename, bytes);
    assert.throws(() => inspectedClientTarget(filename), /Unsupported client executable/);
  }
  const universal = Buffer.alloc(160);
  universal.writeUInt32BE(0xcafebabe);
  universal.writeUInt32BE(1, 4);
  universal.writeUInt32BE(0x0100000c, 8);
  universal.writeUInt32BE(96, 16);
  universal.writeUInt32BE(64, 20);
  macho.writeUInt32LE(0x0100000c, 4);
  macho.copy(universal, 96);
  fs.writeFileSync(filename, universal);
  assert.equal(inspectedClientTarget(filename).id, 'darwin/arm64');
  universal.writeUInt32BE(160, 16);
  fs.writeFileSync(filename, universal);
  assert.throws(() => inspectedClientTarget(filename), /Invalid ARM64 Mach-O slice bounds/);
});
