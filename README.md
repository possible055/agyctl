# agyctl

English | [简体中文](README.zh-CN.md)

agyctl adds a context-usage panel to the Antigravity desktop app, plus optional tools that modify the installed app: an input-toolbar usage capsule, interface localization, and Language Server patches for the context limit, tool-output capacity, and summary compaction. The current target is Antigravity 2.33.0 for Windows (stable channel). Each feature has its own qualification status, linked from its section below; records for older builds are kept so their patches can still be recognized and removed.

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

### Prebuilt npm package

You need [Node.js](https://nodejs.org/) 26.x (26.13 or newer), but not Go, Git, or a compiler. Install a prepared tarball (replace the example path and `VERSION`):

```powershell
npm install --global 'C:\Downloads\agyctl-VERSION.tgz'
agyctl --help
agyctl models
```

`models` reads the signed-in client's catalog while Antigravity is running. Then quit Antigravity and install the panel:

```powershell
agyctl install
agyctl status --json
```

To install all features, select the model IDs and limits explicitly. The mapping below is only an example; use the IDs returned by your selected client:

```powershell
agyctl install --all --locale zh-Hant-TW --model-limits '1318=500000,1319=500000,1320=500000' --dry-run --json
agyctl install --all --locale zh-Hant-TW --model-limits '1318=500000,1319=500000,1320=500000'
```

`--all` can reuse a verified current or installer-saved model mapping; otherwise it requires `--model-limits`. Disabled account models are not unlocked. Use `--asar` or `AGYCTL_APP_DIR` to select an installation. Reopen Antigravity after applying changes. See [npm installation operations](docs/operations.md#npm-installation) for individual features, removal, and partial-failure recovery.

Installing or removing the npm package itself never modifies Antigravity. Before removing the tool, quit the client and remove its features:

```powershell
agyctl uninstall --all
npm uninstall --global agyctl
```

Registry installation (`npm install --global agyctl`) is available only after a maintainer publishes the package; local packaging does not publish it.

### From source

Clone the project and install its development dependencies. The later `npm run ...` walkthroughs run from this folder in PowerShell; building the native tool additionally requires Go:

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

Reopen Antigravity and use **Settings → Patches**. Installed values are filled in automatically. Expand **Model context limits** to choose models from the signed-in account's Language Server catalog; Gemini thinking-effort variants share one row. New rows start at 256,000 tokens and unchecked; new or changed values must be 256,000–983,040. The **Summary compaction patch** checkbox controls the [compaction patch](#summary-compaction-patch); on 2.33.0 and 2.32.1 it can be combined with model context limits, while older builds allow only one of the two. Unknown native states stay unchanged without blocking unrelated Host controls. Press **Save settings** to save a draft; nothing is applied yet. Then quit Antigravity and apply the draft from a terminal as described in [patch controls](docs/operations.md#panel-patch-controls), which also covers unavailable models and recovery. After reopening, the panel reads the settings back from the installed files. The commands below are the terminal alternative.

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

The saved plan binds the exact installation; changing `AGYCTL_APP_DIR` does not retarget it. Reopen Antigravity and check the interface language.

Preparation picks the profile for the exact installed app version and refuses unknown versions instead of using a nearby one. The 2.33.0 profile uses a new native adapter for the updated SSH and remote-connection dialogs, retaining earlier adapters for older builds. All profiles are `probe-only`: a successful install does not prove that every screen is translated; see [verification status](docs/localization.md#verification-status).

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

To change an installed patch on 2.33.0 or 2.32.1, quit Antigravity and apply the complete new mapping directly. On older builds, restore first using the command below, then preview and apply the new mapping. The mapping replaces the selected model set; it does not merge with earlier IDs. `--model-limits` cannot be combined with legacy `--ids`/`--limit`. Legacy commands still accept one shared floor. With no settings flags, a patch command reuses detected installed settings or the saved last patch settings when applicable; otherwise it uses the built-in 500,000-token/default-ID combination. An explicit restore disables saved-setting reuse: pass the full mapping when applying again. An app update can remove the patch: `settings_state` distinguishes saved settings from current bytes, and nothing reapplies automatically.

**Remove.** Quit Antigravity first, then run:

```powershell
npm run limit:restore
```

Expect `restored: true` or `already_restored: true`. Run the status command again and confirm `patch_state.kind` is `original`, then reopen Antigravity.

## Tool-output capacity patch

Raises Language Server limits for native tool output: file reads go from 800 to 2,000 lines and from 45 KiB to 128 KiB, and the per-step message budget floor goes to 98,304 tokens so larger reads reach the model. The legacy `grep_search` result cap is also raised to 100, but the tested builds do not expose that tool. Supported builds are Windows 2.33.0, 2.32.1, and 2.31.2 (the 2.31.2 recipe also carries native grep fixes); each admits only its exact registered `language_server.exe`. These values are qualification targets, not proven maxima. See [status and evidence](docs/tool-output-patch.md).

```powershell
npm run tool-output:status    # on-disk state of the selected installation
npm run tool-output:patch     # plan in memory; writes nothing
npm run tool-output:patch -- --apply    # quit Antigravity first
npm run tool-output:restore   # back to the exact patched-from input
```

Applying and restoring require the client to be closed, verified backups, and an explicit `--binary` when several installations exist. Other tools' limits are unchanged. On 2.33.0 and 2.32.1 this patch combines freely with the limit and compaction patches; on 2.31.2, remove a conflicting patch first. App updates remove the patch and nothing is reapplied automatically.

## Summary compaction patch

Changes what survives when Antigravity compacts a long conversation into a summary (Windows 2.33.0 and 2.32.1):

- **Your original messages:** upstream passes only the 10 most recent messages, within a shared byte budget. The patch instead keeps your most recent messages whole, newest first, up to 61,440 UTF-8 bytes in total. Only the oldest kept message may be cut; anything older is dropped. Numbering counts toward the budget, so this is neither a token count nor the whole input size.
- **Summary prompt:** `native` (default) keeps Antigravity's own prompt. `custom` replaces it with your text, up to 3,937 UTF-8 bytes.

When compaction triggers and `/compact` itself are unchanged. Status is `candidate`: manual compaction was verified on Gemini 3.8 Flash High; automatic compaction and other models are not yet qualified. A separate 2.31.2 recipe is kept, but its prompt change was not adopted in testing. See [status and evidence](docs/compaction-patch.md#status) and the [workflow](docs/operations.md#summary-compaction-patch).

```powershell
npm run compaction:status -- --binary ABS_LS_PATH
npm run compaction:patch -- --binary ABS_LS_PATH --prompt-mode native    # plan only
npm run compaction:patch -- --binary ABS_LS_PATH --prompt-mode custom --prompt-file summary.txt    # plan only
npm run compaction:patch -- --binary ABS_LS_PATH --prompt-mode native --apply    # quit Antigravity first
npm run compaction:restore -- --binary ABS_LS_PATH
```

Applying and restoring follow the same closed-client, verified-backup, and explicit-`--binary` rules as the other Language Server patches. On 2.33.0 and 2.32.1 the three patches are combined into one image, so each can be enabled, changed, or removed without touching the others; see [native composition](docs/operations.md#native-feature-composition). On 2.31.2 they keep their separate conflict checks. App updates remove the patch and nothing is reapplied automatically.

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
