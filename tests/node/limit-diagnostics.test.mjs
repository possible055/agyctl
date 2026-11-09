import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseCheckpointLimits,
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

test('local checkpoint diagnostics decode distinct protobuf limits and reject truncated values', () => {
  const prefix = Buffer.from('08c09a0c10011d0000803f28', 'hex');
  const raw = Buffer.concat([
    prefix,
    Buffer.from('a0c21e', 'hex'),
    prefix,
    Buffer.from('80d00f', 'hex'),
    prefix,
    Buffer.from('a0c21e', 'hex'),
  ]);
  assert.deepEqual(parseCheckpointLimits(raw), [256000, 500000]);
  assert.deepEqual(parseCheckpointLimits(Buffer.from('unrelated metadata')), []);
  assert.throws(
    () => parseCheckpointLimits(Buffer.concat([prefix, Buffer.from([0x80])])),
    /Malformed CheckpointConfig/,
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
  db.exec('CREATE TABLE executor_metadata (data BLOB)');
  db.prepare('INSERT INTO executor_metadata VALUES (?)').run(
    Buffer.from('08c09a0c10011d0000803f28a0c21e', 'hex'),
  );
  db.close();
  const before = fs.readFileSync(filename);
  const result = await readRecentContextLimits({ conversationDir });
  assert.deepEqual(result, {
    source: 'local-executor-metadata',
    error: null,
    conversations: [{ id: name.slice(0, -3), limits: [500000], error: null }],
  });
  assert.deepEqual(fs.readFileSync(filename), before);
  fs.writeFileSync(filename, 'invalid database');
  const failed = await readRecentContextLimits({ conversationDir });
  assert.equal(failed.conversations[0].limits.length, 0);
  assert.match(failed.conversations[0].error, /not a database/);
});
