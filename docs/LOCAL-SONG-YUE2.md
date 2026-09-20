# 本地创作带歌词的歌曲：WanGP YuE2

`local.audio.neural-song` 根据歌词与风格描述生成带歌唱人声和伴奏的 WAV。它与 `local.audio.neural-music` 的 MusicGen 短纯配乐、`local.audio.clone-voice` 的 F5-TTS 配音分别配置，不会互相替换。

**本地音乐模型按需准备，普通安装不会要求先下载歌曲模型。** 只有当你的任务需要创作歌曲或配乐时，Agent 才在方案规划阶段检查电脑，比较本地和在线路线，再推荐需要的组件。看能力表、剪辑已有歌曲或仅制作旁白，都不应触发 YuE2/MusicGen 权重下载。已有兼容环境和权重会优先复用。

已有 Windows / NVIDIA 本地路线产出过 32 秒和约 98 秒原生歌唱音频，完成混音后的中文歌曲已获得用户听感认可。低显存路线使用 INT8、MMGP CPU 卸载、原生 `legacy` 解码与 VAE 分块。约 4.5 GB 是运行路线的资源量级，不能保证所有 4.5 GB 显卡、驱动、歌词长度都能运行；实际效果和逐字唱准仍须试听。当前适配器的安装和生成结果应分别看回执，不能将模型文件存在当作歌曲通过验收。

此次可分发适配器还通过正式本地执行器新生成了约 18 秒、48 kHz 双声道 WAV，并完成解码、源文件检查与旧结果恢复测试；RTX 2070 SUPER 上的这次短样 CUDA 峰值保留量约 3.26 GiB。它是技术链路样本，短时长上限截断了后续段落，不能据此宣称整首歌词、所有语言或更低显存设备都通过了艺术验收。

## 先检查电脑

让 Agent 从仓库根目录执行：

```sh
python backend-node/scripts/setup-yue2.py --inspect
```

此命令默认只读，不安装、不下载、不改配置，输出 GPU 型号、总/空闲显存、总/可用内存、目标盘空间、模型完整性与建议。Agent 还需确认实际操作系统、驱动/CUDA 兼容情况，并分别核对环境、权重和输出所在磁盘。可用显存约 4.5 GiB、可用内存约 8 GiB 是尝试短样的参考线；首先避开其他大模型或渲染任务占用高峰，不擅自结束未保存的工作。首次安装为代码、CUDA Python 环境、约 4.6 GB 权重和缓存预留约 15–20 GiB，按实际磁盘结果选择目录。运行时不会因为“显存不够 4.5 GB”自动永久锁死任务。

本适配器面向 Windows/Linux 的 NVIDIA CUDA。安装入口使用 64 位 Python 3.11/3.12。Windows 路线已有实测；Linux 有安装实现，但尚不声明拥有相同设备实测。Mac、无 NVIDIA GPU、资源不足的机器可选具备相应许可的线上歌曲服务；检查该服务的真实官方 API、收费、歌词输入、人声/伴奏分轨与授权范围后再使用。不会自动发起付费请求。MusicGen CPU 可用于纯配乐，不能替代 YuE2 歌唱。

## 本地不适合时怎么选

不必为了使用媒体工作流先买显卡或下载一套暂时用不到的模型。Agent 应说明实际限制，并在当前方案里给出适合的替代路线：

| 需求 | 可考虑的路线 | 入口与边界 |
| --- | --- | --- |
| 带歌词、人声的歌曲 | 在线歌曲服务 | [Suno 官网](https://suno.com/) / [官方教程与帮助](https://help.suno.com/)，或 [Udio 官网](https://www.udio.com/) / [官方帮助](https://help.udio.com/)。选择前核对当前收费、地区可用性、导出方式和作品许可。 |
| 短纯配乐 | 已有授权音乐、在线音乐服务，或硬件允许时按需准备 MusicGen | CPU 路线先试小样，按实际耗时决定是否适合；不会生成人声歌唱。 |
| 解说、对白、草稿节奏 | 已配置 TTS、原片对白或用户提供的录音 | 通常准备成本较低；TTS 念白或节奏占位不是唱歌，不能承诺相同演唱效果。 |

以上网址是服务与学习入口，不表示它们提供了公开 API，也不表示工作流已经配置了这些服务。需要自动化调用时，应核对服务当前官方接口或用户选择的兼容提供方，说明上传、计费与许可；第三方包装接口不能称作“官方 Suno API”。推荐方案本身不产生上传或扣费。

## 安装或复用

由 Agent 按检查结果选择有空间的目录，然后执行一次：

```sh
python backend-node/scripts/setup-yue2.py --install --root /path/to/yue2-runtime --weights-dir /path/to/yue2-weights
```

Windows 同样接受 `D:/YinziModels/yue2` 这样的路径。没有自定义需求时省略两个路径即可。安装器创建独立 venv，固定 WanGP 源码与模型版本，校验模型 SHA-256，通过导入检查后才合并本机 `~/.yinzi-media/neural-audio.json` 的 `song` 项。使用 `YINZI_NEURAL_AUDIO_CONFIG` 或 `--config` 可指定独立配置。既有 music、voice、缓存及其他字段保留，失败安装可在同一目录重跑；不会对已有不同版本源码执行强制 checkout。

已经有兼容环境时，直接复用，无需第二份模型或 pip 修改：

```sh
python backend-node/scripts/setup-yue2.py --adopt --python /path/to/venv/bin/python --source-dir /path/to/Wan2GP --weights-dir /path/to/yue2-weights
```

Windows 的解释器路径是 `venv/Scripts/python.exe`。原环境若把 Python 依赖放在独立 `--target` 目录，可再传 `--runtime-dir /path/to/dependencies`。复用时检查独立 venv、固定源码版本、权重哈希和实际 Python 导入；不会修改该环境。`--inspect --verify-hashes` 可进行只读完整校验。

固定来源：

- WanGP：<https://github.com/deepbeepmeep/Wan2GP>，revision `bfaff285463ef6124c2357136e8d36c6c93c0fb2`。
- 原始模型：<https://huggingface.co/m-a-p/YuE2-3B>。
- WanGP 量化权重：<https://huggingface.co/DeepBeepMeep/TTS>，revision `5020589aa562cea206a25eea208d7cbb1f6efae7`。
- 当前权重许可 **CC-BY-NC-4.0**，不默认授权商业用途。`purpose: commercial` 会明确提示换用许可合适的模型；工作流免费不等于第三方权重可以商用。

## 从短样到整曲

用 UTF-8 文本保存歌词，保留换行以及 `[Verse]`、`[Chorus]` 标签，通过现有本地媒体队列提交：

```json
{
  "module_id": "local.audio.neural-song",
  "input_path": "/path/to/lyrics.txt",
  "parameters": {
    "style": "Mandarin melodic pop rap, expressive female vocal, rising emotional intensity, clear pronunciation, tight drums",
    "seconds": 45,
    "steps": 32,
    "seed": 42,
    "purpose": "personal"
  }
}
```

使用 `local_media_run` / 工作流的本地媒体提交入口，补充当前 `session_id` 和唯一 `request_key` 即可获得任务进度和结果；再用 `local_media_get_job` 查询。`lyrics` 或 `text` 参数也可覆盖输入文件中的歌词，仍保留主输入文件用于任务追踪；不要同时传入两份不同歌词。`duration_seconds` 是 `seconds` 的别名。

运行时在本机离线推理，不再访问模型 API，保留硬件、阶段进度、原生结构计划、ABC 乐谱、生成参数、资源峰值与输出哈希。导出 24-bit WAV 前做峰值缩放，防止新导出发生削波，再解码检查。任务的 `quality_status` 保持 `review_required`：必须听人声、核对实际唱出的词、查看是否漏段/重复、情绪是否连贯，才能交付。

短样确定唱感后再扩展整曲。期望时长是模型上限/提示，不保证固定长度。可选 `score_file` 传入已有 UTF-8 ABC 谱（最多 256 KB），辅助复用旋律；它不能保证不同语言歌词得到完全相同的时长或音节落点。中英文版本要分别核词、听审、对齐，不能只替换字幕。

高级参数在工具 schema 中可见：`steps`、`guidance`、`temperature`、`top_k`、`top_p`、`mode`、`device`、`gpu_fraction`、`offload_profile`、`budgets`、`vae_tile`、`threads`、`timeout_seconds`、`minimum_free_ram_gib`、`minimum_free_vram_gib`、`save_latents`。默认省显存配置为 MMGP profile 5、VAE tile 64。时长范围 5–360 秒，长曲优先分段并保留满意片段；参数可调，不把一首样例的 BPM、种子或角色硬编码成所有歌曲的模板。

## 失败与恢复

安装缺失、显存不足、超时、歌词没唱准都允许修正后重试。已有成功 WAV 和回执匹配时复用该结果，不重新推理；没有完整回执的既有音频保留供检查，并使用新的本地任务尝试继续。生成失败保留阶段文件和失败原因；更换时长、资源或歌词只重做需要修复的部分。程序读取用户 site-packages 时容易被 NumPy 等依赖污染，适配器固定以 `python -s` 启动，不修改用户全局库。

完整歌曲经认可后再制作 MV：先锁音乐、歌词实唱时间与鼓点，按故事动作和情绪设计视觉段落，再安排素材生成与 AE 合成。纯 TTS 拼接虽然容易逐字准确，但不能宣称等同真正的歌唱；它适合用户明确选择的配音、念白或鬼畜路线。
