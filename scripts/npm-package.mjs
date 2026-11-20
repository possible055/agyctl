import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assembleCapsule } from './capsule-build.mjs';
import { verifyHostBuild } from './lib/host-build.mjs';
import { installLayout } from './lib/install-paths.mjs';
import { verifyLocalizationBuild } from './lib/localization-build.mjs';
import { portableNpmTarball } from './lib/npm-package-tar.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifestFile = 'dist/npm-package-manifest.json';
const targetIds = ['darwin/arm64', 'linux/amd64', 'windows/amd64'];
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} ${args.join(' ')} failed:\n${result.stderr ?? ''}${result.stdout ?? ''}`,
    );
  return result.stdout;
}

function npm(args, options) {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  const cli = candidates.find((file) => file && fs.existsSync(file));
  if (!cli) throw new Error('Cannot locate npm-cli.js; run this command with npm run');
  return run(process.execPath, [cli, ...args], options);
}

function packageFiles(directory) {
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (metadata.name !== 'agyctl' || metadata.bin?.agyctl !== 'bin/agyctl.mjs')
    throw new Error('Unexpected npm package identity or CLI entry');
  const files = new Set(['package.json']);
  for (const pattern of metadata.files) {
    const matches = [...fs.globSync(pattern, { cwd: directory })];
    if (matches.length === 0 && pattern !== manifestFile)
      throw new Error(`Package input is missing: ${pattern}`);
    for (const relative of matches) {
      const normalized = relative.split(path.sep).join('/');
      if (
        normalized.split('/').some((segment) => segment.startsWith('.')) ||
        /^(var|knowledge|tests|vendor-src|node_modules|src\/agyctl)\//.test(normalized) ||
        /(^|\/)(AGENTS\.md|.*\.(pem|key|p12|pfx)|.*\.orig(?:\..*)?)$/i.test(normalized)
      )
        throw new Error(`Forbidden npm package path: ${normalized}`);
      if (!fs.lstatSync(path.join(directory, relative)).isFile())
        throw new Error(`Package input is not a regular file: ${normalized}`);
      if (normalized !== manifestFile) files.add(normalized);
    }
  }
  return { metadata, files: [...files].sort() };
}

function nativePaths(directory) {
  const layout = JSON.parse(
    fs.readFileSync(path.join(directory, 'compat/install-layout.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(layout.targets).sort(), targetIds, 'Unexpected supported targets');
  return Object.fromEntries(
    targetIds.map((id) => [
      id,
      `dist/bin/${id.replace('/', '-')}/agyctl${id.startsWith('windows/') ? '.exe' : ''}`,
    ]),
  );
}

function verifyNative(directory, targets) {
  for (const [id, relative] of Object.entries(targets)) {
    const bytes = fs.readFileSync(path.join(directory, relative));
    let valid = false;
    if (id === 'windows/amd64' && bytes.length > 64 && bytes.toString('ascii', 0, 2) === 'MZ') {
      const pe = bytes.readUInt32LE(60);
      valid =
        pe + 6 <= bytes.length &&
        bytes.readUInt32LE(pe) === 0x4550 &&
        bytes.readUInt16LE(pe + 4) === 0x8664;
    } else if (id === 'linux/amd64' && bytes.length > 20) {
      valid =
        bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) &&
        bytes.readUInt16LE(18) === 62;
    } else if (id === 'darwin/arm64' && bytes.length > 8) {
      valid = bytes.readUInt32LE(0) === 0xfeedfacf && bytes.readUInt32LE(4) === 0x100000c;
    }
    if (!valid) throw new Error(`Invalid prebuilt executable for ${id}: ${relative}`);
  }
}

function verifyBuilds() {
  const files = new Set(packageFiles(root).files);
  for (const manifest of [verifyHostBuild(), verifyLocalizationBuild()]) {
    for (const relative of Object.keys({ ...manifest.inputs, ...manifest.outputs })) {
      if (!files.has(relative))
        throw new Error(`Build manifest input is not packaged: ${relative}`);
    }
  }
  assert.equal(
    fs.readFileSync(path.join(root, 'dist/capsule/input-capsule.js'), 'utf8'),
    assembleCapsule(),
    'Capsule bundle is stale; run npm run capsule:build',
  );
}

export function verifyNpmPackage(directory = root) {
  const { metadata, files } = packageFiles(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, manifestFile), 'utf8'));
  assert.equal(manifest.schemaVersion, 1, 'Invalid npm package manifest schema');
  assert.equal(manifest.packageVersion, metadata.version, 'Stale npm package version');
  assert.deepEqual(manifest.targets, nativePaths(directory), 'Stale npm package targets');
  assert.deepEqual(Object.keys(manifest.files).sort(), files, 'Npm package file set changed');
  for (const relative of files) {
    if (manifest.files[relative] !== digest(path.join(directory, relative)))
      throw new Error(`Npm package is stale or incomplete: ${relative}; run npm run package:build`);
  }
  verifyNative(directory, manifest.targets);
  return manifest;
}

function verifyPacklist() {
  const manifest = verifyNpmPackage();
  verifyBuilds();
  const [packed] = Object.values(
    JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'])),
  );
  assert.deepEqual(
    packed.files.map((file) => file.path).sort(),
    [...Object.keys(manifest.files), manifestFile].sort(),
    'Npm tarball differs from the verified allowlist',
  );
  console.log(`Verified agyctl@${manifest.packageVersion}: ${packed.files.length} packaged files`);
  return manifest;
}

function buildPackage() {
  for (const script of [
    'src/host/esbuild.mjs',
    'scripts/capsule-build.mjs',
    'src/localization/esbuild.mjs',
  ])
    run(process.execPath, [script], { stdio: 'inherit' });
  for (const id of targetIds) {
    const target = installLayout().targets[id];
    run(process.execPath, ['scripts/tools-build.mjs'], {
      env: { ...process.env, GOOS: target.goos, GOARCH: target.goarch, CGO_ENABLED: '0' },
      stdio: 'inherit',
    });
  }
  verifyBuilds();
  const { metadata, files } = packageFiles(root);
  const targets = nativePaths(root);
  verifyNative(root, targets);
  if (process.platform !== 'win32') {
    for (const [id, relative] of Object.entries(targets))
      if (!id.startsWith('windows/')) fs.chmodSync(path.join(root, relative), 0o755);
  }
  fs.writeFileSync(
    path.join(root, manifestFile),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packageVersion: metadata.version,
        targets,
        files: Object.fromEntries(
          files.map((relative) => [relative, digest(path.join(root, relative))]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  verifyPacklist();
}

function smokePackage(tarball) {
  if (!tarball)
    throw new Error('Usage: npm run package:smoke -- /absolute/path/agyctl-VERSION.tgz');
  const archive = path.resolve(tarball);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-npm-smoke-'));
  try {
    const prefix = path.join(temporary, 'prefix');
    npm(
      [
        'install',
        '--global',
        '--prefix',
        prefix,
        '--ignore-scripts',
        '--omit=dev',
        '--offline',
        '--no-audit',
        '--no-fund',
        archive,
      ],
      { cwd: temporary },
    );
    const installed = path.join(
      prefix,
      process.platform === 'win32' ? 'node_modules' : 'lib/node_modules',
      'agyctl',
    );
    const metadata = verifyNpmPackage(installed);
    assert.equal(
      fs.existsSync(path.join(installed, 'node_modules')),
      false,
      'Runtime dependencies were installed',
    );
    const env = {
      ...process.env,
      PATH: path.join(temporary, 'no-compilers'),
      AGYCTL_HOME: path.join(temporary, 'state'),
    };
    for (const key of Object.keys(env))
      if (key.toLowerCase() === 'path' && key !== 'PATH') delete env[key];
    const cli = path.join(installed, 'bin/agyctl.mjs');
    const invoke = (args) => run(process.execPath, [cli, ...args], { cwd: temporary, env });
    assert.match(invoke(['--help']), /agyctl/);
    assert.equal(invoke(['--version']).trim(), metadata.packageVersion);
    const versions = JSON.parse(invoke(['limit', 'versions', '--json']));
    const registry = JSON.parse(
      fs.readFileSync(path.join(installed, 'compat/versions.json'), 'utf8'),
    );
    assert.deepEqual(
      versions.entries.map((entry) => entry.id).sort(),
      registry.entries.map((entry) => entry.id).sort(),
    );
    run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const base = ${JSON.stringify(pathToFileURL(`${installed}${path.sep}`).href)};
      const host = await import(new URL('scripts/lib/host-build.mjs', base));
      host.verifyHostBuild(); host.loadHostComposer(); host.loadCapsuleFeature();
      const localization = await import(new URL('scripts/lib/localization-build.mjs', base));
      localization.verifyLocalizationBuild();
      const capsule = await import(new URL('scripts/capsule-build.mjs', base));
      capsule.assembleCapsule();
    `,
      ],
      { cwd: temporary, env },
    );
    const refused = spawnSync(
      process.execPath,
      [
        cli,
        'install',
        '--panel',
        '--asar',
        path.join(temporary, 'missing', 'app.asar'),
        '--dry-run',
        '--json',
      ],
      { cwd: temporary, env, encoding: 'utf8', windowsHide: true },
    );
    if (refused.error) throw refused.error;
    assert.equal(refused.status, 1, 'An invalid target did not produce a normal refusal');
    assert.match(
      `${refused.stdout}${refused.stderr}`,
      /missing|not found|does not exist|ENOENT|invalid/i,
    );
    console.log(
      `Installed tarball smoke passed outside checkout without compilers: agyctl@${metadata.packageVersion}`,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function packPackage(args) {
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--pack-destination'))
    throw new Error('Usage: npm run package:pack -- [--pack-destination DIRECTORY]');
  const manifest = verifyPacklist();
  const expectedFiles = {
    ...manifest.files,
    [manifestFile]: digest(path.join(root, manifestFile)),
  };
  const directory = args.length ? path.resolve(args[1]) : root;
  fs.mkdirSync(directory, { recursive: true });
  const [packed] = Object.values(
    JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', directory])),
  );
  const archive = path.join(directory, packed.filename);
  fs.writeFileSync(archive, portableNpmTarball(fs.readFileSync(archive), expectedFiles));
  console.log(`${archive}\nsha256: ${digest(archive)}`);
}

if (import.meta.main) {
  try {
    switch (process.argv[2]) {
      case 'build':
        buildPackage();
        break;
      case 'verify':
        verifyPacklist();
        break;
      case 'prepack':
        verifyPacklist();
        if (process.platform === 'win32')
          throw new Error(
            'On Windows, use npm run package:pack to preserve Unix executable modes; publish the resulting tarball, not the directory',
          );
        break;
      case 'pack':
        packPackage(process.argv.slice(3));
        break;
      case 'smoke':
        smokePackage(process.argv[3]);
        break;
      default:
        throw new Error(
          'Usage: node scripts/npm-package.mjs <build|verify|pack|prepack|smoke> [arguments]',
        );
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
