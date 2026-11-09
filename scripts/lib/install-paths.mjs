import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PRODUCT = 'agyctl';

export function agyctlHome() {
  const override = process.env.AGYCTL_HOME;
  if (override) return override;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, PRODUCT);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', PRODUCT);
  }
  const xdg = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(xdg, PRODUCT);
}

export function backupDir() {
  return path.join(agyctlHome(), 'backups');
}

export function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    // biome-ignore lint/suspicious/noAssignInExpressions: chunked read loop
    while ((bytesRead = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

export function findAsarPath() {
  const [target] = installedTargets();
  if (target) return target.asarPath;
  throw new Error('未找到 Antigravity 安裝之 app.asar');
}

/** The packaged Language Server next to `resources/app.asar`. */
export function languageServerPath(asarPath, platform = process.platform) {
  return path.join(
    path.dirname(asarPath),
    'bin',
    installLayout().platforms[platform].language_server,
  );
}

export function installLayout() {
  // Walk up from this module (or its bundler output) to the repo root that
  // owns compat/install-layout.json, so the layout also resolves when this
  // module is packed into dist/localization bundles.
  let directory = path.dirname(fileURLToPath(import.meta.url));
  let filename;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(directory, 'compat', 'install-layout.json');
    if (fs.existsSync(candidate)) {
      filename = candidate;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (!filename) throw new Error('compat/install-layout.json not found');
  const layout = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (layout.schema !== 1 || !layout.targets || !layout.platforms)
    throw new Error('Unsupported or incomplete installation layout');
  return layout;
}

export function supportedTarget(platform = process.platform, arch = process.arch) {
  const target = Object.entries(installLayout().targets).find(
    ([, value]) => value.nodePlatform === platform && value.nodeArch === arch,
  );
  if (!target) throw new Error(`Unsupported target: ${platform}/${arch}`);
  return { id: target[0], ...target[1] };
}

/** Identifies client data without executing it or depending on the native tools build. */
export function inspectedClientTarget(filename) {
  const descriptor = fs.openSync(filename, 'r');
  try {
    const size = fs.fstatSync(descriptor).size;
    const read = (offset, length) => {
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > size - length)
        throw new Error('Truncated client executable header');
      const bytes = Buffer.alloc(length);
      if (fs.readSync(descriptor, bytes, 0, length, offset) !== length)
        throw new Error('Client executable changed while reading its header');
      return bytes;
    };
    const header = read(0, 32);
    let goos;
    let goarch;
    if (header.subarray(0, 2).toString() === 'MZ') {
      const pe = read(read(60, 4).readUInt32LE(), 6);
      if (pe.subarray(0, 4).equals(Buffer.from('PE\0\0')) && pe.readUInt16LE(4) === 0x8664) {
        goos = 'windows';
        goarch = 'amd64';
      }
    } else if (header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      if (header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62) {
        goos = 'linux';
        goarch = 'amd64';
      }
    } else if (header.readUInt32LE() === 0xfeedfacf && header.readUInt32LE(4) === 0x0100000c) {
      goos = 'darwin';
      goarch = 'arm64';
    } else if ([0xcafebabe, 0xcafebabf].includes(header.readUInt32BE())) {
      const count = header.readUInt32BE(4);
      const wide = header.readUInt32BE() === 0xcafebabf;
      if (count < 1 || count > 32) throw new Error('Invalid universal Mach-O slice count');
      let matches = 0;
      for (let index = 0; index < count; index++) {
        const slice = read(8 + index * (wide ? 32 : 20), wide ? 32 : 20);
        if (slice.readUInt32BE() !== 0x0100000c) continue;
        const offset = wide ? Number(slice.readBigUInt64BE(8)) : slice.readUInt32BE(8);
        const length = wide ? Number(slice.readBigUInt64BE(16)) : slice.readUInt32BE(12);
        if (!Number.isSafeInteger(length) || length < 32 || offset > size - length)
          throw new Error('Invalid ARM64 Mach-O slice bounds');
        const selected = read(offset, 32);
        if (selected.readUInt32LE() !== 0xfeedfacf || selected.readUInt32LE(4) !== 0x0100000c)
          throw new Error('Universal Mach-O ARM64 slice header does not match');
        matches++;
      }
      if (matches !== 1) throw new Error('Universal Mach-O must have exactly one ARM64 slice');
      goos = 'darwin';
      goarch = 'arm64';
    }
    const id = `${goos}/${goarch}`;
    const target = installLayout().targets[id];
    if (!target) throw new Error('Unsupported client executable format or architecture');
    return { id, ...target };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function installationPaths(
  resources,
  product,
  platform = process.platform,
  arch = process.arch,
) {
  supportedTarget(platform, arch);
  const layout = installLayout().platforms[platform];
  const channel = layout.channels.find((entry) => entry.channel === product);
  if (!channel) throw new Error(`Unsupported Antigravity channel: ${product}`);
  const root = path.dirname(path.resolve(resources));
  return {
    root,
    binaryPath: path.join(resources, 'bin', layout.language_server),
    executablePath: path.join(root, channel.executable),
  };
}

export function installedTargets() {
  supportedTarget();
  const platform = installLayout().platforms[process.platform];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return platform.channels
    .map((entry) => {
      const root = path.resolve(entry.root.replace('{localAppData}', local));
      return {
        product: entry.channel,
        root,
        asarPath: path.join(root, platform.resources, 'app.asar'),
        binaryPath: path.join(root, platform.resources, 'bin', platform.language_server),
        executablePath: path.join(root, entry.executable),
      };
    })
    .filter((target) => fs.existsSync(target.asarPath));
}
