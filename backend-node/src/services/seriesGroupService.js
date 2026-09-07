const crypto = require('node:crypto');
const repo = require('./productionRepository');

function nowIso() { return new Date().toISOString(); }
function parse(value, fallback = {}) { try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; } }
function getGroup(db, id) {
  const row = db.prepare('SELECT * FROM series_groups WHERE id = ? AND archived_at IS NULL').get(Number(id));
  if (!row) return null;
  const episodes = db.prepare('SELECT * FROM series_group_episodes WHERE series_group_id = ? ORDER BY drama_id, episode_id').all(row.id);
  const assets = db.prepare(`SELECT a.*, v.version AS current_version, v.content_json AS current_content, v.content_hash AS current_hash
    FROM series_assets a LEFT JOIN series_asset_versions v ON v.id = a.current_version_id WHERE a.series_group_id = ? ORDER BY a.asset_type, a.asset_key`).all(row.id)
    .map((item) => ({ ...item, current_content: parse(item.current_content), versions: db.prepare('SELECT * FROM series_asset_versions WHERE series_asset_id = ? ORDER BY version DESC').all(item.id).map((v) => ({ ...v, content: parse(v.content_json) })) }));
  return { ...row, metadata: parse(row.metadata_json), episodes, assets };
}
function listGroups(db, query = {}) {
  const page = Math.max(1, Number(query.page) || 1); const size = Math.min(100, Math.max(1, Number(query.page_size) || 20));
  const total = db.prepare('SELECT COUNT(*) AS n FROM series_groups WHERE archived_at IS NULL').get().n;
  const rows = db.prepare('SELECT * FROM series_groups WHERE archived_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(size, (page - 1) * size);
  return { items: rows.map((row) => getGroup(db, row.id)), pagination: { page, page_size: size, total, total_pages: Math.ceil(total / size) } };
}
function createGroup(db, input = {}) {
  const name = String(input.name || '').trim(); if (!name) throw Object.assign(new Error('剧集组名称不能为空'), { code: 'SERIES_GROUP_NAME_REQUIRED' });
  const now = nowIso(); const info = db.prepare('INSERT INTO series_groups (name,description,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?)').run(name, String(input.description || '').slice(0, 2000), JSON.stringify(input.metadata || {}), now, now);
  return getGroup(db, info.lastInsertRowid);
}
function addEpisode(db, groupId, input = {}) {
  if (!getGroup(db, groupId)) throw Object.assign(new Error('剧集组不存在'), { code: 'SERIES_GROUP_NOT_FOUND' });
  const dramaId = Number(input.drama_id); if (!Number.isInteger(dramaId) || dramaId <= 0) throw Object.assign(new Error('drama_id 无效'), { code: 'SERIES_EPISODE_INVALID' });
  const now = nowIso(); db.prepare('INSERT OR IGNORE INTO series_group_episodes (series_group_id,drama_id,episode_id,created_at) VALUES (?,?,?,?)').run(Number(groupId), dramaId, input.episode_id == null ? null : Number(input.episode_id), now);
  return getGroup(db, groupId);
}
function upsertAsset(db, groupId, input = {}) {
  if (!getGroup(db, groupId)) throw Object.assign(new Error('剧集组不存在'), { code: 'SERIES_GROUP_NOT_FOUND' });
  const key = String(input.asset_key || input.key || '').trim(); const type = String(input.asset_type || input.type || 'unknown').trim();
  if (!key || !type) throw Object.assign(new Error('asset_key 与 asset_type 必填'), { code: 'SERIES_ASSET_INVALID' });
  const now = nowIso(); let asset = db.prepare('SELECT * FROM series_assets WHERE series_group_id = ? AND asset_key = ?').get(Number(groupId), key);
  const tx = db.transaction(() => {
    if (!asset) { const info = db.prepare('INSERT INTO series_assets (series_group_id,asset_key,asset_type,title,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(Number(groupId), key, type, String(input.title || key).slice(0, 240), now, now); asset = db.prepare('SELECT * FROM series_assets WHERE id = ?').get(info.lastInsertRowid); }
    const previous = db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM series_asset_versions WHERE series_asset_id = ?').get(asset.id).version;
    const content = input.content && typeof input.content === 'object' ? input.content : {};
    const hash = crypto.createHash('sha256').update(JSON.stringify(content)).digest('hex');
    const info = db.prepare('INSERT INTO series_asset_versions (series_asset_id,version,content_json,source_artifact_id,content_hash,created_at) VALUES (?,?,?,?,?,?)').run(asset.id, Number(previous) + 1, JSON.stringify(content), input.source_artifact_id == null ? null : Number(input.source_artifact_id), hash, now);
    db.prepare('UPDATE series_assets SET current_version_id = ?, title = ?, updated_at = ? WHERE id = ?').run(info.lastInsertRowid, String(input.title || asset.title || key).slice(0, 240), now, asset.id);
  }); tx.immediate(); return getGroup(db, groupId);
}
function reuseAsset(db, groupId, input = {}) {
  const asset = db.prepare('SELECT * FROM series_assets WHERE id = ? AND series_group_id = ?').get(Number(input.series_asset_id), Number(groupId));
  if (!asset) throw Object.assign(new Error('剧集资产不存在'), { code: 'SERIES_ASSET_NOT_FOUND' });
  const versionId = Number(input.series_asset_version_id || asset.current_version_id); const version = db.prepare('SELECT * FROM series_asset_versions WHERE id = ? AND series_asset_id = ?').get(versionId, asset.id);
  if (!version) throw Object.assign(new Error('剧集资产版本不存在'), { code: 'SERIES_ASSET_VERSION_NOT_FOUND' });
  const dramaId = Number(input.drama_id); if (!Number.isInteger(dramaId) || dramaId <= 0) throw Object.assign(new Error('drama_id 无效'), { code: 'SERIES_EPISODE_INVALID' });
  db.prepare('INSERT OR IGNORE INTO episode_asset_refs (series_asset_id,series_asset_version_id,drama_id,episode_id,mode,created_at) VALUES (?,?,?,?,?,?)').run(asset.id, version.id, dramaId, input.episode_id == null ? null : Number(input.episode_id), 'reuse', nowIso());
  return { asset: { ...asset, version: { ...version, content: parse(version.content_json) } }, reference: db.prepare('SELECT * FROM episode_asset_refs WHERE series_asset_id = ? AND series_asset_version_id = ? AND drama_id = ? AND IFNULL(episode_id,0) = IFNULL(?,0)').get(asset.id, version.id, dramaId, input.episode_id == null ? null : Number(input.episode_id)) };
}
function forkAsset(db, groupId, input = {}) {
  const asset = db.prepare('SELECT * FROM series_assets WHERE id = ? AND series_group_id = ?').get(Number(input.series_asset_id), Number(groupId));
  if (!asset) throw Object.assign(new Error('剧集资产不存在'), { code: 'SERIES_ASSET_NOT_FOUND' });
  const versionId = Number(input.series_asset_version_id || asset.current_version_id); const version = db.prepare('SELECT * FROM series_asset_versions WHERE id = ? AND series_asset_id = ?').get(versionId, asset.id);
  if (!version) throw Object.assign(new Error('剧集资产版本不存在'), { code: 'SERIES_ASSET_VERSION_NOT_FOUND' });
  return upsertAsset(db, groupId, { asset_key: input.new_asset_key || `${asset.asset_key}:fork:${Date.now()}`, asset_type: asset.asset_type, title: input.title || `${asset.title}（副本）`, content: input.content || parse(version.content_json), source_artifact_id: input.source_artifact_id });
}
function listReusableAssets(db, groupId, query = {}) {
  const group = getGroup(db, groupId); if (!group) return null;
  const type = query.asset_type || query.type; return { group_id: Number(groupId), items: group.assets.filter((asset) => !type || asset.asset_type === type).map((asset) => ({ id: asset.id, asset_key: asset.asset_key, asset_type: asset.asset_type, title: asset.title, current_version_id: asset.current_version_id, current_version: asset.current_version, content: asset.current_content, content_hash: asset.current_hash })) };
}

function findEpisodeGroup(db, dramaId, episodeId = null) {
  const row = db.prepare(`SELECT series_group_id FROM series_group_episodes
    WHERE drama_id = ? AND IFNULL(episode_id, 0) = IFNULL(?, 0)
    ORDER BY created_at DESC LIMIT 1`).get(Number(dramaId), episodeId == null ? null : Number(episodeId));
  return row ? getGroup(db, row.series_group_id) : null;
}

function listEpisodeReferences(db, dramaId, episodeId = null) {
  return db.prepare(`SELECT r.*, a.asset_key, a.asset_type, a.title, v.version, v.content_json, v.content_hash, v.source_artifact_id
    FROM episode_asset_refs r
    JOIN series_assets a ON a.id = r.series_asset_id
    JOIN series_asset_versions v ON v.id = r.series_asset_version_id
    WHERE r.drama_id = ? AND IFNULL(r.episode_id, 0) = IFNULL(?, 0)
    ORDER BY a.asset_type, a.asset_key`).all(Number(dramaId), episodeId == null ? null : Number(episodeId))
    .map((row) => ({ ...row, content: parse(row.content_json), content_json: undefined }));
}

/**
 * Stable, path-free context for text generation. Reuse candidates are advice;
 * only explicit episode refs are treated as selected assets.
 */
function buildGenerationContext(db, run) {
  if (!run?.drama_id) return { group: null, selected: [], candidates: [] };
  const group = findEpisodeGroup(db, run.drama_id, run.episode_id);
  if (!group) return { group: null, selected: [], candidates: [] };
  const selected = listEpisodeReferences(db, run.drama_id, run.episode_id).map((item) => ({
    series_asset_id: item.series_asset_id,
    version_id: item.series_asset_version_id,
    version: item.version,
    asset_key: item.asset_key,
    asset_type: item.asset_type,
    title: item.title,
    content: item.content,
    content_hash: item.content_hash,
    selected: true,
  }));
  const selectedIds = new Set(selected.map((item) => item.version_id));
  const candidates = group.assets.map((asset) => ({
    series_asset_id: asset.id,
    version_id: asset.current_version_id,
    version: asset.current_version,
    asset_key: asset.asset_key,
    asset_type: asset.asset_type,
    title: asset.title,
    content: asset.current_content,
    content_hash: asset.current_hash,
    selected: selectedIds.has(asset.current_version_id),
  }));
  return { group: { id: group.id, name: group.name, description: group.description }, selected, candidates };
}

module.exports = { getGroup, listGroups, createGroup, addEpisode, upsertAsset, reuseAsset, forkAsset, listReusableAssets, findEpisodeGroup, listEpisodeReferences, buildGenerationContext };
