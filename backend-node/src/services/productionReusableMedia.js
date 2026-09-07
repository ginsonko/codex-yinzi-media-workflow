const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { storageRoot, resolveLocalMediaPath } = require('./productionMediaValidation');

const MAX_REUSABLE_MEDIA_BYTES = 1024 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/i;
const ALLOWED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.webm', '.mov', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac', '.flac',
]);

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function digest(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function artifactReceipt(artifact) {
  const validation = artifact?.content?.validation && typeof artifact.content.validation === 'object'
    ? artifact.content.validation
    : {};
  const absolutePath = validation.absolute_path || validation.absolutePath || null;
  const recordedRoot = validation.storage_root || validation.storageRoot || null;
  const expectedHash = String(validation.sha256 || artifact?.content_hash || '').trim().toLowerCase();
  return { validation, absolutePath, recordedRoot, expectedHash };
}

function safeExtension(artifact, sourcePath) {
  const fromPath = path.extname(String(sourcePath || '')).toLowerCase();
  if (ALLOWED_EXTENSIONS.has(fromPath)) return fromPath;
  const mime = String(artifact?.mime_type || '').toLowerCase();
  const byMime = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/mp4': '.m4a',
  };
  return byMime[mime] || '.bin';
}

function currentFile(cfg, mediaPath) {
  if (!mediaPath) return null;
  try {
    return resolveLocalMediaPath(cfg, mediaPath);
  } catch (_) {
    return null;
  }
}

function historicalFile(artifact) {
  const { absolutePath, recordedRoot, expectedHash } = artifactReceipt(artifact);
  if (!absolutePath || !recordedRoot) return { available: false, reason: 'missing_media_receipt' };
  if (!SHA256.test(expectedHash)) return { available: false, reason: 'missing_media_digest' };
  if (!path.isAbsolute(String(recordedRoot)) || !path.isAbsolute(String(absolutePath))) {
    return { available: false, reason: 'media_receipt_path_not_absolute' };
  }
  let root;
  let candidate;
  try { root = fs.realpathSync.native(String(recordedRoot)); }
  catch (_) { return { available: false, reason: 'source_root_missing' }; }
  try { candidate = fs.realpathSync.native(String(absolutePath)); }
  catch (_) { return { available: false, reason: 'source_file_missing' }; }
  if (!inside(root, candidate)) return { available: false, reason: 'media_receipt_outside_root' };
  let stat;
  try { stat = fs.statSync(candidate); } catch (_) { return { available: false, reason: 'source_file_missing' }; }
  if (!stat.isFile()) return { available: false, reason: 'source_not_regular_file' };
  if (stat.size <= 0 || stat.size > MAX_REUSABLE_MEDIA_BYTES) {
    return { available: false, reason: 'source_file_too_large_or_empty' };
  }
  return { available: true, source_path: candidate, source_root: root, bytes: stat.size, expected_hash: expectedHash };
}

function publicPath(relativePath) {
  return `/static/${String(relativePath || '').replace(/^\/+/, '').replace(/\\/g, '/')}`;
}

function inspectArtifactMedia(cfg, artifact) {
  const originalPath = artifact?.media_path || null;
  const current = currentFile(cfg, originalPath);
  if (current) {
    return {
      available: true,
      ready: true,
      media_path: current.relative_path,
      media_url: publicPath(current.relative_path),
      original_media_path: originalPath,
      availability_reason: null,
      source_kind: 'current_storage',
    };
  }
  const historical = historicalFile(artifact);
  if (!historical.available) {
    return {
      available: false,
      ready: false,
      media_path: originalPath,
      media_url: null,
      original_media_path: originalPath,
      availability_reason: historical.reason,
      source_kind: 'unavailable',
    };
  }
  return {
    available: true,
    ready: false,
    media_path: originalPath,
    media_url: null,
    original_media_path: originalPath,
    availability_reason: 'needs_materialization',
    source_kind: 'historical_storage',
  };
}

function targetFor(cfg, artifact, sourcePath, hash) {
  const root = storageRoot(cfg);
  const extension = safeExtension(artifact, sourcePath);
  const directory = path.join(root, 'reusable', hash);
  const target = path.join(directory, `${hash}${extension}`);
  if (!inside(root, directory) || !inside(root, target)) throw fail('MEDIA_CACHE_PATH_INVALID', '历史媒体缓存路径无效');
  return { root, directory, target, relative: path.relative(root, target).replace(/\\/g, '/') };
}

async function verifyCached(target, expectedHash, expectedBytes) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size !== expectedBytes) return false;
    return await digest(target) === expectedHash;
  } catch (_) {
    return false;
  }
}

async function materializeArtifactMedia(cfg, artifact) {
  const current = currentFile(cfg, artifact?.media_path);
  if (current) {
    const stat = fs.statSync(current.absolute_path);
    return {
      available: true, ready: true, source_kind: 'current_storage',
      media_path: current.relative_path, media_url: publicPath(current.relative_path),
      original_media_path: artifact.media_path, bytes: stat.size,
      sha256: artifact.content_hash || null,
    };
  }

  const historical = historicalFile(artifact);
  if (!historical.available) throw fail('REUSABLE_MEDIA_UNAVAILABLE', '历史媒体无法验证或来源文件不存在');
  const actualHash = await digest(historical.source_path);
  if (actualHash !== historical.expected_hash) {
    throw fail('REUSABLE_MEDIA_DIGEST_MISMATCH', '历史媒体校验失败，未复制或提交');
  }
  const target = targetFor(cfg, artifact, historical.source_path, actualHash);
  fs.mkdirSync(target.directory, { recursive: true });

  if (!(await verifyCached(target.target, actualHash, historical.bytes))) {
    const temporary = `${target.target}.tmp-${crypto.randomUUID()}`;
    try {
      fs.copyFileSync(historical.source_path, temporary, fs.constants.COPYFILE_EXCL);
      if (!(await verifyCached(temporary, actualHash, historical.bytes))) {
        throw fail('MEDIA_CACHE_VERIFY_FAILED', '历史媒体缓存校验失败');
      }
      try {
        fs.renameSync(temporary, target.target);
      } catch (error) {
        if (!fs.existsSync(target.target)) throw error;
        if (!(await verifyCached(target.target, actualHash, historical.bytes))) throw error;
        try { fs.unlinkSync(temporary); } catch (_) {}
      }
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch (_) {}
    }
  }

  return {
    available: true, ready: true, source_kind: 'historical_storage',
    media_path: target.relative, media_url: publicPath(target.relative),
    original_media_path: artifact.media_path, bytes: historical.bytes, sha256: actualHash,
  };
}

module.exports = {
  MAX_REUSABLE_MEDIA_BYTES,
  inspectArtifactMedia,
  materializeArtifactMedia,
  historicalFile,
};
