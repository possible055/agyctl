# Client Localization

`agyctl` can translate the Antigravity interface by composing a localization
feature into `app.asar` and injecting a Hub DOM engine plus native-interface
helpers at runtime. Translated `prepare` publishes `index.json` and optional
`native.json`; it does not rewrite the Language Server `main.js`. Leftover AST
packs remain readable until they are migrated. This page covers the stages, the
recorded profiles, and the offline developer workflow. For the Host apply
commands, see [operations](operations.md#localization-preparation-and-apply).

The panel and capsule language selector is a separate feature: it changes AGY's
own messages and never translates Antigravity. See
[interface languages](operations.md#interface-languages).

## Current status

The development and acceptance target is Windows x86-64 Antigravity 2.31.0, in
`zh-Hant-TW`, `zh-Hans-CN`, and `ja-JP`. Isolated Electron contracts use the
production CLI's DOM/native catalog preparation; they do not establish
complete real-client UI or performance acceptance. Real 2.31.0 checks have
identified and driven fixes for Hub scopes, protected names, delayed activation,
native Zoom, repeated subtree scans, and navigation/reload. Full three-language
acceptance remains separate from isolated contracts; no profile is promoted by
these checks. The older partial Insiders AST pass is historical evidence only.

Every profile in [profiles.json](../compat/localization/profiles.json) is
`probe-only`. A `probe-only` profile may enter installation preflight with an
`UNTESTED_BUILD` warning; it is not a claim of verification. Read the current
registry instead of treating a list in this guide as an allowlist:

```bash
node -e "for(const p of require('./compat/localization/profiles.json').profiles)console.log(p.profileId,p.platform,p.status)"
```

### Recorded 2.31.0 live checks

Recorded on 2026-11-14, Windows x86-64, installed Antigravity 2.31.0
(Electron 44.9.1). All three locales used engine SHA-256
`e46e3d80827e8729db05bd608288a9cebb8a9e44b6358ac06e5d2ee95fc06963`.
These observations do not promote the probe-only profile or complete M7.

The live quit confirmation and workspace folder picker were exercised in all
three locales. The actual Ctrl+Q handler opened the native confirmation;
Windows UI Automation and native button inspection verified the translated
title, instruction, detail, Cancel/Quit order, and default Quit command link.
Cancelling kept the client running. The visible Add context > Folder action
opened the native picker, titled `開啟工作區`, `打开工作区`, or
`ワークスペースを開く`. Cancelling selected no folder and preserved the input,
project, and existing conversation paths. Native integration is owned by
[native-adapters.ts](../src/localization/host/native-adapters.ts) and
[native.ts](../src/localization/runtime/native.ts); this pass does not cover
every dialog supported by those adapters.

Each locale had a ten-minute repeated-operation run: five minutes with
the DOM engine active, followed by five minutes after `dispose()` restored its
writes. Each phase used thirty ten-second rounds, each containing five settings
open/close cycles, one model-menu cycle, and one literal input insert/clear.
No messages were sent. Across the locales this exercised 900 settings cycles.
The off phase retained the Host/native installation, so it was not a pristine
client control. A full GC preceded each minute's heap/DOM checkpoint. Settings
timings ran from the click through two animation frames, not startup TTI.

| Locale | Settings median, on/off (ms) | Settings p95, on/off (ms) | GC heap, on phase (MiB) | GC heap, off phase (MiB) |
| --- | --- | --- | --- | --- |
| `zh-Hant-TW` | 90.4 / 89.9 | 113.5 / 119.4 | 43.25 → 53.60 | 53.55 → 58.87 |
| `zh-Hans-CN` | 92.3 / 91.3 | 114.7 / 119.2 | 41.30 → 53.94 | 53.90 → 59.81 |
| `ja-JP` | 49.7 / 46.2 | 58.9 / 53.3 | 41.79 → 54.24 | 54.19 → 60.21 |

Every checkpoint had zero queued work and errors; connected owned writes
remained 31 when active and zero after disposal. Long-task counts were
167/155, 174/155, and 1/0 for on/off respectively. These were ordered,
non-randomized background automation runs with differing system load; do not
compare locales as a performance ranking or infer foreground input latency.
The first Traditional Chinese attempt used an insufficient modal-close wait;
the completed run used a bounded wait for actual removal. Some idle intervals
included legitimate delayed upstream DOM additions; they are not evidence that
every interval was mutation-free.

Memory growth remains unresolved, not passed. Supplemental retained-allocation
sampling used a 16 KiB interval and full GC, with the engine script identity
obtained from its actual function location. After forty settings cycles, live
sampled bytes were 5,770,420, of which 18,944 had engine allocation ancestry;
after disposal, another forty cycles retained 4,053,768 sampled bytes with no
engine ancestry. Five hundred read-only evaluations added 92 bytes or zero to
the respective GC heap. Allocation sites are not retaining paths and cannot
prove absence of a leak. A separate verified pristine client, without Host,
Capsule, or localization, also grew from 43,666,504 to 52,967,964 GC heap bytes
over five minutes and 150 settings cycles. This settings-only control is not
the full workload above; it establishes upstream growth, not its long-term
bound or the translation engine's exact incremental cost. Do not weaken the
acceptance condition or patch upstream internals to turn this into a pass.

The tray's actual visible menu passed in all three locales after the user
unlocked the desktop. Earlier, foreground window zero and `OpenInputDesktop`
access denied (error 5) prevented display; no input-desktop switch was attempted.
The resumed pass right-clicked the actual, uniquely identified Antigravity icon
in Explorer's overflow popup. The provider exposed its rectangle but no
clickable point, so the inspected rectangle center was used with Explorer
process, bounds, and hit-target guards. Windows UI Automation verified the
visible zero-agent, Open Antigravity, and Quit labels; Escape dismissed the
actual menu without invoking an action. This client's popup had class
`Chrome_WidgetWin_1` with an empty title, rather than the initially anticipated
`Chrome_WidgetWin_2`; the inspection helper was corrected, not the product.
WSL submenus, nonzero agent counts, and tray action execution were not tested.
Conditional
updater, WSL/provisioning, device, and passkey dialogs were not forced: those
paths require additional installation, account, or device state. Other unrun
cases, including the download-folder picker, remain gaps rather than implied
passes. Full startup/foreground latency, longer-term memory bounds, and the
remaining conversation/terminal/diff operations are also incomplete.

The temporary installation was removed after the checks. ASAR, paired EXE,
Language Server, and unpacked hashes matched the originals; Host status was
pristine with no receipt or features, and limit status was original/not-applied.
No client or Language Server remained running. Own plugin registrations/data
were removed, while unrelated configuration, Swarm, and original backups were
preserved. Recovery remains documented in
[operations](operations.md#localization-preparation-and-apply).

Messages are defined once in
[source.json](../src/localization/catalogs/source.json); the `zh-Hant-TW`,
`zh-Hans-CN`, and `ja-JP` catalogs translate them. Translated `prepare` builds a
DOM index from those catalogs; unresolved same-English conflicts refuse the pack.
Probe and `--format=ast` still use
[usage-points.json](../compat/localization/usage-points.json) and the Acorn
transform. `validateTranslations` in
[transform.ts](../src/localization/build/transform.ts) refuses a translation
without a source message, an empty or unreviewed translation, changed ICU
arguments, and a missing translation for a `critical` message. The developer
AST path may omit non-critical messages; production DOM preparation additionally
requires a reviewed translation for every admitted DOM and native message
([dom-artifact.ts](../src/localization/build/dom-artifact.ts)).

Rule and message counts change with translation work; read them from the data
files:

```bash
node -e "const u=require('./compat/localization/usage-points.json');for(const[k,v]of Object.entries(u.profiles))console.log(k,(v.rules??[]).length,(v.fallbackRules??[]).length)"
node -e "for(const l of['source','zh-Hant-TW','zh-Hans-CN','ja-JP'])console.log(l,Object.keys(require('./src/localization/catalogs/'+l+'.json').messages).length)"
```

The internal provenance label `official-profile` is not Google endorsement, and
the project-added Hub bootstrap is not an upstream localization API.

## Flow and qualification

| Stage | Flow and boundary | Implementation |
| --- | --- | --- |
| Source admission | ZIP structure, CRC, strict UTF-8, and per-asset sizes/hashes gate a selected profile. The whole-LS identity is evidence, not a gate, so a limit patch outside the assets does not invalidate them | [assets.ts](../src/localization/build/assets.ts) |
| Offline prepare | Translated locales build a DOM index (`exact` plus `{0}` templates) and optional native catalog. Probe and `--format=ast` run the Acorn transform with exact hit counts | [dom-index.ts](../src/localization/build/dom-index.ts), [transform.ts](../src/localization/build/transform.ts) |
| Usage-point inventory | Classifies every string literal of the observed `main.js`, lists NLS defaults, and matches vendor keys; see [below](#usage-point-inventory) | [inventory.ts](../src/localization/build/inventory.ts) |
| Artifact publication | DOM packs publish `manifest.json`, `index.json`, and `native.json` under a content-addressed tool-state directory; AST packs also publish rewritten `main.js`. Conflicting contents are rejected | [cli.ts](../src/localization/cli.ts), [artifact.ts](../src/localization/artifact.ts) |
| Selection | `select` writes a per-installation selection record; `status` reports it with the last-known runtime snapshot. Neither installs the Host bridge | [cli.ts](../src/localization/cli.ts) |
| Host composition | A reviewed plan binds target, payloads, and observed source. Requires an existing profile; probe-only status and identity drift warn. Executable/fuse qualification and unique adapter anchors gate writes | [feature.ts](../src/localization/host/feature.ts), [compose.ts](../src/host/compose.ts) |
| Runtime delivery | A unique `win.loadURL` anchor in `dist/utils.js` calls `loadLocalizedURL`. The archive pins only the state root and installation id (`runtime-config.json` schemaVersion 2); each launch verifies the selection and artifact, so re-selection applies on the next launch without re-patching. Events persist to JSONL plus `runtime-status.json` | [host.ts](../src/localization/runtime/host.ts), [startup.ts](../src/localization/runtime/startup.ts) |
| Hub bootstrap | Preload invokes `agyctl:localization:bootstrap` once per document, with bounded retries while the document is not ready; Host authorizes the current Hub main frame, its exact registered `https://127.0.0.1[:port]` origin, and the reviewed 2.31.0 manager paths/query keys, checks engine bytes against `engineSha256`, and injects `dom-engine.js` plus `index.json`. English and AST selections skip injection | [preload.ts](../src/localization/runtime/preload.ts), [hub.ts](../src/localization/runtime/hub.ts), [engine.ts](../src/localization/runtime/engine.ts) |
| Native interface | `native.json` (bound by `manifest.nativeCatalogSha256`) feeds reviewed main-process edits; see [below](#native-interface) | [native-adapters.ts](../src/localization/host/native-adapters.ts), [native.ts](../src/localization/runtime/native.ts) |

Selection alone does not inject the DOM engine or prove activation. Missing
profiles and failed asset or structural checks refuse the feature; ASAR or
executable hash drift emits `IDENTITY_DRIFT` instead. Receipts retain
`features.localization.profileStatus`.

### Trust boundary and known limits

- The tool state root is the trust boundary. Hashes there detect corruption and
  mix-ups; they do not defend against another process running as the same user.
- Host localization does not intercept HTTPS. Leftover AST packs remain
  readable for migration but are not served through the Host engine.
- The DOM engine translates text and limited attributes inside writable Hub
  scopes. Native messages use `native.json`. Unreviewed strings stay in the
  source language.
- Project-name spans, customization names/descriptions, document bodies, and
  non-category mention labels are content, including when their text equals a
  catalog message. Mixed mention rows without a distinct built-in-action marker
  keep their labels unchanged; category rows and fixed controls remain writable.
  The 2.31.0 boundaries are centralized in
  [scopes.ts](../src/localization/runtime/scopes.ts).
- Complete document navigation clears the last bootstrap binding and health; a
  fresh authorized bootstrap is required before another `active` result. SPA
  same-document navigation does not install a second engine. Navigating to an
  unreviewed document records `degraded` health with `SOURCE_MISMATCH`.

## Offline inspection and preparation

This developer workflow reads assets from a Language Server binary and writes
only artifacts under the tool's private state root. It does not install
localization or change the client. Run `npm ci` first if needed, and set
`$binary` to the target's absolute `resources/bin/language_server.exe`:

```powershell
npm run localization -- inspect --ls "$binary" --json
```

Inspect `profileId`, `profileStatus`, `installationQualified`, `sources`, and
`usagePoints`. A matching asset set can qualify a `probe-only` profile for
preflight while retaining the untested warning; an unknown source stays
unqualified. `prepare --profile PROFILE_ID` additionally requires that
profile's exact asset sizes and hashes. Extraction locates the embedded archive across the whole
binary, validates its directory and ranges, and never executes the binary.
`--sample-dir DIR` (containing `index.html` and `main.js`) is an explicit
alternate input, not a fallback. Source:
[assets.ts](../src/localization/build/assets.ts) and
[cli.ts](../src/localization/cli.ts).

English without `--probe` is an explicit disable and refuses `prepare`. To
prepare and validate, build once and call Node directly so npm output stays out
of the parsed JSON:

```powershell
npm run localization:build
$prepared = node scripts/localization.mjs prepare --ls "$binary" --locale zh-Hant-TW --json | ConvertFrom-Json
node scripts/localization.mjs validate --artifact-dir "$($prepared.directory)" --json
```

Translated `prepare` publishes a DOM artifact (`manifest.json`, `index.json`,
and `native.json` when native messages exist). `--probe` (English identity) and
`--format=ast` publish rewritten `main.js`, `manifest.json`, `coverage.json`,
`inventory.json`, `rules.json`, and `native.json`; AST `prepare` checks exact
usage-point hit counts. The staged directory must pass validation before it is
published. `validate` checks artifact hashes and, for AST packs, JavaScript
parseability. Neither result promotes a profile or proves activation.

### Usage-point inventory

`npm run localization -- inventory --ls ABS_LS_PATH [--out PATH]` builds the
usage-point inventory for the observed web bundle: every string literal with its
display context (command `label`, `aria-label`, `title`, `placeholder`, React
`createElement` children, other), the NLS helper defaults, and the vendor
dictionary matches per locale with their disposition (available, conflict, empty,
identical, missing). Every recorded usage point carries its byte and UTF-16
range, context, and a per-point review disposition;
[reviews.json](../compat/localization/reviews.json) binds
`adopt`/`exclude`/`unresolved` decisions to the observed source digest. The full
report is written once under the tool state
(`localization/inventory/<sourceIdentity>.json`); the summary on stdout counts the
literals that match no vendor key instead of dropping them.

Rules cover the kinds `nls-default-string`, `literal`, `element-child`,
`template-literal`, and `element-message`. Template-literal and `createElement`
usage points are rebuilt against a self-contained ICU formatter that `prepare`
injects into the artifact, and `native.json` carries build-time-precompiled ICU
ASTs for native display.

### Generated usage rules

`npm run localization -- rules:generate --ls ABS_LS_PATH [--profile ID]` derives
digest-bound rules mechanically from the observed `main.js` and stores them as
`generatedRules` on the matched profile in
[usage-points.json](../compat/localization/usage-points.json). A usage point is
adopted only when its text (literal and `createElement` child positions), its
NLS `upstreamKey` + default pair, or its template/`elementMessage` ICU skeleton
resolves to exactly one catalog message — or to several messages whose
translations are identical in every shipped locale. Points inside an adopted
`elementMessage` span stay owned by the sentence rule, matching the transform's
exclusion. Every rule still carries `sourceSha256` and per-range `expectedHits`,
so drift fails the transform exactly like reviewed rules. Ambiguous points
(distinct translations for the same source text) and unmatched points are never
guessed: they are counted in the command report and listed, capped, in a
worklist under tool state (`localization/rules/<sourceIdentity>.json`) for
human review. Reviewed `rules` always take precedence over `generatedRules`,
which take precedence over `fallbackRules`.

Generation is adoption, not review: a mechanically matched messageId can pick a
plausible-but-not-reviewed translation for ambiguous surface text, so generated
coverage is a superset of fallback coverage but remains `probe-only` evidence
until a real-client pass and spot review.

### Native interface

Native texts ship as `native.json` and are applied at display time by
host-engine helpers called from reviewed structural edits
([native-adapters.ts](../src/localization/host/native-adapters.ts),
`buildReviewedNativeEdits`). Each edit's anchor must be unique, and every
transformed member is re-parsed before composition. Covered surfaces: the
quit-confirmation dialog, tray items (agents label, Open, New Window, Quit), the
application menu (by stable `role`, so translated labels never determine action
identity), File/Help items (New Window, Docs, WSL connect/reopen), the updater item
and its state machine (keyed by update step), startup and WSL error dialogs, the
provisioning splash, WebAuthn and device-chooser dialogs, workspace dialogs, the
IDE-install wizard HTML (HTML-context escaping), and the embedded-browser
security popup and its edit menu. Message boxes keep their `defaultId`/`cancelId` semantics.
Helpers fall back to the original text; a failed native verification clears the
catalog with a diagnostic. Messages are listed in
[native-messages.json](../compat/localization/native-messages.json).

### Selection and status

`npm run localization -- select --artifact ID --installation ABS_ASAR_PATH`
records a selection for a discovered installed target and writes only tool
state. `--artifact` takes the 64-hex artifact ID printed by `prepare`, and the
artifact must pass validation. `--installation` must resolve to a discovered
`app.asar` path; Windows comparison ignores case, while POSIX comparison remains
case-sensitive. The installation ID is the SHA-256 of the discovered path, and `--installation-id ID` passes it directly
instead. A patched installation whose runtime config binds the selection
(`schemaVersion` 2) picks up the newly selected artifact and locale on the next
client launch without recomposing the archive; other runtime-config schemas are
rejected.

`npm run localization -- status --installation ABS_ASAR_PATH` reads that
selection and reports `lastKnownRuntime`: the most recent `runtime-status.json`
snapshot the Host process persisted (run id, artifact, locale, health, terminal
failure). It is last-known evidence, never a live claim, and is absent until a
bound runtime has run. A snapshot for a different installation is omitted with
an explicit diagnostic. Both `select` and `status` reject ambiguous discovery when
more than one installation exists, so pass the explicit `app.asar` path.

`node scripts/manage.mjs status --asar ABS_ASAR_PATH` reports the same evidence
for one installation: `selected` (the selection record), `coverage`
(replaced-message totals plus the explicit `untranslated`/`unapplied` message ids
of the selected artifact), and `lastKnownRuntime`. `installed` means only that
the Host composition is applied; it does not claim that the Hub bootstrap
ever ran.

The offline CLI rejects unknown, repeated, or command-inappropriate arguments;
`--ls` and `--sample-dir` cannot be combined. It does not accept `--asar`.
For a custom installation outside the discovery paths, use the management
[prepare/apply/status workflow](operations.md#localization-preparation-and-apply)
with an explicit absolute `--asar` instead.
