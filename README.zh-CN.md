# agyctl

[English](README.md) | 简体中文

面向 Google Antigravity 桌面客户端的 sidecar 插件，实时显示上下文窗口用量、服务器端 token 计数和生成速率估算。面板通过 Connect-RPC 读取本地 Language Server，不修改客户端。

三个可选功能会修改已安装的客户端：输入栏胶囊、客户端界面本地化和上下文上限补丁。每个都保留经过校验的原始备份，并提供各自的移除或还原命令。

| 组件 | 用途 | 是否修改客户端 |
| --- | --- | --- |
| Sidecar 面板 | 用量、会话、价格和设置；列出可选修改的终端命令 | 否；只显示这些命令，不会执行 |
| 输入栏胶囊（capsule） | 在发送按钮旁显示上下文用量 | 是，`app.asar` |
| 客户端界面本地化 | 翻译 Antigravity 界面；通过 `node scripts/manage.mjs` 准备并应用（[说明](docs/localization.md)） | 是，`app.asar` |
| 上下文上限补丁 | 提高按模型的 checkpoint token 上限 | 是，`language_server.exe` |
| 兼容性检查器 | 检查已安装的客户端或官方安装包 | 否，仅校验 |

## 状态与兼容性

版本 0.1.0（`package.json`）。

- **目标客户端：** Antigravity Hub 2.x 和 Insiders 1.0.x。
- **客户端修改：** 在 Antigravity 关闭时通过 CLI 应用；面板只负责监控。本文中的路径使用 Windows 写法。
- **兼容性检查：** 检查 Windows x64、Linux x64 和 macOS Apple Silicon 的官方 Hub 与 Insiders 安装包。
- **上限补丁：** 仅当 clamp 字节与 [compat/versions.json](compat/versions.json) 中记录的原始签名匹配时才准入，与版本号无关。`npm run limit:versions` 列出已记录的构建；每条记录的 `notes` 说明其验证程度（静态、只读试运行或实时）。所选二进制文件的 `compat.status`（`verified-exact`、`version-match` 或 `unverified`）仅供参考，不改变该准入条件。

## 快速开始

需要 Node.js 26.13 或更高的 26.x 版本。本指南中的所有命令均从项目根目录运行。安装面板：

```bash
npm ci
npm run plugin:install
```

安装后，通过宿主支持的生命周期重新加载插件，或正常退出并重新打开 Antigravity。安装完成不代表已经激活；请打开面板确认它已加载。没有专用的面板移除脚本。

安装程序先在 `%USERPROFILE%\.gemini\config\plugin-backups\` 下校验并暂存插件，再切换到 `%USERPROFILE%\.gemini\config\plugins\agyctl\`。旧版本和失败的安装保留在发现目录之外，宿主不会加载重复插件。

侧边栏包含 **Overview**、**Sessions** 和 **Settings**：

- **Overview** — 本地会话的 token 与费用合计（今天、7 天或全部）、input/cache/thinking/output 构成、14 天图表和按模型用量。子代理用量计入其父会话。
- **Sessions** — 可搜索的会话列表。
- **Settings** — 面板语言、刷新间隔、自定义模型价格（美元/百万 token）和可选客户端修改的终端命令。Settings 从不修改客户端。

用量合计覆盖当前运行客户端的本地历史，不是云端账户总量。

## 准备工具

面板从不修改已安装的客户端。胶囊、上下文上限和本地化都在项目文件夹的终端中应用，且 Antigravity 必须已关闭。每个命令都会先检查已安装的文件，无法识别的内容一律不写入。

CLI 上限命令和兼容性检查需要已构建的 `agyctl` 可执行文件。安装 Go 1.26 或更高版本后运行：

```bash
npm ci
npm run tools:build
```

若已安装依赖，可跳过 `npm ci`。`.npmrc` 设置了 `ignore-scripts=true`，因此安装依赖时不运行生命周期脚本。构建会生成 `dist/bin/<goos>-<goarch>/agyctl`（Windows 上为 `.exe`），并从本仓库读取 `compat/`，请通过 `npm run limit:*` 与 `npm run update-check:*` 脚本运行。面板监控、语言/价格设置，以及仅操作胶囊的命令都不需要此 Go 构建。

更新项目时，拉取仓库后运行 `npm ci` 与 `npm run plugin:install`；`src/agyctl/` 有变更时需重新构建工具。

## 使用 CLI

### 安装或移除输入栏胶囊

胶囊在发送按钮旁显示实时上下文用量，并提供会话缓存命中率、按模型分发比例和主代理/子代理切换。若尚未安装依赖，先运行 `npm ci`；npm Capsule 命令会自动构建所需的 Host 包。

**安装或移除前请确认目标。** 普通 Capsule 命令没有独立的目标选择参数：它们选择第一个检测到的安装实例，目前 Insiders 优先于 Hub。若两者均已安装，请使用[经过审阅的 Host 命令](docs/operations.md#reviewed-host-changes)明确指定安装/移除目标。不要假定目标就是当前运行的客户端。

安装时运行以下命令。它会立即写入，默认不做试运行：

```bash
npm run capsule:install
```

若客户端提供的网页包不再包含胶囊挂载所需的锚点，安装会拒绝并列出缺失项，且不写入任何内容。安装成功后，请正常重新打开目标客户端并确认胶囊已出现：归档校验通过不代表胶囊已挂载。添加、移除或保留本地化的变更会在客户端运行时拒绝执行。仅涉及胶囊的安装或移除不会检查客户端进程，因此请先自行关闭目标客户端，完成后再重新打开。

移除时，再次确认目标，然后运行：

```bash
npm run capsule:uninstall
```

移除会保留已有本地化。完成后请重新打开目标客户端。安装程序将原始文件保存在不可变、按安装实例区分的备份中，并以哈希配对；移除要求配对匹配，`--force` 也不能绕过配对。详见[胶囊备份](docs/operations.md#capsule-backups)。

### 调整或还原上下文上限

补丁在替换逻辑的后续限制之前，提高按模型的候选 checkpoint token 上限。它改写已准入的 clamp 函数体和模型 ID 表，不修改远程配置或其他配置函数。这不能证明实际窗口必然增大，也不能证明端到端压缩行为保持不变。详见[二进制分析](docs/context-chain-analysis.md)。

#### 检查与预览

先[构建工具](#准备工具)。以下 PowerShell 示例明确指向默认的 Windows Insiders 安装实例。若要修改 Hub 或其他安装路径，请在继续前修改 `$binary`。预览、应用、验证和还原时，保持使用同一终端和目标。

```powershell
$binary = Join-Path $env:LOCALAPPDATA 'Programs\antigravity-insiders\resources\bin\language_server.exe'
npm run limit:versions
npm run limit:status -- --binary "$binary"
npm run limit:patch -- --binary "$binary"
```

检查状态 JSON 中的 `binary`、`app_version`、`compat` 和 `patch_state`。补丁命令默认试运行：对于原始二进制文件，应看到 `dry_run: true`、`applied: false` 和 `plan`。已安装的函数必须匹配已记录的原始字节签名；仅凭版本字符串不能授权打补丁。

未指定 `--binary` 时，上限命令选择第一个发现的 Language Server，目前 Insiders 优先于 Hub。可选的 `--ids` 和 `--limit` 在预览和应用时必须保持一致。默认 ID 为 `1318-1320,1400-1405,1417-1419`，上限为 `500000` token。若已存在相同补丁，会返回 `already_patched: true`；修改设置需先还原。

#### 应用

保存工作并正常退出所选的 Antigravity 安装实例。该实例的客户端或 Language Server 仍在运行，或无法确认其状态时，都会拒绝应用。其他安装实例的 Language Server 不会阻挡此目标。此 CLI 不会关闭或重新启动客户端。仅在审阅预览并确认目标后，运行：

```powershell
npm run limit:patch -- --binary "$binary" --apply
```

#### 验证并重新打开客户端

应看到 `applied: true` 和备份记录；若已有相同补丁且无需变更，则为 `already_patched: true`。重新检查已安装的文件：

```powershell
npm run limit:status -- --binary "$binary"
```

确认 `patch_state.kind` 为 `patched`，其中的 `ids` 和 `limit` 符合请求，并检查 `sibling_backup.verified` 和 `repo_backup.verified`。然后正常重新打开 Antigravity。

#### 需要时还原

撤销补丁或修改设置时，先保存工作并再次退出 Antigravity。还原会立即写入并校验备份校验和；若二进制文件已被应用更新替换，则拒绝覆盖。

```powershell
npm run limit:restore -- --binary "$binary"
```

应看到 `restored: true` 或 `already_restored: true`，然后运行上面的状态命令，确认 `patch_state.kind` 为 `original`。重新打开客户端，或在应用不同设置前预览新补丁。

备份位置：Windows 为 `%LOCALAPPDATA%\agyctl\backups\`，macOS 为 `~/Library/Application Support/agyctl/backups/`，Linux 为 `$XDG_STATE_HOME/agyctl/backups/`（未设置 `XDG_STATE_HOME` 时为 `~/.local/state`）。`AGYCTL_HOME` 可覆盖产品主目录。

### 检查兼容性

先[构建工具](#准备工具)。检查器检查已安装的客户端，或下载并解包官方安装包，以检查上下文上限、模型目录和胶囊挂载点。它会写入报告，但绝不安装补丁或运行解包内容。这是独立的 CLI 任务。

检查已安装的客户端时，明确选择渠道（`insiders`，或用 `antigravity` 指定 Hub）：

```bash
npm run update-check:local -- --channel insiders
```

该检查只读取所选目标的已安装文件，不会连接正在运行的客户端。

用 `--install-dir` 明确指定安装根目录。未指定目标时，本地检查选择第一个检测到的安装实例，目前 Insiders 优先于 Hub。对于下载的安装包，渠道名称则包含 `hub`。未指定 `--channel` 和 `--platform` 时，`check` 检查 Hub 渠道在当前运行机器平台上的安装包；要检查其他目标，请同时指定两者：

```bash
npm run update-check:versions
npm run update-check:check -- --channel hub --platform win-x64
```

检查两个渠道（Hub、Insiders）与三个平台（`win-x64`、`darwin-arm64`、`linux-x64`）的所有组合：

```bash
npm run update-check:check -- --matrix
```

阅读 JSON 结果和保存在 `var/update-check/reports/` 下的报告。结论为 `compatible`、`needs-review` 或 `incompatible`（退出码 0、1、2；`--matrix` 返回最差的一格；3 表示检查本身失败）。结论只是初步筛查，不代表已实时激活，也不授权打补丁：每项功能在应用时各自执行精确的准入检查，`node scripts/manage.mjs status` 可只读地报告已安装客户端的这些检查结果。详见[检查器指南](docs/update-check.md)。

## 数据来源与准确性

- Token 计数来自 Language Server：prompt、cache read、thinking 和 response output，从不回退到本地估算。
- 速率（流式 tok/s、单请求吞吐、TTFT、总耗时、近期同模型平均值）是基于 Language Server 计时的估算，不代表引擎端模型速度。未确认或不足一秒的窗口会被标记。
- 胶囊中按来源的构成拆分根据自定义项数量估算，并标注为估算值。
- 过期数值、不完整历史、未知容量和缺失价格都会如实显示。
- 运行时监控不使用 CDP，也不开启远程调试端口。

## 开发

Node.js 26.13 或更高的 26.x 版本（`.nvmrc`、`engines`）。开发工具：Go 1.26 或更高版本；可选的 `uv`，用于隔离启动钩子；以及 `PATH` 上的 `gitleaks` 和 `golangci-lint` v2.x，供各自的检查使用。不需要项目 Python 环境。

```bash
npm ci
uvx pre-commit install
```

请按变更选择最小的相关检查；以下是可用命令，不是必须全部运行的本地门禁。钩子只做变更文件的整洁与安全检查；正确性测试由[受影响的 CI 作业](.github/README.md)运行。

```bash
npm run lint
npm test                  # 准备核心产物并运行核心 Node 测试
npm run test:run           # 同一测试集，使用现有产物
npm run test:localization  # 构建本地化并运行其测试
npm run typecheck
npm run host:typecheck
npm run tools:test
npm run test:vendor-sync   # 可选：检查已记录的 vendor-src 快照
npm run test:electron      # 可选：需要固定版本 Electron 44.10.2，且 PATH 上有 OpenSSL
```

缺少前置条件（已安装的客户端、Electron、已构建的本地化产物、`vendor-src` 快照或真实样本）的测试会报告 **SKIP** 并说明原因；跳过从不记为通过。在信任全绿结果前请先查看跳过项：例如，除非已通过 `npm run test:localization`（或 `npm run localization:build`）构建 `dist/localization`，Host 测试中的本地化用例会跳过。若要使用已安装 devDependency 之外的 Electron，可设置 `AGYCTL_ELECTRON_EXECUTABLE`。

胶囊以单个自包含文件发布。共享逻辑位于 `src/plugin/lib/` 下的 ES 模块（`metrics-core.mjs` 与 `pricing-core.mjs` 为共享的指标与定价逻辑），由 `scripts/capsule-build.mjs` 组装进胶囊。`capsule:install` 会在内存中重新组装同一批源码，因此不会安装过时的 `dist` 文件：

```bash
npm run capsule:build       # regenerate dist/capsule/input-capsule.js (build output; do not edit)
```

| 路径 | 用途 |
| --- | --- |
| `src/plugin/` | Sidecar 面板和共享遥测逻辑 |
| `src/capsule/` | 输入栏胶囊源码 |
| `src/host/` | 中立 ASAR 合成、备份、收据、交易协调与工具日志 |
| `src/localization/` | 本地化转换、运行时交付和自身 Host 功能 |
| `src/agyctl/` | Go CLI：兼容性检查器与上限补丁工具 |
| `scripts/` | 构建、安装和 Host 入口 |
| `compat/` | 签名、安装布局和本地化配置 |
| `tests/` | Node 和 Electron 测试；Go 测试与其包放在一起 |
| `docs/` | 架构、运维、本地化、检查器与逆向分析参考 |

## 文档

以下文档为英文：

- [docs/architecture.md](docs/architecture.md) — 稳定的组件边界与数据流
- [docs/operations.md](docs/operations.md) — 客户端修改、面板设置、备份、恢复与本地化应用
- [docs/localization.md](docs/localization.md) — 本地化流程、已记录的配置档、离线准备与真实客户端证据
- [docs/update-check.md](docs/update-check.md) — 兼容性检查流程
- [docs/context-chain-analysis.md](docs/context-chain-analysis.md) — 上下文上限字节证据与补丁/恢复边界
- [docs/upstream-analysis.md](docs/upstream-analysis.md) — 已检查的上游构建、包内成员定位与可重现的宿主/网页资源分析
- [docs/development.md](docs/development.md) — 工具链固定与供应链

## 许可证

`package.json` 声明的许可证为 MIT。
