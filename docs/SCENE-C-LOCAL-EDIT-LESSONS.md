# 真人改编与短片精剪经验

本案例曾尝试将动画场景改编为约一分钟真人片。生成的视频存在身体静止、只有嘴动、局部错脸和参考道具不准确等问题，不能把这一路线称为完整成功。用户停止进一步生成后，制作转为筛选已有动态素材，通过本地 AE 剪成 13.33 秒概念样片。最终关键词字效版已获用户认可。

## 可复用的做法

- 先核准所有出场人物的参考图、服装、道具与场景。身份参考用于保持人物，而不是强行复制动漫的静止姿势。
- 约束出现冲突时说明取舍。用户允许电影化改编后，保留故事、对白与大致节奏，放开机位、构图和演员动作；先看真实短段表现，再扩大制作。
- 记录每段素材的来源区间，排除错脸、隐藏切镜、重复动作和接触错误。画面可解码不等于表演自然；AE 后期和插帧不能凭空修复演员身份或演技。
- 宣传片保留关键对白与环境声，音乐要适合作品及情绪。不要每个镜头重新起同一个循环，也不要让人物嘴动时没有声音。对白、音乐、环境和音效分轨，轻压对白下的音乐。
- 字效只使用已确认的剧情信息。本片采用“电话微波炉 / 时空跳跃 / 凝胶香蕉”三个关键词，结合场景留白、光色和聚焦设计，不用自编旁白或粗体字幕贴片。
- 3～4 秒附近的切换用短暂失焦和溶接衔接，保留已认可音轨。只修改用户指出的位置，保存前版和可编辑工程。

## 不能外推的结论

这次通过的是短样片，不是完整一分钟真人重制。原素材表演偏静的局限仍在。短参数请求偶然返回较长视频，不是输出时长或计费保证。听感与观感必须看实际结果，响度、哈希和解码检查不能代替用户审片。

通用操作已整理进 [真人表演参考](../codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/skills/codex-yinzi-universal-video/references/live-action-character-performance.md)、[音乐驱动剪辑](../codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/skills/codex-yinzi-universal-video/references/music-driven-editing.md) 和 [故事与合成](../codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow/skills/codex-yinzi-universal-video/references/music-mv-story-and-compositing.md)。需要新歌曲时，参考 [本地音乐按需准备](LOCAL-SONG-YUE2.md)，先检查实际硬件再推荐下载。
