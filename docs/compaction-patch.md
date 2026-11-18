# Language Server Summary Compaction Patch

This page owns the `agyctl compaction` feature: what the recipe changes, its
registered builds, the binary evidence behind it, and its qualification. Commands
and recovery are in [operations](operations.md#summary-compaction-patch); component
boundaries are in [architecture](architecture.md#language-server-patch-admission).
It is a separate feature from the [context-limit patch](limit-patch.md) and the
[tool-output patch](tool-output-patch.md); on 2.32.1 all three are combined by
[native composition](operations.md#native-feature-composition).

## Status

Qualification is recorded per build in [compaction.json](../compat/compaction.json):

| Build | Status | Scope of the evidence |
| --- | --- | --- |
| Windows 2.32.1 | `candidate` | Offline execution of the emitted code; on the installed client, exact retention rendering and native/custom prompts at manual compaction on Gemini 3.8 Flash High. Automatic compaction and other models are not qualified. See [live checks](#windows-2321-live-checks). |
| Windows 2.31.2 | `candidate` | The transaction worked, but the tested route did not adopt the replacement prompt and retention is unverified. See [legacy qualification](#windows-2312-legacy-qualification). |

A disk patch never proves what a running session loaded; `status` reports disk
state only, with `effective_state: "unknown"`.

### What the 2.32.1 recipe changes

- **Original user-message retention.** Upstream renders at most the 10 most recent
  user messages within a shared byte budget. The recipe replaces that with one fixed
  total budget of **61,440 UTF-8 bytes**, allocated newest first: newer messages stay
  whole, only the oldest retained message can be cut, and every older message is
  omitted. There is no message-count limit and no user-adjustable budget. Native
  numbering, UTF-8/media truncation, and the truncation notice are kept; numbering
  counts toward the budget, the notice and surrounding structure do not.
- **Summary prompt.** `native` (default) leaves all upstream prompt bytes and
  model-specific prompt selection unchanged, including the M432 profile's own prompt.
  `custom` uses the user's exact non-empty text, at most 3,937 UTF-8 bytes, on both
  summary consumers, M432 included. Empty text, invalid Unicode, NUL, and oversized
  input are refused, never truncated or replaced. The native 120-byte suffix that
  manual `/compact` appends is preserved in both modes.

[summary-v1.txt](../compat/compaction/summary-v1.txt) is kept as an optional
custom-text preset and as the 2.31.2 recipe's editing source; native mode never
selects it. Out of scope: automatic compaction thresholds, remote configuration,
checkpoint source payloads, file reattachment, hook or sidecar rewriting, manual
command parsing, and step compaction (`stepcompactor`), which the recipe neither
disables nor forces on.

## Registered builds

### Windows 2.32.1

The current recipe targets **Antigravity App Windows 2.32.1, `windows-amd64`**,
package member `resources/bin/language_server.exe`, 215,547,392 bytes.

| State | Whole-file SHA-256 |
| --- | --- |
| Original input | `65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f` |
| Current standalone native-prompt output | `a5b6fa7ae779b2d81bfcf81d3cf072977c1eaa2ef5fb25645481fe38a66267c0` |

The recipe admits only this exact original. Managed combinations are rebuilt
from that original by [native composition](operations.md#native-feature-composition),
not admitted as arbitrary new recipe inputs. Exact prior v1/v2/v3 consumer recipes
remain unchanged in `historical_inputs` only for native transaction migration and
restore. Custom prompt images are deterministically assembled from the exact
original and registered templates, not admitted as additional binary inputs. The
historical v3 record includes its complete custom prompt metadata (fingerprint
`edce28dc43923c50e8627e97731d07c72e7c1d34bdafbe9796e4b58715225995`).

### Windows 2.31.2 legacy inputs

The legacy recipe targets **Antigravity App Windows 2.31.2,
`windows-amd64`**, package member `resources/bin/language_server.exe`,
197,992,960 bytes. Only its registered whole-file inputs are admitted; a matching
version number or a successful install discovery never admits a binary.

| State | Whole-file SHA-256 |
| --- | --- |
| Tool-output patch output (recorded 2.31.2 input) | `47a439efe717e797533f1cdc0c303d40f264c5f1e0a1135f766b64f1208fa61e` |
| Grep-patched baseline (recorded 2.31.2 `.orig` sibling) | `1c69b4fc10b15b016125d38a32a5b4fd13018dad22564207b576bbb3e759e164` |
| Compaction output from the tool-output input | `c6c7d81e29eeab66af720c2304c7ad6b7543c5482db48dfd1379dd7a95c33814` |
| Compaction output from the grep-patched input | `b361c8c3ed47a1e315714d1f8b8178e23f282cb4d0724be5aeb8d9380c0831d6` |

Each input has its own recipe and its own output hash. The unpatched original
(`e40f0447…`) is **not** registered: no hash-verified copy was available, and an
entry is added only after the exact input file is hash-verified.

## Recipe segments

### Windows 2.32.1 consumer evidence

Recorded offline on 2026-11-18 (Asia/Taipei) for build 2.32.1, package member
`resources/bin/language_server.exe`, original SHA-256
`65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f`.
The editing sources and exact preimages are
[build layouts](../scripts/lib/compaction-builds.mjs),
[consumer assembly](../scripts/lib/compaction-consumers.mjs), and
[the registry](../compat/compaction.json).

#### Native allocation and omission

`utils.GetWaterFillAllocation` at VA `0x141823ee0` still uses its original
prologue, allocation calls and stack size. The equal-length replacement at
`0x141823f75..0x14182403b` checks the saved caller frame's full return address
against the ASLR-safe RIP-relative `FormatCheckpointUserRequests` return
`0x141820b05`. Only that path receives reverse/newest-first allocation and
unconditionally resets `RDI` to 61,440 with `MOV EDI,61440`, regardless of the
incoming budget. The
parent-message route (return `0x141820c98`) and the second direct caller,
`allocateDiscreteWaterFillBudget`, retain signed water-fill, negative-size
clamping, and newest-first distribution of the remainder. No global priority
change is applied to those callers; their incoming signed budgets are unchanged.

The user-only remaining budget stays within `0..61440`. Its comparison with one
and subtraction therefore use 32-bit operands without losing information. Source
lengths, `min(entryBytes, remaining)`, indices, and stored allocations remain
64-bit, including source lengths above `2^32`. A direct branch to the existing
common return removes a redundant two-byte jump. Together with the two shorter
budget instructions and one former padding byte, this fits the five-byte budget
reset inside the original 198-byte span without moving either return sequence.

The reverse loop computes `min(entryBytes, remaining)` from the last entry
backward. After the budget is exhausted, an internal allocation sentinel of
`-1` marks older entries. It does not send a negative limit to truncation.
The formatter replacement at `0x141821411..0x1418214c2` clears only the marked
private scratch string's length and skips the original truncation calls for
that entry. The boundary and all newer entries still reach the original
`Truncate` / `ToTruncatedBytesString` calls at `0x1418214c2` /
`0x1418214c7`, with the same media options, live pointer slots and write-barrier
stores. The second loop's compacted head at `0x141821653` skips empty scratch
entries before appending any per-entry output; it does not render one truncation
notice for every omitted message.

This scratch slice is not the checkpoint payload: `formatCapturedEntries`
constructs a local `[]string` using a stack array or `runtime.makeslice` at
`0x141821159..0x14182119f`, stores its pointer at SP+`0x158`, and writes
newly formatted strings into it at `0x141821315/1333` and
`0x1418213a3/13c1`. Original `CapturedEntry` string pointer/length fields
`+8/+0x10` are read, not rewritten. The two format strings read through the PE
section table are `%d. %s` (VA `0x1439b92f4`, six bytes) and `%d.`
(VA `0x14399add5`, three bytes). Consequently even a parent entry with empty
source text has a nonempty numbered scratch string. A zero total parent budget
bypasses truncation; a zero water-fill share of a nonempty numbered entry emits
the nonempty native truncation notice through `ToTruncatedBytesString`
(`0x140b68e55..0x140b68ec0`, testing the removed-byte count at `+0x20`).
Thus the empty scratch marker is produced only by the user omission path, not
by a legal parent empty-source entry.

The expanded capture guard spans preserve the original nil branches while
selecting current history instead of a policy count:
`0x142222c5d..0x142222c6c` (Handle) and
`0x141cc6712..0x141cc671f` (core). Native capture still scans backward and
reverses the result into chronological order before formatting.

#### Stack and control-flow checks

No metadata is changed. The allocator keeps its original LEAVE/RET PCs at
`0x141823f7d/3f7e` and `0x141824007/4008`; the common `MOV RAX,R8`
is at `0x141824001`. Original `pcsp=72` and the two `pcsp=0` RET ranges
therefore remain valid. Its overwritten span has `UnsafePoint=-1` and
`StackMap=1`. The renderer's `0x141821611..0x1418216e7` span retains
`pcsp=760`, `UnsafePoint=-1`, and `StackMap=13`; the existing external
entries at `0x141821611`, `0x1418216e7`, and `0x141821718` are preserved.
The original dispatch at `0x14182160b` now jumps to `0x141821653`.
All existing calls and pointer roots remain; there is no executable slack arena,
new allocation call, changed SP, or metadata patch.

#### Prompt templates and offline execution

Native-mode regular segments reserve all prompt/data spans with
`new_hex == expected_hex`. Input-local `prompt` metadata declares custom
replacement templates for the raw 3,937-byte body and both consumers. The body
is filled with exact UTF-8 text plus unused space padding; only three declared
four-byte body-length immediates are changed to the actual text length. Prompt
metadata, templates and length fields participate in the recipe fingerprint.
The current fingerprint is
`2ebda7ec1f5c8cfb9b495217d5ac1a1b66d020502369b14849c359dc50f3810f`.

The custom core consumer retains its qualified call at `0x1420a4af1` to
`runtime.concatstring2` (`0x140070960`). Existing `pcsp=792`,
`UnsafePoint=-1`, `StackMap=9`, scalar outgoing slots `0x40..0x60`,
source prompt root SP+`0x230`, and final prompt slots `0x30/0x38` are
preserved. The original generation call at `0x1420a4b80` is unchanged.

Trusted emitted x86-64 blocks were executed in private executable allocations,
not by launching or executing the inspected Language Server. Cases covered
empty / one / more than 30 short inputs, mixed long sizes, exact 61,440-byte
exhaustion, a single oldest partial boundary, older-message omission, parent and
discrete water-fill including zero / negative budgets and signed-size clamping.
User allocation was identical for incoming budgets `0`, `10240`, `61440`,
`99999`, `2^40+7`, and `-7`; parent/discrete allocation continued to use each
incoming signed value. A source-length case above `2^32` confirmed that it was
not narrowed. The pre-fix v3 block failed the same user contract at incoming
budget zero: a 19-byte entry received omission sentinel `-1`, not allocation 19.
The v4 allocator block SHA-256 is
`9a4f560ebe4d9929d9b72edefc40f72dfe17eb3162e927ccf560bf2709d9b8ec`.

The custom Handle/core blocks, unchanged since v3, were execution-checked for
complete / changed manual suffixes, preserved original register arguments,
RetryConfig slots and concat arguments using a trusted concat stub. V4 changes
only the allocator segment; all other segments and custom prompt templates are
byte-identical to v3. Native/custom static audits checked branch targets and
preserved call and return PCs for v4.

These offline checks execute the emitted allocator and formatter argument/omission
blocks, not upstream truncation or the complete Go runtime; the 5-byte boundary
case checks allocation and native-call arguments only. The installed-client
observations below are separate evidence.

### Windows 2.32.1 live checks

Recorded 2026-11-18 (Asia/Taipei) on the installed build with the original identity
above, using synthetic conversations on the Gemini 3.8 Flash High core route. The
images also carried tool-output and model limits `1318/1319/1320=500000`: native
prompt image `7d2efd9493fcd35a0e81ed7ffdf0ffc4167fb5ec37cc6059d84ddd4adedafbe0`,
custom prompt image `655a020ad09b022145e508fd82e72dc8f5d75e1add5bad321972c83b8a2869d9`.

- **Retention.** A checkpoint with 33 text-only captured requests rendered entries 7
  through 33: 26 whole newer entries, one partial oldest entry, and six omitted
  older entries (the earlier v3 recipe rendered only entries 26–33 within 10,240
  bytes). The complete section matched an independent reconstruction byte for byte,
  including header, numbering, UTF-8 prefixes, separators, and the native truncation
  notice. Retained numbered source was 61,439 bytes (the next code point did not
  fit); the rendered section was 61,576 bytes, SHA-256
  `ea6a4d21605b890ef1edcb965086a350d8d9690d6473794f7fea3e5914686cd7`, valid
  UTF-8 with no U+FFFD.
- **Native prompt.** At the core generation call, native mode supplied 4,057 bytes:
  the original 3,937-byte prompt plus the 120-byte manual suffix, SHA-256
  `c0d46ddb483333062f9842d4f410810d550d1a471ad4287b9ca70793b07e1ca8`. The manual
  checkpoint completed.
- **Custom prompt.** A 206-byte prompt containing Traditional Chinese, emoji, and
  CRLF supplied exactly that text plus the suffix (326 bytes, SHA-256
  `308a5d2951a08fa54873fb95a8f94b231f51a6afba971f4fe0138767c784461f`). The
  checkpoint completed and contained a marker the prompt requested. Switching back
  to native reproduced the original 4,057-byte prompt.
- **Panel.** The panel counted the custom prompt as 206 bytes, like the CLI, even
  though its text box normalizes CRLF to LF; blank and oversized text were blocked.

To reproduce the retention observation, create a synthetic checkpoint with text-only
requests whose total formatted size exceeds the budget and read its
`capturedUserRequests` through `GetCascadeTrajectorySteps`. Independently allocate
61,440 bytes in reverse order over the UTF-8 strings `${index + 1}. ${text}`: keep
newer strings whole, shorten only the oldest boundary to a complete UTF-8 prefix,
and omit earlier strings. Compare the complete rendered section, including original
numbering, native separators, and the `<truncated N bytes>` notice.

To read the actual bytes on Windows, set a bounded hardware execution breakpoint at
the installed image base plus RVA `0x1820b05`, immediately after
`FormatCheckpointUserRequests` calls `formatCapturedEntries`; the Go string return is
`(RAX, RBX)`. For prompt adoption, break at the call at RVA `0x20a4b80`; the outgoing
prompt pointer and length are at `SP+0x30/SP+0x38`. Read them with
`ReadProcessMemory` and compare with the registered native body or the supplied
custom text plus the suffix recorded in
[build layouts](../scripts/lib/compaction-builds.mjs). Restore debug registers and
detach in all outcomes, and never execute an extracted installer binary.

These checks do not qualify other models, parent or media rendering, automatic
compaction, or arbitrary GC schedules.

### Historical v2 live evidence

The v2 recipe (30 requests of at most 2,048 bytes each, summary-v1 as the prompt)
is kept in `historical_inputs` only for migration and restore. Its observations on Windows
2.32.1, recorded 2026-11-16/17, remain useful route evidence but do not qualify the
current recipe:

- The Gemini 3.8 Flash High `useCoreDirect` route summarizes through Cortex core's
  `NewContextSummaryHook` and oneharness `generateContextSummary`, not
  `CheckpointHandler.Handle`, so patching raw prompt defaults alone is not enough;
  both consumers must be covered. The core consumer is at VA
  `0x1420a4a4c..0x1420a4b80`; oneharness `PopulateAuxiliaryCheckpointData` reads the
  request count at `0x141cc6717`.
- Consumer overrides do not rewrite the source configuration object, so executor
  metadata still reports the upstream prompt, count 10, and 1,024 bytes while the
  patched consumers use the local policy. Diagnostics report that metadata as is.
- Natural automatic compaction (2026-11-17) at the unchanged 256,000-token threshold
  produced a completed checkpoint whose summary consumer received exactly the
  3,871-byte summary-v1 prompt, SHA-256
  `8a82c71c3fc03e10f3d2eb80efb2498b4782f190f207bfcfc505604ff9125fb4`, without the
  manual suffix.
- With compaction and tool-output enabled, limit changes through the settings-draft
  path preserved both, plus localization and the capsule. On a binary copy, six
  enable orders, eight feature subsets, and reverse removals produced
  order-independent image hashes, and removing everything restored the exact
  original.
- M432 native-prompt preservation was checked statically and by offline execution;
  that model was unavailable to the test account. `stepcompactor` entry points were
  not reached on the tested manual route.

### Windows 2.31.2 legacy recipe

Every legacy segment is equal-length and was verified against both 2.31.2 inputs;
the prompt and value bytes are identical in both. VA-to-file-offset agreement is
re-derived from the PE section table (image base `0x140000000`) on every
inspection and build; no single delta constant is assumed. Image base and
sections: `.rdata` for the raw prompt, `.data` for the embedded configuration,
`.text` for the two initializer immediates.

Prompt segments (role `prompt`, all three carry the canonical text):

| Name | VA | File offset | Length |
| --- | --- | --- | --- |
| `summary-prompt-raw` | `0x143c2a28d` | 63,084,173 | 3,937 bytes (raw prompt in `.rdata`) |
| `summary-prompt-json-1` | `0x149e5ffea` | 166,063,594 | 4,103 bytes (encoded body in the embedded config) |
| `summary-prompt-json-2` | `0x149e62da4` | 166,075,300 | 4,103 bytes (encoded body, second profile) |

The two JSON bodies are the `session_summary_prompt_override` values of the
M124 and M408 `CASCADE_USE_EXPERIMENT_CHECKPOINTER` profiles; the other six
profile/variant settings carry empty overrides. The compiled-in raw prompt is
the candidate fallback, but the live fallback selection has not been verified.

Retention segments (role `capacity`):

| Name | VA | File offset | Change |
| --- | --- | --- | --- |
| 8 × `max-user-requests-<profile>` | see registry | see registry | ASCII `10` → `30` inside each profile's embedded settings |
| `max-user-request-bytes-imm32` | `0x1418c0f85` | 25,953,669 | `mov dword ptr [rax+0x1c], 1024` → `2048` |
| `max-user-requests-imm32` | `0x1418c0f90` | 25,953,680 | `mov dword ptr [rax+0x18], 10` → `30` |

Field mapping was confirmed by read-only inspection on 2026-11-15 for the
registered tool-output input. `utils.GetCheckpointConfig` at VA `0x1418c0c80`
initializes the fields using `c7 40 1c 00 04 00 00` and
`c7 40 18 0a 00 00 00`. The named protobuf getters prove their identities:

| Getter | VA | File offset | Getter bytes |
| --- | --- | --- | --- |
| `(*CheckpointConfig).GetMaxUserRequests` | `0x140c36de0` | `0xc363e0` | `48 85 c0 74 04 8b 40 18 c3 31 c0 c3` |
| `(*CheckpointConfig).GetMaxUserRequestBytes` | `0x140c36e00` | `0xc36400` | `48 85 c0 74 04 8b 40 1c c3 31 c0 c3` |

To reproduce, first hash the explicit input, resolve these function suffixes in
the Go pclntab function index, and map each entry VA through its PE section.
Read the listed bytes without executing the binary: `8b 40 18` reads the int32
at `+0x18`, while `8b 40 1c` reads `+0x1c`. The existing Go pclntab discovery
approach is in [binary.go](../src/agyctl/internal/limit/binary.go).

This proves the field mapping, not the byte cap's use in retention.
`CheckpointHandler.populateAuxiliaryCheckpointData` at VA `0x1425798a0` reads
`config+0x18` at `0x1425798e5` before calling `utils.CaptureUserRequests` at
`0x142579962`. `utils.captureRecentEntries` at `0x1418bde40` scans backward
and stops at the configured count. A retention consumer of `config+0x1c` was
not established by this inspection. The separate `gchat.TruncateUTF8Bytes`
helper at `0x142fc7ba0` respects byte and rune boundaries, but its presence
does not prove checkpoint retention calls it. Whether retention uses the byte
cap, and its ordering relative to count filtering, remain unverified.

### Prompt encoding

The 2.31.2 bodies are double-encoded, verified byte-for-byte by round-tripping both
recorded bodies (`encode(decode(body)) === body`):

1. Inner layer — Python-`json.dumps(ensure_ascii=True)`-style escaping of the
   raw prompt: newline → `\n`, quotes → `\"`, non-ASCII → `\uXXXX` (astral
   characters as surrogate-pair escapes).
2. Outer layer — Go-`json.Marshal`-style escaping with HTML escaping:
   `\` → `\\`, `"` → `\"`, `<` → `\u003c`, `>` → `\u003e`, `&` → `\u0026`.

Padding: the canonical prompt is shorter than the recorded prompt, so trailing
whitespace (44 newlines and 22 spaces for summary-v1) fills both segment
lengths. Padding grows by 1 byte per space and 3 bytes per newline in the
encoded body but 1 byte per either in the raw segment, so the split is solved
arithmetically and verified against both lengths. The comparison rule is
"remove trailing whitespace, then equal the canonical prompt"; recorded payload
hashes are per representation.

## Reproducing the static checks

All checks read file bytes only; extracted installer content is never executed.

```sh
node scripts/compaction-recipe.mjs inspect --binary ABS_PATH     # identity, PE mapping, segments, config sites
node scripts/compaction-recipe.mjs prompt-fit                    # canonical prompt against the registered lengths
node scripts/compaction-recipe.mjs check-registry                # registry vs canonical prompt consistency
node scripts/compaction-recipe.mjs build --binary ABS_PATH --expect-sha INPUT_SHA --out var/compaction/candidate.json
```

`build` verifies the whole-file input SHA against `--expect-sha`, re-derives
every VA mapping through the PE section table, verifies the recorded prompt
preimages, applies the recipe in memory, re-parses the full embedded
configuration (outer and per-profile JSON). For the 2.32.1 consumer recipe, every
embedded setting retains its original semantics; for the legacy 2.31.2 recipe,
only the recorded prompt overrides and `max_user_requests` values may change.
Candidate output is written only under `var/`. `compat/compaction.json` is the
promoted, reviewed registry; `check-registry` reproduces the current consumer
assembly, checks legacy prompt replacements against the canonical prompt, and
verifies historical recipe fingerprints so these editing sources cannot silently
diverge.

## Admission gate and coexistence

`compaction` reuses the shared [layout](../src/agyctl/internal/layout/layout.go)
discovery, the shared operation lock (`limit-operation.lock`), and the
transaction machinery rules described in
[operations](operations.md#recovery-boundaries). Verified backups precede writes,
prepare records bind replacement and recovery, and foreign or drifted states are
refused rather than repaired.

Admission and transaction refusals exit nonzero with one JSON object containing
`error` and `refusal.kind` (with `refusal.detail`). Callers must use that structured
reason instead of parsing the English message. The panel maps a rejected compaction
preview to its localized unavailable message; preflight does not modify the binary or
complete a pending transaction.

### Windows 2.32.1 native composition

Limit, tool-output, and compaction use one native transaction for the exact
registered 2.32.1 original. Independent compaction removal preserves the other
enabled features, and limit changes do not require removing compaction. Each
feature retains its own gate before the coordinator rebuilds the complete image
from the verified original. Commands, reviewed-plan bindings, and recovery are
owned by [native composition](operations.md#native-feature-composition).

### Windows 2.31.2 legacy coexistence

The following standalone transaction and conflict rules apply only to the legacy
2.31.2 recipe. Restore accepts its recorded output or a validated pending
transaction, not another feature's later output.

- **With `tool-output`:** the registered inputs are the tool-output patch
  output and the grep-patched baseline. Compaction only adds its own byte
  differences and preserves the tool-output and grep fixes. Restoring
  compaction returns exactly the input it patched from — the tool-output state
  is untouched and remains owned by its own command.
- **With `limit`:** limit's byte-signature gate is unchanged. Compaction
  refuses a binary that matches limit's last patch output
  (`PATCH_CONFLICT`); remove the limit patch with `agyctl limit restore`
  first. Applying limit on top of a compaction output is not blocked by limit,
  and it leaves the binary in a state compaction's restore refuses; the panel
  keeps the two patches exclusive for this reason and offers no combination.

## Qualification status

The 2.32.1 recipe is a `candidate`: its emitted code is execution-checked offline and
its core-route behavior is [live-checked](#windows-2321-live-checks) for manual
compaction on one model. The [v2 observations](#historical-v2-live-evidence) do not
qualify the current retention algorithm or custom prompt templates. Promotion needs
at least automatic compaction and other model routes. No claim is made about every
model, complete-runtime GC behavior, or summary quality.

### Windows 2.31.2 legacy qualification

Controlled live test, 2026-11-15, on Antigravity 2.31.2 Windows stable with the LS
running from the patched binary (`c6c7d81e…`, hash re-verified while running): a new
Gemini 3.8 Flash High session with three marker facts, one user correction, and an
unfinished goal, followed by a manual `/compact`.

| Check | Result |
| --- | --- |
| Apply / restore | Applied `47a439… → c6c7d81e…` with verified backups; restore returned exactly `47a439…`; a second apply reported `already-applied`. |
| Manual `/compact` | Completed normally; markers, the correction, and the unfinished goal were retained. |
| Thresholds | Executor checkpoint limit stayed `256000`. |
| **Prompt adoption** | **Not effective.** The summary used upstream's seven-section structure, not summary-v1's ten sections, so this route does not read the three patched prompt sources, or a higher layer such as server settings overrides them. |
| Retention values | No observable evidence; whether retention uses the byte cap was never established (see [recipe segments](#recipe-segments)). |
| Other models, automatic compaction | Not tested. |

The recipe therefore stays `candidate`. Static verification still holds: both
registered recipes reproduce their output hashes, full-file diffs stay inside the 13
registered segments, and the embedded configuration round-trips with only the
expected field changes. Open questions are recorded in the registry notes: whether
retention uses `max_user_request_bytes`, its truncation and ordering, upstream
acceptance of the whitespace padding, which profile a live session selects, and
whether remote settings override these values (confirmed for the prompt on the
tested route). The later 2.32.1 evidence does not show that the 2.31.2 source
defaults work.
