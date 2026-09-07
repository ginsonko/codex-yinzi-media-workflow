const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const sharp = require('sharp');
const { storageRoot, resolveLocalMediaPath } = require('./productionMediaValidation');

const DEFAULT_DENSITY = 0.18;
const MIN_DENSITY = 0.02;
const MAX_DENSITY = 0.6;
const MODES = new Set(['line_grayscale', 'face_grid']);

function clampDensity(value) { const n = Number(value); return Number.isFinite(n) ? Math.max(MIN_DENSITY, Math.min(MAX_DENSITY, n)) : DEFAULT_DENSITY; }
function hashFile(filePath) { const hash = crypto.createHash('sha256'); hash.update(fs.readFileSync(filePath)); return hash.digest('hex'); }
function normalizeRegion(region) {
  if (!region || typeof region !== 'object') return { x: 0.25, y: 0.12, width: 0.5, height: 0.45, source: 'fallback_center_portrait' };
  const clamp = (v, fallback) => Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : fallback));
  const x = clamp(region.x, 0.25); const y = clamp(region.y, 0.12); const width = Math.min(1 - x, clamp(region.width, 0.5)); const height = Math.min(1 - y, clamp(region.height, 0.45));
  return { x, y, width, height, source: String(region.source || 'user_or_detector').slice(0, 80) };
}
function lineSvg(width, height, region, density, seed) {
  const count = Math.max(4, Math.min(180, Math.round(8 + density * 260)));
  let state = (Number(seed) >>> 0) || 1; const rand = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const x0 = region.x * width; const y0 = region.y * height; const x1 = (region.x + region.width) * width; const y1 = (region.y + region.height) * height;
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const y = y0 + rand() * Math.max(1, y1 - y0); const drift = (rand() - 0.5) * Math.max(12, width * 0.08); const endY = Math.max(y0, Math.min(y1, y + (rand() - 0.5) * Math.max(8, height * 0.12)));
    lines.push(`<path d="M ${Math.round(x0 - drift)} ${Math.round(y)} L ${Math.round(x1 + drift)} ${Math.round(endY)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><g fill="none" stroke="#d43b3b" stroke-width="${Math.max(1, Math.round(width / 360))}" stroke-linecap="round" opacity="0.8">${lines.join('')}</g></svg>`;
}
function normalizeMode(value) {
  const mode = String(value || 'line_grayscale').trim().toLowerCase();
  return MODES.has(mode) ? mode : 'line_grayscale';
}
async function faceGridBoard(image, width, height, region, seed) {
  const x = Math.max(0, Math.min(width - 1, Math.round(region.x * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(region.y * height)));
  const cropWidth = Math.max(9, Math.min(width - x, Math.round(region.width * width)));
  const cropHeight = Math.max(9, Math.min(height - y, Math.round(region.height * height)));
  const gutter = Math.max(4, Math.round(Math.min(width, height) / 80));
  const tile = Math.max(48, Math.min(512, Math.round(Math.min(cropWidth / 3, cropHeight / 3))));
  const canvasWidth = tile * 3 + gutter * 4;
  const canvasHeight = tile * 3 + gutter * 4;
  const crop = await image.clone().extract({ left: x, top: y, width: cropWidth, height: cropHeight }).png().toBuffer();
  const composites = [];
  let state = (Number(seed) >>> 0) || 1;
  const rand = () => { state = (1664525 * state + 1013904223) >>> 0; return state / 4294967296; };
  const cells = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const index = row * 3 + col + 1;
      const left = Math.floor(col * cropWidth / 3);
      const top = Math.floor(row * cropHeight / 3);
      const right = col === 2 ? cropWidth : Math.floor((col + 1) * cropWidth / 3);
      const bottom = row === 2 ? cropHeight : Math.floor((row + 1) * cropHeight / 3);
      const tileWidth = Math.max(1, right - left);
      const tileHeight = Math.max(1, bottom - top);
      composites.push({
        input: await sharp(crop).extract({ left, top, width: tileWidth, height: tileHeight }).resize(tile, tile, { fit: 'cover' }).png().toBuffer(),
        left: gutter + col * (tile + gutter),
        top: gutter + row * (tile + gutter),
      });
      cells.push({ index, row, column: col, source_x: left / cropWidth, source_y: top / cropHeight, source_width: tileWidth / cropWidth, source_height: tileHeight / cropHeight, jitter: Math.round(rand() * 1000) / 1000 });
    }
  }
  const output = await sharp({ create: { width: canvasWidth, height: canvasHeight, channels: 3, background: { r: 235, g: 235, b: 235 } } }).composite(composites).png().toBuffer();
  return { output, width: canvasWidth, height: canvasHeight, grid: { rows: 3, columns: 3, cells, source_region: region, reconstructed: false } };
}
function sourceFile(cfg, mediaPath) {
  const resolved = resolveLocalMediaPath(cfg, String(mediaPath || ''));
  if (!resolved?.absolute_path || !fs.existsSync(resolved.absolute_path)) throw Object.assign(new Error('源图片不存在或不在本地素材目录内'), { code: 'PRIVACY_SOURCE_MISSING' });
  return resolved;
}
async function derive(db, cfg, input = {}) {
  const source = sourceFile(cfg, input.source_media_path || input.media_path);
  const density = clampDensity(input.density); const seed = Number.isInteger(Number(input.seed)) ? Number(input.seed) : crypto.randomInt(1, 0x7fffffff); const region = normalizeRegion(input.face_region); const mode = normalizeMode(input.mode);
  const image = sharp(source.absolute_path); const metadata = await image.metadata(); const width = metadata.width || 1024; const height = metadata.height || 1024; const sourceHash = hashFile(source.absolute_path);
  const relative = path.join('privacy', `${sourceHash.slice(0, 16)}-${mode}-d${Math.round(density * 1000)}-s${seed}.png`).replace(/\\/g, '/'); const root = storageRoot(cfg); const target = path.resolve(root, relative); const rel = path.relative(root, target); if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('派生图片路径无效'), { code: 'PRIVACY_TARGET_INVALID' });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let grid = null;
  if (mode === 'face_grid') {
    const board = await faceGridBoard(image, width, height, region, seed); grid = board.grid;
    await sharp(board.output).png().toFile(target);
  } else {
    await image.grayscale().composite([{ input: Buffer.from(lineSvg(width, height, region, density, seed)), blend: 'over' }]).png().toFile(target);
  }
  const now = new Date().toISOString(); const result = db.prepare('INSERT INTO privacy_derivations (source_media_path,source_sha256,derived_media_path,density,seed,face_region_json,detection_mode,detection_confidence,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(source.relative_path, sourceHash, relative, density, seed, JSON.stringify(region), region.source === 'fallback_center_portrait' ? 'fallback_center_portrait' : 'user_or_detector', region.source === 'fallback_center_portrait' ? 0.25 : 0.7, now);
  db.prepare('UPDATE privacy_derivations SET mode = ?, grid_json = ? WHERE id = ?').run(mode, grid ? JSON.stringify(grid) : null, Number(result.lastInsertRowid));
  return { id: Number(result.lastInsertRowid), source_media_path: source.relative_path, source_sha256: sourceHash, derived_media_path: relative, derived_media_url: `/static/${relative}`, density, seed, mode, face_region: region, grid, detection_confidence: region.source === 'fallback_center_portrait' ? 0.25 : 0.7, reversible: true, source_preserved: true, notice: mode === 'face_grid' ? '已生成九宫格面部细节参考板；未重建完整脸部，原图未改动。' : '这是本地可逆的真人素材隐私派生，不保证或承诺上游审核结果。' };
}
function list(db, query = {}) { const rows = db.prepare('SELECT * FROM privacy_derivations WHERE deleted_at IS NULL ORDER BY id DESC LIMIT ?').all(Math.min(100, Math.max(1, Number(query.limit) || 50))); return rows.map((row) => ({ ...row, mode: row.mode || 'line_grayscale', face_region: row.face_region_json ? JSON.parse(row.face_region_json) : null, grid: row.grid_json ? JSON.parse(row.grid_json) : null, derived_media_url: `/static/${row.derived_media_path}` })); }
function remove(db, cfg, id) { const row = db.prepare('SELECT * FROM privacy_derivations WHERE id = ? AND deleted_at IS NULL').get(Number(id)); if (!row) throw Object.assign(new Error('派生图片不存在'), { code: 'PRIVACY_DERIVATION_NOT_FOUND' }); const file = path.resolve(storageRoot(cfg), row.derived_media_path); const rel = path.relative(storageRoot(cfg), file); if (!rel.startsWith('..') && !path.isAbsolute(rel)) { try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (_) {} } db.prepare('UPDATE privacy_derivations SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), row.id); return { id: row.id, deleted: true, source_preserved: true };
}
module.exports = { derive, list, remove, clampDensity, normalizeRegion, normalizeMode, faceGridBoard };
