#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const argv = process.argv.slice(2);
const help = `Usage: agyctl <command> [options]

Commands:
  install       Install selected features (default: panel only)
  uninstall     Remove selected features (default: panel only)
  status        Inspect all features without changing the client
  models        List account model choices while the client is running
  settings      Forward panel settings draft commands: preflight|apply|status
  native, limit, tool-output, compaction, check
                Forward commands to the packaged native tool

Feature options for install/uninstall:
  --all                     Select all features
  --panel                   Sidecar panel plugin
  --capsule                 Input-toolbar capsule
  --localization            Client localization (default locale: zh-Hant-TW)
  --locale LOCALE            Select localization; canonical locale required
  --model-limits ID=LIMIT,... Explicit model limits; --limit is an alias
  --limit                   With uninstall, remove only context-limit patches
  --tool-output             Tool-output patch
  --compaction              Summary-compaction patch
  --prompt-mode native      Select compaction with its registered native prompt

Shared options:
  --asar ABS_PATH           Select installed resources/app.asar
  --dry-run                 Plan install/uninstall without changing client files
  --json                    Print structured output
  --help                    Show this help
  --version                 Show the package version

Examples:
  agyctl install
  agyctl install --all --model-limits 1318=500000 --locale zh-Hant-TW
  agyctl install --all --dry-run --json
  agyctl uninstall --all
  agyctl status --json

--all installation requires explicit model limits or a verified current/saved mapping.
Model IDs are not inferred from names; disabled account models are not unlocked.
Close the selected Antigravity client and Language Server before installation/removal.
No command automatically closes or restarts the client. Backups and user data are retained.
Dry runs may prepare tool-state artifacts, but never modify installed client files.
On partial failure, inspect the reported operation journal, then rerun the same command.
Run agyctl uninstall --all before npm uninstall -g agyctl to remove client features.`;

try {
  if (argv.length === 0 || (argv.length === 1 && ['--help', '-h'].includes(argv[0]))) {
    console.log(help);
  } else if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) {
    console.log(JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version);
  } else if (['native', 'limit', 'tool-output', 'compaction', 'check'].includes(argv[0])) {
    const { runAgyctl } = await import('../scripts/lib/agyctl.mjs');
    console.log(JSON.stringify(runAgyctl(argv), null, 2));
  } else if (argv[0] === 'settings') {
    const child = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('scripts/settings.mjs', root)), ...argv.slice(1)],
      { stdio: 'inherit', windowsHide: true },
    );
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } else {
    const { executeInstaller, parseInstallerArgs } = await import('../scripts/lib/installer.mjs');
    const options = parseInstallerArgs(argv);
    const result = await executeInstaller(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.command}: ${result.state}`);
      console.log(`Target: ${result.target.asarPath}`);
      console.log(JSON.stringify(result.features ?? result.desired, null, 2));
      if (result.journal) console.log(`Operation journal: ${result.journal}`);
      if (result.process?.languageServerRunning === true)
        console.log('Close this Antigravity installation before applying changes.');
      for (const issue of result.errors ?? []) console.error(`${issue.component}: ${issue.error}`);
    }
  }
} catch (error) {
  if (argv.includes('--json'))
    console.log(
      JSON.stringify(
        { error: error.message, code: error.code ?? 'INSTALLER_REFUSED', ...error.installerResult },
        null,
        2,
      ),
    );
  else console.error(error.message);
  process.exitCode = 1;
}
