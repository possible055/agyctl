// Self-made HTTPS test service for the P0-A delivery harness. Serves fixed
// fixture content only; its certificate identity is checked by exact
// fingerprint, never by a global ignore flag.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');

const ORIGINAL_MAIN = 'window.__ORIGINAL_BUNDLE_RAN__ = true;\n';
const OTHER_JS = 'window.__OTHER_JS_RAN__ = true;\n';
const STREAM_CHUNKS = 12;
const STREAM_CHUNK_DELAY_MS = 110;
const INDEX_HTML = [
  '<!doctype html>',
  '<html lang="en">',
  '<head><meta charset="utf-8"><title>agyctl harness</title></head>',
  '<body><div id="root"></div><script src="/main.js"></script></body>',
  '</html>',
].join('\n');

function generateCertificate(directory) {
  const keyPath = path.join(directory, 'harness-key.pem');
  const certPath = path.join(directory, 'harness-cert.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'pipe' },
  );
  const der = execFileSync('openssl', ['x509', '-in', certPath, '-outform', 'DER'], {
    stdio: 'pipe',
  });
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
    hexFingerprint: crypto.createHash('sha256').update(der).digest('hex'),
    // Electron reports certificate fingerprints as `sha256/<base64>`.
    fingerprint: `sha256/${crypto.createHash('sha256').update(der).digest('base64')}`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeTestServer(tmpDir) {
  const material = generateCertificate(tmpDir);
  const requestLog = [];
  const streamState = { started: 0, completed: 0, cancelled: 0 };
  const server = https.createServer({ key: material.key, cert: material.cert }, (req, res) => {
    const url = new URL(req.url, `https://127.0.0.1/`);
    requestLog.push({ method: req.method, path: url.pathname, query: url.search });
    const send = (status, body, headers = {}) => {
      res.writeHead(status, headers);
      res.end(body);
    };
    if (req.method === 'GET' && url.pathname === '/') {
      send(200, INDEX_HTML, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; script-src 'self'",
        'cross-origin-opener-policy': 'same-origin',
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/main.js') {
      send(200, ORIGINAL_MAIN, { 'content-type': 'text/javascript; charset=utf-8' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/other.js') {
      send(200, OTHER_JS, { 'content-type': 'text/javascript; charset=utf-8' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/stream') {
      streamState.started += 1;
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      let closed = false;
      res.on('close', () => {
        closed = true;
        if (res.writableEnded) streamState.completed += 1;
        else streamState.cancelled += 1;
      });
      (async () => {
        for (let i = 0; i < STREAM_CHUNKS; i++) {
          if (closed) return;
          res.write(`chunk-${i};`);
          await sleep(STREAM_CHUNK_DELAY_MS);
        }
        if (!closed) res.end('stream-end');
      })();
      return;
    }
    if (url.pathname === '/rpc') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        send(200, JSON.stringify({ method: req.method, path: url.pathname, body }), {
          'content-type': 'application/json',
        });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/cookie-multi') {
      res.setHeader('set-cookie', ['harness-a=1; Path=/', 'harness-b=2; Path=/']);
      send(200, 'ok', { 'content-type': 'text/plain' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/redirect') {
      send(302, '', { location: '/main.js' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/slow') {
      setTimeout(() => send(200, 'slow-ok', { 'content-type': 'text/plain' }), 1200);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/reflect') {
      send(200, JSON.stringify({ method: req.method, path: url.pathname, headers: req.headers }), {
        'content-type': 'application/json',
      });
      return;
    }
    send(404, 'not found', { 'content-type': 'text/plain' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    port: server.address().port,
    fingerprint: material.fingerprint,
    certPem: material.cert.toString('utf8'),
    requestLog,
    streamState,
    originalMain: Buffer.from(ORIGINAL_MAIN),
    otherJs: Buffer.from(OTHER_JS),
    streamChunks: STREAM_CHUNKS,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

module.exports = { makeTestServer, INDEX_HTML, tmpdir: os.tmpdir };
