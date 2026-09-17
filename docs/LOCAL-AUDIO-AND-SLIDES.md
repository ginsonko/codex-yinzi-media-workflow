# 本地配乐、参考声音与课件

把用途告诉 Agent：给讲解配一段轻音乐、用自己的声音朗读教案，或者把知识点整理成可修改的课件。Agent 会沿用当前工作流任务，按机器资源和用途选择工具。

## 已接入的本地音频

| 工具 | 输入 | 输出 |
|---|---|---|
| `local.audio.neural-music` | UTF-8 文件中的配乐描述 | 1–30 秒 WAV、参数记录 |
| `local.audio.clone-voice` | UTF-8 讲稿、参考录音及其准确转写 | WAV、逐段生成与缓存记录 |

目前后端分别为 MusicGen-small 和 F5-TTS v1 Base，均使用 CPU，默认 4 线程。预训练权重是 CC-BY-NC-4.0，适用于非商用研究和个人试用。代码开源与音色、模型权重的使用许可分别适用；商业项目应选择许可合适的后端。声音录音应由本人提供或已获许可。

### 首次准备

由 Agent 执行，用户不需要逐项操作。使用 Python 3.10–3.12，模型与环境存放在用户目录下的独立位置，不修改系统 Python。先查看配置与空间估算：

```sh
python backend-node/scripts/setup-neural-audio.py --backend music --inspect
python backend-node/scripts/setup-neural-audio.py --backend music
python backend-node/scripts/setup-neural-audio.py --backend voice
```

可用 `--root` 选择空间足够的磁盘。已有兼容隔离环境时，用 `--python` 指定解释器，配合 `--model-dir` 或 `--checkpoint`、`--vocoder` 复用已下载模型。配置默认保存为 `~/.yinzi-media/neural-audio.json`；可用 `YINZI_NEURAL_AUDIO_CONFIG` 指向另一配置。配置文件和权重均不提交 Git。

安装只访问官方包与模型来源，用户声音不上传。首次下载可能较大，进度由安装进程报告；推理只读取本地模型。可配置空闲内存阈值，先根据机器和当前负载评估，不因为显卡型号就判定能否完成任务。

### 使用与恢复

通过现有 `local_media_run` / CLI `local-run` 提交，保留 `session_id` 和 `request_key`。工作台能看到模型加载、配音分段、输出核对和成果。缺模型时任务显示具体准备方法，安装完成后调用 `local_media_resume` 恢复同一作业。没有静默调用收费在线服务。

音乐参数示例：`{"seconds":12,"threads":4,"seed":42,"purpose":"personal"}`。

声音参数示例：`{"reference_path":"/path/to/my-voice.wav","reference_text":"参考录音准确原文","threads":4,"purpose":"personal","segment_characters":130}`。用清晰的 1–30 秒参考录音；长稿按语句分段，成功分段以文本、参考音哈希、模型和参数共同标识缓存，恢复时复用。参考录音发生变化后会建立新身份，不套用旧结果。

生成完仍要试听读音、语气、停顿和相似度。文件可解码只说明技术输出有效。CPU 的 F5 配音可能需要数分钟，实时或大量生成可按实际用途评估其它本地模型或在线服务。

## 在线音乐选项

电脑资源不足或需要更快、更长的音乐，可考虑以下官方服务，具体能力、价格和许可以接入时账户为准。本工作流没有替这些服务购买额度，也没有在失败后自动收费。

- [ElevenLabs Music](https://elevenlabs.io/docs/api-reference/music/compose)：可按提示词或分段方案生成。使用官方 `force_instrumental`、`respect_sections_durations` 字段。
- [Google Lyria](https://cloud.google.com/vertex-ai/generative-ai/docs/music/generate-music)：适合已有 Google Cloud 的用户。Lyria 2 的 predict 和新版本 interactions 协议分别处理。
- [Stable Audio](https://platform.stability.ai/docs/api-reference)：音乐与音效候选，按实际公开接口与订阅许可接入。

银子 API 当前不提供音乐生成；这些外部服务不应显示成银子已可用模型。ACE-Step、Qwen3-TTS、Pocket-TTS 是可以继续评估的本地替代，不因调研过就宣称已经安装实测。

## 可编辑 PPTX

`local.document.editable-pptx` 以 JSON 为输入，按需安装固定版本 PptxGenJS。支持 1–100 页，night / paper 主题、字体、五种主题颜色、原生文字、表格、XY 图表及讲者备注。输入示例见 [物理课件](../backend-node/examples/presentations/physics.json) 和 [社团活动](../backend-node/examples/presentations/reading-club.json)。

Agent 根据需求组织内容并调用现有 `local_media_run`，`parameters` 可留空。每页有标题、可选副标题/备注和 1–2 个内容块。文字块为 paragraphs，表格为矩形 rows，图表为 x/y 数组；多组数据共用横坐标。正文密度提示保存在 `presentation-review.json`，生成后用本机演示软件导出逐页预览并检查。

已在 Windows WPS 中验证两套不同内容的原生打开、PNG 导出、文字修改保存重开，以及真实表格和 XY 图表。自动生成器不添加动画；需要动画时作为独立后期步骤，并检查实际放映。任意旧 PPT 自动美化和其它系统/Office 的实机兼容性尚未完成验证。

## 展示与质量范围

课件内容应由用户目标决定，可以是课堂演示、答辩、汇报或复习资料。文字、表格和数据图表尽量保留原生对象，按真实页面渲染检查排版。PPTX 可生成、文字可编辑、动画可放映、能否导出视频分别验证，不用某一项代替其它项。

教学网站展示的是已制作作品及交互示例。复制需求后交给自己的 Agent 执行；静态网站本身不接收私人录音或题目上传，也不会远程启动用户电脑上的模型。
