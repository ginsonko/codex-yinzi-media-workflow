# 第三方组件与资产

本项目的社区非商业条款只覆盖有权授权的原创增量，不替代以下许可。

| 组件 | 用途 | 许可与来源 |
| --- | --- | --- |
| LocalMiniDrama | 原始应用基础 | MIT；[原许可](licenses/LocalMiniDrama-MIT.txt)、[上游](https://github.com/xuanyustudio/LocalMiniDrama) |
| Node.js | 运行 JavaScript | [Node.js 许可](https://github.com/nodejs/node/blob/main/LICENSE)，安装器下载官方发行版并核对 SHA-256 |
| FFmpeg / FFprobe | 剪辑、混音、字幕和媒体检查 | GPL v3；[FFmpeg](https://ffmpeg.org/)、[Gyan builds](https://www.gyan.dev/ffmpeg/builds/)。源码仓库不捆绑可执行文件，安装器从发布者下载校验后的独立工具，保留包内 LICENSE / README。下载到的工具遵守其原始许可，不受本项目非商业条款限制 |
| Kenney 3D assets | 导演台示例角色 | CC0；[随附许可](frontweb/public/director-assets/kenney/LICENSE-KENNEY.txt)、[Kenney](https://kenney.nl/) |
| Vue、Vite、Pinia、Three.js、Express、better-sqlite3 等 | 前后端基础 | 按锁文件解析的各包原许可，安装后见 node_modules 中的 LICENSE 和 package.json |
| node-edge-tts | 在线语音合成 | MIT；[项目](https://github.com/SchneeHertz/node-edge-tts)。使用在线服务另须遵守提供者条款 |
| 示例图片与视频 | 引导和流程演示 | 项目公开演示素材，沿用适用来源许可；不包含本机私人任务数据库或用户上传库 |

发布自行打包的二进制时，应同时提供依赖对应版本的许可证、版权、源码提供义务及构建信息；
本仓库的源码安装说明不构成所有二进制组合已完成分发合规审查的证明。
