import fs from 'node:fs';
import path from 'node:path';
import { conversationProducts } from './transport.mjs';

/** @param {Buffer} raw @returns {number[]} */
export function parseCheckpointLimits(raw) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: protobuf field tags are binary bytes.
  const pattern = /\x08[\x80-\xff]*[\x00-\x7f]\x10[\x00-\x7f]\x1d[\s\S]{4}\x28/g;
  const limits = new Set();
  for (const match of raw.toString('latin1').matchAll(pattern)) {
    let value = 0;
    let shift = 0;
    let complete = false;
    for (let i = match.index + match[0].length; i < raw.length && shift < 53; i++, shift += 7) {
      const byte = raw[i];
      value += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) {
        complete = true;
        break;
      }
    }
    if (!complete || !Number.isSafeInteger(value))
      throw new Error('Malformed CheckpointConfig max_token_limit varint');
    limits.add(value);
  }
  return [...limits].sort((a, b) => a - b);
}

/** Reads recent executor metadata without opening the conversation databases for writes. */
/** @param {{conversationDir:string,count?:number}} options @returns {Promise<import("./contracts.js").LimitDiagnostics>} */
export async function readRecentContextLimits({ conversationDir, count = 3 }) {
  /** @type {import("./contracts.js").LimitDiagnostics} */
  const result = { source: 'local-executor-metadata', conversations: [], error: null };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const files = fs
      .readdirSync(conversationDir)
      .filter((name) => /^[a-f\d-]{36}\.db$/i.test(name))
      .map((name) => ({ name, mtime: fs.statSync(path.join(conversationDir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, count);
    for (const { name } of files) {
      let database;
      /** @type {import("./contracts.js").LimitDiagnostic} */
      const entry = { id: name.slice(0, -3), limits: [], error: null };
      try {
        database = new DatabaseSync(path.join(conversationDir, name), { readOnly: true });
        const rows = database.prepare('SELECT data FROM executor_metadata').all();
        const raw = Buffer.concat(
          rows
            .filter((row) => row.data != null)
            .map((row) => {
              if (!(row.data instanceof Uint8Array))
                throw new Error('executor_metadata.data is not a BLOB');
              return Buffer.from(row.data);
            }),
        );
        entry.limits = parseCheckpointLimits(raw);
      } catch (error) {
        entry.error = error.message;
      } finally {
        database?.close();
      }
      result.conversations.push(entry);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

/** @returns {Promise<import("./contracts.js").LimitDiagnostics>} */
export async function readContextLimitDiagnostics() {
  const results = await Promise.all(
    conversationProducts()
      .filter(({ conversationDir }) => fs.existsSync(conversationDir))
      .map(({ conversationDir }) => readRecentContextLimits({ conversationDir })),
  );
  return {
    source: 'local-executor-metadata',
    conversations: results.flatMap((result) => result.conversations),
    error: results.map((result) => result.error).find(Boolean) ?? null,
  };
}
