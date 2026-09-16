# 可编辑分镜与模型提示词适配

用于跨模型复用故事、镜头和参考素材，或检查新渠道与旧渠道的提示词差异。

1. 用 `prompt_adapt({action:"profiles"})` 查看内置合同。需要新渠道时传按实际资料整理的 profile 对象；未确认的信息保持 null/unknown。
2. Agent 根据剧情和素材写 `shot-ir/v1`：shots 内逐镜 shot_id、subject、action；可加 time.duration/start、camera.description、style、audio.description、negative、references。references 每项有 type(image/video/audio)、index，建议带 asset_id 和 role。要快捷开始可用 action:parse/text，自动拆分仅识别显式字段，不负责完整剧情理解。
3. 调 `prompt_adapt({action:"compile",ir,profile:"Seedance 2.5",options:{resolution:"720p"}})`，查看 compiled.prompt/reference_manifest/loss_report 和 success。修正真实冲突再生成。工具本身不提交生成，也不改分镜时长或分辨率。

主CLI：`prompt-profiles`、`prompt-adapt --input request.json`；HTTP `/api/v1/prompt-adapter`。离线源码 CLI `node backend-node/scripts/prompt-adapter.mjs --input request.json` 共用同一编译器。

保留 raw_text 和 metadata.original_text 为来源，后续镜头修改以 IR 的 subject/action 等字段为准。`@图片1`、`@视频1`、`@音频1` 分别编号，不能将同类型同序号绑定多个资产。每镜负面约束进入正文；不要因独立negative参数未知而丢弃约束。`reference_template` 可按渠道改写，例如 `@{type}{index}` 或 `[{type}{index}]`。

遇到 `REFERENCE_CONFLICT` 时，查看 `reference_conflicts` 中保留的全部资产身份，修正引用编号或统一已确认的资产标识后重新编译。同槽冲突不会自动选最后一张图；单凭一个本地路径和一个网络 URL 也不能确认它们是同一素材。冲突槽不会进入可用 `reference_manifest`。HTTP 返回 400、CLI 非零退出、MCP 标记 `isError`，均表示本地编译未通过，不是生成服务已经拒绝或扣费。普通“构图1”“地图1”等叙事文本不是素材引用。

精确 `Seedance 2.5` 与历史 `Seedance 2.5-720`、`Seedance 2.0` 与 `Seedance 2.0-720` 合同独立。内置合同带出处/时间，生成前以用户当前渠道为准。H3尚缺已核实官方合同或离线权重，使用中立可读描述或自定义profile，不宣称已能离线抽卡。转换保留语义，不保证不同模型生成同效果。
