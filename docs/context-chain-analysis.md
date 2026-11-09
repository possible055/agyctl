# Language Server Context-Limit Patch

This document describes the evidence and modification boundary of
`agyctl limit` for the Antigravity desktop Language Server. It is not a
complete specification of upstream context management. Hub 2.x and Insiders 1.0.x
are product families, not compatibility guarantees.

For stable component boundaries, see [architecture](architecture.md). Exact
inspected shell and web-asset identities are in
[upstream analysis](upstream-analysis.md#package-identities).

## Evidence scope

The tracked [signature registry](../compat/versions.json) lists the original
entries shown by `npm run limit:versions`. At this revision, only the Windows x64 Insiders entry records live behavioral
observation; the Hub `2.29.0` Linux entry records a body that was verified
statically and by read-only dry-run planning against the recorded binary:

| Entry | Platform / arch | Original LS size | Original LS SHA-256 |
| --- | --- | ---: | --- |
| Insiders `1.0.20261103110059` | win32 x86-64 | 188,926,976 bytes | `ec9d5f4a1d357fce6a260395c658759bac863c022225336d2acab819932f4c1f` |
| Hub `2.29.0` | linux x86-64 | 195,948,944 bytes | `cac05cef325e91df2f86215ba01ecdabd85fc6629057e0eb5eb59b0c51bf0419` |

Both entries record the same 128-byte x86-64 original body. Static inspection
also found it byte-for-byte in the Windows x64 Hub `2.29.0` build, which has no
registry entry of its own:

```text
x86-64 SHA-256: 048bdf996a4261a772de3029774d32e830c87a153e2647eb22642cce0f0277a4
```

The Insiders registry note records a live observation of a `500000` checkpoint
limit on targeted models.

Static inspection on 2026-11-08 of Hub `2.29.0`'s upstream member
`resources/bin/language_server.exe` also found the 128-byte original body by its
Go pclntab symbol. The inspected binary has this whole-file identity:

```text
SHA-256: c98e7c331da5bcc37002a550e7d625b4c636f775fa2804f73777c6a500e1c3d5
```

This is a static package-byte observation; see the
[reproduction procedure](#reproduce-the-binary-observations).

The checker reads its original function bodies from the same registry, so
neither tool carries a second record of which bytes are original.

## What is established about upstream limits

The recorded original clamp body accesses the candidate limit at `[rax+0x0c]`.
The patch implementation interprets this as `CheckpointConfig.MaxTokenLimit`,
the model identifier at `[rbx+0x08]`, and the model context-window field at
`[rbx+0x14]`. These are layout assumptions of the admitted machine code, not
portable protobuf offsets for other versions.

Under that layout interpretation, the original instructions initialize a zero
limit using the model window minus `40000`, then apply context/reserve and output clamps.
The x86-64 replacement assembler reimplements those operations after its
model-specific raise. It does **not** simply copy an unchanged original byte
tail. See [asm.go](../src/agyctl/internal/limit/asm.go).

### ELF text base

In the externally linked linux builds, Go's `runtime.text` does not start at the
`.text` section: the inspected Hub `2.29.0` Linux x86-64 binary places it at
`.text + 0x80`. The patcher therefore resolves the
Go text base from the pclntab header and cross-validates it against the ELF
moduledata and its dynamic `RELATIVE` relocations before trusting any function
address; missing or contradictory evidence is refused. The patcher and checker
resolve it independently (see [elf.go](../src/agyctl/internal/limit/elf.go)
and [pclntab_elf.go](../src/agyctl/internal/check/pclntab_elf.go)); the patcher's
result is the one that gates writes. No test compares the two parsers on real
binaries.

The same Hub binary's Go pclntab locates the following symbols:

| Symbol | Observed size |
| --- | ---: |
| `utils.GetCheckpointConfig` | `0x540` |
| `config.applyFeatureProviderCheckpointOverrideConfig` | `0x200` |
| `config.selectCheckpointExperimentKey` | `0x1e0` |

`utils.GetCheckpointConfig` contains one occurrence of
`81 fa 00 e8 03 00 be 00 e8 03 00`, containing the integer `256000`.

The checker searches for these symbols and byte markers; it does not recover
their call graph, prove branch reachability for each model, or read the active
remote experiment configuration. A marker containing `256000` is not proof
that every conversation has that limit. Symbol addresses and body offsets vary
between builds and must not be reused as universal patch addresses.
See [probes.go](../src/agyctl/internal/check/probes.go).

### Observable context metadata

The project reads
`executorMetadata[].cascadeConfig.checkpointConfig.maxTokenLimit` from
`GetCascadeTrajectoryExecutorMetadatas`. `applyExecutorCapacity` accepts the
latest positive numeric limit and reads `tokenThreshold` separately; it does
not reconstruct the upstream configuration call graph. See
[metrics-core.mjs](../src/plugin/lib/metrics-core.mjs).

The panel's separate `readRecentContextLimits` reads `executor_metadata.data`
from recent conversation databases and applies `parseCheckpointLimits` to the
stored protobuf bytes. This is local-data parsing, not live server telemetry
or a complete protobuf schema. It is implemented in
[limit-diagnostics.mjs](../src/plugin/sidecars/panel/limit-diagnostics.mjs).

## Exact modification boundary

The production implementation is Go under
[src/agyctl/internal/limit/](../src/agyctl/internal/limit/).

1. [binary.go](../src/agyctl/internal/limit/binary.go) parses PE and ELF64
   x86-64 images and Mach-O ARM64 images
   ([macho.go](../src/agyctl/internal/limit/macho.go)), locates the target by its
   Go pclntab symbol, and derives its size. Only x86-64 images continue to
   planning; a Mach-O ARM64 image reports state `unavailable`. On ELF the Go text base is cross-validated against
   moduledata before any function address is trusted
   (see [ELF text base](#elf-text-base)).
2. [run.go](../src/agyctl/internal/limit/run.go) and
   [DetectState](../src/agyctl/internal/limit/asm.go) require the original
   body to match a recorded original for the detected architecture exactly.
   Version/channel labels are diagnostic; an unlisted build with known bytes
   can pass this body gate. Unknown bytes or a size other than the admitted
   size (`0x80` on x86-64) are refused.
3. `PlanPatch` places a 16-byte model-ID bitset in alignment padding near the
   function; it refuses if no suitable location exists. The location strategy
   is per-architecture and per-format — see [cave placement](#cave-placement)
   below.
4. `Assemble` builds the x86-64 replacement in place and raises the candidate
   limit for targeted models before the original clamp logic runs.
5. `ApplyPatch` writes only the planned function body and table in a copy of the input binary. Applying to the
   installation additionally requires the direct command's Language Server
   stopped-state check, verified backups, a prepare record, and hash-checked
   replacement.

Current defaults are `500000` tokens and model IDs
`1318-1320,1400-1405,1417-1419`, defined in
[asm.go](../src/agyctl/internal/limit/asm.go). IDs must fit within a 128-wide
bitset window. They are numeric enum targets, not a promise that model display
names or account availability remain unchanged.

The requested value is a candidate floor before the later clamps, **not** a
guaranteed effective context window. This patch does not change provider limits,
model access, remote profiles, `GetCheckpointConfig`, or `app.asar`.
Matching already-patched settings are recognized; changing them requires restore
first. See [operations.md](operations.md).

### Cave placement

The model-ID table lives in verified executable padding. Both PE and ELF x86-64
scan forward from the target for a run of at least 24 bytes of `0xcc` ending at a
later function entry. The planner refuses unknown bytes or an unusable address
map; see [binary.go](../src/agyctl/internal/limit/binary.go).

Windows/Linux ARM64 patch implementations and their fixtures have been removed.
macOS Apple Silicon is a selected tool target, but Mach-O mutation is unavailable
until the [admission requirements](#macos-admission-requirements) are met.

## Backup and recovery boundaries

The following are implemented conditions, not a promise that every failure
restores the previous installation:

1. `EnsureBackup` checks the source hash and creates a backup exclusively. It
   reuses an existing backup only when its hash matches, preserving and rejecting
   conflicting contents. `patchBinary` can choose `.orig.<original-sha>` when
   `.orig` belongs to another original. A failed initial backup write can leave
   a partial backup that a later attempt rejects. See
   [fsx.go](../src/agyctl/internal/fsx/fsx.go) and
   [run.go](../src/agyctl/internal/limit/run.go).
2. Only after the sibling and tool-state backups verify does `writePrepare`
   publish the intended original/new hashes and settings before replacement.
   Status can report `recorded`, `applied-not-recorded`, `prepared-not-applied`,
   or `target-drift`; it does not repair these states automatically. See
   [prepare.go](../src/agyctl/internal/limit/prepare.go), `prepareReport`.
3. `ReplaceVerified` checks the installed hash before staging and immediately
   before replacement, then checks the installed whole-file hash afterward.
   A failed post-write check attempts guarded rollback only after rereading and
   confirming stable anomalous contents. Restoration is staged, replaced, and
   hash-verified against operation-start bytes, retaining mode/mtime. It returns
   `ErrRolledBack` only after verification; drift, unreadable contents, or failed
   restoration returns `ErrRollbackFailed` and preserves recovery data. See
   [fsx.go](../src/agyctl/internal/fsx/fsx.go).
4. After a verified replacement, path-resolution or manifest-append failures
   trigger a guarded rollback attempt. That attempt requires the target still
   match the expected replacement hash and can itself fail. Other replacement
   errors do not enter this bookkeeping rollback path. A verified replacement
   rollback clears the prepare record; a failed rollback retains it. Patch and restore use
   this limited contract in [run.go](../src/agyctl/internal/limit/run.go).
5. Restore requires the LS stopped and verifies original bytes and backup
   pairing. With a manifest, current bytes must match the recorded patched hash;
   without one, a recognized patch must be reproducible from the original backup.
   An unrelated updated binary is not a restore target.

File synchronization and replacement checks do not constitute a guarantee
against arbitrary storage failure. The limit patch is independent of the Host
archive transaction: a failure in one never reverses the other. See
[recovery boundaries](operations.md#recovery-boundaries).

## macOS admission requirements

`PlanPatch` refuses ARM64 images and `compat/versions.json` has no `darwin/arm64`
entry. The inspected macOS packages, their `0x90`-byte clamp body, and their
signing layout are recorded in
[upstream analysis](upstream-analysis.md#macos-apple-silicon-signing-boundary).
Lifting the refusal requires one acceptance pass on a real Apple Silicon host with
those package identities, explicit user authorization for installed-client
mutation on that machine, and the built `darwin/arm64` tool:

1. Limit mutation on a copy of `Resources/bin/language_server` first, never the
   installed file: apply to the copy, confirm the byte gate admits only a recorded
   original, restore from the sibling backup, and re-hash. Only after the copy
   round trip passes, run apply, start, function, and restore against the installed
   client under the explicit authorization above.
2. A recorded re-signing decision. A patched Mach-O carries a stale Developer ID
   signature (team `EQHXZ8M8AV`, hardened runtime). Launch the patched server
   unmodified first and observe the expected code-signing kill; then re-sign the
   copy ad hoc (`codesign -s -`) and launch again. If the ad-hoc binary launches
   and functions, adopting ad-hoc re-signing is an explicit trust change that the
   status must surface. If the kernel still refuses it, macOS limit mutation stays
   unavailable; no fallback that disables integrity or strips signatures may be
   used.
3. Only a full pass adds the `compat/versions.json` entry and replaces the
   explicit refusal in the planner. The entry records byte-signature originals
   from the inspected builds, never a version cutoff.

## Conclusions that the evidence does not support

The inspected binary, registry, assembler, and checker implementation do not establish:

- a complete `CascadeManager` configuration/merge/compaction call sequence;
- that this function is the only possible configuration or modification point;
- that environment variables, flags, settings, or APIs cannot offer another control;
- that experiment profiles always set `256000`, or that every request takes
  the same initialization branch;
- end-to-end preservation of summary prompts, retries, snapshots, or compaction
  behavior merely because the patch writes a small region;
- live behavioral success of the patch on any platform: only the Insiders
  win32-x64 entry records live observation of the raised limit. The Hub 2.29.0
  Linux entry was verified statically and by read-only dry-run planning, and
  Linux live behavior is explicitly unverified;
- universal Hub 2.x/Insiders 1.0.x support, or successful
  requests at the configured larger limit.

Those claims require build-specific disassembly/data-flow evidence and, for
runtime behavior, separately authorized live validation. Static inspection alone
does not supply them. Read-only reproduction commands and the checker's limits
are documented in [update-check.md](update-check.md).

## Reproduce the binary observations

Obtain the exact Hub `2.29.0` Windows x64 package and compare
`resources/bin/language_server.exe` with the whole-file hash above. After
[building the tools](../README.md#prepare-the-tools), point
the checker at that installed or unpacked distribution root:

```powershell
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\antigravity'
npm run update-check:local -- --install-dir "$installDir"
```

Change `$installDir` for an unpacked package. Inspect the context capability's
symbol sizes, body hash, and marker counts in the generated report. The checker
parses the executable as data; it does not start it, apply a patch, or add a
baseline. Its [probe implementation](../src/agyctl/internal/check/probes.go)
defines what the observations establish.
