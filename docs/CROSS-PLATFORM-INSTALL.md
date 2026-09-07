# 跨平台安装与启动

本仓库支持 Windows、macOS 和 Linux。

## 给 Codex 的安装请求

```text
请帮我安装并启动 Codex 银子万能媒体工作流：
https://github.com/ginsonko/codex-yinzi-media-workflow
请先读取仓库 AGENTS.md，识别我当前的操作系统：
Windows 使用根目录 install.ps1（或 install.cmd）；macOS/Linux 使用根目录 install.sh，并先赋予它可执行权限。
安装依赖、注册 Skills 和 MCP，启动工作台，并返回实际 frontend_url。
先不配置 Key，带我看一遍示例。
```

Codex 不应在 macOS/Linux 上执行 `.ps1`，也不应在 Windows 上要求用户手动运行 shell 命令。安装器会使用 Node.js 22 LTS、动态端口和当前 checkout，保留用户数据与配置。

## 手动入口

- Windows：`powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\install.ps1`，或双击 `install.cmd`。
- macOS/Linux：先安装 Node.js 22 LTS，再运行 `chmod +x install.sh start.sh && ./install.sh`；以后运行 `./start.sh`。

如果当前没有 `codex` 命令，Unix 安装器仍会完成本地工作台准备并明确提示；安装 Codex 后重新运行即可注册 Skills 和 MCP。
