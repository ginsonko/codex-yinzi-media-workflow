# 安装、更新与恢复

## 安装器会改什么

从当前源码目录安装，不再下载第二份源码。安装会联网获取 Node.js 官方发行版（必要时）、npm 锁定依赖、校验后的 FFmpeg 独立工具；没有 Codex CLI 时安装官方 `@openai/codex` CLI。

| 位置 | 内容 |
| --- | --- |
| 当前仓库 | `node_modules`、前端构建、忽略提交的 FFmpeg 文件 |
| `%LOCALAPPDATA%\Yinzi\CodexVideoWorkflow` | 运行时登记、日志、工具缓存、本地配置、SQLite 与媒体 |
| `~/.agents/skills` | 媒体与文本 Skill 的目录链接，指向安装源码，保留相对脚本依赖 |
| Codex 配置 | 名为 `yinzi_video_workflow` 的 MCP 工具；支持完整插件命令的 CLI 则注册插件 |

Codex 官方 [Skills 目录说明](https://developers.openai.com/codex/skills) 支持 `.agents/skills` 和目录链接。源码必须留在固定目录，不能安装后删除。一个新 Codex 任务会发现 Skills；若工具缓存尚未更新，重启 Codex。当前任务可直接用仓库 Skill 内的 CLI。

安装不会配置模型 Key、调用付费模型或上传素材。你可以全程跳过 Key 配置。

## 日常打开

双击 `start.cmd`。服务已经在运行时只打开真实页面；没有服务时启动后台，再打开页面。端口自动退避，以返回的网址为准。首页可添加带图标的 Windows 桌面快捷方式。

浏览器被系统策略阻止自动打开时，复制终端最后输出的 `frontend_url` 打开即可，也可以让 Codex 帮你打开。

## 更新

Git 安装：`git pull --ff-only` 后运行 `install.cmd`。源码修改导致无法快进时，保留修改，让 Codex 帮助合并。

ZIP 安装：解压新版本到固定的新目录，再运行新目录的安装器；默认继续使用相同本机数据目录。安装器只替换自己登记的 Skill 目录链接，不删除自建 Skill。安装完成后新建 Codex 任务。

## 常见问题

| 看到的情况 | 怎么处理 |
| --- | --- |
| PowerShell 禁止运行脚本 | 双击 `install.cmd`；它只在本次进程使用 ExecutionPolicy Bypass，不修改系统策略 |
| 下载失败/校验失败 | 保留错误，检查代理和网络后重跑；校验失败的包不会安装 |
| npm 原生依赖失败 | 使用 Node.js 22 LTS 与 Windows x64；将终端错误交给 Codex，检查预编译包下载是否被拦截 |
| 没看到 Skill 或工具 | 新建任务；仍没有则重启 Codex，检查 installation.json 的安装模式 |
| 已有同名自建 Skill | 安装器保留它；让 Codex 比较并迁移，避免覆盖你的改进 |
| 旧地址打不开 | 运行 `start.cmd` 获取当前地址；不用猜 5679 或其他端口 |
| 缺少图片/视频模型 | 打开“模型与 Key”；先完成本地任务，按需添加配置 |
| 上游任务状态不明 | 给 Codex 原任务详情，先查询/对账，不重复生成 |

## 隔离演练与开发参数

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -StateRoot D:\YinziTest\state -CodexHome D:\YinziTest\codex -SkillsRoot D:\YinziTest\skills -NoBrowser
```

这会把本轮演练运行时与 Codex 配置放在指定目录，不接触默认配置。不提供这些参数时按当前用户正常安装。
`-SkipCodexInstall` 只启动本地工作台；`-NoBrowser` 只输出地址。`start.ps1 -StateRoot ...` 继续打开该隔离实例。

## 备份与卸载

备份运行时目录（其中包含模型凭据），存放在自己的受控位置。不要上传数据库或备份包到 Issue。
若要卸载，请让 Codex 按 `installation.json` 和 `skill-installation.json` 找到本项目安装项，移除对应 MCP/插件和 Skill 链接。删除源码前先处理这些链接。默认保留运行时目录中的项目、Key 和媒体；只有你明确要删除这些数据时才删除。

Blender 为可选依赖，安装后在高级设置填写路径或让 Codex 自动检测。它不影响普通素材整理、剪辑和 Three.js 预览。
