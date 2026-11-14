# Architecture and Modification Boundaries

`agyctl` adds usage visibility and optional client modifications to the
Antigravity 2.31.0 desktop app (stable release). Older compatibility records remain
historical evidence, not current acceptance targets. The tools can still discover and
inspect the development (Insiders) channel. The supported tool targets
are Windows x86-64, Linux x86-64, and macOS Apple Silicon.

The main goals are:

- display server-recorded token usage and available context-limit metadata;
- show generation-delivery speed and cost **estimates**, with their limitations;
- provide an optional input-toolbar capsule and signature-gated local limit patch;
- inspect new upstream packages without installing or executing them.

Localization has an offline preparation path and a Host integration implementation,
but every recorded profile is still `probe-only`: there is **no profile with complete
real-client acceptance**. See [localization](localization.md).

## Upstream desktop architecture

In the inspected Windows packages, the Electron shell and the Go Language Server
are separate components. The shell lives in `resources/app.asar`; the packaged
native LS lives in `resources/bin/language_server.exe`. The main chat web UI is
served by the LS, rather than being the Electron shell's `dist/main.js`.

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

This diagram describes the normal local desktop path, not a universal window
implementation or a WSL/headless deployment. A packaged Windows LS need not be
the server used by a WSL session. Finding shell JavaScript in ASAR must not be
confused with finding the main chat bundle there.

The project uses Connect JSON requests, not a blanket HTTP/2-only contract.
Unary Connect can use HTTP/1.1; framed streaming is a distinct wire form.
See the [Connect protocol reference](https://connectrpc.com/docs/protocol/).

## Project-owned components

### Sidecar panel

[src/plugin/](../src/plugin/) is a sidecar package. Its
[manifest](../src/plugin/sidecars/panel/sidecar.json) starts
[main.mjs](../src/plugin/sidecars/panel/main.mjs), which loads the
runtime-provided `sidecar_sdk`. A loopback development shim is used only when
the SDK is missing and the production sidecar token is absent.

The panel UI covers historical usage, estimated cost, pricing, and editable patch
settings. Feature reads and writes go through
[feature-control.mjs](../src/plugin/sidecars/panel/feature-control.mjs), which
spawns [feature-control-worker.mjs](../scripts/feature-control-worker.mjs) in the
checkout; the worker calls [feature-control.mjs](../scripts/lib/feature-control.mjs)
for installed state and drafts and
[model-catalog.mjs](../scripts/lib/model-catalog.mjs) for model names (the
signed-in LS catalog joined to the selected binary's literal model enum; unknown
mappings are not guessed). Save settings writes a draft only; it is applied by
`npm run settings:apply` from a terminal after the user quits the client. The
panel never writes ASAR and never closes or restarts Antigravity. Live
per-conversation context/speed display is the capsule's responsibility. See
[patch controls](operations.md#panel-patch-controls).

[usage.mjs](../src/plugin/sidecars/panel/usage.mjs) combines local conversation
discovery, read-only summary data, and LS trajectory/generator/step RPCs.
File fingerprints limit rescanning; partial/error/date-coverage state accompanies
incomplete scans. Historical totals are not a complete provider billing ledger.
Changing the LS host, port, or product invalidates usage caches and retry backoff,
even when the new server belongs to the same product.

[transport.mjs](../src/plugin/sidecars/panel/transport.mjs) discovers the LS
through environment values or product logs, obtains CSRF metadata, and makes
Node HTTP(S) Connect requests. Panel monitoring does not use CDP or patch ASAR.

### Input-toolbar capsule and shared logic

[src/capsule/](../src/capsule/) adds the optional live widget near the chat
input. It uses browser fetch against the host LS origin and its
`__APP_CONFIG__.csrfToken`, not the panel's Node log-discovery transport.
`SubscribeToSidecars` discovers the matching panel endpoint for saved prices.

Shared logic and boundary contracts live in:

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

[scripts/capsule-build.mjs](../scripts/capsule-build.mjs) assembles those
modules into the self-contained `dist/capsule/input-capsule.js`; see
[build outputs](development.md#build-outputs).

AGY's own interface language (capsule and panel) is one Host-owned state shared
with embedded panel frames; [page.mjs](../src/plugin/sidecars/panel/page.mjs)
embeds the same locale modules into the panel. These product messages are separate
from client localization; see [interface languages](operations.md#interface-languages).

Capsule polling serializes requests, rereads a bounded generator tail, and
periodically reconciles from offset zero. It is not an immediate change feed or a
full rescan of all conversation history every poll.

### What the measurements mean

- Token usage and available checkpoint/capacity values come from LS metadata;
  the project does not tokenize conversation text to invent usage totals.
- Speed is calculated from LS token counts and timings. It estimates delivery,
  not engine-side decoding speed or complete agent-task throughput. Recent
  same-model rates use confirmed-complete generations.
- Cost uses local built-in aliases/rates or user overrides. It is an estimate,
  not an official price catalog or account bill.
- The composition breakdown for skills, rules, tools, and prompts is an
  item-count heuristic. Its buffer can also use a local default when absent
  from LS data. It is not a server-measured token breakdown.

These calculations live in
[metrics-core.mjs](../src/plugin/lib/metrics-core.mjs) and
[pricing-core.mjs](../src/plugin/lib/pricing-core.mjs); unavailable,
incomplete, stale, and estimated values must remain distinguishable.

## Installed-client modification points

These are separate optional operations, not prerequisites for read-only panel
usage:

| Component | Target | Modification |
| --- | --- | --- |
| Panel installation | Plugin directory | Installs project sidecar files; does not modify `app.asar` or LS |
| Capsule | `app.asar/dist/preload.js`, `dist/input-capsule.js` | Appends a preload hook containing the capsule code and retains a capsule member |
| Limit patch | Native LS executable | Replaces an admitted x86-64 clamp body and its model-ID table; macOS mutation requires separate qualification |
| Localization, when qualified | ASAR preload, reviewed adapter targets, `dist/agyctl-localization/*` | Adds Hub bootstrap, the DOM engine, native helpers, and profile-specific adapter edits. Does not rewrite the LS asset archive or intercept Hub HTTPS |

The shared [Host Composer](../src/host/compose.ts) implements ASAR
composition behind the capsule and Host command entry points. It starts from a
verified original and composes the requested/retained features together;
capsule and localization must not independently overwrite each other's archive.
It owns identity, backup/receipt handling, contribution conflicts, and the single
archive transaction, not feature-specific admission or code generation.
[Capsule](../src/capsule/host-feature.ts) and
[localization](../src/localization/host/feature.ts) provide those contributions.
Saved contributions are hash-bound, so retaining a feature does not rebuild it;
see [Host rules](operations.md#reviewed-host-changes).

The [capsule hook](../src/capsule/preload-hook.ts) embeds the capsule code
directly in the preload behind the `// [agyctl Host Capsule Feature]` marker and
runs it through `webFrame.executeJavaScript`. The capsule
[entry](../src/capsule/entry.js) resolves the Host language at mount time (after
the parsed `<html lang>` is readable) and defers UI mounting until DOM readiness.
Historical injection formats are not supported.
It does not fetch `dist/input-capsule.js` at startup. Hub and Insiders use the
same archive-relative hook in the current installer; different roots and
executable identities do not establish different injection architectures.

Capsule installation only replaces the archive; no CDP is involved anywhere.
Before replacing it the installer checks every anchor token derived from
[anchors.js](../src/capsule/anchors.js) against the web bundle that the
client's Language Server serves
([served-bundle.ts](../src/capsule/served-bundle.ts), bounded extraction that
never executes the bundle) and refuses when one is missing. Neither that check,
a successful archive replacement, nor the panel's monitoring proves that a
capsule visibly mounted.

### Localization

Localization is an optional Host feature: an offline prepare publishes a DOM
artifact into tool state, the Host contribution adds the bootstrap and reviewed
native adapter edits to the ASAR, and the runtime injects the DOM engine on the
next launch. Every profile is `probe-only`; see [localization](localization.md).

### Limit admission and recovery

The limit patcher admits PE and ELF64 x86-64 images. It reads Mach-O ARM64 as
data and reports its state as `unavailable`; macOS mutation needs its own reviewed
bytes and signing evidence. Windows/Linux ARM64 are not supported. Admission checks the original
function bytes for the detected architecture in
[versions.json](../compat/versions.json), not merely the application version.
An unlisted version with known bytes may pass. Only the Insiders Windows x64
entry records live behavioral observation. The requested limit remains subject
to the replacement's later clamps and upstream/provider restrictions. See
[limit patch](limit-patch.md).

ASAR composition and limit replacement retain original backups and hash-bound
recovery records. Staging, per-file replacement, and prepare records are not
one atomic transaction across every file/component, nor a guarantee against
arbitrary storage failure. Restoration requires matching evidence, not just a
hook marker. See [operations.md](operations.md).

## Compatibility checks and distribution

[compat/install-layout.json](../compat/install-layout.json) defines the default
stable (Hub) and Insiders install paths for Windows, macOS, and Linux. The
documented user target is the Antigravity stable app; discovery coverage is
not proof that every feature works on every OS or architecture.

The Go [checker](update-check.md) inspects installers and installed files for
screening. It parses ASAR and executable formats with its own code, but reads the
recorded original function bodies from [versions.json](../compat/versions.json),
the registry the limit patcher gates on. Static marker matches and a
`compatible` result are screening evidence, not live activation or
larger-context acceptance, and nothing consumes the verdict as an admission
gate.

Each feature gates its own writes; see
[client modifications](operations.md#client-modifications-from-the-cli). The
limit patch requires an exact byte-signature match, the capsule requires
executable and ASAR qualification plus its served-bundle anchors, and
localization requires profile or structural evidence plus bound plan inputs.
`node scripts/manage.mjs status` reports those gates read-only. Capsule and
localization form one Host mutation group, admitted and journaled together, while
the limit remains an independent operation. This project does not close, relaunch,
or supervise the client: [winproc](../src/agyctl/internal/winproc/) only inspects
processes so that applies refuse while the selected client or Language Server
runs. See [recovery boundaries](operations.md#recovery-boundaries).

The Go tool reads the compat data its command declares from the repository
checkout: [assets](../src/agyctl/internal/assets/capture.go) captures those files
once and the command decides on the captured bytes. This is not an immutable
execution snapshot or protection against concurrent privileged modification.
[tools-build.mjs](../scripts/tools-build.mjs) is a plain `go build` for the
selected target pair (the host by default).

The project runs from a Git checkout: update it with `git pull`, `npm ci`, and
`npm run plugin:install`. There is no release signing or self-updater.

[operations.md](operations.md) contains the commands and recovery workflow.
Report tests and static inspection separately from live validation.
