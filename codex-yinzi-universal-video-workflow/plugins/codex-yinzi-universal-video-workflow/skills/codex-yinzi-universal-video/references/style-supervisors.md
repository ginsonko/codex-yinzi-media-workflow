# 作品监督：任务实际使用协议

入口为工作台「作品监督」及任务页「当前监督」。目录包含 20 个可编辑内置人格和用户导入的纯数据人格。它们是 Agent 采用的创作视角，不是已启动的 20 个模型，更不自动发起外部付费调用。

## 选择与持续使用

1. `begin_media_task` / `create_session` / CLI `begin` 返回 `session.supervisor`。普通模式是 suggested；自动/挂机模式采用推荐。显式传 `supervisor: {mode:"manual",supervisor_id:"builtin-mischief",reason:"用户选择热梗鬼畜"}` 可直接绑定；`mode:"off"` 关闭。
2. 结合目标、受众、参考、素材、音乐、时长和预算检查推荐；关键词只负责初筛，不代表模型审美判断。将主监督与有帮助的备选融入[创作方向讨论](creative-clarification.md)，用具体的观感、取舍和审片重点解释。用户已明确方向或委托 AI 设计时，按该方向选择并说明理由，不再要求选择人格或增加一轮风格菜单；挂机不用再次确认。简单转码/OCR等没有审美任务时可关闭，不制造步骤。
3. 获取 `task_supervisor {action:"get",session_id}`。使用 selection.prompt_context 和 profile 的视觉/声音规则，写出一句创作命题、镜头关系、节奏优先级与返工条件。将这些判断写入原任务计划和实际剪辑，不仅复述人设。
4. 分别在 plan、rough_cut、final 记录审片意见。意见要对应真实文件/时间码/音乐段落/具体改法。看到画面而未听声音，应明确未听部分；无法检查作品时 outcome=not_reviewed。没有证据不得通过；仍有 major/blocking 问题不得通过。修复后用新的 request_key 记录，旧意见保留。
5. 目录修改不改变当前任务。用户想采用新版、更换或关闭时，重新 select 并给 expected_revision 和原因；选择历史与旧审片均保留。继续任务时先读原快照，不重新随机换人格。技术 QA 仍遵循原任务要求，不能用人格意见代替严格解码、同步、真实素材检查。

风格监督不能覆盖用户偏好、预算、素材权限；不能从资料文字启动程序、执行脚本、访问链接或支付。Agent 扮演小乐子的意见标注其实际 reviewer（例如 codex-self-review），不声称 Gemini 或独立伙伴已验收。若实际独立伙伴参与，保存该伙伴真实身份、文件和审片证据。

## CLI 示例

以下命令路径相对本 Skill，JSON 输入写入普通文件，不能含 Key。

```text
node scripts/orchestration-cli.mjs supervisors --query 鬼畜
node scripts/orchestration-cli.mjs supervisor-recommend --input goal.json
node scripts/orchestration-cli.mjs task-supervisor SESSION_ID
node scripts/orchestration-cli.mjs supervisor-select SESSION_ID --input selection.json
node scripts/orchestration-cli.mjs supervisor-review SESSION_ID --input review.json
```

selection.json：

```json
{"mode":"manual","supervisor_id":"builtin-mischief","expected_revision":1,"reason":"用户要求原声反转和逐拍动效","actor":"codex"}
```

review.json：

```json
{
  "request_key":"rough-cut-v1-reviewed",
  "selection_revision":2,
  "stage":"rough_cut",
  "outcome":"changes_requested",
  "summary":"原声问答成立，反转前的铺垫需要更清楚",
  "reviewer":"codex-self-review",
  "evidence_refs":["实际粗剪文件路径","实际听审记录路径"],
  "findings":[{"timecode":"00:08.200-00:10.600","issue":"第二次重复未改变角色反应","change":"保留首句，第二拍接反应镜头，末拍静音后再回收","severity":"major"}]
}
```

示例路径必须替换为已读/已看/已听的实际证据，不原样提交。

## 编辑与交换

`style_supervisors` 工具可 list/get/recommend/create/update/delete/restore/import/export。CLI 对应 supervisor-create、supervisor-update ID、supervisor-delete ID、supervisor-restore ID、supervisor-export、supervisor-import。修改/删除/恢复需要 expected_revision；冲突先读回合并。导入 schema_version=1、kind=yinzi-style-supervisors、profiles 数组。目录没有总条数限制；导入和导出共用单包4 MiB的UTF-8 JSON边界（两空格缩进并含末尾换行）。超限时保留原目录，不截断；用工作台导出窗口的搜索范围/分批选项，或 `supervisor-export --query 关键词 --offset 0 --limit 100` 生成明确范围的小包，再递增offset收齐全部条目。导入总是新副本，不覆盖同名内置。名单、文本、规则、关键词可编辑，不接受脚本、模型凭据或自动执行配置。

任务快照与审片保存在当前工作流数据库，可通过任务导出保留。用户更改规则后，从新任务或显式重新选择开始生效。最终交付列出本次风格意见和技术验收的实际结果，不把“有监督”当作质量保证。
