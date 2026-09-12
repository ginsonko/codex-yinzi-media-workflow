const crypto = require('node:crypto');
const { sanitize } = require('./orchestrationService');

const caches = new WeakMap();
const TECHNICAL = new Set(['succeeded', 'failed', 'unknown']);
const QUALITY = new Set(['not_reviewed', 'passed', 'partial', 'failed']);
const secretField = /^(?:x[-_]?api[-_]?key|api[-_]?key|authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|(?:access|refresh|source|session|bearer)[-_]?token|x[-_]?amz[-_]?security[-_]?token|x[-_]?amz[-_]?(?:signature|credential)|x[-_]?goog[-_]?(?:signature|credential)|aws[-_]?access[-_]?key[-_]?id|token|password|secret|client[-_]?secret|credential)$/i;
const fail = (code, message) => Object.assign(new Error(message), { code });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

// Experience text is reference data, never executable instructions. Strip
// credentials before persisting or indexing it, including signed media URLs.
function redact(value, depth = 0) {
  if (depth > 10) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 128).map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 128)
    .map(([key, item]) => [key, secretField.test(key) ? '[REDACTED]' : redact(item, depth + 1)]));
  if (typeof value !== 'string') return value;
  return sanitize(value)
    .replace(/data:[^\s;,]+(?:;[^,]*)?,[^\s)"']+/gi, '[media data omitted]')
    .replace(/\b(?:https?:\/\/)[^\s<>"')]+/gi, raw => {
      try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString(); }
      catch { return '[redacted URL]'; }
    })
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=*-]+/gi, '[REDACTED AUTH]')
    .replace(/\b((?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"')?#]*)?)\?[^\s<>"')]+/gi, '$1')
    .replace(/\b(?:cookie|set-cookie)["']?\s*[:=]\s*[^\r\n]+/gi, '[REDACTED COOKIE]')
    .replace(/\b(?:api[-_]?key|authorization|(?:access|refresh|source|session|bearer)[-_]?token|x[-_]?amz[-_]?(?:security[-_]?token|signature|credential)|x[-_]?goog[-_]?(?:signature|credential)|aws[-_]?access[-_]?key[-_]?id|token|password|client[-_]?secret|secret)["']?\s*[:=]\s*[^\r\n,;]+/gi, '[REDACTED CREDENTIAL]');
}
function summarizeParameters(value, key = '') {
  if (typeof value === 'string' && /(?:prompt|script|transcript|narration|instruction|caption|description|text)s?$/i.test(key)) {
    return { character_count:[...value].length,sha256:digest(value),content:'see original local media job' };
  }
  if (Array.isArray(value)) return value.map(item => summarizeParameters(item,key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,summarizeParameters(v,k)]));
  return value;
}
function text(value, max = 1000) { return String(redact(value == null ? '' : value)).trim().slice(0, max); }
function object(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('EXPERIENCE_INVALID', '经验的上下文和处理建议必须是结构化对象');
  if (JSON.stringify(value).length > 32000) throw fail('EXPERIENCE_TOO_LARGE', '经验内容过长，请保存摘要和证据位置');
  return redact(value);
}
function listText(value, max = 32) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw fail('EXPERIENCE_INVALID', '标签和证据引用必须是列表');
  return [...new Set(value.slice(0, max).map(item => text(item, 1200)).filter(Boolean))];
}

function createMediaExperiences(db) {
  if (caches.has(db)) return caches.get(db);
  db.exec(`CREATE TABLE IF NOT EXISTS media_experiences (
    id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
    module_id TEXT NOT NULL, session_id TEXT NOT NULL, technical_status TEXT NOT NULL,
    source TEXT NOT NULL, created_at TEXT NOT NULL, search_text TEXT NOT NULL, record_json TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS media_experiences_module ON media_experiences(module_id, created_at);
  CREATE INDEX IF NOT EXISTS media_experiences_session ON media_experiences(session_id, created_at);`);
  function get(id) {
    const row = db.prepare('SELECT record_json FROM media_experiences WHERE id=?').get(String(id));
    if (!row) return null;
    const record = JSON.parse(row.record_json);
    const revisions = db.prepare("SELECT id FROM media_experiences WHERE json_extract(record_json,'$.supersedes_id')=? ORDER BY created_at,id").all(record.id);
    return { ...record, superseded_by: revisions.map(item => item.id) };
  }
  const insert = db.transaction((input, source) => {
    const key = String(input.request_key || '').trim();
    if (!key || key.length > 240 || text(key, 241) !== key) throw fail('EXPERIENCE_REQUEST_KEY', '需要不含凭据的稳定经验请求键');
    const technical = input.technical_status || 'unknown', quality = input.quality_status || 'not_reviewed';
    if (!TECHNICAL.has(technical) || !QUALITY.has(quality)) throw fail('EXPERIENCE_INVALID', '经验状态无效');
    const title = text(input.title, 240);
    if (!title) throw fail('EXPERIENCE_INVALID', '请填写经验标题');
    const payload = {
      request_key: key, title, summary: text(input.summary, 2000), category: text(input.category || 'media', 100),
      tags: listText(input.tags, 24), module_id: text(input.module_id, 200), session_id: text(input.session_id, 200),
      job_id: text(input.job_id, 200) || null, attempt: Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : null,
      source, actor: source === 'system_receipt' ? 'system' : text(input.actor || (source === 'user_note' ? 'user' : 'agent'), 120),
      technical_status: technical, quality_status: quality,
      context: object(input.context), error: input.error ? object(input.error) : null,
      guidance: object(input.guidance), evidence_refs: listText(input.evidence_refs), supersedes_id: text(input.supersedes_id, 200) || null,
    };
    const hash = digest(payload);
    const previous = db.prepare('SELECT id,request_hash FROM media_experiences WHERE request_key=?').get(key);
    if (previous) {
      if (previous.request_hash !== hash) throw fail('EXPERIENCE_REQUEST_CONFLICT', '同一经验请求键的内容已变化；请用新请求键记录补充或纠正');
      return { ...get(previous.id), reused: true };
    }
    if (payload.supersedes_id && !get(payload.supersedes_id)) throw fail('EXPERIENCE_NOT_FOUND', '被纠正的原经验不存在');
    const record = { id: crypto.randomUUID(), ...payload, created_at: new Date().toISOString() };
    const search = [title, record.summary, record.category, ...record.tags, record.module_id,
      JSON.stringify(record.error), JSON.stringify(record.guidance)].join(' ').toLowerCase();
    db.prepare('INSERT INTO media_experiences VALUES (?,?,?,?,?,?,?,?,?,?)').run(record.id,key,hash,record.module_id,
      record.session_id,technical,source,record.created_at,search,JSON.stringify(record));
    return { ...record, superseded_by: [], reused: false };
  });
  function recordNote(input = {}) {
    const source = input.source || 'agent_note';
    if (!['agent_note', 'user_note'].includes(source)) throw fail('EXPERIENCE_SOURCE_INVALID', '系统执行回执由后台自动记录；补充经验请选择用户或代理笔记');
    return insert(input, source);
  }
  function recordJob(job) {
    if (!['succeeded', 'failed'].includes(job.status)) return null;
    const result = job.result || {}, error = job.status === 'failed' ? job.error : null;
    const params = summarizeParameters(redact(job.request.parameters || {})), sources = result.sources || job.request.sources || [];
    const parameterSummary = JSON.stringify(params).length <= 8000 ? params
      : { keys:Object.keys(params), sha256:digest(params), full_parameters:'see original local media job' };
    return insert({
      request_key: `local-job:${job.id}:${job.attempt}:${job.status}`,
      title: `${job.operation_title || job.request.module_id}：${job.status === 'succeeded' ? '执行完成' : '执行失败'}`,
      summary: job.status === 'succeeded' ? '本地执行回执已保存；内容质量尚未由用户或代理验收。' : text(error?.message || '执行失败，未取得更多原因'),
      category: 'local_media', tags: [job.request.module_id, job.status, ...(error?.code ? [error.code] : [])],
      module_id: job.request.module_id, session_id: job.session_id, job_id: job.id, attempt: job.attempt,
      technical_status: job.status, quality_status: 'not_reviewed', error,
      context: {
        component_id: result.component_id || null, component_version: result.component_version || null,
        components: (result.components || []).slice(0, 16), parameters: parameterSummary,
        input_sha256: result.input_sha256 || null, input_identity: job.request.input_identity || null,
        sources: sources.slice(0, 24).map(item => ({ role: item.role, sha256: item.sha256 || null, identity: item.identity || null, identity_basis:item.identity_basis || null })),
        sources_count: sources.length, sources_truncated: sources.length > 24,
        output_sha256: result.output_sha256 || null, bytes: result.bytes || null,
        source_status: job.status, executor_quality_status: result.details?.quality_status || null,
      },
      evidence_refs: [`local-media-job:${job.id}`, ...(job.status === 'succeeded' && result.output_path ? [result.output_path] : [])],
    }, 'system_receipt');
  }
  function list(query = {}) {
    const number = (value, fallback, max) => value == null ? fallback : Math.min(max, Math.max(0, Math.floor(Number(value) || 0)));
    const limit = Math.max(1, number(query.limit, 20, 100)), offset = number(query.offset, 0, 1000000);
    const conditions = [], args = [];
    for (const key of ['module_id', 'session_id', 'technical_status', 'source']) if (query[key]) { conditions.push(`${key}=?`); args.push(String(query[key])); }
    for (const term of text(query.q, 500).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)) {
      conditions.push("search_text LIKE ? ESCAPE '\\'"); args.push('%' + term.replace(/[\\%_]/g, '\\$&') + '%');
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const total = db.prepare('SELECT COUNT(*) n FROM media_experiences' + where).get(...args).n;
    const rows = db.prepare('SELECT record_json FROM media_experiences' + where + ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(...args, limit, offset);
    const items = rows.map(row => {
      const { id, title, summary, category, tags, module_id, session_id, job_id, attempt, source, actor, technical_status, quality_status, created_at, supersedes_id } = JSON.parse(row.record_json);
      return { id, title, summary, category, tags, module_id, session_id, job_id, attempt, source, actor, technical_status, quality_status, created_at, supersedes_id };
    });
    return { items, total, limit, offset };
  }
  const service = { get, list, recordNote, recordJob };
  caches.set(db, service); return service;
}
module.exports = { createMediaExperiences, redact, summarizeParameters };
