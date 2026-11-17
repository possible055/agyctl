import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { conversationProducts } from './transport.mjs';

/** @param {Buffer} raw @returns {Generator<{number:number,value:bigint|Buffer|null}>} */
function* fields(raw) {
  let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= raw.length) throw new Error('Truncated protobuf varint');
      const byte = raw[offset++];
      if (i === 9 && byte > 1) throw new Error('Overflowing protobuf varint');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    throw new Error('Overflowing protobuf varint');
  };
  while (offset < raw.length) {
    const tag = varint();
    if (tag < 8n || tag > 0xffffffffn) throw new Error('Invalid protobuf field tag');
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (wire === 0) {
      yield { number, value: varint() };
      continue;
    }
    if (![1, 2, 5].includes(wire)) throw new Error(`Unsupported protobuf wire type ${wire}`);
    const length = wire === 2 ? varint() : BigInt(wire === 1 ? 8 : 4);
    if (length > BigInt(raw.length - offset)) throw new Error('Truncated protobuf field');
    const end = offset + Number(length);
    yield { number, value: wire === 2 ? raw.subarray(offset, end) : null };
    offset = end;
  }
}

/** @param {bigint|Buffer|null} value @returns {Buffer} */
function message(value) {
  if (!Buffer.isBuffer(value)) throw new Error('Expected a length-delimited protobuf field');
  return value;
}

/** @param {bigint|Buffer|null} value @param {'uint32'|'int32'|'bool'} type */
function scalar(value, type) {
  if (typeof value !== 'bigint') throw new Error('Expected a protobuf varint field');
  if (type === 'bool') return value === 0n ? 0 : 1;
  if (type === 'int32') return Number(BigInt.asIntN(32, value));
  if (value > 0xffffffffn) throw new Error('Checkpoint uint32 overflow');
  return Number(value);
}

/** @param {Buffer[]} chunks @param {number} number */
function submessages(chunks, number) {
  return chunks.flatMap((chunk) =>
    [...fields(chunk)]
      .filter((field) => field.number === number)
      .map(({ value }) => message(value)),
  );
}

/** @param {Buffer[]} chunks @returns {import('./contracts.js').CheckpointMetadata|null} */
function checkpoint(chunks) {
  if (!chunks.length) return null;
  /** @type {import('./contracts.js').CheckpointMetadata} */
  const result = {
    maxTokenLimit: null,
    maxUserRequests: null,
    maxUserRequestBytes: null,
    enabled: null,
    includeLastUserMessage: null,
    summaryPrompt: null,
    stepCompaction: null,
  };
  // Wire field numbers come from the inspected 2.32.1 descriptors, not Go struct offsets.
  for (const chunk of chunks) {
    for (const { number, value } of fields(chunk)) {
      if (number === 5) result.maxTokenLimit = scalar(value, 'uint32');
      else if (number === 16) result.maxUserRequests = scalar(value, 'int32');
      else if (number === 17) result.maxUserRequestBytes = scalar(value, 'int32');
      else if (number === 6) result.enabled = scalar(value, 'bool') !== 0;
      else if (number === 29) result.includeLastUserMessage = scalar(value, 'bool') !== 0;
      else if (number === 20) {
        const bytes = message(value);
        result.summaryPrompt = {
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }
    }
  }
  const steps = submessages(chunks, 38);
  if (steps.length) {
    result.stepCompaction = { maxInlineFrames: null, maxLatestResultBytes: null };
    for (const chunk of steps) {
      for (const { number, value } of fields(chunk)) {
        if (number === 2) result.stepCompaction.maxInlineFrames = scalar(value, 'int32');
        else if (number === 10) result.stepCompaction.maxLatestResultBytes = scalar(value, 'int32');
      }
    }
  }
  return result;
}

/** Decodes one ExecutorMetadata row without exposing prompt or conversation text.
 * @param {Buffer} raw
 */
export function parseExecutorCheckpointMetadata(raw) {
  return {
    checkpoint: checkpoint(submessages(submessages([raw], 10), 2)),
    requestOverride: checkpoint(submessages(submessages([raw], 17), 2)),
  };
}

/** @param {Buffer} raw @returns {number[]} */
export function parseCheckpointLimits(raw) {
  const limit = parseExecutorCheckpointMetadata(raw).checkpoint?.maxTokenLimit;
  return limit == null ? [] : [limit];
}

/** Reads recent executor metadata without opening the conversation databases for writes. */
/** @param {{conversationDir:string,count?:number,conversationIds?:string[]}} options @returns {Promise<import("./contracts.js").LimitDiagnostics>} */
export async function readRecentContextLimits({ conversationDir, count = 3, conversationIds }) {
  /** @type {import("./contracts.js").LimitDiagnostics} */
  const result = { source: 'local-executor-metadata', conversations: [], error: null };
  try {
    const { DatabaseSync } = await import('node:sqlite');
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid conversation count');
    const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
    if (conversationIds && !conversationIds.every((id) => uuid.test(id)))
      throw new Error('Invalid explicit conversation id');
    const files = conversationIds
      ? conversationIds.map((id) => ({ name: `${id}.db` }))
      : fs
          .readdirSync(conversationDir)
          .filter((name) => name.endsWith('.db') && uuid.test(name.slice(0, -3)))
          .map((name) => ({ name, mtime: fs.statSync(path.join(conversationDir, name)).mtimeMs }))
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, count);
    for (const { name } of files) {
      let database;
      /** @type {import("./contracts.js").LimitDiagnostic} */
      const entry = { id: name.slice(0, -3), limits: [], executors: [], error: null };
      try {
        database = new DatabaseSync(path.join(conversationDir, name), { readOnly: true });
        const rows = database.prepare('SELECT idx, data FROM executor_metadata ORDER BY idx').all();
        for (const row of rows) {
          const executor = {
            index: Number(row.idx),
            checkpoint: null,
            requestOverride: null,
            error: null,
          };
          try {
            if (!(row.data instanceof Uint8Array))
              throw new Error('executor_metadata.data is not a BLOB');
            Object.assign(executor, parseExecutorCheckpointMetadata(Buffer.from(row.data)));
          } catch (error) {
            executor.error = error.message;
            entry.error = 'One or more executor metadata rows could not be decoded';
          }
          entry.executors.push(executor);
        }
        entry.limits = [
          ...new Set(
            entry.executors.flatMap(({ checkpoint }) =>
              checkpoint?.maxTokenLimit == null ? [] : [checkpoint.maxTokenLimit],
            ),
          ),
        ].sort((a, b) => a - b);
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
