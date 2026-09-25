const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { createHash } = require('node:crypto');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '[::1]']);

function explicitLocalPath(value) {
  const raw = String(value || '').trim();
  if (/^file:/i.test(raw)) return fileURLToPath(raw);
  if (/^https?:|^data:|^file_id:/i.test(raw) || /^[/\\]static[/\\]/i.test(raw)) return null;
  return path.isAbsolute(raw) ? path.normalize(raw) : null;
}

// Explicit user file paths can live anywhere. Media URLs still resolve inside
// storage: a URL must never turn into an unrelated absolute filesystem path.
function localReferencePath(raw, storageRoot) {
  let value = String(raw || '').trim();
  if (!value || /^(data:|file_id:)/i.test(value)) return null;
  const explicit = explicitLocalPath(value);
  if (explicit) return fs.existsSync(explicit) && fs.statSync(explicit).isFile() ? explicit : null;
  if (!storageRoot) return null;
  if (/^https?:\/\//i.test(value)) {
    const url = new URL(value);
    if (!LOCAL_HOSTS.has(url.hostname)) return null;
    value = url.pathname;
  }
  const staticIndex = value.indexOf('/static/');
  if (staticIndex >= 0) value = value.slice(staticIndex + 8);
  try { value = decodeURIComponent(value); } catch { /* literal path */ }
  const root = path.resolve(storageRoot);
  const candidate = path.resolve(root, value.replace(/^[/\\]+/, ''));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(candidate);
  return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
}

function importExplicitReference(value, storageRoot) {
  const source = explicitLocalPath(value);
  if (!source || !storageRoot) return value;
  const stat = fs.statSync(source); // Surface the actual missing/read error.
  if (!stat.isFile()) throw new Error(`参考素材不是文件：${source}`);
  const hash = createHash('sha256');
  const fd = fs.openSync(source, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  const extension = path.extname(source).toLowerCase();
  const suffix = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin';
  const relative = `imports/${hash.digest('hex')}${suffix}`;
  const destination = path.join(storageRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try { fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (fs.statSync(destination).size !== stat.size) throw new Error('已导入参考文件大小不一致');
  }
  return relative;
}

function importGenerationReferences(options = {}) {
  const result = { ...options };
  const cache = new Map();
  const convert = value => {
    if (typeof value !== 'string') return value;
    if (!cache.has(value)) cache.set(value, importExplicitReference(value, options.storage_local_path));
    return cache.get(value);
  };
  for (const key of ['image_url', 'first_frame_url', 'last_frame_url', 'first_frame_local_path', 'last_frame_local_path', 'voice_reference_url']) {
    if (result[key]) result[key] = convert(result[key]);
  }
  for (const key of ['reference_urls', 'reference_image_urls', 'reference_images', 'reference_video_urls', 'reference_audio_urls']) {
    if (Array.isArray(result[key])) result[key] = result[key].map(convert);
  }
  return result;
}

module.exports = { explicitLocalPath, localReferencePath, importExplicitReference, importGenerationReferences };
