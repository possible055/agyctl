# Language Server Summary Compaction Patch

This page owns the `agyctl compaction` feature: the registered summary-prompt and
request-retention recipe, its build-specific binary evidence, and its
modification boundary. Commands and recovery are in
[operations](operations.md#summary-compaction-patch); component boundaries are in
[architecture](architecture.md#limit-admission-and-recovery). The feature is
independent of the context-limit patch (`agyctl limit`, documented in
[limit-patch.md](limit-patch.md)) and the tool-output capacity patch
(`agyctl tool-output`, documented in
[tool-output-patch.md](tool-output-patch.md)).

## Status

Qualification is build-specific in [compaction.json](../compat/compaction.json):

| Build | Status | Recorded runtime scope |
| --- | --- | --- |
| Windows 2.32.1 | `supported` | The exact current consumer recipe adopted the canonical prompt during manual and natural automatic compaction on Gemini 3.8 Flash High; request capture, rendered retention, and native feature coexistence were also verified. Other model routes are not implied. |
| Windows 2.31.2 | `candidate` | The legacy default-string recipe completed its transaction, but the tested Gemini route did not adopt the replacement prompt; retention remains unverified. |

See [consumer evidence](#windows-2321-consumer-evidence) and
[legacy qualification](#windows-2312-legacy-qualification). A disk patch never
proves what the running session loaded; `compaction status` continues to report
`effective_state: "unknown"`, separately from a build's recorded qualification.

Each build implements one fixed combination, not a set of tunable features:

- **Summary prompt v1** replaces the upstream continuation-summary prompt with
  the canonical ten-section text in
  [summary-v1.txt](../compat/compaction/summary-v1.txt). It keeps the
  `<summary>` wrapper and the no-tools rule, drops the unbounded verbatim
  user-message requirement, and prioritizes the latest user intent, unresolved
  constraints, current work state (including the last tool call's outcome, or
  an explicit "unknown"), and next steps.
- **Request retention** targets 30 requests and at most 2048 rendered bytes per
  request. The 2.32.1 consumer recipe preserves lower native allocations and
  leaves source configuration values unchanged; the legacy recipe edits the
  `max_user_requests` and `max_user_request_bytes` defaults instead.
- **Untouched by design:** automatic compaction thresholds
  (`max_token_limit`, `token_threshold`, model reporting flags), the 3.0
  context-estimation divisor, file re-attachment, synthetic aborted tool
  results, a forced continuation preamble, and the manual `/compact` command
  path (command parsing, trigger flags, and handler bytes are not in any
  registered segment). Remote settings are not rewritten. The 2.32.1 consumers
  substitute only the recorded default/legacy prompt selections and preserve
  other nonempty overrides, including M432. Legacy source-default changes alone
  did not establish runtime adoption.

## Registered build

### Windows 2.32.1

The current recipe targets **Antigravity App Windows 2.32.1, `windows-amd64`**,
package member `resources/bin/language_server.exe`, 215,547,392 bytes.

| State | Whole-file SHA-256 |
| --- | --- |
| Original input | `65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f` |
| Current standalone compaction output | `b9ba32e6e1f23227e2ac1f109e509b8e487d231397002e24a44cac1c556997da` |

The recipe admits only this exact original. Managed combinations are rebuilt
from that original by [native composition](operations.md#native-feature-composition),
not admitted as arbitrary new recipe inputs. The exact prior consumer recipe
remains in `historical_inputs` only for native transaction migration and restore;
it is not the currently qualified recipe.

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
(`e40f0447…`) is **not** registered: no verified copy exists locally, and a
registry entry is added only after the exact input file was hash-verified.

## Recipe segments

### Windows 2.32.1 consumer evidence

Recorded 2026-11-16 for `resources/bin/language_server.exe`, original SHA
`65cdb8d132fc61056625081be7d07d4d22f57eba485de7edf0d24d98e77c891f`.
The standalone C output is
`b9ba32e6e1f23227e2ac1f109e509b8e487d231397002e24a44cac1c556997da`.
The current recipe, metadata, addresses, and preimages are reproducible from
[build layouts](../scripts/lib/compaction-builds.mjs),
[consumer assembly](../scripts/lib/compaction-consumers.mjs), and
[the registry](../compat/compaction.json).

- The live Gemini 3.8 Flash High `useCoreDirect` route enters Cortex core's
  `NewContextSummaryHook`, then oneharness `generateContextSummary`, not
  `CheckpointHandler.Handle`. The replacement at VA `0x1420a4a4c..0x1420a4b80`
  recognizes the complete legacy prompt, optionally followed by the exact native
  120-byte on-demand instruction. It preserves the latter verbatim, M432's native
  prompt, and all other nonempty overrides. The Handle consumer is also covered;
  modifying raw defaults alone was insufficient.
- One qualified call to existing `runtime.concatstring2` retains the native
  manual instruction. The original generation call and SP remain unchanged.
  Scalar retry values go directly to their original outgoing ABI slots; live
  pointer roots, native heap/write-barrier operations, and Go metadata are
  retained. Build evidence records the exact stack map, spill bounds, and call
  addresses; this is not an arbitrary trampoline or borrowed padding region.
- A hardware breakpoint at the actual generation call observed a 3,991-byte
  prompt, SHA `56be593a4dfcbea1f873d52aaab6b68f96d1cf8f68b53214b59404c837034b35`,
  exactly matching the canonical prompt plus the native manual instruction.
  The resulting checkpoint completed with ten sections. This directly validates
  adoption on that route rather than inferring it from headings.
- Oneharness `PopulateAuxiliaryCheckpointData` consumes the request count at
  `0x141cc6717`. A synthetic conversation with more than 30 requests retained
  exactly 30, in order. The common converter's native formatter remains in use.
  Raw checkpoint source text may exceed the rendering ceiling; stored raw text
  and model-visible rendered retention are different observations.
- A second synthetic conversation isolated one long request from the shared
  waterfill budget. Its 8,434-byte Chinese/English/emoji source rendered as an
  exact 2,043-byte UTF-8 prefix plus the native truncation notice, with no U+FFFD.
  The consumer passes `min(native allocation, 2048)` to native UTF-8 truncation;
  its formatting and code-point boundary can retain slightly fewer bytes. A
  separate many-long-requests case retained lower native waterfill allocations
  rather than inflating them to 2,048. Three original test markers and the
  Traditional Chinese correction survived. Another continuation correctly
  recalled completed `read_file` and `AGY_CAP_2000` without rerunning tools.
- These consumer overrides intentionally do not rewrite the source configuration
  object. Executor metadata can still report the upstream prompt, count 10, and
  bytes 1024 while the above consumers use the local policy. Diagnostics report
  that metadata honestly rather than inventing replacement values.
- Native M432 preservation is statically and locally execution-checked; that
  model was unavailable to the signed-in account and is not live-qualified.
  `stepcompactor` entry points were not observed during this tested manual route;
  their existence or absent metadata is not proof about other models. The recipe
  does not disable or force-enable step compaction.
- **Natural automatic compaction, 2026-11-17 (Asia/Taipei):** a new synthetic
  Gemini 3.8 Flash High session used the unchanged native `maxTokenLimit=256000`
  with L disabled and C/T retained. Ordinary messages incrementally built the
  context; no slash command or threshold override was sent. The fifth increment
  produced a completed checkpoint and normal response. The actual summary
  consumer received exactly the 3,871-byte canonical prompt, SHA
  `8a82c71c3fc03e10f3d2eb80efb2498b4782f190f207bfcfc505604ff9125fb4`,
  without the manual suffix. The preceding normal request reported 60,342 input
  tokens and 194,020 cache-read tokens; the post-compaction request reported
  23,066 input tokens. Both original markers and the language constraint survived.
- **Installed coexistence:** while C/T remained enabled, changing L to 550,000
  read back as 550,000 in the executor. The production settings-draft path then
  restored L to 500,000 without dropping C/T, TW localization, or the capsule.
  Reapplying the same managed state preserved its generation. A reviewed Host
  plan created before that native change refused afterwards; both installed
  file hashes stayed unchanged by the rejected operation. Six enable orders,
  eight subsets, and reverse independent removals were additionally exercised on
  a real binary copy; complete image hashes were order-independent and all-off
  restored the exact original. Interrupted-transaction recovery is covered by
  Go tests, not a claimed live power-loss experiment.

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

Compaction admission and transaction refusals keep a nonzero exit status and one
JSON object containing
`error` and `refusal.kind` (with `refusal.detail`). Callers must use that
structured reason instead of parsing the English message. The panel maps a
rejected compaction preview to its localized unavailable message; preflight
does not modify the binary or complete a pending transaction.

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

The current 2.32.1 recipe is `supported` only within the recorded
[consumer evidence](#windows-2321-consumer-evidence): Gemini 3.8 Flash High manual
and natural automatic adoption, request capture/rendering, and native feature
coexistence. M432 was not available for live testing, and no claim extends to all
models or general summary-quality improvement.

### Windows 2.31.2 legacy qualification

Controlled live test, 2026-11-15: Antigravity 2.31.2 Windows stable, LS
relaunched from the patched binary (`c6c7d81e…`, whole-file hash re-verified
while running), new session on the Gemini 3.8 Flash High path with three
planted marker facts, one user correction, an unfinished goal, then a manual
`/compact`.

| Check | Result |
| --- | --- |
| Apply / restore transaction | Applied `47a439… → c6c7d81e…` with verified backups; restore returned exactly `47a439…` (the tool-output state, from the verified `.orig.<sha>` sibling); a second apply reported `already-applied`; status reported `managed-output` throughout. |
| Manual `/compact` | Triggered and completed normally on the patched binary; the command path is not broken by the patch. |
| Summary output quality | Well-formed `<summary>…</summary>`; all planted markers, the language correction, and the unfinished goal were retained. |
| Compaction thresholds | `executor_metadata` checkpoint limit read with the project's read-only diagnostics: `256000` in the patched-binary session, equal to pre-patch sessions — thresholds untouched. |
| **Prompt adoption (M1)** | **Not effective on the tested path.** The produced summary follows the upstream seven-section structure (`Task Overview`, `Progress`, `Key Findings`, `Errors & Fixes`, `Active Context`, `Next Steps`, `Commitments & Constraints`), not the ten-section summary-v1. The LS ran from the patched bytes, so the summarizer on this path does not read the three covered prompt sources (the compiled-in raw prompt and the two `session_summary_prompt_override` values), or a higher layer such as server settings overrides them. |
| Retention values (M2) | Unknown on this path. The summary gives no observable evidence for the 30-request / 2048-byte retention change, and the byte cap's retention use was already unverified (see [Recipe segments](#recipe-segments)). |
| Other model paths | Not tested; each profile path stands on its own evidence. |
| Natural auto-compaction | Not tested (native 256K threshold not reached). |

Interpretation of this 2.31.2 test: the legacy recipe completed its transaction
and did not disturb the tested manual compaction path, but its prompt change was
not adopted and retention remained unverified. That recipe stays `candidate`.
The later 2.32.1 consumer evidence does not establish that the legacy source
defaults worked, nor does it authorize intercepting arbitrary remote overrides.

Static verification remains: both registered recipes reproduce their
registered output hashes; full-file diffs stay inside the 13 registered
segments; the embedded configuration round-trips with only the expected field
changes. Summary quality against the ten-section prompt cannot be evaluated
while the prompt is not adopted; no claim is made that it improves summaries.
Remaining unknowns are also recorded in the registry notes: whether retention
actually uses `max_user_request_bytes`, its truncation/order semantics,
upstream acceptance of the trailing-whitespace padding, which profile a live
session selects, and whether a remote settings override replaces these values
before use — the live test confirms the last question is real for the prompt
override on the tested path.
