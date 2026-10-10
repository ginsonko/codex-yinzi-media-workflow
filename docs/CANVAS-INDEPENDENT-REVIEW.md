# 无限画布创作 Agent：首轮独立对抗审查

日期：2026-10-10。审查者：`canvas_acceptance`。主工程：`C:/YinziDev/media-canvas-agent-20261010`。

本轮先读 `docs/CANVAS-AGENT-PLAN.md`，随后只读检查画布存储、生成依赖、专用 Agent、HTTP 路由、前端及导出服务。未修改产品源码，未调用付费供应商，未对外发布。主线程在并行进行浏览器和真实 FFmpeg 验收，本报告不代替该验收。

以下四项是在首轮源码快照中确认的问题。主线程已经接手修正；本报告保存发现和复现证据，**不是对修正后版本的最终结论**。行号对应发现时快照，后续修改可能使行号变化。

## R1 / P1：异步保存后生成落到新选中的节点或画布

- 位置：`frontweb/src/views/CreationCanvas.vue`，原 `generateNode` 第 141 行及 `saveNode` 第 125 行。
- 原实现为 `await saveNode(); await submit('generate', {node_ids:[selected.value.id]})`。`submit` 又读取当时的 `canvasId.value`。
- 复现：在 A 画布选中 A 节点点击“保存并生成”；保存请求尚未返回时，切换到 B 画布/B 节点；保存返回后生成请求使用 B。这可能对并非刚才确认的目标产生收费生成。
- 已执行最小复现：用 Node `vm` 读取源码中的原 `generateNode`，只把保存响应延迟，期间切换响应式选择。没有访问供应商。

```json
{"clicked":{"canvas":"canvas-A","node":"node-A"},"actual":[{"canvas":"canvas-B","action":"generate","input":{"node_ids":["node-B"]}}]}
```

- 最小修正：操作入口固定 `canvas_id/node_id` 和待保存内容；保存、生成、分析及弹窗异步提交沿用该目标；异步完成后仅在界面仍属于原目标时刷新草稿或面板。
- 主线程反馈：已接手，前端目标快照修正正在落地。尚未执行修正后定点复查。

## R2 / P2：终态生成不再对账，下载恢复后的真实产物无法自动回到画布

- 位置：`backend-node/src/services/creationCanvas/service.js`，`pump` 原第 103 行、`controlJob` 原第 129 行起。
- `pump` 在 job 已失败、步骤为 `needs_review` 时直接跳过。随后用户去原生成队列恢复下载，原 batch 即使已经完成，画布也不再调用 `reconcile`。此外，`resume` 排除了所有 `TERMINAL` 步骤，包含 `needs_review`，因此不能主动消费该原批次的迟到回执。
- 已执行最小复现：内存 SQLite，画布服务使用只在内存变更的 mediaBatch 替身。`processing → needs_review` 后使画布失败；再把原 batch 改为 `completed` 并提供 `local_path`，调用 `pump`。无网络和付费请求。

```json
{"before":{"status":"failed","step":"needs_review"},"providerNow":"completed","after":{"status":"failed","step":"needs_review","media":null}}
```

- 最小修正：对已拥有 `batch_id` 的步骤继续有界、低频、只读对账；恢复操作可调用原批次 `resume` 以消费迟到回执。保持原生成身份，不能因此重新提交供应商。
- 主线程反馈：已接手终态批次低频只读对账修正。尚未执行修正后定点复查。

## R3 / P2：挂起导出会无限阻塞关闭，退出计时器没有机会安装

- 位置：`backend-node/src/services/creationCanvas/service.js` 原第 193–208 行；`backend-node/src/server.js` 第 56–67 行；`backend-node/src/services/videoMergeService.js` 原第 126、158、213 行。
- 导出只保存 Promise，不保留可终止的 Worker 句柄；`stop()` 无期限等待全部导出 Promise。被调用的远程素材 `fetch` 与 FFmpeg `spawnSync` 也没有期限。
- `shutdown` 先 `await creationCanvas.close()`，直到该等待完成后才安装五秒退出计时器。所以挂起的远程视频或 FFmpeg 会使关闭停在这一步，用户无法正常重启完成更新。
- 证据类型：已完整追踪源码等待关系；未启动一个故意无限挂起的真实 FFmpeg 进程，以免干扰主线程导出验收。
- 最小修正：保存并管理 Worker 句柄；关闭有界终止并记录中断状态，冷启恢复本地导出；把进程退出兜底计时器放到首个等待之前，并给下载/FFmpeg 加明确期限。关闭不应重放付费生成。
- 主线程反馈：已接手 Worker 生命周期和有界关闭修正。尚未执行修正后定点复查。

## R4 / P2：并发导出共用毫秒级临时文件名，可能串片或互删

- 位置：`backend-node/src/services/videoMergeService.js` 原第 142、229、297、346 行。
- 画布每份导出启动独立 Worker，但均使用 `os.tmpdir()/drama-video-merge`；临时标准化片段为 `strict_${Date.now()}_${index}.mp4`，拼接列表为 `concat_list_${Date.now()}.txt`，输出为 `merged_${Date.now()}.mp4`。
- 同毫秒推进的两个 Worker 可以写入相同文件，某个导出清理时又可删除另一份仍在消费的片段。现在的 Worker 并发使原本同步代码里的文件名假设不再成立。
- 证据类型：共享目录及无唯一任务身份的源码竞态；未做多 FFmpeg 压力复现，也未测量发生概率。
- 最小修正：每个 `merge_id` 使用独立临时目录；输出和列表使用任务 ID 或 UUID，清理范围只限本任务目录。
- 主线程反馈：已接手独立临时目录和 UUID 文件名修正。尚未执行修正后定点复查。

## 已验证的正向边界

- 后端节点变更通过实体版本检查与事务执行；一个批次里后续编辑冲突不会保留前面的半成品变更。
- 生成步骤保存参数、参考节点与依赖快照；后续依赖取本次上游步骤的产物。
- 节点产物回收使用 `active_attempt_id`，旧尝试不会直接覆盖较新的活动尝试；手动设置媒体会取消原活动尝试的覆盖权。
- 画布任务、运行、媒体读取均以所属画布 ID 检查；没有在本轮指定范围发现一个已复现的后端跨画布读取问题。
- Agent 检查中断信号后不再启动后续工具；重启会把未结束文本轮标为 `interrupted`，不静默重放模型请求。
- 画布导出明确传入 `strict: true`，合成失败不使用首段冒充完整成片。最终可播放性、顺序和时长仍由主线程真实 FFmpeg 验收覆盖。

执行的已有定向测试：

```text
node --test --test-name-pattern="canvas edits|dedicated Agent|JSON-action" test/creationCanvas.test.js
```

结果：3 项通过，0 项失败。覆盖事务/画布隔离/脱敏/版本检查/请求复用、专用配置与真实本地 HTTP 工具循环、停止阻止后续工具、JSON 动作模式、空响应和供应商报错可见。测试名称里的 `survives reload` 不应解读为已经完成杀进程冷启验收。

本轮未覆盖：真实付费模型的质量/协议差异、真实服务进程被强杀后的全链恢复、长时间并发压力、修正后上述四项的复测、浏览器完整作品体验。首轮没有以局部通过冒充最终产品验收。

## 四项修正的定点复查（2026-10-10）

主线程完成修正后，本审查者重新读取了当前 `CreationCanvas.vue`、画布 `service.js`、导出子进程、服务关闭入口、`videoMergeService.js` 和新增恢复测试。严格限定在 R1–R4，没有扩大审查范围或修改产品源码。

**结论：R1–R4 均已实质修正；这四项中没有遗留的已确认 P1/P2。** 该结论限定于下述源码链与本机测试，不代表真实供应商质量或所有平台已经验收。

| 项目 | 当前实现与独立证据 | 结论 |
| --- | --- | --- |
| R1 生成串目标 | `actionContext` 固定画布/节点/界面代次；`saveNode` 返回原 context；`generateNode` 将原 ID 显式传给 `submit`，异步返回仅在原界面仍有效时刷新草稿。读取当前函数做 VM 延迟保存复现，分别在同画布切节点、跨画布切节点，保存与生成均仍指向 `canvas-A/node-A`，没有重新加载 B 的草稿。 | 通过 |
| R2 迟到产物不回收 | 终态批次默认每 15 秒分页只读对账，每页 100 条；终态对账不会调用生成提交，`needs_review` 恢复允许原批次恢复查询。新增测试实际验证下载失败后恢复完成、创建批次计数仍为 1；较旧结果与人工替换不会覆盖当前媒体。 | 通过 |
| R3 关闭被导出阻塞 | 导出改为受控子进程，保存中断控制器；Windows 仅针对本次子进程 PID 执行进程树停止，导出另有可配置总期限。关闭首先中断导出，保存 `interrupted`；服务五秒退出计时器已移到首次 `await` 前。真实本地 HTTP 服务故意不返回响应头，测试关闭在五秒以内完成，记录保留为 `interrupted`。 | 通过 |
| R4 并发临时文件相撞 | 每次合成使用 `mkdtemp` 独立目录，输出包含 merge ID 和 UUID，拼接列表使用 UUID，清理只作用于本次独立临时目录。两份真实 FFmpeg 导出并发完成，输出路径不同，两份文件均通过存在性与大小检查。 | 通过 |

独立执行命令：

```text
node --test test/creationCanvasRecovery.test.js
```

结果：**5 项通过，0 项失败，总测试耗时约 5.13 秒**。实际项目为：

1. 迟到下载回收、旧 attempt 与人工替换的归属保持。
2. 服务对象重建后保留批次身份、中断文本轮、依赖暂停/恢复不重复提交。
3. 真实视频分析、两份真实 FFmpeg 并发合成与本地结果读取。
4. 挂起子进程下载的及时停止与可恢复记录。
5. MCP stdio 通过同一后端创建、配置、编辑、发消息并读取画布。

R1 额外最小复现输出的两种情形均为：

```json
{"save":{"canvas":"canvas-A","node":"node-A"},"generate":{"canvas":"canvas-A","node":"node-A"}}
```

验证边界继续保留：本轮没有调用真实付费 API，没有重跑完整浏览器视觉验收，没有进行操作系统强杀主服务后的完整恢复测试，也没有验证其他操作系统上的进程树终止。上述恢复测试的第二项属于共享持久数据的服务对象重建，不应写成已经实测整个应用被强杀后的冷启动。FFmpeg 测试验证真实合成与不同输出文件；最终画面、顺序、音画与时长的完整浏览器验收由主线程证据负责。
