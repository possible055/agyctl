# Language Server Context-Limit Patch

This page describes how `agyctl limit` modifies the Antigravity desktop Language
Server (LS): the targeted function, the admission gate, the replacement encoding,
qualification, and recovery. It is not a specification of upstream context
management. Commands and status readback are in
[operations](operations.md#per-model-context-settings); component boundaries are in
[architecture](architecture.md#language-server-patch-admission).

## Upstream clamp

The legacy recorded `utils.ClampCheckpointConfigForModelInfo` body reads the
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

Windows Hub 2.33.0 has a different ABI and behavior. Its 352-byte clamp in package
member `resources/bin/language_server.exe` uses `RCX` for configuration, `RDI` for
the model, and `ESI` for the output allowance; `RAX/RBX` carry the context pair.
Strategy `3` resolves an independent summary model through `utils.summaryModelInfo`
and `utils.ResolveStrategyCheckpointModel`, then clamps both the context and output
against that model. The legacy replacement must not run on this body.

To observe the result, the project reads
`executorMetadata[].cascadeConfig.checkpointConfig.maxTokenLimit` from
`GetCascadeTrajectoryExecutorMetadatas` (`applyExecutorCapacity` in
[metrics-core.mjs](../src/plugin/lib/metrics-core.mjs)). The panel's
`readRecentContextLimits` separately parses stored `executor_metadata.data` from
recent conversation databases
([limit-diagnostics.mjs](../src/plugin/sidecars/panel/limit-diagnostics.mjs)).
Neither reconstructs the upstream configuration call graph.

## Modification boundary

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
   passes, while unknown bytes or an unimplemented signature/size are refused.
   The 352-byte strategy additionally checks the exact original SHA-256, rather
   than treating its size as sufficient evidence.
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

The 2.33.0 encoding is `linked-v3-summary`, with native planner reference
`linked-v3-summary-reserved-v1`. It uses the same bounded `AGL2` data nodes, but its
head displacement is at body offsets `0x30..0x33`, relative to function VA +
`0x34`. [summary_abi.go](../src/agyctl/internal/limit/summary_abi.go) implements its
signature-specific assembler. The old `linked-v2-reserved-v1` reference and
fingerprint remain unchanged so historical states and backups stay reproducible.

The new assembler preserves the original stack check, 32-byte local frame,
context-pair spills, configuration-pointer spill at `[rsp+0x40]`, summary resolver
call at body offset `0xa3`, epilogues at `0x102/0x104`, and complete morestack path.
The lookup changes only scratch registers and an int32 configuration field before
the original clamp semantics. It neither adds calls nor jumps into another Go
function's padding. All rewritten instructions remain in the original `pcsp=40`
region; the existing synchronous call PC and its pointer map are retained. The
strategy-3 context and output clamps remain independent of the selected model's
configured floor.

### Cave placement

On PE and ELF x86-64, the planner scans forward from the target for a 16-byte slot
preceded by an 8-byte `0xcc` guard, ending at a later function entry. A fresh slot
contains `0xcc`; the legacy planner can also reuse an identical table, and per-model
reconstruction can reuse validated node slots. Unknown bytes or an unusable address
map are refused. macOS mutation stays unavailable until its original bytes,
placement, and signing strategy are qualified.

## Qualification

Admission is byte-based (see above); [versions.json](../compat/versions.json)
records each inspected build with its original body and notes. Recorded live
check on Windows stable 2.32.1, 2026-11-16:

- Package member `resources/bin/language_server.exe`, 215,547,392 bytes, original
  SHA-256 `65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f`.
  `utils.ClampCheckpointConfigForModelInfo` at VA `0x141823b00` (file offset
  `0x1823100`) matched the recorded 128-byte original.
- Applying `--model-limits 1318=500000,1319=500000,1320=500000` with the client and
  LS stopped produced SHA-256
  `b661864c7e6265e70a502ac0440ebce07f0b4bc1d61ab013e7fa0630b9ac7125`.
- After restarting, `GetCascadeTrajectoryExecutorMetadatas` reported
  `checkpointConfig.maxTokenLimit=500000` for both a resumed Gemini 3.8 Flash High
  session (256,000 before the patch) and a new one. Request retention and the summary
  prompt were unchanged.

This qualifies that model path and the limit change only, not other models or
automatic compaction behavior.

### Windows 2.33.0 evidence

The inspected original package member is 203,692,544 bytes, SHA-256
`eb6d986dfc5a859c6e9b1b36a0601f5c362993cc16eb8962ad554c9141defc9c`.
Its clamp starts at VA `0x141821280`, file offset `0x1820880`, with original body
SHA-256 `6c3e3ab006baf9105efd7d5a8545bddc8fdaef102f578d3bee9aad6967ebae25`.
These observations apply to this exact image, not every build labeled 2.33.0.

Offline validation on 2026-11-18 covered generated instruction boundaries,
the original pclntab's `pcsp`/safe-point/stack-map data, candidate readback,
combined limit/tool-output/compaction reconstruction, changed per-model mappings,
native/custom summary prompts, independent removal, exact original restoration,
and unknown-image refusal. An isolated generated-machine-code harness exercised
zero/existing limits, matching/unmatched models, signed windows, reserves, and
successful/error/nil summary-model resolution against the native clamp semantics.
This is not evidence that a live model or natural automatic compaction path works.

The subsequent live check on 2026-11-18 applied the combined native image through
the reviewed app-update transition, advancing the existing generation from 11 to
12 without changing its previous backup or historical state. The complete output
SHA-256 was
`8599d89aac4552bc1e2928fedaec8ff67da8ebb3661ed99fc7e7d7cba22147c2`.
After the installed client and LS restarted, a new executor in a synthetic Gemini
3.8 Flash High session (ID `1318`) recorded `maxTokenLimit=500000`, compared with
`256000` in its pre-patch executor. Its same-model strategy, checkpoint model
`MODEL_PLACEHOLDER_M50`, and native 3937-byte summary override were unchanged.
This qualifies this model's limit path, not other models or natural automatic
compaction. The patcher was not promoted to the tracked registry until this live
observation succeeded.

A subsequent reviewed mapping changed ID `1318` to 550,000 while leaving the other
two tested IDs at 500,000 and preserving tool-output/custom compaction. After a
restart, a new executor reported `maxTokenLimit=550000` and completed a response.
Independent `limit`, `tool-output` and `compaction` restores each preserved the
other enabled features. Disabling all three through a reviewed native plan
restored the exact original whole-file SHA-256 above. These are installed-client
checks recorded on the same date, not automatic-compaction qualification.

For a reproducible inspection, run `agyctl check local --install-dir ABS` on the
original installed package (or its complete offline copy), then inspect the saved
report's `fingerprint.clamp` body, SHA-256 and size. Compare the complete recorded
body with [versions.json](../compat/versions.json). For this exact image, slice
352 bytes at file offset `0x1820880` and disassemble as x86-64 at VA `0x141821280`.
The validated pclntab starts at file offset `0x4ab8020`; its function table resolves
this symbol to `_func` at file offset `0x7b0aa60`. Decode `_func.pcsp` and pcdata
through the Go pcHeader's pctab offset: `pcsp=40` covers body offsets `0x12..0x102`,
and stack-map index `1` covers `0xa3..0x105`. Confirm that the frame/spill, call,
and epilogue offsets listed above did not move before running live tests. The
stripped image has no `runtime.pclntab` symbol, so `go tool objdump` cannot locate
its table by symbol name; the project parsers locate its validated header instead.

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

The steps above describe the standalone limit transaction. On the registered
2.32.1 and 2.33.0 originals, the limit patch is instead one contribution to the
[native transaction](operations.md#native-feature-composition) shared with the
tool-output and compaction patches. Both are independent of the Host archive
transaction; see [recovery boundaries](operations.md#recovery-boundaries).
