# agyctl

English | [简体中文](README.zh-CN.md)

agyctl targets Antigravity 2.31.0 desktop (stable release), adding a context-usage panel plus optional tools that change the app: an input-toolbar usage capsule, interface localization, and a higher context limit. Older compatibility records are historical evidence, not current acceptance targets.

## Features

| Feature | What it does | Modifies the app |
| --- | --- | --- |
| [Sidecar panel](#sidecar-panel) | Shows token usage, cost, sessions, and settings in a sidebar | No |
| [Input-toolbar capsule](#input-toolbar-capsule) | Shows live context usage next to the send button | Yes, `app.asar` |
| [Client localization](#client-localization) | Translates the interface into Traditional Chinese, Simplified Chinese, or Japanese | Yes, `app.asar` |
| [Context limit patch](#context-limit-patch) | Raises the context limit for selected models | Yes, `language_server.exe` |
| [Compatibility checker](#compatibility-checker) | Checks whether your app version supports these features | No |

The capsule, localization, and limit patch keep a verified backup of the original files and can be removed.

Both versions use the same commands below. Compatibility is checked against the selected installation's files, not a version-number range; see [localization evidence](docs/localization.md) and [limit patch](docs/limit-patch.md). If you keep both versions, select one with `AGYCTL_APP_DIR`. After an Antigravity update, check feature status and prepare a new localization plan instead of applying an older plan or restoring another build's backup. A successful file patch is not proof of runtime activation.

## Get started

You need [Node.js](https://nodejs.org/) 26.x (26.13 or newer). Clone the project and install its dependencies; run every later command from this folder in PowerShell:

```powershell
git clone https://github.com/possible055/agyctl.git
cd agyctl
npm ci
```

agyctl automatically detects the default Antigravity installation. If yours is in a custom folder, or several installations exist, select the folder containing `Antigravity.exe`:

```powershell
$env:AGYCTL_APP_DIR = 'D:\Apps\Antigravity'   # only for a custom or explicit installation
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

Reopen Antigravity and use **Settings → Patches**. Installed values are filled in automatically. Models come from the signed-in account's Language Server catalog and are matched to the selected installation's numeric enum IDs; choose models by name, including their Low/Medium/High variants. New rows start at 256,000 tokens and remain unchecked; the panel accepts 256,000–896,000. Select the features, locale, and per-model limits, then press **Save settings**. Quit Antigravity yourself and run the shown `npm run settings:apply -- --draft <id>` command. The tool applies the selected changes without closing or restarting the app. Reopen after application finishes; settings are read back from the installed files. See [patch controls](docs/operations.md#panel-patch-controls) for unavailable models, pending operations, and recovery. The commands below remain available as an alternative.

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
npm run tools:build   # only if you use the limit patch or the checker
```

Reopen Antigravity after installation.

## Backups

By default, original app files are kept in `%LOCALAPPDATA%\agyctl\backups\`; `AGYCTL_HOME` changes the tool-state root. The limit patch also keeps an original beside the Language Server, and panel backups live separately under `~/.gemini/config/plugin-backups/`. Do not delete or overwrite originals needed for removal. See [backups and recovery](docs/operations.md#recovery-boundaries).

## Documentation

- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md): targets, backups, and recovery
- [Localization](docs/localization.md)
- [Compatibility checker](docs/update-check.md)
- [Limit patch](docs/limit-patch.md)
- [Development](docs/development.md): setup, tests, and project layout

## License

MIT. See [LICENSE](LICENSE).
