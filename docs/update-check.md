# Update Compatibility Checker

The Go `agyctl check` command inspects installers or installed files without
patching the client, starting extracted applications, or closing a running client.
It shares install discovery data and the registry of original function bodies
([versions.json](../compat/versions.json)) with the other tools, but not their
patch or executable/ASAR parsing implementations. Its verdicts gate nothing:
each modification feature runs its own exact gate when it is applied; see
[client modifications](operations.md#client-modifications-from-the-cli).

This is a compatibility screening tool, not proof that monitoring, capsule
mounting, or a larger context window works end to end.

The context probe recognizes the legacy common-floor body and independently
screens `linked-v2` per-model bodies and their bounded table chain. Recognized
per-model fingerprints include `clamp.model_limits`; this is still not the
patcher's full placement, original-backup, or stopped-process gate. Use
`limit status` for the installed setting readback described in
[operations](operations.md#per-model-context-settings).

## Commands

The checker is a CLI-only task; Settings has no report control. From
the repository root, install dependencies and build the tools first (Go 1.26 or
newer):

```bash
npm ci
npm run tools:build
```

Skip `npm ci` if dependencies are already installed. Running a checker command
does not build the executable automatically, and no panel installation is
required. See the [README](../README.md#compatibility-checker).

### Inspect an installed client

The default command inspects the selected Antigravity stable installation
(`AGYCTL_APP_DIR` when set, otherwise the default path):

```bash
npm run update-check:local
```

Local channel names are `antigravity` (stable/Hub) and `insiders`. The
downloaded-installer channel for the stable app is `hub`, not `antigravity`.
To filter a default-path installation by channel:

```bash
npm run update-check:local -- --channel antigravity
```

Use `--install-dir` for an explicit installation root, for example:

```powershell
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\antigravity'
npm run update-check:local -- --install-dir "$installDir"
```

Without `--install-dir`, local checking uses `AGYCTL_APP_DIR` when set, otherwise
the default installation paths. `--channel` filters those candidates; several
matches require an explicit selection instead of taking the first. An invalid
environment root is an error, not a request to try a different installation.
See [installation selection](operations.md#installation-selection). The check
reads only the selected installed files and never contacts a running client,
so the same installation yields the same verdict whether or not the client is open.

With an explicit installation root, an unreadable or missing LS does not discard
the ASAR/UI findings. The report retains the ASAR hash, marks context
and models failed with the LS error, and still exits with an overall error.

### Inspect downloaded installers

These commands download or inspect installers, not the installed client. The
downloaded-installer channels include `hub` and `insiders`:

```bash
# Resolve the latest Hub and Insiders assets for the three supported platforms.
npm run update-check:versions

# List up to five Hub releases for one platform.
npm run update-check:versions -- --channel hub --platform win-x64 --limit 5

# Download, extract, and inspect one installer. Without --channel/--platform,
# check uses Hub and the platform of the machine running it.
npm run update-check:check -- --channel hub --platform win-x64

# Inspect Hub + Insiders across all three platforms, sequentially
# (--matrix ignores --channel; --platform, repeatable, narrows the platforms).
npm run update-check:check -- --matrix
npm run update-check:check -- --channel insiders --platform linux-x64

# Reuse a cached installer after checking its recorded digest and metadata.
npm run update-check:check -- --matrix --skip-download
```

### Inspect manually downloaded installers offline

Keep manually supplied installers separate from the managed download cache:

```text
var/update-check/inputs/
  win-x64/
  linux-x64/
  darwin-arm64/
```

Retain original filenames in separate platform directories. Directory and filename
labels are not evidence of the packaged architecture.

```bash
# Recursively inspect the default var/update-check/inputs directory.
npm run update-check:files

# Inspect another input directory and retain extraction scratch for review.
npm run update-check:files -- --input-dir /path/to/installers --keep-work
```

The `files` command reads regular `.exe`, `.zip`, `.deb`, `.dmg`, and `.tar.gz`
inputs without following symbolic links. It uses the existing extraction and
static probe implementations, infers platform and architecture from the packaged
Language Server, and records the ASAR package identity. Unsupported target pairs
are rejected instead of re-enabling removed architectures. It does not resolve release feeds, download installers,
run live probes, or execute extracted content. EXE/DMG
extraction requires a locally available 7-Zip tool; missing tools produce an
error rather than a download.

Local input hashes identify the inspected bytes; they do not authenticate the
publisher. Inputs are hashed before and after inspection to detect changes.
Each installer gets its own saved JSON report, and the batch JSON result includes
the input path, detected platform, exit code, and report path. An invalid installer
does not suppress results for the remaining files; the batch returns the highest
exit code. An empty or missing input directory is an error.

Do not manually populate `work/downloads/` or fabricate `archive.json` entries to
use this workflow. The `inputs/` directory, extraction scratch, and reports remain
under the Git-ignored `var/` tree. See
[files.go](../src/agyctl/internal/check/files.go) for the local input flow.

### Options and defaults

Every command accepts `--work-dir` and `--reports-dir`; the defaults are
`var/update-check/work` and `var/update-check/reports` under the checkout. Any
other option a command does not list is an error, not ignored
([cli.go](../src/agyctl/internal/check/cli.go), `parseOptions`).

| Command | Options | Defaults |
| --- | --- | --- |
| `versions` | `--channel`, `--platform`, `--version`, `--limit` | All channels and platforms. `--limit` (default 10) applies only to one non-Insiders channel on one platform; Insiders always resolves its current feed |
| `local` | `--channel insiders\|antigravity`, `--install-dir` | The only matching installation (`AGYCTL_APP_DIR` when set, otherwise the default paths); several matches require `--install-dir` or `AGYCTL_APP_DIR` |
| `check` | `--channel hub\|insiders`, `--platform` (repeatable), `--matrix`, `--version`, `--skip-download`, `--keep-work` | Hub on the host's own platform |
| `files` | `--input-dir`, `--keep-work` | `var/update-check/inputs` |
| `report` | `--file` | The newest saved report |

### Read the result

Inspect the JSON result and the report under `var/update-check/reports/`. To
render the newest saved report again:

```bash
npm run update-check:report
```

Exit codes are `0` compatible, `1` needs-review, `2` incompatible, and `3`
error. Matrix and local-installer batches return the highest cell exit code.
Inspect `target` to confirm the input, `capabilities` for context/model/UI/localization findings, and
`capability_matrix` for feature-specific restrictions. A compatible verdict does
not apply patches or prove live activation. The checker never writes trust data.

The platform matrix is exactly `win-x64`, `linux-x64`, and `darwin-arm64`.
This is **installer inspection coverage**, not patcher or native-runtime proof.
Both current app channels remain; the historical IDE feed is removed.

## Feed resolution and cached inputs

[feed.go](../src/agyctl/internal/check/feed.go) defines the upstream endpoints
and asset rules:

- Hub uses a Cloud Run `/releases` response containing `version` and
  `execution_id`, then constructs a Google Cloud Storage asset URL. Platform
  directories are `windows-x64`, `linux-x64`, and `darwin-arm`.
  Current Windows releases use `Antigravity-x64.exe`; historical filename exceptions
  are not supported.
- Insiders uses `latest-{arch}-{os}.yml` under the public Insiders bucket.
  Linux x64 selects a `.deb`; missing current feeds are errors, not a reason to
  derive another architecture or silently substitute an asset.
- `--version` selects a stable app release for `versions` and `check`; Insiders
  resolves its current YAML feed.

Downloads and `archive.json` are retained under `var/update-check/work/`.
Cache entries use
`downloads/{channel}/{version}[-{execution_id}]/{platform}/{filename}`; reuse
requires an `archive.json` record whose URL, path, channel, platform, version, and
execution ID all match. `--skip-download` still resolves the feed and verifies a matching cache record:
it is not an offline mode. SHA-256 binds reuse to that record; feed size and
SHA-512 are checked when supplied. A locally calculated digest alone is not an
independent publisher signature.

## Pipeline and evidence

[cli.go](../src/agyctl/internal/check/cli.go) coordinates feed resolution,
download, extraction, probes, and report publication. Extracted files remain
untrusted data. Supported archive paths include NSIS, TAR/GZIP, ZIP, Debian AR
packages, and DMG through 7-Zip; format support does not guarantee every upstream
installer will extract successfully.

| Probe | What the implementation establishes | What it does not establish |
| --- | --- | --- |
| Context | Finds Go function metadata, records clamp size/body, and classifies known original, recognized patch, or unknown bytes | Model-provider capacity, successful long requests, or correct compaction at runtime |
| Models | Counts embedded catalog/RPC marker strings | Static markers alone do not prove an RPC works or a model is available to the account |
| UI | Reads ASAR members, checks `dist/main.js` and `dist/preload.js`, and searches the preload for `webFrame` and `executeJavaScript` | A valid injection AST, successful capsule mounting, or visible activation |
| Localization | Requires readable `dist/preload.js`; matches either recorded ASAR or LS identity against the snapshot-loaded profile store, yielding pass for verified, warn for probe-only or unlisted | Asset transform admission, a safe adapter edit, or live translated UI |
| Integrity | Reads the paired Electron executable's fuse wire | A full platform signing/notarization or OS acceptance check |

Context classification compares the clamp body with the originals in
[versions.json](../compat/versions.json), the same registry the limit patcher
gates on, using its own parser. A missing clamp or unexpected size (`0x80`
x86-64, `0x90` ARM64) fails; a body that is neither a recorded original nor a
recognized patch warns. See [probes.go](../src/agyctl/internal/check/probes.go).
Symbolic-link ASAR members are rejected ([asar.go](../src/agyctl/internal/check/asar.go));
ELF Go text bases must be proven, not assumed
([pclntab_elf.go](../src/agyctl/internal/check/pclntab_elf.go)).

Each main capability has `pass`, `warn`, or `fail`; the aggregate maps to
`compatible`, `needs-review`, or `incompatible`. Probe/input errors are reported
separately as `error`.

Localization participates in the aggregate and exit code: a build that matches
no profile, or only a `probe-only` profile, warns, so an otherwise passing build
yields `needs-review` (exit `1`). Nothing
consumes the aggregate as an admission gate: each feature runs its own exact gate
(limit byte signature, capsule anchors, localization qualification) when applied.
`node scripts/manage.mjs status` reports those gates read-only for an installed
client.

Reports also contain a `capability_matrix` for read-only monitoring, installer
inspection, capsule injection, localization delivery, and limit patching. These
are checker-derived classifications, not independent execution results. The
monitoring row depends only on model evidence: a failed patch-target probe does
not make read-only telemetry unavailable. `localization_delivery` maps its own
verdict independently. An unknown context body keeps limit patching `blocked`
in this screening matrix; the patcher's own byte gate remains the actual
admission authority.
PE and ELF64 x86-64 are the admitted limit-patch pairs. Matching bytes on
Mach-O ARM64 do not make it patchable: macOS signing and original-body
qualification remain separate requirements. Unknown or unexpected-size bodies
are refused.
See [report.go](../src/agyctl/internal/check/report.go).

`ui.staticHookEvidence` records only the two preload marker strings.
Live capsule mounting and activation are unknown. `ui.capsuleIntegrity` records
fuse qualification: enabled ASAR-integrity enforcement blocks modification;
missing, unknown, or unreadable fuse metadata requires review. An otherwise
allowed fuse result does not replace installer-specific checks.
Electron documents the underlying [ASAR integrity behavior](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
and [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).

## Running clients

`local` inspects installed files only. It does not discover a Language Server
port or call a running client: that evidence depends on whether, and which,
client process is running, so it would make one installation report different
verdicts at different times. Capsule anchors are not checked here either; the
capsule anchor gate owns them. Live monitoring behavior is validated by the
panel against its own Connect-RPC calls, not by this checker.

## Resource limits and output

Downloads and extraction run under time, size, and entry budgets; these are
cooperative bounds, not a hard filesystem quota. See
[extract.go](../src/agyctl/internal/check/extract.go).

`report` selects the newest saved report, or the one named by `--file`.
Extraction scratch is removed unless `--keep-work` is given; verified downloads
and reports stay under `var/` for reuse and are never committed.

`npm run tools:test` runs the Go suites, including synthetic executable/archive
fixtures and checker cases. Passing those tests does not qualify an actual new
Antigravity build. Run each feature's own gate against an installed client for
that.
