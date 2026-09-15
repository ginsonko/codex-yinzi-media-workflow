# FFmpeg 专业音视频处理扩展 Skills 按需指南

本指南面向 Agent、编排系统与工程维护者，详述本次扩展的 8 项专业音视频滤镜的实际应用场景、推荐调用参数、命令行模板与主备降级策略。

当前维护源码已注册这 8 项操作。Windows 隔离执行中，除 `anlmdn` 外的 7 项有正常长度短样本回执；这些证据不代表所有长素材、跨平台和主观音画效果均已验收。`anlmdn` 现在按实际选定的 FFmpeg 文件探测可用性，当前 Windows 构建仍未通过，详见 2.2。维护源码接入、运行服务激活和发布包更新应分别核对。

---

## 1. 扩展工具总览

| 模块 ID | 名称 | 类型 | 适用场景与痛点解决 |
|---|---|---|---|
| `local.audio.deesser` | 人声齿音咝音削减 | 音频 | 播客、访谈、配音中刺耳的“s/z/c”齿音压制 |
| `local.audio.anlmdn` | 非局部均值音频降噪 | 音频 | 复杂宽带背景环境噪声消除，保留自然对白瞬态 |
| `local.audio.crystalizer` | 音频细节晶体化锐化 | 音频 | 灰暗、闷塞配乐或人声的通透感提升与泛音高频激发 |
| `local.audio.virtualbass` | 虚拟低音谐波增强 | 音频 | 手机/小音箱无法还原的深沉低音心理声学谐波重塑 |
| `local.audio.afwtdn` | 小波变换音频降噪 | 音频 | 高频毛刺、传感器白噪声的小波多尺度自适应滤除 |
| `local.video.atadenoise` | 自适应时域平均视频降噪 | 视频 | 暗光监控、摄像机传感器高感 ISO 颗粒的时域抑制 |
| `local.video.bm3d` | 块匹配 3D 视频高保真降噪 | 视频 | 画面降噪并尽量保留纹理和边缘，强度需按素材对照检查 |
| `local.video.cas` | 对比度自适应锐化 (CAS) | 视频 | 画面缩放或轻度模糊后的清晰度增强，检查噪点放大与边缘伪影 |

---

## 2. 详细应用场景与调用配方

### 2.1 人声齿音削减 (`local.audio.deesser`)
- **典型场景**：电容麦近距离录音产生刺耳的咝音。
- **参数建议**：
  - 轻度齿音消除：`{ intensity: 0.1, max: 0.4, frequency: 0.5 }`
  - 强力齿音压制：`{ intensity: 0.25, max: 0.7, frequency: 0.6 }`
- **原生 FFmpeg 调用**：
  ```bash
  ffmpeg -i vocal_raw.wav -af "deesser=i=0.12:m=0.5:f=0.5:s=o" -c:a pcm_s16le vocal_deessed.wav
  ```

### 2.2 非局部均值音频降噪 (`local.audio.anlmdn`)
- **当前可用性**：执行器先用固定 2 秒 PCM WAV 对实际选定的 FFmpeg 做短探测，输出到 null，不读取用户音频。结果按文件路径、大小、修改时间、变更时间及文件标识缓存；并发复用，替换构建后自动重新探测。失败返回 `ANLMDN_BUILD_UNAVAILABLE`，保留原始退出码、NTSTATUS、信号和超时信息。当前 Windows 9.0.1 essentials 构建仍有 `0xc0000374`，不能宣称可用于生产；可更换能通过探测的 FFmpeg 或明确选择 `local.audio.afftdn`。不会自动替换滤镜。
- **失败处理**：保留原始非零退出码与失败回执。原候选的 0.08 秒样本成功不能覆盖正常音频中出现的堆异常；不能因输出文件存在就忽略进程崩溃。需要完成降噪时，明确改选已有 `local.audio.afftdn`，记录实际使用的算法和输出。
- **典型场景**：室外风噪、咖啡馆底噪或低信噪比录音，传统频域降噪易产生“音乐噪声/水下声”。
- **参数建议**：
  - 默认温和底噪滤除：`{ strength: 0.00005, patch: 0.002, research: 0.006, smooth: 11 }`
  - 较强平稳噪声：`{ strength: 0.0002, patch: 0.004, research: 0.01, smooth: 15 }`
- **原生 FFmpeg 调用**：
  ```bash
  # Only use on an independently verified FFmpeg build.
  ffmpeg -i noisy_audio.wav -af "anlmdn=s=0.00005:p=0.002:r=0.006:m=11:o=o" -c:a pcm_s16le clean_audio.wav
  ```

### 2.3 音频细节晶体化锐化 (`local.audio.crystalizer`)
- **典型场景**：老旧音频翻新、过于闷厚的乐器音轨高频激发。
- **参数建议**：
  - 轻度通透度增强：`{ intensity: 1.5, clipping: true }`
  - 显著金属感与明亮度：`{ intensity: 3.5, clipping: true }`
- **原生 FFmpeg 调用**：
  ```bash
  ffmpeg -i dull_track.wav -af "crystalizer=i=2.0:c=1" -c:a pcm_s16le sparkling_track.wav
  ```

### 2.4 虚拟低音谐波增强 (`local.audio.virtualbass`)
- **典型场景**：重低音音响在普通移动端耳机或平板喇叭上播放无力。利用缺失基频（Missing Fundamental）效应生成高阶谐波，欺骗大脑感知丰厚低音。
- **参数建议**：
  - 流行音乐增强：`{ cutoff: 220, strength: 1.8 }`
  - 电影大片音效冲击力：`{ cutoff: 300, strength: 2.5 }`
- **原生 FFmpeg 调用**：
  ```bash
  ffmpeg -i music.wav -af "virtualbass=cutoff=250:strength=2.0" -c:a pcm_s16le bass_boosted.wav
  ```

### 2.5 小波变换音频降噪 (`local.audio.afwtdn`)
- **典型场景**：高频白噪、电磁轻微干扰。
- **参数建议**：
  - 快速去噪：`{ sigma: 0.02, levels: 10, wavet: 4, percent: 85 }`
- **原生 FFmpeg 调用**：
  ```bash
  ffmpeg -i track_hiss.wav -af "afwtdn=sigma=0.02:levels=10:wavet=4:percent=85:softness=1" -c:a pcm_s16le clean_track.wav
  ```

### 2.6 自适应时域平均视频降噪 (`local.video.atadenoise`)
- **典型场景**：静止或慢动作夜景视频、摄像机暗部跳动噪点。
- **参数建议**：
  - 轻度日常噪点：`{ threshold_a: 0.02, threshold_b: 0.04, frames: 7 }`
  - 强暗光杂色抑制：`{ threshold_a: 0.04, threshold_b: 0.08, frames: 11 }`
- **原生 FFmpeg 调用**：
  ```bash
  ffmpeg -i night_raw.mp4 -vf "atadenoise=0a=0.02:0b=0.04:1a=0.02:1b=0.04:2a=0.02:2b=0.04:s=9" -c:v libx264 -crf 20 -c:a copy night_clean.mp4
  ```

### 2.7 块匹配 3D 视频高保真降噪 (`local.video.bm3d`)
- **典型场景**：高质量影视后期调色前降噪，保留面部毛细孔、织物纹理。
- **参数边界**：`group` 仅接受 `1, 4, 8, 16, 32, 64, 128, 256`。通过现有参数校验调用，不能把任意整数直接传给滤镜；各合法值并不意味着同等性能或已经覆盖所有素材。
- **参数建议**：
  - 高保真快速去噪：`{ sigma: 2.0, block: 16, bstep: 4, group: 1, range: 9 }`
- **原生 FFmpeg 调用**：
  ```bash
  ffmpeg -i cinema_raw.mp4 -vf "bm3d=sigma=2.0:block=16:bstep=4:group=1:range=9" -threads 2 -c:v libx264 -crf 18 -c:a copy cinema_clean.mp4
  ```

### 2.8 对比度自适应锐化 (`local.video.cas`)
- **典型场景**：1080p 升 4K 后的边缘锐化、模糊镜头清晰度重构。
- **参数建议**：
  - 温和锐化：`{ strength: 0.3 }`
  - 电影通透清晰度：`{ strength: 0.6 }`
- **原生 FFmpeg 调用**：
  ```bash
  ffmpeg -i soft_video.mp4 -vf "cas=strength=0.4:planes=7" -threads 2 -c:v libx264 -crf 19 -c:a copy sharp_video.mp4
  ```

---

## 3. 主备策略与降级退路 (Fallback Architecture)

以下是 Agent 可选择的替代配方，不代表执行器已经自动探测和切换。遇到缺滤镜或构建失败时，保留原失败，根据素材目标选择替代工具，在新的处理记录中说明实际算法，再检查输出、时长、音轨和效果。替代操作同样可能失败，应继续保留具体错误。

| 目标操作 | 降级候选 1 (常用 FFmpeg 既有滤镜) | 降级候选 2 (替代参数/组件方案) | 效果差异说明 |
|---|---|---|---|
| `deesser` | `equalizer=f=6500:t=q:w=2:g=-6` | 动态多频段压缩 `mcompand` | 降级为固定陷波衰减，无法做到自适应动态齿音触发，但可抑制嘶嘶声 |
| `anlmdn` | 现存 `afftdn=nf=-25` | `highpass` + `lowpass` | `afftdn` 为频域 FFT 降噪，降噪效果显著但瞬态稍有软化 |
| `crystalizer` | 现存 `treble=g=3` | `equalizer=f=8000:t=h:g=3` | 降级为线性高频增益，缺乏动态泛音激发特性 |
| `virtualbass` | 现存 `asubboost=dry=0.8:wet=0.2` | `bass=g=4` | `asubboost` 侧重超低频提升，需配合具备低音单元的音箱设备 |
| `afwtdn` | 现存 `afftdn=nf=-20` | `agate` 噪声门 | FFT 降噪可作为替代；对白细节和瞬态表现需重新听审 |
| `atadenoise` | 现存 `hqdn3d=2:1.5:3:2` | `tmix=frames=3:weights=1 1 1` | `hqdn3d` 空间时域混合降噪，快速且成熟 |
| `bm3d` | 现存 `nlmeans=s=1:p=3:r=5` | `hqdn3d=3:2:4:3` | `nlmeans` 同样基于非局部匹配，运算效率更高但极高频纹理稍逊 |
| `cas` | 现存 `unsharp=5:5:0.5:5:5:0` | `convolution` 自定义卷积核 | 传统反锐化掩模在强对比边缘易产生轻微白边振铃 |
