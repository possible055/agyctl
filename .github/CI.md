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
| `compat/localization/profiles.json` | Node correctness, shared Go correctness (the checker reads it) |
| Other `compat/localization/` | Node correctness |
| `src/host/`, `src/localization/`, `src/capsule/`, `src/plugin/`, Node/Electron tests, other `scripts/`, root TypeScript configuration, `biome.jsonc` | Node correctness |
| `scripts/tools-build.mjs`, `scripts/agyctl.mjs`, `scripts/lib/agyctl.mjs`, `scripts/lib/install-paths.mjs`, `.npmrc`, `.nvmrc` | Node correctness, native packaging |
| `package.json`, `package-lock.json` | Node correctness, native packaging, npm advisories |
| Other paths, including shared `compat/` contracts and workflow configuration | All jobs |

Native packaging builds only the Go tool, so Host, localization, capsule, and panel changes do not select it.

## Jobs

| Job | Runner | Checks |
| --- | --- | --- |
| Select checks | Ubuntu 24.04 | Selection/gate contract tests and changed-path selection |
| Repository security | Ubuntu 24.04 | Full-history Gitleaks, actionlint, offline zizmor |
| Node correctness | Windows 2025 x64 | Biome, Host/Capsule/localization artifact preparation once, core Node and localization suites, required three-locale Electron localization contracts, panel/Host/localization/Capsule typechecks |
| Go correctness (shared) | Ubuntu 24.04 x64 | Formatting, lint under all supported build constraints, vet, full Go suite once |
| Native packaging | Windows 2025 x64, macOS 15 Apple Silicon, Ubuntu 24.04 x64 | Assert native runner target; Windows/macOS OS-boundary packages; build the tool for the target; smoke-test `limit:versions` |
| npm advisories | Ubuntu 24.04 | OSV-Scanner on `package-lock.json` |
| Reachable Go vulnerabilities | Ubuntu 24.04 | govulncheck for `linux/amd64`, `windows/amd64`, `darwin/arm64` |
| CI passed | Ubuntu 24.04 | Required gate |

The native matrix explicitly sets `GOOS`, `GOARCH`, and `CGO_ENABLED=0`. It admits exactly `windows/amd64`, `darwin/arm64`, and `linux/amd64`; output belongs under `dist/bin/<os>-<arch>/`. GitHub's [runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) identifies `macos-15` as ARM64 and `macos-15-intel` as Intel. The job also asserts Node's actual host identity before executing native tests.

Windows/macOS boundary checks cover `fsx`, `layout`, `assets`, and `winproc`; Linux is covered by the shared suite when Go sources change. The generic full suite is not repeated on every native target.

These checks use synthetic/local fixtures, not downloaded installers or a live Antigravity client. Native packaging success does not qualify client patching, signing, or localization. Live-client cases report SKIP when prerequisites are absent; SKIP is not a pass. The Node job explicitly installs the locked Electron runtime and runs the localization Host/bootstrap and DOM contracts for all three locales with `AGYCTL_REQUIRE_ELECTRON=1`; missing or unusable Electron fails instead of skipping. The broader `test:electron` command, including Capsule scenarios, remains a separate local check. npm's other lifecycle scripts remain disabled.

## Local workflow

Run `npm ci` and, optionally, `uvx pre-commit install`. No project Python environment or `uv sync` is needed. Commit hooks perform changed-file hygiene/formatting, secret scanning, and the type checks and test suites selected by the `files:` patterns in [.pre-commit-config.yaml](../.pre-commit-config.yaml). The Node and localization test hooks build their required artifacts. Formatting hooks may rewrite files; review the diff afterwards. Push hooks run secret scanning only.

Choose the smallest relevant existing check. Aggregate commands remain convenient:

- `npm test`: build Host, Capsule, and localization (`test:prepare`), then run the core Node suite (`test:run`). `npm run test:localization` independently builds localization and runs its suite; CI reuses the prepared bundle with `test:localization:run`.
- `npm run tools:build`: build the native tool for this host (or `GOOS`/`GOARCH`) with `CGO_ENABLED=0 go build -trimpath -buildvcs=false`; see [build outputs](../docs/development.md#build-outputs).
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

Permissions are `contents: read`; checkout never persists credentials. The workflow uses no secrets or `pull_request_target` and publishes nothing. Actions are SHA-pinned, downloaded scanners are SHA-256 checked, and [Dependabot](dependabot.yml) proposes Action updates. npm lifecycle scripts stay disabled; Go uses `GOTOOLCHAIN=local` and `-mod=readonly`. Scanner findings/failures fail their jobs, without retries or `continue-on-error`. OSV covers npm; govulncheck covers reachable Go dependencies. Python is used only to launch the isolated workflow scanner.
