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

The recipe is qualified as `candidate` in
[compaction.json](../compat/compaction.json). Only static verification has been
performed: the registered recipes reproduce their registered output hashes from
the registered inputs byte for byte. Live validation — that a new session
actually adopts the new prompt and retention values, that summary quality
improves, and that upstream accepts the trailing-whitespace padding — is pending
and is a separate, explicitly authorized step. A disk patch never proves the
loaded configuration; `compaction status` reports `effective_state: "unknown"`
for this reason.

The first version is one fixed combination, not a set of tunable features:

- **Summary prompt v1** replaces the upstream continuation-summary prompt with
  the canonical ten-section text in
  [summary-v1.txt](../compat/compaction/summary-v1.txt). It keeps the
  `<summary>` wrapper and the no-tools rule, drops the unbounded verbatim
  user-message requirement, and prioritizes the latest user intent, unresolved
  constraints, current work state (including the last tool call's outcome, or
  an explicit "unknown"), and next steps.
- **Request retention** raises `max_user_requests` from 10 to 30 and
  `max_user_request_bytes` from 1024 to 2048.
- **Untouched by design:** automatic compaction thresholds
  (`max_token_limit`, `token_threshold`, model reporting flags), the 3.0
  context-estimation divisor, file re-attachment, synthetic aborted tool
  results, a forced continuation preamble, and the manual `/compact` command
  path (command parsing, trigger flags, and handler bytes are not in any
  registered segment). Remote settings overrides are neither intercepted nor
  forced; if one overrides these values at runtime, the disk patch would not
  take effect, and no detection exists yet — this is recorded as an open risk,
  not a verified failure.

## Registered build

Exactly one build is registered: **Antigravity App Windows 2.31.2,
`windows-amd64`**, package member `resources/bin/language_server.exe`,
197,992,960 bytes. Only registered whole-file inputs are admitted; a matching
version number or a successful install discovery never admits a binary.

| State | Whole-file SHA-256 |
| --- | --- |
| Tool-output patch output (current installed state) | `47a439efe717e797533f1cdc0c303d40f264c5f1e0a1135f766b64f1208fa61e` |
| Grep-patched baseline (recorded `.orig` sibling) | `1c69b4fc10b15b016125d38a32a5b4fd13018dad22564207b576bbb3e759e164` |
| Compaction output from the tool-output input | `c6c7d81e29eeab66af720c2304c7ad6b7543c5482db48dfd1379dd7a95c33814` |
| Compaction output from the grep-patched input | `b361c8c3ed47a1e315714d1f8b8178e23f282cb4d0724be5aeb8d9380c0831d6` |

Each input has its own recipe and its own output hash. The unpatched original
(`e40f0447…`) is **not** registered: no verified copy exists locally, and a
registry entry is added only after the exact input file was hash-verified.

## Recipe segments

Every segment is equal-length and was verified against both registered inputs;
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

The bodies are double-encoded, verified byte-for-byte by round-tripping both
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
configuration (outer and per-profile JSON), and fails unless the only changed
fields are the two prompt overrides and the eight `max_user_requests` values.
Candidate output is written only under `var/`. `compat/compaction.json` is the
promoted, reviewed registry; `check-registry` decodes its registered `new_hex`
and compares it against the canonical prompt so the text and the recipe cannot
silently diverge.

## Admission gate and coexistence

`compaction` reuses the shared [layout](../src/agyctl/internal/layout/layout.go)
discovery, the shared operation lock (`limit-operation.lock`), and the
transaction machinery rules described in
[operations](operations.md#recovery-boundaries): verified backups are created
before any write, a direction-aware prepare record is verified before replacement,
restore accepts only this feature's recorded output or a validated pending
transaction, and foreign or drifted states are
refused, never repaired.

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

| Level | State |
| --- | --- |
| Static (`static-verified`) | Both registered recipes reproduce their registered output hashes; full-file diffs stay inside the 13 registered segments; embedded configuration round-trips with only the expected field changes. |
| Runtime (`runtime-verified`) | Not verified. Requires an authorized controlled run on a qualified installation: new-session adoption of M1/M2 values, manual `/compact` smoke test, retention boundary behavior (≤30 requests, ≤2048 bytes each), and automatic triggering at the untouched native thresholds. |
| Quality (`quality-evaluated`) | Not evaluated. Summary content checks against synthetic conversations are pending; no claim is made that the ten-section prompt improves summaries. |

Known unknowns, also recorded in the registry notes: whether retention actually
uses `max_user_request_bytes`, its truncation/order semantics, upstream acceptance
of the trailing-whitespace padding, which profile a live session selects, and
whether a remote settings override replaces these values before use.
