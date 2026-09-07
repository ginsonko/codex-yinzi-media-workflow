# 社区贡献与技能分享

欢迎提交 Bug、个人非商业改进、Skills、工具和适配器。先阅读 [LICENSE](LICENSE)、[NOTICE.md](NOTICE.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 分享工具包

在工作台“工具与能力/工具目录”选择导出工具包；其他用户导入时会按工具身份去重。
包里应只放代码、说明和公开示例，不放 Key、个人配置、数据库、日志和用户素材。
导入后先查看来源、依赖、运行命令和权限，再启用你需要的工具。第三方脚本按普通程序对待。

## 分享 Skill

Skill 文件夹应包含 `SKILL.md`（name、description、任务使用指导）及真正需要的 scripts/references/assets。
注明作者、用途、适用条件、所需依赖和许可；引用本项目内容时保留项目与原仓库地址，并说明修改。
独立新工具仍由你拥有版权，提交到本仓库时应能按本仓库许可授权，第三方引用需保留其原许可。

## 提交代码

Fork 本仓库，从 main 新建分支；一个 PR 解决一个清晰问题。写明实际变化、触发条件、验证和局限。
提交表示你有权贡献，且同意原创贡献按本仓库社区非商业来源标注许可提供；不授予维护者未写明的商业重授权。
不要提交来源不明或与此许可不兼容的第三方内容。

## 本地验证

需要 Node.js 22+。后端 `npm ci --ignore-scripts`，前端 `npm ci`；构建前端 `npm run build`。

```powershell
node --test backend-node/test/*.test.js
node --test frontweb/test/*.test.js
node --test codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/mcp/server.test.mjs
node --test codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/scripts/runtime-launcher.test.mjs
node scripts/audit-public.mjs
```

在安装器给出的本地工作台验收变更的真实行为。需要调用云端模型时使用自己的 Key 和明确预算，不能让 CI 发起付费请求。
报告问题只附脱敏错误、必要截图和步骤；不要附 runtime 数据目录。
