import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  callLanguageServer as call,
  discoverLanguageServer,
  findLatestListeningPort,
} from '../../src/plugin/sidecars/panel/transport.mjs';

test('log discovery reconstructs a listening line straddling the reverse-read chunk boundary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-transport-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const CHUNK = 256 * 1024;
  const head = 'listening on random port at 22';
  const target = 'listening on random port at 2222 for HTTPS (gRPC)';
  const oldLine = Buffer.from('listening on random port at 1111 for HTTP (gRPC)\n');
  // The newest reverse chunk starts at size - CHUNK, placed inside the target's
  // port digits, so neither fragment alone matches the listening pattern.
  const boundary = 4096;
  const padLength = boundary - Buffer.byteLength(head) - oldLine.length;
  const pad = Buffer.alloc(padLength, 0x78);
  pad[pad.length - 1] = 0x0a;
  const log = Buffer.concat([
    oldLine,
    pad,
    Buffer.from(`${target}\n`),
    Buffer.alloc(boundary + CHUNK - (oldLine.length + padLength + target.length + 1), 0x79),
  ]);
  assert.equal(log.length, CHUNK + boundary);
  assert.equal(log.indexOf(target), boundary - Buffer.byteLength(head));
  const straddle = path.join(root, 'straddle.log');
  const plain = path.join(root, 'plain.log');
  fs.writeFileSync(straddle, log);
  fs.writeFileSync(
    plain,
    'listening on random port at 3333 for HTTP (gRPC)\n' +
      'listening on random port at 4444 for HTTP (gRPC)\n',
  );
  assert.deepEqual(findLatestListeningPort(straddle), { port: 2222, useHttps: true });
  assert.deepEqual(findLatestListeningPort(plain), { port: 4444, useHttps: false });
  assert.equal(findLatestListeningPort(path.join(root, 'missing.log')), null);
});

test('callLanguageServer fails visibly instead of truncating an oversize response', async (t) => {
  const captured = [];
  const makeRes = (statusCode) => {
    const handlers = {};
    return {
      statusCode,
      destroyed: false,
      on(name, callback) {
        if (!handlers[name]) handlers[name] = [];
        handlers[name].push(callback);
      },
      emit(name, event) {
        for (const callback of handlers[name] || []) callback(event);
      },
      destroy() {
        this.destroyed = true;
      },
    };
  };
  const request = t.mock.method(http, 'request', (_options, callback) => ({
    on() {},
    write() {},
    end() {
      captured.push(callback);
    },
  }));
  try {
    const endpoint = { host: '127.0.0.1', port: 1, protocol: 'http:', csrfToken: 't' };
    const method = 'GetCascadeTrajectoryGeneratorMetadata';

    const oversize = call(endpoint, method, {}, { maxBytes: 16 });
    const res = makeRes(200);
    captured.at(-1)(res);
    res.emit('data', Buffer.alloc(17, 0x61));
    res.emit('end');
    await assert.rejects(oversize, /exceeded the 16-byte limit/);
    assert.equal(res.destroyed, true, 'an oversize response must be aborted, never truncated');

    const ok = call(endpoint, method, {}, {});
    const okRes = makeRes(200);
    captured.at(-1)(okRes);
    okRes.emit('data', Buffer.from('{"ok":true}'));
    okRes.emit('end');
    assert.deepEqual(await ok, { ok: true });

    const failure = call(endpoint, method, {}, {});
    const failRes = makeRes(500);
    captured.at(-1)(failRes);
    failRes.emit('data', Buffer.from('server exploded'));
    failRes.emit('end');
    await assert.rejects(failure, /RPC HTTP 500: server exploded/);
  } finally {
    request.mock.restore();
  }
});

test('discovery via env shortcut (deterministic, no network)', async () => {
  const origAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const origToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  const origDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  try {
    process.env.ANTIGRAVITY_LS_ADDRESS = '127.0.0.1:59999';
    process.env.ANTIGRAVITY_CSRF_TOKEN = 'unit-test-token';
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = path.join(
      os.homedir(),
      '.gemini',
      'antigravity',
      'sidecar_data',
      'agyctl',
      'panel',
      'data',
    );
    const ep = await discoverLanguageServer(true);
    if (ep.source !== 'env') throw new Error(`expected source 'env', got '${ep.source}'`);
    if (ep.port !== 59999) throw new Error(`expected port 59999, got ${ep.port}`);
    if (ep.csrfToken !== 'unit-test-token') throw new Error('csrfToken mismatch');
    assert.equal(ep.product, 'hub');
    assert.equal(
      ep.conversationDir,
      path.join(os.homedir(), '.gemini', 'antigravity', 'conversations'),
    );
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = path.join(os.tmpdir(), 'other-client', 'data');
    const unknown = await discoverLanguageServer(true);
    assert.equal(unknown.product, undefined);
    assert.equal(unknown.conversationDir, undefined);
  } finally {
    if (origAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
    else process.env.ANTIGRAVITY_LS_ADDRESS = origAddr;
    if (origToken === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    else process.env.ANTIGRAVITY_CSRF_TOKEN = origToken;
    if (origDataDir === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = origDataDir;
  }
});

test('invalid or incomplete explicit LS settings refuse instead of discovering another server', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agyctl-transport-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const transport = new URL('../../src/plugin/sidecars/panel/transport.mjs', import.meta.url).href;
  const script = `
    import { discoverLanguageServer } from ${JSON.stringify(transport)};
    try {
      await discoverLanguageServer();
      process.stdout.write(JSON.stringify({ discovered: true }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.message }));
    }
  `;
  for (const [address, token, expected] of [
    ['http://127.0.0.1:59999', 'test-token', /Invalid LS address/],
    ['127.0.0.1:59999', undefined, /must be set together/],
    [undefined, 'test-token', /must be set together/],
  ]) {
    const env = { ...process.env, HOME: root, USERPROFILE: root, APPDATA: root };
    delete env.ANTIGRAVITY_LS_ADDRESS;
    delete env.ANTIGRAVITY_CSRF_TOKEN;
    if (address !== undefined) env.ANTIGRAVITY_LS_ADDRESS = address;
    if (token !== undefined) env.ANTIGRAVITY_CSRF_TOKEN = token;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).error, expected);
  }
});

test('discovery via log + web scraping (requires live Antigravity)', async (t) => {
  const origAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const origToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  try {
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    let ep;
    try {
      ep = await discoverLanguageServer(true);
    } catch (error) {
      if (/Homepage response contains no csrfToken/.test(error.message)) {
        t.skip('The running Language Server does not expose a homepage CSRF token');
        return;
      }
      if (!/No Language Server listening port found in logs/.test(error.message)) throw error;
      t.skip('Language Server is not running or its log is missing');
      return;
    }
    assert.ok(ep.port > 0 && ep.csrfToken, 'discovery returned an incomplete endpoint');
    assert.equal(ep.source, 'log_and_web');
  } finally {
    if (origAddr === undefined) delete process.env.ANTIGRAVITY_LS_ADDRESS;
    else process.env.ANTIGRAVITY_LS_ADDRESS = origAddr;
    if (origToken === undefined) delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    else process.env.ANTIGRAVITY_CSRF_TOKEN = origToken;
  }
});
