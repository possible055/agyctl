import fs from 'node:fs';
import { ComposerError } from './contracts.js';

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');

function readFuseWire(executablePath: string): Buffer {
  const handle = fs.openSync(executablePath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let tail = Buffer.alloc(0);
    let position = 0;
    let wireOffset = -1;
    let size: number;
    while ((size = fs.readSync(handle, chunk, 0, chunk.length, null)) > 0) {
      const window = Buffer.concat([tail, chunk.subarray(0, size)]);
      let index = window.indexOf(SENTINEL);
      while (index >= 0) {
        if (wireOffset >= 0) throw new Error('multiple Electron fuse wires found');
        wireOffset = position - tail.length + index;
        index = window.indexOf(SENTINEL, index + 1);
      }
      position += size;
      tail = Buffer.from(window.subarray(Math.max(0, window.length - SENTINEL.length + 1)));
    }
    if (wireOffset < 0) throw new Error('Electron fuse wire not found');
    const wire = Buffer.alloc(SENTINEL.length + 2 + 255);
    const length = fs.readSync(handle, wire, 0, wire.length, wireOffset);
    return wire.subarray(0, length);
  } finally {
    fs.closeSync(handle);
  }
}

/** Read-only Electron fuse qualification; no executable content is executed. */
export function qualifyArchiveMutation(executablePath: string | undefined): void {
  const refuse = (reason: string): never => {
    throw new ComposerError('UNSUPPORTED_STATE', `Electron ASAR integrity qualification failed: ${reason}; client files and fuses were not changed`);
  };
  if (!executablePath) refuse('the application executable is unresolved');
  let bytes: Buffer;
  try {
    bytes = readFuseWire(executablePath as string);
  } catch (error) {
    refuse(`cannot qualify the application executable (${(error as Error).message})`);
  }
  const start = SENTINEL.length;
  const version = bytes![start];
  const count = bytes![start + 1];
  if (version !== 1 || count === undefined || count <= 4 || start + 2 + count > bytes!.length)
    refuse('unknown or truncated Electron fuse schema');
  const states = bytes!.subarray(start + 2, start + 2 + count);
  if ([...states].some((state) => state !== 0x30 && state !== 0x31 && state !== 0x72))
    refuse('unknown Electron fuse state');
  if (states[4] !== 0x30 && states[4] !== 0x72)
    refuse('EnableEmbeddedAsarIntegrityValidation is enabled; modifying the ASAR header would invalidate its embedded hash');
}
