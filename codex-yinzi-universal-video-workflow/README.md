# Codex 插件与 Skills

本目录提供媒体工作流 Skill、可选文本模型 Skill、MCP 工具和动态运行时启动器。
安装请使用仓库根目录 [README](../README.md) 与 [install.ps1](../install.ps1)。
不要只复制单个 Skill：脚本会引用插件内的 runtime-state 等公共模块。

安装器兼容完整插件注册与 Skills + MCP 注册。新任务发现 Skills；若仍未刷新，请重启 Codex。
当前任务也可读取 [主 Skill](plugins/codex-yinzi-universal-video-workflow/skills/codex-yinzi-universal-video/SKILL.md)，
使用其中 CLI 桥接继续。工作台 URL 从运行时返回值读取，不固定端口。

模型配置详见 [新手说明](../docs/BEGINNER-KEY-SETUP.md)。本插件及原创新增内容遵守
[社区非商业来源标注许可](../LICENSE)；上游和第三方按原许可。
