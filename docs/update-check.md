# Update Compatibility Checker

`agyctl check` inspects Antigravity installers or installed files and reports
whether a build still matches what agyctl's features expect. It never patches the
client, starts extracted applications, or closes a running client.

It shares install discovery data and the registry of original function bodies
([versions.json](../compat/versions.json)) with the other tools, but not their patch
or executable/ASAR parsing code.

The checker is a screening tool. A `compatible` verdict does not apply patches or
prove that monitoring, capsule mounting, or a larger context window works end to
end, and it gates nothing: each modification feature runs its own exact gate when
applied (see [client modifications](operations.md#client-modifications-from-the-cli)).

The context probe recognizes the legacy common-floor body and independently screens
`linked-v2` and PE x86-64 `linked-v3-summary` per-model bodies and their bounded
table chain. Recognized per-model
fingerprints include `clamp.model_limits`. This is still not the patcher's
placement, original-backup, or stopped-process gate; use `limit status` for the
installed-setting readback described in
[operations](operations.md#per-model-context-settings).

## Commands

Build the tools first (Go 1.26 or newer); no panel installation is required and
checker commands do not build the executable for you:

```bash
npm ci               # skip if dependencies are already installed
npm run tools:build
```

See also the [README](../README.md#compatibility-checker).

### Inspect an installed client

```bash
npm run update-check:local
```

This inspects the selected installation: `AGYCTL_APP_DIR` when set, otherwise
the only installation found in the default paths. To select the stable channel,
pass `--channel antigravity`. Local channel names are `antigravity` (stable/Hub) and
`insiders`; the downloaded-installer channel for the stable app is `hub`, not
`antigravity`.

```bash
npm run update-check:local -- --channel antigravity
```

```powershell
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\antigravity'
npm run update-check:local -- --install-dir "$installDir"
```

`--channel` filters the candidate installations, and several remaining matches
require an explicit `--install-dir` or `AGYCTL_APP_DIR` rather than taking the first.
An invalid environment root is an error, not a request to try another installation;
see [installation selection](operations.md#installation-selection).

`local` reads only the selected installed files. It never discovers an LS port or
calls a running client, so one installation yields the same verdict whether or not
the client is open. Capsule anchors are checked by the capsule gate, not here, and
live monitoring behavior is validated by the panel through its own Connect-RPC
calls.

With an explicit installation root, an unreadable or missing LS does not discard the
ASAR/UI findings. The report keeps the ASAR hash, marks the context and models
probes failed with the LS error, and exits with an overall error.

### Inspect downloaded installers

These commands download and inspect installers, not the installed client.

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

The platform matrix is exactly `win-x64`, `linux-x64`, and `darwin-arm64`. It
describes installer inspection coverage, not patcher or native-runtime support.

### Inspect manually downloaded installers

Keep manually supplied installers apart from the managed download cache:

```text
var/update-check/inputs/
  win-x64/
  linux-x64/
  darwin-arm64/
```

Keep original filenames and use separate platform directories; directory and
filename labels are not treated as evidence of the packaged architecture.

```bash
# Recursively inspect the default var/update-check/inputs directory.
npm run update-check:files

# Inspect another input directory and keep extraction scratch for review.
npm run update-check:files -- --input-dir /path/to/installers --keep-work
```

`files` reads regular `.exe`, `.zip`, `.deb`, `.dmg`, and `.tar.gz` inputs without
following symbolic links. It uses the same extraction and static probes as `check`,
infers platform and architecture from the packaged LS, and records the ASAR package
identity. Unsupported target pairs are rejected. It does not resolve release feeds,
download installers, run live probes, or execute extracted content. EXE and DMG
extraction needs a locally available 7-Zip; a missing tool is an error, not a
download.

Input hashes identify the inspected bytes; they do not authenticate the publisher.
Inputs are hashed before and after inspection to detect changes. Each installer gets
its own saved JSON report, and the batch JSON result lists the input path, detected
platform, exit code, and report path. An invalid installer does not suppress results
for the others; the batch returns the highest exit code. An empty or missing input
directory is an error.

Do not populate `work/downloads/` or fabricate `archive.json` entries to use this
workflow.

### Options and defaults

Every command accepts `--work-dir` and `--reports-dir`; the defaults are
`var/update-check/work` and `var/update-check/reports` under the checkout. Any other
option a command does not list is an error.

| Command | Options | Defaults |
| --- | --- | --- |
| `versions` | `--channel`, `--platform`, `--version`, `--limit` | All channels and platforms. `--limit` (default 10) applies only to one non-Insiders channel on one platform; Insiders always resolves its current feed |
| `local` | `--channel insiders\|antigravity`, `--install-dir` | The only matching installation (`AGYCTL_APP_DIR` when set, otherwise the default paths); several matches require `--install-dir` or `AGYCTL_APP_DIR` |
| `check` | `--channel hub\|insiders`, `--platform` (repeatable), `--matrix`, `--version`, `--skip-download`, `--keep-work` | Hub on the host's own platform |
| `files` | `--input-dir`, `--keep-work` | `var/update-check/inputs` |
| `report` | `--file` | The newest saved report |

### Reading the result

Each run prints a JSON result and saves a report under `var/update-check/reports/`.
Render the newest saved report again, or the one named by `--file`, with:

```bash
npm run update-check:report
```

Exit codes: `0` compatible, `1` needs-review, `2` incompatible, `3` error. Matrix and
local-installer batches return the highest cell exit code.

In the report, `target` identifies the input, `capabilities` holds the
context/model/UI/localization findings, and `capability_matrix` holds
feature-specific restrictions. The checker never writes trust data.

Extraction scratch is removed unless `--keep-work` is given. Verified downloads and
reports stay under the Git-ignored `var/` tree for reuse and are never committed.

## Feed resolution and cached inputs

[feed.go](../src/agyctl/internal/check/feed.go) defines the upstream endpoints and
asset rules:

- **Hub** uses a Cloud Run `/releases` response containing `version` and
  `execution_id`, then constructs a Google Cloud Storage asset URL. Platform
  directories are `windows-x64`, `linux-x64`, and `darwin-arm`. Windows releases use
  `Antigravity-x64.exe`.
- **Insiders** uses `latest-{arch}-{os}.yml` under the public Insiders bucket; Linux
  x64 selects a `.deb`. A missing current feed is an error, not a reason to derive
  another architecture or substitute an asset.
- `--version` selects a stable app release for `versions` and `check`; Insiders
  resolves its current YAML feed.

Downloads and `archive.json` live under `var/update-check/work/`. Cache entries use
`downloads/{channel}/{version}[-{execution_id}]/{platform}/{filename}`. Reuse
requires an `archive.json` record whose URL, path, channel, platform, version, and
execution ID all match, and SHA-256 binds reuse to that record; feed size and
SHA-512 are checked when the feed supplies them. A locally computed digest is not an
independent publisher signature. `--skip-download` still resolves the feed and
verifies a matching cache record, so it is not an offline mode.

## Pipeline and probes

[cli.go](../src/agyctl/internal/check/cli.go) coordinates feed resolution, download,
extraction, probes, and report publication. Extracted files are untrusted data and
are never executed. Supported archive paths are NSIS, TAR/GZIP, ZIP, Debian AR
packages, and DMG through 7-Zip. Format support does not guarantee that every
upstream installer extracts.

Downloads and extraction run under time, size, and entry budgets. These are
cooperative bounds, not a hard filesystem quota
([extract.go](../src/agyctl/internal/check/extract.go)).

| Probe | What the implementation establishes | What it does not establish |
| --- | --- | --- |
| Context | Finds Go function metadata, records the clamp size and body, and classifies it as a known original, a recognized patch, or unknown bytes | Provider capacity, successful long requests, or correct runtime compaction |
| Models | Counts embedded catalog/RPC marker strings | That an RPC works or a model is available to the account |
| UI | Reads ASAR members, checks `dist/main.js` and `dist/preload.js`, and searches the preload for `webFrame` and `executeJavaScript` | A valid injection AST, successful capsule mounting, or visible activation |
| Localization | Requires a readable `dist/preload.js` and matches the recorded ASAR or LS identity against the loaded profile store: pass for verified, warn for probe-only or unlisted | Asset transform admission, a safe adapter edit, or live translated UI |
| Integrity | Reads the paired Electron executable's fuse wire | A full platform signing/notarization or OS acceptance check |

Context classification compares the clamp body with the originals in
[versions.json](../compat/versions.json), using the checker's own parser. A missing
clamp or an unexpected size (`0x80` on x86-64, or the recognized `0x160` summary ABI
on PE x86-64; `0x90` on ARM64) fails; a body that
is neither a recorded original nor a recognized patch warns. See
[probes.go](../src/agyctl/internal/check/probes.go). Symbolic-link ASAR members are
rejected ([asar.go](../src/agyctl/internal/check/asar.go)), and ELF Go text bases
must be proven rather than assumed
([pclntab_elf.go](../src/agyctl/internal/check/pclntab_elf.go)).

Windows Hub 2.33.0's inspected package member
`resources/bin/language_server.exe` has a 352-byte clamp at VA `0x141821280`, with
original SHA-256
`6c3e3ab006baf9105efd7d5a8545bddc8fdaef102f578d3bee9aad6967ebae25`.
The independent checker recognizes its original only from the registry and its
patch only from the complete screening template plus validated table nodes. It
does not import the limit assembler or planner. A size match alone does not pass;
the new layout does not qualify ELF or ARM64. See the
[ABI and qualification evidence](limit-patch.md#per-model-encoding).

`ui.staticHookEvidence` records only the two preload marker strings.
`ui.capsuleIntegrity` records fuse qualification: enabled ASAR-integrity enforcement
blocks modification, and missing, unknown, or unreadable fuse metadata requires
review. An otherwise allowed fuse result does not replace installer-specific checks.
Electron documents the underlying
[ASAR integrity behavior](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)
and [fuses](https://www.electronjs.org/docs/latest/tutorial/fuses).

### Verdict and capability matrix

Each main capability has `pass`, `warn`, or `fail`; the aggregate maps to
`compatible`, `needs-review`, or `incompatible`. Probe or input errors are reported
separately as `error`. Localization participates in the aggregate: a build that
matches no profile, or only a `probe-only` profile, warns, so an otherwise passing
build yields `needs-review` (exit `1`).

Reports also contain a `capability_matrix` for read-only monitoring, installer
inspection, capsule injection, localization delivery, and limit patching
([report.go](../src/agyctl/internal/check/report.go)). These rows are
checker-derived classifications, not execution results:

- The monitoring row depends only on model evidence, so a failed patch-target probe
  does not make read-only telemetry unavailable.
- `localization_delivery` maps its own verdict independently.
- An unknown context body keeps limit patching `blocked` in this matrix. The
  patcher's own byte gate remains the actual admission authority.
- PE and ELF64 x86-64 are the admitted limit-patch pairs. Matching bytes on Mach-O
  ARM64 do not make it patchable, because macOS signing and original-body
  qualification remain separate requirements. Unknown or unexpected-size bodies are
  refused.
