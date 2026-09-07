const crypto = require('crypto');
const moduleCatalog = require('./orchestrationModuleCatalog');

const SESSION_STATUSES = new Set(['draft', 'waiting_confirmation', 'planned', 'running', 'paused', 'succeeded', 'partial', 'failed', 'cancelled']);
const NODE_STATUSES = new Set(['pending', 'ready', 'running', 'waiting_confirmation', 'succeeded', 'partial', 'failed', 'skipped', 'cancelled']);
const TERMINAL_NODE_STATUSES = new Set(['succeeded', 'partial', 'failed', 'skipped', 'cancelled']);
const SATISFIED_NODE_STATUSES = new Set(['succeeded', 'partial', 'skipped']);
const SECRET_FIELDS = new Set(['api_key', 'apikey', 'authorization', 'access_token', 'refresh_token', 'password', 'secret', 'client_secret', 'source_token', 'credential']);
const STRUCTURED_EVENT_TYPES = new Set(['fact', 'decision', 'progress', 'research', 'qa', 'user_message', 'asset_classification', 'plan_note']);

function nowIso() { return new Date().toISOString(); }
function json(value, fallback) {
  try { return JSON.stringify(value ?? fallback); }
  catch (_) { return JSON.stringify(fallback); }
}
function parse(value, fallback) {
  try { return value == null || value === '' ? fallback : JSON.parse(value); }
  catch (_) { return fallback; }
}
function makeError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}
function normalizeActor(value) {
  const actor = String(value || 'codex').trim().toLowerCase();
  return ['codex', 'user', 'system', 'provider', 'manual'].includes(actor) ? actor : 'codex';
}
function sanitizeString(value, redactions) {
  let text = String(value);
  text = text.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, () => { redactions.add('api_key'); return 'sk-***'; });
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, () => { redactions.add('authorization'); return 'Bearer ***'; });
  return text;
}
function sanitize(value, redactions = new Set(), depth = 0) {
  if (depth > 12) return '[truncated]';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return sanitizeString(value, redactions);
  if (Array.isArray(value)) return value.slice(0, 2000).map((item) => sanitize(item, redactions, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(value)) {
      const key = String(rawKey);
      if (SECRET_FIELDS.has(key.toLowerCase())) {
        out[key] = '[REDACTED]';
        redactions.add(key.toLowerCase());
      } else {
        out[key] = sanitize(rawValue, redactions, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}
function normalizedJson(value, fallback) { return json(sanitize(value), fallback); }

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

function nodeDefinitionSignature(definition) {
  return json(canonicalize(definition), {});
}

function existingNodeDefinition(row) {
  const decision = parse(row.decision_json, {});
  delete decision.module_contract_status;
  return {
    module_id: row.module_id,
    module_version: Number(row.module_version) || 1,
    phase: row.phase,
    depends_on: parse(row.depends_on_json, []),
    input_refs: parse(row.input_refs_json, []),
    executor: row.executor,
    decision,
  };
}

function assertValidPlanGraph(definitions) {
  const byKey = new Map(definitions.map((item) => [item.nodeKey, item]));
  for (const item of definitions) {
    for (const dependency of item.definition.depends_on) {
      if (!byKey.has(dependency)) {
        throw makeError('PLAN_DEPENDENCY_MISSING', `节点 ${item.nodeKey} 依赖了计划中不存在的节点：${dependency}`);
      }
      if (dependency === item.nodeKey) throw makeError('PLAN_DEPENDENCY_CYCLE', `节点 ${item.nodeKey} 不能依赖自己`);
    }
  }
  const visiting = new Set(); const visited = new Set();
  function visit(key, path = []) {
    if (visiting.has(key)) throw makeError('PLAN_DEPENDENCY_CYCLE', `计划依赖形成循环：${[...path, key].join(' -> ')}`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key).definition.depends_on) visit(dependency, [...path, key]);
    visiting.delete(key); visited.add(key);
  }
  for (const key of byKey.keys()) visit(key);
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS orchestration_sessions (
      id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, title TEXT NOT NULL DEFAULT '', user_goal TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'collaborate', status TEXT NOT NULL DEFAULT 'draft', source_context_json TEXT NOT NULL DEFAULT '{}',
      linked_drama_id INTEGER, linked_run_id TEXT, plan_revision INTEGER NOT NULL DEFAULT 0, plan_json TEXT NOT NULL DEFAULT '{}',
      budget_json TEXT NOT NULL DEFAULT '{}', usage_json TEXT NOT NULL DEFAULT '{}', checkpoint_json TEXT NOT NULL DEFAULT '{}',
      last_error_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT, deleted_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestration_sessions_idempotency ON orchestration_sessions(idempotency_key);
    CREATE INDEX IF NOT EXISTS idx_orchestration_sessions_status ON orchestration_sessions(status, updated_at DESC);
    CREATE TABLE IF NOT EXISTS orchestration_nodes (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, node_key TEXT NOT NULL, module_id TEXT NOT NULL, module_version INTEGER NOT NULL DEFAULT 1,
      plan_revision INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'create', status TEXT NOT NULL DEFAULT 'pending', active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0, depends_on_json TEXT NOT NULL DEFAULT '[]', input_refs_json TEXT NOT NULL DEFAULT '[]',
      output_refs_json TEXT NOT NULL DEFAULT '[]', executor TEXT NOT NULL DEFAULT 'codex', progress_json TEXT NOT NULL DEFAULT '{}', request_hash TEXT,
      config_revision TEXT, cost_ledger_id INTEGER, decision_json TEXT NOT NULL DEFAULT '{}', error_json TEXT NOT NULL DEFAULT '{}',
      attempt INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, UNIQUE(session_id, node_key)
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_nodes_session ON orchestration_nodes(session_id, active, sort_order, created_at);
    CREATE TABLE IF NOT EXISTS orchestration_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id TEXT, event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system', payload_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_events_session ON orchestration_events(session_id, id DESC);
    CREATE TABLE IF NOT EXISTS orchestration_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'local', original_code TEXT, normalized_category TEXT, message TEXT NOT NULL DEFAULT '',
      attempted_json TEXT NOT NULL DEFAULT '[]', retryable TEXT NOT NULL DEFAULT 'unknown', fallback_available INTEGER NOT NULL DEFAULT 0,
      next_actions_json TEXT NOT NULL DEFAULT '[]', correlation_id TEXT, redactions_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      UNIQUE(node_id, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_receipts_session ON orchestration_receipts(session_id, id DESC);
    CREATE TABLE IF NOT EXISTS orchestration_event_idempotency (
      session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, event_id INTEGER NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_event_idempotency_event ON orchestration_event_idempotency(event_id);
    CREATE TABLE IF NOT EXISTS orchestration_artifacts (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, node_id TEXT, artifact_id TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'unknown', mime_type TEXT, title TEXT NOT NULL DEFAULT '',
      url TEXT, thumbnail_url TEXT, path TEXT, bytes INTEGER, width INTEGER, height INTEGER,
      duration_seconds REAL, frame_rate REAL, shot_id TEXT, version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ready', source_refs_json TEXT NOT NULL DEFAULT '[]',
      validation_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      UNIQUE(session_id, artifact_id)
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_artifacts_session ON orchestration_artifacts(session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS orchestration_feedback (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      message TEXT NOT NULL, scope_json TEXT NOT NULL DEFAULT '{}', actor TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL, UNIQUE(session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_feedback_session ON orchestration_feedback(session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS orchestration_deliveries (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      artifact_ids_json TEXT NOT NULL DEFAULT '[]', format TEXT, status TEXT NOT NULL DEFAULT 'ready',
      created_at TEXT NOT NULL, UNIQUE(session_id, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_deliveries_session ON orchestration_deliveries(session_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS orchestration_blender_jobs (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, node_id TEXT, node_key TEXT NOT NULL,
      request_key TEXT NOT NULL, request_hash TEXT NOT NULL, plan_id TEXT NOT NULL, scene_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', phase TEXT NOT NULL DEFAULT 'queued',
      progress_json TEXT NOT NULL DEFAULT '{}', output_dir TEXT NOT NULL, plan_json TEXT NOT NULL DEFAULT '{}', manifest_json TEXT NOT NULL DEFAULT '{}',
      error_json TEXT NOT NULL DEFAULT '{}', pid INTEGER, owner_pid INTEGER, attempt INTEGER NOT NULL DEFAULT 1,
      cancel_requested INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      started_at TEXT, completed_at TEXT, UNIQUE(session_id, node_key, request_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_orchestration_blender_jobs_session ON orchestration_blender_jobs(session_id, updated_at DESC);
  `);
  // The table was introduced after the first orchestration release. Keep an
  // existing local SQLite database readable without forcing a destructive
  // migration or dropping any durable job state.
  try {
    const columns = db.prepare('PRAGMA table_info(orchestration_blender_jobs)').all().map((item) => item.name);
    if (!columns.includes('plan_json')) db.exec("ALTER TABLE orchestration_blender_jobs ADD COLUMN plan_json TEXT NOT NULL DEFAULT '{}'");
    if (!columns.includes('owner_pid')) db.exec("ALTER TABLE orchestration_blender_jobs ADD COLUMN owner_pid INTEGER");
  } catch (_) { /* older or read-only databases report their own error later */ }
}

function publicSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    idempotency_key: row.idempotency_key,
    title: row.title,
    user_goal: row.user_goal,
    mode: row.mode,
    status: row.status,
    source_context: parse(row.source_context_json, {}),
    linked_drama_id: row.linked_drama_id,
    linked_run_id: row.linked_run_id,
    plan_revision: row.plan_revision,
    plan: parse(row.plan_json, {}),
    budget: parse(row.budget_json, {}),
    usage: parse(row.usage_json, {}),
    checkpoint: parse(row.checkpoint_json, {}),
    last_error: parse(row.last_error_json, {}),
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function publicNode(row) {
  if (!row) return null;
  const contract = moduleCatalog.getModule(row.module_id);
  return {
    id: row.id,
    session_id: row.session_id,
    node_key: row.node_key,
    module_id: row.module_id,
    module_version: row.module_version,
    module_contract_status: contract ? contract.availability : 'unknown',
    plan_revision: row.plan_revision,
    phase: row.phase,
    status: row.status,
    active: Boolean(row.active),
    sort_order: row.sort_order,
    depends_on: parse(row.depends_on_json, []),
    input_refs: parse(row.input_refs_json, []),
    output_refs: parse(row.output_refs_json, []),
    executor: row.executor,
    progress: parse(row.progress_json, {}),
    request_hash: row.request_hash,
    config_revision: row.config_revision,
    cost_ledger_id: row.cost_ledger_id,
    decision: parse(row.decision_json, {}),
    error: parse(row.error_json, {}),
    attempt: row.attempt,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}

function publicEvent(row) {
  return { id: row.id, session_id: row.session_id, node_id: row.node_id, event_type: row.event_type, actor: row.actor, payload: parse(row.payload_json, {}), created_at: row.created_at };
}
function publicArtifact(row) {
  if (!row) return null;
  return {
    id: row.id, artifact_id: row.artifact_id, session_id: row.session_id, node_id: row.node_id,
    type: row.type, mime_type: row.mime_type, title: row.title, url: row.url, thumbnail_url: row.thumbnail_url,
    path: row.path, bytes: row.bytes == null ? null : Number(row.bytes), width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height), duration_seconds: row.duration_seconds == null ? null : Number(row.duration_seconds),
    frame_rate: row.frame_rate == null ? null : Number(row.frame_rate), shot_id: row.shot_id, version: Number(row.version) || 1,
    status: row.status, source_refs: parse(row.source_refs_json, []), validation: parse(row.validation_json, {}), created_at: row.created_at,
  };
}
function publicBlenderJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    session_id: row.session_id,
    node_id: row.node_id,
    node_key: row.node_key,
    request_key: row.request_key,
    request_hash: row.request_hash,
    plan_id: row.plan_id,
    scene_hash: row.scene_hash,
    plan: (() => { const plan = parse(row.plan_json, {}); return { profile: plan.profile, scene: plan.scene }; })(),
    status: row.status,
    phase: row.phase,
    progress: parse(row.progress_json, {}),
    output_dir: row.output_dir,
    manifest: parse(row.manifest_json, {}),
    error: parse(row.error_json, {}),
    attempt: Number(row.attempt) || 1,
    cancel_requested: Boolean(row.cancel_requested),
    created_at: row.created_at,
    updated_at: row.updated_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
  };
}
function publicFeedback(row) {
  if (!row) return null;
  return { id: row.id, session_id: row.session_id, idempotency_key: row.idempotency_key, message: row.message, scope: parse(row.scope_json, {}), actor: row.actor, status: row.status, created_at: row.created_at };
}
function publicDelivery(row, artifacts = []) {
  if (!row) return null;
  return { id: row.id, session_id: row.session_id, idempotency_key: row.idempotency_key, artifact_ids: parse(row.artifact_ids_json, []), format: row.format, status: row.status, items: artifacts, created_at: row.created_at };
}
function publicReceipt(row) {
  return {
    id: row.id, session_id: row.session_id, node_id: row.node_id, attempt: row.attempt, status: row.status,
    source: row.source, original_code: row.original_code, normalized_category: row.normalized_category, message: row.message,
    attempted: parse(row.attempted_json, []), retryable: row.retryable, fallback_available: Boolean(row.fallback_available),
    next_actions: parse(row.next_actions_json, []), correlation_id: row.correlation_id, redactions: parse(row.redactions_json, []), created_at: row.created_at,
  };
}

function appendEvent(db, sessionId, eventType, payload = {}, options = {}) {
  const redactions = new Set();
  const safe = sanitize(payload, redactions);
  if (redactions.size) safe.redactions = [...new Set([...(safe.redactions || []), ...redactions])];
  const info = db.prepare(`INSERT INTO orchestration_events (session_id,node_id,event_type,actor,payload_json,created_at) VALUES (?,?,?,?,?,?)`)
    .run(sessionId, options.node_id || null, eventType, normalizeActor(options.actor), json(safe, {}), nowIso());
  return publicEvent(db.prepare('SELECT * FROM orchestration_events WHERE id=?').get(info.lastInsertRowid));
}

function getSessionRow(db, id) {
  return db.prepare('SELECT * FROM orchestration_sessions WHERE id=? AND deleted_at IS NULL').get(id);
}
function getNodeRow(db, sessionId, nodeIdOrKey) {
  return db.prepare('SELECT * FROM orchestration_nodes WHERE session_id=? AND (id=? OR node_key=?)').get(sessionId, nodeIdOrKey, nodeIdOrKey);
}

function computeSessionStatus(db, sessionId) {
  const nodes = db.prepare('SELECT status FROM orchestration_nodes WHERE session_id=? AND active=1').all(sessionId);
  if (!nodes.length) return null;
  const statuses = nodes.map((item) => item.status);
  if (statuses.every((status) => ['succeeded', 'skipped'].includes(status))) return 'succeeded';
  if (statuses.every((status) => TERMINAL_NODE_STATUSES.has(status))) {
    const hasFailure = statuses.some((status) => ['failed', 'cancelled'].includes(status));
    const hasUsableResult = statuses.some((status) => ['succeeded', 'partial', 'skipped'].includes(status));
    if (hasFailure && !hasUsableResult) return 'failed';
    return hasFailure || statuses.includes('partial') ? 'partial' : 'succeeded';
  }
  return null;
}

function refreshReadyNodes(db, sessionId) {
  const rows = db.prepare('SELECT * FROM orchestration_nodes WHERE session_id=? AND active=1 ORDER BY sort_order,id').all(sessionId);
  const byKey = new Map(rows.map((row) => [row.node_key, row]));
  const update = db.prepare(`UPDATE orchestration_nodes SET status='ready',updated_at=?,version=version+1 WHERE id=? AND status='pending'`);
  let changed = 0;
  for (const row of rows) {
    if (row.status !== 'pending') continue;
    const deps = parse(row.depends_on_json, []);
    const satisfied = deps.every((key) => byKey.has(key) && SATISFIED_NODE_STATUSES.has(byKey.get(key).status));
    if (satisfied) { update.run(nowIso(), row.id); changed += 1; }
  }
  return changed;
}

function createReceipt(db, node, rawReceipt = {}, fallbackStatus) {
  const redactions = new Set();
  const receipt = sanitize(rawReceipt || {}, redactions);
  const status = String(receipt.status || fallbackStatus || node.status || 'failed');
  const retryable = ['true', 'false', 'unknown'].includes(String(receipt.retryable)) ? String(receipt.retryable) : 'unknown';
  const message = sanitizeString(receipt.message || node.error?.message || '', redactions);
  db.prepare(`
    INSERT OR IGNORE INTO orchestration_receipts
      (session_id,node_id,attempt,status,source,original_code,normalized_category,message,attempted_json,retryable,fallback_available,next_actions_json,correlation_id,redactions_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    node.session_id, node.id, node.attempt, status, String(receipt.source || 'local'),
    receipt.original_code == null ? null : String(receipt.original_code), receipt.normalized_category == null ? null : String(receipt.normalized_category),
    message, json(receipt.attempted || [], []), retryable, receipt.fallback_available ? 1 : 0,
    json(receipt.next_actions || [], []), receipt.correlation_id == null ? null : String(receipt.correlation_id),
    json([...new Set([...(receipt.redactions || []), ...redactions])], []), nowIso(),
  );
  return publicReceipt(db.prepare('SELECT * FROM orchestration_receipts WHERE node_id=? AND attempt=?').get(node.id, node.attempt));
}

const creativePreferences = require('./creativePreferences');

function createOrchestrationService(db) {
  ensureSchema(db);

  function getSession(id) { return publicSession(getSessionRow(db, id)); }
  function listSessions(query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
    const status = String(query.status || '').trim();
    const linkedRunId = String(query.linked_run_id || '').trim();
    const clauses = ['deleted_at IS NULL']; const args = [];
    if (status) { clauses.push('status=?'); args.push(status); }
    if (linkedRunId) { clauses.push('linked_run_id=?'); args.push(linkedRunId); }
    args.push(limit);
    const rows = db.prepare(`SELECT *, (SELECT MAX(id) FROM orchestration_events WHERE session_id=orchestration_sessions.id) AS last_event_id FROM orchestration_sessions WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...args);
    return { items: rows.map(row => ({ ...publicSession(row), last_event_id: row.last_event_id || 0 })), total: rows.length };
  }
  function listNodes(sessionId, query = {}) {
    const activeOnly = String(query.active || 'true') !== 'false';
    const rows = db.prepare(`SELECT * FROM orchestration_nodes WHERE session_id=? ${activeOnly ? 'AND active=1' : ''} ORDER BY sort_order,id`).all(sessionId);
    return rows.map(publicNode);
  }
  function listEvents(sessionId, query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const after = Math.max(Number(query.after) || 0, 0);
    return db.prepare('SELECT * FROM orchestration_events WHERE session_id=? AND id>? ORDER BY id ASC LIMIT ?').all(sessionId, after, limit).map(publicEvent);
  }
  function listReceipts(sessionId) {
    return db.prepare('SELECT * FROM orchestration_receipts WHERE session_id=? ORDER BY id ASC').all(sessionId).map(publicReceipt);
  }
  function listArtifacts(sessionId, query = {}) {
    const rows = db.prepare('SELECT * FROM orchestration_artifacts WHERE session_id=? ORDER BY created_at ASC,id ASC').all(sessionId);
    return rows.map(publicArtifact);
  }
  function searchArtifacts(query = {}) {
    const page = Math.max(1, Math.floor(Number(query.page) || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(query.page_size) || 30)));
    const where = []; const values = [];
    if (query.type && query.type !== 'all') { where.push('a.type=?'); values.push(String(query.type)); }
    if (query.q) { where.push('(a.title LIKE ? OR s.title LIKE ?)'); values.push('%' + String(query.q).slice(0, 200) + '%', '%' + String(query.q).slice(0, 200) + '%'); }
    const from = ' FROM orchestration_artifacts a JOIN orchestration_sessions s ON s.id=a.session_id' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
    const total = db.prepare('SELECT count(*) AS total' + from).get(...values).total;
    const rows = db.prepare('SELECT a.*,s.title AS session_title' + from + ' ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?').all(...values, pageSize, (page - 1) * pageSize);
    return { items: rows.map(row => ({ ...publicArtifact(row), session_title: row.session_title })), pagination: { total, page, page_size: pageSize } };
  }
  function listFeedback(sessionId) {
    return db.prepare('SELECT * FROM orchestration_feedback WHERE session_id=? ORDER BY created_at ASC,id ASC').all(sessionId).map(publicFeedback);
  }
  function listBlenderJobs(sessionId) {
    try {
      return db.prepare('SELECT * FROM orchestration_blender_jobs WHERE session_id=? ORDER BY created_at ASC,id ASC').all(sessionId).map(publicBlenderJob);
    } catch (_) {
      return [];
    }
  }
  function latestDelivery(sessionId) {
    const row = db.prepare('SELECT * FROM orchestration_deliveries WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(sessionId);
    if (!row) return null;
    const ids = parse(row.artifact_ids_json, []);
    const marks = new Set(ids);
    const artifacts = db.prepare('SELECT * FROM orchestration_artifacts WHERE session_id=? ORDER BY created_at ASC,id ASC').all(sessionId)
      .filter((item) => marks.has(item.artifact_id)).map(publicArtifact);
    return publicDelivery(row, artifacts);
  }
  function onboarding() {
    const configCounts = { text: 0, image: 0, video: 0 };
    try {
      const rows = db.prepare("SELECT service_type, COUNT(*) AS count FROM ai_service_configs WHERE deleted_at IS NULL AND is_active = 1 GROUP BY service_type").all();
      for (const row of rows) {
        const type = String(row.service_type || '').toLowerCase();
        if (Object.prototype.hasOwnProperty.call(configCounts, type)) configCounts[type] = Number(row.count) || 0;
      }
    } catch (_) { /* older databases may not have AI config tables yet */ }
    return {
      schema: 'yinzi.codex-video-onboarding/v1',
      version: '0.1.4',
      connected: true,
      creative_preferences: creativePreferences.get(db),
      planning_guidance: creativePreferences.profile(creativePreferences.get(db).quality_profile),
      open_world: true,
      next_steps: [
        '在 Codex 中直接说出目标，并授权文件或文件夹路径',
        '先做素材扫描、分类、计划设计和本地剪辑，不必一次配置所有模型',
        '只有真正执行图片、视频或文本服务时，才需要配置对应服务',
      ],
      capabilities: ['orchestration', 'asset-scan', 'production-bridge', 'local-editing', 'audit-export', 'manual-takeover'],
      active_config_counts: configCounts,
      budget_hint: '建议在 Codex 指令中说明本次最多可接受的费用；未填写不代表系统已经启用硬性预算上限。',
      low_gate_notice: '未知模型或能力不会阻断本地计划；执行依赖某项服务的节点时，系统会只提示该节点需要配置。',
    };
  }
  function assertEventPayload(value, at = '$', depth = 0, state = { bytes: 0 }) {
    if (depth > 8) throw makeError('EVENT_PAYLOAD_TOO_DEEP', '事件内容层级过深，最多支持 8 层');
    if (typeof value === 'string') {
      if (value.length > 8000) throw makeError('EVENT_PAYLOAD_TOO_LARGE', `事件文本过长：${at}`);
      if (/\bsk-[A-Za-z0-9_-]{12,}\b/.test(value) || /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/i.test(value)) throw makeError('EVENT_SECRET_REJECTED', `事件内容疑似包含密钥：${at}`);
      state.bytes += Buffer.byteLength(value, 'utf8');
      return;
    }
    if (value == null || typeof value === 'number' || typeof value === 'boolean') return;
    if (Array.isArray(value)) {
      if (value.length > 200) throw makeError('EVENT_PAYLOAD_TOO_LARGE', `事件数组过长：${at}`);
      value.forEach((item, index) => assertEventPayload(item, `${at}[${index}]`, depth + 1, state));
      return;
    }
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length > 200) throw makeError('EVENT_PAYLOAD_TOO_LARGE', `事件字段过多：${at}`);
      for (const [key, item] of Object.entries(value)) {
        if (SECRET_FIELDS.has(String(key).toLowerCase())) throw makeError('EVENT_SECRET_REJECTED', `事件包含密钥字段：${at}.${key}`);
        assertEventPayload(item, `${at}.${key}`, depth + 1, state);
      }
      return;
    }
    throw makeError('EVENT_PAYLOAD_INVALID', `事件内容类型不支持：${at}`);
  }
  function recordEvent(sessionId, input = {}) {
    const session = getSessionRow(db, sessionId);
    if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    const eventType = String(input.event_type || input.type || '').trim();
    if (!eventType || eventType.length > 80 || !/^[a-z][a-z0-9_.:-]*$/i.test(eventType)) throw makeError('EVENT_TYPE_INVALID', '事件类型不能为空，且只能包含字母、数字、点、下划线、冒号或短横线');
    const idempotencyKey = String(input.event_idempotency_key || input.idempotency_key || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw makeError('EVENT_IDEMPOTENCY_REQUIRED', '结构化事件必须提供不超过 200 个字符的幂等键');
    const payload = input.payload == null ? {} : input.payload;
    assertEventPayload(payload);
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded, 'utf8') > 64 * 1024) throw makeError('EVENT_PAYLOAD_TOO_LARGE', '事件内容超过 64KB');
    const tx = db.transaction(() => {
      const prior = db.prepare('SELECT event_id FROM orchestration_event_idempotency WHERE session_id=? AND idempotency_key=?').get(sessionId, idempotencyKey);
      if (prior) return { reused: true, event: publicEvent(db.prepare('SELECT * FROM orchestration_events WHERE id=?').get(prior.event_id)) };
      const event = appendEvent(db, sessionId, eventType, payload, { actor: input.actor || 'codex', node_id: input.node_id || null });
      db.prepare('INSERT INTO orchestration_event_idempotency (session_id,idempotency_key,event_id,created_at) VALUES (?,?,?,?)').run(sessionId, idempotencyKey, event.id, nowIso());
      return { reused: false, event };
    });
    return tx.immediate();
  }
  function getBundle(id, query = {}) {
    const session = getSession(id);
    if (!session) return null;
    const nodes = listNodes(id, { active: query.include_inactive === true || query.include_inactive === 'true' ? 'false' : 'true' });
    const events = listEvents(id, { limit: query.event_limit || 200, after: query.after || 0 });
    const receipts = listReceipts(id);
    const counts = nodes.reduce((acc, node) => { acc[node.status] = (acc[node.status] || 0) + 1; return acc; }, {});
    return { schema_version: 2, open_world: true, planning_guidance: creativePreferences.profile(session.source_context?.quality_profile || creativePreferences.get(db).quality_profile), session, nodes, events, receipts, counts, artifacts: listArtifacts(id, query), feedback: listFeedback(id), delivery: latestDelivery(id), blender_jobs: listBlenderJobs(id) };
  }

  function beginWork(input = {}) {
    if (!String(input.idempotency_key || '').trim() || !String(input.user_goal || '').trim()) throw makeError('WORK_INPUT_REQUIRED', '开始任务需要稳定请求键和用户目标');
    const intent = input.intent === 'analyze' ? 'analyze' : 'create';
    const stamp = nowIso();
    return createSession({ ...input, source_context: { ...(input.source_context || {}), intent,
      activity: { stage: 'analysis', state: 'working', message: '已接收需求，正在分析素材与目标', next_action: '整理方案与验收标准', needs_user: false, updated_at: stamp },
    } });
  }

  function reportActivity(id, input = {}) {
    return db.transaction(() => {
      const session = getSession(id);
      if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
      if (!input.event_idempotency_key || !String(input.message || '').trim()) throw makeError('ACTIVITY_INPUT_REQUIRED', '进度需要事件请求键和真实动作说明');
      const state = input.state || 'working';
      if (!['working','waiting','completed'].includes(state)) throw makeError('ACTIVITY_STATE_INVALID', '进度状态无效');
      const report = input.analysis_report == null ? session.source_context?.analysis_report : sanitize(input.analysis_report);
      if (state === 'completed' && session.source_context?.intent === 'analyze') {
        if (!report || !String(typeof report === 'string' ? report : report.summary || '').trim()) throw makeError('ANALYSIS_REPORT_REQUIRED', '分析完成时请保存分析结论');
        const unfinished = listNodes(id).filter(node => !TERMINAL_NODE_STATUSES.has(node.status));
        if (unfinished.length) throw makeError('COMPLETION_UNFINISHED_NODES', '请先收口分析节点的真实结果');
      }
      const event = recordEvent(id, { event_type: 'activity.reported', event_idempotency_key: input.event_idempotency_key, actor: input.actor || 'codex', payload: sanitize(input) });
      if (event.reused) return getBundle(id);
      const activity = sanitize({ stage: input.stage || 'analysis', state, message: input.message, next_action: input.next_action || '', needs_user: Boolean(input.needs_user), updated_at: nowIso() });
      const nextStatus = state === 'completed' && session.source_context?.intent === 'analyze' ? (listNodes(id).length ? computeSessionStatus(db, id) : 'succeeded') : session.status;
      return updateSession(id, { status: nextStatus, source_context: { ...session.source_context, activity, ...(report == null ? {} : { analysis_report: report }) } });
    })();
  }

  function createSession(input = {}) {
    const idem = input.idempotency_key ? String(input.idempotency_key).trim() : null;
    if (idem) {
      const reused = db.prepare('SELECT * FROM orchestration_sessions WHERE idempotency_key=? AND deleted_at IS NULL').get(idem);
      if (reused) return { reused: true, session: publicSession(reused) };
    }
    const mode = String(input.mode || 'collaborate');
    if (!['auto', 'collaborate', 'manual'].includes(mode)) throw makeError('ORCHESTRATION_MODE_INVALID', 'mode 必须是 auto、collaborate 或 manual');
    const id = String(input.id || crypto.randomUUID());
    const stamp = nowIso();
    db.prepare(`
      INSERT INTO orchestration_sessions
        (id,idempotency_key,title,user_goal,mode,status,source_context_json,linked_drama_id,linked_run_id,plan_revision,plan_json,budget_json,usage_json,checkpoint_json,last_error_json,version,created_at,updated_at)
      VALUES (?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?,1,?,?)
    `).run(
      id, idem, sanitizeString(input.title || 'Codex 视频任务', new Set()), sanitizeString(input.user_goal || '', new Set()), mode,
      normalizedJson({ ...(input.source_context || {}), quality_profile: creativePreferences.profile(input.quality_profile || input.source_context?.quality_profile || creativePreferences.get(db).quality_profile).id }, {}), input.linked_drama_id || null, input.linked_run_id || null, 0,
      '{}', normalizedJson(input.budget, {}), '{}', '{}', '{}', stamp, stamp,
    );
    appendEvent(db, id, 'session.created', { title: input.title || 'Codex 视频任务', mode, linked_run_id: input.linked_run_id || null }, { actor: input.actor || 'codex' });
    return { reused: false, session: getSession(id) };
  }

  function updateSession(id, input = {}) {
    const row = getSessionRow(db, id);
    if (!row) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    if (input.expected_version != null && Number(input.expected_version) !== row.version) throw makeError('VERSION_CONFLICT', '任务已更新，请刷新后重试', { current_version: row.version });
    const status = input.status == null ? row.status : String(input.status);
    if (!SESSION_STATUSES.has(status)) throw makeError('ORCHESTRATION_STATUS_INVALID', '不支持的任务状态');
    const mode = input.mode == null ? row.mode : String(input.mode);
    if (!['auto', 'collaborate', 'manual'].includes(mode)) throw makeError('ORCHESTRATION_MODE_INVALID', 'mode 必须是 auto、collaborate 或 manual');
    const completedAt = ['succeeded', 'partial', 'failed', 'cancelled'].includes(status) ? (row.completed_at || nowIso()) : null;
    db.prepare(`UPDATE orchestration_sessions SET title=?,user_goal=?,mode=?,status=?,source_context_json=?,linked_drama_id=?,linked_run_id=?,budget_json=?,usage_json=?,last_error_json=?,version=version+1,updated_at=?,completed_at=? WHERE id=?`)
      .run(
        input.title == null ? row.title : sanitizeString(input.title, new Set()),
        input.user_goal == null ? row.user_goal : sanitizeString(input.user_goal, new Set()), mode, status,
        input.source_context == null ? row.source_context_json : normalizedJson(input.source_context, {}),
        input.linked_drama_id === undefined ? row.linked_drama_id : (input.linked_drama_id || null),
        input.linked_run_id === undefined ? row.linked_run_id : (input.linked_run_id || null),
        input.budget == null ? row.budget_json : normalizedJson(input.budget, {}),
        input.usage == null ? row.usage_json : normalizedJson(input.usage, {}),
        input.last_error == null ? row.last_error_json : normalizedJson(input.last_error, {}),
        nowIso(), completedAt, id,
      );
    appendEvent(db, id, 'session.updated', { status, mode, note: input.note || null }, { actor: input.actor || 'codex' });
    return getBundle(id);
  }

  function submitPlan(id, input = {}) {
    const tx = db.transaction(() => {
      const session = getSessionRow(db, id);
      if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
      if (input.expected_revision != null && Number(input.expected_revision) !== session.plan_revision) {
        throw makeError('PLAN_REVISION_CONFLICT', '计划已更新，请读取最新版本后再提交', { current_revision: session.plan_revision });
      }
      const rawPlan = input.plan && typeof input.plan === 'object' ? input.plan : {};
      const rawNodes = Array.isArray(input.nodes) ? input.nodes : (Array.isArray(rawPlan.nodes) ? rawPlan.nodes : []);
      if (!rawNodes.length) throw makeError('PLAN_NODES_REQUIRED', '动态计划至少需要一个节点');
      const seen = new Set();
      for (const node of rawNodes) {
        const key = String(node.node_key || '').trim();
        if (!key) throw makeError('PLAN_NODE_KEY_REQUIRED', '每个节点都需要 node_key');
        if (seen.has(key)) throw makeError('PLAN_NODE_DUPLICATE', `计划中存在重复节点：${key}`);
        seen.add(key);
      }
      const existingRows = db.prepare('SELECT * FROM orchestration_nodes WHERE session_id=?').all(id);
      const existingByKey = new Map(existingRows.map((row) => [row.node_key, row]));
      const definitions = rawNodes.map((raw, index) => {
        const nodeKey = String(raw.node_key).trim();
        const moduleId = String(raw.module_id || 'manual.override').trim();
        const contract = moduleCatalog.getModule(moduleId);
        const requestedStatus = raw.status == null ? null : String(raw.status);
        if (requestedStatus && !NODE_STATUSES.has(requestedStatus)) throw makeError('NODE_STATUS_INVALID', `节点 ${nodeKey} 状态无效`);
        const decision = sanitize(raw.decision || {});
        delete decision.module_contract_status;
        const definition = {
          module_id: moduleId,
          module_version: Number(raw.module_version) || 1,
          phase: String(raw.phase || contract?.phase || 'create'),
          depends_on: sanitize(Array.isArray(raw.depends_on) ? raw.depends_on.map((key) => String(key).trim()).filter(Boolean) : []),
          input_refs: sanitize(Array.isArray(raw.input_refs) ? raw.input_refs : []),
          executor: String(raw.executor || contract?.executor || 'codex'),
          decision,
        };
        return {
          raw, index, nodeKey, contract, requestedStatus, definition,
          sortOrder: Number.isFinite(Number(raw.sort_order)) ? Number(raw.sort_order) : index,
        };
      });
      assertValidPlanGraph(definitions);

      const invalidated = new Map();
      for (const item of definitions) {
        const existing = existingByKey.get(item.nodeKey);
        if (existing && nodeDefinitionSignature(existingNodeDefinition(existing)) !== nodeDefinitionSignature(item.definition)) {
          invalidated.set(item.nodeKey, { reason: 'definition_changed', invalidated_by: [] });
        }
      }
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const item of definitions) {
          if (!existingByKey.has(item.nodeKey) || invalidated.has(item.nodeKey)) continue;
          const changedDependencies = item.definition.depends_on.filter((key) => invalidated.has(key));
          if (changedDependencies.length) {
            invalidated.set(item.nodeKey, { reason: 'upstream_invalidated', invalidated_by: changedDependencies });
            expanded = true;
          }
        }
      }
      for (const row of existingRows.filter((item) => item.status === 'running')) {
        if (!seen.has(row.node_key)) {
          throw makeError('PLAN_RUNNING_NODE_CONFLICT', `节点 ${row.node_key} 正在运行，不能从计划中移除；请先等待、停止本地执行或明确处理供应商任务`);
        }
        if (invalidated.has(row.node_key)) {
          throw makeError('PLAN_RUNNING_NODE_CONFLICT', `节点 ${row.node_key} 正在运行，不能静默修改其模块、依赖、输入或执行条件`);
        }
      }
      const revision = session.plan_revision + 1;
      db.prepare(`UPDATE orchestration_nodes SET active=0,updated_at=?,version=version+1 WHERE session_id=? AND status NOT IN ('running')`).run(nowIso(), id);
      const getExisting = db.prepare('SELECT * FROM orchestration_nodes WHERE session_id=? AND node_key=?');
      const insert = db.prepare(`
        INSERT INTO orchestration_nodes
          (id,session_id,node_key,module_id,module_version,plan_revision,phase,status,active,sort_order,depends_on_json,input_refs_json,output_refs_json,executor,progress_json,request_hash,config_revision,cost_ledger_id,decision_json,error_json,attempt,version,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?)
      `);
      const update = db.prepare(`
        UPDATE orchestration_nodes SET module_id=?,module_version=?,plan_revision=?,phase=?,status=?,active=1,sort_order=?,depends_on_json=?,input_refs_json=?,executor=?,decision_json=?,updated_at=?,version=version+1 WHERE id=?
      `);
      const invalidate = db.prepare(`
        UPDATE orchestration_nodes SET module_id=?,module_version=?,plan_revision=?,phase=?,status='pending',active=1,sort_order=?,depends_on_json=?,input_refs_json=?,output_refs_json='[]',executor=?,progress_json='{}',request_hash=NULL,config_revision=?,cost_ledger_id=NULL,decision_json=?,error_json='{}',attempt=attempt+1,started_at=NULL,completed_at=NULL,updated_at=?,version=version+1 WHERE id=?
      `);
      definitions.forEach((item) => {
        const { raw, nodeKey, contract, requestedStatus, definition } = item;
        const existing = getExisting.get(id, nodeKey);
        const status = requestedStatus || existing?.status || 'pending';
        const decision = { ...definition.decision, module_contract_status: contract ? contract.availability : 'unknown' };
        const values = {
          moduleId: definition.module_id, moduleVersion: definition.module_version, phase: definition.phase, status,
          sortOrder: item.sortOrder, depends: json(definition.depends_on, []), inputs: json(definition.input_refs, []),
          executor: definition.executor, configRevision: raw.config_revision || null, decision: json(decision, {}),
        };
        if (existing) {
          const invalidation = invalidated.get(nodeKey);
          if (invalidation) {
            invalidate.run(values.moduleId, values.moduleVersion, revision, values.phase, values.sortOrder, values.depends, values.inputs, values.executor, values.configRevision, values.decision, nowIso(), existing.id);
            appendEvent(db, id, 'node.invalidated_by_plan', {
              node_key: nodeKey, previous_status: existing.status, previous_attempt: existing.attempt,
              next_attempt: existing.attempt + 1, reason: invalidation.reason, invalidated_by: invalidation.invalidated_by,
              previous_plan_revision: existing.plan_revision, plan_revision: revision,
            }, { node_id: existing.id, actor: input.actor || 'codex' });
          } else {
            update.run(values.moduleId, values.moduleVersion, revision, values.phase, values.status, values.sortOrder, values.depends, values.inputs, values.executor, values.decision, nowIso(), existing.id);
          }
        } else {
          const stamp = nowIso();
          insert.run(crypto.randomUUID(), id, nodeKey, values.moduleId, values.moduleVersion, revision, values.phase, values.status, values.sortOrder, values.depends, values.inputs, '[]', values.executor, '{}', raw.request_hash || null, values.configRevision, raw.cost_ledger_id || null, values.decision, '{}', stamp, stamp);
        }
      });
      const plan = sanitize({ ...rawPlan, nodes: rawNodes.map((node) => ({ node_key: node.node_key, module_id: node.module_id, depends_on: node.depends_on || [] })) });
      const terminalStatus = computeSessionStatus(db, id);
      const nextStatus = input.confirm ? (terminalStatus || 'planned') : 'waiting_confirmation';
      db.prepare(`UPDATE orchestration_sessions SET plan_revision=?,plan_json=?,status=?,updated_at=?,version=version+1 WHERE id=?`)
        .run(revision, json(plan, {}), nextStatus, nowIso(), id);
      appendEvent(db, id, input.confirm ? 'plan.confirmed' : 'plan.proposed', {
        plan_revision: revision, node_count: rawNodes.length, summary: rawPlan.summary || null,
        invalidated_node_keys: [...invalidated.keys()], preserved_node_keys: definitions.filter((item) => existingByKey.has(item.nodeKey) && !invalidated.has(item.nodeKey)).map((item) => item.nodeKey),
      }, { actor: input.actor || 'codex' });
      return getBundle(id, { include_inactive: true });
    });
    return tx();
  }

  function confirmPlan(id, input = {}) {
    const session = getSessionRow(db, id);
    if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    if (input.expected_revision != null && Number(input.expected_revision) !== session.plan_revision) throw makeError('PLAN_REVISION_CONFLICT', '计划已更新，请刷新后再确认', { current_revision: session.plan_revision });
    if (session.plan_revision < 1) throw makeError('PLAN_REQUIRED', '请先提交动态计划');
    db.prepare(`UPDATE orchestration_sessions SET status='planned',updated_at=?,version=version+1 WHERE id=?`).run(nowIso(), id);
    appendEvent(db, id, 'plan.confirmed', { plan_revision: session.plan_revision, note: input.note || null }, { actor: input.actor || 'user' });
    return getBundle(id);
  }

  function startSession(id, input = {}) {
    const session = getSessionRow(db, id);
    if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    db.prepare(`UPDATE orchestration_sessions SET status='running',updated_at=?,completed_at=NULL,version=version+1 WHERE id=?`).run(nowIso(), id);
    refreshReadyNodes(db, id);
    appendEvent(db, id, 'session.started', { plan_revision: session.plan_revision }, { actor: input.actor || 'codex' });
    return getBundle(id);
  }

  function updateNode(sessionId, nodeIdOrKey, input = {}) {
    const tx = db.transaction(() => {
      const session = getSessionRow(db, sessionId);
      if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
      const row = getNodeRow(db, sessionId, nodeIdOrKey);
      if (!row) throw makeError('ORCHESTRATION_NODE_NOT_FOUND', '编排节点不存在');
      if (input.expected_version != null && Number(input.expected_version) !== row.version) throw makeError('VERSION_CONFLICT', '节点已更新，请刷新后重试', { current_version: row.version });
      const status = input.status == null ? row.status : String(input.status);
      if (session.status === 'paused' && status === 'running' && row.status !== 'running') throw makeError('SESSION_PAUSED', '任务已暂停，请先继续任务再开始新步骤');
      if (!NODE_STATUSES.has(status)) throw makeError('NODE_STATUS_INVALID', '不支持的节点状态');
      const stamp = nowIso();
      const startedAt = status === 'running' ? (row.started_at || stamp) : row.started_at;
      const completedAt = TERMINAL_NODE_STATUSES.has(status) ? (row.completed_at || stamp) : null;
      const redactions = new Set();
      const error = input.error == null ? parse(row.error_json, {}) : sanitize(input.error, redactions);
      db.prepare(`
        UPDATE orchestration_nodes SET status=?,progress_json=?,input_refs_json=?,output_refs_json=?,executor=?,decision_json=?,error_json=?,request_hash=?,config_revision=?,cost_ledger_id=?,active=?,updated_at=?,started_at=?,completed_at=?,version=version+1 WHERE id=?
      `).run(
        status,
        input.progress == null ? row.progress_json : normalizedJson(input.progress, {}),
        input.input_refs == null ? row.input_refs_json : normalizedJson(input.input_refs, []),
        input.output_refs == null ? row.output_refs_json : normalizedJson(input.output_refs, []),
        input.executor == null ? row.executor : String(input.executor),
        input.decision == null ? row.decision_json : normalizedJson(input.decision, {}),
        json(error, {}), input.request_hash === undefined ? row.request_hash : (input.request_hash || null),
        input.config_revision === undefined ? row.config_revision : (input.config_revision || null),
        input.cost_ledger_id === undefined ? row.cost_ledger_id : (input.cost_ledger_id || null),
        input.active === undefined ? row.active : (input.active ? 1 : 0), stamp, startedAt, completedAt, row.id,
      );
      const node = publicNode(db.prepare('SELECT * FROM orchestration_nodes WHERE id=?').get(row.id));
      let receipt = null;
      if (TERMINAL_NODE_STATUSES.has(status) && (input.receipt || ['failed', 'partial'].includes(status))) {
        receipt = createReceipt(db, node, input.receipt || { status, message: error.message || '', original_code: error.code || null, retryable: error.retryable ?? 'unknown', next_actions: error.next_actions || [] }, status);
      }
      appendEvent(db, sessionId, `node.${status}`, { node_key: node.node_key, module_id: node.module_id, attempt: node.attempt, progress: node.progress, error, receipt_id: receipt?.id || null, redactions: [...redactions] }, { node_id: node.id, actor: input.actor || 'codex' });
      if (SATISFIED_NODE_STATUSES.has(status)) refreshReadyNodes(db, sessionId);
      const computed = computeSessionStatus(db, sessionId);
      if (computed) db.prepare('UPDATE orchestration_sessions SET status=?,updated_at=?,completed_at=?,version=version+1 WHERE id=?').run(computed, stamp, stamp, sessionId);
      else if (session.status !== 'paused' && ['running', 'ready'].includes(status)) db.prepare(`UPDATE orchestration_sessions SET status='running',updated_at=?,completed_at=NULL,version=version+1 WHERE id=?`).run(stamp, sessionId);
      return { node, receipt, bundle: getBundle(sessionId) };
    });
    return tx();
  }

  function retryNode(sessionId, nodeIdOrKey, input = {}) {
    const row = getNodeRow(db, sessionId, nodeIdOrKey);
    if (!row) throw makeError('ORCHESTRATION_NODE_NOT_FOUND', '编排节点不存在');
    if (row.status === 'running') throw makeError('NODE_RUNNING', '节点仍在运行；请先停止本地观察或等待真实结果');
    if (row.status === 'succeeded' && !input.force) throw makeError('NODE_ALREADY_SUCCEEDED', '节点已经成功；如需重新执行，请明确 force=true');
    const stamp = nowIso();
    db.prepare(`UPDATE orchestration_nodes SET status='ready',attempt=attempt+1,progress_json='{}',error_json='{}',started_at=NULL,completed_at=NULL,updated_at=?,version=version+1,active=1 WHERE id=?`).run(stamp, row.id);
    db.prepare(`UPDATE orchestration_sessions SET status='running',last_error_json='{}',updated_at=?,completed_at=NULL,version=version+1 WHERE id=?`).run(stamp, sessionId);
    const node = publicNode(db.prepare('SELECT * FROM orchestration_nodes WHERE id=?').get(row.id));
    appendEvent(db, sessionId, 'node.retry_authorized', { node_key: node.node_key, attempt: node.attempt, note: input.note || null }, { node_id: node.id, actor: input.actor || 'user' });
    return { node, bundle: getBundle(sessionId) };
  }

  function actOnNode(sessionId, nodeIdOrKey, action, input = {}) {
    const row = getNodeRow(db, sessionId, nodeIdOrKey);
    if (!row) throw makeError('ORCHESTRATION_NODE_NOT_FOUND', '编排节点不存在');
    const name = String(action || '').trim().toLowerCase();
    if (name === 'retry' || name === 'reopen') {
      return retryNode(sessionId, nodeIdOrKey, { ...input, force: name === 'reopen' || input.force });
    }
    if (name === 'start') {
      if (!input.force && !['ready', 'waiting_confirmation'].includes(row.status)) {
        throw makeError('NODE_NOT_READY', '节点尚未就绪；可以先修改依赖计划，或由人工明确强制接管', { current_status: row.status });
      }
      return updateNode(sessionId, nodeIdOrKey, {
        ...input,
        status: 'running',
        progress: input.progress || { state: 'local_started', message: '执行器已开始；等待真实阶段事件' },
      });
    }
    if (name === 'complete') {
      return updateNode(sessionId, nodeIdOrKey, {
        ...input,
        status: input.partial ? 'partial' : 'succeeded',
        progress: input.progress || { state: 'completed', message: input.partial ? '节点部分完成，仍有明确未完成项' : '节点执行完成' },
        error: {},
        receipt: input.receipt || {
          status: input.partial ? 'partial' : 'success',
          source: input.source || row.executor || 'local',
          message: input.message || (input.partial ? '节点部分完成' : '节点执行完成'),
          retryable: input.partial ? 'unknown' : 'false',
          next_actions: input.partial ? ['retry', 'manual', 'continue'] : ['continue'],
        },
      });
    }
    if (name === 'fail') {
      const error = input.error || {
        code: input.original_code || null,
        message: input.message || '执行失败，尚未提供更多信息',
        retryable: input.retryable ?? 'unknown',
        next_actions: input.next_actions || ['retry', 'skip', 'manual'],
      };
      return updateNode(sessionId, nodeIdOrKey, {
        ...input,
        status: 'failed',
        progress: input.progress || { state: 'failed', message: error.message },
        error,
        receipt: input.receipt || {
          status: 'failed', source: input.source || row.executor || 'local', original_code: error.code || null,
          normalized_category: input.normalized_category || null, message: error.message,
          attempted: input.attempted || [], retryable: error.retryable ?? 'unknown',
          fallback_available: Boolean(input.fallback_available), next_actions: error.next_actions || ['retry', 'skip', 'manual'],
          correlation_id: input.correlation_id || null,
        },
      });
    }
    if (name === 'skip') {
      return updateNode(sessionId, nodeIdOrKey, {
        ...input,
        status: 'skipped',
        progress: input.progress || { state: 'skipped', message: input.message || '节点已跳过；未伪造执行结果' },
        decision: { ...parse(row.decision_json, {}), ...(sanitize(input.decision || {})), skip_note: input.note || null },
        receipt: input.receipt || { status: 'success', source: 'manual', message: input.message || '节点已跳过', retryable: 'false', next_actions: ['continue', 'reopen'] },
      });
    }
    throw makeError('NODE_ACTION_INVALID', '不支持的节点动作；可用 start、complete、fail、skip、retry 或 reopen');
  }

  function pauseSession(id, input = {}) {
    return updateSession(id, { status: 'paused', actor: input.actor || 'user', note: input.note || null, expected_version: input.expected_version });
  }
  function resumeSession(id, input = {}) {
    const bundle = updateSession(id, { status: 'running', actor: input.actor || 'user', note: input.note || null, expected_version: input.expected_version });
    refreshReadyNodes(db, id);
    appendEvent(db, id, 'session.resumed_from_checkpoint', { checkpoint: bundle.session.checkpoint || {} }, { actor: input.actor || 'user' });
    const computed = computeSessionStatus(db, id);
    if (computed) {
      db.prepare('UPDATE orchestration_sessions SET status=?,updated_at=?,completed_at=COALESCE(completed_at,?),version=version+1 WHERE id=?')
        .run(computed, nowIso(), nowIso(), id);
    }
    return getBundle(id);
  }
  function saveCheckpoint(id, input = {}) {
    const session = getSessionRow(db, id);
    if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    const latestEvent = db.prepare('SELECT MAX(id) AS id FROM orchestration_events WHERE session_id=?').get(id)?.id || 0;
    const checkpoint = sanitize({ ...(input.checkpoint || {}), plan_revision: session.plan_revision, event_cursor: latestEvent, saved_at: nowIso() });
    db.prepare('UPDATE orchestration_sessions SET checkpoint_json=?,updated_at=?,version=version+1 WHERE id=?').run(json(checkpoint, {}), nowIso(), id);
    appendEvent(db, id, 'session.checkpoint_saved', { plan_revision: session.plan_revision, event_cursor: latestEvent, summary: checkpoint.summary || null }, { actor: input.actor || 'codex' });
    return getBundle(id);
  }
  function exportSession(id) {
    const bundle = getBundle(id, { include_inactive: true, event_limit: 500 });
    if (!bundle) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    return { exported_at: nowIso(), schema: 'yinzi.codex-video-orchestration/v1', ...bundle };
  }

  function recordArtifact(sessionId, input = {}) {
    const session = getSessionRow(db, sessionId);
    if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    const artifactId = String(input.artifact_id || input.id || '').trim();
    if (!artifactId || artifactId.length > 180) throw makeError('ARTIFACT_ID_REQUIRED', '成果必须提供不超过180个字符的稳定 artifact_id');
    const existing = db.prepare('SELECT * FROM orchestration_artifacts WHERE session_id=? AND artifact_id=?').get(sessionId, artifactId);
    if (existing) return { reused: true, artifact: publicArtifact(existing), bundle: getBundle(sessionId) };
    const id = String(input.id || crypto.randomUUID());
    const type = String(input.type || 'unknown').trim().slice(0, 40) || 'unknown';
    const mime = input.mime_type == null ? null : String(input.mime_type).trim().slice(0, 120);
    const safe = (value, max = 2000) => value == null ? null : sanitizeString(String(value).slice(0, max), new Set());
    const stamp = nowIso();
    db.prepare(`INSERT INTO orchestration_artifacts
      (id,session_id,node_id,artifact_id,type,mime_type,title,url,thumbnail_url,path,bytes,width,height,duration_seconds,frame_rate,shot_id,version,status,source_refs_json,validation_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, sessionId, input.node_id || null, artifactId, type, mime, safe(input.title || artifactId, 240), safe(input.url, 2000), safe(input.thumbnail_url, 2000), safe(input.path, 2000),
      input.bytes == null ? null : Math.max(0, Number(input.bytes) || 0), input.width == null ? null : Math.max(0, Number(input.width) || 0), input.height == null ? null : Math.max(0, Number(input.height) || 0),
      input.duration_seconds == null ? null : Math.max(0, Number(input.duration_seconds) || 0), input.frame_rate == null ? null : Math.max(0, Number(input.frame_rate) || 0), safe(input.shot_id, 180), Math.max(1, Number(input.version) || 1),
      String(input.status || 'ready').slice(0, 30), normalizedJson(input.source_refs, []), normalizedJson(input.validation, {}), stamp,
    );
    appendEvent(db, sessionId, 'artifact.registered', { artifact_id: artifactId, type, title: safe(input.title || artifactId, 240), validation: input.validation || {} }, { node_id: input.node_id || null, actor: input.actor || 'codex' });
    return { reused: false, artifact: publicArtifact(db.prepare('SELECT * FROM orchestration_artifacts WHERE id=?').get(id)), bundle: getBundle(sessionId) };
  }

  function recordFeedback(sessionId, input = {}) {
    const session = getSessionRow(db, sessionId);
    if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    const message = String(input.message || '').trim();
    if (!message || message.length > 8000) throw makeError('FEEDBACK_MESSAGE_INVALID', '反馈不能为空且不能超过8000个字符');
    const key = String(input.idempotency_key || input.request_id || '').trim();
    if (!key || key.length > 200) throw makeError('FEEDBACK_IDEMPOTENCY_REQUIRED', '反馈必须提供稳定幂等键');
    const prior = db.prepare('SELECT * FROM orchestration_feedback WHERE session_id=? AND idempotency_key=?').get(sessionId, key);
    if (prior) return { reused: true, feedback: publicFeedback(prior), bundle: getBundle(sessionId) };
    const id = crypto.randomUUID();
    const scope = sanitize(input.scope && typeof input.scope === 'object' ? input.scope : { type: input.scope || 'session', node_id: input.node_id || null, artifact_id: input.artifact_id || null });
    db.prepare('INSERT INTO orchestration_feedback (id,session_id,idempotency_key,message,scope_json,actor,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, sessionId, key, sanitizeString(message, new Set()), json(scope, {}), normalizeActor(input.actor || 'user'), 'open', nowIso());
    appendEvent(db, sessionId, 'user.feedback', { feedback_id: id, message, scope }, { actor: input.actor || 'user' });
    if (input.pause === true && ['running', 'planned', 'waiting_confirmation'].includes(session.status)) {
      db.prepare("UPDATE orchestration_sessions SET status='paused',updated_at=?,version=version+1 WHERE id=?").run(nowIso(), sessionId);
      appendEvent(db, sessionId, 'session.paused_for_feedback', { feedback_id: id }, { actor: input.actor || 'user' });
    }
    return { reused: false, feedback: publicFeedback(db.prepare('SELECT * FROM orchestration_feedback WHERE id=?').get(id)), bundle: getBundle(sessionId) };
  }

  function deliverSession(sessionId, input = {}) {
    const session = getSessionRow(db, sessionId);
    if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    const key = String(input.idempotency_key || input.request_id || '').trim();
    if (!key || key.length > 200) throw makeError('DELIVERY_IDEMPOTENCY_REQUIRED', '交付必须提供稳定幂等键');
    const prior = db.prepare('SELECT * FROM orchestration_deliveries WHERE session_id=? AND idempotency_key=?').get(sessionId, key);
    if (prior) return { reused: true, delivery: latestDelivery(sessionId), bundle: getBundle(sessionId) };
    const ids = [...new Set((Array.isArray(input.artifact_ids) ? input.artifact_ids : []).map((value) => String(value).trim()).filter(Boolean))].slice(0, 100);
    if (!ids.length) throw makeError('DELIVERY_ARTIFACTS_REQUIRED', '交付至少需要选择一个成果');
    const available = db.prepare('SELECT artifact_id FROM orchestration_artifacts WHERE session_id=?').all(sessionId).map((row) => row.artifact_id);
    const missing = ids.filter((id) => !available.includes(id));
    if (missing.length) throw makeError('DELIVERY_ARTIFACT_NOT_FOUND', '交付包含当前任务不存在的成果', { missing });
    const row = { id: crypto.randomUUID(), session_id: sessionId, idempotency_key: key, artifact_ids_json: json(ids, []), format: input.format == null ? null : String(input.format).slice(0, 40), status: 'ready', created_at: nowIso() };
    db.prepare('INSERT INTO orchestration_deliveries (id,session_id,idempotency_key,artifact_ids_json,format,status,created_at) VALUES (?,?,?,?,?,?,?)').run(row.id, row.session_id, row.idempotency_key, row.artifact_ids_json, row.format, row.status, row.created_at);
    appendEvent(db, sessionId, 'delivery.prepared', { delivery_id: row.id, artifact_ids: ids, format: row.format }, { actor: input.actor || 'user' });
    return { reused: false, delivery: latestDelivery(sessionId), bundle: getBundle(sessionId) };
  }

  function completeSession(sessionId, input = {}) {
    return db.transaction(() => {
      const row = getSessionRow(db, sessionId);
      if (!row) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
      const status = computeSessionStatus(db, sessionId);
      if (!status) throw makeError('COMPLETION_UNFINISHED_NODES', '请先回报每个活动节点的真实结果，再完成任务', { unfinished: listNodes(sessionId).filter(node => !TERMINAL_NODE_STATUSES.has(node.status)).map(node => node.node_key) });
      if (input.expected_version != null && Number(input.expected_version) !== row.version) throw makeError('VERSION_CONFLICT', '任务已更新，请刷新后重试');
      const completionToken = `${row.plan_revision}:${listNodes(sessionId).map(node => `${node.id}:${node.version}`).join('|')}`;
      const prior = db.prepare("SELECT id FROM orchestration_events WHERE session_id=? AND event_type='session.completed' AND json_extract(payload_json, '$.completion_token')=? LIMIT 1").get(sessionId,completionToken);
      if (prior && row.completed_at && row.status === status) return { reused:true, bundle:getBundle(sessionId) };
      db.prepare('UPDATE orchestration_sessions SET status=?,completed_at=COALESCE(completed_at,?),updated_at=?,version=version+1 WHERE id=?').run(status,nowIso(),nowIso(),sessionId);
      db.prepare("UPDATE orchestration_deliveries SET status='delivered' WHERE session_id=? AND status='ready'").run(sessionId);
      appendEvent(db,sessionId,'session.completed',{status,plan_revision:row.plan_revision,completion_token:completionToken,summary:input.summary || ''},{actor:input.actor || 'codex'});
      return { reused:false,bundle:getBundle(sessionId) };
    })();
  }

  function reserveExternalRequest(sessionId, nodeIdOrKey, input = {}) {
    const tx = db.transaction(() => {
      const session = getSessionRow(db, sessionId);
      if (!session) throw makeError('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
      const row = getNodeRow(db, sessionId, nodeIdOrKey);
      if (!row) throw makeError('ORCHESTRATION_NODE_NOT_FOUND', '编排节点不存在');
      const requestHash = String(input.request_hash || '').trim();
      if (!requestHash) throw makeError('REQUEST_HASH_REQUIRED', '外部请求必须提供稳定 request_hash');
      const priorSubmission = parse(row.progress_json, {}).submission_state;
      if (row.request_hash) {
        if (row.request_hash !== requestHash) throw makeError('REQUEST_HASH_CONFLICT', '该节点已绑定另一请求；请重开节点或提交新计划，禁止静默覆盖');
        return { reserved: false, reused: true, reconciliation_required: ['submitting', 'accepted', 'uncertain', 'settled'].includes(priorSubmission), node: publicNode(row) };
      }
      if (!['ready', 'waiting_confirmation'].includes(row.status)) {
        throw makeError('NODE_NOT_READY', '节点尚未就绪，不能创建新的外部请求');
      }
      if (session.status === 'paused') throw makeError('SESSION_PAUSED', '任务已暂停，不再提交新的外部请求；已有任务仍可查询');
      const stamp = nowIso();
      const progress = sanitize({ ...(parse(row.progress_json, {})), ...(input.progress || {}), state: 'local_started', submission_state: 'submitting', message: input.message || '正在提交外部请求' });
      const decision = sanitize({ ...(parse(row.decision_json, {})), ...(input.decision || {}) });
      db.prepare(`UPDATE orchestration_nodes SET status='running',request_hash=?,progress_json=?,decision_json=?,started_at=COALESCE(started_at,?),completed_at=NULL,updated_at=?,version=version+1 WHERE id=?`)
        .run(requestHash, json(progress, {}), json(decision, {}), stamp, stamp, row.id);
      db.prepare(`UPDATE orchestration_sessions SET status='running',updated_at=?,completed_at=NULL,version=version+1 WHERE id=?`).run(stamp, sessionId);
      const node = publicNode(db.prepare('SELECT * FROM orchestration_nodes WHERE id=?').get(row.id));
      appendEvent(db, sessionId, 'node.external_request_reserved', { node_key: node.node_key, request_hash: requestHash, attempt: node.attempt }, { node_id: node.id, actor: input.actor || 'codex' });
      return { reserved: true, reused: false, reconciliation_required: false, node };
    });
    return tx.immediate();
  }

  return {
    beginWork, reportActivity, createSession, updateSession, listSessions, getBundle, submitPlan, confirmPlan, startSession, completeSession,
    updateNode, retryNode, actOnNode, pauseSession, resumeSession, saveCheckpoint, exportSession,
    reserveExternalRequest, listArtifacts, searchArtifacts, listFeedback, latestDelivery, recordArtifact, recordFeedback, deliverSession,
    onboarding, recordEvent,
    listEvents, listNodes, listReceipts, listBlenderJobs,
  };
}

module.exports = { createOrchestrationService, ensureSchema, sanitize, publicBlenderJob, SESSION_STATUSES, NODE_STATUSES };
