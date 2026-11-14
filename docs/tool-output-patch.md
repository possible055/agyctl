# Language Server Tool-Output Capacity Patch

This page owns the `agyctl tool-output` feature: the registered capacity recipe for
native tool outputs, its build-specific evidence, and its modification boundary.
Commands and recovery are in
[operations](operations.md#tool-output-capacity-patch); component boundaries are in
[architecture](architecture.md#limit-admission-and-recovery). The feature is
independent of the context-limit patch (`agyctl limit`), documented in
[limit-patch.md](limit-patch.md).

## Status

The recipe is qualified as `candidate` in
[tool-output.json](../compat/tool-output.json). The capacity values are
qualification targets, **not** measured upstream maxima, and live validation in the
running app is pending (see [Qualification status](#qualification-status)).

## Registered build

Exactly one build is registered: **Antigravity App Windows 2.31.2,
`windows-amd64`**, package member `resources/bin/language_server.exe`, 197,992,960
bytes. Only the registered whole-file inputs for this Windows x86-64 recipe are
admitted; a close version number or successful install discovery never admits a
binary. The byte gate does not independently authenticate the installation path or
channel, so an identical copied binary still matches.

| State | Whole-file SHA-256 |
| --- | --- |
| Recorded original | `e40f0447109c43ece15e7025ca0864a138e0e16cb8864d4ccf64a00512a99e1a` |
| Recorded grep-patched baseline | `1c69b4fc10b15b016125d38a32a5b4fd13018dad22564207b576bbb3e759e164` |
| Registered output | `47a439efe717e797533f1cdc0c303d40f264c5f1e0a1135f766b64f1208fa61e` |

Both registered inputs produce the same output. Applying the recipe to the original
also applies the externally verified 2.31.2 native grep fixes, while applying it to
the grep-patched baseline preserves those fixes and changes only the capacity
bytes. Output equality across both inputs is part of the registry self-check that
every `patch` plan reproduces before it may write.

## Capacity targets

| Setting | Source value | Target | Layer |
| --- | --- | --- | --- |
| `CascadeConfig.plannerConfig.toolConfig.viewFile.maxLinesPerView` | 800 | 2000 | base default constant |
| `CascadeConfig.plannerConfig.toolConfig.viewFile.maxBytesPerView` | 46,080 | 131,072 | base default constant |
| `CascadeConfig.plannerConfig.toolConfig.grep.maxGrepResults` | 50 | 100 | base default constant |
| Post-merge step budget floor (`trajectoryConversionConfig.maxTokensPerStep`) | 32,768 | 98,304 | after manager static/dynamic settings merge |

Why these layers (observations from isolated probes recorded 2026-11-14, with no
installed-file changes, and the inferences drawn from them):

- With no settings overriding a field, the effective merged config equals the base
  defaults (`maxLinesPerView: 800`, `maxBytesPerView: 46080`, `maxGrepResults: 50`).
  Values set by settings pass through unchanged to the effective config and the
  legacy grep tool declaration. Raising the base constants therefore changes the
  effective value only for sessions that do not set these fields explicitly.
- With the step budget floor at 32,768 (the existing verified post-merge patch),
  prepared model messages up to 60,078 bytes were delivered intact, and a 16,384
  budget truncated the same content with a `<truncated … bytes>` marker. The 98,304
  floor is the 3-byte-per-token approximation intended to carry 128 KiB tool results
  through the shared message conversion. Whether the real message framing fits is
  unverified.
- Inference, not yet validated live: persistence across app restarts, new sessions,
  subagent roles, and re-discovered MCP tools follows from the two adaptation layers
  (config constructor constants and the post-merge floor in
  `(*CascadeManager).getCascadeConfig`).

Out of scope for this recipe:

- `toolOutput.perTool[run_command]` (65,536) and per-tool MCP `maxOutputBytes`
  (131,072). The probes showed an additional eager ~10 KiB truncation on one MCP
  call path that the same-named config fields did not lift. The effective field
  names, precedence, and construction timing of `perTool` need live evidence before
  bytes can be registered.
- A global `toolOutput.maxOutputBytes` increase, which is deliberately not used.
- Read/grep paging, two-tier capacity APIs, edit/write tools, and `useCoreDirect`
  switching.
- Non-target tools such as `find.maxFindResults`. The second 50-result store in the
  config constructor belongs to `find` and stays at 50.

## Recipe segments

[tool-output.json](../compat/tool-output.json) records, per input state, every
segment's file offset, expected bytes, and new bytes. The three base-default
segments change only immediate operands with equal-length encodings. The
post-merge floor is a separate equal-length instruction-sequence transform; its
expected bytes depend on the input. Go PC/stack/GC metadata qualification is
recorded in the registry's external evidence. The grep transform segments reproduce
the externally verified 2.31.2 grep fixes (drive-aware path splitting, scanner budget
and error handling, no GNU grep fallback).

Capacity-related segments (the base-default segments have the same expected and new
bytes for both inputs; the post-merge segment has input-specific expected bytes):

| Name | VA | File offset | Encoding change |
| --- | --- | --- | --- |
| `viewfile-max-lines-per-view-2000` | `0x141a4b744` | 27,569,476 | `mov dword ptr [rax], 0x320` → `0x7d0` |
| `viewfile-max-bytes-per-view-131072` | `0x141a4b75e` | 27,569,502 | `mov dword ptr [rax], 0xb400` → `0x20000` |
| `grep-max-grep-results-100` | `0x141a4c708` | 27,573,512 | `mov dword ptr [rax+8], 0x32` → `0x64` |
| `post-merge-step-budget-floor-98304` | `0x1428b3112` | 42,673,938 | Installs a guarded `0x18000` floor on the original; raises the existing `0x8000` floor on the grep-patched input |

How the sites were identified:

- The grep-max site is found through `GrepSearchToolConverter.GetToolDefinition`
  (`0x142393740`), whose nil-checked getter chain reads the result cap as a dword at
  struct offset `+8`, reached through parent offset `+0x18`. In the config
  constructor, the two 50-result stores write submessages at parent offsets `+0x18`
  (grep) and `+0x20` (find), in protojson field order.
- The step-budget site is inside `(*CascadeManager).getCascadeConfig`, after both
  `MergeCascadeConfigsWithOverwrites` calls. That is why the floor survives static
  and dynamic settings merging while preserving larger existing values.

On the grep-patched input, the seven grep segments carry `role: "preserve"`
(expected bytes equal new bytes, which proves the fixes are present). The floor
segment transforms the recorded patched bytes to the 98,304 variant.

### Reproducing the static checks

All checks read file bytes only; extracted installer content is never executed.

1. Confirm the whole-file SHA-256 of both recorded binaries. The external patch
   manifest (SHA-256 recorded under `evidence` in the registry) must match: every
   declared original byte sequence matches the original binary, every patched
   sequence matches the patched binary at the declared offsets, and there are no
   differences outside the declared segments.
2. Derive file offsets from virtual addresses using image base `0x140000000`,
   `.text` RVA `0x1000`, and raw pointer `0x600`, that is,
   `file offset = VA − 0x140000a00` inside `.text`. Re-derive the immediate
   encodings with any x86-64 disassembler rather than trusting the table above.
3. Apply the recipe to both inputs in memory and require the registered output
   SHA-256, zero differences outside registered segments, and no segment overlaps.

The external report and patch manifest live outside this repository; their SHA-256
values are in the registry's `evidence` block.

## Admission gate and coexistence with limit

`tooloutput` reuses the [layout](../src/agyctl/internal/layout/layout.go) and
[winproc](../src/agyctl/internal/winproc/winproc.go) contracts and the shared
[apptarget](../src/agyctl/internal/apptarget/target.go) resolution. It owns its
admission, planning, transaction, and restore, and does not import the limit
registry, parser, or assembler.

- `patch` accepts only whole-file inputs registered in
  [tool-output.json](../compat/tool-output.json) with a matching PE x86-64 identity
  and byte-exact segments. Refusal kinds include `unknown-input`,
  `size-mismatch`, `pe-invalid`, `recognized-output-unmanaged` (a recognized output
  without a transaction record), and `PATCH_CONFLICT` (the binary matches the limit
  patch's last output; such a binary is never auto-restored). A registered input
  whose segment bytes disagree with the recipe is refused as `unknown-input`.
- `already-applied` is a no-op result with `already_applied: true`: the current
  bytes match this tool's recorded output. It does not rewrite the binary;
  `--apply` may complete a matching pending prepare record.
- `patch` without `--apply` plans in memory and persists nothing.
- Both features share one operation lock,
  `<agyctl home>/backups/limit-operation.lock`
  ([patchlock](../src/agyctl/internal/patchlock/patchlock.go)), keeping the
  existing lock order: operation lock before the short-lived state-store lock. A
  held limit operation refuses a tool-output mutation and vice versa, without
  disturbing the holder's lock file.
- `restore` requires a tool-output patch record for the current binary whose
  recorded output hash equals the installed hash, and the recorded recipe
  fingerprint must still be registered. A binary that changed since the patch (an
  app update, a later limit patch, or an external edit) is refused. Restoring across
  another feature's patch is not supported.
- `agyctl check` plays no part in this gate; the feature screens itself and never
  runs extracted content.

## Qualification status

- **Static:** both input binaries were byte-checked against the external manifest,
  the recipe was derived from disassembly, and the registered output is reproducible
  in memory (verified 2026-11-14).
- **Offline:** the Go suite covers the registry self-check, fixed-vector
  admission/plan/apply/restore, refusal kinds, shared-lock contention, and
  prepare-record re-entry.
- **Live app:** pending. Capacity boundaries, UTF-8 continuation, truncation hints,
  background output, and session persistence must pass before the recipe can be
  marked `supported`.

A successful disk patch does not mean the running app loaded the bytes or that the
model receives the new capacity; `status` reports disk state only.
