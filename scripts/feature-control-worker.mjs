if (process.versions.electron) {
  // Electron virtualizes ASAR files and shares the client's process identity.
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const probe = spawnSync('node', ['-p', 'process.versions.electron ? "" : process.execPath'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    maxBuffer: 65536,
  });
  const executable = probe.stdout?.trim();
  if (probe.error || probe.status !== 0 || !executable) {
    console.log(
      JSON.stringify({
        code: 'FEATURE_UNAVAILABLE',
        error: 'Node.js is unavailable; install Node.js and reopen Antigravity',
      }),
    );
    console.error(probe.error?.stack ?? probe.stderr ?? 'A standalone Node.js runtime is required');
    process.exit(1);
  }
  const result = spawnSync(executable, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error(result.error.stack ?? String(result.error));
  process.exit(result.status ?? 1);
}

import readline from 'node:readline';

const {
  applyFeatureDraft,
  cancelFeatureApply,
  preflightFeatureDraft,
  queueFeatureApply,
  readFeatures,
  runFeatureOperation,
} = await import('./lib/feature-control.mjs');
const { readModelCatalog } = await import('./lib/model-catalog.mjs');

const MAX_PAYLOAD_BYTES = 32768;

async function input() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES)
      throw new Error('Feature selection is too large');
  }
  return JSON.parse(text);
}

function failureOutput(error) {
  return {
    code: error.safeForPanel ? error.code : 'FEATURE_UNAVAILABLE',
    error: error.safeForPanel
      ? error.message
      : 'Feature control is unavailable; rebuild tools and reload',
  };
}

async function dispatch(action, payload) {
  if (action === 'status') return readFeatures();
  if (action === 'models') return readModelCatalog();
  if (action === 'queue') return queueFeatureApply(payload);
  if (action === 'cancel') return cancelFeatureApply(payload);
  if (action === 'preflight') return preflightFeatureDraft(payload.id);
  if (action === 'apply-draft') return applyFeatureDraft(payload.id);
  throw new Error('Invalid feature-control action');
}

const [action, ...args] = process.argv.slice(2);

if (action === undefined) {
  // Persistent mode: one JSON request object per stdin line, one JSON response
  // object per line. Used by the panel so process-local caches survive across
  // reads; exits when stdin closes and no request is in flight.
  let inFlight = 0;
  let closing = false;
  const maybeExit = () => {
    if (closing && inFlight === 0) process.exit(0);
  };
  const respond = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  };
  const handleLine = async (line) => {
    if (!line.trim()) return;
    let request;
    try {
      if (Buffer.byteLength(line) > MAX_PAYLOAD_BYTES)
        throw new Error('Feature selection is too large');
      request = JSON.parse(line);
    } catch (error) {
      respond({ id: null, ok: false, ...failureOutput(error) });
      return;
    }
    inFlight += 1;
    try {
      const result = await dispatch(request.action, request.payload);
      respond({ id: request.id, ok: true, result });
    } catch (error) {
      respond({ id: request.id, ok: false, ...failureOutput(error) });
      console.error(error.stack ?? String(error));
    } finally {
      inFlight -= 1;
      maybeExit();
    }
  };
  readline
    .createInterface({ input: process.stdin, terminal: false })
    .on('line', (line) => void handleLine(line))
    .on('close', () => {
      closing = true;
      maybeExit();
    });
} else {
  try {
    let result;
    if (action === 'run' && args.length === 2) {
      await runFeatureOperation(args[0], args[1]);
    } else if (args.length !== 0) throw new Error('Invalid feature-control arguments');
    else if (action === 'status') result = await dispatch(action);
    else if (action === 'models') result = await dispatch(action);
    else if (action === 'queue') result = await dispatch(action, await input());
    else if (action === 'cancel') result = await dispatch(action, await input());
    else if (action === 'preflight') result = await dispatch(action, await input());
    else if (action === 'apply-draft') result = await dispatch(action, await input());
    else throw new Error('Invalid feature-control action');
    if (result) console.log(JSON.stringify(result));
  } catch (error) {
    console.log(JSON.stringify(failureOutput(error)));
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
