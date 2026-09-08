const fs = require('node:fs');
const path = require('node:path');
const presentation = require('./orchestrationModulePresentation.json');
const clone = (value) => JSON.parse(JSON.stringify(value));

function moduleContract(moduleId, versionTrack, phase, executor, status, description, inputs, outputs, sideEffects = {}) {
  return Object.freeze({
    module_id: moduleId,
    ...(presentation[moduleId] || {}),
    version: 1,
    version_track: versionTrack,
    phase,
    executor,
    availability: status,
    description,
    inputs,
    outputs,
    side_effects: {
      network: false,
      filesystem_write: false,
      database_write: true,
      external_write: false,
      paid: false,
      ...sideEffects,
    },
    idempotency: 'session_id + node_key; retries increment attempt without creating another logical node',
    unknown_input_policy: 'preserve_and_explain',
    recovery: 'read the persisted session, node, immutable events and latest receipt before continuing',
  });
}

const LOCAL_MEDIA_MODULES = require('./localMediaOperations').contracts();

const MODULES = Object.freeze([
  // V1 - orchestration foundation
  moduleContract('session.create', 'V1', 'intake', 'local', 'integrated', 'Create a durable Codex orchestration session.', ['user_goal', 'source_context'], ['session']),
  moduleContract('asset.scan', 'V1', 'intake', 'codex', 'bridge', 'Inspect user-authorized files or folders and persist a bounded inventory.', ['paths'], ['asset_inventory'], { filesystem_write: true }),
  moduleContract('asset.classify', 'V1', 'intake', 'codex', 'bridge', 'Classify assets by fact, authority and intended use without silently sending them to a model.', ['asset_inventory', 'user_goal'], ['asset_roles']),
  moduleContract('asset.bind', 'V1', 'plan', 'codex', 'bridge', 'Bind assets to product, character, scene, shot or timeline scopes.', ['asset_roles'], ['asset_bindings']),
  moduleContract('plan.propose', 'V1', 'plan', 'codex', 'integrated', 'Persist a revisable dynamic plan and its dependency graph.', ['goal', 'facts', 'module_candidates'], ['plan_revision']),
  moduleContract('plan.confirm', 'V1', 'plan', 'manual', 'integrated', 'Confirm the current plan without hiding earlier revisions.', ['plan_revision'], ['confirmed_plan']),
  moduleContract('node.run', 'V1', 'create', 'codex', 'integrated', 'Record that a selected executor has started a module node.', ['node'], ['progress']),
  moduleContract('node.retry', 'V1', 'create', 'manual', 'integrated', 'Retry one logical node with the same node key and a new attempt.', ['failed_node'], ['ready_node']),
  moduleContract('manual.override', 'V1', 'plan', 'manual', 'integrated', 'Let a user edit, skip, reopen or replace a planned node with an auditable event.', ['node', 'patch'], ['updated_node']),
  moduleContract('session.pause', 'V1', 'deliver', 'manual', 'integrated', 'Pause orchestration without deleting outputs or cancelling unrelated provider work.', ['session'], ['paused_session']),
  moduleContract('session.resume', 'V1', 'deliver', 'manual', 'integrated', 'Resume from durable state after reading the latest checkpoint.', ['session'], ['running_session']),
  moduleContract('session.checkpoint', 'V1', 'deliver', 'codex', 'integrated', 'Save a compact recovery checkpoint and event cursor.', ['session_state'], ['checkpoint']),
  moduleContract('session.readback', 'V1', 'deliver', 'codex', 'integrated', 'Read the authoritative session, nodes, receipts and events.', ['session_id'], ['session_bundle']),

  // V2 - research and creative reasoning; Codex performs research with its
  // available tools and records evidence here. The backend never scrapes by itself.
  moduleContract('research.request', 'V2', 'research', 'codex', 'bridge', 'Define a bounded research question, sources and stop condition.', ['research_goal'], ['research_brief'], { network: true }),
  moduleContract('research.record-source', 'V2', 'research', 'codex', 'integrated', 'Persist source URL, date, metrics and a non-copying summary.', ['source_evidence'], ['source_record']),
  moduleContract('research.extract-patterns', 'V2', 'research', 'codex', 'bridge', 'Extract reusable structural patterns without treating third-party media as licensed assets.', ['source_records'], ['patterns']),
  moduleContract('product.extract-facts', 'V2', 'research', 'codex', 'bridge', 'Separate product facts, claims, uncertainty and conflicts.', ['product_assets'], ['fact_sheet']),
  moduleContract('creative.generate-directions', 'V2', 'plan', 'codex', 'bridge', 'Generate several traceable creative directions from facts and research.', ['fact_sheet', 'patterns'], ['creative_directions']),
  moduleContract('shot.plan-grid', 'V2', 'plan', 'codex', 'bridge', 'Plan shots or a nine-grid movement board while preserving subject authority.', ['creative_direction', 'asset_bindings'], ['shot_plan']),
  moduleContract('copy.generate', 'V2', 'create', 'codex', 'bridge', 'Create script, voiceover, subtitles or CTA grounded in confirmed facts.', ['fact_sheet', 'creative_direction'], ['copy_assets']),
  moduleContract('qa.claim-trace', 'V2', 'qa', 'codex', 'bridge', 'Check that product claims, figures and citations trace back to evidence.', ['fact_sheet', 'deliverable'], ['qa_receipt']),

  // V3 - local-first identity and commerce helpers. These contracts expose
  // capability choices before an executor is installed; unknown availability
  // remains visible and can be fulfilled by a lazy local component later.
  moduleContract('video.character-replace-local', 'V3', 'edit', 'local', 'advisory', 'Replace a visible character while preserving the source video motion, camera and background where the material supports it; a verified local component is required before execution.', ['source_video', 'character_reference', 'target_subject'], ['video_asset', 'quality_receipt'], { filesystem_write: true }),
  moduleContract('video.identity-repair-local', 'V3', 'edit', 'local', 'advisory', 'Repair face and identity drift in a generated video without regenerating the whole scene; a verified local component is required before execution.', ['video_asset', 'character_reference'], ['video_asset', 'quality_receipt'], { filesystem_write: true }),
  moduleContract('video.to-animation-local', 'V3', 'edit', 'local', 'advisory', 'Stylize a live-action subject into an animated or illustrated character while retaining motion and timing; a verified local component is required before execution.', ['source_video', 'style_reference', 'character_reference'], ['video_asset', 'quality_receipt'], { filesystem_write: true }),
  moduleContract('video.beauty-local', 'V3', 'edit', 'local', 'advisory', 'Apply bounded face and skin retouching with reversible parameters and temporal consistency; a verified local component is required before execution.', ['video_asset', 'beauty_settings'], ['video_asset', 'quality_receipt'], { filesystem_write: true }),
  moduleContract('image.batch-generate-fast', 'V3', 'create', 'provider', 'bridge', 'Submit a bounded batch of independent image jobs with concurrency, retry and per-item receipts.', ['prompts', 'reference_assets', 'concurrency'], ['image_assets', 'batch_receipt'], { network: true, external_write: true, paid: true }),

  // V3 - maps onto existing workflow/media capabilities. Codex chooses and
  // calls the concrete existing API, then records the returned artifact.
  moduleContract('video.import', 'V3', 'create', 'local', 'bridge', 'Import a user-owned video as a direct timeline clip.', ['video_asset', 'timeline_target'], ['direct_clip'], { filesystem_write: true }),
  moduleContract('video.trim', 'V3', 'edit', 'local', 'bridge', 'Trim a clip without regenerating it.', ['video_asset', 'time_range'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.concat', 'V3', 'edit', 'local', 'bridge', 'Concatenate compatible timeline clips.', ['video_assets'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.speed', 'V3', 'edit', 'local', 'bridge', 'Change clip speed with explicit audio policy.', ['video_asset', 'speed'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.color', 'V3', 'edit', 'local', 'bridge', 'Apply reversible color parameters or a saved preset.', ['video_asset', 'color_settings'], ['video_asset'], { filesystem_write: true }),
  moduleContract('video.audio', 'V3', 'edit', 'local', 'bridge', 'Mix, preserve, replace or duck audio tracks.', ['video_asset', 'audio_assets'], ['video_asset'], { filesystem_write: true }),
  moduleContract('subtitle.create', 'V3', 'edit', 'codex', 'bridge', 'Create timed subtitles and retain source text provenance.', ['copy_asset', 'timeline'], ['subtitle_asset'], { filesystem_write: true }),
  moduleContract('image.generate', 'V3', 'create', 'provider', 'bridge', 'Use the configured image provider through the existing workflow.', ['prompt', 'reference_assets'], ['image_asset'], { network: true, external_write: true, paid: true }),
  moduleContract('video.generate', 'V3', 'create', 'provider', 'bridge', 'Use the configured video provider through the existing idempotent workflow.', ['prompt', 'reference_bundle'], ['video_asset'], { network: true, external_write: true, paid: true }),
  moduleContract('video.timeline-assemble', 'V3', 'edit', 'local', 'bridge', 'Assemble imported and generated clips into one auditable timeline.', ['timeline_clips'], ['timeline_asset'], { filesystem_write: true }),
  moduleContract('deliver.export', 'V3', 'deliver', 'local', 'bridge', 'Export final media and its provenance package.', ['approved_timeline'], ['delivery_bundle'], { filesystem_write: true }),
  // The professional Blender line starts with a zero-side-effect capability
  // and smoke-plan bridge. Actual rendering is deliberately a later module
  // after the local Blender installation and artifact contracts are verified.
  moduleContract('director.blender-smoke', 'V3', 'create', 'local', 'bridge', 'Probe the local Blender installation and prepare a deterministic offline smoke plan without starting a process or creating media.', ['scene_document', 'request_key'], ['blender_capability', 'smoke_plan'], { filesystem_write: false, database_write: false }),
  moduleContract('director.blender-render', 'V3', 'create', 'local', 'integrated', 'Render a normalized director scene locally with Blender, export an editable project, sampled frames and a browser GLB proxy, then encode an optional reference preview without provider charges.', ['scene_document', 'request_key'], ['blend_project', 'rendered_frames', 'glb_preview', 'reference_video', 'render_manifest'], { filesystem_write: true, database_write: false }),

  // V4 - proposal/sandbox capabilities. Application remains a deliberate
  // Codex action with diff, tests, confirmation and rollback outside this API.
  moduleContract('provider.diagnose', 'V4', 'qa', 'codex', 'advisory', 'Diagnose a provider protocol from redacted evidence without paid probing.', ['provider_evidence'], ['diagnosis']),
  moduleContract('adapter.propose', 'V4', 'plan', 'codex', 'advisory', 'Propose a versioned provider adapter without applying it.', ['diagnosis'], ['patch_proposal']),
  moduleContract('adapter.test-sandbox', 'V4', 'qa', 'codex', 'advisory', 'Run fixtures and zero-side-effect protocol tests in an isolated checkout.', ['patch_proposal', 'fixtures'], ['test_receipt']),
  moduleContract('patch.propose', 'V4', 'plan', 'codex', 'advisory', 'Record a source patch proposal, scope and rollback anchor.', ['problem', 'evidence'], ['patch_proposal']),
  moduleContract('patch.test', 'V4', 'qa', 'codex', 'advisory', 'Record focused, full and adversarial test evidence for a patch.', ['patch_proposal'], ['test_receipt']),
  moduleContract('patch.apply', 'V4', 'deliver', 'manual', 'advisory', 'Apply an approved patch only after user confirmation and rollback preparation.', ['approved_patch', 'rollback_anchor'], ['applied_patch'], { filesystem_write: true, external_write: true }),
  moduleContract('module.register', 'V4', 'deliver', 'manual', 'advisory', 'Register an approved module contract without redefining unknown work as invalid.', ['module_contract'], ['module_registration'], { filesystem_write: true }),
  moduleContract('skill.export', 'V4', 'deliver', 'codex', 'integrated', 'Export the current orchestration contract and examples as a versioned Skill package.', ['module_contracts', 'usage_examples'], ['skill_bundle'], { filesystem_write: true }),
  moduleContract('session.replay', 'V4', 'qa', 'codex', 'integrated', 'Replay persisted decisions and receipts without re-executing paid side effects.', ['session_bundle'], ['replay_report']),
  ...LOCAL_MEDIA_MODULES,
]);

function registryDirectory() { return path.resolve(process.env.YINZI_WORKFLOW_MODULE_DIR || path.join(process.cwd(), 'data', 'orchestration-modules')); }
function readRegistered() {
  const directory = registryDirectory();
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((name) => name.endsWith('.json')).slice(0, 500).flatMap((name) => {
    try { const file = path.join(directory, name); if (fs.statSync(file).size > 65536) return []; const item = validateModule(JSON.parse(fs.readFileSync(file, 'utf8'))); return MODULES.some((builtin) => builtin.module_id === item.module_id) ? [] : [item]; }
    catch (_) { return []; }
  });
}
function validateModule(input = {}) {
  if (!/^[a-z][a-z0-9.-]{1,99}$/.test(input.module_id || '')) throw new Error('工具编号使用小写字母、数字、点和短横线');
  const serialized = JSON.stringify(input);
  if (serialized.length > 65536 || /sk-[A-Za-z0-9_-]{12,}|Bearer\s+[A-Za-z0-9._-]{12,}/i.test(serialized)) throw new Error('工具合同过大或包含敏感凭据');
  const strings = (value) => Array.isArray(value) ? value.slice(0, 60).map(String) : [];
  return { module_id: input.module_id, version: Math.max(1, Number(input.version) || 1), version_track: String(input.version_track || 'custom').slice(0, 20),
    phase: String(input.phase || 'create'), executor: String(input.executor || 'codex'), availability: String(input.availability || 'bridge'),
    title: String(input.title || input.module_id).slice(0, 160), description: String(input.description || '').slice(0, 4000),
    description_zh: String(input.description_zh || input.description || '').slice(0, 4000), example: String(input.example || '').slice(0, 1000),
    inputs: strings(input.inputs), outputs: strings(input.outputs), side_effects: Object.fromEntries(['network','filesystem_write','database_write','external_write','paid'].map((key) => [key, Boolean(input.side_effects?.[key])])),
    recovery: String(input.recovery || '读取原节点与已有成果后继续'), unknown_input_policy: 'preserve_and_explain', enabled: input.enabled !== false, registered: true };
}
function registerModule(input) {
  const item = validateModule(input);
  if (MODULES.some((builtin) => builtin.module_id === item.module_id)) throw new Error('内置工具保持原合同；扩展请使用新的工具编号');
  const directory = registryDirectory(); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, item.module_id + '.json');
  const temporary = file + '.' + require('node:crypto').randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(item, null, 2)); fs.renameSync(temporary, file);
  return clone(item);
}

function registeredModule(moduleId) {
  const id = String(moduleId || '').trim();
  if (!id || !/^[a-z][a-z0-9.-]{1,99}$/.test(id) || MODULES.some((builtin) => builtin.module_id === id)) return null;
  const directory = registryDirectory();
  const file = path.resolve(directory, id + '.json');
  if (path.dirname(file) !== path.resolve(directory)) return null;
  if (!fs.existsSync(file)) return null;
  try { return { file, item: validateModule(JSON.parse(fs.readFileSync(file, 'utf8'))) }; } catch (_) { return null; }
}

function updateModule(moduleId, patch = {}) {
  const current = registeredModule(moduleId);
  if (!current) throw new Error('只能修改已导入的自定义工具');
  const next = validateModule({ ...current.item, ...patch, module_id: current.item.module_id });
  const temporary = current.file + '.' + require('node:crypto').randomUUID() + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2)); fs.renameSync(temporary, current.file);
  return clone(next);
}

function deleteModule(moduleId) {
  const current = registeredModule(moduleId);
  if (!current) return false;
  fs.unlinkSync(current.file);
  return true;
}

function importModules(payload = {}) {
  const rawItems = Array.isArray(payload) ? payload : payload.items;
  if (!Array.isArray(rawItems) || rawItems.length > 100) throw new Error('工具包必须是最多 100 条合同的 JSON 数组');
  const result = { added: [], updated: [], skipped: [], errors: [] };
  const seen = new Set();
  for (const raw of rawItems) {
    try {
      const item = validateModule(raw);
      if (seen.has(item.module_id)) { result.skipped.push({ module_id: item.module_id, reason: '导入包内重复' }); continue; }
      seen.add(item.module_id);
      if (MODULES.some((builtin) => builtin.module_id === item.module_id)) { result.skipped.push({ module_id: item.module_id, reason: '内置工具' }); continue; }
      const current = registeredModule(item.module_id);
      if (current && JSON.stringify(current.item) === JSON.stringify(item)) { result.skipped.push({ module_id: item.module_id, reason: '内容未变化' }); continue; }
      registerModule(item);
      (current ? result.updated : result.added).push(item.module_id);
    } catch (error) {
      result.errors.push({ module_id: raw?.module_id || null, message: error.message });
    }
  }
  return result;
}

function exportModules(query = {}) {
  const list = listModules({ ...query, include_disabled: true }).items.filter((item) => item.registered);
  return { schema_version: 1, exported_at: new Date().toISOString(), items: list };
}

function listModules(query = {}) {
  const q = String(query.q || '').trim().toLowerCase();
  const track = String(query.version_track || '').trim().toUpperCase();
  const availability = String(query.availability || '').trim().toLowerCase();
  const items = [...MODULES, ...readRegistered()].filter((item) => {
    if (track && item.version_track !== track) return false;
    if (availability && item.availability !== availability) return false;
    if (q && !`${item.module_id} ${item.title} ${item.description_zh} ${item.description} ${item.phase}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const includeDisabled = String(query.include_disabled || '').toLowerCase() === 'true' || query.include_disabled === true;
  const visible = includeDisabled ? items : items.filter((item) => item.enabled !== false);
  return { schema_version: 1, open_world: true, items: clone(visible), total: visible.length, disabled_count: items.filter((item) => item.enabled === false).length };
}

function getModule(moduleId) {
  return clone([...MODULES, ...readRegistered()].find((item) => item.module_id === String(moduleId || '').trim()) || null);
}

module.exports = { MODULES, getModule, listModules, registerModule, importModules, exportModules, updateModule, deleteModule };
