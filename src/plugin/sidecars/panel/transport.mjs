import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { parseHostPort } from '../../lib/endpoint.mjs';
import { languageServerRpcPath } from '../../lib/upstream-contract.mjs';

const homeDir = os.homedir();
const isWin = process.platform === 'win32';

/** @type {import("./contracts.js").Endpoint | null} */
let cachedLsEndpoint = null;
let lastDiscoveryTime = 0;
const DISCOVERY_CACHE_TTL = 30_000;
/** @returns {{product: string, conversationDir: string}[]} */
export function conversationProducts() {
  return [
    {
      product: 'insiders',
      conversationDir: path.join(homeDir, '.gemini', 'antigravity-insiders', 'conversations'),
    },
    {
      product: 'hub',
      conversationDir: path.join(homeDir, '.gemini', 'antigravity', 'conversations'),
    },
  ];
}

/**
 * 發現 Language Server 連接埠與 CSRF Token
 */
/** @param {boolean} [force] @param {string|null} [conversationId] @param {AbortSignal} [signal] @returns {Promise<import("./contracts.js").Endpoint>} */
export async function discoverLanguageServer(force = false, conversationId = null, signal) {
  signal?.throwIfAborted();
  const envAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const envToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (envAddr !== undefined || envToken !== undefined) {
    if (!envAddr || !envToken)
      throw new Error('ANTIGRAVITY_LS_ADDRESS and ANTIGRAVITY_CSRF_TOKEN must be set together');
    const { host, port } = parseHostPort(envAddr);
    cachedLsEndpoint = {
      host,
      port,
      protocol: 'http:',
      csrfToken: envToken,
      source: 'env',
    };
    lastDiscoveryTime = Date.now();
    return cachedLsEndpoint;
  }
  const preferredProduct = conversationId
    ? conversationProducts().find((product) =>
        fs.existsSync(path.join(product.conversationDir, `${conversationId}.db`)),
      )?.product
    : null;
  if (
    !force &&
    cachedLsEndpoint &&
    cachedLsEndpoint.source !== 'env' &&
    (!preferredProduct ||
      !cachedLsEndpoint.product ||
      cachedLsEndpoint.product === preferredProduct) &&
    Date.now() - lastDiscoveryTime < DISCOVERY_CACHE_TTL
  ) {
    return cachedLsEndpoint;
  }

  // 2. 搜尋日誌檔案
  const logCandidates = [];
  if (isWin) {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    logCandidates.push(
      path.join(appData, 'Antigravity - Insiders', 'logs', 'language_server.log'),
      path.join(appData, 'Antigravity', 'logs', 'language_server.log'),
      path.join(appData, 'antigravity', 'logs', 'language_server.log'),
    );
  } else if (process.platform === 'darwin') {
    logCandidates.push(
      path.join(
        homeDir,
        'Library',
        'Application Support',
        'Antigravity - Insiders',
        'logs',
        'language_server.log',
      ),
      path.join(
        homeDir,
        'Library',
        'Application Support',
        'Antigravity',
        'logs',
        'language_server.log',
      ),
    );
  } else {
    logCandidates.push(
      path.join(homeDir, '.config', 'Antigravity - Insiders', 'logs', 'language_server.log'),
      path.join(homeDir, '.config', 'Antigravity', 'logs', 'language_server.log'),
    );
  }

  const failures = [];
  for (const logFile of logCandidates) {
    signal?.throwIfAborted();
    const hit = findLatestListeningPort(logFile);
    if (!hit) continue;
    const product = logFile.includes('Insiders') ? 'insiders' : 'hub';
    if (preferredProduct && product !== preferredProduct) continue;
    const protocol = hit.useHttps ? 'https:' : 'http:';
    try {
      const csrfToken = await fetchCsrfTokenFromWeb(protocol, hit.port, signal);
      cachedLsEndpoint = {
        host: '127.0.0.1',
        port: hit.port,
        protocol,
        csrfToken,
        product,
        conversationDir: conversationProducts().find((p) => p.product === product)?.conversationDir,
        source: 'log_and_web',
      };
      lastDiscoveryTime = Date.now();
      return cachedLsEndpoint;
    } catch (err) {
      failures.push(`${hit.port}: ${err.message}`);
    }
  }
  cachedLsEndpoint = null;
  throw new Error(
    failures.length
      ? `Language Server discovery failed (${failures.join('; ')})`
      : 'No Language Server listening port found in logs',
  );
}

/**
 * Provisional response budget pending phase-0 payload measurement: generator
 * and executor metadata responses measure well below this in current builds.
 * An oversize response fails the affected capability with an explicit error
 * instead of being truncated or buffered without bound.
 */
export const LS_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 調用 Language Server Connect-RPC
 */
/** @template {keyof import("./contracts.js").RpcResponses} M @param {import("./contracts.js").Endpoint} endpoint @param {M} method @param {object} [payload] @param {{signal?:AbortSignal,timeoutMs?:number,maxBytes?:number}} [options] @returns {Promise<import("./contracts.js").RpcResponses[M]>} */
export function callLanguageServer(
  endpoint,
  method,
  payload = {},
  { signal, timeoutMs = 8000, maxBytes = LS_RESPONSE_MAX_BYTES } = {},
) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('RPC deadline exceeded')), timeoutMs);
    let finished = false;
    /** @param {Error|null} err @param {import("./contracts.js").RpcResponses[M]} [result] */
    const finish = (err, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (err) {
        if (cachedLsEndpoint === endpoint) cachedLsEndpoint = null;
        reject(err);
      } else if (result !== undefined) resolve(result);
      else reject(new Error('Missing RPC result'));
    };
    const client = endpoint.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(payload);

    const req = client.request(
      {
        hostname: endpoint.host,
        port: endpoint.port,
        path: languageServerRpcPath(method),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': endpoint.csrfToken,
          'Content-Length': Buffer.byteLength(bodyStr),
        },
        rejectUnauthorized: false,
        signal: controller.signal,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          if (finished) return;
          received += chunk.length;
          if (received > maxBytes) {
            res.destroy();
            return finish(new Error(`RPC ${method} response exceeded the ${maxBytes}-byte limit`));
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (finished) return;
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) {
            return finish(new Error(`RPC HTTP ${res.statusCode}: ${body.slice(0, 160)}`));
          }
          try {
            finish(null, JSON.parse(body));
          } catch (err) {
            finish(new Error(`RPC JSON parse failed: ${err.message}`));
          }
        });
        res.on('error', finish);
      },
    );

    req.on('error', finish);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * 從日誌尾端以區塊反向掃描最新的監聽埠，避免整檔讀入記憶體。
 * 語義與「從檔尾往回找第一條 listening 行」一致，但每次只緩衝一個區塊。
 */
/** @param {string} logFile @returns {{port: number, useHttps: boolean} | null} */
export function findLatestListeningPort(logFile) {
  let fd;
  try {
    fd = fs.openSync(logFile, 'r');
  } catch {
    return null;
  }
  try {
    const CHUNK = 256 * 1024;
    const size = fs.fstatSync(fd).size;
    let end = size;
    // 尾端片段：跨越上層邊界那一行在較新區塊內的後半段，'' 代表已達檔尾。
    let carry = '';
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const length = end - start;
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, start);
      const lines = buf.toString('utf8', 0, read).split('\n');
      // 區塊末段是跨越上層邊界那行的前半，接上來自較新區塊的後半才構成完整行
      lines[lines.length - 1] += carry;
      // 區塊起點的第一行只有後半，其前半在更舊的區塊，到那裡才能重組，故跳過
      const from = start === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= from; i--) {
        const line = lines[i];
        const mHttps = line.match(/listening on random port at (\d+) for HTTPS \(gRPC\)/i);
        if (mHttps) {
          return { port: parseInt(mHttps[1], 10), useHttps: true };
        }
        const mHttp = line.match(/listening on random port at (\d+) for HTTP\b/i);
        if (mHttp) {
          return { port: parseInt(mHttp[1], 10), useHttps: false };
        }
      }
      carry = start === 0 ? '' : lines[0];
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 透過 GET / 獲取 __APP_CONFIG__.csrfToken
 */
// The homepage is a small config shell; anything larger is not a config page.
const CSRF_RESPONSE_MAX_BYTES = 1024 * 1024;

/** @param {string} protocol @param {number} port @param {AbortSignal} [signal] @returns {Promise<string>} */
function fetchCsrfTokenFromWeb(protocol, port, signal) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('Language Server discovery deadline exceeded')),
      4000,
    );
    /** @param {Error|null} err @param {string} [token] */
    const finish = (err, token) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (err) reject(err);
      else if (token !== undefined) resolve(token);
      else reject(new Error('Missing CSRF token'));
    };
    const client = protocol === 'https:' ? https : http;
    const req = client.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'GET',
        rejectUnauthorized: false,
        signal: controller.signal,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > CSRF_RESPONSE_MAX_BYTES) {
            res.destroy();
            return finish(
              new Error(`Homepage response exceeded the ${CSRF_RESPONSE_MAX_BYTES}-byte limit`),
            );
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (res.statusCode !== 200)
            return finish(new Error(`Language Server HTTP ${res.statusCode}`));
          const body = Buffer.concat(chunks).toString('utf8');
          const m = body.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\});/);
          if (m) {
            try {
              const config = JSON.parse(m[1]);
              if (config.csrfToken) {
                return finish(null, config.csrfToken);
              }
            } catch {}
          }
          finish(new Error('Homepage response contains no csrfToken'));
        });
        res.on('error', finish);
      },
    );

    req.on('error', finish);
    req.end();
  });
}
