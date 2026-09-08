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
    "next_actions": ["查询原任务", "确认未提交后重试"]
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
  "message": "正在提交一次受预算保护的图片生成请求",
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

## Guarded image generation

Use MCP `generate_image_once` for a newly authorized image request. It requires:

- `session_id` and a dedicated `node_key`;
- stable `idempotency_key` and existing authorization via `confirmed_paid_action:true` or saved unattended mode;
- locked `image_config_id`, `provider`, `model`, and `group_name`;
- the final prompt and optional reference images;
- `max_unit_price_usd` from the user's approved exposure.

The tool first proves that the public local configuration matches the locked service type, provider, and model, is active, and has a saved credential. It then reads the local live price table before reservation. When the configuration contains a verifiable group binding, that exact group price is used. When it does not, the tool uses the highest current catalog price for the provider/model and labels the estimate `unverified_config_group_worst_case`; the caller cannot pick a cheap group name to understate exposure. Missing or ambiguous price, a higher current price, missing confirmation, configuration mismatch, or a request-hash conflict stops before `/api/v1/images`. A successful create response records both the local image-generation ID and asynchronous task ID. The returned cost is a live-catalog estimate until an actual provider billing receipt proves settlement.

After submission, use MCP `reconcile_image` with the same session and node. It reads `/api/v1/images/:id` and `/api/v1/tasks/:taskId`, then records one of:

- `pending`: the same task still runs;
- `succeeded`: an actual readable output is attached and the node completes;
- `failed`: the provider/local error is retained and billing remains unknown unless separately evidenced;
- `unresolved`: no generation/task identifier proves acceptance, so the node stays uncertain and no new request is sent.

Transport timeout after reservation is never proof of failure and never authorizes a resend.

## Guarded video generation

Use MCP `generate_video_once` with a dedicated session/node, stable idempotency key, saved `video_config_id`/provider/model, final prompt, duration and references. Existing authorization is represented by `confirmed_paid_action:true` or saved unattended mode. Set `max_cost_cny` to any user-specified ceiling; in unattended mode it can be omitted when no ceiling was specified.

The selected model remains authoritative. There is no mandatory Key discovery step before video submission. Missing capability metadata is recorded as unknown; supplied parameters are advisory by default. Optional `contract_validation_mode:strict` validates known duration, resolution and reference limits. Actual generation errors retain their real outcome and recovery path.

Public pricing supplies an estimate, without asserting Key permissions. Exact model matches or evidenced aliases can supply prices. If a user specified a ceiling, the tool checks the available price and uses the highest matching group exposure when no group is configured. Unknown price is reported as unknown, never zero; a specified ceiling must remain verifiable. In unattended mode without a specified ceiling, an absent price or capability entry does not block the selected video request.

A single `reserved:true` permits exactly one local `POST /api/v1/videos`. The response records the local generation ID, local asynchronous task ID, provider task ID when available, request hash, configuration ID, capability snapshot, price source/version, and estimated CNY exposure. A local generation record is not proof that the provider accepted it. Transport or response ambiguity remains `uncertain`; call `reconcile_video`, never `generate_video_once` as a resend mechanism.

`reconcile_video` reads the same generation/task or recovers the generation by the persisted request hash. It reports:

- `unresolved`: no existing generation/task can yet be proved; keep the reservation and do not resend;
- `pending`: the original task remains submitted, accepted, generating, or downloading;
- `provider_completed_downloading`: upstream generation completed but no readable local media exists yet;
- `succeeded`: generation completed, local download completed, and non-zero local video bytes were read;
- `failed`: generation failed; billing stays unknown unless an actual provider receipt proves it;
- `download_failed`: upstream generation completed but the local download failed.

Pass `retry_download:true` only for `download_failed`. It calls the existing local download-recovery route and never creates another video. A catalog estimate is not a charge, refund, or balance receipt.

## CLI

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
