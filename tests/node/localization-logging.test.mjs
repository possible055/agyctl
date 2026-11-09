// S0 logging contract tests (continuation plan §4): JSONL events with the
// shared envelope, bounded rotation/retention, whitelisted serialization, the
// pre/post-mutation failure split, and CLI stdout/log correlation. The CLI
// cases spawn the real tool with AGYCTL_HOME redirected to a temp directory.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createEventSink,
  createGuardedEventSink,
  JsonlEventWriter,
  LoggingError,
} from '../../dist/host/bundle/tooling-logging.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-l10n-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readEvents(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

test('writer adds the envelope, rotates segments and bounds closed retention', (t) => {
  const root = temporary(t);
  const directory = path.join(root, 'logs', 'offline');
  const writer = new JsonlEventWriter({
    directory,
    maxSegmentBytes: 1024,
    maxClosedSegments: 50,
    activeGraceMs: 0,
  });
  const sink = createEventSink(writer, { component: 'test', operationId: 'op-1' });
  for (let index = 0; index < 40; index++)
    sink({
      level: 'info',
      stage: 'transform',
      event: 'applied',
      result: 'applied',
      messageId: `message.${index}`,
      detail: 'x'.repeat(80),
    });
  writer.close();

  const segments = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
  assert.ok(segments.length > 1, `expected rotation, got ${segments.length} segment(s)`);
  const events = segments.flatMap((name) => readEvents(path.join(directory, name)));
  assert.equal(events.length, 40);
  for (const event of events) {
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.runId, writer.runId);
    assert.equal(event.operationId, 'op-1');
    assert.equal(event.component, 'test');
    assert.match(event.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  // A closed writer refuses further events instead of silently dropping them.
  assert.throws(
    () => writer.write({ ...events[0], event: 'after-close' }),
    (error) => error instanceof LoggingError && error.code === 'LOG_WRITE_FAILED',
  );

  // With a tight retention cap, old closed segments are dropped and the
  // newest events survive.
  const bounded = new JsonlEventWriter({
    directory: path.join(root, 'logs', 'bounded'),
    maxSegmentBytes: 1024,
    maxClosedSegments: 2,
    activeGraceMs: 0,
  });
  const boundedSink = createEventSink(bounded, { component: 'test', operationId: 'op-1b' });
  for (let index = 0; index < 40; index++)
    boundedSink({ level: 'info', stage: 's', event: 'e', result: 'r', messageId: `m.${index}` });
  bounded.close();
  const remaining = fs
    .readdirSync(path.join(root, 'logs', 'bounded'))
    .filter((name) => name.endsWith('.jsonl'));
  assert.ok(remaining.length <= 2, `retention must bound closed segments, got ${remaining.length}`);
  const remainingEvents = remaining.flatMap((name) =>
    readEvents(path.join(root, 'logs', 'bounded', name)),
  );
  // Retention keeps the newest events and drops the oldest segments.
  assert.equal(
    remainingEvents.some((event) => event.messageId === 'm.39'),
    true,
  );
  assert.equal(
    remainingEvents.some((event) => event.messageId === 'm.0'),
    false,
  );
});

test('serialization is whitelisted and bounded: unknown fields never reach the log', (t) => {
  const root = temporary(t);
  const writer = new JsonlEventWriter({ directory: path.join(root, 'logs', 'offline') });
  const sink = createEventSink(writer, { component: 'test', operationId: 'op-2' });
  sink({
    level: 'warn',
    stage: 'vendor.import',
    event: 'conflict',
    result: 'kept-both',
    detail: 'x'.repeat(5000),
    counts: { kept: 1, dropped: NaN },
  });
  writer.close();
  const [event] = readEvents(writer.activePath);
  assert.equal(event.detail.length, 2001);
  assert.ok(event.detail.endsWith('…'));
  assert.deepEqual(event.counts, { kept: 1 });
  // An arbitrary error object merged into the event must not leak through.
  const leaky = new Error('boom');
  leaky.config = { authorization: 'Bearer secret', cookie: 'session=1' };
  const second = new JsonlEventWriter({ directory: path.join(root, 'logs', 'offline') });
  second.write({
    schemaVersion: 1,
    timestamp: new Date().toISOString(),
    level: 'error',
    runId: second.runId,
    operationId: 'op-3',
    component: 'test',
    stage: 'stage',
    event: 'failed',
    result: 'failed',
    ...leaky,
  });
  second.close();
  const [raw] = readEvents(second.activePath);
  assert.equal(raw.config, undefined);
  assert.equal(raw.authorization, undefined);
});

test('a guarded sink aborts before the mutation point and degrades after it', () => {
  const failing = () => {
    throw new LoggingError('LOG_WRITE_FAILED', 'disk full');
  };
  const guarded = createGuardedEventSink(failing);
  assert.throws(() => guarded.sink({ level: 'info', stage: 's', event: 'e', result: 'r' }));
  assert.equal(guarded.failure(), null);
  guarded.markMutating();
  guarded.sink({ level: 'info', stage: 's', event: 'e', result: 'r' });
  assert.equal(guarded.failure()?.code, 'LOG_WRITE_FAILED');
});

function runCli(home, args) {
  return spawnSync(process.execPath, ['scripts/localization.mjs', ...args], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AGYCTL_HOME: home },
  });
}

function syntheticSample(root) {
  const sample = path.join(root, 'sample');
  fs.mkdirSync(sample);
  const { profiles } = JSON.parse(fs.readFileSync('compat/localization/profiles.json', 'utf8'));
  const profile = profiles[0];
  const usage = JSON.parse(fs.readFileSync('compat/localization/usage-points.json', 'utf8'))
    .profiles[profile.profileId];
  const main = (usage.fallbackRules ?? usage.rules)
    .flatMap((rule) => {
      if (rule.kind === 'template-literal')
        return Array.from(
          { length: rule.expectedHits },
          () =>
            'void `' + rule.originalText.replace(/\{(\d+)\}/g, (_, n) => '${x' + n + '}') + '`;',
        );
      if (rule.kind === 'element-child')
        return Array.from(
          { length: rule.expectedHits },
          () => `A.createElement("span", null, ${JSON.stringify(rule.originalText)});`,
        );
      if (rule.kind !== 'nls-default-string') {
        return Array.from({ length: rule.expectedHits }, () =>
          rule.withinProperty
            ? `obj({${/^[A-Za-z_$][\w$]*$/.test(rule.withinProperty) ? rule.withinProperty : JSON.stringify(rule.withinProperty)}: ${JSON.stringify(rule.originalText)}});`
            : `const v = ${JSON.stringify(rule.originalText)};`,
        );
      }
      return Array.from(
        { length: rule.expectedHits },
        () =>
          `${profile.nlsHelper.calleeName}(${JSON.stringify(rule.upstreamKey)}, ${JSON.stringify(rule.originalText)});`,
      );
    })
    .join('\n');
  fs.writeFileSync(path.join(sample, 'main.js'), main);
  fs.writeFileSync(path.join(sample, 'index.html'), '<html>synthetic</html>');
  return sample;
}

test('CLI prepare records the flow in JSONL and keeps stdout a single result JSON', (t) => {
  const root = temporary(t);
  const home = path.join(root, 'tool-state');
  const result = runCli(home, [
    'prepare',
    '--probe',
    '--sample-dir',
    syntheticSample(root),
    '--json',
  ]);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.probe, true);
  assert.match(report.log.path, /\.jsonl$/);
  assert.ok(fs.existsSync(report.log.path));
  const events = readEvents(report.log.path);
  const stages = events.map((event) => `${event.stage}.${event.event}`);
  assert.ok(stages.includes('source.observe.started'));
  assert.ok(stages.includes('source.observe.completed'));
  assert.ok(stages.includes('transform.completed'));
  assert.ok(stages.includes('artifact.publish.completed'));
  assert.equal(new Set(events.map((event) => event.runId)).size, 1);
  assert.equal(new Set(events.map((event) => event.operationId)).size, 1);
  assert.equal(
    events.every((event) => event.component === 'cli'),
    true,
  );
});

test('a deliberate CLI failure locates the last completed stage, code and target in the log', (t) => {
  const root = temporary(t);
  const home = path.join(root, 'tool-state');
  const result = runCli(home, [
    'prepare',
    '--locale',
    'xx-TEST',
    '--sample-dir',
    syntheticSample(root),
    '--json',
  ]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.code, 'CATALOG_INVALID');
  assert.ok(fs.existsSync(report.log.path));
  const events = readEvents(report.log.path);
  const completed = events.filter((event) => event.event === 'completed');
  assert.equal(completed.at(-1)?.stage, 'source.observe');
  const failed = events.at(-1);
  assert.equal(failed.event, 'failed');
  assert.equal(failed.code, 'CATALOG_INVALID');
  assert.ok(failed.detail.includes('xx-TEST'));
  // Nothing was written to the tool's artifact store.
  assert.equal(fs.existsSync(path.join(home, 'localization', 'artifacts')), false);
});

test('a mutating CLI command that cannot create its log writes nothing', (t) => {
  const root = temporary(t);
  const home = path.join(root, 'tool-state');
  // A file where the log directory must go makes writer creation fail.
  fs.mkdirSync(path.join(home, 'localization'), { recursive: true });
  fs.writeFileSync(path.join(home, 'localization', 'logs'), 'not a directory');
  const result = runCli(home, [
    'prepare',
    '--probe',
    '--sample-dir',
    path.join(root, 'unread-source'),
    '--json',
  ]);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.code, 'LOG_WRITE_FAILED');
  assert.equal(report.log, undefined);
  assert.equal(fs.existsSync(path.join(home, 'localization', 'artifacts')), false);
});
