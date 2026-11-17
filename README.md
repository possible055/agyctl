# agyctl

English | [简体中文](README.zh-CN.md)

agyctl adds a context-usage panel to Antigravity desktop, plus optional tools for an input-toolbar usage capsule, interface localization, and context/tool-output patches. Current compatibility work targets stable Windows 2.32.1; each feature has its own admission and qualification status. Older records remain available for recognition and recovery.

## Features

| Feature | What it does | Modifies the app |
| --- | --- | --- |
| [Sidecar panel](#sidecar-panel) | Shows token usage, cost, sessions, and settings in a sidebar | No |
| [Input-toolbar capsule](#input-toolbar-capsule) | Shows live context usage next to the send button | Yes, `app.asar` |
| [Client localization](#client-localization) | Translates the interface into Traditional Chinese, Simplified Chinese, or Japanese | Yes, `app.asar` |
| [Context limit patch](#context-limit-patch) | Raises the context limit for selected models | Yes, `language_server.exe` |
| [Tool-output capacity patch](#tool-output-capacity-patch) | Raises recorded native tool-output limits on a qualified build | Yes, `language_server.exe` |
| [Summary compaction patch](#summary-compaction-patch) | Improves summary and request retention at context compaction on a qualified build | Yes, `language_server.exe` |
| [Compatibility checker](#compatibility-checker) | Checks whether your app version supports these features | No |

The capsule, localization, limit patch, tool-output patch, and compaction patch keep verified backups of the original files and can be removed.

The stable and development (Insiders) channels use the same commands below, with feature-specific admission checks. Compatibility is checked against the selected installation's files, not a version-number range; see [localization status](docs/localization.md#current-status) and [limit patch](docs/limit-patch.md). If you keep both channels, select one with `AGYCTL_APP_DIR`. After an Antigravity update, check feature status and prepare a new localization plan instead of applying an older plan or restoring another build's backup. A successful file patch is not proof of runtime activation.

## Get started

You need [Node.js](https://nodejs.org/) 26.x (26.13 or newer). Clone the project and install its dependencies; run every later command from this folder in PowerShell:

```powershell
git clone https://github.com/possible055/agyctl.git
cd agyctl
npm ci
```

agyctl automatically detects the default Antigravity installation. If yours is in a custom folder, or several installations exist, select the folder containing `Antigravity.exe`:

```powershell
$env:AGYCTL_APP_DIR = '<installation-root>'   # replace with your installation folder
```

This variable applies to this terminal. To reuse it in future terminals, optionally save it with `[Environment]::SetEnvironmentVariable('AGYCTL_APP_DIR', $env:AGYCTL_APP_DIR, 'User')`. Explicit command paths take priority; an invalid environment path fails instead of falling back. Multiple detected installations require a selection. `AGYCTL_HOME` is separate: it controls tool state and backups, not the app location. See [installation selection](docs/operations.md#installation-selection).

## Sidecar panel

The panel has three tabs. **Overview** shows token and cost totals for today, 7 days, or all time, with a per-model breakdown. **Sessions** lists your conversations. **Settings** edits language, refresh interval, model prices, and patches. Usage covers this app's local history, not your cloud account.

**Enable.** Quit Antigravity first, then run:

```powershell
npm run plugin:install
```

Reopen Antigravity and check that the panel appears in the sidebar.

**Remove.** Quit Antigravity first, then run:

```powershell
npm run plugin:uninstall
```

Reopen Antigravity and check that the panel is gone. The removed plugin folder is kept under `~/.gemini/config/plugin-backups/`; panel settings and pricing data are left intact.

### Patch controls

Build the patch tools first (Go 1.26 or newer is required), then quit Antigravity before updating the panel:

```powershell
npm run host:build
npm run localization:build
npm run tools:build
npm run plugin:install
```

Reopen Antigravity and use **Settings → Patches**. Installed values are filled in automatically. Expand **Model context limits** to choose models from the signed-in account's Language Server catalog; Gemini thinking-effort variants share one row. New rows start at 256,000 tokens and remain unchecked; the panel accepts 256,000–983,040 for new or changed values. The **Summary compaction patch** checkbox mirrors the [compaction patch](#summary-compaction-patch) and can be combined with model context limits on the exact registered 2.32.1 native target; legacy targets keep their conflict checks. Select the features, locale, and per-model limits, then press **Save settings** to save a draft without applying it. The panel does not display terminal commands. Follow [patch controls](docs/operations.md#panel-patch-controls) to find the draft ID, apply it with Antigravity closed, and handle unavailable models or recovery. Reopen after application finishes; settings are read back from the installed files. The commands below remain available as an alternative.

## Input-toolbar capsule

Shows context usage, cache-hit rate, and per-model ratios next to the send button.

**Enable.** Quit Antigravity first, then run:

```powershell
npm run capsule:build
npm run host-patch -- apply --capsule --capsule-code "$PWD\dist\capsule\input-capsule.js" --json
```

The output should include `"applied": true`, which confirms the archive was installed, not that the capsule activated. Reopen Antigravity and check that the capsule appears next to the send button.

**Remove.** Quit Antigravity first, then run:

```powershell
npm run host-patch -- remove --capsule --json
```

The JSON should list `capsule` in `removed`. Reopen Antigravity and check that the capsule is gone; any installed localization is preserved.

## Client localization

Translates the interface. Locales: `zh-Hant-TW`, `zh-Hans-CN`, `ja-JP`.

Uses the installation selected above, including `AGYCTL_APP_DIR`. The feature still checks the selected build before making changes.

**Enable.** In the panel, save the language draft, quit Antigravity, then run the
shown `npm run settings:apply -- --draft <id>` command. The same change can be
prepared from a terminal:

```powershell
npm run host:build
npm run localization:build
node scripts/manage.mjs prepare --localization --locale zh-Hant-TW
```

Copy the `localizationPlan` path from the output and apply it:

```powershell
node scripts/manage.mjs --host-apply --localization-plan '<localizationPlan path>'
```

The saved plan binds the exact installation; changing `AGYCTL_APP_DIR` does not retarget it. Reopen Antigravity and check the interface language. Current localization profiles are `probe-only`; successful installation is not real-client activation verification.

Installed-source preparation automatically selects the exact app version/platform, then verifies its reviewed assets and adapter anchors. Unknown versions refuse rather than selecting a nearby profile. The 2.32.1 profile includes SSH/MCP translations; three-locale native SSH picker/error checks passed on the installed client, while complete remote-session acceptance remains pending.

**Remove.** Quit Antigravity first, then run:

```powershell
npm run host-patch -- remove --localization --json
```

The JSON should list `localization` in `removed`. Reopen Antigravity and check that the original interface is restored; any installed capsule is preserved.

See the [localization guide](docs/localization.md) for details.

## Context limit patch

Sets independent candidate checkpoint floors for numeric model IDs, before later model and output clamps. For example, `1318=300000,1400=500000` keeps both settings in the same patch. These are not guaranteed effective context windows, and a floor does not lower an already larger candidate. IDs are build-specific enum values, not display names; do not infer an ID from a model name. See the [modification boundary](docs/limit-patch.md#modification-boundary).

This needs [Go](https://go.dev/dl/) 1.26 or newer. Build the CLI once:

```powershell
npm run tools:build
```

**Preview** (writes nothing):

```powershell
npm run limit:patch -- --model-limits '1318=300000,1400=500000'
```

**Enable.** Quit Antigravity first, then run:

```powershell
npm run limit:patch -- --model-limits '1318=300000,1400=500000' --apply
```

**Check.** `patch_state.kind` should be `patched`, and `patch_state.model_limits` should contain both ID/value pairs. Status decodes the installed bytes after every restart; it does not rely on remembering the previous command:

```powershell
npm run limit:status
```

The panel's Settings and the capsule's details also show the selected installation's on-disk patch state, separately from server-reported session capacity. Build the tools and install/update the panel for this shared read-only display; a missing panel or CLI is shown as unavailable, not as an applied patch.

To change an installed patch, quit Antigravity, restore it using the command below, then preview and apply the complete new mapping. The mapping replaces the selected model set; it does not merge with earlier IDs. `--model-limits` cannot be combined with legacy `--ids`/`--limit`. Legacy commands still accept one shared floor. With no settings flags, a patch command reuses detected installed settings or the saved last patch settings when applicable; otherwise it uses the built-in 500,000-token/default-ID combination. An explicit restore disables saved-setting reuse: pass the full mapping when applying again. An app update can remove the patch: `settings_state` distinguishes saved settings from current bytes, and nothing reapplies automatically.

**Remove.** Quit Antigravity first, then run:

```powershell
npm run limit:restore
```

Expect `restored: true` or `already_restored: true`. Run the status command again and confirm `patch_state.kind` is `original`, then reopen Antigravity.

## Tool-output capacity patch

Raises recorded Language Server limits for native tool outputs: Read (2,000 lines / 128 KiB), legacy `grep_search` (100 results), and the post-merge message-conversion budget floor (98,304). These are qualification targets, not proven maxima. Windows 2.31.2 retains its legacy recipe and grep fixes; the Windows 2.32.1 candidate contains only the relocated capacity/floor segments, with live `read_file` line/byte capacity and model-visible delivery verified; legacy grep remains unobserved on the current toolset. The installed app version selects the recipe before the exact whole-file hash gate. See [the recipe and evidence](docs/tool-output-patch.md).

```powershell
npm run tool-output:status    # on-disk state of the selected installation
npm run tool-output:patch     # plan in memory; writes nothing
npm run tool-output:patch -- --apply    # quit Antigravity first
npm run tool-output:restore   # back to the exact patched-from input
```

Applying and restoring require the client to be closed, verified backups, and an explicit `--binary` when several installations exist. The patch never relaxes other tools' settings. The registered 2.32.1 target composes L/T/C through one native transaction; legacy conflicting images refuse instead of being overwritten. App updates do not reapply anything.

## Summary compaction patch

On Windows 2.32.1, the registered recipe patches final summary/retention consumers, preserving native M432 and custom prompts. Gemini 3.8 Flash High has live-verified manual and natural automatic adoption, 30-request capture, and native UTF-8 rendering capped at 2,048 bytes per request while keeping lower native budgets. Raw stored checkpoint text can be larger. Thresholds and `/compact` remain native. Qualification is limited to the recorded model route, not every model. The legacy 2.31.2 recipe remains experimental: its replacement prompt was not adopted live. See [build-specific evidence](docs/compaction-patch.md) and [workflow](docs/operations.md#summary-compaction-patch).

```powershell
npm run compaction:status    # on-disk state of the selected installation
npm run compaction:patch     # plan in memory; writes nothing
npm run compaction:patch -- --apply    # quit Antigravity first
npm run compaction:restore   # back to the exact patched-from input
```

Applying and restoring follow the same closed-client, verified-backup, and explicit-`--binary` rules as the other binary patches, and share the same mutation lock. On the exact registered 2.32.1 target, limit, tool-output, and compaction share one native transaction and support independent removal and limit changes. Legacy builds keep their original conflict and recovery checks. App updates do not reapply anything. The panel uses the same native admission and reviewed-plan checks; see [native composition](docs/operations.md#native-feature-composition).

## Compatibility checker

Run this after Antigravity updates, before you enable a feature that modifies the app. It needs [Go](https://go.dev/dl/) 1.26 or newer and the CLI built with `npm run tools:build`. Read each capability and its diagnostics: `needs-review` means at least one warning, including a `probe-only` localization profile, not that every feature is unusable. The checker is advisory; each feature's own preflight decides whether it can modify the selected files. `compatible` does not prove runtime activation.

```powershell
npm run update-check:local
```

To check the latest official installer instead:

```powershell
npm run update-check:check -- --channel hub --platform win-x64
```

See the [checker guide](docs/update-check.md).

## Update agyctl

Quit Antigravity before replacing the installed panel, then run:

```powershell
git pull
npm ci
npm run plugin:install
npm run tools:build   # if you use patch controls, a binary patch, or the checker
```

Reopen Antigravity after installation.

## Backups

On Windows, original app files are kept in `%LOCALAPPDATA%\agyctl\backups\` by default; `AGYCTL_HOME` changes the tool-state root. The limit patch also keeps an original beside the Language Server, and panel backups live separately under `~/.gemini/config/plugin-backups/`. Do not delete or overwrite originals needed for removal. See [backup locations](docs/operations.md#backup-locations) for every platform and [recovery](docs/operations.md#recovery-boundaries).

## Documentation

- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md): targets, backups, and recovery
- [Localization](docs/localization.md)
- [Compatibility checker](docs/update-check.md)
- [Limit patch](docs/limit-patch.md)
- [Tool-output patch](docs/tool-output-patch.md)
- [Summary compaction patch](docs/compaction-patch.md)
- [Development](docs/development.md): setup, tests, and project layout

## License

MIT. See [LICENSE](LICENSE).
