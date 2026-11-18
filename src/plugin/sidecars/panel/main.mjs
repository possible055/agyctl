import { cancelFeatureApply, queueFeatureApply, readFeatures } from './feature-control.mjs';
import { readContextLimitDiagnostics } from './limit-diagnostics.mjs';
import { readLimitStatus } from './limit-status.mjs';
import { renderPanelPage } from './page.mjs';
import { readPricingStatus, repairPricing, savePricing } from './pricing.mjs';
import { readSettings, saveSettings } from './settings.mjs';
import { getUsageOverview } from './usage.mjs';

// 動態嘗試載入 sidecar_sdk (Antigravity 運行時自動解析)
let SidecarApp;
let SidecarResponse;
let productionSdk = false;
try {
  const sdk = await import('sidecar_sdk');
  SidecarApp = sdk.SidecarApp;
  SidecarResponse = sdk.Response;
  productionSdk = true;
} catch (e) {
  if (
    e.code !== 'ERR_MODULE_NOT_FOUND' ||
    !e.message.includes("'sidecar_sdk'") ||
    process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN
  )
    throw e;
  // 本地獨立除錯模擬 Shim
  console.log('[agyctl] sidecar_sdk not found, using lightweight mock for standalone dev');
  SidecarResponse = class {
    constructor(body, options) {
      Object.assign(this, options, { body });
    }
  };
  SidecarApp = class MockSidecarApp {
    constructor() {
      this.pages = new Map();
      this.apis = new Map();
    }
    page(path, handler) {
      this.pages.set(path, handler);
    }
    api(path, handler, method = 'GET') {
      this.apis.set(`${method}:${path}`, handler);
    }
    run() {
      import('node:http').then(({ createServer }) => {
        const port = process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 8787;
        const server = createServer(async (req, res) => {
          const url = new URL(req.url, `http://localhost:${port}`);
          const host = new URL(`http://${req.headers.host}`);
          if (!['localhost', '127.0.0.1', '[::1]'].includes(host.hostname)) {
            res.writeHead(403);
            return res.end('Invalid host');
          }
          if (this.pages.has(url.pathname)) {
            const html = this.pages.get(url.pathname)();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end(html);
          }
          const apiKey = `${req.method}:${url.pathname}`;
          if (this.apis.has(apiKey)) {
            const handler = this.apis.get(apiKey);
            try {
              let queryData = Object.fromEntries(url.searchParams.entries());
              if (req.method !== 'GET') {
                if (
                  req.headers['x-agyctl-action'] !== '1' ||
                  req.headers['content-type'] !== 'application/json' ||
                  (req.headers.origin && req.headers.origin !== host.origin)
                ) {
                  res.writeHead(403);
                  return res.end('Same-origin JSON action required');
                }
                const chunks = [];
                let bodyBytes = 0;
                for await (const chunk of req) {
                  chunks.push(chunk);
                  bodyBytes += chunk.length;
                  const maxBytes =
                    url.pathname === '/api/pricing'
                      ? 65536
                      : url.pathname === '/api/features/apply'
                        ? 32768
                        : 16384;
                  if (bodyBytes > maxBytes) {
                    throw new Error('Request body too large');
                  }
                }
                queryData = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              }
              const result = await handler(queryData);
              if (result instanceof SidecarResponse) {
                res.writeHead(result.status || 200, {
                  'Content-Type': result.contentType,
                  ...result.headers,
                });
                return res.end(result.body);
              }
              res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              return res.end(JSON.stringify({ error: err.message }));
            }
          }
          res.writeHead(404);
          res.end('Not found');
        });
        server.listen(port, '127.0.0.1', () => {
          console.log(`[agyctl Mock Server] Listening on http://localhost:${port}`);
        });
      });
    }
  };
}

const app = new SidecarApp();

app.api(
  '/api/limit-status',
  async () =>
    new SidecarResponse(JSON.stringify(await readLimitStatus()), {
      contentType: 'application/json; charset=utf-8',
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    }),
  'GET',
);

// 靜態頁面路由
app.page('/', () => renderPanelPage());

const handle = (action) => async (data) => {
  try {
    return await action(data);
  } catch (error) {
    return {
      error: error.message,
      ...(typeof error.code === 'string' ? { code: error.code } : {}),
    };
  }
};

const featureAction = (action) =>
  handle((data) => {
    if (productionSdk && !process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN?.trim()) {
      throw Object.assign(new Error('Patch controls are unavailable in this host'), {
        code: 'FEATURE_UNAVAILABLE',
      });
    }
    return action(data);
  });

app.api(
  '/api/features',
  handle((data) => readFeatures({ fresh: data?.fresh === '1' || data?.fresh === true })),
  'GET',
);
app.api(
  '/api/features/apply',
  featureAction((data) => queueFeatureApply(data)),
  'POST',
);
app.api(
  '/api/features/cancel',
  featureAction((data) => cancelFeatureApply(data)),
  'POST',
);

app.api(
  '/api/usage',
  handle(() => getUsageOverview()),
  'GET',
);
app.api(
  '/api/usage/refresh',
  handle(() => getUsageOverview({ refresh: true })),
  'POST',
);
app.api(
  '/api/pricing',
  async () => {
    const result = readPricingStatus();
    return new SidecarResponse(JSON.stringify(result), {
      contentType: 'application/json; charset=utf-8',
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' },
    });
  },
  'GET',
);
app.api(
  '/api/pricing/repair',
  handle((data) => {
    const saved = repairPricing(data);
    void getUsageOverview({ refresh: true }).catch((error) =>
      console.error('[agyctl] Pricing repair refresh:', error.message),
    );
    return saved;
  }),
  'POST',
);
app.api(
  '/api/pricing',
  handle((data) => {
    const saved = savePricing(data);
    void getUsageOverview({ refresh: true }).catch((error) =>
      console.error('[agyctl] Pricing refresh:', error.message),
    );
    return saved;
  }),
  'POST',
);
app.api(
  '/api/settings',
  handle(() => ({ settings: readSettings() })),
  'GET',
);
app.api(
  '/api/settings',
  handle((data) => {
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('Only the refresh interval can be saved');
    return { settings: saveSettings({ ...readSettings(), ...data }) };
  }),
  'POST',
);
app.api(
  '/api/diagnostics',
  handle(() => readContextLimitDiagnostics()),
  'GET',
);

app.run();
