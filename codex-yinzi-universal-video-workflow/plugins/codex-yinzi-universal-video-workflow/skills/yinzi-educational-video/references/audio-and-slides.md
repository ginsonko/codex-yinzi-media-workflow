# 配乐、自己的声音和可编辑课件

按用户目标选择，三项能力可以独立使用。复用当前媒体会话及其本地任务工具，不要建立第二套队列或把作品演示网站当远程生成接口。

## 配乐与声音

- `local.audio.neural-music`：输入为 UTF-8 提示词文件，参数 `seconds` 1–30、`threads` 1–16、`seed`、`purpose`。当前官方后端 MusicGen-small 使用 CPU，只生成短配乐。
- `local.audio.clone-voice`：输入 UTF-8 新讲稿，参数 `reference_path`、`reference_text`、`segment_characters` 30–240、线程和种子。使用自己的或已获授权的干净录音，准确转写参考原文。当前 F5-TTS 按语句分段，成功部分保存在缓存中。
- 两者使用 CC-BY-NC-4.0 权重，商业任务选择许可相符的其它后端。银子 API 当前没有音乐生成。线上可研究 ElevenLabs Music、Google Lyria、Stable Audio 的官方接口与账户许可，不静默开通或付费。

调用前检查模型配置、可用内存、磁盘和正在运行的重任务。缺模型时先读仓库 `docs/LOCAL-AUDIO-AND-SLIDES.md`，运行 `backend-node/scripts/setup-neural-audio.py --backend music|voice --inspect`，再按授权安装。独立环境和模型路径可配置；已兼容环境可以复用。网络不可用时保留已下载文件和日志，不关闭 TLS 检查。

保留 `session_id`、`request_key` 和 `job_id`。缺依赖或失败恢复原作业，不重复成功请求。当前 CPU 声音样例约 18 秒需要约 11 分钟；根据机器实际情况说明等待时间。缓存模型、词表、声码器、参考音或文字改变时不得套用旧片段。

先试听短稿再做长课。重点检查多音字、数字与公式口播、句子是否遗漏、语气与参考音是否接近、段落衔接和停顿。解码、时长和响度都不能替代听审。新演示必须有可公开的录音来源，不能默认公开模型自带示例声音。

## 可编辑课件

`local.document.editable-pptx` 接受 JSON 文件。当前开放的 PptxGenJS 组件可由工作流按需安装，不依赖 Codex 宿主私有包。

JSON 使用 `title`、`theme`（night/paper）、`font`、可选 `colors`，以及 `slides`。每页有 `title`、可选 `subtitle`、`notes` 和 1–2 个 `blocks`：

- `text`：`heading` 和 `paragraphs`。
- `table`：`heading` 与矩形 `rows`。
- `chart`：`heading`、`x_label`、`y_label`，`series` 中每组有 `name`、相同横坐标 `x` 和数值 `y`。

完整的物理与社团活动两种输入见仓库 `backend-node/examples/presentations/`。以用户内容写 JSON，选主题只是起点，不能把所有课程做成同一个讲法。把来源和推导放进讲者备注。文字太密时拆页，不能缩到看不清。

生成器给出原生文字、表格和 XY 图表，返回布局提示；它不自动保证任意输入的排版。使用可用的 PowerPoint、WPS 或 LibreOffice 导出每页预览，检查文字、公式、图表轴名、对比度和溢出。对用户自己的原文件先创建副本。动画、放映和导出视频分别测试；某宿主可保存动画标签不能替代真实放映验收。

本机通过 Windows WPS 原生打开、PNG 导出、修改文字后保存再打开，以及原生表格/XY 图表结构检查。尚未实测 macOS、Linux、Microsoft PowerPoint 的全链路和任意旧文稿自动美化。
