# Inspected Upstream Desktop Builds

This document records static observations, not an upstream API contract or live
qualification. Windows package bytes were inspected as data on 2026-11-08;
the macOS section records a separate 2026-11-09 inspection. Neither the
Language Server nor extracted JavaScript was executed. The paths below identify
members of the upstream distribution.

For stable project responsibilities, see [architecture](architecture.md). For
context-limit machine-code evidence, see [context-limit analysis](context-chain-analysis.md).

## Package identities

| Windows x64 build | Upstream member | SHA-256 |
| --- | --- | --- |
| Hub `2.29.0` | `resources/app.asar` | `290e1b7a1caa430a0c5367c7b433e8d284e2ca5d0b305e91e5ce8ec926f43283` |
| Hub `2.29.0` | `resources/bin/language_server.exe` | `c98e7c331da5bcc37002a550e7d625b4c636f775fa2804f73777c6a500e1c3d5` |
| Insiders `1.0.20261107110649` | `resources/app.asar` | `9c1d2c940053b8b3ccec8d269ff2a7373439f18a2723c95dbafee695a4292aff` |

The build labels come from `resources/app.asar` member `package.json`. Inspecting
the Insiders archive does not qualify its Language Server or localization path.
Reproduction requires these exact packages; the current Insiders feed may offer
a different build. Do not substitute a newer package while retaining these findings.

## macOS Apple Silicon signing boundary

Static data inspection on 2026-11-09 covered stable app `2.29.1` and
Insiders `1.0.20261108110649`. The stable feed execution was
`5241471524274176`; its asset was `darwin-arm/Antigravity.dmg` (212,868,323 bytes).
The development-channel asset was `Antigravity-arm64-mac.zip` (193,518,913 bytes).
No extracted executable or JavaScript was run, and no installed client was changed.

Package-relative roots are `Antigravity.app/Contents/` and
`Antigravity - Insiders.app/Contents/`, respectively:

| Member relative to Contents | Stable SHA-256 | Insiders SHA-256 |
| --- | --- | --- |
| `Resources/bin/language_server` | `4fc02a11d38ec400543ea47d00bb1d4922de26476758e1ab5c116defc3a2d206` | `0594a74fe890be97ce35cd84e7811ea838a0f5b964339659867e34c761d9d4f0` |
| `Resources/app.asar` | `a6bfd4567c2560495860e895c8894106ed40782e4a31e459713fec1cc2a0d02b` | `e4964b5f6f8df4955fbc82746ae52dfbbb13d5d33d333cd13e757852971ae208` |

Both servers are ARM64 Mach-O images. Go build metadata reads
`go1.28-20261025-RC00` and `go1.28-20261102-RC00`, respectively. Independent
Go function readers locate a `0x90`-byte `utils.ClampCheckpointConfigForModelInfo`
body with SHA-256
`fa16ff87f1c50d3bf4eeacdf3da161b68249f6b81c210f9bbbb9bcc14d0d1e6a` in both.
That is inspection evidence, not macOS patch admission or live execution evidence.

Both servers have `LC_CODE_SIGNATURE` with an embedded SuperBlob
(`0xfade0cc0`). Stable uses offset `0xa237e40`, size `0x55b90`; Insiders uses
offset `0xab6a300`, size `0x5a530`. Both enclosing
`_CodeSignature/CodeResources` files contain `files2` SHA-256 entries for
`Resources/bin/language_server` and `Resources/app.asar`, matching the table.
Consequently, modifying these members changes signed/sealed content; an unchanged
signature cannot be assumed to accept the modified app. OS acceptance was not tested.

The fuse wire is in
`Frameworks/Electron Framework.framework/Versions/A/Electron Framework`,
not the small `MacOS/Antigravity` or `MacOS/Antigravity - Insiders` launcher.
Both wires are schema 1, count 9, states `101100011`; embedded ASAR validation
(index 4) is disabled. Nevertheless, `Info.plist` declares
`ElectronAsarIntegrity` for `Resources/app.asar`: stable header hash
`1c0c1a191d413d08efcea5be55884dd1e65ab4eeb7ee755dc2478160a59daaba`, Insiders
`6b5810c0f76476305d8d3529e0bc8bdef2d32cbb0e3e2fdddba0ea2a9df36f00`.
A disabled fuse does not remove the enclosing code-signing boundary or qualify
our existing paired-launcher fuse reader for this macOS layout.

The independent checker originally qualified the fuse wire only from the largest
`MacOS`-directory candidate, which is the small launcher on this layout, so its
first stable/Insiders darwin-arm64 runs reported the sentinel missing. The
candidate scan in [fuses.go](../src/agyctl/internal/check/fuses.go) now also
reads framework version directories and qualifies from the first binary that
carries the wire; re-running the Insiders package moves `capsule_injection` from
`needs-review` to `available` while `limit_patching` stays `blocked`. The
checker's strict no-link extraction still refuses the stable DMG
(`7z archive contains unsupported links` from its own pipeline); the member-level
reproduction below remains the data path for that channel.

To reproduce without executing package content, obtain those exact assets and
extract only the listed members plus `Info.plist`, `_CodeSignature/CodeResources`,
the launcher, and the framework binary. 7-Zip 26.03 can extract the stable DMG's
APFS content directly using full app member names; ordinary ZIP readers can select
the Insiders members. For the extracted server, `go version -m` reads its metadata;
`agyctl client target --binary ABS_LS --json` identifies the target and
`agyctl limit status --binary ABS_LS --json` explicitly reports unavailable
mutation. See the data readers in [binary.go](../src/agyctl/internal/layout/binary.go),
[macho.go](../src/agyctl/internal/limit/macho.go), and the independent
[pclntab.go](../src/agyctl/internal/check/pclntab.go).
On a Mac, `otool -l` and `plutil -p` can inspect the load commands and the two
property lists as data. None of these steps re-signs, launches, or patches the app.

The unresolved work is a deliberate signing/trust strategy and native macOS
apply/start/function/restore acceptance. No macOS patch registry entry, automatic
re-signing, signature stripping, or signing bypass was added by this inspection.

## Shell launch and window boundaries

Each source locator combines the distribution path, ASAR member, and function.
Use the [read-only inspection procedure](#reproduce-shell-inspection) to read it.

| Observation | Upstream source locator |
| --- | --- |
| Both shells resolve the packaged server under `process.resourcesPath/bin/` | `resources/app.asar` → `dist/languageServer.js`, `LS_BINARY` |
| Both pass `--standalone`, `--https_server_port`, `--csrf_token`, and `--enable_sidecars` | `resources/app.asar` → `dist/languageServer.js`, `startLanguageServer` |
| Both pass `--subclient_type hub`; this argument cannot distinguish Hub from Insiders | Same member and function, `args` array |
| Both contain alternate WSL/headless launch branches | Same member and function, `wsl` and `headless` branches |
| Hub has both `BrowserWindow` and `BaseWindow`/`WebContentsView` construction paths | Hub `resources/app.asar` → `dist/utils.js`, `createWindow` and `isWcvBrowserWindowEnabled` |
| Insiders constructs a `BaseWindow` with separate chat and curtain views | Insiders `resources/app.asar` → `dist/utils.js`, `createWindow` |
| Both set `nodeIntegration: false`, `contextIsolation: true`, and `dist/preload.js` | `resources/app.asar` → `dist/utils.js`, `createWindow`'s `webPreferences` |
| Hub generates a renderer CSRF token and passes the separately obtained Host bridge token to the LS launcher | Hub `resources/app.asar` → `dist/main.js`, `crypto.randomUUID()` and the `startAndMonitorLanguageServer` call |

These observations establish different window implementations in these two
archives, not separate universal injection architectures. They also do not prove
that a packaged Windows server is the server used by a particular WSL session.

## Hub web assets and NLS helper

The inspected Hub `resources/bin/language_server.exe` contains a ZIP at byte
offset `163198568`, length `5627663`. These coordinates apply only to the LS
SHA-256 above. Its members include:

| Embedded ZIP member | Bytes | SHA-256 |
| --- | ---: | --- |
| `index.html` | 3,798 | `118dcfc4e881a41715f2f363ced8ae9afa6b4d7c1acf312da194cb6fab50f768` |
| `main.js` | 11,187,917 | `8d1196a22cd3eb9779e8faf5c31eb732d3df8d9d037b685733ed4e3d6cdfb5a2` |

`index.html` begins with `<html lang="en">`. In this ZIP's `main.js`, the
minified helper `Fu(a,b,...c)` reads `globalThis._VSCODE_NLS_MESSAGES?.[a]` only
inside its `typeof a === "number"` branch. The string-key branch instead uses
the second argument through `rDa(b,c)`. A directly observed call is:

```javascript
Fu("statusBarBackground", "Background color of the editor hover status bar.")
```

The same member reads `globalThis._VSCODE_NLS_LANGUAGE || "en"`. These specific
expressions do not identify who supplies those globals, establish a supported
Hub language-pack interface, or show that injecting an NLS array translates
string-key calls or the entire chat UI. No claim about all upstream catalogs,
all call sites, or Insiders localization follows from this inspection.

The project's reviewed rules for this build are
recorded in [usage-points.json](../compat/localization/usage-points.json). Their
hit counts are checked against this exact `main.js`; they are not evidence of
complete Hub translation or of an upstream language-pack interface. See the
[localization flow](localization.md#flow-and-qualification) and
[offline preparation](localization.md#offline-inspection-and-preparation).

## Reproduce shell inspection

Use an installed distribution or an unpacked installer of the intended build.
For downloaded Hub packages, the [checker](update-check.md#inspect-downloaded-installers)
accepts `--version 2.29.0` and `--keep-work`; inspect the resulting package,
never run its extracted contents.

From the project root in PowerShell 7, set `$installDir` to the selected
distribution root. The default installed Hub location is an example:

```powershell
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\antigravity'
$asar = Join-Path $installDir 'resources\app.asar'
Get-FileHash -LiteralPath "$asar" -Algorithm SHA256
node --input-type=commonjs -e 'const { builtinAsar } = require("./scripts/vendor/asar-engine.cjs"); builtinAsar.validateArchive(process.argv[1]); process.stdout.write(builtinAsar.extractFile(process.argv[1], process.argv[2]));' "$asar" 'dist/languageServer.js'
```

Compare the hash with the table before associating results with a recorded build.
Repeat the Node command with `package.json`, `dist/main.js`, or `dist/utils.js`
as its final argument and inspect the named functions above. This loads the
project's tracked ASAR reader, not the upstream modules.

## Reproduce the embedded-asset observation

The following developer-only Python standard-library script checks the whole LS
hash before using the recorded ZIP coordinates. It prints asset identities and
the observed helper as text, and saves only `index.html` and `main.js` into a new
temporary sample directory for offline CLI inspection. It does not execute the
binary or JavaScript, or write to the installed distribution:

```powershell
$binary = Join-Path $installDir 'resources\bin\language_server.exe'
$sampleDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
@'
import hashlib
import io
import sys
import zipfile
from pathlib import Path

data = Path(sys.argv[1]).read_bytes()
expected = "c98e7c331da5bcc37002a550e7d625b4c636f775fa2804f73777c6a500e1c3d5"
if hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit("Not the inspected Hub 2.29.0 Language Server")
with zipfile.ZipFile(io.BytesIO(data[163198568:163198568 + 5627663])) as archive:
    assets = {member: archive.read(member) for member in ("index.html", "main.js")}
    destination = Path(sys.argv[2])
    destination.mkdir(exist_ok=False)
    for member in ("index.html", "main.js"):
        asset = assets[member]
        print(member, len(asset), hashlib.sha256(asset).hexdigest())
        with (destination / member).open("xb") as output:
            output.write(asset)
    source = assets["main.js"].decode("utf-8")
    start = source.index("function Fu(")
    print(source[start:source.index(";var Gu=", start)])
'@ | python - "$binary" "$sampleDir"
```

Compare the printed asset identities with the table, then retain `$sampleDir`
in the same terminal for the
[offline workflow](localization.md#offline-inspection-and-preparation).
The CLI independently checks the sample sizes and hashes.
