import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { portableNpmTarball } from '../../scripts/lib/npm-package-tar.mjs';

test('portable npm archives preserve payloads, restore Unix modes and reject unsafe members', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-npm-tar-'));
  try {
    const members = [
      'package/dist/bin/linux-amd64/agyctl',
      'package/dist/bin/darwin-arm64/agyctl',
      'package/data.json',
    ];
    for (const member of members) {
      const file = path.join(temporary, member);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `payload: ${member}\n`, { mode: 0o644 });
    }
    const expected = Object.fromEntries(
      members.map((member) => [
        member.slice('package/'.length),
        createHash('sha256').update(`payload: ${member}\n`).digest('hex'),
      ]),
    );
    const archive = path.join(temporary, 'input.tgz');
    execFileSync('tar', ['--format=ustar', '-czf', 'input.tgz', ...members], {
      cwd: temporary,
      windowsHide: true,
    });
    const original = fs.readFileSync(archive);
    const portable = portableNpmTarball(original, expected);
    const output = path.join(temporary, 'portable.tgz');
    fs.writeFileSync(output, portable);
    const listing = execFileSync('tar', ['-tvzf', 'portable.tgz'], {
      cwd: temporary,
      encoding: 'utf8',
      windowsHide: true,
    });
    for (const member of members.slice(0, 2))
      assert.match(listing, new RegExp(`^-rwxr-xr-x .*${member}$`, 'm'));
    const extracted = path.join(temporary, 'extracted');
    fs.mkdirSync(extracted);
    execFileSync('tar', ['-xzf', 'portable.tgz', '-C', 'extracted'], {
      cwd: temporary,
      windowsHide: true,
    });
    for (const member of members)
      assert.equal(fs.readFileSync(path.join(extracted, member), 'utf8'), `payload: ${member}\n`);
    const unsafe = gunzipSync(original);
    unsafe[0] = '/'.charCodeAt(0);
    assert.throws(
      () => portableNpmTarball(gzipSync(unsafe), expected),
      /Unsafe or duplicate npm tar path/,
    );
    const altered = gunzipSync(original);
    altered[512] ^= 1;
    assert.throws(
      () => portableNpmTarball(gzipSync(altered), expected),
      /payload changed while packing/,
    );
    assert.throws(
      () =>
        portableNpmTarball(original, {
          'dist/bin/linux-amd64/agyctl': expected['dist/bin/linux-amd64/agyctl'],
          'dist/bin/darwin-arm64/agyctl': expected['dist/bin/darwin-arm64/agyctl'],
        }),
      /Unexpected npm tar file: package\/data.json/,
    );
    const incomplete = path.join(temporary, 'incomplete.tgz');
    execFileSync('tar', ['--format=ustar', '-czf', 'incomplete.tgz', members[0]], {
      cwd: temporary,
      windowsHide: true,
    });
    assert.throws(
      () =>
        portableNpmTarball(fs.readFileSync(incomplete), {
          'dist/bin/linux-amd64/agyctl': expected['dist/bin/linux-amd64/agyctl'],
        }),
      /missing a Unix executable/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
