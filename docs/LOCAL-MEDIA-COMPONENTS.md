# 本地媒体组件与 124 项执行合同

本轮新增 124 项实际可调用的处理操作：36 项图片、48 项视频、40 项音频。它们共用两个可复用组件：Sharp 0.35.3 和 FFmpeg 9.0.1。工具目录总计 172 项，包含原有 48 项；原有目录中的规划参考项仍按原状态展示。124 是独立处理操作数量，不是 124 个模型或安装包。

## 用户看到的过程

用户描述目标并提供素材，Codex 按需要搜索工具目录，用 `local_media_run` 提交已有任务中的处理步骤。后台立即返回持久作业编号，自动检查输入、准备缺失组件、运行操作、验证输出并把成果登记到原任务。无需用户打开终端、下载 ZIP、安装 Python、设置环境变量或重新提交任务。本地处理不需要 API Key 或供应商鉴权。

组件首次准备会使用网络，之后可复用本机组件；不会每个任务重装。FFmpeg 下载显示真实字节和总量，Sharp 的 npm 安装显示阶段状态，不伪造字节百分比。工作台“任务与计划”显示处理名称、组件准备、执行、验收、成果链接和历史记录，刷新不丢失。短暂下载失败自动重试最多三次；失败缓存和原任务保留，Codex 可恢复同一作业。断网一直不恢复、磁盘满、系统禁止执行时不能承诺成功，界面给出实际原因。

## 推荐怎样选

| 用户目标 | 优先选择 | 作用与边界 |
| --- | --- | --- |
| 电商主图统一尺寸、白底、压缩、隐私清理 | 图片 resize/crop/flatten/convert/metadata-strip | CPU 本地批处理，无需重复分析整套素材；透明铺白底不等于自动分割商品 |
| 已有短视频剪辑、色彩修复、降噪、补帧 | 视频 trim/eq/hqdn3d/deflicker/fps/minterpolate | 尽快给出预览；混帧插值不能重新生成缺失的人物细节 |
| 讲解视频声音处理 | 音频 loudnorm/afftdn/highpass/adeclick/atrim | 修响度、噪声和杂点；不能承诺分离所有人声和背景音 |
| 动漫素材优化与风格预览 | 锐化、调色板、线稿、像素化 | 图像处理效果；不等于真人转动漫模型 |
| Seedance 成果轻微闪烁、曝光差异、压缩噪声 | deflicker/eq/deband/hqdn3d | 只修对应画面质量问题，不能修复身份语义错误 |
| 原视频全身角色替换且背景尽量不变 | 专用分割/跟踪/生成/合成路线，见后续候选 | 当前 124 项基础操作不能独立实现；不自动降级为滤镜冒充换人 |

## 运行和恢复设计

安装清单由代码注册，API 只接受组件 ID；不执行外部合同内的任意 shell。组件按平台、固定版本、锁文件和摘要选择，采用独立安装目录、跨进程锁和安装后健康检查，成功后原子激活。FFmpeg 归档来自锁定的官方构建渠道并验 SHA-256；Sharp 使用 `npm ci --ignore-scripts` 和锁定的预编译原生依赖。复用时验证文件状态、摘要和实际运行能力，旧版文件保留。

同一任务的 `request_key` 保持稳定：重复调用返回原作业，参数或输入文件身份变化时返回冲突，避免悄悄交付旧图。素材排队期间若被替换，执行前会检测到。长素材不在提交时全量读入内存；输入输出流式算摘要，成果写入独立 attempt 目录，源文件不覆盖。短暂下载错误保留断点并自动重试，后台重启恢复未结束的作业，关联计划节点随实际执行更新。

组件安装、哈希、探针只针对本次需要的两个组件；不扫描或预装所有候选工具。默认按 CPU 核数及可用内存，将本地作业并发限制在 1–4，每个媒体进程使用有限线程。图片解码限制为 1 亿像素；倒放会缓存完整片段，当前要求不超过 120 秒。长视频应先分片、执行再合成；当前两组件方案不需要 GPU，也未声称具备 GPU 自动选型和重模型部署能力。

当前自动安装已实测的平台为 **Windows x64**。macOS、Linux、ARM 仍需各自实机验证，新组件 API 会如实显示当前平台状态；已有工作流的其他能力不受这个实测范围声明影响。

## Codex 调用

先按 `list_modules` 的 `q` 搜索目标，选中实际执行合同。全局 172 项目录无需每次全部读入。示例：

```json
{
  "session_id": "已有任务编号",
  "request_key": "商品主图-尺寸统一-001",
  "module_id": "local.image.resize",
  "input_path": "C:/用户授权素材/商品.png",
  "parameters": { "width": 1200, "height": 1200 }
}
```

调用 `local_media_get_job` 读取状态，成功后从 `result.url` 和原任务素材列表使用成果。有失败可用 `local_media_resume` 恢复原 job。`local_media_components` 只读设备/安装摘要。CLI 对应 `components`、`local-run --input request.json`、`local-job JOB_ID`、`local-resume JOB_ID`。这些是给 Codex 的接口，用户无需记忆命令。

以下表格列出各操作与数值参数的默认值和范围。未列参数的是固定预设；不能传任意滤镜字符串。默认图片输出 PNG（CMYK 为 JPEG，格式转换按 format），视频为 H.264/AAC MP4，音频为 PCM WAV。视频保留输入音轨；联系表输出在 MP4 中，非静态海报。画面降噪/美化是确定性处理，不是面部感知美颜模型。

<!-- OPERATIONS BEGIN -->
### 图片 · 36 项

| 合同编号 | 用途 | 参数默认值与范围 |
| --- | --- | --- |
| `local.image.resize` | 调整图片尺寸 | `width=96`（1–8192）；`height=64`（1–8192） |
| `local.image.crop` | 按坐标裁剪图片 | `left=8`（0–8192）；`top=8`（0–8192）；`width=64`（1–8192）；`height=48`（1–8192） |
| `local.image.extend` | 为图片补边 | `pixels=8`（0–2048） |
| `local.image.rotate` | 旋转图片 | `angle=90`（-360–360） |
| `local.image.flip` | 垂直翻转图片 | 固定预设 |
| `local.image.flop` | 水平镜像图片 | 固定预设 |
| `local.image.grayscale` | 转换灰度图片 | 固定预设 |
| `local.image.negate` | 图片负片反色 | 固定预设 |
| `local.image.blur` | 图片高斯模糊 | `sigma=1.2`（0.3–100） |
| `local.image.sharpen` | 增强图片细节 | `sigma=1`（0.01–10） |
| `local.image.median` | 去除图片椒盐噪点 | `size=3`（1–9） |
| `local.image.threshold` | 生成黑白阈值图 | `threshold=128`（0–255） |
| `local.image.normalize` | 拉伸图片亮度范围 | 固定预设 |
| `local.image.gamma` | 调整图片伽马 | `gamma=1.8`（1–3） |
| `local.image.tint` | 为灰度层着色 | 固定预设 |
| `local.image.modulate` | 调整亮度饱和度色相 | `brightness=1.1`（0.1–3）；`saturation=1.15`（0–3）；`hue=15`（0–360） |
| `local.image.linear` | 线性曝光调整 | `gain=1.1`（0.1–3）；`offset=3`（-255–255） |
| `local.image.recomb` | 通道矩阵复古调色 | 固定预设 |
| `local.image.emboss` | 图片浮雕卷积 | 固定预设 |
| `local.image.edges` | 图片边缘卷积 | 固定预设 |
| `local.image.flatten` | 透明图片铺白底 | 固定预设 |
| `local.image.remove-alpha` | 移除透明通道 | 固定预设 |
| `local.image.ensure-alpha` | 添加统一透明度 | `alpha=0.7`（0–1） |
| `local.image.extract-alpha` | 导出透明通道灰度图 | 固定预设 |
| `local.image.extract-red` | 导出红色通道 | 固定预设 |
| `local.image.srgb` | 标准化 sRGB 色彩空间 | 固定预设 |
| `local.image.cmyk` | 生成印刷 CMYK 图片 | 固定预设 |
| `local.image.palette` | 生成有限调色板 PNG | `colors=16`（2–256） |
| `local.image.convert` | 转换图片输出格式 | `format=webp`（png/jpeg/webp/avif/tiff） |
| `local.image.trim` | 去除统一颜色边缘 | 固定预设 |
| `local.image.pixelate` | 像素化缩略图 | `width=24`（1–256） |
| `local.image.clahe` | 自适应局部对比度 | 固定预设 |
| `local.image.threshold-alpha` | 将黑色背景转换为透明 | 固定预设 |
| `local.image.affine` | 执行仿射倾斜变换 | 固定预设 |
| `local.image.join-border` | 叠加居中边框 | `thickness=4`（1–128） |
| `local.image.metadata-strip` | 清除输出隐私元数据 | 固定预设 |

### 视频 · 48 项

| 合同编号 | 用途 | 参数默认值与范围 |
| --- | --- | --- |
| `local.video.scale` | 调整视频分辨率 | `width=128`（16–4096）；`height=72`（16–4096） |
| `local.video.crop` | 裁剪视频区域 | `width=128`（16–4096）；`height=72`（16–4096）；`x=8`（0–4096）；`y=8`（0–4096） |
| `local.video.pad` | 视频扩展画布 | 固定预设 |
| `local.video.transpose` | 旋转视频方向 | `direction=1`（0–3） |
| `local.video.hflip` | 水平镜像视频 | 固定预设 |
| `local.video.vflip` | 垂直翻转视频 | 固定预设 |
| `local.video.reverse` | 倒放视频片段 | 固定预设 |
| `local.video.grayscale` | 视频转为黑白 | 固定预设 |
| `local.video.negate` | 视频负片反色 | 固定预设 |
| `local.video.eq` | 调整视频曝光对比度 | `brightness=0.03`（-1–1）；`contrast=1.1`（0.1–3）；`saturation=1.1`（0–3） |
| `local.video.hue` | 调整视频色相 | `degrees=20`（-180–180） |
| `local.video.gblur` | 高斯柔化视频 | `sigma=1`（0.1–10） |
| `local.video.boxblur` | 快速方框模糊 | 固定预设 |
| `local.video.unsharp` | 增强视频细节 | 固定预设 |
| `local.video.hqdn3d` | 时空联合视频降噪 | 固定预设 |
| `local.video.nlmeans` | 非局部均值视频降噪 | 固定预设 |
| `local.video.deflicker` | 缓解亮度闪烁 | 固定预设 |
| `local.video.bwdif` | 视频去隔行 | 固定预设 |
| `local.video.vignette` | 增加视频暗角 | 固定预设 |
| `local.video.lenscorrection` | 校正镜头径向畸变 | `k1=-0.05`（-0.5–0.5） |
| `local.video.chromakey` | 绿幕抠像并铺黑底 | 固定预设 |
| `local.video.drawbox` | 叠加指定区域标记 | 固定预设 |
| `local.video.edgedetect` | 视频线稿滤镜 | 固定预设 |
| `local.video.sobel` | 视频索贝尔边缘 | 固定预设 |
| `local.video.posterize` | 视频分层调色风格 | 固定预设 |
| `local.video.fade-in` | 视频淡入 | `duration=0.3`（0.01–60） |
| `local.video.fade-out` | 视频淡出 | `start=0.4`（0–86400）；`duration=0.3`（0.01–60） |
| `local.video.fps` | 转换视频帧率 | `fps=12`（1–120） |
| `local.video.tmix` | 多帧混合柔化运动 | 固定预设 |
| `local.video.minterpolate` | 混帧插值补帧 | `fps=24`（1–60） |
| `local.video.speed` | 改变视频速度并同步音频 | `speed=1.5`（0.5–2） |
| `local.video.trim` | 截取视频时间片段 | `start=0.1`（0–86400）；`duration=0.4`（0.01–86400） |
| `local.video.tpad` | 延长尾帧停留时间 | `duration=0.2`（0–60） |
| `local.video.tile` | 生成视频联系表 | 固定预设 |
| `local.video.colorbalance` | 视频阴影高光调色 | 固定预设 |
| `local.video.colorchannelmixer` | 视频复古通道调色 | 固定预设 |
| `local.video.curves` | 视频曲线提升中间调 | 固定预设 |
| `local.video.deband` | 缓解视频色带 | 固定预设 |
| `local.video.deblock` | 降低块状压缩伪影 | 固定预设 |
| `local.video.dejudder` | 减轻重复帧不均匀顿挫 | 固定预设 |
| `local.video.deshake` | 轻微手持画面稳定 | 固定预设 |
| `local.video.pixelate` | 视频像素化风格 | 固定预设 |
| `local.video.lagfun` | 视频运动残影 | 固定预设 |
| `local.video.noise` | 添加影片颗粒 | `amount=5`（0–30） |
| `local.video.setsar` | 校正像素宽高比 | 固定预设 |
| `local.video.setdar` | 设置显示宽高比 | 固定预设 |
| `local.video.colorlevels` | 调整视频黑白场 | 固定预设 |
| `local.video.lut-yuv` | 限定视频亮度范围 | 固定预设 |

### 音频 · 40 项

| 合同编号 | 用途 | 参数默认值与范围 |
| --- | --- | --- |
| `local.audio.volume` | 调整音频音量 | `gain=0.8`（0–4） |
| `local.audio.loudnorm` | 广播响度归一化 | 固定预设 |
| `local.audio.alimiter` | 限制音频峰值 | 固定预设 |
| `local.audio.acompressor` | 动态压缩音频 | 固定预设 |
| `local.audio.compand` | 扩展音频动态范围 | 固定预设 |
| `local.audio.agate` | 音频噪声门 | 固定预设 |
| `local.audio.highpass` | 音频高通除低频 | `frequency=80`（10–10000） |
| `local.audio.lowpass` | 音频低通削高频 | `frequency=8000`（100–20000） |
| `local.audio.bandpass` | 保留指定频带 | 固定预设 |
| `local.audio.bandreject` | 削除指定频带 | 固定预设 |
| `local.audio.bass` | 调整低音 | `gain=3`（-20–20） |
| `local.audio.treble` | 调整高音 | `gain=2`（-20–20） |
| `local.audio.equalizer` | 参数均衡器 | 固定预设 |
| `local.audio.aecho` | 添加回声 | 固定预设 |
| `local.audio.chorus` | 添加合唱效果 | 固定预设 |
| `local.audio.flanger` | 添加镶边效果 | 固定预设 |
| `local.audio.aphaser` | 添加相位效果 | 固定预设 |
| `local.audio.tremolo` | 添加振幅颤音 | 固定预设 |
| `local.audio.vibrato` | 添加音高颤音 | 固定预设 |
| `local.audio.pitch` | 改变音高并补偿时长 | `factor=1.1`（0.5–2） |
| `local.audio.atempo` | 改变音频速度保持音高 | `speed=1.2`（0.5–2） |
| `local.audio.areverse` | 倒放音频 | 固定预设 |
| `local.audio.fade-in` | 音频淡入 | 固定预设 |
| `local.audio.fade-out` | 音频淡出 | 固定预设 |
| `local.audio.atrim` | 截取音频时间片段 | `start=0.1`（0–86400）；`duration=0.4`（0.01–86400） |
| `local.audio.adelay` | 添加声道延迟 | 固定预设 |
| `local.audio.apad` | 音频尾部补静音 | 固定预设 |
| `local.audio.silenceremove` | 去除音频头部静音 | 固定预设 |
| `local.audio.afftdn` | 频谱音频降噪 | 固定预设 |
| `local.audio.adeclick` | 修复音频脉冲杂点 | 固定预设 |
| `local.audio.adeclip` | 修复音频削波 | 固定预设 |
| `local.audio.dcshift` | 调整音频直流偏移 | 固定预设 |
| `local.audio.dynaudnorm` | 动态音量归一化 | 固定预设 |
| `local.audio.stereo` | 转换双声道音频 | 固定预设 |
| `local.audio.mono` | 将双声道混合为单声道 | 固定预设 |
| `local.audio.resample` | 重采样音频 | `sample_rate=44100`（8000–96000） |
| `local.audio.asetrate` | 修改采样率与播放节奏 | 固定预设 |
| `local.audio.anull` | 音频无损解码导出 | 固定预设 |
| `local.audio.asubboost` | 增强超低频 | 固定预设 |
| `local.audio.crossfeed` | 耳机跨声道混合 | 固定预设 |

<!-- OPERATIONS END -->

## 调研来源与下一批组件建议

资料在 2026-09-09 读取自官方仓库或官方 API 文档。FFmpeg 的各项滤镜、Sharp 的图像 API 已用锁定版本实际执行。候选库的 README 只证明项目公开能力和依赖说明，不证明它在用户本机可用。

| 工具/组件 | 官方资料支持的方向 | 集成建议与实测状态 |
| --- | --- | --- |
| [FFmpeg](https://ffmpeg.org/ffmpeg-filters.html) / [Gyan 构建](https://www.gyan.dev/ffmpeg/builds/) | 视频、音频滤镜和格式处理 | 已注册自动安装；依赖版本、来源和 GPL/LGPL 构建信息见 scripts/dependencies.json |
| [Sharp](https://github.com/lovell/sharp) / [API](https://sharp.pixelplumbing.com/api-operation/) | CPU 高效图片处理 | 已注册自动安装；Apache-2.0，libvips 等依赖保留各自许可证 |
| [rembg](https://github.com/danielgatis/rembg) | 背景移除、CPU ONNX 推理、模型自动下载 | 下一优先候选，解决电商抠图；需锁定 Python/ONNX/模型并验证头发和透明商品；未注册执行组件 |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | CPU 语音识别、量化、Windows | 下一优先候选，字幕与口播转写；代码 MIT，模型分别核查；未在本轮注册/安装 |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | 通用/动漫超分，小型动漫视频模型，ncnn Vulkan 版本 | 图像放大候选；“动漫模型”用于动漫素材修复，不能冒充真人转动漫；需测试分块、显卡兼容、闪烁和速度 |
| [MediaPipe](https://github.com/google-ai-edge/mediapipe) | 视觉任务与跨端部署基础 | 面部关键点、局部美颜和跟踪候选；需具体任务模型、许可证、CPU 性能及真实肖像测试，未注册 |
| [SAM 2](https://github.com/facebookresearch/sam2) | 图像/视频提示式分割与流式记忆 | 更难遮挡的角色分割候选；官方依赖 PyTorch，Windows 推荐 WSL，原生零配置适配尚未完成 |
| [FaceFusion](https://github.com/facefusion/facefusion) | 人脸处理工作流 | 面部替换候选，不能当全身换人；README 明示安装需技术能力，代码许可 OpenRAIL-AS，具体权重需单独检查；未注册 |
| [Wan2.2 / Wan-Animate](https://github.com/Wan-Video/Wan2.2#run-wan-animate) | Animate-14B 动作驱动与 replacement 模式、背景/遮罩/姿态输入 | 全身角色替换和跨角色风格的重型候选；需专门的设备探测、固定权重、GPU运行包和遮挡片段质量验收。本轮未下载安装，未实测，不能承诺普通 CPU 轻载一步完成 |

下一阶段先推进 rembg、whisper.cpp 等 CPU 组件，再接超分/关键点美颜，最后接 Wan-Animate 等重模型。每增加一个可执行组件，都复用本轮“空安装目录→自动准备→真实任务→输出检查→缓存复用→中断恢复→界面”的验收流程；没有通过时只留研究候选。重模型需要的磁盘、显存、驱动支持从该组件真实版本和本机探针决定，不套用其他模型的硬件数字。

## 验收证据与复现

`backend-node/components/acceptance-windows-x64.json` 保存可公开的逐项输入/输出哈希、组件版本、参数及执行器源码摘要，不含用户文件路径。工具卡片的“Windows 样本实测”仅在该清单与当前执行器源码一致时显示，改代码不会自动沿用旧实测标记。

维护者在隔离目录运行：

```text
node backend-node/scripts/accept-local-media.cjs ABSOLUTE_ACCEPTANCE_DIR
node backend-node/scripts/export-local-acceptance.cjs ABSOLUTE_ACCEPTANCE_DIR
```

首次目录无组件时会实际下载。全部 124 项会执行并保留素材及回执；发布导出要求全部成功且源码摘要未变化。本轮的生成样本是短视频、图片和音频，验证了可执行性、可解码性、源文件不变及代表性操作效果；不代表所有真实长视频、所有参数组合、所有肖像效果都已验证。
