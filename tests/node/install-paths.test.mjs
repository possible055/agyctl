import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { inspectedClientTarget } from '../../scripts/lib/install-paths.mjs';

test('automatic ASAR selection refuses multiple installations with an explicit-target remedy', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-install-selection-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'scripts/lib'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'compat'));
  fs.copyFileSync(
    'scripts/lib/install-paths.mjs',
    path.join(directory, 'scripts/lib/install-paths.mjs'),
  );
  const layout = JSON.parse(fs.readFileSync('compat/install-layout.json', 'utf8'));
  for (const [index, channel] of layout.platforms[process.platform].channels.entries()) {
    channel.root = path.join(directory, `installation-${index}`);
    const archive = path.join(
      channel.root,
      layout.platforms[process.platform].resources,
      'app.asar',
    );
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, 'discovery does not execute or parse archives');
  }
  fs.writeFileSync(path.join(directory, 'compat/install-layout.json'), JSON.stringify(layout));
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const { findAsarPath } = await import(${JSON.stringify(pathToFileURL(path.join(directory, 'scripts/lib/install-paths.mjs')).href)});
    assert.throws(() => findAsarPath(), /Multiple.*host-patch.*--asar/);
  `,
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => key !== 'AGYCTL_APP_DIR'),
      ),
    },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('AGYCTL_APP_DIR selects one complete installation and refuses invalid roots without fallback', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-app-dir-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const modulePath = path.join(directory, 'scripts/lib/install-paths.mjs');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.copyFileSync('scripts/lib/install-paths.mjs', modulePath);
  fs.mkdirSync(path.join(directory, 'compat'));
  const layout = JSON.parse(fs.readFileSync('compat/install-layout.json', 'utf8'));
  const platform = layout.platforms[process.platform];
  const createInstallation = (root, channel, complete = true) => {
    const files = [path.join(platform.resources, 'app.asar')];
    if (complete) {
      files.push(path.join(platform.resources, 'bin', platform.language_server));
      files.push(channel.executable);
    }
    for (const file of files) {
      const filename = path.join(root, file);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, 'installation data is never executed');
    }
  };
  for (const [index, channel] of platform.channels.entries()) {
    channel.root = path.join(directory, `default-${index}`);
    createInstallation(channel.root, channel);
  }
  fs.writeFileSync(path.join(directory, 'compat/install-layout.json'), JSON.stringify(layout));
  const run = (appDir, assertion) => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';
         const { installedTargets, findAsarPath } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
         ${assertion}`,
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, AGYCTL_APP_DIR: appDir },
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  for (const [index, channel] of platform.channels.entries()) {
    const selected = path.join(directory, `unrelated-portable-${index}`);
    createInstallation(selected, channel);
    run(
      selected,
      `const targets = installedTargets();
       assert.equal(targets.length, 1);
       assert.equal(targets[0].root, ${JSON.stringify(selected)});
       assert.equal(targets[0].product, ${JSON.stringify(channel.channel)});
       assert.equal(findAsarPath(), targets[0].asarPath);
       assert.equal(installedTargets({ ignoreAppDir: true }).length, 2);`,
    );
  }
  const incomplete = path.join(directory, 'incomplete');
  createInstallation(incomplete, platform.channels[0], false);
  const ambiguous = path.join(directory, 'ambiguous');
  for (const channel of platform.channels) createInstallation(ambiguous, channel);
  const invalid = [
    ['', 'absolute'],
    ['relative-installation', 'absolute'],
    [path.join(directory, 'missing'), 'ENOENT'],
    [incomplete, 'ENOENT'],
    [ambiguous, 'ambiguous'],
  ];
  for (const [name, reason] of [
    [path.join(platform.resources, 'app.asar'), 'ENOENT'],
    [platform.channels[0].executable, 'Missing or ambiguous'],
  ]) {
    const selected = path.join(directory, `missing-${path.basename(name)}`);
    createInstallation(selected, platform.channels[0]);
    fs.unlinkSync(path.join(selected, name));
    invalid.push([selected, reason]);
  }
  for (const [appDir, reason] of invalid) {
    run(
      appDir,
      `assert.throws(() => installedTargets(), /AGYCTL_APP_DIR.*${reason}/);
       assert.throws(() => findAsarPath(), /AGYCTL_APP_DIR/);
       assert.equal(installedTargets({ ignoreAppDir: true }).length, 2);`,
    );
  }
});

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
