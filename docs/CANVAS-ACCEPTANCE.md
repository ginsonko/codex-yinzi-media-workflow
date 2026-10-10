# 画布创作本地验收记录

日期：2026-10-10。基线 `05b8a5ea093a083f6507e4a660dd0b912f1a2239`，本地分支 `feat/canvas-agent-20261010`。报告只覆盖本分支新增画布能力及相关回归；没有把本地接线验证等同于付费模型创作质量。

| 检查 | 实际结果 | 证据 |
|---|---|---|
| 原有手动参考、批量生成、素材交付、研究；新增画布、恢复、忙闲状态 | 51/51，无失败、无跳过 | `.yinzi-local/canvas-preview/acceptance-backend.log` |
| 原有前端逻辑回归 | 214/214，无失败 | `.yinzi-local/canvas-preview/acceptance-frontend.log` |
| Vue 生产构建 | 通过；既有大 chunk 提醒保留 | `npm run build`，本轮终端回执 |
| 真实Edge完整页面链路 | 8组检查通过，page_errors为空 | `.yinzi-local/canvas-preview/acceptance-browser.log` |
| 图像参考→图片→视频首帧 | 本地HTTP真实适配器与下载；下游收到图像字节，非不可访问的localhost引用 | `test/creationCanvas.test.js` |
| 对话专用模型与原生/JSON动作 | 实际HTTP多轮、编辑回执、停止与错误显示通过 | 同上 |
| 延迟保存期间切节点/整张画布 | 原节点/原画布生成，新选中草稿保留，未重定向 | `test/e2e/creationCanvas.browser.cjs` |
| 迟到下载、旧版本回收、人工替换媒体 | 原批次只读对账成功；旧产物不覆盖新选择 | `test/creationCanvasRecovery.test.js` |
| 素材与真实研究报告导入 | 来源/版本/101条报告的100条导入及next_offset保留；重复请求未重复导入 | 同上 |
| 视频分析与并发导出 | 实际生成接触表；两份真实FFmpeg导出路径独立且可下载 | 同上 |
| 挂起导出关闭 | 故意不回应HTTP请求，子进程树被结束，五秒内返回，任务记为interrupted | 同上 |
| MCP | 真正启动stdio进程；创建、配置、编辑、对话、读取落到同一后端 | 同上 |
| 主服务强杀后冷启 | 真正启动两次server.js；媒体保留，对话中断；1次图片/1次文本请求均未重放 | `test/creationCanvasProcess.test.js` |
| 完整应用预览 | 首页/批量/手动/研究/画布均渲染；MCP实际读取本预览画布，page_errors为空 | `.yinzi-local/canvas-preview/evidence/full-app-check.json` |
| 独立对抗验收 | R1–R4四项确认缺陷已全部修复并定点复查 | `CANVAS-INDEPENDENT-REVIEW.md` |

最后一次浏览器临时测试目录：`C:/Users/ADMINI~1/AppData/Local/Temp/yinzi-canvas-8hjRyl`。核心证据已复制到源码内 Git 忽略的 `.yinzi-local/canvas-preview/evidence/`，不依赖用户记住临时目录：

- `browser-evidence.json`：真实节点、请求次数、合成任务回执。
- `canvas-desktop.png`、`canvas-mobile.png`：页面截图。
- `actual-ffmpeg-export.mp4`：实际下载合成文件，531176字节。
- `export-probe.json`：ffprobe与完整解码。H.264视频1280×720，AAC音轨，2.021029秒；全片解码退出码0。

这些为本地功能测试素材。图像为纯色图，视频为FFmpeg测试片，不能用来评价模型美术质量。最初浏览器测试出现过Element Plus选择器遮挡及测试脚本等待条件错误，已修正选择器/等待并重新验收；没有将这些失败记录伪装成一次通过。

真实预览使用完整应用和独立数据库，地址由 `.yinzi-local/canvas-preview/preview.json` 给出。它与测试夹具不同，可由用户自行配置模型继续创作。用户原安装实例、Key、已有任务和历史作品未被替换。

未验收：真实付费供应商、任意模型的工具调用/视觉品质、超大画布和长时间压力、额外EXE安装包。当前文本协议为Chat Completions；详见交接说明中的边界。

AP-Vibe：回读仍为revision 730，11章齐全、10个评估维度均有理由/风险/改进（未知评分保持null）。本次增量保留所有旧章节后存为 `.yinzi-local/canvas-preview/ap-vibe-pending-patch.json`，request_id=`media-canvas-local-closeout-20261010-v1`。在线提交返回 `knowledge patch exceeds byte budget`，未声称同步成功，也未删旧历史来腾空间。当前功能基线、交接与恢复入口已本地冷保存。
