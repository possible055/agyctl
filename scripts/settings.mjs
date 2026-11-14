import { applyFeatureDraft, preflightFeatureDraft, readFeatures } from './lib/feature-control.mjs';

function usage() {
  return 'Usage: node scripts/settings.mjs preflight|apply|status --draft DRAFT_ID [--cleanup-sidecars]';
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['preflight', 'apply', 'status'].includes(command)) throw new Error(usage());
  let draft;
  let cleanupSidecars = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--cleanup-sidecars') {
      cleanupSidecars = true;
      continue;
    }
    if (flag === '--draft') {
      const value = rest[++index];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --draft');
      draft = value;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (command !== 'status' && !draft)
    throw new Error('preflight and apply require --draft DRAFT_ID');
  if (command === 'status' && draft) throw new Error('status does not take --draft');
  return { command, draft, cleanupSidecars };
}

try {
  const { command, draft, cleanupSidecars } = parseArgs(process.argv.slice(2));
  const result =
    command === 'status'
      ? await readFeatures()
      : command === 'preflight'
        ? await preflightFeatureDraft(draft, { cleanupSidecars })
        : await applyFeatureDraft(draft, { cleanupSidecars });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(
    JSON.stringify(
      {
        code: error.safeForPanel ? error.code : 'FEATURE_UNAVAILABLE',
        error: error.safeForPanel ? error.message : error.message,
      },
      null,
      2,
    ),
  );
  console.error(error.stack ?? String(error));
  process.exitCode = 1;
}
