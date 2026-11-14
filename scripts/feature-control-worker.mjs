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

const {
  applyFeatureDraft,
  cancelFeatureApply,
  preflightFeatureDraft,
  queueFeatureApply,
  readFeatures,
  runFeatureOperation,
} = await import('./lib/feature-control.mjs');
const { readModelCatalog } = await import('./lib/model-catalog.mjs');

async function input() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (Buffer.byteLength(text) > 32768) throw new Error('Feature selection is too large');
  }
  return JSON.parse(text);
}

try {
  const [action, ...args] = process.argv.slice(2);
  let result;
  if (action === 'run' && args.length === 2) {
    await runFeatureOperation(args[0], args[1]);
  } else if (args.length !== 0) throw new Error('Invalid feature-control arguments');
  else if (action === 'status') result = await readFeatures();
  else if (action === 'models') result = await readModelCatalog();
  else if (action === 'queue') result = await queueFeatureApply(await input());
  else if (action === 'cancel') result = await cancelFeatureApply(await input());
  else if (action === 'preflight') result = await preflightFeatureDraft((await input()).id);
  else if (action === 'apply-draft') result = await applyFeatureDraft((await input()).id);
  else throw new Error('Invalid feature-control action');
  if (result) console.log(JSON.stringify(result));
} catch (error) {
  console.log(
    JSON.stringify({
      code: error.safeForPanel ? error.code : 'FEATURE_UNAVAILABLE',
      error: error.safeForPanel
        ? error.message
        : 'Feature control is unavailable; rebuild tools and reload',
    }),
  );
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
