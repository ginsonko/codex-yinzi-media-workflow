'use strict';
const crypto = require('node:crypto');
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');

function createStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS creation_canvases (id TEXT PRIMARY KEY, title TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS creation_canvas_requests (canvas_id TEXT NOT NULL, request_id TEXT NOT NULL, hash TEXT NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(canvas_id,request_id));
    CREATE TABLE IF NOT EXISTS creation_canvas_jobs (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS creation_canvas_jobs_owner ON creation_canvas_jobs(canvas_id,updated_at);
    CREATE TABLE IF NOT EXISTS creation_canvas_runs (id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, status TEXT NOT NULL, data_json TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS creation_canvas_runs_owner ON creation_canvas_runs(canvas_id,updated_at);
    CREATE TABLE IF NOT EXISTS creation_canvas_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, canvas_id TEXT NOT NULL, data_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS creation_canvas_messages_owner ON creation_canvas_messages(canvas_id,seq);`);
  function get(id) {
    const row = db.prepare('SELECT data_json FROM creation_canvases WHERE id=?').get(String(id));
    if (!row) throw fail('CANVAS_NOT_FOUND', '画布不存在', 404);
    return JSON.parse(row.data_json);
  }
  function save(canvas) {
    canvas.updated_at = now();
    db.prepare('INSERT INTO creation_canvases VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,data_json=excluded.data_json,updated_at=excluded.updated_at')
      .run(canvas.id, canvas.title, JSON.stringify(canvas), canvas.updated_at);
    return canvas;
  }
  const mutate = db.transaction((id, fn) => { const canvas = get(id); const result = fn(canvas); canvas.revision++; save(canvas); return result; });
  const once = db.transaction((id, requestId, input, fn) => {
    if (!requestId || typeof requestId !== 'string' || requestId.length > 240) throw fail('REQUEST_ID_REQUIRED', '请提供本次操作的 request_id；显式再操作请使用新值');
    const previous = db.prepare('SELECT * FROM creation_canvas_requests WHERE canvas_id=? AND request_id=?').get(id, requestId);
    const digest = hash(input);
    if (previous) {
      if (previous.hash !== digest) throw fail('REQUEST_CONFLICT', '请求内容已变更，请使用新的 request_id', 409);
      return { ...JSON.parse(previous.result_json), reused: true };
    }
    const result = fn();
    db.prepare('INSERT INTO creation_canvas_requests VALUES (?,?,?,?)').run(id, requestId, digest, JSON.stringify(result));
    return result;
  });
  const table = kind => kind === 'job' ? 'creation_canvas_jobs' : 'creation_canvas_runs';
  function record(kind, value) {
    value.updated_at = now();
    db.prepare(`INSERT INTO ${table(kind)} VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data_json=excluded.data_json,updated_at=excluded.updated_at`)
      .run(value.id, value.canvas_id, value.status, JSON.stringify(value), value.updated_at);
    return value;
  }
  function read(kind, id, canvasId) {
    const row = db.prepare(`SELECT data_json FROM ${table(kind)} WHERE id=?`).get(String(id));
    const value = row && JSON.parse(row.data_json);
    if (!value || (canvasId && value.canvas_id !== canvasId)) throw fail('CANVAS_RECORD_NOT_FOUND', '这份记录不属于当前画布', 404);
    return value;
  }
  function records(kind, canvasId, limit = 100) {
    return db.prepare(`SELECT data_json FROM ${table(kind)} ${canvasId ? 'WHERE canvas_id=?' : ''} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(canvasId ? [canvasId, limit] : [limit])).map(row => JSON.parse(row.data_json));
  }
  function message(canvasId, item) {
    get(canvasId);
    const value = { ...item, created_at: now() };
    const result = db.prepare('INSERT INTO creation_canvas_messages(canvas_id,data_json) VALUES (?,?)').run(canvasId, JSON.stringify(value));
    return { seq: Number(result.lastInsertRowid), ...value };
  }
  function messages(canvasId, after = 0, limit = 100) {
    return db.prepare('SELECT seq,data_json FROM creation_canvas_messages WHERE canvas_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(canvasId, Number(after) || 0, Math.min(500, Math.max(1, Number(limit) || 100))).map(row => ({ seq: row.seq, ...JSON.parse(row.data_json) }));
  }
  return { db, get, save, mutate, once, record, read, records, message, messages,
    create: (body = {}) => save({ id: uid(), title: String(body.title || '新的创作画布').slice(0, 160), revision: 1,
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, agent: {}, created_at: now() }),
    list: () => db.prepare('SELECT id,title,updated_at FROM creation_canvases ORDER BY updated_at DESC').all() };
}
module.exports = { createStore, uid, now, clone, fail, hash };
