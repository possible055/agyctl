# agyctl

English | [简体中文](README.zh-CN.md)

A sidecar plugin for the Google Antigravity desktop client that shows live context-window usage, server-side token counts, and generation-rate estimates. The panel reads the local Language Server over Connect-RPC and does not modify the client.

Three optional features modify the installed client: the capsule, client localization, and the limit patcher. Each keeps a verified original backup and has its own removal or restore command.

| Component | Purpose | Modifies the client |
| --- | --- | --- |
| Sidecar panel | Usage, sessions, prices, and settings; lists the terminal commands for the optional modifications | No; it only displays those commands and runs none of them |
| Input-toolbar capsule | Context usage beside the send button | Yes, `app.asar` |
| Client localization | Translate the Antigravity interface; prepared and applied with `node scripts/manage.mjs` ([guide](docs/localization.md)) | Yes, `app.asar` |
| Context limit patcher | Raise per-model checkpoint token limits | Yes, `language_server.exe` |
| Compatibility checker | Inspect installed clients or official installers | No, verification only |

## Status and compatibility

Version 0.1.0 (`package.json`).

- **Target clients:** Antigravity app stable and development (Insiders) channels.
- **Client modifications:** applied from the CLI with Antigravity closed; the panel only monitors. Paths in this README use Windows notation.
- **Compatibility checking:** inspects official Hub and Insiders installers for Windows x64, Linux x64, and macOS Apple Silicon.
- **Limit patcher:** admits a binary only when its clamp bytes match an original recorded in [compat/versions.json](compat/versions.json), regardless of version. `npm run limit:versions` lists the recorded builds; each entry's `notes` states its verification level (static, read-only dry-run, or live). The selected binary's `compat.status` (`verified-exact`, `version-match`, or `unverified`) is informational and does not change that gate.

## Quick start

Requires Node.js 26.13 or a newer 26.x release. Run all commands in this guide from the project root. To install the panel:

```bash
npm ci
npm run plugin:install
```

After installation, reload the plugin through the host's supported lifecycle or quit and reopen Antigravity normally. Installation does not confirm activation; open the panel to verify it loaded. There is no dedicated panel removal script.

The installer validates and stages the plugin under `%USERPROFILE%\.gemini\config\plugin-backups\`, then switches it into `%USERPROFILE%\.gemini\config\plugins\agyctl\`. Previous and failed installations stay outside the discovery directory, so the host never loads duplicates.

The sidebar has **Overview**, **Sessions**, and **Settings**:

- **Overview** — token and cost totals across local conversations (today, 7 days, or all), the input/cache/thinking/output mix, a 14-day chart, and per-model usage. Subagent usage rolls into its parent session.
- **Sessions** — a searchable session list.
- **Settings** — panel language, refresh interval, custom model prices (USD per million tokens), and the terminal commands for optional client modifications. Settings never changes the client.

Usage totals cover the local history of the running client, not a cloud account total.

## Prepare the tools

The panel never changes the installed client. The capsule, the context limit, and localization are applied from a terminal in the project folder, with Antigravity closed. Each command checks the installed files first and writes nothing it does not recognize.

CLI limit commands and compatibility checks need a built `agyctl` executable. With Go 1.26 or newer installed, run:

```bash
npm ci
npm run tools:build
```

Skip `npm ci` if dependencies are already installed. `.npmrc` sets `ignore-scripts=true`, so dependency installation runs no lifecycle scripts. The build writes `dist/bin/<goos>-<goarch>/agyctl` (`.exe` on Windows). It reads `compat/` from this checkout, so run it through the `npm run limit:*` and `npm run update-check:*` scripts. Panel monitoring, language/pricing settings, and capsule-only commands do not need this Go build.

To update the project, pull the repository, run `npm ci` and `npm run plugin:install`, and rebuild the tools when `src/agyctl/` changed.

## Use the CLI

### Install or remove the input-toolbar capsule

The capsule shows live context usage next to the send button, plus session cache-hit rate, per-model dispatch ratios, and a main-agent/subagent switcher. Run `npm ci` first if dependencies are not installed; the npm Capsule commands build their required Host bundles automatically.

**Confirm the target before installing or removing.** Ordinary Capsule commands have no standalone target-selection flag: they select the first detected installation, currently Insiders before Hub. When both are installed, use the [reviewed Host commands](docs/operations.md#reviewed-host-changes) for explicit-target installation/removal. Do not assume the target is the currently running client.

To install, run the following command. It writes immediately; there is no default dry run:

```bash
npm run capsule:install
```

Installation refuses a client whose served web bundle no longer contains the anchors the capsule mounts on, and names the missing ones; nothing is written in that case. After a successful install, reopen the target client normally and check that the capsule appears: a verified archive does not prove the capsule mounted. Changes that add, remove, or preserve localization refuse while the client is running. A capsule-only install or removal does not check the client process, so close the target client yourself first and reopen it afterwards.

To remove it, confirm the target again, then run:

```bash
npm run capsule:uninstall
```

Removal preserves any localization. Reopen the target client afterwards. The installer keeps an immutable, installation-specific original backup paired by hash; removal requires a matching pair and `--force` cannot bypass pairing. See [capsule backups](docs/operations.md#capsule-backups).

### Adjust or restore the context limit

The patch raises a per-model candidate checkpoint limit before the replacement's later clamps. It rewrites the admitted clamp body and model-ID table, not remote profiles or other configuration functions. This does not prove a larger effective window or unchanged end-to-end compaction behavior. See [the binary analysis](docs/context-chain-analysis.md).

#### Check and preview

First [build the tools](#prepare-the-tools). The following PowerShell example explicitly targets the default Windows Insiders installation. Change `$binary` before proceeding if you intend to modify Hub or a different install path. Keep the same terminal and target for preview, apply, verification, and restore.

```powershell
$binary = Join-Path $env:LOCALAPPDATA 'Programs\antigravity-insiders\resources\bin\language_server.exe'
npm run limit:versions
npm run limit:status -- --binary "$binary"
npm run limit:patch -- --binary "$binary"
```

Check `binary`, `app_version`, `compat`, and `patch_state` in the status JSON. The patch command defaults to a dry run: expect `dry_run: true`, `applied: false`, and a `plan` for an original binary. The installed function must match a recorded original byte signature; a version string alone does not authorize patching.

Without `--binary`, limit commands select the first discovered Language Server, currently Insiders before Hub. Optional `--ids` and `--limit` values must be identical in preview and apply. Defaults are IDs `1318-1320,1400-1405,1417-1419` and `500000` tokens. An existing identical patch returns `already_patched: true`; different settings require restoring first.

#### Apply

Save your work and quit the selected Antigravity installation normally. Apply refuses while that installation's client or Language Server is running or its state cannot be confirmed. Another installation's server does not block this target. This CLI does not close or relaunch the client. Only after reviewing the preview and confirming the target, run:

```powershell
npm run limit:patch -- --binary "$binary" --apply
```

#### Verify and reopen

Expect `applied: true` and a backup record, or `already_patched: true` for an unchanged identical patch. Recheck the installed file:

```powershell
npm run limit:status -- --binary "$binary"
```

Confirm `patch_state.kind` is `patched`, its `ids` and `limit` match your request, and inspect `sibling_backup.verified` and `repo_backup.verified`. Then reopen Antigravity normally.

#### Restore when needed

To undo the patch or change its settings, save your work and quit Antigravity again. Restore writes immediately and checks the backup checksum; it refuses to overwrite a binary replaced by an application update.

```powershell
npm run limit:restore -- --binary "$binary"
```

Expect `restored: true` or `already_restored: true`, then run the status command above and confirm `patch_state.kind` is `original`. Reopen the client, or preview a new patch before applying different settings.

Backups live in `%LOCALAPPDATA%\agyctl\backups\` on Windows, `~/Library/Application Support/agyctl/backups/` on macOS, and `$XDG_STATE_HOME/agyctl/backups/` on Linux (`~/.local/state` when `XDG_STATE_HOME` is unset). `AGYCTL_HOME` overrides the product home.

### Check compatibility

[Build the tools](#prepare-the-tools) first. The checker inspects an installed client or downloads and unpacks official installers to check context limits, model catalogs, and capsule hook points. It writes reports, but never installs patches or runs extracted content. This is a separate CLI task.

For an installed client, choose the channel explicitly (`insiders` or `antigravity` for Hub):

```bash
npm run update-check:local -- --channel insiders
```

Use `--install-dir` for an explicit installation root. Without a target, local checking selects the first detected installation, currently Insiders before Hub. The check reads only the selected installed files and never contacts a running client.

For downloaded installers, channel names instead include `hub`. Without `--channel` and `--platform`, `check` inspects Hub for the platform of the machine running it; name both to inspect another target:

```bash
npm run update-check:versions
npm run update-check:check -- --channel hub --platform win-x64
```

For every combination of the two channels (Hub, Insiders) and three platforms (`win-x64`, `darwin-arm64`, `linux-x64`), run:

```bash
npm run update-check:check -- --matrix
```

Read the JSON result and saved report under `var/update-check/reports/`. Verdicts are `compatible`, `needs-review`, or `incompatible` (exit codes 0, 1, 2; `--matrix` returns the worst cell; 3 means the check itself failed). A verdict is screening, not proof of live activation or authorization to patch: each feature runs its own exact gate when applied, and `node scripts/manage.mjs status` reports those gates read-only for an installed client. See [the checker guide](docs/update-check.md).

## Data sources and accuracy

- Token counts come from the Language Server: prompt, cache read, thinking, and response output. They never fall back to local estimates.
- Rates (streaming tok/s, request throughput, TTFT, total time, recent same-model average) are estimates from Language Server timings, not engine-side model speed. Unconfirmed or sub-second windows are marked.
- The capsule's per-source composition breakdown is estimated from customization counts and labeled as an estimate.
- Stale values, incomplete history, unknown capacity, and missing prices are shown as such.
- Runtime monitoring uses no CDP and opens no remote debugging port.

## Development

Node.js 26.13 or a newer 26.x release (`.nvmrc`, `engines`). Development tools: Go 1.26 or newer, optional `uv` for isolated hook launching, and `gitleaks` / `golangci-lint` v2.x on `PATH` for their checks. No project Python environment is required.

```bash
npm ci
uvx pre-commit install
```

Choose the smallest relevant check for the change; these are available commands,
not a mandatory full local gate. Hooks run changed-file hygiene and security;
[affected CI jobs](.github/README.md) run correctness suites.

```bash
npm run lint
npm test                  # prepares core artifacts and runs the core Node suite
npm run test:run           # same suite, using existing artifacts
npm run test:localization  # builds localization and runs its suite
npm run typecheck
npm run host:typecheck
npm run tools:test
npm run test:vendor-sync   # optional: checks the recorded vendor-src snapshot
npm run test:electron      # optional: pinned Electron 44.10.2 and OpenSSL on PATH
```

A test whose prerequisite is missing (an installed client, Electron, built localization artifacts, the `vendor-src` snapshot, or a real sample) reports **SKIP** with the reason; a skip is never reported as a pass. Read the skips before trusting a green run: for example, the localization cases in the Host suite skip unless `npm run test:localization` (or `npm run localization:build`) has built `dist/localization`. Set `AGYCTL_ELECTRON_EXECUTABLE` to use an Electron binary other than the installed devDependency.

The capsule ships as one self-contained file. Shared logic lives in the ES modules under `src/plugin/lib/` (`metrics-core.mjs` and `pricing-core.mjs` are the shared telemetry and pricing logic) and is assembled into the capsule by `scripts/capsule-build.mjs`. `capsule:install` assembles the same sources again in memory, so it never installs a stale `dist` file:

```bash
npm run capsule:build       # regenerate dist/capsule/input-capsule.js (build output; do not edit)
```

| Path | Purpose |
| --- | --- |
| `src/plugin/` | Sidecar panel and shared telemetry logic |
| `src/capsule/` | Input-toolbar capsule sources |
| `src/host/` | Neutral ASAR composition, backups, receipts, transactions, and tooling logs |
| `src/localization/` | Localization transforms, runtime delivery, and its Host feature |
| `src/agyctl/` | Go CLI: compatibility checker and limit patcher |
| `scripts/` | Build, install, and Host entry points |
| `compat/` | Signatures, install layout, localization profiles |
| `tests/` | Node and Electron suites; Go tests sit beside their packages |
| `docs/` | Architecture, operations, localization, checker, and reverse-engineering references |

## Documentation

- [docs/architecture.md](docs/architecture.md) — stable component boundaries and data flow
- [docs/operations.md](docs/operations.md) — client modifications, panel settings, backups, recovery, and localization apply
- [docs/localization.md](docs/localization.md) — localization stages, recorded profiles, offline preparation, and real-client evidence
- [docs/update-check.md](docs/update-check.md) — compatibility checker pipeline
- [docs/context-chain-analysis.md](docs/context-chain-analysis.md) — context-limit byte evidence and patch/recovery boundaries
- [docs/upstream-analysis.md](docs/upstream-analysis.md) — inspected upstream builds, package-member locators, and reproducible shell/web-asset analysis
- [docs/development.md](docs/development.md) — toolchain pinning and supply chain

## License

`package.json` declares the MIT license.
