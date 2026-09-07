---
name: yinzi-workflow-setup
description: Install, launch, update, or repair the Codex Yinzi media workflow from this repository. Use when the user asks to install/use this project or provides its repository or promotional image for installation; not for unrelated code review.
---

# 银子工作流安装与启动

将当前目录向上解析到有 `install.ps1` 的仓库根目录。用户请求安装时运行
`powershell.exe -NoProfile -ExecutionPolicy Bypass -File <root>/install.ps1`。
安装器使用当前源码，补齐依赖，注册 Skills/MCP，验证并打开动态端口工作台。
不要只解释如何安装而把已授权的操作交回给用户。

读取最后的 JSON，显示真实 `frontend_url`。安装本身不提交生成请求，付费生成依据当前授权和预算。
首次 Key 配置可选，参见根目录 `docs/BEGINNER-KEY-SETUP.md`。

已安装时运行 `<root>/start.ps1`，不能猜端口。更新使用 `git pull --ff-only` 后重新执行安装器；
保留用户修改，冲突时读取具体情况，不 reset/clean。下载失败可以重跑同一安装器。

主媒体 Skill 在 `codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/skills/codex-yinzi-universal-video/SKILL.md`。
如当前任务尚未发现新工具，直接读取主 Skill 并使用其 CLI；新任务仍不可见时说明重启 Codex。
用户要求修复时核对 `installation.json`、`runtime.json`、后端身份和真实首页，不能仅凭文件存在报告成功。
