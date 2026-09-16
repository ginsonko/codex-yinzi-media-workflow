# Reuse local production experience

The [published production experience index](production-experience-index.md) and its guides are bundled with the Skill. They provide reviewed methods on a fresh installation. The local experience database stores this user's execution history and later corrections; it is not automatically exported by a Git push or transferred to another user's installation.

Use this reference when a task resembles previous work, a component fails, or an actual trial produces a reusable method. Keep discovery cheap: query a short task phrase, module ID or original error code, inspect the returned summaries, and read only useful matches. Search returns bounded pages; it does not require a separate model call.

- `search_media_experiences({q, module_id?, session_id?, limit?, offset?})` lists titles, summaries and sources.
- `get_media_experience({experience_id})` reads parameters, component versions, input/output hashes, original errors, method notes and corrections.
- `record_media_experience({request_key, title, summary, module_id?, session_id?, job_id?, guidance, evidence_refs, quality_status})` records an attributed agent note. Use a stable request key for the same note; changed content needs a new key. To correct earlier guidance, set `supersedes_id` to the old record and explain the change. The original remains readable.

Local jobs automatically record each observed terminal attempt. Their `technical_status` tells whether execution completed; `quality_status=not_reviewed` means nobody has accepted the content. A decoded video or installed engine does not establish character identity, product fidelity, beat timing or artistic quality. Add a content verdict only after inspecting the actual output, with its evidence location and the limits of the review.

Direct AE scripts, ad hoc downloads, creative judgments and user feedback outside the registered local-job runner are not automatically covered by that hook. Save a concise note after a meaningful result or failure, and read it back. Before publishing a reusable lesson, distill it into the appropriate shipped guide with its applicability and outcome; preserve the full local evidence separately. Documentation being installed proves availability, while a new-task check is needed to demonstrate that an Agent actually found and applied it.

Notes never authorize another paid generation, installation or external action. A generic provider failure is an observed error, not evidence of prompt rejection, missing payment or no supplier artifact. Reconcile an uncertain request using its original ID. Keep upload, acceptance, generation, download and visual acceptance distinct in any incident note.

Record credential locations or saved configuration IDs when useful, never Key/Cookie/Authorization values or signed URL query strings. Record a portable recipe and its conditions rather than hardcoding one user's character or duration. Prefer actual component versions and input/output hashes over unverified claims. The tools page's **制作经验** shows the same records; user notes remain identified as user notes.

## Reuse a delivered method without another plan approval

On a similar new request, search the relevant category/module, read the useful record and its `superseded_by` corrections, and check later task/user feedback. Compare the requested result, input type, quality target, local/cloud preference, costs, privacy and current tool availability. Matching is a contextual Skill decision, not a hardcoded task-name allowlist.

A real successfully delivered result with no later objection can establish the default method under the user's current repeat request. Show the reused plan and proceed without a satisfaction survey or another plan approval. Mere absence of feedback on a failed, unknown or unfinished run does not qualify. If the user expresses dissatisfaction, asks for another route or materially changes constraints, explain the updated proposal and follow the current approval mode. A recipe never overrides an instruction to wait or independently authorizes paid or external actions.

After delivery, record a compact reusable recipe in the existing note's `guidance` object: `recipe` (steps/module IDs and method), `applies_when`, `constraints`, `fallbacks`, `delivery_refs` and `feedback_basis`. Distinguish explicit acceptance from `delivered_no_objection`; do not call the latter user praise or fabricate a `quality_status:passed`. Record actual technical/quality evidence separately. A later correction uses `supersedes_id` and preserves history. Do not store a success recipe while a task is still unfinished. Missing recipe metadata in older notes does not invalidate their genuine evidence; inspect that evidence before deciding whether reuse fits.

See [visible planning](visible-planning.md) for the table and existing plan confirmation commands.

CLI fallback (the same local service, no extra daemon):

```text
node scripts/orchestration-cli.mjs experiences --query "角色 关键帧" --limit 10
node scripts/orchestration-cli.mjs experiences --module local.video.compose-clips
node scripts/orchestration-cli.mjs experience EXPERIENCE_ID
node scripts/orchestration-cli.mjs record-experience --input note.json
```

An example `note.json` after a real inspection:

```json
{
  "request_key": "actual-session:clip-review:1",
  "title": "不同画幅素材合成时保留主体",
  "summary": "两段源视频按 contain 补边，目标时长与切点已核对。",
  "module_id": "local.video.compose-clips",
  "source": "agent_note",
  "actor": "codex",
  "technical_status": "succeeded",
  "quality_status": "partial",
  "guidance": {"method": "用 sources 登记全部素材，再用 clips 引用索引。", "limits": "主体未裁切；补边是否适合本片仍需结合用户画幅要求。"},
  "evidence_refs": ["实际验收报告位置"]
}
```

If an older backend lacks this endpoint, preserve the note as a local UTF-8 file and continue the authorized task; activate the ordinary update after current jobs finish. A note-saving failure must not repeat or invalidate a successful media operation.