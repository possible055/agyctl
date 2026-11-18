# agyctl

[English](README.md) | 简体中文

agyctl 为 Antigravity 桌面应用添加上下文用量面板，并提供会修改已安装应用的可选工具：输入栏用量胶囊、界面本地化，以及针对上下文上限、工具输出容量和压缩摘要的语言服务器补丁。当前目标是 Windows 版 Antigravity 2.32.1（正式版渠道）。各功能有独立的资格状态，见下方各节链接；旧版本的记录仍保留，以便识别并移除其补丁。

## 功能

| 功能 | 作用 | 是否修改应用 |
| --- | --- | --- |
| [侧边栏面板](#侧边栏面板) | 在侧边栏显示 token 用量、费用、会话和设置 | 否 |
| [输入栏胶囊](#输入栏胶囊) | 在发送按钮旁显示实时上下文用量 | 是，`app.asar` |
| [客户端本地化](#客户端本地化) | 将界面翻译为繁体中文、简体中文或日语 | 是，`app.asar` |
| [上下文上限补丁](#上下文上限补丁) | 提高指定模型的上下文上限 | 是，`language_server.exe` |
| [原生工具输出容量补丁](#原生工具输出容量补丁) | 放宽已通过资格检查的构建中的原生工具输出限制 | 是，`language_server.exe` |
| [压缩摘要补丁](#压缩摘要补丁) | 在已通过资格检查的构建中改善上下文压缩时的摘要与请求保留量 | 是，`language_server.exe` |
| [兼容性检查](#兼容性检查) | 检查你的应用版本是否支持这些功能 | 否 |

胶囊、本地化、上限补丁、工具输出补丁和压缩摘要补丁都会保留经过校验的原始文件备份，并且可以移除。

正式版和开发版（Insiders）使用下面相同的命令，各功能分别检查是否允许修改。兼容性根据所选安装的文件检查，不是按版本号范围放行；详见[本地化状态](docs/localization.md#current-status)和[上限补丁](docs/limit-patch.md)。同时保留两个渠道时，用 `AGYCTL_APP_DIR` 选择一个。Antigravity 更新后应检查功能状态、重新准备本地化计划，不要应用旧计划或还原其他构建的备份。文件补丁成功不代表已经验证运行时激活。

## 开始使用

需要 [Node.js](https://nodejs.org/) 26.x（26.13 或更新）。克隆项目并安装依赖；之后的命令都在这个文件夹的 PowerShell 中执行：

```powershell
git clone https://github.com/possible055/agyctl.git
cd agyctl
npm ci
```

agyctl 会自动检测默认的 Antigravity 安装位置。使用自定义文件夹或存在多个安装时，请选择包含 `Antigravity.exe` 的文件夹：

```powershell
$env:AGYCTL_APP_DIR = '<installation-root>'   # 替换为你的安装文件夹
```

此变量只对当前终端生效。如需在以后打开的终端中复用，可选择运行 `[Environment]::SetEnvironmentVariable('AGYCTL_APP_DIR', $env:AGYCTL_APP_DIR, 'User')` 保存。命令中明确指定的路径优先；环境变量路径无效时会报错，不会改选其他安装。检测到多个安装时必须选择。`AGYCTL_HOME` 只控制工具状态和备份目录，不是应用位置。详见[安装选择](docs/operations.md#installation-selection)。

## 侧边栏面板

面板有三个标签页。**Overview** 显示今天、7 天或全部时间的 token 与费用总计，并按模型细分。**Sessions** 列出你的会话。**Settings** 编辑语言、刷新间隔、模型价格和补丁。用量只统计本应用的本地历史，不是云端账户总量。

**启用。** 先退出 Antigravity，再执行：

```powershell
npm run plugin:install
```

重新打开 Antigravity，检查侧边栏是否出现面板。

**移除。** 先退出 Antigravity，再执行：

```powershell
npm run plugin:uninstall
```

重新打开 Antigravity，检查面板是否消失。移除的插件文件夹保留在 `~/.gemini/config/plugin-backups/`；面板设置和价格数据不会删除。

### 补丁控制

先构建补丁工具（需要 Go 1.26 或更新版本），再退出 Antigravity 后更新面板：

```powershell
npm run host:build
npm run localization:build
npm run tools:build
npm run plugin:install
```

重新打开 Antigravity，进入 **Settings → 补丁**。界面会自动填入已安装的设置。展开**模型上下文上限**，从当前登录账号的 Language Server 模型列表选择模型；Gemini 的不同思考强度共用一行。新模型默认填入 256,000 token 且不勾选；新增或修改的值必须在 256,000–983,040 之间。**压缩摘要改善补丁**复选框控制[压缩摘要补丁](#压缩摘要补丁)；在 2.32.1 上可与模型上下文上限同时启用，旧版本只能二选一。点击**保存设置**只会保存草稿，不会立即应用。之后退出 Antigravity，按[补丁控制](docs/operations.md#panel-patch-controls)在终端应用草稿；该节也说明不可用模型与恢复方式。重新打开后，面板会从已安装文件读回设置。下方命令是终端替代方式。

## 输入栏胶囊

在发送按钮旁显示上下文用量、缓存命中率和各模型占比。

**启用。** 先退出 Antigravity，再执行：

```powershell
npm run capsule:build
npm run host-patch -- apply --capsule --capsule-code "$PWD\dist\capsule\input-capsule.js" --json
```

输出应包含 `"applied": true`，表示归档已安装，不代表胶囊已经激活。重新打开 Antigravity，检查发送按钮旁是否出现胶囊。

**移除。** 先退出 Antigravity，再执行：

```powershell
npm run host-patch -- remove --capsule --json
```

JSON 的 `removed` 中应包含 `capsule`。重新打开 Antigravity，检查胶囊是否消失；已安装的本地化会保留。

## 客户端本地化

翻译界面。支持的语言：`zh-Hant-TW`、`zh-Hans-CN`、`ja-JP`。

使用上面选定的安装位置，也支持 `AGYCTL_APP_DIR`。功能仍会先检查所选构建，再决定是否修改。

**启用。** 在面板中保存语言草稿，退出 Antigravity，再运行面板显示的
`npm run settings:apply -- --draft <id>`。同一变更也可从终端准备：

```powershell
npm run host:build
npm run localization:build
node scripts/manage.mjs prepare --localization --locale zh-Hans-CN
```

从输出中复制 `localizationPlan` 的路径并应用：

```powershell
node scripts/manage.mjs --host-apply --localization-plan '<localizationPlan 路径>'
```

保存的计划绑定了确切的安装位置；改变 `AGYCTL_APP_DIR` 不会重定向计划。重新打开 Antigravity，检查界面语言。

准备时会按已安装应用的精确版本选择配置档，未知版本直接拒绝，不会改用邻近版本。2.32.1 配置档还会翻译 SSH 远程连接与 MCP 对话框。所有配置档都是 `probe-only`：安装成功不代表每个界面都已翻译，见[验证状态](docs/localization.md#verification-status)。

**移除。** 先退出 Antigravity，再执行：

```powershell
npm run host-patch -- remove --localization --json
```

JSON 的 `removed` 中应包含 `localization`。重新打开 Antigravity，检查原始界面是否恢复；已安装的胶囊会保留。

详见[本地化指南](docs/localization.md)。

## 上下文上限补丁

为数字模型 ID 分别设置候选检查点下限，然后仍受后续模型和输出限制约束。例如 `1318=300000,1400=500000` 会在同一补丁中保留两个设置。这不保证有效上下文窗口达到设置值，也不会降低已经更大的候选值。ID 是构建相关的枚举值，不是显示名称；不要根据模型名称猜测 ID。详见[修改边界](docs/limit-patch.md#modification-boundary)。

需要 [Go](https://go.dev/dl/) 1.26 或更新。先构建一次 CLI：

```powershell
npm run tools:build
```

**预览**（不写入）：

```powershell
npm run limit:patch -- --model-limits '1318=300000,1400=500000'
```

**启用。** 先退出 Antigravity，再执行：

```powershell
npm run limit:patch -- --model-limits '1318=300000,1400=500000' --apply
```

**检查。** `patch_state.kind` 应为 `patched`，`patch_state.model_limits` 应包含两个 ID／值。每次重新运行状态命令，都会从已安装文件解码，无需记住上次的命令：

```powershell
npm run limit:status
```

面板 Settings 和胶囊详情也会显示所选安装在磁盘上的补丁状态，与服务器回报的会话容量分开。需要构建工具并安装／更新面板才能使用这个共享的只读显示；缺少面板或 CLI 时会显示不可用，不会声称补丁已应用。

在 2.32.1 上修改已安装补丁时，退出 Antigravity 后直接应用完整的新映射即可。旧版本需先使用下面的命令还原，再预览并应用新映射。映射会替换所选模型集合，不会合并旧 ID。`--model-limits` 不能与旧的 `--ids`／`--limit` 同时使用。旧命令仍支持一个共用下限。不传设置参数时，补丁命令会在适用时沿用检测到的已安装设置或上次保存的补丁设置，否则使用内置的 500,000 token 和默认 ID。明确还原后不会沿用已保存设置；再次应用时应传入完整映射。应用更新可能移除补丁：`settings_state` 会区分已保存设置与当前文件，不会自动重新应用。

**移除。** 先退出 Antigravity，再执行：

```powershell
npm run limit:restore
```

输出应包含 `restored: true` 或 `already_restored: true`。再次运行状态命令，确认 `patch_state.kind` 为 `original`，再重新打开 Antigravity。

## 原生工具输出容量补丁

放宽语言服务器的原生工具输出限制：读取文件由 800 行提高到 2,000 行、由 45 KiB 提高到 128 KiB，每步消息预算下限提高到 98,304 token，让较大的读取结果完整送达模型。传统 `grep_search` 的结果上限也提高到 100，但已测试的版本并未提供该工具。支持 Windows 2.32.1 与 2.31.2（2.31.2 配方另含原生 grep 修复）；每个版本只接受精确登记的 `language_server.exe`。这些数值是资格化目标，不是已实测的最大值。详见[状态与证据](docs/tool-output-patch.md)。

```powershell
npm run tool-output:status    # 查看所选安装的磁盘状态
npm run tool-output:patch     # 仅在内存生成计划，不写入
npm run tool-output:patch -- --apply    # 先退出 Antigravity
npm run tool-output:restore   # 精确回到套用前的输入
```

应用与还原要求客户端已关闭、备份经过校验；发现多个安装时必须显式传 `--binary`。其他工具的限制保持不变。在 2.32.1 上，此补丁可与上限及压缩补丁自由组合；在 2.31.2 上需先移除冲突的补丁。应用更新会移除补丁，不会自动重新应用。

## 压缩摘要补丁

改变 Antigravity 把长对话压缩成摘要时保留的内容（Windows 2.32.1）：

- **你的原始消息：** 上游只传入最近 10 条消息，并共用一个字节预算。补丁改为从最新开始完整保留你的消息，总计最多 61,440 UTF-8 字节。只有最旧的一条保留消息可能被截断，更早的消息直接省略。编号也计入预算，因此这既不是 token 数，也不是整个输入的大小。
- **摘要提示词：** `native`（默认）保留 Antigravity 自带的提示词；`custom` 改用你的文字，最多 3,937 UTF-8 字节。

压缩的触发时机与 `/compact` 本身不变。状态为 `candidate`：已在 Gemini 3.8 Flash High 上验证手动压缩；自动压缩与其他模型尚未取得验证资格。另保留一个 2.31.2 配方，但测试中其提示词修改未被采用。详见[状态与证据](docs/compaction-patch.md#status)及[操作流程](docs/operations.md#summary-compaction-patch)。

```powershell
npm run compaction:status -- --binary ABS_LS_PATH
npm run compaction:patch -- --binary ABS_LS_PATH --prompt-mode native    # 仅生成计划
npm run compaction:patch -- --binary ABS_LS_PATH --prompt-mode custom --prompt-file summary.txt    # 仅生成计划
npm run compaction:patch -- --binary ABS_LS_PATH --prompt-mode native --apply    # 先退出 Antigravity
npm run compaction:restore -- --binary ABS_LS_PATH
```

应用与还原遵循与其他语言服务器补丁相同的关闭客户端、校验备份与显式 `--binary` 规则。在 2.32.1 上，三个补丁合成同一个映像，因此每个都能单独启用、修改或移除，不影响其他补丁；见[原生组合](docs/operations.md#native-feature-composition)。在 2.31.2 上，它们保留各自的冲突检查。应用更新会移除补丁，不会自动重新应用。

## 兼容性检查

Antigravity 更新后、启用会修改应用的功能前执行。需要 [Go](https://go.dev/dl/) 1.26 或更新，并先用 `npm run tools:build` 构建 CLI。请查看各项能力及诊断信息：`needs-review` 表示至少有一项警告（包括 `probe-only` 本地化配置档），不代表所有功能都不可用。检查器只提供参考；能否修改所选文件，由各功能自己的预检决定。`compatible` 也不代表已经验证运行时激活。

```powershell
npm run update-check:local
```

改为检查最新的官方安装包：

```powershell
npm run update-check:check -- --channel hub --platform win-x64
```

详见[检查器指南](docs/update-check.md)。

## 更新 agyctl

替换已安装的面板前先退出 Antigravity，再执行：

```powershell
git pull
npm ci
npm run plugin:install
npm run tools:build   # 使用补丁控制、二进制补丁或兼容性检查时需要
```

安装完成后重新打开 Antigravity。

## 备份

在 Windows 上，应用原始文件默认保存在 `%LOCALAPPDATA%\agyctl\backups\`；`AGYCTL_HOME` 可更改工具状态根目录。上限补丁还会在 Language Server 旁保留原始文件，面板备份则单独存放在 `~/.gemini/config/plugin-backups/`。请勿删除或覆盖移除功能所需的原始文件。各平台路径见[备份位置](docs/operations.md#backup-locations)，恢复方式见[恢复边界](docs/operations.md#recovery-boundaries)。

## 文档

- [架构](docs/architecture.md)
- [操作指南](docs/operations.md)：目标选择、备份与恢复
- [本地化](docs/localization.md)
- [兼容性检查](docs/update-check.md)
- [上下文上限补丁](docs/limit-patch.md)
- [工具输出补丁](docs/tool-output-patch.md)
- [压缩摘要补丁](docs/compaction-patch.md)
- [开发](docs/development.md)：环境、测试与项目结构

## 许可证

MIT。见 [LICENSE](LICENSE)。
