# Codex 银子万能媒体工作流

**把想法和素材交给 Codex，从脚本到成片，在一个工作台里看见进度与成果。**

为个人创作者准备的本地媒体工作流。Codex 负责理解目标、研究、设计方案和检查质量，工作台负责素材、模型配置、批量执行、进度和恢复。适合个人短片、小说漫剧实验、知识口播、旅行 Vlog、直播片段整理，以及商品视觉与广告的学习练习。

![创建模型 Key 并开始使用](docs/images/key-steps.svg)

[快速安装](#三步开始) · [配置 Key 图文说明](docs/BEGINNER-KEY-SETUP.md) · [安装与故障排查](docs/INSTALLATION.md) · [分享 Skills](CONTRIBUTING.md) · [许可证](LICENSE)

## 三步开始

**Windows 10/11，64 位。首次安装需要联网和可用的 Codex。** 本轮内测首先覆盖 Windows x64 源码安装。

### 1. 把仓库交给 Codex

最省事的方式是在 Codex 中发送：

```text
请帮我安装并启动 Codex 银子万能媒体工作流：
https://github.com/ginsonko/codex-yinzi-media-workflow
读取仓库 AGENTS.md，执行根目录 install.ps1，安装 Skills 并打开工作台。
先不配置 Key，带我看一遍示例。
```

也可以把含本仓库地址的宣传图交给 Codex，再说“帮我安装这个”。仓库中的安装 Skill 和 `AGENTS.md` 会告诉它如何完成安装。

手动安装只需：

```powershell
git clone --depth 1 https://github.com/ginsonko/codex-yinzi-media-workflow.git
cd codex-yinzi-media-workflow
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

没有 Git：点击 GitHub **Code → Download ZIP**，解压到固定目录，双击 **install.cmd**。
拉取/解压本身不会执行代码；安装器运行后才会完成安装。无需自己寻找或复制 Skills。

### 2. 看示例，按需配置模型

安装器检查 Node.js 22+、安装锁定的依赖、下载并校验 FFmpeg、注册 Codex Skills 和工具、构建前端并打开工作台。首次安装耗时取决于网络；下载失败可重跑，已有数据保留。**安装不会扣模型余额。**

工作台首页可选进入示例，也可以直接跳过。前 10 分钟可以这样体验：

| 时间 | 做什么 | 得到什么 |
| --- | --- | --- |
| 0–2 分钟 | 打开首页，选择示例 | 看懂素材、计划和成果之间的关系 |
| 2–5 分钟 | 按需打开“模型与 Key” | 银子 API 一键预填 URL/推荐模型；也支持其他服务商 |
| 5–8 分钟 | 发一段需求或自己的素材给 Codex | Codex 按质量优先建立适合这次需求的计划 |
| 8–10 分钟 | 查看“任务与计划”和成果 | 看到当前动作、最近更新、等待原因和处理进度 |

这些步骤均可跳过，不要求一次学会所有设置。拿不准就问 Codex。

| 你的配置 | 可以开始的工作 |
| --- | --- |
| 不配置云端 Key | Codex 写脚本、素材整理、已有视频剪辑、字幕音频处理、任务规划、3D 预览 |
| 图片模型 URL + Key + 模型名 | 宣传图、角色/场景/道具图、分镜参考图、图像变体与批量生图 |
| 视频模型 URL + Key + 模型名 | 文生/图生视频、动态镜头与片段，具体参数以所选模型能力为准 |
| 可选文本模型 | 用自己喜欢的模型写对白、口播、分镜或参与创意审核 |
| 可选 Blender | 可编辑 3D 工程、构图运镜参考、逐帧渲染与参考视频 |

推荐入口依次为 [银子 API](https://yinziapi.top/)、银子媒体站、老李站点；服务商由你选择。
银子 API 访问端点是 `https://api.yinziapi.top/v1`。**模型调用费用由服务商收取，账户余额与权限以实际配置为准。**
图文步骤见 [在哪里创建 Key、复制什么、粘贴哪里](docs/BEGINNER-KEY-SETUP.md)。

### 3. 开一个 Codex 新任务，描述成果

```text
把这个文件夹的旅行素材剪成 60 秒 Vlog，先筛掉重复镜头。
默认质量优先，配合适的音乐和字幕，先使用已有素材。
```

```text
把这段小说做成 30 秒短片，先设计角色和分镜，保持人物一致。
需要生成图片或视频时，告诉我将使用的模型和预计费用。
```

安装后新任务会发现媒体与文本 Skills；如果仍未显示，重启 Codex。旧任务也可直接读取仓库 Skill，使用 CLI 继续。Skill 会检查后台、必要时启动，并给出当前工作台地址。端口占用时自动选择空闲端口。

## 工作台能做什么

- **统一管理**：项目、剧集、任务、批量生成、素材库、模型与 Key、工具目录在同一个界面；支持亮/暗主题。
- **质量档位**：质量优先（默认）、均衡、速度优先，影响规划、创意迭代和验收深度；不会擅自扩大付费预算。
- **可恢复批量任务**：用户设置并发上限；可从 1 开始逐步探索，成功再增加，遇到长尾、限流或错误时停止扩容。
- **模型自由选择**：图片、视频和文本均支持多配置与备注；文本最多 100 份。费用、分辨率和能力说明可选，Codex 可根据实测补充。
- **3D 与剪辑**：Three.js 导演台、可选 Blender、素材剪辑、字幕、配音、混音与导出。最终检查可播放性、内容、构图和音画。
- **社区扩展**：工具包导入/导出与去重，工具启停和管理；Codex 可以在用户授权下添加或改进工具。

查看正在执行、等待处理和已完成的结果；遇到不确定的上游请求，先按原任务查询，避免重复生成和扣费。

## 日常启动与更新

- 打开：双击 `start.cmd`，或让 Codex“启动银子工作流”。首页的小按钮可以添加 Windows 桌面快捷方式。
- 更新：在仓库执行 `git pull --ff-only`，再运行 `install.cmd`。安装器刷新依赖与 Skills，保留本机 Key、项目和媒体；有自己修改的源码时先让 Codex 处理合并。
- ZIP 用户：下载新版到新目录，运行安装器；保持原数据目录，安装器会迁移自己创建的 Skill 链接。
- 数据：默认在 `%LOCALAPPDATA%\Yinzi\CodexVideoWorkflow`，与 Git 源码分开。备份、诊断、卸载和高级参数见 [安装说明](docs/INSTALLATION.md)。

## 开发与目录

| 目录 | 内容 |
| --- | --- |
| `backend-node/` | API、SQLite 迁移、编排、模型适配、媒体工具和测试 |
| `frontweb/` | Vue 工作台、公共示例资产和测试 |
| `codex-yinzi-universal-video-workflow/` | Marketplace、插件、MCP、媒体与文本 Skills、运行时启动器 |
| `.agents/skills/` | 拉取仓库后即可发现的安装 Skill |
| `runtime/blender/` | Blender 工程与渲染桥接 |
| `desktop/` | Electron 可选打包源码与图标；当前内测使用根目录源码安装 |
| `scripts/`、`docs/` | 安装依赖锁、操作说明与社区指南 |

运行 `install.ps1 -SkipCodexInstall -NoBrowser` 可只准备本地开发工作台。
Node.js 22+ 下在 `backend-node` 执行 `npm ci --ignore-scripts`，在 `frontweb` 执行 `npm ci`；构建用 `npm run build`（frontweb）；测试见 [贡献指南](CONTRIBUTING.md)。

## 社区与许可

欢迎个人学习、改进、二次开发与免费分享 Skills；**禁止未经授权的商业使用，分发和二开必须标注来源**。例如收费 SaaS、商业内部部署、代运营接单、商品广告生产及收费培训打包需要另行书面授权。

本项目采用 [社区非商业来源标注许可证](LICENSE)，属于公开源码、非商业共享项目，不使用“OSI 开源”来描述该许可。上游 LocalMiniDrama 和此前已按 MIT 发布的内容继续遵守 MIT；第三方组件遵守各自许可。详见 [NOTICE.md](NOTICE.md) 与 [第三方声明](THIRD_PARTY_NOTICES.md)。

内测反馈请发到 [Issues](https://github.com/ginsonko/codex-yinzi-media-workflow/issues)，附操作步骤、Windows/Codex 版本和脱敏截图，切勿上传 Key 或数据库。
