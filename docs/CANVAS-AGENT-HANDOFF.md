# 画布创作与专用 Agent：本地功能基线交接

日期：2026-10-10。源码目录：`C:/YinziDev/media-canvas-agent-20261010`。分支：`feat/canvas-agent-20261010`。

本次在重新 fetch 并核对的 `origin/main=05b8a5ea093a083f6507e4a660dd0b912f1a2239` 上增加功能。只交付本地版本，未 push、未发布官网、未切换已安装工作流。用户下一步把本目录交给 Opus 5.5 做前端优化。

## 如何打开

当前隔离预览：`http://127.0.0.1:64410/create-canvas`。首页和侧边栏均有「画布创作」。

服务停止后，在源码根目录运行：

```powershell
node scripts/start-canvas-preview.cjs
```

脚本优先使用 64410；如果端口被其他程序占用，会选择空闲端口并打印真实地址。已有本预览进程则返回原地址。实际地址与进程身份记录于 `.yinzi-local/canvas-preview/preview.json`。

数据目录：`C:/YinziDev/media-canvas-agent-20261010/.yinzi-local/canvas-preview`。其中 `canvas-preview.db` 是预览数据库，`storage` 是上传、生成、分析和合成文件，`config.json` 是预览运行配置。专用模型 Key 保存在该实例现有模型配置表中，不进入画布、聊天或项目导出。此目录被 Git 忽略。

这是开发预览，用户现有安装实例与数据仍在原位置。需要自己的模型时，在此预览的「模型与 Key」配置图像/视频模型，在「Agent 配置」选择或新增独立文本 URL、Key、模型。无需 Codex 也能手动上传、编辑、连线和生成。

改前端后：`cd frontweb` → `npm run build` → 刷新预览。改后端后应关闭本预览进程，再运行上面的启动脚本。不要用安装器去覆盖用户正式运行时，仅为视觉迭代不需要改变发布配置。

## 已接通的操作

- 创建与切换多张持久画布；文本/剧本、图片、视频、音频节点；拖动、缩放、多选、连线、整理布局。
- 上传本地图片/视频/音频，导入已有素材库与热门/商品视频研究报告，保留来源。研究导入当前为前 100 条，明确保留 total/next_offset；不是假称已观看所有参考视频。
- 逐节点选择图像/视频配置与模型、提示词、画幅、时长、分辨率和高级参数。复用 image2/image2.5 已有 21 档尺寸映射，不重建另一套参数表。
- 参考连线支持普通参考、首帧、尾帧和上下文；一批中先生成上游，再把本次上游的真实产物传给下游；生成参数与参考快照保存在任务中。
- 手动与 Agent 共用同一后端节点。每次显式再生成产生新版本；已有成功版本可继续再生成，也可切回历史结果。刷新、网络恢复使用原请求身份，避免误发重复请求。
- 专用 Agent 支持独立模型配置、原生 tool calling 与显式 JSON 动作兼容模式；当前传输为 **OpenAI Chat Completions**。用户可以发纠正、停止、继续生成任务；后台保留消息、工具实回执、运行与产物。
- Agent 可读取画布、查询模型、编辑节点、生成、等任务、控制任务、导入素材/研究、分析媒体和顺序导出。失败、空响应、协议不支持都显示真实结果，不伪造完成、不静默换模型。
- 图片查看与视频镜头分析/接触表、音频节拍分析接到现有本地工具。接触表是抽样视觉证据，不代表全片逐帧审看。
- 选择视频节点顺序、导出真实 MP4、在任务面板下载。使用既有严格合成，失败不回退为第一段冒充全片。并发导出使用独立子进程与临时目录。
- 宿主 MCP 新增 `creation_canvas`，使用相同 API。宿主可配置、发指令、观察、中断、纠正和验收，无需模拟人工点画布。

## 实际验收

1. 后端定向回归 **51/51**，覆盖新增画布、Agent、恢复、运行忙闲识别、既有手动参考、批量服务、素材交付与真实研究报告逻辑。
2. 现有前端回归 **214/214**；生产构建通过。保留原有大 chunk 提醒，未趁此改造无关打包策略。
3. 真实 Edge 浏览器：创建、上传、模型选择、助手多轮工具调用、按参考生成、刷新、编辑、再次生成、延迟保存期间切换节点、真实 FFmpeg 导出、移动端与旧页面路由。最新 JSON 与截图路径见本目录的 `CANVAS-ACCEPTANCE.md`。
4. 真实视频分析产生接触表；两份同时导出得到不同路径且可下载；故意挂住远程下载时关闭导出子进程，在五秒内返回并保留中断记录。
5. 实际启动 `src/server.js`，生成本地测试图片，然后在文本请求进行中强杀该**隔离测试进程**、重启；原图片和节点恢复、对话标明中断；供应商记录仍只有一次图片请求和一次文本请求。
6. 实际启动 MCP stdio 服务，通过 JSON-RPC 创建/配置/编辑/发消息/读取同一后端画布。
7. 独立审查确认四项已修复：异步切换串目标、下载恢复后画布不对账、挂起导出阻塞关闭、并发导出共用文件名。详见 `CANVAS-INDEPENDENT-REVIEW.md`。

**证据范围**：模型端点均为本地 HTTP 模拟供应商；FFmpeg、文件下载、SQLite、浏览器、MCP 与主服务进程是真实运行。未调用付费生成或付费文本模型，不能据此宣称任意线上模型协议和创作品质已经验收。批量和研究原有入口已保留，未对用户正式数据库做迁移/切换。

## 给 Opus 5.5 的前端范围

主要文件：

- `frontweb/src/views/CreationCanvas.vue`：画布、编辑侧栏、助手、任务、配置/导入/导出弹窗。
- `frontweb/src/components/CreationCanvasNode.vue`：节点外观、预览与连接点。
- `frontweb/src/api/creationCanvas.js`：HTTP 接口封装。
- `frontweb/src/components/AppShell.vue`、`frontweb/src/views/HomeDashboard.vue`、`frontweb/src/router/index.js`：入口。

可优化画布布局、快捷操作、节点工具条、配置引导、任务可读性、手机端。保持既有深色主题风格的一致性；用户会另行提供审美要求。这次已经有可用功能，勿将后端真实生成换成前端假状态或写死演示。

必须保留的接线：点击时冻结画布/节点身份；异步响应不能覆盖新选中的编辑草稿；`request_id` 的恢复与再生成含义；实体 `expected_version`；独立配置 ID；生成 attempt 归属；停止与后端生命周期；上传的图片/视频/音频及首尾帧引用；原 `/batch`、`/free-create`、`/research` 功能。

接口根 `/api/v1/creation-canvases`。集合 GET/POST；对象 GET/PATCH；`operations`、`generate`、`messages`、`import-assets`、`import-research`、`export-video`；`jobs/:jobId` 及 pause/resume/cancel；`runs/:runId` 与 stop；`nodes/:nodeId/inspect`、`nodes/:nodeId/media`；`exports/:jobId/file`、`export.json`。正文合同以 `backend-node/src/services/creationCanvas/agent.js` 工具 schema 和插件 `mcp/canvas-tools.mjs` 为准。

## 已知边界

- 不是把 Toonflow 整个 Electron 应用塞入工作台。本次参考其画布/专用助手交互方式，用我们现有 Vue Flow、SQLite、上传、模型配置、批量队列、分析和合成主链实现。参考源码没有复制，不能称为完整 Toonflow 功能移植。
- 本轮交付是本地功能版；现有项目本就有桌面打包目录，但尚未额外制作/验收新的 EXE 安装包。参考项目能打包不等于本分支已经交付 EXE。
- 本版原生支持的是 Chat Completions，未实现 Claude Messages、OpenAI Responses 等独立传输。兼容服务和实际模型需实测，JSON 动作模式也需要模型能遵循合同。
- 视频导出是按序统一画幅与拼接：16:9 为 1280×720，9:16 为 720×1280，1:1 为 960×960。完整时间线、精确裁切、配乐混音、字幕特效继续使用已有媒体编辑工具；这里不冒充完整 NLE。
- 大规模节点/长历史和长时间并发没有压力数据；不宣称速度提升比例。终态任务分批低频核对，活跃任务持续更新；页面当前约 1.5 秒轮询。
- 本地预览的测试图和测试视频仅用于验证功能，不是 AI 创作品质示范。界面审美优化与真实作品验收是后续阶段。

## 可复现命令

```powershell
cd C:/YinziDev/media-canvas-agent-20261010/backend-node
node --test test/creationCanvas.test.js test/creationCanvasRecovery.test.js test/creationCanvasProcess.test.js test/runtimeWorkStatus.test.js test/manualBatchReferences.test.js test/mediaBatchService.test.js test/manualDelivery.test.js test/productResearchJobs.test.js
node test/e2e/creationCanvas.browser.cjs
cd ../frontweb
node --test test/*.test.js
npm run build
```

前端浏览器验收使用本机 Edge 与已安装 playwright-core；每次新建隔离临时目录和模拟模型，不读取用户 Key。不要把这些模拟模型配置复制为正式模型候选。
