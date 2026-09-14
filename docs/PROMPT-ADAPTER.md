# 分镜提示词适配

适配器在本机把自然语言或可编辑的分镜结构转换为目标模型描述，同时返回引用清单和合同差异。它不会调用模型，也不承诺不同模型生成相同画面。

建议先由 Agent 读故事和素材，完成中立 `shot-ir/v1`：每镜包含 `shot_id`、`subject`、`action`，可加 `time`、`camera`、`style`、`audio.description`、`negative`、`references`。自动 `parse` 只识别显式字段、分镜标题和素材序号；复杂剧情由 Agent 编辑 IR。`raw_text` 与原始输入用于追溯，不会覆盖编辑后的画面或动作。

## 调用

工作流 MCP：`prompt_adapt`。主 CLI：`prompt-profiles` 或 `prompt-adapt --input request.json`。HTTP：`GET /api/v1/prompt-adapter/profiles`、`POST /api/v1/prompt-adapter`。离线可直接运行：

```sh
node backend-node/scripts/prompt-adapter.mjs --input request.json
```

请求例子：

```json
{
  "action": "compile",
  "profile": "Seedance 2.5",
  "ir": {
    "version": "shot-ir/v1",
    "shots": [{
      "shot_id": 1,
      "subject": "重伤仙尊挡在地球与敌军之间",
      "action": "侧身架住敌首兵器，随即反击；远处军团保持层次",
      "time": {"duration": 10},
      "camera": {"description": "中景侧向跟拍，冲击后切大远景"},
      "audio": {"description": "兵器碰撞与低沉战鼓"},
      "negative": "不要让角色和武器穿模，不要新增地球",
      "references": [
        {"type": "image", "index": 1, "asset_id": "hero", "role": "character"},
        {"type": "video", "index": 1, "asset_id": "motion", "role": "motion_guide"},
        {"type": "audio", "index": 1, "asset_id": "beat"}
      ]
    }]
  },
  "options": {"resolution": "720p"}
}
```

每种媒体独立编号：`@图片1`、`@视频1`、`@音频1`。相同槽位不能绑定不同素材。输出保留完整文字和原 IR，不会为了长度或数量上限截断。约束始终进入每镜正文；仅明确支持独立负面参数时再返回 `negative_prompt`。

## 可配置合同与备用方式

`profile` 可以用已列出的 ID，也可以直接传完整对象。示例：

```json
{"profile_id":"my-channel","model_name":"用户的模型","availability":"unknown","duration_mode":"unknown","reference_template":"@{type}{index}","negative_prompt_supported":null,"max_prompt_length":null}
```

引用模板可改为 `[{type}{index}]` 等真实渠道格式。已确认的时长、分辨率、图片/视频/音频上限、首尾帧支持和出处可写入 profile。未知信息用 `null` 或 `unknown`，按次配置不会污染其它调用。

内置新 `Seedance 2.5` 合同来自 2026-09-14 用户确认的渠道：4–30 秒、480p/720p/1080p、30 图/10 视频/10 音频，总计 50，逐项引用，不支持首尾帧。历史 `Seedance 2.5-720`、`Seedance 2.0-720` 分开保留。精确 `Seedance 2.0` 不继承旧 -720 别名限制。其它渠道先使用自己的实际合同。

H3 名称及离线权重尚无已核实依据；可输出中立描述或传入实际 profile。转换器不代替生成服务。`strict:true` 可让合同警告使编译结果为不通过，仍保留完整提示词与差异便于修改；默认给出警告，后续生成参数由 Agent 按真实渠道决定。

## 实测边界

针对性测试覆盖混合引用、动作和约束保留、已编辑 IR、空值和畸形字段、素材冲突、数量限制、自定义模板、配置隔离，以及真实 CLI/HTTP 往返。媒体生成质量由后续实际视频验收确定。