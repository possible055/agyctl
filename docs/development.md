# Development

Setup, checks, project layout, build outputs, and toolchain pinning. CI job
selection and the required gate are documented in the [CI guide](../.github/CI.md).

## Prerequisites

- Node.js 26.13 or a newer 26.x release (`.nvmrc`, `engines`)
- Go 1.26 or newer
- Optional: `uv` (isolated hook launching), `gitleaks` and `golangci-lint` v2.x on
  `PATH` for their checks

No project Python environment is required.

```bash
npm ci
uvx pre-commit install
```

## Checks

Run the smallest check relevant to your change; none of these is a mandatory full
local gate. Commit hooks run changed-file hygiene, formatting, security, and the
correctness checks selected by the `files:` patterns in
[.pre-commit-config.yaml](../.pre-commit-config.yaml). Formatting hooks rewrite
files in place, so review the diff afterwards. Push hooks run secret scanning, and
[CI](../.github/CI.md) provides the broader correctness gate.

```bash
npm run lint
npm test                   # builds Host/Capsule/localization, then runs the core Node suite
npm run test:run           # same suite, using existing build artifacts
npm run test:unit          # fast subset that needs no built artifacts
npm run test:localization  # builds localization and runs its suite
npm run typecheck
npm run host:typecheck
npm run capsule:typecheck
npm run localization:typecheck
npm run tools:test         # full Go suite
npm run tools:vet
npm run tools:lint         # needs golangci-lint v2.x
npm run test:vendor-sync   # optional: checks the recorded vendor-src snapshot
npm run test:electron      # optional: pinned Electron 44.10.2
```

To test one Go package: `go -C src/agyctl test ./internal/<package>`. To run one Node
test: `node --test tests/node/<name>.test.mjs` (after the matching build when it
needs `dist/` artifacts).

A test whose prerequisite is missing (an installed client, Electron, built
localization artifacts, the `vendor-src` snapshot, or a real sample) reports
**SKIP** with the reason. A skip is not a pass: read the skips before trusting a
green run. For example, the localization cases in the Host suite skip until
`npm run test:localization` or `npm run localization:build` has produced
`dist/localization`. Set `AGYCTL_ELECTRON_EXECUTABLE` to use an Electron binary
other than the installed devDependency.

Never run live mutation or lifecycle commands (`limit patch --apply`, `restore`,
`host-patch apply`, and similar) as part of verification.

### Limit patch tests

The limit suite checks assembly byte contracts, patch planning, readback, and
restoration on synthetic inputs, and it does not execute generated machine code.
It therefore cannot validate native instruction semantics or compatibility with a
new Antigravity build. The installed-byte gate is described under
[modification boundary](limit-patch.md#modification-boundary), and the layout
assumptions under [upstream clamp](limit-patch.md#upstream-clamp).

The byte-gate and patch-integrity contract runs through the public API in the
separate [patchtest package](../src/agyctl/internal/limit/patchtest/integrity_test.go),
so it builds into a different test executable from the other limit tests. Neither
group is disabled: `go -C src/agyctl test -count=1 ./internal/limit/...` runs both,
and `npm run tools:test` and CI's recursive Go suite include both packages.

The split exists because a Windows antivirus blocked the combined test executable
while the contract alone and its complement ran. If antivirus blocks a Go test
executable, record the detection name and file hash and report the suspected false
positive to the vendor instead of rerunning repeatedly. A successful `go test -c`
build is not equivalent evidence, because Go may retain debug information in that
mode while stripping it from ordinary test executables (`go test -n` shows the link
command).

## Project layout

| Path | Purpose |
| --- | --- |
| `src/plugin/` | Sidecar panel and shared telemetry logic |
| `src/capsule/` | Input-toolbar capsule sources |
| `src/host/` | Neutral ASAR composition, backups, receipts, transactions, and tooling logs |
| `src/localization/` | Localization catalogs, DOM engine, Host bootstrap, and its Host feature |
| `src/agyctl/` | Go CLI: compatibility checker, limit patcher, tool-output patcher |
| `scripts/` | Build, install, and Host entry points |
| `compat/` | Signatures, install layout, tool-output registry, localization profiles |
| `tests/` | Node and Electron suites; Go tests sit beside their packages |
| `docs/` | Architecture, operations, localization, limit patch, tool-output patch, checker, and development guides |

## Build outputs

Everything under `dist/` is generated: edit the sources and rebuild.

| Output | Produced by | Consumed by |
| --- | --- | --- |
| `dist/bin/<goos>-<goarch>/agyctl` (`.exe` on Windows) | `npm run tools:build` | `npm run limit:*`, `tool-output:*`, `update-check:*`, `manage.mjs status` |
| `dist/host/bundle/` | `npm run host:build` | Capsule, Host, and management scripts |
| `dist/capsule/input-capsule.js` | `npm run capsule:build` | Host `apply`/`plan --capsule-code`; `capsule:install` assembles its own copy in memory |
| `dist/localization/bundle/` | `npm run localization:build` | `scripts/localization.mjs`, localization Host features and tests |

`tools:build` ([tools-build.mjs](../scripts/tools-build.mjs)) runs
`CGO_ENABLED=0 go build -trimpath -buildvcs=false` for the target from
`GOOS`/`GOARCH`, or the host by default, and stamps `main.buildCommit` with
`git rev-parse HEAD` (`unknown` when that fails, for example before the first
commit). It uses the Go from `GO`, else the standard Windows Go installation when
present, else `go` on `PATH`.

The capsule ships as one self-contained classic script.
[capsule-build.mjs](../scripts/capsule-build.mjs) strips import/export syntax from
the shared ES modules under `src/plugin/lib/` and the capsule fragments, then
concatenates them in the fixed `CAPSULE_INPUTS` order, without a bundler. Syntax it
cannot strip fails the build. Rebuild after editing sources. The documented enable path
is `host-patch apply --capsule-code` with the built file, while the
`capsule:install` wrapper takes no arguments, uses the selected installation, and
assembles the same sources in memory instead of reading `dist`.

The Host and localization loaders compare every input and output hash in their
`build-manifest.json` and refuse with a "stale or incomplete" error after a source
edit until you rebuild. The npm wrappers `capsule:install`, `capsule:uninstall`,
`host-patch`, `localization`, `test`, and `test:localization` rebuild the bundles
they need first; direct `node scripts/...` calls, including `manage.mjs`, do not.

## Toolchain and supply chain

Build tooling is pinned where the repository can pin it, and the remaining `PATH`
tools are verified or logged at use.

- **pre-commit hooks** are frozen to commit SHAs, not tags, in
  [.pre-commit-config.yaml](../.pre-commit-config.yaml). Update with
  `pre-commit autoupdate --freeze`, review the diff, and keep the trailing tag
  comment accurate.
- **Go** declares a suggested toolchain in [go.mod](../src/agyctl/go.mod), not an
  exact version lock; the selected version also depends on the local toolchain and
  `GOTOOLCHAIN` (see [Go toolchain selection](https://go.dev/doc/toolchain#select)).
  [CI](../.github/workflows/ci.yml) uses `actions/setup-go` with `go.mod` and sets
  `GOTOOLCHAIN=local`. Each setup-go step overrides that variable, because setup-go
  would otherwise install the `go` floor and ignore the `toolchain` directive.
  Record `go version` when reproducing a build.
- **7-Zip**, used to unpack untrusted installers, is resolved in this order: a
  cached copy verified against the digests recorded in
  [extract.go](../src/agyctl/internal/check/extract.go); a system `7z`, logged as
  unverified; then a download of the pinned tools, verified, only on Windows when
  downloads are allowed. Non-Windows runs and local-file checks never download it.
- **npm lifecycle scripts are disabled** (`.npmrc` sets `ignore-scripts=true`), so
  dependencies must install without them. esbuild ships its platform binary as an
  ordinary optional dependency, and TypeScript and Biome need no postinstall.
  Electron's binary download is skipped as well. The localization harness takes an
  executable from `AGYCTL_ELECTRON_EXECUTABLE`, an Electron binary already in
  `node_modules`, or an independent Windows install under
  `%LOCALAPPDATA%/agyctl/electron-test/node_modules/electron/dist/electron.exe`,
  regardless of `AGYCTL_HOME`. It reports SKIP when none exists. Whatever it finds
  must report exactly `v44.10.2`.
  Review any future dependency that needs install scripts before allowing it.
- **Vulnerability and secret scanning** run in the [CI gate](../.github/CI.md).
  Review lockfile diffs and run the complete gate before merging dependency changes.

## Vendored components

[scripts/vendor/asar-engine.cjs](../scripts/vendor/asar-engine.cjs) reads,
validates, extracts, and packs ASAR archives for
[host-patch.mjs](../scripts/lib/host-patch.mjs). It is exercised by
[install-safety.test.mjs](../tests/node/install-safety.test.mjs) and
[host-patch.test.mjs](../tests/node/host-patch.test.mjs).
