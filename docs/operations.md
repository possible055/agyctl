# Operations Guide

This guide covers client modifications from the CLI, panel settings, capsule backups, recovery boundaries, reviewed Host changes, and localization apply. See the [README](../README.md#prepare-the-tools) for setup, [architecture.md](architecture.md) for component boundaries, and [localization.md](localization.md) for the localization stages and offline preparation. Run commands from the project root. Commands that apply, remove, or restore change the installed client; inspection alone does not authorize those actions.

## Client modifications from the CLI

The panel never changes the installed client: its Settings view only lists the commands below. This project does not close, relaunch, or supervise the client. Close the selected installation yourself before any write. The process checks differ by feature:

- **Context limit:** `agyctl limit patch --apply` and `restore` refuse while the selected installation's client or Language Server is running, or when the process state cannot be read. Another installation's server does not block the selected one.
- **Host changes that add, remove, or preserve localization:** refuse while a process with the target client's executable name is running (`tasklist` on Windows, `pgrep -f` elsewhere), and refuse when that check is unavailable (`CLIENT_RUNNING`, `CLIENT_RUNNING_UNKNOWN`). The check runs again inside the Host lock.
- **Capsule-only install or removal:** does not check the client process. Closing the client is your responsibility.

Every writing command refuses a target it cannot qualify, so a refusal is the expected outcome on an unknown build; do not work around it. Update the project itself with `git pull`, `npm ci`, and `npm run plugin:install`.

Each feature has one gate that decides whether the installed bytes are known. A failing gate writes nothing and names what no longer matches:

| Feature | Gate | Read-only check |
| --- | --- | --- |
| Context limit | The installed clamp function body must equal an original recorded in [versions.json](../compat/versions.json) | `npm run limit:status`, or `npm run limit:patch` without `--apply` |
| Capsule | Executable and ASAR qualification, plus every anchor in [anchors.js](../src/capsule/anchors.js) present in the Language Server's served web bundle | `node scripts/manage.mjs status` (`capsuleAnchors`); `npm run capsule:install` runs the same gate and refuses before any write |
| Localization | Reviewed profile or structural evidence, adapter anchors, and bound plan inputs | `node scripts/manage.mjs status`, `prepare`, and `--host-preflight` below |

The capsule anchor gate parses the embedded web bundle with bounded extraction and never executes it. Anchors are the capsule's one volatile upstream dependency: a renamed selector is caught when the client changes, not after the capsule silently fails to mount. The tests cover the token derivation and refusal with synthetic bundles; the opt-in installed-client test checks every installation on the machine and reports SKIP when none exists.

The panel data directory is `ANTIGRAVITY_EXECUTABLE_DATA_DIR` when the host provides it, otherwise `~/.gemini/antigravity/sidecar_data/agyctl/panel/data`; that Hub-named fallback does not establish automatic Hub/Insiders data isolation. It holds two files, each written atomically through a temporary file: `settings.json` (schema 3) stores only the refresh interval (`pollIntervalSeconds`, integer 10–300, default 10 when the file is absent), and `pricing.json` (schema 1) stores custom model prices. Other settings schemas are refused; other fields in a schema 3 file are ignored on read and rejected on save. The standalone development server binds only to loopback. See [settings.mjs](../src/plugin/sidecars/panel/settings.mjs).

### Localization preparation and apply

`node scripts/manage.mjs` prepares and applies localization plans against one selected installation; it has no job, close, or relaunch behavior. It runs the built bundles directly, so build first: `npm run host:build` always, `npm run localization:build` before `prepare --localization`, and `npm run tools:build` if `status` should report the limit state. Each command prints JSON.

- `status [--asar ABS_PATH] [--localization-plan ABS_PLAN]` reports Host features, `capsuleAnchors`, localization, limit, and client-process state for one installation. Without `--asar` it uses the only discovered installation; with several it reports an error and asks for an explicit absolute archive path.
- `prepare --localization --locale zh-Hant-TW` runs the offline localization `prepare` for the target's Language Server, then writes a private, target-bound Host plan to `<agyctl home>/management/plans/<sha256>-<uuid>.json` (mode `0600`) and returns its path as `localizationPlan`. Without `--asar` it requires exactly one discovered installation; add `--capsule` when the plan should also install or update the capsule. The locale must be canonical (`en`, `zh-Hant-TW`, `zh-Hans-CN`, `ja-JP`), and the target must be the host's own platform. Preparation verifies local assets against the profile for the original archive; it does not create profiles or bypass source checks.
- `--host-preflight --asar ABS_PATH --localization-plan ABS_PLAN` verifies the plan without writing. `--host-apply` with the same arguments applies it, requires the client to be closed, and then writes the locale selection. Both refuse when the plan file, the Language Server, or the saved selection changed since `prepare`; prepare again instead of editing the plan. Include `--capsule` when the plan updates the capsule; an unselected installed capsule stays bound to the plan unchanged.

Capsule and localization are composed once from one verified original, not applied as separate stale plans; unselected installed features are preserved. Changing the AGY language alone does not translate Antigravity. Preparing the localization artifact itself is described in [localization.md](localization.md#offline-inspection-and-preparation).

Direct `agyctl limit` commands patch PE/ELF x86-64 targets; Mach-O ARM64 binaries are inspected as data and report `unavailable`, and macOS limit mutation is refused until its original bytes, code placement, and signing strategy are qualified; see [macOS admission requirements](context-chain-analysis.md#macos-admission-requirements).

## Interface languages

AGY supports English, Traditional Chinese, Simplified Chinese, and Japanese.
With the current Capsule Host bridge active, the Capsule language button and
panel language selector update the same Host-owned state, including open tooltips
and menus. Saved preference takes priority over the declared Host and system
languages. Old `zh-TW` and `zh-CN` preferences remain readable.

A panel-only installation remains independently usable and saves its own choice.
It does not require the optional Capsule patch. Language selection never edits
ASAR or restarts the application. Antigravity localization is a separate
feature that requires a prepared artifact and a reviewed plan; see
[localization.md](localization.md).

`npm run capsule:build` validates product dictionary completeness and the selected
Japanese vendor source mappings. `npm run test:electron` includes a controlled
real-Electron Capsule/panel test; a missing Electron binary is reported as SKIP.
That fixture verifies owned HTTP and `plugin://` frames, not placement or runtime
qualification in an installed client.

## Model prices

Under **Settings → Model prices**, use an exact server model alias or a built-in model family and enter all four rates in USD per million tokens; zero is valid. Custom prices override built-in rates for matching historical usage. Deleting an override restores the built-in rate when one is known. Panel saves are checked against the loaded revision. The capsule discovers the panel pricing endpoint and validates the returned price schema/revision; it does not require matching source versions. Prices and resulting costs are local estimates, not an account bill, and price edits do not patch the client.

## Capsule backups

The capsule installer retains an installation-specific original archive and unpacked files, refusing to overwrite conflicting backup contents. Recovery records pair the exact original and installed archive hashes; a hook marker alone never authorizes restoration.

- Existing legacy backups are preserved, not overwritten, and are not migrated automatically.
- Unknown, corrupted, or mismatched backups require manual review; `--force` does not bypass pairing.
- The archive is staged and validated before replacement; the unpacked-sidecar manifest is checked.

Installation and removal report persisted, hash-verified archive state. Neither proves that the capsule visibly mounted: reopen the client and look. To undo an installation, use the capsule-uninstall recovery path for the same installation and verified backup; with multiple installations use the explicit-target [reviewed Host removal](#reviewed-host-changes), which uses the same Composer removal path. Do not restore an unrelated archive or another installation's backup.

## Recovery boundaries

Recovery is component-specific, not a single transaction across the client:

- **Host archive:** `ensureOriginalBackup` verifies the archive and unpacked
  sidecar before publishing a hash-named original backup. Existing contents must
  verify; conflicting or incomplete state is rejected rather than overwritten.
  A backup, feature-input record, or receipt may remain after a later operation
  fails. See [Host Composer](../src/host/compose.ts).
- **One archive replacement:** `replaceFileTransaction` validates staging,
  checks the current hash, copies and verifies a rollback file, then replaces
  and revalidates the target. After a post-replacement failure it attempts rollback
  only while the target still matches the staged hash. If that check or rollback
  fails, it reports an unknown outcome and the actual remaining recovery path.
  After a restore rename, that path is the target itself, not a nonexistent
  separate copy. A successful commit returns cleanup errors separately; a
  temporary-directory cleanup failure does not mean installation failed. It does not
  guarantee power-loss durability; no file synchronization is performed by this
  helper. See [file-transaction.mjs](../scripts/lib/file-transaction.mjs).
- **Limit binary:** backup reuse requires matching hashes; prepare records make
  interrupted states inspectable. A failed post-write check attempts guarded,
  hash-verified rollback only while anomalous target contents remain stable.
  Verified rollback clears the prepare record; drift, unreadable contents, or
  restoration failure returns `ErrRollbackFailed` and retains the prepare record
  and a recovery copy. See
  [the exact limit recovery contract](context-chain-analysis.md#backup-and-recovery-boundaries).
- **Multiple features:** capsule and localization are one Host transaction over one verified original. The limit patch is a separate operation on the Language Server binary; a failure in one never reverses the other, so check each feature's status after a failed run.

On failure, read the command result, current feature status, and any
prepare/recovery records before retrying. Do not delete originals or treat a
failed command as proof that no installation bytes changed. Restore only through
the component's matching-backup checks; an application update or target drift
requires review rather than forcing an older backup over new files.

## Reviewed Host changes

Use this workflow when you need an explicit Capsule target or a saved plan before modifying `app.asar`. Unlike ordinary `npm run capsule:install` and `npm run capsule:uninstall`, Host commands accept `--asar` directly. Ordinary Capsule commands select the first detected installation, currently Insiders before Hub; adding `--asar` alone to those commands is not supported.

### Prepare and review

Run `npm ci` first if dependencies are not installed. Host npm commands build the
neutral Host bundle, not localization. Build localization separately only when
preparing that feature. To save a clean JSON plan in PowerShell 7, build separately
and invoke Node directly so build logs stay out of the UTF-8 file. This example
targets the default Windows Insiders installation; change `$asar` first if needed:

```powershell
npm run host:build
npm run capsule:build
$asar = Join-Path $env:LOCALAPPDATA 'Programs\antigravity-insiders\resources\app.asar'
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
