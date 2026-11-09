# Client Localization

`agyctl` can translate the Antigravity interface by composing a localization
feature into `app.asar` and serving a prepared copy of the Language Server's web
bundle at runtime. This page covers the implemented stages, the recorded
profiles, the offline developer workflow, and the evidence collected so far. For
the Host apply commands, see
[operations](operations.md#localization-preparation-and-apply). For the inspected
upstream members, see
[upstream analysis](upstream-analysis.md#hub-web-assets-and-nls-helper).

The panel and capsule language selector is a separate feature: it changes AGY's
own messages and never translates Antigravity. See
[interface languages](operations.md#interface-languages).

## Current status

Every profile in [profiles.json](../compat/localization/profiles.json) is
`probe-only`. A `probe-only` profile may enter installation preflight with an
`UNTESTED_BUILD` warning; it is not a claim of verification. All three are
Windows x64 profiles:

| Profile | Source evidence |
| --- | --- |
| `hub-win-x64-2.29.0-290e1b7a` | Windows package assets |
| `insiders-win-x64-1.0.20261107110649-9c1d2c94` | Windows assets, identical in the inspected WSL Ubuntu server |
| `insiders-win-x64-1.0.20261108110649-e4964b5f` | Windows assets, identical in the inspected WSL Ubuntu server |

Rules live in [usage-points.json](../compat/localization/usage-points.json).
Rules bound to a source digest apply only to that observed `main.js`; when none
matches, the profile's range-free fallback rules apply. Messages are defined
once in [source.json](../src/localization/catalogs/source.json); the
`zh-Hant-TW`, `zh-Hans-CN`, and `ja-JP` catalogs translate them. Preparation
(`validateTranslations` in [transform.ts](../src/localization/build/transform.ts))
refuses a translation without a source message, an empty or unreviewed
translation, changed ICU arguments, and a missing translation for a `critical`
message. A missing non-critical translation is allowed, so equal catalog sizes are
a current observation, not an enforced invariant.

Rule and message counts change with translation work, so this guide does not
record them. Read the current values from the data files instead:

```bash
node -e "const u=require('./compat/localization/usage-points.json');for(const[k,v]of Object.entries(u.profiles))console.log(k,(v.rules??[]).length,(v.fallbackRules??[]).length)"
node -e "for(const l of['source','zh-Hant-TW','zh-Hans-CN','ja-JP'])console.log(l,Object.keys(require('./src/localization/catalogs/'+l+'.json').messages).length)"
```

One partial real-client pass is [recorded](#recorded-real-client-pass) for
Insiders `zh-Hant-TW`. It did not promote any profile. The internal provenance
label `official-profile` is not Google endorsement, and the project-added delivery
coordinator is not an upstream localization API.

## Flow and qualification

| Stage | Flow and boundary | Tracked implementation |
| --- | --- | --- |
| Source admission | ZIP structure, CRC, strict UTF-8, and per-asset sizes/hashes gate a selected profile. The whole-LS hash is observed evidence, not an admission gate, so a limit patch outside the assets does not invalidate them. Unknown sources may be observed/prepared but are not installation-qualified | [assets.ts](../src/localization/build/assets.ts) |
| Offline transform | Acorn matches the reviewed helper, key, original string, and exact expected hit count. Context-scoped rules replace only classified display positions (`label`/`aria-label`/`title` properties, React `createElement` children); `template-literal` rules rebuild dynamic sentences from a `{n}`-marked skeleton, splicing the original expressions back in unchanged so each keeps its single evaluation and ordering. ICU messages (template-literal and multi-part `createElement` children) are rebuilt against a self-contained formatter runtime that prepare injects into the artifact, preserving single evaluation and element identity. Several rules may share one semantic message id and their hits sum. Catalog entries provide reviewed translations; mismatches refuse preparation | [transform.ts](../src/localization/build/transform.ts), [usage-points.json](../compat/localization/usage-points.json) |
| Usage-point inventory | `inventory` parses the observed `main.js` once, classifies every string literal's display context, lists NLS helper defaults, and matches vendor dictionary keys per locale (own-property lookup only). Every usage point is recorded with byte and UTF-16 ranges, context, ancestors, and a review disposition; [reviews.json](../compat/localization/reviews.json) binds `adopt`/`exclude`/`unresolved` decisions to the observed source digest. The report lands in tool state and counts the un-matched remainder instead of hiding it | [inventory.ts](../src/localization/build/inventory.ts), [cli.ts](../src/localization/cli.ts) |
| Artifact publication | `main.js`, `manifest.json`, `coverage.json`, `inventory.json`, `rules.json`, and `native.json` (when native messages exist) are published under a content-addressed tool-state directory; conflicting existing contents are rejected. Coverage enumerates every inventory usage point as `translated`/`unresolved`/`excluded`/`probe` with edit evidence, and `validate` re-verifies that evidence against the reviewed rules | [cli.ts](../src/localization/cli.ts), `writeArtifactDirectory`; [artifact.ts](../src/localization/artifact.ts), `readValidatedArtifact` |
| Selection | `select` writes a private per-installation selection record; `status` reads it and reports the last-known runtime snapshot as separate evidence. Neither installs the Host bridge nor establishes runtime activation | [cli.ts](../src/localization/cli.ts), `runLocalizationCommand` |
| Host composition | A reviewed plan binds the target, payloads, and observed source. Localization requires an existing profile; probe-only status and ASAR/executable identity drift emit warnings. Paired executable/fuse qualification and unique adapter anchors still gate writes. Capsule and localization are composed from one verified original | [feature.ts](../src/localization/host/feature.ts), `qualifyLocalizationOriginal`; [compose.ts](../src/host/compose.ts), `applyHostPatch` |
| Runtime delivery | Each recorded profile names a `dist/utils.js` adapter located by one unique `win.loadURL` anchor; the replacement calls `loadLocalizedURL` before the original navigation. The adapter's recorded SHA-256 is evidence, not a gate. The patched archive pins only the tool state root and selection installation id (`runtime-config.json` schemaVersion 2); each launch resolves and verifies `selection.json`, the artifact manifest, and the artifact bytes from the state root, so re-selection takes effect on the next launch without re-patching. Schema-less runtime configs are rejected. It checks the live loopback `/main.js` source hash and binds the resolved artifact and locale to its coordinator. Matching HTTPS GET requests use hash-checked managed assets; other requests are forwarded. Runtime events persist to per-installation JSONL segments and an atomic `runtime-status.json` last-known snapshot | [host.ts](../src/localization/runtime/host.ts), `loadLocalizedURL`, `SessionDeliveryCoordinator`, `resolveStartupSnapshot`, and `RuntimePersistence`; [startup.ts](../src/localization/runtime/startup.ts); [host-patch.mjs](../scripts/lib/host-patch.mjs), `loadLocalizationInputs` |
| Execution confirmation | The preload exposes a confirmation IPC call. Matching navigation/artifact/locale evidence advances a served record to executed, then active after page load. Preparation failures load the original interface through the already-pending `loadURL`; failures after navigation began only mark the coordinator degraded, release tracking, and record the terminal state — the running page is never re-navigated or reloaded | [preload.ts](../src/localization/runtime/preload.ts), [host.ts](../src/localization/runtime/host.ts), `handleConfirmation` |
| Native interface | Prepared artifacts ship `native.json` (byte hash in `manifest.nativeCatalogSha256`, with build-time-precompiled ICU for dynamic messages) for messages with native surfaces. Reviewed structural edits ([native-adapters.ts](../src/localization/host/native-adapters.ts), `buildReviewedNativeEdits`) patch approved main-process positions — quit dialog, tray agents-running label, startup/WSL errors, workspace/WebAuthn/device dialogs, the IDE-install wizard HTML (HTML-context escaping), the embedded-browser security popup, the updater menu state machine — to call host-engine helpers at display time; each edit's anchor must be unique and every transformed member is re-parsed before composition. The application menu is localized by stable `role`, never by English label, and the updater item is keyed by update step, so translated labels never determine action identity; message boxes keep their `defaultId`/`cancelId` semantics. Helpers translate from the verified catalog or return the original text; a failed native verification clears the catalog so every helper degrades to the original with a diagnostic | [native.ts](../src/localization/runtime/native.ts), [feature.ts](../src/localization/host/feature.ts), `applyAdapterEdits`; [host-patch.mjs](../scripts/lib/host-patch.mjs), `loadLocalizationInputs`; [native-messages.json](../compat/localization/native-messages.json) |

Selection alone does not attach a runtime coordinator or prove real-client
activation. Missing profiles and failed asset or structural checks refuse the
feature. ASAR or executable hash drift emits `IDENTITY_DRIFT` instead of blocking
unrelated modifications. Receipts retain `features.localization.profileStatus`.

### Trust boundary and known limits

- The tool state root is the trust boundary. Artifact, catalog, and asset hashes
  there detect corruption and mix-ups; they do not defend against another
  process running as the same user that can rewrite the state root.
- `protocol.handle` requests carry no `webContents` identity, so a request is
  attributed to the first active delivery record of the current generation.
  Overlapping first loads of two Hub windows can leave one record `pending`.
- The delivered route set is `/main.js` only. The observed `index.html` also loads
  `/prism_bundle.js` and two stylesheets from the origin; they stay untranslated
  until they are added to the profile assets, transform, and delivery routes.

## Offline inspection and preparation

This developer workflow reads profile-matching assets and writes only localization
artifacts under the tool's private state root. It does not install localization
or change the client.

Run `npm ci` first if needed. Use the
[upstream asset inspection procedure](upstream-analysis.md#reproduce-the-embedded-asset-observation)
to read the exact Hub LS and create `$sampleDir` containing `index.html` and
`main.js`. Keep the same PowerShell 7 terminal and compare the printed asset
identities with the upstream table before continuing:

```powershell
$profile = 'hub-win-x64-2.29.0-290e1b7a'
npm run localization -- inspect --profile "$profile" --sample-dir "$sampleDir" --json
```

Inspect `profileId`, `profileStatus`, `installationQualified`, `sources`, and
`usagePoints`. A matching complete asset set can qualify a `probe-only` profile
for installation preflight while retaining the untested warning; an unknown source
remains unqualified. `prepare --profile` requires the selected profile's exact asset
sizes and hashes. Expected and observed whole-LS identities remain separate, so a
non-asset limit patch reports drift without rejecting unchanged assets. Source:
[assets.ts](../src/localization/build/assets.ts) and the
[CLI implementation](../src/localization/cli.ts).

`inspect --ls ABS_LS_PATH` reads the assets from a Language Server binary instead.
It locates EOCD candidates across the complete binary rather than only its final
`65557` bytes, bounds the candidate count, validates the central directory and
file ranges, accepts empty directory entries, and requires one unambiguous archive
containing the requested profile assets. Extraction treats the binary as data and
never executes it. `--sample-dir` is an explicit alternate input, not an automatic
fallback after extraction failure.

To prepare an English no-translation probe and validate the resulting artifact,
build once and call Node directly when capturing JSON, so npm output is not
included in the parsed value:

```powershell
npm run localization:build
$prepared = node scripts/localization.mjs prepare --profile "$profile" --sample-dir "$sampleDir" --probe --json | ConvertFrom-Json
$prepared
npm run localization -- validate --artifact-dir "$($prepared.directory)" --json
```

Expect `probe: true`, `locale: en`, an artifact ID and directory, and then
`valid: true`. The directory contains `main.js`, `manifest.json`,
`coverage.json`, `inventory.json`, `rules.json`, and `native.json` when native
messages exist; conflicting existing artifacts are rejected. To prepare a
translation instead, use:

```powershell
npm run localization -- prepare --profile "$profile" --sample-dir "$sampleDir" --locale zh-Hant-TW --json
```

`prepare` checks exact usage-point hit counts and catalog entries, and the staged
directory must pass artifact validation before it is published. `validate` checks
the artifact's asset and coverage hashes and JavaScript parseability. Neither
result promotes the profile or proves real-client translation or activation.

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

### Native interface

Native interface texts ship as `native.json` in the artifact and are applied at
display time by host-engine helpers. The reviewed native adapter covers the
quit-confirmation dialog, the tray agents label, the application menu (localized
by stable `role`, so translated labels never determine action identity), the
updater item and its menu state machine (keyed by update step, not by label),
startup and WSL error dialogs, the provisioning splash, WebAuthn and
device-chooser dialogs, workspace dialogs, the IDE-install wizard HTML
(HTML-context escaping), and the embedded-browser security popup. Message boxes
keep their `defaultId`/`cancelId` semantics.

### Selection and status

`npm run localization -- select --artifact ID --installation ABS_ASAR_PATH`
records a selection for a discovered installed target and writes only tool
state. `--artifact` takes the 64-hex artifact ID printed by `prepare`, and the
artifact must pass validation. `--installation` must equal a discovered
`app.asar` path exactly (string comparison, no normalization); the installation
ID is the SHA-256 of that path, and `--installation-id ID` passes it directly
instead. A patched installation whose runtime config binds the selection
(`schemaVersion` 2) picks up the newly selected artifact and locale on the next
client launch without recomposing the archive; other runtime-config schemas are
rejected.

`npm run localization -- status --installation ABS_ASAR_PATH` reads that
selection and reports `lastKnownRuntime`: the most recent `runtime-status.json`
snapshot the Host process persisted (run id, artifact, locale, health, terminal
failure). It is last-known evidence, never a live claim, and is absent until a
bound runtime has run. Both `select` and `status` reject ambiguous discovery when
more than one installation exists, so pass the explicit `app.asar` path.

`node scripts/manage.mjs status --asar ABS_ASAR_PATH` reports the same evidence
for one installation: `selected` (the selection record), `coverage`
(replaced-message totals plus the explicit `untranslated`/`unapplied` message ids
of the selected artifact), and `lastKnownRuntime`. `installed` means only that
the Host composition is applied; it does not claim that a delivery coordinator
ever attached.

## Recorded real-client pass

Executed 2026-11-09 on Windows x64 with an explicit per-run authorization. The
method was prepare, apply, launch, then read tool state; the current apply path is
the [localization workflow](operations.md#localization-preparation-and-apply).

| Item | Result |
| --- | --- |
| Build / channel | Antigravity Insiders `1.0.20261108110649`, Windows x86-64, Language Server binary identity drifted from the profile (`IDENTITY_DRIFT` warning emitted, prepare proceeded on structural evidence) |
| Profile status | `probe-only` with `UNTESTED_BUILD` warnings surfaced at prepare, status, and plan review; no version allowlist was consulted |
| Artifact denominator | Counts for that artifact (current catalogs differ): 4,182 catalog messages, 115,360 recorded usage points (4,996 `translated`, 2,507 `excluded` with reasons, 107,857 `unresolved`), 4,418 replacements, 793 `unapplied` messages visible; 80 qualified native usage points |
| Apply | Reviewed plan applied by the management job that has since been removed; the current path is `node scripts/manage.mjs --host-apply` with the client closed; receipt updated; selection written by apply; takes effect at the next client launch |
| Delivery cycles | Two fresh client processes each completed startup → native catalog loaded → attach → served `/main.js` → confirmation accepted → `active`, with no terminal failures (per-run JSONL segments plus the atomic `runtime-status.json`; every event carries `operationId` = runId) |
| Timing | Runtime init → active: ~2.3 s (first launch), ~1.8 s (second launch); not the paired p95 measurement the performance targets require |
| UI evidence | Accessibility-tree semantics confirmed translated interface strings (e.g. the 通知 control) in the running client; raster capture of the client area was unavailable in the verification environment (D3D/GDI captures returned black frames) |
| Restore | Selection removed after evidence collection; the installation returned to its pre-acceptance behavior (original interface on next launch), Capsule intact, original backups untouched |

Not run in that pass, and still required before claiming three-language
delivery: live WSL connection-mode operation, menu-popup and updater visual
verification, `zh-Hans-CN` and `ja-JP` client passes, the accessibility and
long-translation layout review, and the paired cold/warm performance matrix.
