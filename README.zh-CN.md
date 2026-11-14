# agyctl

[English](README.md) | 简体中文

agyctl 面向 Antigravity 2.31.0 桌面应用（正式版），添加上下文用量面板，并提供几项会修改应用的可选工具：输入栏用量胶囊、界面本地化，以及更高的上下文上限。旧版兼容记录仅作为历史证据，不再是当前验收目标。

## 功能

| 功能 | 作用 | 是否修改应用 |
| --- | --- | --- |
| [侧边栏面板](#侧边栏面板) | 在侧边栏显示 token 用量、费用、会话和设置 | 否 |
| [输入栏胶囊](#输入栏胶囊) | 在发送按钮旁显示实时上下文用量 | 是，`app.asar` |
| [客户端本地化](#客户端本地化) | 将界面翻译为繁体中文、简体中文或日语 | 是，`app.asar` |
| [上下文上限补丁](#上下文上限补丁) | 提高指定模型的上下文上限 | 是，`language_server.exe` |
| [兼容性检查](#兼容性检查) | 检查你的应用版本是否支持这些功能 | 否 |

胶囊、本地化和上限补丁都会保留经过校验的原始文件备份，并且可以移除。

两个版本使用下面相同的命令。兼容性根据所选安装的文件检查，不是按版本号范围放行；详见[本地化证据](docs/localization.md)和[上限补丁](docs/limit-patch.md)。同时保留两个版本时，用 `AGYCTL_APP_DIR` 选择一个。Antigravity 更新后应检查功能状态、重新准备本地化计划，不要应用旧计划或还原其他构建的备份。文件补丁成功不代表已经验证运行时激活。

## 开始使用

需要 [Node.js](https://nodejs.org/) 26.x（26.13 或更新）。克隆项目并安装依赖；之后的命令都在这个文件夹的 PowerShell 中执行：

```powershell
git clone https://github.com/possible055/agyctl.git
cd agyctl
npm ci
```

agyctl 会自动检测默认的 Antigravity 安装位置。使用自定义文件夹或存在多个安装时，请选择包含 `Antigravity.exe` 的文件夹：

```powershell
$env:AGYCTL_APP_DIR = 'D:\Apps\Antigravity'   # 仅自定义位置或明确选择安装时需要
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

重新打开 Antigravity，进入 **Settings → 补丁**。界面会自动填入已安装的设置。模型来自当前登录账号的 Language Server 模型列表，并对应到所选安装版本的数字枚举 ID；按名称选择模型，包括 Low／Medium／High 变体。新模型默认填入 256,000 token 且不勾选；面板接受 256,000–896,000。选择功能、语言与各模型上限，点击**保存设置**。自行退出 Antigravity，再运行面板显示的 `npm run settings:apply -- --draft <id>`。工具会应用选中的更改，不会关闭或重新启动应用。应用完成后重新打开，界面会从已安装文件读回设置。不可用模型、等待中的操作与恢复方式见[补丁控制](docs/operations.md#panel-patch-controls)。下方命令仍可作为替代方式使用。

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

保存的计划绑定了确切的安装位置；改变 `AGYCTL_APP_DIR` 不会重定向计划。重新打开 Antigravity，检查界面语言。目前的本地化配置档都是 `probe-only`；安装成功不代表已验证真实客户端激活。

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

修改已安装补丁时，先退出 Antigravity，使用下面的命令还原，再预览并应用完整的新映射。映射会替换所选模型集合，不会合并旧 ID。`--model-limits` 不能与旧的 `--ids`／`--limit` 同时使用。旧命令仍支持一个共用下限。不传设置参数时，补丁命令会在适用时沿用检测到的已安装设置或上次保存的补丁设置，否则使用内置的 500,000 token 和默认 ID。明确还原后不会沿用已保存设置；再次应用时应传入完整映射。应用更新可能移除补丁：`settings_state` 会区分已保存设置与当前文件，不会自动重新应用。

**移除。** 先退出 Antigravity，再执行：

```powershell
npm run limit:restore
```

输出应包含 `restored: true` 或 `already_restored: true`。再次运行状态命令，确认 `patch_state.kind` 为 `original`，再重新打开 Antigravity。

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
npm run tools:build   # 仅在使用上限补丁或兼容性检查时需要
```

安装完成后重新打开 Antigravity。

## 备份

默认情况下，应用原始文件保存在 `%LOCALAPPDATA%\agyctl\backups\`；`AGYCTL_HOME` 可更改工具状态根目录。上限补丁还会在 Language Server 旁保留原始文件，面板备份则单独存放在 `~/.gemini/config/plugin-backups/`。请勿删除或覆盖移除功能所需的原始文件。详见[备份与恢复](docs/operations.md#recovery-boundaries)。

## 文档

- [架构](docs/architecture.md)
- [操作指南](docs/operations.md)：目标选择、备份与恢复
- [本地化](docs/localization.md)
- [兼容性检查](docs/update-check.md)
- [上下文上限补丁](docs/limit-patch.md)
- [开发](docs/development.md)：环境、测试与项目结构

## 许可证

MIT。见 [LICENSE](LICENSE)。
