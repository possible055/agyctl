# Operations Guide

How to apply, inspect, and recover the client modifications: process checks and
gates, installation selection, panel setup and settings, localization and Host
workflows, the binary patches, backups, and recovery. For setup see the
[README](../README.md#get-started); for component boundaries see
[architecture](architecture.md); for localization stages and offline preparation see
[localization](localization.md).

Run commands from the project root. Commands that apply, remove, or restore change
the installed client; inspection commands do not.

## Client modifications from the CLI

These commands are the terminal alternative to the
[panel patch controls](#panel-patch-controls). Neither workflow closes or relaunches
the client, so close the selected installation yourself before any write. The
process checks differ by feature:

- **Context limit:** `agyctl limit patch --apply` and `restore` refuse while the
  selected installation's client or Language Server (LS) is running, or when the
  process state cannot be read. Another installation's server does not block the
  selected one. An explicit custom `--binary` in a recognized installation layout
  also resolves the paired client; a missing or ambiguous executable refuses
  mutation.
- **Tool output:** `agyctl tool-output patch --apply` and `restore` use the same
  stopped-process contract. Discovery never guesses between multiple installations:
  an explicit `--binary` is required when more than one is found.
- **Host changes that add, remove, or preserve localization:** resolve the selected
  installation's paired executable, including explicit custom paths. Windows checks
  exact image names from `tasklist`, Linux checks matching `ps` command names against
  the exact executable path, and macOS compares the `ps` executable command without
  arguments. A running target or an unavailable or ambiguous process identity
  refuses the operation (`CLIENT_RUNNING`, `CLIENT_RUNNING_UNKNOWN`), and the check
  runs again inside the Host lock.
- **Capsule-only install or removal:** does not check the client process; closing the
  client is your responsibility.

Every writing command refuses a target it cannot qualify, so a refusal is the
expected outcome on an unknown build; do not work around it.

Each feature has one gate that decides whether the installed bytes are known. A
failing gate writes nothing and names what no longer matches:

| Feature | Gate | Read-only check |
| --- | --- | --- |
| Context limit | The installed clamp function body must equal an original recorded in [versions.json](../compat/versions.json) | `npm run limit:status`, or `npm run limit:patch` without `--apply` |
| Tool output | The installed binary must equal a whole-file input registered in [tool-output.json](../compat/tool-output.json) | `npm run tool-output:status`, or `npm run tool-output:patch` without `--apply` |
| Capsule | Executable and ASAR qualification, plus every anchor in [anchors.js](../src/capsule/anchors.js) present in the LS's served web bundle | `node scripts/manage.mjs status` reports `capsuleAnchors`; a [Host plan](#prepare-and-review) checks the proposed change without applying it |
| Localization | Reviewed profile or structural evidence, adapter anchors, and bound plan inputs | `node scripts/manage.mjs status` and `--host-preflight` after [preparation](#localization-preparation-and-apply); `prepare` writes tool state, not installed files |

The capsule anchor gate parses the embedded web bundle with bounded extraction and
never executes it. Anchors are the capsule's one volatile upstream dependency: a
renamed selector is caught when the client changes, not after the capsule silently
fails to mount.

## Installation selection

The Node Host/Capsule tools, management preparation/status, and Go local discovery
share this precedence:

1. an explicit `--asar`, `--binary`, or `--install-dir`;
2. `AGYCTL_APP_DIR`;
3. the platform's default paths in
   [install-layout.json](../compat/install-layout.json).

`AGYCTL_APP_DIR` is an absolute installation root: the directory containing
`Antigravity.exe` on Windows, `/opt/antigravity` or a custom equivalent on Linux, and
the app's `Contents` directory on macOS. Discovery does not grant mutation support
on a platform.

An environment-selected root must contain `resources/app.asar` (`Resources/app.asar`
on macOS), the paired LS, and exactly one recognized channel executable. An empty,
relative, missing, incomplete, or ambiguous root fails without falling back to
another installation. Feature-specific package, architecture, original-byte, and
backup checks still apply. With no override, multiple discovered installations
require an explicit selection for Host operations, management, limit operations, and
the local checker (checker `--channel` may narrow the selection). See
[Node discovery](../scripts/lib/install-paths.mjs) and
[Go discovery](../src/agyctl/internal/layout/layout.go).

To see what discovery finds, run `node scripts/agyctl.mjs locate` (discovered targets
plus the tool's build commit). `node scripts/agyctl.mjs client target --binary ABS_LS`
identifies one LS's platform and target. Both are read-only and need
`npm run tools:build`.

The variable is read on every command; agyctl never writes the user's environment.
A PowerShell `$env:AGYCTL_APP_DIR` assignment lasts only for
that terminal (persistence is described in the
[README](../README.md#get-started)). `AGYCTL_HOME` is the separate tool-state and
backup location. Panel installation and LS connection discovery are independent of
the app-directory selection.

An existing reviewed Host plan is an explicit target, not a discovery request:
applying it uses its bound archive even if `AGYCTL_APP_DIR` changes, and an explicit
`--asar` supplied with the plan must match. The offline localization CLI's
`--ls`/`--sample-dir` flags bypass environment discovery, its `--installation` lookup
selects among default-discovered installations, and omitted target arguments use
environment discovery. For a custom installation's reviewed apply, use the management
workflow.

## Panel installation and data

Quit Antigravity before installing, updating, or removing the panel: a running
sidecar can hold its working directory open and block directory moves on Windows.

- `npm run plugin:install` copies `src/plugin/` to
  `~/.gemini/config/plugins/agyctl` and keeps the replaced directory under
  `~/.gemini/config/plugin-backups/`.
- `npm run plugin:uninstall` moves that directory to
  `plugin-backups/agyctl.removed-<uuid>`.

Neither command deletes data, and removal leaves the panel data directory untouched.
Reopen Antigravity and verify the panel's presence or absence afterwards.

The panel data directory is `ANTIGRAVITY_EXECUTABLE_DATA_DIR` when the host provides
it, otherwise `~/.gemini/antigravity/sidecar_data/agyctl/panel/data`. That fallback
is named for the Hub channel and does not isolate panel data per app channel. It
holds two files, each written atomically through a temporary file:

- `settings.json` (schema 3) stores only the refresh interval
  (`pollIntervalSeconds`, an integer from 10 to 300; 10 when the file is absent).
- `pricing.json` (schema 1) stores custom model prices.

Other settings schemas are refused, and other fields in a schema 3 file are ignored
on read and rejected on save. The standalone development server binds only to
loopback.

The panel finds the LS in one of two ways. An explicit connection needs both
`ANTIGRAVITY_LS_ADDRESS` (`host:port`, or `[::1]:port` for IPv6) and
`ANTIGRAVITY_CSRF_TOKEN`; invalid or incomplete explicit settings fail instead of
falling back to another installation's logs. With neither variable set, discovery
uses the client logs.

## Panel patch controls

Build the Host, localization, and native tools, then install or update the panel.
Settings reads the selected installation's feature state and decoded model limits
instead of showing terminal commands. Toggle the capsule, localization, and
context-limit patches independently, choose a locale, and set each model's token
limit; uncheck a model to omit it from the new mapping. Installed values prefill the
controls, and saved values can prefill a disabled limit patch. Polling does not
overwrite unsaved edits or silently retarget their installation revision.

Model discovery calls the connected LS's
`GetAvailableModels` with `{forceRefresh:false}` and joins
`response.models[alias].model` to the literal `Model` enum in the `main.js` extracted
read-only from the selected LS binary. It never evaluates upstream JavaScript or
infers IDs from names, ordering, or placeholder suffixes. Display names and
Low/Medium/High variants come from the catalog, with aliases distinguishing duplicate
names, and profiles without a display name are not listed. A disabled profile is
labeled unavailable without rejecting other model settings or changing account
access, and a model with no enum match cannot be selected. Existing mappings absent
from the catalog stay visible as unknown IDs. If discovery fails, existing settings
and the other feature controls remain usable, with a short model-list error.

New model rows prefill 256,000 and start unchecked, so opening settings never enables
a new mapping. The panel and its worker accept whole-token limits from 256,000
through 896,000 inclusive; existing out-of-range values are shown unchanged and must
be corrected or unchecked before submission. The CLI keeps its own numeric-ID
interface and bounds. The capsule shows decoded limits with the same catalog names,
and explicit IDs when names are unknown. These are disk patch values, not confirmed
live context capacity.

**Save settings** writes a draft only, to `<AGYCTL_HOME>/management/drafts/<id>.json`,
and shows the matching command. Opening the panel never applies saved settings. Quit
Antigravity yourself, then run from a terminal:

```bash
npm run settings:preflight -- --draft <id>   # check without modifying installed files
npm run settings:apply -- --draft <id>       # apply it
npm run settings:status                      # current feature state; takes no --draft
```

`apply` refuses while the selected client or LS is running and does not wait for,
close, or restart them. `--cleanup-sidecars` (preflight and apply only) is an
explicit extra option and is never implied.

Preflight can prepare localization artifacts and plans under the tool-state root;
it does not apply them to the client.

The panel reaches these operations through a worker in the checkout. When started
inside Electron, the worker re-runs itself under a standalone `node`. Without one,
or on any other unexpected worker error, it returns `FEATURE_UNAVAILABLE` (install Node.js and
reopen Antigravity; details go to stderr). Feature status reads do not update
operation records or write the hash and model-catalog caches, which are bounded and
process-local. A missing live model catalog is reported as unavailable without
replacing the observed feature state.

Sidecar cleanup is Windows x86-64 only. It stops only orphaned `agyctl/panel` and
built-in `swarm/swarm_board` sidecars whose identity and launcher chain verify, using
an identity-checked process handle rather than `taskkill`. A running client or LS, an
unknown layout, or any identity mismatch refuses before anything is stopped.
Preflight only lists candidates (`preflight: false` until they exit), and stopping an
orphan does not change its plugin.

`apply` rechecks target identity and the feature gates. An app update, unknown
process state, or conflicting operation refuses the request instead of switching
targets or bypassing checks. Host changes precede limit changes, and the sequence is
not one atomic transaction: a later failure can leave earlier steps applied, so the
panel reads their real state instead of claiming every step succeeded. Original
backups remain available through the recovery paths below.

## Localization preparation and apply

`node scripts/manage.mjs` prepares and applies localization plans against one
selected installation; it has no job, close, or relaunch behavior. It runs the built
bundles directly, so build first: `npm run host:build` always,
`npm run localization:build` before `prepare --localization`, and
`npm run tools:build` if `status` should report the limit and tool-output state.
Each command prints JSON.

- `status [--asar ABS_PATH] [--localization-plan ABS_PLAN]` reports Host features,
  `capsuleAnchors`, localization, limit, tool-output (`toolOutput`: registered input,
  managed output, recognized output, or unknown), and client-process state for one
  installation. Without `--asar` it uses the only discovered installation; with
  several it reports an error and asks for an explicit absolute archive path.
- `prepare --localization --locale zh-Hant-TW` runs the offline localization
  `prepare` for the target's LS, then writes a private, target-bound Host plan under
  `<AGYCTL_HOME>/management/plans/` (mode `0600`) and returns its path as
  `localizationPlan`. Translated locales produce a DOM artifact (`index.json`, no
  rewritten `main.js`); `--locale en` refuses, because English is an explicit disable
  and not an identity pack. Without `--asar` it requires exactly one discovered
  installation. Add `--capsule` when the plan should also install or update the
  capsule. The locale must be canonical (`en`, `zh-Hant-TW`, `zh-Hans-CN`, `ja-JP`),
  and the target must be the host's own platform. Preparation verifies local assets
  against the profile for the original archive; it does not create profiles or bypass
  source checks.
- `--host-preflight [--asar ABS_PATH] --localization-plan ABS_PLAN` verifies the plan
  without writing. `--host-apply` with the same arguments applies it, requires the
  client to be closed, and then writes the locale selection. The saved plan selects
  the installation, and an optional `--asar` must match it. Both refuse when the plan
  file, the LS, or the saved selection changed since `prepare`; prepare again instead
  of editing the plan. Include `--capsule` when the plan updates the capsule. An
  unselected installed capsule stays bound to the plan unchanged.

The capsule and localization are composed once from one verified original, not
applied as separate stale plans, and unselected installed features are preserved.
Changing the AGY language alone does not translate Antigravity. Preparing the
localization artifact itself is described in
[localization](localization.md#offline-inspection-and-preparation).

An explicit absolute `--asar` can select a custom installation outside the default
discovery paths.
Target inspection verifies the package identity,
installed layout, canonical regular files, paired LS/executable, and native target
before preparation or process inspection. Use the same archive for preparation,
reviewed apply, status, and removal; a custom path does not bypass the feature gates.

## Per-model context settings

`agyctl limit` patches PE and ELF x86-64 targets. Mach-O ARM64 binaries are inspected
as data and report `unavailable`, and macOS limit mutation is refused until its
original bytes, code placement, and signing strategy are qualified; see
[limit patch](limit-patch.md).

`limit patch --model-limits '1318=300000,1400=500000'` describes the complete model
mapping, not an incremental edit. Preview is read-only unless `--out` explicitly
requests a new output file, and `--apply` is required to replace the installation.
Quit the selected client before applying or restoring. To change an existing patch,
restore first, then preview and apply the complete replacement mapping. Numeric IDs
are build-specific enum values; the tool does not guess model names or account
availability. The patch raises a candidate floor and keeps later context/output
clamps; it does not force the session window to that value or lower a larger existing
candidate. See [modification boundary](limit-patch.md#modification-boundary).

`limit status` decodes installed values into `patch_state.model_limits` on every
invocation, for both the legacy common-floor patch and the per-model encoding.
`saved_settings` is historical configuration, not proof of installation, and
`settings_state` distinguishes it from current bytes. A recognized patch can be
decoded even when its successful-write record is missing, but recovery still needs a
verified original backup. App updates never trigger automatic reapplication.

A `patch` invocation without setting flags can reuse detected or applicable saved
settings; explicit flags select a new configuration and do not merge earlier values.
Preview and status never complete interrupted bookkeeping. An explicit `restore`
keeps historical settings visible when recorded but disables their automatic reuse by
a later no-settings patch command, so supply the intended full mapping when applying
again.

The panel and capsule share a read-only `/api/limit-status` sidecar response from the
external native tool. The installed panel's runtime locator records the repository
location and selected path overrides; it does not bundle Go. Patch writes go through
the draft and `feature-control-worker.mjs` path above, not this endpoint. Build with
`npm run tools:build` and reinstall or update the panel when you move the checkout.
The display is a timestamped snapshot of the selected installation on disk, not
confirmation that the running server loaded those bytes. Responses are shared and
cached for up to 60 seconds to avoid repeatedly hashing the binary. The capsule's
server-reported session capacity is separate. A missing tool, invalid selection, or
absent sidecar produces an unavailable status instead of a remembered applied claim,
and ordinary usage monitoring does not need this optional connection.

## Tool-output capacity patch

`tool-output patch` relaxes recorded LS limits for native tool outputs (read
lines/bytes, legacy grep result count, and the post-merge step budget). The
registered values and their evidence are in
[tool-output-patch.md](tool-output-patch.md). Preview is always in-memory: without
`--apply` the command writes nothing. An explicit `--binary` selects the
installation, and with several installed the command refuses instead of guessing.

Quit the selected client before applying or restoring (the process checks above
apply). To change or remove the patch, run `npm run tool-output:restore`, which
returns the binary to exactly the input it was patched from, verified against the
recorded transaction. A binary that changed since the patch (an app update, a later
`limit` patch, or an external edit) is refused rather than overwritten; remove the
other patch with its own restore first. The two features share one operation lock, so
they cannot mutate the same installation concurrently.

State lives beside the limit records in the tool home: `tool-output-state.json` and
`tool-output-prepare-<target>.json` transaction records, plus the feature-named
tool-home backup. The tool never overwrites or deletes backups.
`node scripts/manage.mjs status` reports the disk state under `toolOutput`; a disk
patch does not mean the running client loaded it, and app updates never reapply
anything automatically.

## Interface languages

AGY's own messages support `en`, `zh-Hant-TW`, `zh-Hans-CN`, and `ja-JP` (old
`zh-TW`/`zh-CN` preferences are normalized). The order is saved preference, declared
Host language, system language, then English. With the capsule active, its language
button and the panel selector share one Host-owned state, while a panel-only
installation saves its own choice. Language selection never edits ASAR or restarts the
application, and it does not translate Antigravity; that is the separate
[localization](localization.md) feature. `npm run capsule:build` validates message
completeness and the Japanese vendor mappings.

## Model prices

Under **Settings → Model prices**, enter an exact server model alias or a built-in
model family and all four rates in USD per million tokens (zero is valid). Custom
prices override built-in rates for matching historical usage, and deleting an
override restores the built-in rate when one is known. Panel saves are checked against
the loaded revision. The capsule discovers the panel pricing endpoint and validates
the returned price schema and revision; it does not require matching source versions.
Prices and resulting costs are local estimates, not an account bill, and price edits
do not patch the client.

## Capsule backups

The capsule installer retains an installation-specific original archive and unpacked
files and refuses to overwrite conflicting backup contents. Recovery records pair the
exact original and installed archive hashes; a hook marker alone never authorizes
restoration.

- Existing legacy backups are preserved, not overwritten, and not migrated
  automatically.
- Unknown, corrupted, or mismatched backups need manual review, and `--force` does
  not bypass pairing.
- The archive is staged and validated before replacement, and the unpacked-sidecar
  manifest is checked.

Installation and removal report persisted, hash-verified archive state; neither
proves the capsule visibly mounted, so reopen the client and look. To undo an
installation, run `npm run host-patch -- remove --capsule` for the same installation
and verified backup. With an explicit archive path, use
[reviewed Host removal](#reviewed-host-changes), which takes the same Composer removal
path. Never restore an unrelated archive or another installation's backup.

## Recovery boundaries

Recovery is component-specific, not one transaction across the client:

- **Host archive:** a verified original backup is published before any change.
  Conflicting or incomplete backup state is rejected, not overwritten, and records can
  remain after a later failure. See [Host Composer](../src/host/compose.ts).
- **One archive replacement:** staged, hash-checked, and revalidated, with a guarded
  rollback. An unverifiable rollback reports an unknown outcome and the remaining
  recovery path. There is no power-loss durability. See
  [file-transaction.mjs](../scripts/lib/file-transaction.mjs).
- **Limit binary:** hash-paired backups and prepare records; see
  [limit patch recovery](limit-patch.md#backup-and-recovery).
- **Tool-output binary:** the same verified-backup, prepare-record, and
  verified-replacement pattern with its own state files. Restore returns exactly the
  recorded operation input and refuses drifted binaries; see
  [tool-output admission](tool-output-patch.md#admission-gate-and-coexistence-with-limit).
- **Multiple features:** the capsule and localization are one Host transaction over
  one verified original. The limit and tool-output patches are separate operations on
  the LS binary, and a failure in one never reverses another, so check each feature's
  status after a failed run.

On failure, read the command result, the current feature status, and any
prepare/recovery records before retrying. Do not delete originals or treat a failed
command as proof that no installed bytes changed. Restore only through the
component's matching-backup checks; an app update or target drift needs review, not
an older backup forced over new files.

### Backup locations

`<agyctl home>` is `AGYCTL_HOME` when set; otherwise it is:

| Platform | Default tool-state root |
| --- | --- |
| Windows | `%LOCALAPPDATA%/agyctl` (or `~/AppData/Local/agyctl` if `LOCALAPPDATA` is unset) |
| Linux | `$XDG_STATE_HOME/agyctl`, otherwise `~/.local/state/agyctl` |
| macOS | `~/Library/Application Support/agyctl` |

Originals are never deleted or overwritten by the tools, and neither should you:

- `<agyctl home>/backups/` holds Host and binary-patch originals and the shared
  binary-patch operation lock.
- `.orig` and `.orig.<sha>` siblings sit beside the patched LS binary (limit patch).
- `~/.gemini/config/plugin-backups/` holds panel backups.
- Any legacy repository-local `backups/` must also be preserved; the tools do not
  migrate it automatically.

`<agyctl home>/management/` holds settings drafts and reviewed localization plans,
not original client files.

## Reviewed Host changes

Use this workflow when you need a saved plan, or an explicit `--asar`, before
modifying `app.asar`. Day-to-day enable and remove use `npm run host-patch` against
the installation selected as described in the [README](../README.md#get-started).
The commands below bind a reviewed plan to one archive path.

### Prepare and review

Run `npm ci` first if dependencies are not installed. Host npm commands build the
neutral Host bundle, not localization; build localization separately only when
preparing that feature. To save a clean JSON plan in PowerShell 7, build separately
and invoke Node directly so build logs stay out of the UTF-8 file. This example
targets the default Windows stable installation; change `$asar` if the app is
installed elsewhere:

```powershell
npm run host:build
npm run capsule:build
$asar = Join-Path $env:LOCALAPPDATA 'Programs\antigravity\resources\app.asar'
$capsuleCode = (Resolve-Path -LiteralPath 'dist/capsule/input-capsule.js').Path
$plan = Join-Path $PWD.Path 'host-plan.json'
node scripts/host-patch.mjs plan --asar "$asar" --capsule --capsule-code "$capsuleCode" --json > "$plan"
```

Read `host-plan.json` and confirm the exact `asarPath`, selected features, hash
bindings, and integrity qualification before applying. Planning does not modify the
installed archive.

### Apply and verify

Save your work and quit the target client, then apply only the reviewed plan:

```powershell
npm run host-patch -- apply --plan "$plan" --json
```

Expect `applied: true`, then inspect the persisted archive state:

```powershell
npm run host-patch -- status --asar "$asar" --json
```

Confirm `asarPath` is the intended target and `features.capsule` is `true`. The
capsule is not hot-loaded: reopen the target client and check that it appears.
Installation and live activation are separate results.

### Remove from the same target

Save your work and quit the target client, then run:

```powershell
npm run host-patch -- remove --asar "$asar" --capsule --json
```

Run the status command again and confirm `features.capsule` is `false` while any
retained localization remains present, then reopen the client. Backup history is
retained.

### Host rules

- The saved plan binds the target and payloads; `apply --plan` rejects overrides.
- Every archive write qualifies the paired executable's Electron integrity fuses and
  refuses unknown or enforced integrity without changing fuses.
- Adding, removing, or preserving localization requires the client to be closed.
- Retained feature contributions are hash-bound and validated without rebuilding
  another feature. Older localization payloads without prepared contributions refuse
  partial changes and are not silently converted; restore all features through the
  exact original chain before reapplying reviewed inputs.
- A newly reviewed plan for the same installed inputs is already `current`. Updating
  only observed-source evidence creates a new hash-bound archive and receipt through
  the managed input-hash comment, and earlier receipts and the original backup remain
  unchanged.
- After reviewing recovery, `remove --all` restores the verified original instead of
  guessing from the current bundles.
- Localization plans accept the recorded `probe-only` profiles with an
  `UNTESTED_BUILD` warning, and ASAR/executable hash drift emits `IDENTITY_DRIFT`
  without blocking unrelated modifications. An existing profile, valid selected assets,
  paired executable/fuse qualification, unique adapter anchors, and bound plan inputs
  are still required. This permission is not real-client acceptance; see
  [localization status](localization.md#current-status).
