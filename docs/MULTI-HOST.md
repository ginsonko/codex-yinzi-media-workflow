# 在其它 Agent 软件中使用媒体工作流

媒体能力通过 MCP 提供。已安装工作流后，在插件目录执行以下命令，选择目标软件即可；命令会自动准备适配器依赖，并写入 Node 与 MCP 服务的绝对路径：

```sh
node scripts/install-host.mjs --host cursor
```

| `--host` | 配置位置与格式 |
|---|---|
| `grok` | `GROK_HOME/config.toml`，默认 `~/.grok/config.toml`；同时安装到该根目录的 `skills` |
| `codex-cli` | `CODEX_HOME/config.toml`，默认 `~/.codex/config.toml` |
| `claude-desktop` | Claude Desktop 用户配置，`mcpServers` 对象 |
| `cursor` | `~/.cursor/mcp.json` |
| `cline` | VS Code 的 Cline 专属存储目录 |
| `roo-code` | VS Code 的 Roo Code 专属存储目录 |
| `continue` | 当前项目 `.continue/mcpServers/yinzi-workflow.json` |
| `vscode` | 当前项目 `.vscode/mcp.json`，`servers` 对象及 `stdio` 类型 |
| `zed` | Windows `%APPDATA%/Zed/settings.json`；macOS/Linux `~/.config/zed/settings.json`，支持 JSONC 注释 |

使用 `--config-path "目标文件"` 可选择其它配置位置；`--dry-run` 先显示将使用的位置。同名且内容一致时不会重写文件，同名内容不同时保留原配置并报告冲突。已有 JSONC/TOML 注释保留，变更前备份可以用适配器的 `rollback` 命令恢复。

软件支持 Skills 目录时，可同时传 `--skills-root "目标技能目录"`。安装沿用原工作流的技能复制和链接管理，已有用户自定义 Skill 会被保留。没有标准技能目录的软件可以先使用 MCP 工具；具体能力由 Agent 根据当前工具目录和素材决定。

其它软件或不同版本可使用 `scripts/host-adapters/install-adapter.mjs` 的 `export` 和 `--custom-desc` 功能，按该软件公布的结构导出或合并。JSON、JSONC、TOML、自定义嵌套对象和数组容器均可配置。

Windows 已做空依赖目录安装、含空格路径、配置保护、原技能安装以及根据实际生成配置启动 MCP 的 `initialize`/`tools/list` 验证。宿主界面加载与 macOS/Linux 的实机运行仍需对应环境验收；配置文件存在只显示 `config-observed`，不表示宿主已连接。各个媒体执行器的按需组件支持平台见工具目录。

格式依据：[Continue MCP](https://docs.continue.dev/customize/deep-dives/mcp)、[VS Code MCP](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)、[Zed MCP](https://zed.dev/docs/ai/mcp)、[Zed 配置](https://zed.dev/docs/configuring-zed)。

## Grok：一次安装 MCP 和 Skills

在插件目录执行：

```sh
node scripts/install-host.mjs --host grok
```

Grok CLI 使用 `GROK_HOME`，未设置时使用 `~/.grok`。Grok 桌面软件可能为内置 Agent 使用独立目录，请从该软件的设置或启动配置确认实际 `GROK_HOME`，然后设置这个环境变量，或直接指定配置文件：

```sh
node scripts/install-host.mjs --host grok --config-path "实际 Agent 根目录/config.toml"
```

指定配置路径时，Skills 默认安装到配置文件同目录下的 `skills`；可用 `--skills-root` 单独覆盖。安装器保留已有服务器、模型设置、注释和自定义技能。用相同 `GROK_HOME` 运行 `grok mcp doctor yinzi_video_workflow --json` 可检查握手和工具发现。已经打开的会话可能保留旧工具列表，按宿主提供的刷新方式加载或在当前任务保存后开启新会话；已有任务仍可通过 CLI 接续。

2026-09-14 Windows Grok CLI 1.0.30 诊断发现 40 个 MCP 工具；Grok 桌面会话通过工作流 CLI/API 完成一批 15 张图片并落盘，用户确认测试成功。该记录验证了真实批量工作路径；其它版本、宿主界面与 macOS/Linux 仍按各自实测范围标识。支持 Skills/MCP 的软件具有通用接入基础，工具权限、传输方式和媒体组件平台支持需与宿主实际能力匹配。
