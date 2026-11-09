import { createHash } from 'node:crypto';
import fs from 'node:fs';

export function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256File(filePath: string): string {
  const handle = fs.openSync(filePath, 'r');
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead = 0;
    while ((bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, bytesRead));
    return hash.digest('hex');
  } finally {
    fs.closeSync(handle);
  }
}
