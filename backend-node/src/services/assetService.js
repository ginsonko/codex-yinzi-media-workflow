const fs = require('fs');
const path = require('path');
function list(db, query, cfg) {
  let sql = 'FROM assets WHERE deleted_at IS NULL';
  const params = [];
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  if (query.type) {
    sql += ' AND type = ?';
    params.push(query.type);
  }
  const keyword = String(query.keyword || query.q || '').trim();
  if (keyword) {
    sql += " AND (name LIKE ? OR category LIKE ? OR url LIKE ? OR local_path LIKE ?)";
    const pattern = `%${keyword}%`;
    params.push(pattern, pattern, pattern, pattern);
  }
  const countRow = db.prepare('SELECT COUNT(*) as total ' + sql).get(...params);
  const total = countRow.total || 0;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.page_size, 10) || 20));
  const offset = (page - 1) * pageSize;
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC LIMIT ? OFFSET ?').all(...params, pageSize, offset);
  return { items: rows.map(row => rowToItem(row, cfg)), total, page, pageSize };
}

function rowToItem(r, cfg) {
  const media = localFileMetadata(r.local_path, cfg);
  return {
    id: r.id,
    drama_id: r.drama_id,
    name: r.name,
    type: r.type,
    category: r.category,
    url: r.url,
    local_path: r.local_path,
    file_size: media?.size ?? r.file_size,
    available: Boolean(media),
    download_url: media ? `/api/v1/assets/${r.id}/download` : null,
    mime_type: r.mime_type,
    width: r.width,
    height: r.height,
    duration: r.duration,
    image_gen_id: r.image_gen_id,
    video_gen_id: r.video_gen_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function getById(db, id, cfg) {
  const r = db.prepare('SELECT * FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r, cfg) : null;
}

function create(db, log, req, cfg) {
  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO assets (drama_id, name, type, category, url, local_path, file_size, mime_type, width, height, duration, image_gen_id, video_gen_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.drama_id ?? null,
    req.name || '未命名',
    req.type || 'image',
    req.category ?? null,
    req.url || '',
    req.local_path ?? null,
    req.file_size ?? null,
    req.mime_type ?? null,
    req.width ?? null,
    req.height ?? null,
    req.duration ?? null,
    req.image_gen_id ?? null,
    req.video_gen_id ?? null,
    now,
    now
  );
  return getById(db, info.lastInsertRowid, cfg);
}

function update(db, log, id, req, cfg) {
  if (req.name !== undefined) { req = { ...req, name: String(req.name).trim() }; if (!req.name || req.name.length > 240) throw new Error("素材名称需要1到240个字符"); }
  const row = db.prepare('SELECT id FROM assets WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) return null;
  const updates = [];
  const params = [];
  ['name', 'description', 'type', 'category', 'url', 'local_path', 'thumbnail_url', 'file_size', 'mime_type', 'width', 'height', 'duration', 'is_favorite'].forEach((key) => {
    if (req[key] !== undefined) {
      updates.push(key + ' = ?');
      params.push(req[key]);
    }
  });
  if (updates.length === 0) return getById(db, id, cfg);
  params.push(new Date().toISOString(), id);
  db.prepare('UPDATE assets SET ' + updates.join(', ') + ', updated_at = ? WHERE id = ?').run(...params);
  return getById(db, id, cfg);
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE assets SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

function localFileMetadata(localPath, cfg) {
  if (!localPath) return null;
  try {
    const config = cfg || require('../config').loadConfig();
    const root = fs.realpathSync(path.resolve(config.storage?.local_path || './data/storage'));
    const relative = String(localPath).replace(/\\/g, '/').replace(/^\/?static\//, '');
    if (path.isAbsolute(relative)) return null;
    const file = fs.realpathSync(path.resolve(root, relative));
    const rel = path.relative(root, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 ? { path: file, size: stat.size } : null;
  } catch (_) { return null; }
}

function importGeneration(db, log, id, type, cfg) {
  const table = type === 'video' ? 'video_generations' : 'image_generations';
  const foreignKey = type === 'video' ? 'video_gen_id' : 'image_gen_id';
  return db.transaction(() => {
    const source = db.prepare(`SELECT * FROM ${table} WHERE id=? AND deleted_at IS NULL`).get(Number(id));
    if (!source) return null;
    const media = localFileMetadata(source.local_path, cfg);
    if (!media) throw new Error('媒体尚未保存到本机，请等待下载完成或重试下载');
    const existing = db.prepare(`SELECT id FROM assets WHERE ${foreignKey}=? AND deleted_at IS NULL ORDER BY id LIMIT 1`).get(Number(id));
    const values = { url: `/static/${String(source.local_path).replace(/\\/g, '/')}`, local_path: source.local_path, file_size: media.size, duration: source.duration ?? null };
    if (existing) return update(db, log, existing.id, values, cfg);
    return create(db, log, { ...values, drama_id: source.drama_id, name: `${type === 'video' ? '视频' : '图片'} ${id}`, type, [foreignKey]: Number(id) }, cfg);
  })();
}
function importFromImage(db, log, id, cfg) { return importGeneration(db, log, id, 'image', cfg); }
function importFromVideo(db, log, id, cfg) { return importGeneration(db, log, id, 'video', cfg); }

module.exports = {
  localFileMetadata,
  list,
  getById,
  create,
  update,
  deleteById,
  importFromImage,
  importFromVideo,
};
