# Language Server Context-Limit Patch

This page describes how `agyctl limit` modifies the Antigravity desktop Language
Server (LS): the targeted function, the admission gate, the replacement encoding,
and recovery. It is not a specification of upstream context management. Commands
and status readback are in
[operations](operations.md#per-model-context-settings); component boundaries are in
[architecture](architecture.md#limit-admission-and-recovery).

## Upstream clamp

The recorded original `utils.ClampCheckpointConfigForModelInfo` body reads the
candidate limit at `[rax+0x0c]`. The patch interprets that as
`CheckpointConfig.MaxTokenLimit`, the model identifier at `[rbx+0x08]`, and the
model context-window field at `[rbx+0x14]`. These are layout assumptions of the
admitted machine code, not portable protobuf offsets.

Under that interpretation, the original initializes a zero limit to the model
window minus `40000`, then applies context/reserve and output clamps. The x86-64
replacement reimplements those operations after its model-specific raise rather
than copying the original machine-code body. The per-model encoding reuses the
generated legacy replacement's clamp tail. See
[asm.go](../src/agyctl/internal/limit/asm.go) and
[model_limits.go](../src/agyctl/internal/limit/model_limits.go).

To observe the result, the project reads
`executorMetadata[].cascadeConfig.checkpointConfig.maxTokenLimit` from
`GetCascadeTrajectoryExecutorMetadatas` (`applyExecutorCapacity` in
[metrics-core.mjs](../src/plugin/lib/metrics-core.mjs)). The panel's
`readRecentContextLimits` separately parses stored `executor_metadata.data` from
recent conversation databases
([limit-diagnostics.mjs](../src/plugin/sidecars/panel/limit-diagnostics.mjs)).
Neither reconstructs the upstream configuration call graph.

## Modification boundary

### Windows Hub 2.32.1 live qualification

On 2026-11-16, the installed `resources/bin/language_server.exe` had original
SHA-256 `65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f`
and size 215547392 bytes. Its `utils.ClampCheckpointConfigForModelInfo` body
at VA `0x141823b00` (file offset `0x1823100`) matched the recorded 128-byte
original. After applying `--model-limits 1318=500000,1319=500000,1320=500000`
with the client and Language Server stopped, the patched SHA-256 was
`b661864c7e6265e70a502ac0440ebce07f0b4bc1d61ab013e7fa0630b9ac7125`.

After restarting both processes, `GetCascadeTrajectoryExecutorMetadatas` for
a resumed synthetic Gemini 3.8 Flash High session and a new synthetic session
reported `cascadeConfig.checkpointConfig.maxTokenLimit=500000`. The resumed
session's pre-patch executor recorded 256000. Both post-patch executors retained
`maxUserRequests=10`, `maxUserRequestBytes=1024`, and the same 3937-byte summary
prompt digest `adc0b546b4512337f3edc1080cbcdf2d4b9303345664815694024e7304898a1c`.
This qualifies that model path and the limit change, not other models, prompt
replacement, retention changes, or natural automatic compaction. The exact
build entry is in [versions.json](../compat/versions.json).

The implementation is Go under
[src/agyctl/internal/limit/](../src/agyctl/internal/limit/).

1. [binary.go](../src/agyctl/internal/limit/binary.go) parses PE and ELF64 x86-64
   images and Mach-O ARM64 images ([macho.go](../src/agyctl/internal/limit/macho.go))
   and locates the target by its Go pclntab symbol. Only x86-64 continues to
   planning; Mach-O ARM64 reports `unavailable`. On ELF, `runtime.text` can start
   after the `.text` section, so the Go text base is cross-validated against
   moduledata and `RELATIVE` relocations before any function address is trusted
   ([elf.go](../src/agyctl/internal/limit/elf.go)).
2. [run.go](../src/agyctl/internal/limit/run.go) and `DetectState` in
   [asm.go](../src/agyctl/internal/limit/asm.go) require the body to equal an
   original recorded in [versions.json](../compat/versions.json) for the detected
   architecture. Version labels are diagnostic: an unlisted build with known bytes
   passes, while unknown bytes or a size other than `0x80` are refused.
3. Legacy `PlanPatch` places a 16-byte model-ID bitset in alignment padding near
   the function. The per-model planner places one linked 16-byte node per model,
   each in its own qualified padding slot. Both refuse insufficient padding.
4. The replacement raises the candidate limit for a matching model before the
   original clamp logic runs. Legacy uses one floor for the whole bitset;
   `linked-v2` reads the floor from the model's node. Neither lowers a larger
   candidate.
5. `ApplyPatch` writes only the planned body and table nodes into a copy. Writing
   the installation additionally requires the stopped-process check, verified
   backups, a prepare record, and hash-checked replacement.

Legacy defaults are `500000` tokens for model IDs `1318-1320,1400-1405,1417-1419`
([asm.go](../src/agyctl/internal/limit/asm.go)), and IDs must fit a 128-wide bitset
window. `--model-limits` maps at most 128 distinct positive int32 IDs to positive
floors up to `983040` tokens and cannot be combined with `--ids`/`--limit`.
`--limit` has the same upper bound. The shared native coordinator also rejects
new or changed mappings above this bound, while preserving unchanged historical
mappings for inspection, reconstruction, and restoration. IDs are numeric enum
values; no model name is inferred from them.

The requested value is a candidate floor applied before later clamps, **not** a
guaranteed effective context window. The patch does not change provider limits,
model access, remote profiles, `GetCheckpointConfig`, or `app.asar`.

### Per-model encoding

The `linked-v2` replacement is exactly 128 bytes: a 48-byte model lookup, the
generated legacy replacement's 79-byte clamp tail, and one trailing `0xcc`. It
preserves the original `RCX` reserve argument and uses scratch registers for the lookup, which the Go internal
ABI permits. See [model_limits.go](../src/agyctl/internal/limit/model_limits.go).

Each 16-byte node stores, little-endian, `id` (uint32), `limit` (uint32), a signed
32-bit displacement relative to the node (zero terminates the chain), and the
marker `AGL2`. The RIP-relative head pointer is the dword at body offsets 16–19,
relative to function VA + 20. Detection bounds the chain, validates IDs, values, and
padding, and reconstructs the encoding instead of trusting a marker or saved
settings. The [checker probe](../src/agyctl/internal/check/probes.go) screens the
same template independently; it is not the patcher's gate.

### Cave placement

On PE and ELF x86-64, the planner scans forward from the target for a 16-byte slot
preceded by an 8-byte `0xcc` guard, ending at a later function entry. A fresh slot
contains `0xcc`; the legacy planner can also reuse an identical table, and per-model
reconstruction can reuse validated node slots. Unknown bytes or an unusable address
map are refused. macOS mutation stays unavailable until its original bytes,
placement, and signing strategy are qualified.

## Backup and recovery

These are the implemented conditions, not a promise that every failure restores the
previous installation.

1. `EnsureBackup` checks the source hash and creates the backup exclusively,
   reusing an existing one only when its hash matches. `patchBinary` can choose
   `.orig.<original-sha>` when `.orig` belongs to another original. See
   [fsx.go](../src/agyctl/internal/fsx/fsx.go).
2. After the sibling and tool-state backups verify, `writePrepare` records the
   intended original/new hashes and settings. Status can report `recorded`,
   `applied-not-recorded`, `prepared-not-applied`, or `target-drift`; it does not
   repair them. See [prepare.go](../src/agyctl/internal/limit/prepare.go).
3. `ReplaceVerified` checks the installed hash before staging, before replacement,
   and afterward. A failed post-write check attempts a guarded rollback only when
   the anomalous contents are stable. It returns `ErrRolledBack` after
   verification, otherwise `ErrRollbackFailed` with recovery data preserved.
4. After a verified replacement, a path-resolution or manifest-append failure
   triggers a guarded rollback that requires the target to still match the
   replacement hash. A verified rollback clears the prepare record; a failed one
   keeps it.
5. Restore requires the LS to be stopped and verifies the original bytes and
   backup pairing. With a manifest, current bytes must match the recorded patched
   hash. Without one, a recognized patch must be reproducible from the original
   backup. An unrelated updated binary is not a restore target.

The limit patch is independent of the Host archive transaction and of the
[tool-output patch](tool-output-patch.md); see
[recovery boundaries](operations.md#recovery-boundaries).
