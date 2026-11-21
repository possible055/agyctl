# Client Localization

`agyctl` can translate the Antigravity interface by composing a localization feature
into `app.asar` and injecting a Hub DOM engine plus native-interface helpers at
runtime. A translated `prepare` publishes `index.json` and an optional
`native.json`; it does not rewrite the Language Server `main.js`. Leftover AST packs
remain readable until they are migrated.

This page covers the current status, the stages, the offline developer workflow,
and the selection commands. The Host apply commands are in
[operations](operations.md#localization-preparation-and-apply).

The panel and capsule language selector is a separate feature: it changes AGY's own
messages and never translates Antigravity. See
[interface languages](operations.md#interface-languages).

## Current status

The current development target is Windows x86-64 Antigravity 2.34.0
(profile `hub-win-x64-2.34.0-8934adef`) in `zh-Hant-TW`, `zh-Hans-CN`, and `ja-JP`.
Earlier profiles remain in the registry.

Every profile in [profiles.json](../compat/localization/profiles.json) is
`probe-only`. A `probe-only` profile can enter installation preflight with an
`UNTESTED_BUILD` warning; that is not a claim of verification, and no profile has
complete real-client acceptance. Read the registry rather than a list in this page:

```bash
node -e "for(const p of require('./compat/localization/profiles.json').profiles)console.log(p.profileId,p.platform,p.status)"
```

### Verification status

- **Automated:** isolated Electron contracts exercise production DOM and native
  preparation (`npm run test:electron`; see [development](development.md#checks)).
  They are not full client acceptance.
- **Offline, recorded 2026-11-21 on Windows 2.34.0:** all three locales prepared
  and validated from the installed LS; adapter v4 admitted 266 edits across 19
  ASAR members. At this offline checkpoint, no localization was installed or
  selected. The developer AST path has no reviewed usage rules for this source.
- **Live, partial, recorded 2026-11-21 on Windows 2.34.0:** the reviewed Host
  transaction installed Traditional Chinese localization with Capsule on the
  exact `8934adef...` original ASAR. The first launch reported `SOURCE_MISMATCH`:
  the Hub URL carried a new `#t=<bootstrapToken>` fragment. In that original
  archive, `dist/authBootstrap.js` (SHA-256
  `3ea67da411bae7dbf19214055c815c4765d3c902e04e7e01dfa66098af56be1d`)
  implements `withBootstrapTokenFragment`, and `dist/utils.js` calls it in
  `loadHubWindowUrl`. The observed fragment was exactly `t=` plus 32 lowercase
  hex characters. The runtime now admits only that form while retaining the
  reviewed origin, path and search checks; failed navigation no longer logs the
  token-bearing URL. After rebuilding and reapplying, the runtime reported
  `healthState: active` with no terminal error, and the live window showed
  Traditional Chinese Hub navigation, greeting and menu labels. Selecting new
  artifacts and restarting separately yielded `active` with no terminal error
  for Simplified Chinese and Japanese; both windows showed translated Hub
  navigation, greeting and menu labels while project and conversation names
  remained content. Removing localization kept Capsule installed; a separate
  Capsule removal restored the exact original ASAR SHA-256 above, with its
  verified original backup retained. Visible input-toolbar Capsule mounting and
  SSH/MCP authentication or takeover flows were not exercised. The profile
  therefore remains `probe-only`.
- **Live and isolated, partial, recorded 2026-11-21 on Windows 2.34.0:** after a
  new reviewed Host apply of Traditional Chinese localization plus Capsule, the
  runtime again reported `active` with no terminal error. In the installed Hub,
  `#agyctl-input-capsule` and `#agyctl-titlebar-btn` had visible layout boxes;
  opening the titlebar button displayed `#agyctl-titlebar-popover`, and hovering
  over the input Capsule displayed `#agyctl-input-tooltip`. No subagent composer
  was active, so its Capsule mount was not tested. Isolated Electron 44.10.2 DOM
  runs using the actual 2.34.0 prepared artifacts passed 58 checks per locale in
  all three locales, including SSH/MCP fixed controls and protection of dynamic
  hosts, paths, server names, and raw errors. These fixtures did not establish a
  real SSH connection, authentication or takeover, or a working MCP request.
  The Host features were removed afterward and the original ASAR hash restored;
  the profile remains `probe-only`.
- **Offline, recorded 2026-11-18 on Windows 2.33.0:** all three locales prepared
  and validated from an immutable original LS copy, with no DOM-index conflicts.
  Native adapter v4 admitted 266 unique edits across 19 members and re-parsed every
  transformed member. Exact profile selection and Host structural qualification
  passed against the paired original ASAR and executable; the profile remained
  `probe-only`. Isolated Electron 44.10.2 fixtures passed in all three locales,
  including the new SSH sign-in subtitle and opaque-host collision checks. These
  checks did not install, select, or start localization in the 2.33.0 client.
- **Live, partial, recorded 2026-11-18 on Windows 2.33.0:** reviewed Host and panel
  draft workflows installed localization alongside the capsule. After separate
  restarts, Traditional Chinese, Simplified Chinese and Japanese Hub navigation,
  sidebar labels and greeting text appeared, while conversation titles and test
  content stayed unchanged. The capsule mounted in each locale. Removing
  localization preserved the capsule; removing the capsule then restored the
  original ASAR SHA-256 from the profile. SSH authentication, shared-home takeover,
  restart dialogs and all MCP states were not exercised in the installed client;
  the profile remains `probe-only`. The isolated fixtures above are separate
  evidence, not substitutes for those live paths.
- **Offline, recorded 2026-11-16 on Windows 2.32.1:** all three locales prepared
  and validated against the installed original LS without conflicts; native
  adapter anchors were unique and all transformed members parsed. Three-locale
  Electron DOM fixtures cover SSH/MCP controls and content-string collisions.
- **Live, partial, recorded 2026-11-16 on Windows 2.32.1:** for each locale,
  reviewed Host transactions installed the localization alongside the capsule, and
  after a restart the SSH config-file picker title and the native invalid-host
  error were translated; the Hub DOM engine and capsule were present. No SSH
  connection was made, so successful remote connections, authentication dialogs,
  and every MCP error state are not qualified.
- **Manual, recorded 2026-11-14 on Windows x86-64 Antigravity 2.31.0:** translated
  quit confirmation, workspace picker, and zero-agent tray menus in all three
  locales.
- **Unverified:** broader UI coverage, startup and foreground performance, and the
  engine's incremental memory cost. No profile is promoted by these observations.

### Catalogs and validation

Messages are defined once in
[source.json](../src/localization/catalogs/source.json); the `zh-Hant-TW`,
`zh-Hans-CN`, and `ja-JP` catalogs translate them. Translated `prepare` builds a DOM
index from those catalogs and refuses the pack on unresolved same-English
conflicts. Probe and `--format=ast` still use
[usage-points.json](../compat/localization/usage-points.json) and the Acorn
transform.

`validateTranslations` in [transform.ts](../src/localization/build/transform.ts)
refuses a translation without a source message, an empty or unreviewed translation,
changed ICU arguments, and a missing translation for a `critical` message. The
developer AST path may omit non-critical messages, while production DOM preparation
also requires a reviewed translation for every admitted DOM and native message.

Rule and message counts change with translation work; read them from the data:

```bash
node -e "const u=require('./compat/localization/usage-points.json');for(const[k,v]of Object.entries(u.profiles))console.log(k,(v.rules??[]).length,(v.fallbackRules??[]).length)"
node -e "for(const l of['source','zh-Hant-TW','zh-Hans-CN','ja-JP'])console.log(l,Object.keys(require('./src/localization/catalogs/'+l+'.json').messages).length)"
```

The internal provenance label `official-profile` is not a Google endorsement, and
the project-added Hub bootstrap is not an upstream localization API.

## Flow and qualification

| Stage | Flow and boundary | Implementation |
| --- | --- | --- |
| Source admission | ZIP structure, CRC, strict UTF-8, and per-asset sizes/hashes gate a selected profile. The whole-LS identity is evidence, not a gate, so a limit patch outside the assets does not invalidate them | [assets.ts](../src/localization/build/assets.ts) |
| Offline prepare | Translated locales build a DOM index (`exact` plus `{0}` templates) and an optional native catalog. Probe and `--format=ast` run the Acorn transform with exact hit counts | [dom-index.ts](../src/localization/build/dom-index.ts), [transform.ts](../src/localization/build/transform.ts) |
| Usage-point inventory | Classifies every string literal of the observed `main.js`, lists NLS defaults, and matches vendor keys; see [below](#usage-point-inventory) | [inventory.ts](../src/localization/build/inventory.ts) |
| Artifact publication | DOM packs publish `manifest.json`, `index.json`, and an optional `native.json` under a content-addressed tool-state directory; AST packs also publish `main.js`. Conflicting contents are rejected | [cli.ts](../src/localization/cli.ts), [artifact.ts](../src/localization/artifact.ts) |
| Selection | `select` writes a per-installation selection record; `status` reports it with the last-known runtime snapshot. Neither installs the Host bridge | [cli.ts](../src/localization/cli.ts) |
| Host composition | A reviewed plan binds target, payloads, and observed source. It requires an existing profile; probe-only status and identity drift warn. Executable/fuse qualification and unique adapter anchors gate writes | [feature.ts](../src/localization/host/feature.ts), [compose.ts](../src/host/compose.ts) |
| Runtime delivery | A unique `win.loadURL` anchor in `dist/utils.js` calls `loadLocalizedURL`. The archive pins only the state root and installation id (`runtime-config.json` schemaVersion 2); each launch verifies the selection and artifact, so re-selection applies on the next launch without re-patching. Events persist to JSONL plus `runtime-status.json` | [host.ts](../src/localization/runtime/host.ts), [startup.ts](../src/localization/runtime/startup.ts) |
| Hub bootstrap | The preload invokes `agyctl:localization:bootstrap` once per document, with bounded retries while the document is not ready. The Host authorizes the current Hub main frame, its exact registered `https://127.0.0.1[:port]` origin, and the reviewed 2.31.0 manager paths/query keys (reused by the 2.32.1 profile), checks engine bytes against `engineSha256`, and injects `dom-engine.js` plus `index.json`. English and AST selections skip injection | [preload.ts](../src/localization/runtime/preload.ts), [hub.ts](../src/localization/runtime/hub.ts), [engine.ts](../src/localization/runtime/engine.ts) |
| Native interface | `native.json` (bound by `manifest.nativeCatalogSha256`) feeds reviewed main-process edits; see [below](#native-interface) | [native-adapters.ts](../src/localization/host/native-adapters.ts), [native.ts](../src/localization/runtime/native.ts) |

Selection alone does not inject the DOM engine or prove activation. A missing
profile or a failed asset or structural check refuses the feature; ASAR or
executable hash drift emits `IDENTITY_DRIFT` instead. Receipts retain
`features.localization.profileStatus`.

For installed sources, Host preparation and the localization CLI read the selected
ASAR's `package.json.version` and select an exact version/platform profile before
structural or asset admission. This also applies to explicit `--ls` paths paired
with a custom installation's `app.asar`. Unknown versions refuse; there is no
nearest-version choice. The developer `--profile` override and independent offline
sample inspection remain available, without bypassing their own asset/structural
checks. See [profile resolution](../src/localization/host/feature.ts) and
[CLI source selection](../src/localization/cli.ts).

On 2.32.1 and 2.33.0 the Language Server may already carry limit, tool-output, or compaction
patches. The profile's `nativeImageBinding` lets preparation start from the
[native coordinator's](operations.md#native-feature-composition) verified original
and compare every localization asset, archive identity, and NLS helper with the
installed managed image, so an artifact is reused while those assets are unchanged.
Reviewed Host plans still bind the current native SHA, original SHA, generation, and
recipe-assets fingerprint; any change after review requires preparing again, and old
plans must not be replayed. Legacy profiles keep their whole-LS source binding. See
[management](../scripts/lib/management.mjs) and
[revision binding](../scripts/lib/native-binding.mjs).

### Trust boundary and known limits

- The tool state root is the trust boundary. Hashes there detect corruption and
  mix-ups; they do not defend against another process running as the same user.
- Host localization does not intercept HTTPS. Leftover AST packs stay readable for
  migration but are not served through the Host engine.
- The DOM engine translates text and a limited set of attributes inside writable
  Hub scopes. Native messages come from `native.json`. Unreviewed strings stay in
  the source language.
- Project-name spans, customization names and descriptions, document bodies, and
  non-category mention labels are content, even when their text equals a catalog
  message. Non-category mention rows keep their labels, descriptions, and trailing
  labels; category rows and fixed controls remain writable. The 2.31.0 boundaries
  are centralized in [scopes.ts](../src/localization/runtime/scopes.ts).
- The 2.33.0 SSH sign-in subtitle admits only its reviewed sentence template inside
  `[data-testid="ssh-sign-in-subtitle"]`. Its host-label capture is opaque; the
  same sentence outside that scope is not translated by this template.
- A full document navigation clears the last bootstrap binding and health, so a
  fresh authorized bootstrap is required before another `active` result. SPA
  same-document navigation does not install a second engine. Navigating to an
  unreviewed document records `degraded` health with `SOURCE_MISMATCH`.

## Offline inspection and preparation

This developer workflow reads assets from a Language Server binary without
installing localization or changing the client. `prepare` publishes artifacts under
the tool-state root; inventory can write to `--out`, and rule generation changes a
tracked repository file as described below. Run `npm ci` first if needed, and set
`$binary` to the target's absolute `resources/bin/language_server.exe` path:

```powershell
npm run localization -- inspect --ls "$binary" --json
```

Inspect `selectedProfileId`, `profileStatus`, `installationQualified`, `sources`,
and `capabilities.usagePoints`. A matching asset set can qualify a `probe-only`
profile for preflight with the untested warning, and an unknown source stays unqualified.
`prepare --profile PROFILE_ID` additionally requires that profile's exact asset
sizes and hashes. Extraction locates the embedded archive across the whole binary,
validates its directory and ranges, and never executes the binary. `--sample-dir
DIR` (containing `index.html` and `main.js`) is an explicit alternate input, not a
fallback.

English without `--probe` is an explicit disable and refuses `prepare`. To prepare
and validate, build once and call Node directly so npm output stays out of the
parsed JSON:

```powershell
npm run localization:build
$prepared = node scripts/localization.mjs prepare --ls "$binary" --locale zh-Hant-TW --json | ConvertFrom-Json
node scripts/localization.mjs validate --artifact-dir "$($prepared.directory)" --json
```

A translated `prepare` publishes a DOM artifact (`manifest.json`, `index.json`, and
`native.json` when native messages exist). `--probe` (English identity) and
`--format=ast` publish `main.js`, `manifest.json`, `coverage.json`,
`inventory.json`, and `rules.json`. Translated AST packs may also include
`native.json`; probe packs omit it. AST `prepare` checks exact usage-point hit
counts. The staged directory must pass validation before publication. `validate`
checks artifact hashes and, for AST packs, JavaScript
parseability. Neither command promotes a profile or proves activation.

The offline CLI rejects unknown, repeated, or command-inappropriate arguments, and
`--ls` and `--sample-dir` cannot be combined. It does not accept `--asar`; for a
custom installation outside the discovery paths, use the management
[prepare/apply/status workflow](operations.md#localization-preparation-and-apply)
with an explicit absolute `--asar`.

### Usage-point inventory

`npm run localization -- inventory --ls ABS_LS_PATH [--out PATH]` builds the
usage-point inventory for the observed web bundle: every string literal with its
display context (command `label`, `aria-label`, `title`, `placeholder`, React
`createElement` children, other), the NLS helper defaults, and the vendor
dictionary matches per locale with their disposition (available, conflict, empty,
identical, missing). Every usage point carries its byte and UTF-16 range, context,
and a per-point review disposition.
[reviews.json](../compat/localization/reviews.json) binds `adopt`/`exclude`/
`unresolved` decisions to the observed source digest. The full report is written
under the tool state (`localization/inventory/<sourceIdentity>.json`) unless
`--out` selects another path. The summary on stdout counts the literals that match
no vendor key instead of dropping them.

AST rules cover `nls-default-string`, `literal`, `element-child`,
`template-literal`, and `element-message`. AST preparation rebuilds template and
`createElement` usage points and injects a self-contained ICU formatter when those
edits need it. Translated DOM preparation builds an index instead; it does not
rewrite `main.js` or inject that formatter. `native.json` carries build-time
precompiled ICU ASTs for native display.

### Generated usage rules

`npm run localization -- rules:generate --ls ABS_LS_PATH [--profile ID]` derives
digest-bound rules mechanically from the observed `main.js` and stores them as
`generatedRules` on the matched profile, modifying the tracked
[usage-points.json](../compat/localization/usage-points.json). A usage point is
adopted only when its text (literal and `createElement` child positions), its NLS
`upstreamKey` + default pair, or its template/`elementMessage` ICU skeleton resolves
to exactly one catalog message, or to several messages whose translations are
identical in every shipped locale. Points inside an adopted `elementMessage` span
stay owned by the sentence rule. Every rule carries `sourceSha256` and per-range
`expectedHits`, so drift fails the transform exactly like reviewed rules.

Ambiguous points (distinct translations for the same source text) and unmatched
points are never guessed. They are counted in the command report and listed, capped,
in a worklist under tool state (`localization/rules/<sourceIdentity>.json`) for
human review. Rule precedence is reviewed `rules`, then `generatedRules`, then
`fallbackRules`.

Generation is adoption, not review: a mechanically matched message id can pick a
plausible but unreviewed translation for ambiguous surface text. For its recorded
source digest, the generated rule set is selected instead of merging it with the
fallback rules, so some fallback usage points can remain uncovered. Generated
coverage remains `probe-only` evidence until a real-client pass and spot review.

### Native interface

Native texts ship as `native.json` and are applied at display time by host-engine
helpers called from reviewed structural edits. Each edit's anchor must be unique,
and every transformed member is re-parsed before composition. Helpers fall back to the
original text, and a failed native verification clears the catalog with a
diagnostic.

Covered surfaces: the quit-confirmation dialog, tray items, the application menu
(matched by stable `role`, so translated labels never determine action identity),
File/Help items, the updater item and its state machine, startup and WSL error
dialogs, the provisioning splash, WebAuthn and device-chooser dialogs, workspace
dialogs, and the embedded-browser security popup and
its edit menu. Message boxes keep their `defaultId`/`cancelId` semantics. The
messages are listed in
[native-messages.json](../compat/localization/native-messages.json).

Native adapter v2 keeps the legacy edit set. The 2.32.1 profile selects v3,
which additionally reviews `dist/remote/remoteManager.js`, `sshPrompts.js`,
`sshPromptPreload.js`, `sshBridge.js`, `sshErrorText.js`, `sshArgs.js`,
`disconnectedPage.js`, `sshConnection.js`, `sshDestination.js`, and
`sshConfigHosts.js`. Missing members and unknown adapter versions refuse rather
than dropping edits. The sandboxed SSH prompt preload receives translated static
framing over its existing IPC; it does not load the Host engine with `require`.
Dynamic host labels, paths, usernames, raw SSH/MCP errors, and server names remain
content. DOM protection and reviewed template contexts are in
[scopes.ts](../src/localization/runtime/scopes.ts).

The Windows 2.33.0 and 2.34.0 profiles select v4 without changing v2 or v3's edit sets. The 2.33.0
reviewed upstream source is ASAR
`b33c81600e82e65593aa8430ef01b37d6b28d9d98f0faf45e25957783b71e64b`; its embedded
Hub `main.js` is
`f066a497c9c61198394cb3218e42ff61d85b03910d81282589c3ef066905f347`, with NLS
helper `is`. The profile records the paired executable/LS identities, asset sizes,
and `dist/utils.js` identity. The unique `win.loadURL` Host-delivery anchor is
unchanged. To reproduce the native structural check without running any member,
build localization, set `AGYCTL_REVIEW_ASAR` to the original archive, and run:

```bash
node --input-type=module -e "import {loadAsarEngine} from './scripts/vendor/asar-engine.cjs'; import {buildReviewedNativeEdits} from './dist/localization/bundle/feature-provider.mjs'; const edits=buildReviewedNativeEdits(loadAsarEngine(),process.env.AGYCTL_REVIEW_ASAR,'4'); console.log(edits.length,[...new Set(edits.map(e=>e.file))]);"
```

V4 preserves the existing SSH surfaces using the new exact contexts and adds the
2.33.0 presentation paths: `promptTitle` credential/host-key framing in
`dist/remote/sshPrompts.js`; loopback sign-in, microphone permission,
`takeOverSheet`, and `restartSheet` in `dist/remote/remoteManager.js`; SSH-config
file-type/encoding advice in `dist/remote/sshConfigHosts.js`; Linux-host requirements
in `sshArgs.js`/`sshErrorText.js`; and restart/stopped-agent states and
`BUTTON_LABELS` in `disconnectedPage.js`. The upstream prompt parser, raw prompt
message, sandboxed preload, deny/defer defaults, button indices, and navigation
action identifiers are unchanged. The new prompt title is localized before it is
sent over the existing IPC; the preload continues to assign title, message, and
host label as text. Native HTML framing and disconnected-page labels are escaped
at the rendering boundary. Successful SSH sessions, real authentication dialogs,
takeover/restart actions, and 2.33.0 runtime activation still require client
acceptance; offline admission does not qualify those paths.

## Selection and status

`npm run localization -- select --artifact ID --installation ABS_ASAR_PATH` records
a selection for a discovered installed target and writes only tool state.

- `--artifact` takes the 64-hex artifact ID printed by `prepare`, and the artifact
  must pass validation.
- `--installation` must resolve to a discovered `app.asar` path (case-insensitive
  on Windows, case-sensitive on POSIX). The installation ID is the SHA-256 of the
  discovered path, and `--installation-id ID` passes it directly instead.

A patched installation whose runtime config binds the selection (`schemaVersion` 2)
picks up the newly selected artifact and locale on the next client launch without
recomposing the archive. Other runtime-config schemas are rejected.

`npm run localization -- status --installation ABS_ASAR_PATH` reads the selection
and reports `lastKnownRuntime`: the most recent `runtime-status.json` snapshot the
Host process persisted (run id, artifact, locale, health, terminal failure). It is
last-known evidence, never a live claim, and is absent until a bound runtime has
run. A snapshot for a different installation is omitted with a diagnostic. Both
`select` and `status` reject ambiguous discovery when more than one installation
exists, so pass the explicit `app.asar` path.

`node scripts/manage.mjs status --asar ABS_ASAR_PATH` reports the same evidence for
one installation: `selected` (the selection record), `coverage` (replaced-message
totals plus the explicit `untranslated`/`unapplied` message ids of the selected
artifact), and `lastKnownRuntime`. `installed` means only that the Host composition
is applied; it does not claim the Hub bootstrap ever ran.
