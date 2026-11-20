# CI

[`workflows/ci.yml`](workflows/ci.yml) defines **CI**. [`ci.mjs`](ci.mjs) selects affected jobs and evaluates the required gate; [`ci.test.mjs`](ci.test.mjs) checks those contracts.

This file is not named `README.md`: GitHub gives `.github/README.md` priority over the repository README on the repository home page, which would shadow the project README.

## Required check

Require **CI passed** in branch protection or a ruleset. It requires successful selection and repository security, success for every selected job, and an intentional skip for every unselected job. A missing, cancelled, or unexpectedly skipped job fails the gate.

## Triggers and selection

| Event | Checks run |
| --- | --- |
| `pull_request` | Repository security plus affected jobs |
| `push` to `main`, `merge_group`, `workflow_dispatch` | All jobs |
| Weekly schedule | Repository security, npm advisories, Go vulnerabilities |

PR selection diffs full base/head SHAs with rename detection disabled. Deletions and both sides of a rename select checks; invalid SHAs fail selection.

| Changed path | Selected jobs |
| --- | --- |
| `docs/`, `vendor-src/`, root `README*.md`, `AGENTS.md`, `LICENSE`, this page | None |
| `src/agyctl/` | Shared Go correctness, native packaging, Go vulnerabilities |
| `compat/localization/profiles.json` | Node correctness, native/npm packaging, shared Go correctness (the checker reads it) |
| Other `compat/localization/` | Node correctness, native/npm packaging |
| `bin/`, `src/host/`, `src/localization/`, `src/capsule/`, `src/plugin/`, Node/Electron tests, other `scripts/`, root TypeScript configuration, `biome.jsonc` | Node correctness, native/npm packaging |
| `scripts/tools-build.mjs`, `scripts/agyctl.mjs`, `scripts/lib/agyctl.mjs`, `scripts/lib/install-paths.mjs`, `.npmrc`, `.nvmrc` | Node correctness, native packaging |
| `package.json`, `package-lock.json` | Node correctness, native packaging, npm advisories |
| Other paths, including shared `compat/` contracts and workflow configuration | All jobs |

Packaging includes the prebuilt Node assets and their validation inputs as well as the native tools. Changes to these shipped inputs select packaging so missing runtime dependencies cannot hide behind a source-checkout test.

## Jobs

| Job | Runner | Checks |
| --- | --- | --- |
| Select checks | Ubuntu 24.04 | Selection/gate contract tests and changed-path selection |
| Repository security | Ubuntu 24.04 | Full-history Gitleaks, actionlint, offline zizmor |
| Node correctness | Windows 2025 x64 | Biome, Host/Capsule/localization artifact preparation once, core Node and localization suites, required three-locale Electron localization contracts, panel/Host/localization/Capsule typechecks |
| Go correctness (shared) | Ubuntu 24.04 x64 | Formatting, lint under all supported build constraints, vet, full Go suite once |
| Native and npm packaging | Windows 2025 x64, macOS 15 Apple Silicon, Ubuntu 24.04 x64 | Assert native runner target; Windows/macOS OS-boundary packages; build all supported native targets and Node assets; smoke-test `limit:versions`; pack and globally install the tarball into an isolated prefix outside the checkout; run packaged commands without compilers on PATH |
| npm advisories | Ubuntu 24.04 | OSV-Scanner on `package-lock.json` |
| Reachable Go vulnerabilities | Ubuntu 24.04 | govulncheck for `linux/amd64`, `windows/amd64`, `darwin/arm64` |
| CI passed | Ubuntu 24.04 | Required gate |

The native matrix explicitly sets `GOOS`, `GOARCH`, and `CGO_ENABLED=0`. It admits exactly `windows/amd64`, `darwin/arm64`, and `linux/amd64`; output belongs under `dist/bin/<os>-<arch>/`. GitHub's [runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) identifies `macos-15` as ARM64 and `macos-15-intel` as Intel. The job also asserts Node's actual host identity before executing native tests.

Each packaging runner builds the complete tarball with [`scripts/npm-package.mjs`](../scripts/npm-package.mjs). Its allowlist comes from `package.json`; `dist/npm-package-manifest.json` records the package version, exact supported targets, and SHA-256s of every packaged file other than that manifest itself. Verification checks native executable headers, the Host/localization build manifests and their shipped inputs, capsule freshness, and npm's actual packlist. It refuses missing, changed, or unexpectedly included files. These hashes detect incomplete or stale local artifacts; they are not a publisher signature.

The isolated tarball smoke uses `npm install --global --ignore-scripts --omit=dev --offline` with a temporary prefix and tool-state directory. It checks CLI help/version, the native registry command, Host/localization verification, capsule assembly, and refusal of an invalid install target, with an empty compiler PATH. It does not change an installed Antigravity client. Dependencies required by the bundled localization tools are already in the built artifacts; no consumer Go, TypeScript, esbuild, Electron download, or npm lifecycle hook is required.

Windows/macOS boundary checks cover `fsx`, `layout`, `assets`, and `winproc`; Linux is covered by the shared suite when Go sources change. The generic full suite is not repeated on every native target.

These checks use synthetic/local fixtures, not downloaded installers or a live Antigravity client. Native packaging success does not qualify client patching, signing, or localization. Live-client cases report SKIP when prerequisites are absent; SKIP is not a pass. The Node job explicitly installs the locked Electron runtime and runs the localization Host/bootstrap and DOM contracts for all three locales with `AGYCTL_REQUIRE_ELECTRON=1`; missing or unusable Electron fails instead of skipping. The broader `test:electron` command, including Capsule scenarios, remains a separate local check. npm's other lifecycle scripts remain disabled.

## Local workflow

Run `npm ci` and, optionally, `uvx pre-commit install`. No project Python environment or `uv sync` is needed. Commit hooks perform changed-file hygiene/formatting, secret scanning, and the type checks and test suites selected by the `files:` patterns in [.pre-commit-config.yaml](../.pre-commit-config.yaml). The Node and localization test hooks build their required artifacts. Formatting hooks may rewrite files; review the diff afterwards. Push hooks run secret scanning only.

Choose the smallest relevant existing check. Aggregate commands remain convenient:

- `npm test`: build Host, Capsule, and localization (`test:prepare`), then run the core Node suite (`test:run`). `npm run test:localization` independently builds localization and runs its suite; CI reuses the prepared bundle with `test:localization:run`.
- `npm run tools:build`: build the native tool for this host (or `GOOS`/`GOARCH`) with `CGO_ENABLED=0 go build -trimpath -buildvcs=false`; see [build outputs](../docs/development.md#build-outputs).
- `npm run package:build`: build Host, Capsule, localization, and all three native targets, then write and verify the npm package manifest. This developer step requires the locked build dependencies and Go.
- `npm run package:verify`: check existing package artifacts without building, downloading, installing, or changing the client.
- `npm run package:pack -- --pack-destination var`: verify and pack the prebuilt distribution. The wrapper uses npm with lifecycle hooks disabled after explicit verification, then validates tar headers and restores executable mode on exactly the two Unix native binaries. npm packing on Windows otherwise loses these modes; direct lifecycle-enabled `npm pack` on Windows refuses with this command as the remedy. On Unix, `npm pack` runs verification through `prepack`; the repository's `.npmrc` disables hooks, so use the canonical wrapper for a checked archive on every host.
- `npm run package:smoke -- /absolute/path/agyctl-VERSION.tgz`: run the isolated no-compiler installation check against an existing local tarball.
- `npm run test:vendor-sync`: prepare localization and check the optional vendor snapshot. `test:vendor-sync:run` uses existing artifacts.

Run the selection and repository scanners independently, with the pinned tools in `ci.yml` on PATH:

```sh
node --test .github/ci.test.mjs
actionlint
uvx zizmor==1.32.0 --offline --strict-collection --no-progress .github/
gitleaks git --redact --no-banner .
osv-scanner scan source --lockfile=package-lock.json
```

## Security properties

Permissions are `contents: read`; checkout never persists credentials. The workflow uses no secrets or `pull_request_target` and publishes nothing. Actions are SHA-pinned, downloaded scanners are SHA-256 checked, and [Dependabot](dependabot.yml) proposes Action updates. npm lifecycle scripts stay disabled; package building, verification, and local tarball creation run as explicit commands, not install hooks. Go uses `GOTOOLCHAIN=local` and `-mod=readonly`. Scanner findings/failures fail their jobs, without retries or `continue-on-error`. OSV covers npm; govulncheck covers reachable Go dependencies. Python is used only to launch the isolated workflow scanner.
