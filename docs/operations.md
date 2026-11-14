# Operations Guide

This guide covers client modifications from the CLI, panel settings, capsule backups, recovery boundaries, reviewed Host changes, and localization apply. See the [README](../README.md#get-started) for setup, [architecture.md](architecture.md) for component boundaries, and [localization.md](localization.md) for the localization stages and offline preparation. Run commands from the project root. Commands that apply, remove, or restore change the installed client; inspection alone does not authorize those actions.

## Client modifications from the CLI

The commands below are the terminal alternative to the [panel patch controls](#panel-patch-controls). Neither workflow closes or relaunches the client. Close the selected installation yourself before any write. The process checks differ by feature:

- **Context limit:** `agyctl limit patch --apply` and `restore` refuse while the selected installation's client or Language Server is running, or when the process state cannot be read. Another installation's server does not block the selected one. An explicit custom `--binary` in a recognized installation layout also resolves the paired client; a missing or ambiguous executable refuses mutation. See [discover.go](../src/agyctl/internal/limit/discover.go).
- **Host changes that add, remove, or preserve localization:** resolve the selected installation's paired executable, including explicit custom paths. Windows checks exact image names from `tasklist`; Linux checks matching `ps` command names against the exact executable path; macOS compares the `ps` executable command without arguments. A running target or an unavailable/ambiguous process identity refuses the operation (`CLIENT_RUNNING`, `CLIENT_RUNNING_UNKNOWN`). The check runs again inside the Host lock. See [host-patch.mjs](../scripts/lib/host-patch.mjs).
- **Capsule-only install or removal:** does not check the client process. Closing the client is your responsibility.

Every writing command refuses a target it cannot qualify, so a refusal is the expected outcome on an unknown build; do not work around it. Update the project itself with `git pull`, `npm ci`, and `npm run plugin:install`.

Each feature has one gate that decides whether the installed bytes are known. A failing gate writes nothing and names what no longer matches:

| Feature | Gate | Read-only check |
| --- | --- | --- |
| Context limit | The installed clamp function body must equal an original recorded in [versions.json](../compat/versions.json) | `npm run limit:status`, or `npm run limit:patch` without `--apply` |
| Capsule | Executable and ASAR qualification, plus every anchor in [anchors.js](../src/capsule/anchors.js) present in the Language Server's served web bundle | `node scripts/manage.mjs status` (`capsuleAnchors`); `npm run host-patch -- apply --capsule --capsule-code` runs the same gate and refuses before any write |
| Localization | Reviewed profile or structural evidence, adapter anchors, and bound plan inputs | `node scripts/manage.mjs status`, `prepare`, and `--host-preflight` below |

The capsule anchor gate parses the embedded web bundle with bounded extraction and never executes it. Anchors are the capsule's one volatile upstream dependency: a renamed selector is caught when the client changes, not after the capsule silently fails to mount. The tests cover the token derivation and refusal with synthetic bundles; the opt-in installed-client test checks every installation on the machine and reports SKIP when none exists.

The panel data directory is `ANTIGRAVITY_EXECUTABLE_DATA_DIR` when the host provides it, otherwise `~/.gemini/antigravity/sidecar_data/agyctl/panel/data`; that Hub-named fallback does not isolate panel data by app channel. It holds two files, each written atomically through a temporary file: `settings.json` (schema 3) stores only the refresh interval (`pollIntervalSeconds`, integer 10–300, default 10 when the file is absent), and `pricing.json` (schema 1) stores custom model prices. Other settings schemas are refused; other fields in a schema 3 file are ignored on read and rejected on save. The standalone development server binds only to loopback. See [settings.mjs](../src/plugin/sidecars/panel/settings.mjs).

Quit Antigravity before installing, updating, or removing the panel: a running sidecar can hold its working directory open and prevent directory moves on Windows. `npm run plugin:install` copies `src/plugin/` to `~/.gemini/config/plugins/agyctl`, keeping the replaced directory under `~/.gemini/config/plugin-backups/`. `npm run plugin:uninstall` moves that directory to `plugin-backups/agyctl.removed-<uuid>`; neither command deletes data, and the panel data directory above is untouched by removal. Reopen Antigravity and verify the panel's presence or absence after the command succeeds.

The panel's explicit Language Server connection requires both `ANTIGRAVITY_LS_ADDRESS` (`host:port`, or `[::1]:port` for IPv6) and `ANTIGRAVITY_CSRF_TOKEN`. Invalid or incomplete explicit settings fail instead of falling back to another installation's logs. With neither variable set, discovery uses the client logs. See [transport.mjs](../src/plugin/sidecars/panel/transport.mjs).

## Panel patch controls

Build the Host, localization, and native tools, then install/update the panel.
Settings reads the selected installation's feature state and decoded model
limits, rather than displaying terminal commands. Toggle capsule, localization,
and context-limit patches independently; choose a locale and each model's
token limit. Uncheck a model to omit it from the new mapping.
Installed values prefill the controls; saved values can prefill a disabled limit
patch. Polling does not overwrite unsaved edits or silently retarget their
installation revision.

[Model discovery](../scripts/lib/model-catalog.mjs) calls the connected Language
Server's `GetAvailableModels` with `{forceRefresh:false}` and joins
`response.models[alias].model` to the literal `Model` enum in `main.js` extracted
read-only from the selected Language Server binary. It never evaluates upstream
JavaScript or infers IDs from names, ordering, or placeholder suffixes. Display names and Low/Medium/High variants come from the
catalog, with aliases distinguishing duplicate names. Profiles without a display
name are not listed. A disabled profile is labeled unavailable, without rejecting
other model settings or changing account access; a missing enum match cannot be
selected. Existing mappings absent from the catalog remain visible as unknown
IDs instead of being silently dropped. If discovery fails, existing settings
and the other feature controls remain usable, with a short model-list error.

New model rows prefill 256,000 and remain unchecked, so merely opening settings
does not enable new mappings. Both the panel and its worker validate whole-token
inputs from 256,000 through 896,000 inclusive; existing out-of-range values are
shown unchanged and must be corrected or unchecked before submission. The CLI
retains its separate numeric-ID interface and bounds. The capsule uses the same
catalog names for decoded limits, retaining explicit IDs when names are unknown;
these are still disk patch values, not confirmed live context capacity.

**Save settings** writes a draft only, to
`<AGYCTL_HOME>/management/drafts/<id>.json`, and shows the matching external
command. Simply opening the panel never applies saved settings. Quit Antigravity
yourself, then run from a terminal ([settings.mjs](../scripts/settings.mjs)):

```bash
npm run settings:preflight -- --draft <id>   # read-only check of the draft
npm run settings:apply -- --draft <id>       # apply it
npm run settings:status                      # current feature state; takes no --draft
```

`apply` refuses while the selected client or Language Server is still running
and does not wait, close, or restart them. `--cleanup-sidecars` (preflight and
apply only) is an explicit extra option, never implied.

The panel reaches these operations through
[feature-control-worker.mjs](../scripts/feature-control-worker.mjs) in the
checkout, which calls [feature-control.mjs](../scripts/lib/feature-control.mjs)
and [model-catalog.mjs](../scripts/lib/model-catalog.mjs). When started inside
Electron, the worker re-runs itself under a standalone `node`; without one it
returns `FEATURE_UNAVAILABLE` (install Node.js and reopen Antigravity). Other
unexpected worker errors also return `FEATURE_UNAVAILABLE`, with details on
stderr.

Feature status reads do not update operation records or write hash/model-catalog
caches. Those caches are bounded and process-local; a missing live model catalog
is reported as unavailable without replacing the observed feature state.

Sidecar cleanup is Windows x86-64 only. It stops only orphaned `agyctl/panel`
and built-in `swarm/swarm_board` sidecars whose identity and launcher chain
verify, using an identity-checked process handle rather than `taskkill`. A
running client or LS, an unknown layout, or any identity mismatch refuses before
anything is stopped. Preflight only lists candidates (`preflight: false` until
they exit). Stopping an orphan does not change its plugin. See
[client-processes.mjs](../scripts/lib/client-processes.mjs) and its
[Windows helper](../scripts/lib/client-processes.ps1).

The apply command rechecks target identity and existing feature gates. An app
update, unknown process state, or conflicting operation refuses the request
instead of switching targets or bypassing checks. Host changes precede limit
changes; these are not a single atomic transaction. A later failure can leave
earlier steps applied, so the panel reads their real state rather than claiming
every step succeeded. Original backups remain available through the CLI recovery
paths below. Detailed diagnostics belong in tool logs, not the capsule tooltip.

### Installation selection

Node Host/Capsule tools, management preparation/status, and Go local discovery share this precedence: an explicit `--asar`, `--binary`, or `--install-dir`, then `AGYCTL_APP_DIR`, then the platform's default paths in [install-layout.json](../compat/install-layout.json). `AGYCTL_APP_DIR` is an absolute installation root: the directory containing `Antigravity.exe` on Windows, `/opt/antigravity` or a custom equivalent on Linux, and the app's `Contents` directory on macOS. Only the documented target platforms are supported; discovery does not grant mutation support.

An environment-selected root must contain `resources/app.asar` (`Resources/app.asar` on macOS), the paired Language Server, and exactly one recognized channel executable. Empty, relative, missing, incomplete, or ambiguous environment roots fail without falling back to another installation. Feature-specific package, architecture, original-byte, and backup checks still apply. With no override, multiple discovered installations require an explicit selection for Host operations, management, limit operations, and the local checker; checker `--channel` may narrow the selection. See [Node discovery](../scripts/lib/install-paths.mjs) and [Go discovery](../src/agyctl/internal/layout/layout.go).

To see what discovery finds, run `node scripts/agyctl.mjs locate` (discovered
targets plus the tool's build commit). `node scripts/agyctl.mjs client target --binary ABS_LS`
identifies one Language Server's platform and target. Both are read-only and need
`npm run tools:build`.

The variable is read for each command; agyctl does not write the user's environment. A PowerShell `$env:AGYCTL_APP_DIR = 'D:\Apps\Antigravity'` assignment lasts only for that terminal. User-level persistence is optional and described in [Get started](../README.md#get-started). `AGYCTL_HOME` remains the separate tool-state/backup location. Panel installation and LS connection discovery are independent of the app-directory selection.

An existing reviewed Host plan is an explicit target, not a discovery request: applying it uses its bound archive even if `AGYCTL_APP_DIR` changes. An explicit `--asar` supplied with that plan must match it. The offline localization CLI's `--ls`/`--sample-dir` source flags bypass environment discovery; its `--installation` lookup selects among default-discovered installations, while omitted target arguments use environment discovery. Use the management workflow for a custom installation's reviewed apply.

### Localization preparation and apply

`node scripts/manage.mjs` prepares and applies localization plans against one selected installation; it has no job, close, or relaunch behavior. It runs the built bundles directly, so build first: `npm run host:build` always, `npm run localization:build` before `prepare --localization`, and `npm run tools:build` if `status` should report the limit state. Each command prints JSON.

- `status [--asar ABS_PATH] [--localization-plan ABS_PLAN]` reports Host features, `capsuleAnchors`, localization, limit, and client-process state for one installation. Without `--asar` it uses the only discovered installation; with several it reports an error and asks for an explicit absolute archive path.
- `prepare --localization --locale zh-Hant-TW` runs the offline localization `prepare` for the target's Language Server, then writes a private, target-bound Host plan under `<AGYCTL_HOME>/management/plans/` (mode `0600`) and returns its path as `localizationPlan`. Translated locales produce a DOM artifact (`index.json`, no rewritten `main.js`). `prepare --localization --locale en` refuses: English is an explicit disable, not an identity pack. Without `--asar` it requires exactly one discovered installation; add `--capsule` when the plan should also install or update the capsule. The locale must be canonical (`en`, `zh-Hant-TW`, `zh-Hans-CN`, `ja-JP`), and the target must be the host's own platform. Preparation verifies local assets against the profile for the original archive; it does not create profiles or bypass source checks.
- `--host-preflight [--asar ABS_PATH] --localization-plan ABS_PLAN` verifies the plan without writing. `--host-apply` with the same arguments applies it, requires the client to be closed, and then writes the locale selection. The saved plan selects the installation; an optional `--asar` must match. Both refuse when the plan file, the Language Server, or the saved selection changed since `prepare`; prepare again instead of editing the plan. Include `--capsule` when the plan updates the capsule; an unselected installed capsule stays bound to the plan unchanged.

Capsule and localization are composed once from one verified original, not applied as separate stale plans; unselected installed features are preserved. Changing the AGY language alone does not translate Antigravity. Preparing the localization artifact itself is described in [localization.md](localization.md#offline-inspection-and-preparation).

An explicit absolute `--asar` may select a custom installation outside the default discovery paths. [client-target.mjs](../scripts/lib/client-target.mjs) verifies the package identity, installed layout, canonical regular files, paired Language Server/executable, and native target before preparation or process inspection. Use the same archive for preparation, reviewed apply, status, and removal; selecting a custom path does not bypass the feature gates.

Direct `agyctl limit` commands patch PE/ELF x86-64 targets; Mach-O ARM64 binaries are inspected as data and report `unavailable`, and macOS limit mutation is refused until its original bytes, code placement, and signing strategy are qualified; see [limit patch](limit-patch.md).

### Per-model context settings

`limit patch --model-limits '1318=300000,1400=500000'` describes the complete model
mapping, not an incremental edit. Preview is read-only unless `--out` explicitly
requests a new output file; `--apply` is required to replace the installation.
Quit the selected client before applying or restoring. To change an existing
patch, restore first, then preview/apply the complete replacement mapping. Numeric
IDs are build-specific enum values; the tool does not guess model names or account
availability. The patch raises a candidate floor and keeps later context/output
clamps; it does not force the session window to that value or lower a larger
existing candidate. See [the modification boundary](limit-patch.md#modification-boundary).

`limit status` reports installed values in `patch_state.model_limits` after a
restart, for both the legacy common-floor patch and the per-model encoding.
`saved_settings` is historical configuration, not proof of installation;
`settings_state` distinguishes it from current bytes. A recognized patch can be
decoded even when its successful-write record is missing, but recovery still
requires a verified original backup. App updates do not trigger automatic
reapplication. A patch invocation without setting flags can reuse detected or
applicable saved settings; explicit flags select a new configuration and do not
merge earlier values. Preview/status never complete interrupted bookkeeping.
An explicit restore keeps historical settings visible when recorded, but disables
their automatic reuse by a later no-settings patch command; supply the intended
full mapping when applying again.

The panel and capsule share a read-only `/api/limit-status` sidecar response from
the external native tool. The installed panel's runtime locator records the
repository location and selected path overrides; it does not bundle Go.
Patch writes go through the draft and `feature-control-worker.mjs` path above,
not this read-only endpoint.
Build with `npm run tools:build` and reinstall/update the panel
when moving the checkout. The display is a timestamped snapshot of the selected
installation on disk, not confirmation that the running server loaded those
bytes. Responses are shared and cached for up to 60 seconds to avoid repeatedly
hashing the binary. The capsule's server-reported session capacity remains separate. Missing
tools, invalid selection, or absent sidecar produce unavailable status rather
than a remembered applied claim. Ordinary usage monitoring does not require this
optional tool connection.

## Interface languages

AGY's own messages support `en`, `zh-Hant-TW`, `zh-Hans-CN`, and `ja-JP`
(old `zh-TW`/`zh-CN` preferences are normalized). Order: saved preference,
declared Host language, system language, then English. With the Capsule active,
its language button and the panel selector share one Host-owned state; a
panel-only installation saves its own choice. Language selection never edits
ASAR or restarts the application, and it does not translate Antigravity; that is
the separate [localization](localization.md) feature. `npm run capsule:build`
validates message completeness and the Japanese vendor mappings.

## Model prices

Under **Settings → Model prices**, use an exact server model alias or a built-in model family and enter all four rates in USD per million tokens; zero is valid. Custom prices override built-in rates for matching historical usage. Deleting an override restores the built-in rate when one is known. Panel saves are checked against the loaded revision. The capsule discovers the panel pricing endpoint and validates the returned price schema/revision; it does not require matching source versions. Prices and resulting costs are local estimates, not an account bill, and price edits do not patch the client.

## Capsule backups

The capsule installer retains an installation-specific original archive and unpacked files, refusing to overwrite conflicting backup contents. Recovery records pair the exact original and installed archive hashes; a hook marker alone never authorizes restoration.

- Existing legacy backups are preserved, not overwritten, and are not migrated automatically.
- Unknown, corrupted, or mismatched backups require manual review; `--force` does not bypass pairing.
- The archive is staged and validated before replacement; the unpacked-sidecar manifest is checked.

Installation and removal report persisted, hash-verified archive state. Neither proves that the capsule visibly mounted: reopen the client and look. To undo an installation, use `npm run host-patch -- remove --capsule` for the same installation and verified backup; with an explicit archive path use [reviewed Host removal](#reviewed-host-changes), which uses the same Composer removal path. Do not restore an unrelated archive or another installation's backup.

## Recovery boundaries

Recovery is component-specific, not a single transaction across the client:

- **Host archive:** a verified original backup is published before any change;
  conflicting or incomplete backup state is rejected, not overwritten. Records
  may remain after a later failure. See [Host Composer](../src/host/compose.ts).
- **One archive replacement:** staged, hash-checked, and revalidated, with a
  guarded rollback; an unverifiable rollback reports an unknown outcome and the
  remaining recovery path. No power-loss durability. See
  [file-transaction.mjs](../scripts/lib/file-transaction.mjs).
- **Limit binary:** hash-paired backups and prepare records; see
  [limit patch recovery](limit-patch.md#backup-and-recovery).
- **Multiple features:** capsule and localization are one Host transaction over one verified original. The limit patch is a separate operation on the Language Server binary; a failure in one never reverses the other, so check each feature's status after a failed run.

On failure, read the command result, current feature status, and any
prepare/recovery records before retrying. Do not delete originals or treat a
failed command as proof that no installation bytes changed. Restore only through
the component's matching-backup checks; an application update or target drift
requires review rather than forcing an older backup over new files.

## Reviewed Host changes

Use this workflow when you need a saved plan or an explicit `--asar` before modifying `app.asar`. Day-to-day enable and remove use `npm run host-patch` against the installation selected in [Get started](../README.md#get-started). The commands below bind a reviewed plan to one archive path.

### Prepare and review

Run `npm ci` first if dependencies are not installed. Host npm commands build the
neutral Host bundle, not localization. Build localization separately only when
preparing that feature. To save a clean JSON plan in PowerShell 7, build separately
and invoke Node directly so build logs stay out of the UTF-8 file. This example
targets the default Windows Antigravity stable installation; change `$asar`
if the app is installed elsewhere:

```powershell
npm run host:build
npm run capsule:build
$asar = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources\app.asar'
$capsuleCode = (Resolve-Path -LiteralPath 'dist/capsule/input-capsule.js').Path
$plan = Join-Path $PWD.Path 'host-plan.json'
node scripts/host-patch.mjs plan --asar "$asar" --capsule --capsule-code "$capsuleCode" --json > "$plan"
```

Read `host-plan.json`. Confirm the exact `asarPath`, selected features, hash bindings, and integrity qualification before applying. Planning does not modify the installed archive.

### Apply and verify

Save your work and quit the target client normally before continuing. Apply only the reviewed plan:

```powershell
npm run host-patch -- apply --plan "$plan" --json
```

Expect `applied: true`, then inspect the persisted archive state:

```powershell
npm run host-patch -- status --asar "$asar" --json
```

Confirm `asarPath` is the intended target and `features.capsule` is `true`. This workflow does not hot-load the capsule; reopen the target client and check that it appears. Installation and live activation are separate results.

### Remove from the same target

If you want to remove the capsule, save your work and quit the target client again before running:

```powershell
npm run host-patch -- remove --asar "$asar" --capsule --json
```

Run the status command again and confirm `features.capsule` is `false`, while any retained localization remains present. Then reopen the client. Backup history is retained.

Host rules:

- The saved plan binds the target and payloads; `apply --plan` rejects overrides.
- Every archive write qualifies the paired executable's Electron integrity fuses and refuses unknown or enforced integrity without changing fuses.
- Adding, removing, or preserving localization requires the user to close the client.
- Retained feature contributions are hash-bound and validated without rebuilding
  another feature. Older localization payloads without prepared contributions
  refuse partial changes; they are not silently converted. Restore all features
  through the exact original chain before reapplying reviewed inputs.
- A newly reviewed plan for the same installed inputs is already `current`.
  Updating only observed-source evidence creates a new hash-bound archive and
  receipt through the managed input-hash comment; earlier receipts and the
  original backup remain unchanged.
- After reviewing recovery, `remove --all` restores the verified original rather than guessing from current bundles.

Localization plans accept the recorded `probe-only` profiles with an `UNTESTED_BUILD` warning; ASAR/executable hash drift emits `IDENTITY_DRIFT` rather than blocking unrelated modifications. An existing profile, valid selected assets, paired executable/fuse qualification, unique adapter anchors, and bound plan inputs remain required. This permission is not real-client acceptance. See [localization.md](localization.md#current-status).
