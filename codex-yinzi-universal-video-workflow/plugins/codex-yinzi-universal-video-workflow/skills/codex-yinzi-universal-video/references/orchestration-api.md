# Orchestration API
- GET /api/v1/orchestration-onboarding returns a secret-free first-use snapshot: connection, capabilities, active service counts, low-gate guidance, and a budget reminder.

Use the canonical local base URL, normally `http://127.0.0.1:5683`. The bundled MCP server and CLI probe local candidates (`5683,5679,5680,5682`) when `YINZI_WORKFLOW_URL` is not set, prefer a canonical identity, and stop on conflicting identities, so a healthy older API instance is not mistaken for the active orchestration runtime. API responses wrap successful data in `{success:true,data:...}`. The bundled CLI unwraps this shape.

## Read endpoints

`GET /api/v1/creative-preferences` returns `quality_profile` and `unattended_mode` (default false). `PUT` updates only supplied fields; send `{"unattended_mode":true}` after a user checkbox action or explicit unattended/spending authorization. MCP exposes `get_workflow_preferences` and `set_workflow_preferences`; CLI exposes `preferences` and `set-preferences --input <file>`. Startup and session bundles include the current preference. A plan without `confirm` is automatically confirmed for production work in unattended mode; explicit `confirm:false` and analysis-only intent remain waiting.

- `GET /health`
- `GET /api/v1/orchestration-modules`
- `GET /api/v1/orchestration-modules/:moduleId`
- `GET /api/v1/orchestration-sessions?limit=50`
- `GET /api/v1/orchestration-sessions/:id?include_inactive=true&event_limit=500`
- `GET /api/v1/orchestration-sessions/:id/events?after=0&limit=500`
- `GET /api/v1/orchestration-sessions/:id/export`
- `GET /api/v1/orchestration-sessions/:id/blender/jobs`
- `GET /api/v1/orchestration-sessions/:id/blender/jobs/:jobId`

## Write lifecycle

Create with `POST /api/v1/orchestration-sessions`:

```json
{
  "idempotency_key": "codex:<stable-thread-or-task>:<goal-revision>",
  "title": "15 秒商品投流素材",
  "user_goal": "为每个商品制作可测试的 9:16 视频",
  "mode": "collaborate",
  "source_context": {"source_paths": ["D:/商品A"]},
  "budget": {"currency": "CNY", "maximum": 30, "approved": false},
  "actor": "codex"
}
```

Submit a dynamic plan with `PUT /api/v1/orchestration-sessions/:id/plan`. Pass `expected_revision` from the latest readback to reject stale writers:

```json
{
  "expected_revision": 0,
  "confirm": false,
  "actor": "codex",
  "plan": {"summary": "先识别事实和素材，再研究结构、生成缺失镜头并剪辑"},
  "nodes": [
    {
      "node_key": "assets.scan.v1",
      "module_id": "asset.scan",
      "phase": "intake",
      "depends_on": [],
      "executor": "codex",
      "input_refs": [{"type": "local_path", "id": "D:/商品A", "role": "user_authorized_source"}],
      "decision": {"why": "先建立素材真值", "acceptance": ["每个文件有 hash 和用途候选"]}
    }
  ]
}
```

Confirm with `POST .../:id/confirm`, then start with `POST .../:id/start`. Both accept `actor` and confirmation accepts `expected_revision`.

Update a node with `PATCH .../:id/nodes/:nodeIdOrKey`. Include `expected_version` from the latest node readback when multiple writers are possible. Supported states are `pending`, `ready`, `running`, `waiting_confirmation`, `succeeded`, `partial`, `failed`, `skipped`, and `cancelled`.

For terminal failures include a receipt:

```json
{
  "status": "failed",
  "actor": "codex",
  "error": {"code": "UPSTREAM_TIMEOUT", "message": "上游超时", "retryable": true},
  "receipt": {
    "status": "failed",
    "source": "provider",
    "original_code": "UPSTREAM_TIMEOUT",
    "message": "上游超时",
    "retryable": true,
    "fallback_available": true,
    "next_actions": ["查询原任务", "直接重新生成一次并保留原记录"]
  }
}
```

Retry with `POST .../:id/nodes/:nodeIdOrKey/retry`; a note is optional and has no minimum length. Pause/resume/checkpoint use `POST .../:id/pause`, `/resume`, and `/checkpoint`.

Record a structured Codex fact, decision, progress, research, classification, user message, plan note, or QA result with POST /api/v1/orchestration-sessions/:id/events. The request must include a session-scoped event_idempotency_key; repeating the same key returns the original event instead of creating a duplicate. Payloads are bounded and reject credential fields, API keys, bearer tokens, and binary content.

## Blender 编排作业

当 Codex 判断某个镜头需要可重复的 3D 构图、运镜或多角度参考时，先在动态计划中加入 `director.blender-render` 节点并取得用户对本地渲染时间的确认，再调用：

`POST /api/v1/orchestration-sessions/:id/nodes/:nodeKey/blender/render`

请求体包含稳定的 `request_key`、可选 `request_hash`、scene v2，以及 `max_preview_frames`、`width`、`height` 和 `frames`。服务只运行仓库固定的 `runtime/blender/render_scene.py`，输出位于受控 storage 根，返回 `job` 和受约束 render `plan`。相同 session/node/request hash 会复用同一个作业，不启动第二个 Blender。

作业状态可为 `queued`、`rendering`、`encoding`、`recoverable`、`succeeded`、`partial`、`failed`、`cancelled` 或 `blocked`。阶段和错误会同步写入节点、事件和成果库。读取 `GET .../blender/jobs/:jobId` 或完整 session bundle 观察真实状态。

服务重启后，未完成作业会变为 `recoverable`。只有在确认继续后调用 `POST /api/v1/orchestration-sessions/:id/blender/jobs/:jobId/resume`；它读取原 scene 快照和 manifest，只补缺失帧、工程导出或 FFmpeg 编码，不重复已完成阶段。取消使用 `POST .../blender/jobs/:jobId/cancel`，只停止本地 Blender 进程并保留已有文件，不代表取消任何已提交的上游付费任务。

成功或部分完成时，成果库会登记 `.blend`、GLB、首帧 PNG、参考 MP4 和 manifest。`.blend` 是可编辑权威工程，GLB 是浏览器代理，PNG/MP4 是参考成果；三者都不等同于电影级角色资产或最终上游视频。

## External request reservation

Before a provider request with material cost or duplicate-side-effect risk, atomically reserve the request on its orchestration node:

`POST /api/v1/orchestration-sessions/:id/nodes/:nodeIdOrKey/external-request`

```json
{
  "actor": "codex",
  "request_hash": "sha256-of-locked-request-and-idempotency-key",
  "message": "正在提交图片生成请求；估算费用仅供参考",
  "decision": {
    "paid": true,
    "idempotency_key": "stable-logical-action-key",
    "provider": "saved-provider-name",
    "model": "locked-model-name",
    "config_id": 2,
    "price_snapshot": {"unit_price_usd": 0.07, "source_version": "catalog-version"}
  }
}
```

`reserved:true` grants one submission attempt. The same hash later returns `reserved:false` and `reconciliation_required:true`; query the existing generation/task instead of submitting again. A different hash conflicts and must not overwrite an in-flight, uncertain, accepted, or settled request.

## Image generation

Use MCP `generate_image_once` with `session_id`, `node_key`, stable `idempotency_key`, `image_config_id`, provider, model, final prompt and optional reference files. `group_name`, `confirmed_paid_action` and reference-cost fields are optional. The host owns user intent; the tool does not require an additional confirmation, live-price proof or unattended preference.

Prices are best-effort estimates. A matching config group informs the estimate; otherwise comparable catalog groups supply a conservative estimate. Missing/ratio prices, discovery errors and mixed currencies stay unknown rather than zero. An above-reference estimate is returned as a diagnostic and the request continues. Incompatible public metadata cannot veto the selected connection or model; actual execution errors remain visible. Never invent a quote just to proceed.

After submission, use MCP `reconcile_image` with the same session and node. It reads `/api/v1/images/:id` and `/api/v1/tasks/:taskId`, then records one of:

- `pending`: the same task still runs;
- `succeeded`: an actual readable output is attached and the node completes;
- `failed`: the provider/local error is retained and billing remains unknown unless separately evidenced;
- `unresolved`: no generation/task identifier proves acceptance, so the node stays uncertain and no new request is sent.

Transport timeout is not proof of failure. Reconcile the same attempt, or honor an explicit retry by archiving it with `node_action retry` and submitting a fresh request identity.

## Video generation

Use MCP `generate_video_once` with a session/node, stable idempotency key, saved configuration/provider/model, prompt, duration and references. No additional paid-action flag, cost ceiling or unattended preference is required. Capability metadata (including legacy `strict` requests) is advisory; selected parameters reach the provider for a real result.

Before submitting reference media, follow [reference media protocol](reference-media-protocol.md): local paths are imported automatically; manual multipart uses the actual MIME; known route roles and reference markers are adapted before the first provider request. A generic-reference route can guide opening/ending composition but does not promise exact keyframe locking.

Exact model matches or evidenced aliases can supply price estimates. Missing prices, unavailable catalogs, ratio billing, group-hint mismatches and above-reference estimates do not prevent execution. Unknown is `null`, not zero. `cost_quote_cny` can contain a user-reported config/model-bound quote; unusable quotes are ignored with a diagnostic. No currency is silently converted and quote metadata is never inserted into the provider prompt.

Explicit local paths and file URIs are imported by the main generation path; media-storage URLs still map to their actual media. Reuse a preceding clip or an extracted frame for continuation without another directory/price confirmation.

A single `reserved:true` permits exactly one local `POST /api/v1/videos`. The response records the local generation ID, local asynchronous task ID, provider task ID when available, request hash, configuration ID, capability snapshot, price source/version, and estimated CNY exposure. A local generation record is not proof that the provider accepted it. Transport or response ambiguity remains `uncertain`. Reconcile the original attempt, or perform an explicit retry with `node_action retry` and a fresh idempotency key; no second confirmation is required.

`reconcile_video` reads the same generation/task or recovers the generation by the persisted request hash. It reports:

- `unresolved`: no existing generation/task can yet be proved; keep the reservation and do not resend;
- `pending`: the original task remains submitted, accepted, generating, or downloading;
- `provider_completed_downloading`: upstream generation completed but no readable local media exists yet;
- `succeeded`: generation completed, local download completed, and non-zero local video bytes were read;
- `failed`: generation failed; billing stays unknown unless an actual provider receipt proves it;
- `download_failed`: upstream generation completed but the local download failed.

Pass `retry_download:true` only for `download_failed`. It calls the existing local download-recovery route and never creates another video. A catalog estimate is not a charge, refund, or balance receipt.

## Local Processing

Use `GET /api/v1/orchestration-modules` (or `modules --query <term>`) to select an implemented operation. `GET /api/v1/media-components/profile` reports component preparation state. Submit the local job directly once its input and parameters are clear; the executor automatically prepares missing components and continues. A separate install request is unnecessary.

`POST /api/v1/local-media/jobs`:

```json
{
  "session_id": "<existing-session-id>",
  "node_key": "<matching-plan-node>",
  "request_key": "<stable-key-for-this-input-and-operation>",
  "module_id": "local.image.realesrgan",
  "input_path": "<absolute-local-image-path>",
  "parameters": {"scale": 2, "model": "general"}
}
```

Read `GET /api/v1/local-media/jobs/:jobId` for real installation, execution and result progress. `GET /api/v1/local-media/jobs?session_id=:sessionId` lists the task's jobs. Results contain a downloadable `url`, output path, source/output hashes and operation-specific checks. CLI equivalents: `local-run --input request.json`, `local-job <job-id>`, `local-resume <job-id>`. `POST /api/v1/local-media/jobs/:jobId/resume` recovers a failed local job. Reuse the same request key to recover its receipt; a changed input or parameters require a new key. A completed result with `quality_status: review_required` is ready for inspection, not a failed installation.

## CLI Commands

Run from the skill directory (Codex should resolve the bundled script relative to `SKILL.md`):

```powershell
node scripts/orchestration-cli.mjs health
node scripts/orchestration-cli.mjs sessions
node scripts/orchestration-cli.mjs get <session-id>
node scripts/orchestration-cli.mjs create --input .\request.json
node scripts/orchestration-cli.mjs plan <session-id> --input .\plan.json
node scripts/orchestration-cli.mjs node <session-id> <node-key> --input .\node-update.json
node scripts/orchestration-cli.mjs retry <session-id> <node-key> --input .\retry.json
```

Set `YINZI_WORKFLOW_URL` when the local service uses another URL or when you want to pin a specific instance. You may override discovery candidates with `YINZI_WORKFLOW_CANDIDATE_URLS` or `YINZI_WORKFLOW_CANDIDATE_PORTS`. The CLI rejects likely credential fields or raw `sk-...` values in write payloads.

On `409 VERSION_CONFLICT` or `PLAN_REVISION_CONFLICT`, do not force the write. Read the latest bundle, reconcile the user's current intent, and submit a new revision.
# Recoverable Task Lists

`POST /api/v1/orchestration-sessions/{id}/archive` accepts `{"archived":true,"actor":"user"}` to archive and `false` to restore. The default session list excludes archived tasks; `GET /api/v1/orchestration-sessions?archived=true` lists them and `archived=all` includes both groups. Repeating the same desired state returns `reused:true`. Original detail URLs, artifacts, job IDs, execution state and provider reconciliation remain available. Archiving is list management, separate from pause/cancel/resume or agent execution.
