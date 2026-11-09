import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** Reads regular files under `directories`; symbolic links and special files are refused. */
export function collectFiles(root, directories) {
  const files = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Files cannot be symbolic links: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) walk(path.posix.join(relative, name));
    } else if (stat.isFile()) {
      files.push({ path: relative, content: fs.readFileSync(absolute) });
    } else {
      throw new Error(`Unsupported file type: ${relative}`);
    }
  };
  for (const directory of directories) walk(directory);
  return files;
}
