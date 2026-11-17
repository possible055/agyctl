# Architecture

`agyctl` adds usage visibility and optional client modifications to the
Antigravity 2.31.x desktop app (stable release). The tools can also discover and
inspect the development (Insiders) channel. Exact builds are recorded per feature
in `compat/` (see [limit patch](limit-patch.md),
[tool-output patch](tool-output-patch.md),
[compaction patch](compaction-patch.md), and
[localization](localization.md#current-status)); no feature is admitted by app
version alone. Supported tool targets are Windows x86-64, Linux x86-64, and macOS
Apple Silicon; discovery coverage does not imply that every feature works on every
target.

The project provides:

- read-only display of server-recorded token usage and context-limit metadata;
- generation-speed and cost **estimates**, labeled as such;
- an optional input-toolbar capsule, interface localization, a signature-gated
  context-limit patch, a whole-file tool-output capacity patch, and a whole-file
  summary-compaction patch;
- a checker that inspects new upstream packages without installing or executing
  them.

Every localization profile is `probe-only`: no profile has complete real-client
acceptance. See [localization](localization.md#current-status).

## Upstream desktop architecture

In the inspected packages, the Electron shell and the Go Language Server (LS) are
separate components. The shell lives in `resources/app.asar`; the native LS lives
in `resources/bin/language_server.exe` (`language_server` on Linux and macOS). The
main chat web UI is served by the LS, not by the shell's `dist/main.js`.

```text
Antigravity Electron main process
  app.asar/dist/main.js
    -> dist/languageServer.js starts/monitors the Language Server
    -> dist/utils.js creates the window and loads the LS web origin
          |
          +-- dist/preload.js: Electron bridge
          +-- renderer: LS-served chat UI
                -> exa.language_server_pb.LanguageServerService
                   over local Connect-RPC
```

This is the normal local desktop path. A WSL or headless session may use a
different LS than the one packaged with the Windows app.

agyctl sends Connect JSON requests. Unary Connect can use HTTP/1.1; framed
streaming is a distinct wire form (see the
[Connect protocol reference](https://connectrpc.com/docs/protocol/)).

## Project-owned components

### Sidecar panel

[src/plugin/](../src/plugin/) is a sidecar package. Its
[manifest](../src/plugin/sidecars/panel/sidecar.json) starts
[main.mjs](../src/plugin/sidecars/panel/main.mjs), which loads the runtime-provided
`sidecar_sdk`. A loopback development shim is used only when the SDK is missing
and the production sidecar token is absent.

The panel shows historical usage, estimated cost, pricing, and editable patch
settings. It talks to the LS over Connect-RPC only: it uses no CDP and never
writes `app.asar` or closes and restarts Antigravity.

- [transport.mjs](../src/plugin/sidecars/panel/transport.mjs) discovers the LS
  through environment values or product logs, obtains CSRF metadata, and makes
  Node HTTP(S) Connect requests.
- [usage.mjs](../src/plugin/sidecars/panel/usage.mjs) combines local conversation
  discovery, read-only summary data, and LS trajectory/generator/step RPCs. File
  fingerprints limit rescanning, and partial/error/date-coverage state accompanies
  incomplete scans. Changing the LS host, port, or product invalidates usage caches
  and retry backoff. Historical totals are not a provider billing ledger.
- Feature reads and writes go through
  [feature-control.mjs](../src/plugin/sidecars/panel/feature-control.mjs), which
  spawns [feature-control-worker.mjs](../scripts/feature-control-worker.mjs) in the
  checkout. The worker calls
  [feature-control.mjs](../scripts/lib/feature-control.mjs) for installed state and
  drafts, and [model-catalog.mjs](../scripts/lib/model-catalog.mjs) for model names
  (the signed-in LS catalog joined to the selected binary's literal model enum;
  unknown mappings are not guessed).
- **Save settings** writes a draft only. A terminal command applies it after the
  user quits the client; see
  [panel patch controls](operations.md#panel-patch-controls).

Live per-conversation context and speed display belong to the capsule.

### Input-toolbar capsule and shared logic

[src/capsule/](../src/capsule/) adds the optional live widget near the chat input.
It uses browser `fetch` against the host LS origin and its
`__APP_CONFIG__.csrfToken`, not the panel's Node log-discovery transport.
`SubscribeToSidecars` discovers the matching panel endpoint for saved prices.
Polling serializes requests, rereads a bounded generator tail, and periodically
reconciles from offset zero; it is not a change feed or a full rescan of all
conversations on every poll.

Shared logic and boundary contracts:

| Module | Responsibility |
| --- | --- |
| [metrics-core.mjs](../src/plugin/lib/metrics-core.mjs) | Token normalization, session aggregation, and speed calculations |
| [pricing-core.mjs](../src/plugin/lib/pricing-core.mjs) | Model-family resolution and local USD cost estimation |
| [poll-policy.mjs](../src/plugin/lib/poll-policy.mjs) | Poll-delay and executor/reconciliation decisions |
| [upstream-contract.mjs](../src/plugin/lib/upstream-contract.mjs) | LS service/method identifiers and response normalization |
| [locale.mjs](../src/plugin/lib/locale.mjs) | Canonical locale selection, feature-specific messages, and number/date formatting |
| [locale-state.mjs](../src/plugin/lib/locale-state.mjs) | One Host language state and the fixed sidecar-frame bootstrap contract |
| [anchors.js](../src/capsule/anchors.js) | The only definition of the upstream DOM anchors the capsule mounts on; the install-time served-bundle gate derives its tokens from it |
| [host-ui.js](../src/capsule/host-ui.js) | Capsule element IDs, DOM queries over those anchors, and mount helpers |

[scripts/capsule-build.mjs](../scripts/capsule-build.mjs) assembles these modules
into the self-contained `dist/capsule/input-capsule.js`; see
[build outputs](development.md#build-outputs).

AGY's own interface language (capsule and panel) is one Host-owned state shared
with embedded panel frames; [page.mjs](../src/plugin/sidecars/panel/page.mjs)
embeds the same locale modules into the panel. These product messages are separate
from client localization; see
[interface languages](operations.md#interface-languages).

### What the measurements mean

- Token usage and checkpoint/capacity values come from LS metadata. The project
  does not tokenize conversation text to produce usage totals.
- Speed is computed from LS token counts and timings. It estimates delivery, not
  engine-side decoding speed or whole-task throughput. Recent same-model rates use
  confirmed-complete generations.
- Cost uses built-in aliases/rates or user overrides. It is an estimate, not an
  official price list or an account bill.
- The composition breakdown for skills, rules, tools, and prompts is an item-count
  heuristic, and its buffer can fall back to a local default when LS data lacks
  one. It is not a server-measured breakdown.

Unavailable, incomplete, stale, and estimated values must remain distinguishable in
the UI.

## Installed-client modification points

These are separate optional operations; none is a prerequisite for read-only panel
usage.

| Component | Target | Modification |
| --- | --- | --- |
| Panel installation | Plugin directory | Installs project sidecar files; does not modify `app.asar` or the LS |
| Capsule | `app.asar/dist/preload.js`, `dist/input-capsule.js` | Appends a preload hook containing the capsule code and retains a capsule member |
| Limit patch | Native LS executable | Replaces an admitted x86-64 clamp body and its model-ID table |
| Tool-output patch | Native LS executable | Applies a fixed whole-file capacity recipe for one registered build |
| Localization | ASAR preload, reviewed adapter targets, `dist/agyctl-localization/*` | Adds the Hub bootstrap, DOM engine, native helpers, and profile-specific adapter edits. Does not rewrite the LS asset archive or intercept Hub HTTPS |

The shared [Host Composer](../src/host/compose.ts) implements ASAR composition
behind the capsule and Host command entry points. It starts from a verified
original and composes the requested and retained features together, so the capsule
and localization never overwrite each other's archive. It owns identity,
backup/receipt handling, contribution conflicts, and the single archive
transaction, but not feature-specific admission or code generation.
[Capsule](../src/capsule/host-feature.ts) and
[localization](../src/localization/host/feature.ts) provide the contributions.
Saved contributions are hash-bound, so retaining a feature does not rebuild it; see
[Host rules](operations.md#reviewed-host-changes).

The [capsule hook](../src/capsule/preload-hook.ts) embeds the capsule code in the
preload behind the `// [agyctl Host Capsule Feature]` marker and runs it through
`webFrame.executeJavaScript`; it does not fetch `dist/input-capsule.js` at startup.
The capsule [entry](../src/capsule/entry.js) resolves the Host language at mount
time, after the parsed `<html lang>` is readable, and defers UI mounting until DOM
readiness.

Capsule installation only replaces the archive; no CDP is involved. Before
replacing it, the installer checks every anchor token derived from
[anchors.js](../src/capsule/anchors.js) against the web bundle the client's LS
serves ([served-bundle.ts](../src/capsule/served-bundle.ts); bounded extraction that
never executes the bundle) and refuses when one is missing. A passing check does
not prove the capsule visibly mounts; reopen the client to confirm.

### Localization

Localization is an optional Host feature. An offline `prepare` publishes a DOM
artifact into tool state, the Host contribution adds the bootstrap and reviewed
native adapter edits to the ASAR, and the runtime injects the DOM engine on the
next launch. See [localization](localization.md).

### Limit admission and recovery

The limit patcher admits PE and ELF64 x86-64 images. It reads Mach-O ARM64 as data
and reports its state as `unavailable`; macOS mutation needs its own reviewed bytes
and signing evidence. Windows and Linux ARM64 are not supported. Admission compares
the original function bytes for the detected architecture with
[versions.json](../compat/versions.json), not the application version, so an
unlisted version with known bytes can pass. The registry also records the
Windows stable 2.32.1 live observation. The requested limit remains subject to the
replacement's later clamps and upstream/provider restrictions. See
[limit patch](limit-patch.md).

The tool-output patcher admits only binaries whose whole-file SHA-256 is registered
in [tool-output.json](../compat/tool-output.json) for one qualified build. It owns
its admission, planning, transaction, and restore in
[tooloutput](../src/agyctl/internal/tooloutput/). It shares target resolution
([layout](../src/agyctl/internal/layout/layout.go),
[winproc](../src/agyctl/internal/winproc/winproc.go),
[apptarget](../src/agyctl/internal/apptarget/target.go)) and the
[patchlock](../src/agyctl/internal/patchlock/patchlock.go) operation lock with the
limit feature, but does not import the limit registry. See
[tool-output patch](tool-output-patch.md).

The legacy compaction patcher follows the same whole-file admission pattern for its own
registry, [compaction.json](../compat/compaction.json), and owns its transactions
in [compaction](../src/agyctl/internal/compaction/). Its registered inputs are the
tool-output patch output and the grep-patched baseline of one build; it changes
only the summary-prompt strings and the request-retention values, and it reports
other features' patches as conflicts instead of patching over them. See
[compaction patch](compaction-patch.md).

For the exact registered Windows 2.32.1 original, L/T/C mutations instead use the
fixed-feature [native coordinator](../src/agyctl/internal/lspatch/), assembled by
the [native CLI](../src/agyctl/cmd/agyctl/native.go). Each contribution first
reproduces its own byte-gated recipe, and the coordinator reconstructs the entire
desired image from the verified original. Disabled recipe spans remain reserved
against limit-node allocation. One native active record and prepare transaction
own that target; feature entry points cannot bypass them. Historical recipes are
retained by exact identity and fingerprint to reproduce an older managed image
before migrating it to current recipes. Unknown bytes and stale reviewed plans
refuse. Other builds keep their existing feature gates and recovery paths. See
[native feature composition](operations.md#native-feature-composition).

ASAR composition and binary patches retain original backups and hash-bound
recovery records. Staging, per-file replacement, and prepare records are not one
atomic transaction across components, and they do not guard against arbitrary
storage failure. Restoration requires matching evidence, not just a hook marker. See
[operations](operations.md#recovery-boundaries).

## Compatibility checks and distribution

[compat/install-layout.json](../compat/install-layout.json) defines the default
stable (Hub) and Insiders install paths for Windows, macOS, and Linux.

The Go [checker](update-check.md) inspects installers and installed files. It parses
ASAR and executable formats with its own code, but reads the recorded original
function bodies from [versions.json](../compat/versions.json), the registry the
limit patcher gates on. Its verdict is screening evidence and gates nothing.

Each feature gates its own writes (see
[client modifications](operations.md#client-modifications-from-the-cli)):

- limit patch: exact byte-signature match;
- tool-output patch: registered whole-file hash;
- compaction patch: registered whole-file hash;
- capsule: executable and ASAR qualification plus served-bundle anchors;
- localization: profile or structural evidence plus bound plan inputs.

`node scripts/manage.mjs status` reports these gates read-only. The capsule and
localization form one Host mutation group, admitted and journaled together; the
binary patches are independent operations. The project never closes, relaunches, or
supervises the client: [winproc](../src/agyctl/internal/winproc/) only inspects
processes so that applies refuse while the selected client or LS runs.

The Go tool reads the compat data each command declares from the repository
checkout. [assets](../src/agyctl/internal/assets/capture.go) captures those files
once and the command decides on the captured bytes. This is not an immutable
execution snapshot and does not protect against concurrent privileged
modification.

The project runs from a Git checkout. Update it with `git pull`, `npm ci`, and
`npm run plugin:install`; there is no release signing or self-updater.
Commands and recovery workflows are in [operations](operations.md).
