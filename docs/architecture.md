# Architecture and Modification Boundaries

`agyctl` adds usage visibility and optional client modifications to
Antigravity app, with both stable and development channels. The supported tool targets
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
the server used by a WSL session. Shell and web-asset identities, upstream member
paths, observed functions, and reproduction steps belong in
[the build-specific analysis](upstream-analysis.md#shell-launch-and-window-boundaries),
not in the architecture contract. Finding shell JavaScript in ASAR must not be
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

The current panel UI covers historical usage, estimated cost, pricing settings,
and the CLI commands that modify the client; it never runs them. Live
per-conversation context/speed display is the capsule's responsibility.

[usage.mjs](../src/plugin/sidecars/panel/usage.mjs) combines local conversation
discovery, read-only summary data, and LS trajectory/generator/step RPCs.
File fingerprints limit rescanning; partial/error/date-coverage state accompanies
incomplete scans. Historical totals are not a complete provider billing ledger.
Changing the LS host, port, or product invalidates usage caches and retry backoff,
even when the new server belongs to the same product.

[transport.mjs](../src/plugin/sidecars/panel/transport.mjs) discovers the LS
through environment values or product logs, obtains CSRF metadata, and makes
Node HTTP(S) Connect requests. Panel monitoring does not use CDP or patch ASAR.
Its refresh interval is configurable from 10–300 seconds (default 10); hidden
refreshes use at least 30 seconds, and a running usage scan is re-read every
2 seconds. This is not the capsule's 3/5/15-second schedule.

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

[scripts/capsule-build.mjs](../scripts/capsule-build.mjs) assembles those pure
modules and capsule fragments, in the fixed `CAPSULE_INPUTS` order and without a
bundler, into `dist/capsule/input-capsule.js`. It is a self-contained classic
script; edit sources, not the generated bundle. `npm run capsule:install` calls
the same `assembleCapsule()` in memory instead of reading that file, while the
reviewed Host `plan` command takes an explicit `--capsule-code` file.

Language is resolved before mounting: saved preference, declared Host language,
system language, then English. The canonical IDs are `en`, `zh-Hant-TW`,
`zh-Hans-CN`, and `ja-JP`; existing `zh-TW`/`zh-CN` preferences are normalized.
The Host controller decorates only identified agyctl sidecar root frames with a
locale snapshot, parent origin, and per-frame nonce. Before revealing an embedded
panel, READY/STATE/ACK messages reconcile its snapshot with the current Host state.
Messages bind the exact frame, current URL, origin, and nonce. Only the Host saves
embedded selections; a panel without Host wiring owns its preference independently.
This bootstrap never waits for LS or saved-price discovery. UI disposal does not
discard the Host language controller; reinjection subscribes the replacement UI.

[page.mjs](../src/plugin/sidecars/panel/page.mjs) embeds the same locale modules
into the panel page before its first render. The browser receives only product
messages, not vendor dictionaries. The Capsule build checks required message keys,
parameter arity, and the explicit Japanese vendor mappings in
[locale-validation.mjs](../src/plugin/lib/locale-validation.mjs). Additional AGY
messages are authored translations. These product messages are separate from the
client-localization catalogs described in [localization](localization.md).

Capsule polling normally uses 3 seconds with the popover open, 5 seconds in the
background, and 15 seconds when hidden. It serializes polls, refreshes executor
metadata on a 120-second schedule, rereads a bounded generator tail, and
periodically reconciles from offset zero after 10 minutes. This is not an
immediate change feed or a full rescan of all conversation history every poll.

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
| Localization, when qualified | ASAR preload, reviewed adapter targets, `dist/agyctl-localization/*` | Adds a confirmation bridge, host delivery engine, and profile-specific adapter edits; does not rewrite the LS asset archive |

The shared [Host Composer](../src/host/compose.ts) implements ASAR
composition behind the capsule and Host command entry points. It starts from a
verified original and composes the requested/retained features together;
capsule and localization must not independently overwrite each other's archive.
It owns identity, backup/receipt handling, contribution conflicts, and the single
archive transaction, not feature-specific admission or code generation.
[Capsule](../src/capsule/host-feature.ts) and
[localization](../src/localization/host/feature.ts) provide those contributions.
Saved contributions are bound by the receipt's `inputsHash`, so retaining a
feature does not load or rebuild its current implementation.
The composed preload also records that hash in its managed comment. An
evidence-only input revision therefore gets a distinct archive hash and immutable
receipt without changing feature payloads or replacing earlier records. A reviewed
plan whose complete inputs are already installed is reported as `current`.

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

Localization is an optional Host feature with three separate contracts: an
offline transform that publishes a hash-bound artifact into tool state, a Host
contribution that adds a delivery engine, a confirmation bridge, and reviewed
adapter edits to the ASAR, and a runtime coordinator that serves the prepared
`/main.js` and native-interface messages on the next launch. Selecting an artifact
writes only tool state; it does not install the Host feature or prove activation.

Every recorded profile in
[profiles.json](../compat/localization/profiles.json) is `probe-only`. The
stages, their gates, the recorded profiles, and the one partial real-client pass
are described in [localization](localization.md).

### Limit admission and recovery

The limit patcher admits PE and ELF64 x86-64 images. It reads Mach-O ARM64 as
data and reports its state as `unavailable`; macOS mutation needs its own reviewed
bytes and signing evidence. Windows/Linux ARM64 are not supported. Admission checks the original
function bytes for the detected architecture in
[versions.json](../compat/versions.json), not merely the application version.
An unlisted version with known bytes may pass. Only the Insiders Windows x64
entry records live behavioral observation. The requested limit remains subject
to the replacement's later clamps and upstream/provider restrictions. See
[the evidence limits](context-chain-analysis.md#conclusions-that-the-evidence-does-not-support).

ASAR composition and limit replacement retain original backups and hash-bound
recovery records. Staging, per-file replacement, and prepare records are not
one atomic transaction across every file/component, nor a guarantee against
arbitrary storage failure. Restoration requires matching evidence, not just a
hook marker. See [operations.md](operations.md).

## Compatibility checks and distribution

[compat/install-layout.json](../compat/install-layout.json) defines Hub/Insiders
paths for Windows, macOS, and Linux. Discovery coverage is not proof that every
feature works on every OS or architecture.

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
`npm run plugin:install`. There is no release signing or self-updater. The Python
reference implementation has been removed. Product code is JS/TS and Go; Python
is limited to small scripts and isolated developer-tool launchers.

[operations.md](operations.md) contains the commands and recovery workflow.
Report tests and static inspection separately from live validation.
