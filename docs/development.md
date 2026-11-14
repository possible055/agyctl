# Development

This page covers development setup, checks, project layout, and how build and test tools are pinned or verified. For CI job selection and the required gate, see the [CI guide](../.github/CI.md).

## Setup and checks

Development needs Node.js 26.13 or a newer 26.x release (`.nvmrc`, `engines`), Go 1.26 or newer, optional `uv` for isolated hook launching, and `gitleaks` / `golangci-lint` v2.x on `PATH` for their checks. No project Python environment is required.

```bash
npm ci
uvx pre-commit install
```

Choose the smallest relevant check for the change; these are available commands, not a mandatory full local gate. Commit hooks run changed-file hygiene, formatting, security, and correctness checks selected by the `files:` patterns in [.pre-commit-config.yaml](../.pre-commit-config.yaml). Formatting hooks may rewrite files, so review the diff afterwards. Push hooks run secret scanning; [affected CI jobs](../.github/CI.md) provide the broader correctness gate.

```bash
npm run lint
npm test                   # prepares Host/Capsule/localization and runs the core Node suite
npm run test:run           # same suite, using existing artifacts
npm run test:unit          # fast subset that needs no built artifacts
npm run test:localization  # builds localization and runs its suite
npm run typecheck
npm run host:typecheck
npm run capsule:typecheck
npm run localization:typecheck
npm run tools:test
npm run tools:vet
npm run tools:lint         # needs golangci-lint v2.x
npm run test:vendor-sync   # optional: checks the recorded vendor-src snapshot
npm run test:electron      # optional: pinned Electron 44.10.2
```

A test whose prerequisite is missing (an installed client, Electron, built localization artifacts, the `vendor-src` snapshot, or a real sample) reports **SKIP** with the reason; a skip is never reported as a pass. Read the skips before trusting a green run: for example, the localization cases in the Host suite skip unless `npm run test:localization` (or `npm run localization:build`) has built `dist/localization`. Set `AGYCTL_ELECTRON_EXECUTABLE` to use an Electron binary other than the installed devDependency.

The capsule ships as one self-contained classic script. `scripts/capsule-build.mjs` assembles the shared ES modules under `src/plugin/lib/` and the capsule fragments in the fixed `CAPSULE_INPUTS` order, without a bundler; edit sources, not `dist`. The documented enable path is `host-patch apply --capsule-code` with the built file, so rebuild after source edits. The `capsule:install` wrapper takes no arguments, uses the selected installation, and assembles the same sources in memory instead of reading `dist`.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/plugin/` | Sidecar panel and shared telemetry logic |
| `src/capsule/` | Input-toolbar capsule sources |
| `src/host/` | Neutral ASAR composition, backups, receipts, transactions, and tooling logs |
| `src/localization/` | Localization catalogs, DOM engine, Host bootstrap, and its Host feature |
| `src/agyctl/` | Go CLI: compatibility checker and limit patcher |
| `scripts/` | Build, install, and Host entry points |
| `compat/` | Signatures, install layout, localization profiles |
| `tests/` | Node and Electron suites; Go tests sit beside their packages |
| `docs/` | Architecture, operations, localization, limit patch, checker, and development guides |

## Toolchain and supply chain

Build tooling is pinned where the repository can pin it; the remaining PATH tools are verified or explicitly logged at use:

- **pre-commit hooks** are frozen to commit SHAs (not tags) in [.pre-commit-config.yaml](../.pre-commit-config.yaml) — a moved tag cannot change what runs. Update with `pre-commit autoupdate --freeze`, review the diff, and keep the trailing tag comment accurate.
- **Go** declares a suggested toolchain in [go.mod](../src/agyctl/go.mod), not an exact version lock. The selected version also depends on the local Go toolchain and `GOTOOLCHAIN`; see [Go toolchain selection](https://go.dev/doc/toolchain#select). [CI](../.github/workflows/ci.yml) uses `actions/setup-go` with `go.mod` and sets `GOTOOLCHAIN=local`; each setup-go step overrides that variable because setup-go ignores the `toolchain` directive when `GOTOOLCHAIN=local` is set and would install the `go` floor instead. Record `go version` when reproducing a build.
- **7-Zip**, used to unpack untrusted installers, first reuses a cached copy verified against the digests recorded in [extract.go](../src/agyctl/internal/check/extract.go), then tries a system `7z`, logged as unverified. Only if neither is available does it download and verify the pinned tools, and only on Windows when downloads are allowed. Non-Windows runs never bootstrap 7-Zip by download; local-file checks disable tool downloads too.
- **npm lifecycle scripts are disabled** (`.npmrc` pins `ignore-scripts=true`). Dependencies must install without them: esbuild ships its platform binary as an ordinary optional dependency, and TypeScript, Biome, and the rest need no postinstall. Electron's binary download is skipped too — the localization harness takes an executable from `AGYCTL_ELECTRON_EXECUTABLE`, an Electron binary already present in `node_modules`, or an independent install under `<agyctlHome>/electron-test`, and reports SKIP when none exists. Whatever it finds must report exactly `v44.10.2`. Review any future dependency that requires install scripts before allowing them.
- **Vulnerability and secret scanning** run in the [CI gate](../.github/CI.md). Review lockfile diffs and run the complete gate before merging dependency changes.

## Build outputs

Everything under `dist/` is generated; edit the sources and rebuild instead.

| Output | Produced by | Consumed by |
| --- | --- | --- |
| `dist/bin/<goos>-<goarch>/agyctl` (`.exe` on Windows) | `npm run tools:build`: `CGO_ENABLED=0 go build -trimpath -buildvcs=false`, stamping `main.buildCommit` with `git rev-parse HEAD` (`unknown` when that fails, for example before the first commit); target from `GOOS`/`GOARCH` or the host; Go from `GO`, else `C:/Program Files/Go/bin/go.exe` on Windows when present, else `go` on `PATH` ([tools-build.mjs](../scripts/tools-build.mjs)) | `npm run limit:*`, `npm run update-check:*`, `manage.mjs status` |
| `dist/host/bundle/` | `npm run host:build` | Capsule, Host, and management scripts |
| `dist/capsule/input-capsule.js` | `npm run capsule:build` | Host `apply`/`plan --capsule-code`; `capsule:install` assembles its own copy in memory |
| `dist/localization/bundle/` | `npm run localization:build` | `scripts/localization.mjs`, localization Host features and tests |

The Host and localization loaders compare every input and output hash in their
`build-manifest.json` and refuse with a "stale or incomplete" error after a
source edit until you rebuild. The npm wrappers (`capsule:install`, `capsule:uninstall`, `host-patch`,
`localization`, `test`, `test:localization`) rebuild the bundles they need first;
direct `node scripts/...` calls, including `manage.mjs`, do not.

## Vendored components

- [scripts/vendor/asar-engine.cjs](../scripts/vendor/asar-engine.cjs) reads, validates, extracts, and packs ASAR archives for [host-patch.mjs](../scripts/lib/host-patch.mjs). Node tests such as [install-safety.test.mjs](../tests/node/install-safety.test.mjs) and [host-patch.test.mjs](../tests/node/host-patch.test.mjs) exercise it.
