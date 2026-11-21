# Language Server Tool-Output Capacity Patch

This page owns the `agyctl tool-output` feature: the registered capacity recipe for
native tool outputs, its build-specific evidence, and its modification boundary.
Commands and recovery are in
[operations](operations.md#tool-output-capacity-patch); component boundaries are in
[architecture](architecture.md#language-server-patch-admission). It is a separate
feature from the context-limit patch ([limit-patch.md](limit-patch.md)); on 2.32.1
2.33.0, and 2.34.0 both are combined by
[native composition](operations.md#native-feature-composition).

## Status

Registered recipes are `candidate` in
[tool-output.json](../compat/tool-output.json). The capacity values are
qualification targets, **not** measured upstream maxima. Windows 2.34.0 has a
live `view_file` result beyond the old line and byte defaults, but not an exact
boundary or grep/MCP result. Windows 2.33.0 has offline
instruction, control-flow and Go metadata evidence plus a partial installed-client
read beyond both old limits; its exact capacity boundaries remain unqualified.
The two file-read targets (lines and bytes) are live-verified on
Windows 2.32.1 and 2.31.2; the grep result cap has no
observed live path, and the remaining items are listed under
[qualification status](#qualification-status).

## Registered builds

The **Windows 2.34.0** recipe targets package member
`resources/bin/language_server.exe`, 207,245,312 bytes:

| State | Whole-file SHA-256 |
| --- | --- |
| Original | `cc94d648c39a67c293d0fdc8befc51e953d1a8f55617bf49fff69885ba475db9` |
| Standalone output | `498f5dd9fbd27438a6f83a6ff388c2411aed4ae954a95893c851e2979400695b` |

Only this original is admitted. Its fourth segment is newly derived from the
2.34.0 control flow, not the 2.33.0 byte recipe. The live `view_file` path is
partially qualified below; exact capacity boundaries remain unqualified.

The **Windows 2.33.0** recipe targets package member
`resources/bin/language_server.exe`, 203,692,544 bytes:

| State | Whole-file SHA-256 |
| --- | --- |
| Original | `eb6d986dfc5a859c6e9b1b36a0601f5c362993cc16eb8962ad554c9141defc9c` |
| Standalone output | `9f230dcacd9be8736ca4d80b0d178bbee5d47b50e46ad7561e76ec9525636822` |

Only that original is admitted. The recipe changes the three capacity operands
and post-merge floor, without importing historical grep transforms.

The **Windows 2.32.1** recipe targets package member
`resources/bin/language_server.exe`, 215,547,392 bytes:

| State | Whole-file SHA-256 |
| --- | --- |
| Original | `65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f` |
| Standalone output | `a53f6fcc14e73fa4117acbcf70bf4c1b4497731d9b72db9ca03284b21b82dea0` |

It admits only the original and changes the three capacity operands plus the
post-merge floor. It contains none of the 2.31.2 grep transforms and does not accept
a grep-patched baseline.

The **Windows 2.31.2** recipe targets **Antigravity App Windows 2.31.2,
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

The source values are unchanged in 2.32.1, 2.33.0, and 2.34.0. Why these layers (from isolated probes on
Windows 2.31.2, recorded
2026-11-14, with no installed-file changes):

- **Base constants:** with no settings overriding a field, the effective merged
  config equals the base defaults (`maxLinesPerView: 800`, `maxBytesPerView: 46080`,
  `maxGrepResults: 50`). Values set by settings pass through unchanged to the
  effective config and the legacy grep tool declaration, so raising the base
  constants changes the effective value only for sessions that do not set these
  fields explicitly.
- **Step budget floor:** with the floor at 32,768 (the existing verified post-merge
  patch), prepared model messages up to 60,078 bytes were delivered intact, and a
  16,384 budget truncated the same content with a `<truncated … bytes>` marker. The
  98,304 floor is the 3-byte-per-token approximation intended to carry 128 KiB tool
  results through the shared message conversion; whether the real message framing
  fits is unverified.
- **Persistence (inferred, not validated):** survival across app restarts, new
  sessions, subagent roles, and re-discovered MCP tools follows from the two
  adaptation layers (config constructor constants and the post-merge floor in
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

### Windows 2.31.2

[tool-output.json](../compat/tool-output.json) records, per input state, every
segment's file offset, expected bytes, and new bytes. The three base-default
segments change only immediate operands with equal-length encodings. The
post-merge floor is a separate equal-length instruction-sequence transform; its
expected bytes depend on the input. Go PC/stack/GC metadata qualification is
recorded in the registry's external evidence. The grep transform segments reproduce
the externally verified 2.31.2 grep fixes (drive-aware path splitting, scanner budget
and error handling, no GNU grep fallback).

Capacity-related segments (the base-default segments have the same expected and new
bytes for both 2.31.2 inputs; the post-merge segment has input-specific expected bytes):

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

To reproduce the 2.31.2 static checks (all read file bytes only; extracted
installer content is never executed):

1. Confirm the whole-file SHA-256 of both recorded binaries. The external patch
   manifest (SHA-256 recorded under `evidence` in the registry) must match: every
   declared original byte sequence matches the original binary, every patched
   sequence matches the patched binary at the declared offsets, and there are no
   differences outside the declared segments.
2. Derive file offsets from virtual addresses using the 2.31.2 image base `0x140000000`,
   `.text` RVA `0x1000`, and raw pointer `0x600`, that is,
   `file offset = VA − 0x140000a00` inside `.text`. Re-derive the immediate
   encodings with any x86-64 disassembler rather than trusting the table above.
3. Apply the recipe to both inputs in memory and require the registered output
   SHA-256, zero differences outside registered segments, and no segment overlaps.

The external report and patch manifest live outside this repository; their SHA-256
values are in the registry's `evidence` block.

### Windows 2.32.1

Recorded 2026-11-16 from the installed original
`resources/bin/language_server.exe`, read-only. Read the segment
preimages and replacements from the 2.32.1 target in
[tool-output.json](../compat/tool-output.json).

| Segment | VA | File offset |
| --- | --- | --- |
| Read line cap | `0x1419adee4` | 26924260 |
| Read byte cap | `0x1419adefe` | 26924286 |
| Grep result cap | `0x1419aeea8` | 26928296 |
| Post-merge floor | `0x142904632` | 43007026 |

`config.defaultConversationalCascadeConfig` starts at `0x1419ad5e0`.
The find initializer at `0x1419aef26` is not changed. The 62-byte floor lies in
`(*CascadeManager).getCascadeConfig` (`0x1429043a0`, 992 bytes). Its replacement
has no call, SP change, new stack slot, or pointer store; internal branches land
on instruction boundaries and the final jump reaches the existing `mov rax,rdx`
at `0x1429046f4`. No original direct branch enters the replaced region.

The original Go pclntab is at file offset `0x4a12a00`. Its metadata gives
`pcsp=296` across the replacement and landing, and `UnsafePoint=-1` across the
entire replacement. Source stack-map index 6 and landing index 7 have the same
14-bit locals bitmap (`0100`), retaining the config root at `[rsp+0xb0]`.
Argument maps are `04`/`00`; no argument is used after the jump. Arg-live index 3
is unchanged. To reproduce, locate that function in Go pclntab, map its PCs using
the PE section table, disassemble the registered preimage and replacement, and
decode the function's pcsp, pcdata, and locals/args stack-map entries. Check all
direct branch destinations, not only the replacement's byte length.

The old `CortexToolAdapter` bridge is absent in this build, so the operands alone
did not prove reachability; the live check under
[qualification status](#qualification-status) confirmed `read_file` routing and
model-visible capacity, not search or MCP paths.

### Windows 2.34.0 offline candidate

On 2026-11-21, the exact original above was inspected as package member
`resources/bin/language_server.exe`; registered byte spans are in
[tool-output.json](../compat/tool-output.json). PE `.text` maps a VA to file
offset by subtracting `0x140000a00` (image base `0x140000000`, RVA `0x1000`,
raw offset `0x600`). The three default-constant sites are:

| Operand | VA | File offset |
| --- | --- | --- |
| `viewFile.maxLinesPerView` | `0x141899c2d` | 25793069 |
| `viewFile.maxBytesPerView` | `0x141899c47` | 25793095 |
| `grep.maxGrepResults` | `0x14189ab8b` | 25797003 |

All three retain their instruction boundaries and change only immediate values.
They are in `config.defaultConversationalCascadeConfig`; the separate find
initializer remains untouched.

The old floor site cannot be relocated mechanically: 2.34.0
`(*CascadeManager).getCascadeConfig` is VA `0x1428fc080`, size 928, with a
different control flow. Its recorded path calls
`MergeCascadeConfigsWithOverwrites` at `0x1428fc24c`, then
`ApplySystemPromptTemplateOverrides` at `0x1428fc2c7`. The new 66-byte
replacement at `[0x1428fc2cd,0x1428fc30f)` is after both calls. It loads the
rooted merged configuration from `SP+0xa8`, follows the nil-guarded `+0x20`
trajectory-conversion configuration and `+0x50` int32 field, and raises only
signed values below 98,304. Named protobuf getters at `0x140985060` and
`0x140986560` independently confirm these offsets. The final jump lands at
the original `mov rax,rdx` at `0x1428fc394`; no unchanged branch enters the
replaced span. It adds no call, stack change, or pointer store.

Go pclntab at `0x4c5f000` reports `pcsp=288` and `UnsafePoint=-1` over the
replacement. Source StackMap 6 and landing StackMap 7 have the same locals
bitmap `0100`, preserving the `SP+0xa8` root; argument maps are `04`/`00` and
the return tail dereferences no arguments. Complete-function disassembly of
the standalone candidate confirmed instruction boundaries, incoming branches,
and unchanged retained call PCs. A later [live native transaction and startup](operations.md#native-feature-composition)
read back the enabled disk state. In a further 2026-11-21 live check, a new
synthetic Gemini 3.8 Flash High executor reported `viewFile.maxLinesPerView=2000`
and `maxBytesPerView=131072` through `GetCascadeTrajectoryExecutorMetadatas`,
versus `800` and `46080` on the original LS. A single `view_file` call read a
950-line, 76,898-byte local test file; the final marker was present in the
completed `CORTEX_STEP_TYPE_VIEW_FILE` result returned by
`GetCascadeTrajectorySteps` (86,363 serialized JSON bytes). This qualifies an
actual file-read result beyond both old defaults, **not** the exact 2,000-line or
128-KiB boundaries, grep, MCP, or a general step-budget maximum.

### Windows 2.33.0

Recorded offline on 2026-11-18 from the exact original identified above, package
member `resources/bin/language_server.exe`. The editing source is the 2.33.0
entry in [tool-output.json](../compat/tool-output.json); existing entries are
unchanged.

| Segment | VA | File offset |
| --- | --- | --- |
| Read line cap | `0x1419aa6c4` | 26909892 |
| Read byte cap | `0x1419aa6de` | 26909918 |
| Grep result cap | `0x1419ab635` | 26913845 |
| Post-merge floor | `0x14294a3d2` | 43293138 |

The first three preimages are `c70020030000`, `c70000b40000`, and
`c7400832000000`. They retain their instruction lengths and change only the
immediates. The grep object is stored at parent `+0x18`; the separate 50-result
initializer at `0x1419ab6b1` goes to parent `+0x20` (find) and is not patched.

`(*CascadeManager).getCascadeConfig` is at `0x14294a140`, size 992. The 62-byte
replacement at `[0x14294a3d2,0x14294a410)` still follows both configuration merges
and `ApplySystemPromptTemplateOverrides`. It introduces no call, SP change, new
stack slot, or pointer store. Conditional branches land at `0x14294a3ff`; the final
jump lands on original `mov rax,rdx` at `0x14294a494`. No unchanged direct branch
enters the replaced span. Logging/allocation calls in that span are skipped, not
moved; all calls outside it retain their original PCs and targets.

Named protobuf getters confirm the field chain: `CascadeConfig.GetTrajectoryConversionConfig`
at `0x140984080` reads `[rax+0x20]`, and
`TrajectoryConversionConfig.GetMaxTokensPerStep` at `0x140985580` reads
`[rax+0x50]` followed by the pointed-to int32. The floor retains nil paths and
larger signed values, setting only an existing value below 98,304.

The Go pclntab is at file offset `0x4ab8020`. `pcsp=296` covers both the
replacement and landing. `UnsafePoint=-1` covers the replacement; the native
write-barrier unsafe range starts later, at `0x14294a417`, and is skipped.
Source/landing stack-map indices 6/7 have the same 14-bit locals bitmap `0100`,
retaining the merged configuration root at `SP+0xb0`. Argument maps are `04`/`00`,
and no argument is used after the landing; arg-live index 3 is unchanged.

To reproduce, read the registered original into memory, verify its whole-file
SHA-256 and size, derive each VA/file offset from the PE section table, and require
every `expected_hex` before applying the equal-length `new_hex`. Require the
registered output hash and no differences outside those spans. Disassemble the
complete containing functions in both images and check every direct branch,
including incoming edges, and all retained call PCs. Decode Go `_func.pcsp`,
`PCDATA_UnsafePoint`, `PCDATA_StackMapIndex`, and both pointer maps at the ranges
above using the Go runtime's `runtime2.go`, `symtab.go`, and
`internal/abi/symtab.go` layouts. These are read-only checks, not proof of live
Read/Grep routing or capacity.

## Admission gate and coexistence with limit

The exact Windows 2.32.1/2.33.0/2.34.0 originals and their verified managed images use
[native composition](operations.md#native-feature-composition). Feature entry
points retain the exact T recipe gate and route their changes through that shared
whole-image transaction, preserving L/C on independent T removal. The standalone
feature rules below describe legacy targets, not a requirement to remove other
features from a managed 2.32.1 image.

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
- For an installed client, `patch` first selects targets whose `app_version`
  exactly matches the paired app version, then applies the same whole-file gate.
  An unknown version or unreadable version source refuses. An independent offline
  binary without app metadata uses hash selection; legacy unversioned registries
  retain their hash-only contract. Status and restore keep the full registry for
  historical recognition. See
  [version selection](../src/agyctl/internal/apptarget/selection.go).
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

The recipe stays `candidate`. Nothing below qualifies another build, and a
successful disk patch does not mean the running app loaded the bytes or that the
model receives the new capacity; `status` reports disk state only.

**Verified**

- **Live, partial (2026-11-18, stable-channel Windows 2.33.0):** after the reviewed
  combined native transaction and a client restart, a new synthetic Gemini 3.8
  Flash High conversation changed executor `viewFile` metadata from 800/46,080 to
  2,000/131,072. A single `VIEW_FILE` step returned all 1,400 numbered lines from a
  93,800-byte synthetic file, including its final marker. This proves a read beyond
  both old limits, not the exact new maxima or the next message-conversion layer.
  Reproduce with a numbered ASCII file larger than 800 lines and 46,080 bytes,
  request one native read, and inspect `GetCascadeTrajectorySteps`' `viewFile`
  content rather than relying on the model's answer. The constructor and floor
  sites for this exact build are documented above.
- **Static (2026-11-14):** both input binaries were byte-checked against the
  external manifest, the recipe was derived from disassembly, and the registered
  output is reproducible in memory.
- **Offline:** the Go suite covers the registry self-check, fixed-vector
  admission/plan/apply/restore, refusal kinds, shared-lock contention, and
  prepare-record re-entry.
- **Live, partial (2026-11-15, stable-channel Windows 2.31.2):** the patch was
  applied to the grep-patched input (`1c69b4fc…` → `47a439ef…`, 7 bytes), the client
  was restarted, and an agent conversation exercised the tools. Results below come
  from the raw tool payloads in the conversation store, not the agent's summary.
  - `viewFile.maxLinesPerView=2000`: a 2,100-line file read as `lines 1-2000 of 2100`
    (previously 800).
  - `viewFile.maxBytesPerView=131072`: files larger than the limit were cut at 131072
    bytes with a continuation hint naming `ByteOffset=131072`; a ranged read
    (`startLine=1995 endLine=2005`) returned exactly those lines; resuming at
    `ByteOffset=131072` delivered the remainder with no duplicated or lost lines and
    no U+FFFD, including Chinese text and emoji across the boundary.
  - Non-target regression: the edit tool and `run_command` were unchanged (the
    `run_command` preview keeps head and tail with a middle-elision notice and
    points at the full output file; that is upstream behavior).
- **Live, partial (2026-11-16, stable-channel Windows 2.32.1):** applied as part of
  a native limit + tool-output image, then the Language Server was restarted and a
  new synthetic conversation read synthetic files. The exposed tool is `read_file`,
  stored as a `VIEW_FILE` step.
  - A 1,200-line file read ended at line 800 before the patch and returned all
    1,200 lines after it. A 2,200-line file ended at line 2,000.
  - A 172,500-byte UTF-8 file produced a 131,072-byte content window, plus the
    upstream 321-byte timestamp and continuation framing. The result contained
    no U+FFFD. `GetCascadeTrajectoryGeneratorMetadata(includeMessages:true)` on
    that synthetic conversation showed the same 131,393-byte tool message;
    the next conversion layer did not cut it back to the old capacity. The
    2,000-line result likewise reached the model as a 36,999-byte tool message.
  - This does not qualify other model routes, MCP tools, or the legacy grep
    constructor.

**Not applicable on 2.31.2:** the running engine's toolset does not expose the
legacy `grep_search` tool, so `grep.maxGrepResults=100` has no live execution path;
the value is a patched constant with no observed effect. No legacy grep path was
observed on 2.32.1 either.

**Still unverified** (all must pass before the recipe can be marked `supported`):
MCP multi-block output, the background-output branch, `perTool` values (never
patched), exact boundary values (1,999/2,000/2,001 lines; 131,071/131,072/131,073
bytes), settings persistence beyond one session, and subagent boundary inheritance.

**To reproduce a live check:** apply the patch, restart the client, read a file larger
than the limits from an agent conversation, and inspect the raw `steps` payloads in
`~/.gemini/antigravity/conversations/<conversation>.db`.
