'use strict';
// Agents often put a file from the user's disk (D:\photos\a.jpg, file:///...) straight into a canvas
// node. The media route only serves the workflow's storage folder, so such nodes showed a broken image.
// Those files are copied into storage/references (content-addressed, like the upload button) instead.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { fail } = require('./store');

const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'heic', 'mp4', 'mov', 'webm', 'mkv', 'm4v', 'avi', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']);

/** The absolute file a media field points to, or '' for storage-relative paths and web URLs. */
function localSource(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (/^file:\/\//i.test(s)) {
    try { return fileURLToPath(s); } catch (_) { return ''; }
  }
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s)) return path.win32.normalize(s);
  // "/static/..." and "/api/..." are this server's own URLs, not files.
  if (process.platform !== 'win32' && s.startsWith('/') && !/^\/(static|api)\//.test(s)) return s;
  return '';
}

const mediaExt = file => path.extname(file).slice(1).toLowerCase();

function hashFile(file) {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1 << 20);
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

/** Copies one local media file into <root>/references and returns its storage-relative path. */
function storeLocalFile(root, file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { stat = null; }
  if (!stat?.isFile() || !stat.size) throw fail('MEDIA_FILE_MISSING', `找不到本机文件：${file}`);
  const ext = mediaExt(file);
  if (!MEDIA_EXT.has(ext)) throw fail('MEDIA_TYPE_UNSUPPORTED', `画布只能放图片、视频或音频文件：${path.basename(file)}`);
  const relative = `references/${hashFile(file)}.${ext}`;
  const dest = path.join(root, relative);
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
    fs.copyFileSync(file, tmp);
    try { fs.renameSync(tmp, dest); } catch (e) { fs.rmSync(tmp, { force: true }); if (!fs.existsSync(dest)) throw e; }
  }
  return relative;
}

/** Rewrites node media that points at the user's disk to a copy inside storage. */
function importLocalMedia(operations, root) {
  if (!Array.isArray(operations)) return operations;
  return operations.map(op => {
    const media = op?.data?.media;
    if (!['add_node', 'update_node'].includes(op?.type) || !media || typeof media !== 'object' || Array.isArray(media)) return op;
    const source = localSource(media.local_path) || (!media.local_path ? localSource(media.url) : '');
    if (!source) return op;
    const relative = storeLocalFile(root, source);
    return { ...op, data: { ...op.data, media: { ...media, local_path: relative, url: `/static/${relative}`, source_path: source } } };
  });
}

/** Nodes saved before the import existed still hold an absolute path; serve it when it is a media file. */
function legacyLocalFile(value) {
  const file = localSource(value);
  if (!file || !MEDIA_EXT.has(mediaExt(file))) return null;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 ? { path: file, size: stat.size } : null;
  } catch (_) { return null; }
}

module.exports = { localSource, storeLocalFile, importLocalMedia, legacyLocalFile };
