import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseCheckpointLimits,
  parseExecutorCheckpointMetadata,
  readRecentContextLimits,
} from '../../src/plugin/sidecars/panel/limit-diagnostics.mjs';
import {
  readSettings,
  saveSettings,
  validateSettings,
  writeJson,
} from '../../src/plugin/sidecars/panel/settings.mjs';

function dataDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-panel-'));
  const previous = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

test('panel settings hold only a validated refresh interval and read earlier files', (t) => {
  const directory = dataDirectory(t);
  assert.deepEqual(readSettings(), { pollIntervalSeconds: 10 });
  assert.deepEqual(saveSettings({ pollIntervalSeconds: 45 }), { pollIntervalSeconds: 45 });
  assert.deepEqual(readSettings(), { pollIntervalSeconds: 45 });
  for (const settings of [
    { pollIntervalSeconds: 9 },
    { pollIntervalSeconds: 301 },
    { pollIntervalSeconds: 10.5 },
    { pollIntervalSeconds: 10, asarPath: '/x' },
  ])
    assert.throws(() => validateSettings(settings));
  // Earlier builds also saved client-modification preferences in the same file.
  writeJson(path.join(directory, 'settings.json'), {
    schema: 3,
    settings: {
      asarPath: '',
      pollIntervalSeconds: 30,
      restartAfterApply: true,
      limitIds: '',
      limitTokens: null,
    },
  });
  assert.deepEqual(readSettings(), { pollIntervalSeconds: 30 });
  writeJson(path.join(directory, 'settings.json'), { schema: 2, settings: {} });
  assert.throws(readSettings, /Unsupported settings schema/);
});

function lengthField(tag, bytes) {
  assert.ok(bytes.length < 128);
  return Buffer.concat([Buffer.from(tag, 'hex'), Buffer.from([bytes.length]), bytes]);
}

function executor(checkpoint, tag = '52') {
  return lengthField(tag, lengthField('12', Buffer.from(checkpoint, 'hex')));
}

test('checkpoint diagnostics follow typed fields and merge only within one executor', () => {
  const unrelated = lengthField('42', Buffer.from('08c09a0c10011d0000803f28a0c21e', 'hex'));
  assert.deepEqual(parseCheckpointLimits(unrelated), []);
  assert.deepEqual(parseCheckpointLimits(executor('28a0c21e')), [500000]);
  const prompt = Buffer.from('摘要測試');
  const raw = Buffer.concat([
    executor('28a0c21e80011e880180103001e80101b202051004508010'),
    executor('2880d00f'),
    lengthField('52', lengthField('12', lengthField('a201', prompt))),
    executor('28c0843d', '8a01'),
    unrelated,
  ]);
  const decoded = parseExecutorCheckpointMetadata(raw);
  assert.deepEqual(decoded.checkpoint, {
    maxTokenLimit: 256000,
    maxUserRequests: 30,
    maxUserRequestBytes: 2048,
    enabled: true,
    includeLastUserMessage: true,
    summaryPrompt: {
      bytes: prompt.length,
      sha256: createHash('sha256').update(prompt).digest('hex'),
    },
    stepCompaction: { maxInlineFrames: 4, maxLatestResultBytes: 2048 },
  });
  assert.equal(decoded.requestOverride.maxTokenLimit, 1000000);
  assert.deepEqual(parseCheckpointLimits(raw), [256000]);
  assert.deepEqual(parseExecutorCheckpointMetadata(Buffer.alloc(0)), {
    checkpoint: null,
    requestOverride: null,
  });
  for (const hex of ['5280', '5203120228', '52051203288080', '0000', '520712052d00000000'])
    assert.throws(
      () => parseExecutorCheckpointMetadata(Buffer.from(hex, 'hex')),
      /protobuf|varint/,
    );
});

test('conversation diagnostics open SQLite read-only and keep per-file failures explicit', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const directory = dataDirectory(t);
  const conversationDir = path.join(directory, 'conversations');
  fs.mkdirSync(conversationDir);
  const name = '7e9ee023-f7ae-4925-89a4-07c520a34101.db';
  const filename = path.join(conversationDir, name);
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
  db.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(2, executor('28a0c21e'));
  db.prepare('INSERT INTO executor_metadata VALUES (?, ?)').run(1, executor('2880d00f'));
  db.close();
  const before = fs.readFileSync(filename);
  const result = await readRecentContextLimits({ conversationDir });
  assert.equal(result.error, null);
  assert.equal(result.conversations[0].error, null);
  assert.deepEqual(result.conversations[0].limits, [256000, 500000]);
  assert.deepEqual(
    result.conversations[0].executors.map(({ index, checkpoint }) => [
      index,
      checkpoint.maxTokenLimit,
    ]),
    [
      [1, 256000],
      [2, 500000],
    ],
  );
  assert.deepEqual(fs.readFileSync(filename), before);
  const writer = new DatabaseSync(filename);
  writer
    .prepare('INSERT INTO executor_metadata VALUES (?, ?)')
    .run(3, Buffer.from('520412022880', 'hex'));
  writer
    .prepare('INSERT INTO executor_metadata VALUES (?, ?)')
    .run(4, Buffer.from('808004', 'hex'));
  writer.close();
  fs.writeFileSync(
    path.join(conversationDir, '11111111-1111-1111-1111-111111111111.db'),
    'not selected',
  );
  const selected = await readRecentContextLimits({
    conversationDir,
    conversationIds: [name.slice(0, -3)],
  });
  assert.equal(selected.conversations.length, 1);
  assert.deepEqual(selected.conversations[0].limits, [256000, 500000]);
  assert.match(selected.conversations[0].error, /rows could not be decoded/);
  assert.match(selected.conversations[0].executors[2].error, /Truncated protobuf/);
  assert.match(selected.conversations[0].executors[3].error, /Truncated protobuf/);
  const invalid = await readRecentContextLimits({
    conversationDir,
    conversationIds: ['../outside'],
  });
  assert.match(invalid.error, /Invalid explicit conversation id/);
  fs.writeFileSync(filename, 'invalid database');
  const failed = await readRecentContextLimits({
    conversationDir,
    conversationIds: [name.slice(0, -3)],
  });
  assert.equal(failed.conversations[0].limits.length, 0);
  assert.match(failed.conversations[0].error, /not a database/);
});
