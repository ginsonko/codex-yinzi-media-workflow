'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/**
 * Calculates SHA-256 digest of a local file.
 */
async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/**
 * Safe process runner with timeout and array args (zero shell expansion).
 */
function runProcess(bin, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(fail('PROBE_TIMEOUT', `探针执行超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        reject(fail('PROBE_FAILED', `探针执行失败 (${code}): ${stderr.slice(-500)}`));
      }
    });
  });
}

/**
 * Maps extension to general category.
 */
const EXTENSION_MAP = {
  // Video
  mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video', flv: 'video', wmv: 'video',
  // Audio
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio', wma: 'audio',
  // Image
  jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', bmp: 'image', tiff: 'image', avif: 'image',
  // Document
  pdf: 'document', txt: 'document', md: 'document', json: 'document', csv: 'document', srt: 'document', vtt: 'document'
};

const MIME_MAP = {
  mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', m4a: 'audio/mp4',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', tiff: 'image/tiff',
  pdf: 'application/pdf', txt: 'text/plain', json: 'application/json', md: 'text/markdown', srt: 'application/x-subrip', vtt: 'text/vtt'
};

/**
 * Probes media file with ffprobe to extract technical container and stream details.
 */
async function probeMediaWithFfprobe(ffprobeBin, filePath) {
  try {
    const res = await runProcess(ffprobeBin, [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      filePath
    ], 20000);

    const data = JSON.parse(res.stdout);
    const format = data.format || {};
    const streams = data.streams || [];

    const videoStream = streams.find(s => s.codec_type === 'video');
    const audioStreams = streams.filter(s => s.codec_type === 'audio');

    return {
      success: true,
      container_format: format.format_name || null,
      duration_seconds: format.duration ? Number(format.duration) : null,
      bit_rate: format.bit_rate ? Number(format.bit_rate) : null,
      video: videoStream ? {
        codec: videoStream.codec_name,
        width: videoStream.width || null,
        height: videoStream.height || null,
        fps: parseFps(videoStream.r_frame_rate || videoStream.avg_frame_rate),
        pix_fmt: videoStream.pix_fmt || null
      } : null,
      audio: audioStreams.map(a => ({
        codec: a.codec_name,
        channels: a.channels,
        sample_rate: a.sample_rate ? Number(a.sample_rate) : null,
        bit_rate: a.bit_rate ? Number(a.bit_rate) : null
      }))
    };
  } catch (err) {
    return {
      success: false,
      corrupted: true,
      error_code: err.code || 'PROBE_FAILED',
      error_message: err.message
    };
  }
}

/**
 * Probes image file with sharp to extract dimensions and color space.
 */
async function probeImageWithSharp(sharpModule, filePath) {
  try {
    const img = sharpModule(filePath, { failOn: 'error', limitInputPixels: 100000000 });
    const meta = await img.metadata();
    await img.resize({ width:32, height:32, fit:'inside' }).raw().toBuffer();
    return {
      success: true,
      width: meta.width || null,
      height: meta.height || null,
      format: meta.format || null,
      channels: meta.channels || null,
      space: meta.space || null,
      has_alpha: meta.hasAlpha || false
    };
  } catch (err) {
    return {
      success: false,
      corrupted: true,
      error_code: err.code || 'IMAGE_PROBE_FAILED',
      error_message: err.message
    };
  }
}

function parseFps(str) {
  if (!str) return null;
  const parts = str.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    return den > 0 ? Math.round((num / den) * 1000) / 1000 : null;
  }
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

/**
 * Bounded file traverser that honours symlink restrictions, depth bounds, and maximum files.
 * Implements cycle detection via visited real paths (realpath).
 * Strictly read-only: NEVER deletes or modifies source files.
 */
function normalizeReal(p) {
  return path.resolve(p);
}

function isInsideRoots(realPath, authorizedRoots) {
  if (!authorizedRoots || authorizedRoots.length === 0) return true;
  const target = normalizeReal(realPath);
  return authorizedRoots.some(root => {
    const rel = path.relative(normalizeReal(root), target);
    return rel === '' || (rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

function traverseDirectory(rootDir, options = {}, state = { count: 0, visitedRealPaths: new Set() }) {
  const {
    maxDepth = 10,
    maxFiles = 2000,
    followSymlinks = false,
    includeKinds = ['video', 'audio', 'image', 'document'],
    currentDepth = 0,
    authorizedRoots = null
  } = options;

  if (currentDepth > maxDepth || state.count >= maxFiles) {
    return [];
  }

  // Cycle detection: track real physical directory path
  let realDir;
  try {
    realDir = fs.realpathSync(rootDir);
    if (state.visitedRealPaths.has(realDir)) {
      return [];
    }
    if (!isInsideRoots(realDir, authorizedRoots)) {
      return [];
    }
    state.visitedRealPaths.add(realDir);
  } catch {
    return [];
  }

  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    // Inaccessible directory, return empty
    return [];
  }

  for (const entry of entries) {
    if (state.count >= maxFiles) break;

    const fullPath = path.join(rootDir, entry.name);

    // Filter dangerous / ignored patterns
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name.startsWith('$RECYCLE.BIN') || entry.name === 'System Volume Information') {
      continue;
    }

    let isLink = entry.isSymbolicLink();
    if (isLink && !followSymlinks) {
      continue; // Strictly ignore symlinks/reparse points by default
    }

    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    let realTarget = fullPath;

    if (isLink && followSymlinks) {
      try {
        realTarget = fs.realpathSync(fullPath);
        if (!isInsideRoots(realTarget, authorizedRoots)) {
          continue;
        }
        const stat = fs.statSync(fullPath);
        isDirectory = stat.isDirectory();
        isFile = stat.isFile();
      } catch {
        continue;
      }
    }

    if (isDirectory) {
      const sub = traverseDirectory(fullPath, { ...options, currentDepth: currentDepth + 1 }, state);
      results.push(...sub);
    } else if (isFile) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      const kind = EXTENSION_MAP[ext] || 'other';

      if (includeKinds.includes(kind)) {
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            path: fullPath,
            name: entry.name,
            ext,
            kind,
            mime: MIME_MAP[ext] || 'application/octet-stream',
            size: stat.size,
            mtime_ms: stat.mtimeMs,
            ctime_ms: stat.ctimeMs
          });
          state.count++;
        } catch {
          // File unreadable or disappeared
        }
      }
    }
  }

  return results;
}

/**
 * Main executor contract function for local.media.index.
 * Conforms to executeNative({ inputPath, outputPath, parameters, components, report, sources })
 */
async function executeIndex({ inputPath, outputPath, parameters = {}, components = {}, report = () => {}, sharp = null }) {
  if (!inputPath || !fs.existsSync(inputPath)) {
    throw fail('INPUT_MISSING', '索引授权根目录清单文件不存在');
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw fail('INVALID_MANIFEST_JSON', `清单 JSON 解析失败: ${err.message}`);
  }

  const roots = Array.isArray(manifest) ? manifest : manifest.roots;
  if (!Array.isArray(roots) || roots.length === 0) {
    throw fail('EMPTY_ROOTS', '清单必须包含至少 1 个待索引的根目录路径');
  }

  const maxFiles = Math.max(1, Math.min(parameters.max_files || 2000, 10000));
  const maxDepth = Math.max(1, Math.min(parameters.max_depth || 10, 20));
  const followSymlinks = Boolean(parameters.follow_symlinks);
  const computeSha256 = parameters.compute_sha256 !== false;
  const probeMedia = parameters.probe_media !== false;
  const includeKinds = parameters.include_kinds || ['video', 'audio', 'image', 'document'];

  const ffprobeBin = components['media.ffmpeg']?.executables?.ffprobe;
  const sharpModule = sharp;

  // Load existing cache if provided for incremental resume
  const cachePath = parameters.cache_path ? path.resolve(parameters.cache_path) : null;
  const cacheMap = new Map();
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const cachedData = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      for (const item of cachedData.files || []) {
        cacheMap.set(item.path, item);
      }
    } catch {}
  }

  report({ stage: 'traversing', message: '正在扫描授权目录树' });

  const traversed = [];
  const state = { count: 0, visitedRealPaths: new Set() };

  for (const rootItem of roots) {
    const rootPath = typeof rootItem === 'string' ? rootItem : rootItem.path;
    if (!rootPath || !fs.existsSync(rootPath) || !fs.statSync(rootPath).isDirectory()) throw fail('INDEX_ROOT_MISSING', '索引目录不存在或不是文件夹，请核对输入 roots');
    let authorizedReal = null;
    try {
      authorizedReal = fs.realpathSync(rootPath);
    } catch (err) {
      throw fail('INDEX_ROOT_UNREADABLE', `无法读取索引目录：${err.message}`);
    }
    const files = traverseDirectory(rootPath, {
      maxDepth,
      maxFiles,
      followSymlinks,
      includeKinds,
      authorizedRoots: [authorizedReal]
    }, state);
    traversed.push(...files);
    if (state.count >= maxFiles) break;
  }

  report({ stage: 'indexing', total_files: traversed.length, message: `已发现 ${traversed.length} 个候选文件，正在提取技术元数据与去重` });

  const shaMap = new Map(); // sha256 -> canonical file entry
  const indexedFiles = [];
  const duplicateReferences = [];
  let corruptedCount = 0;
  let reusedCacheCount = 0;

  for (let idx = 0; idx < traversed.length; idx++) {
    const file = traversed[idx];
    const fileId = `file_${crypto.createHash('sha256').update(file.path).digest('hex').slice(0, 12)}`;

    if (idx % 20 === 0) {
      report({ stage: 'processing', current: idx + 1, total: traversed.length, path: file.path });
    }

    // Check incremental cache hit
    const cached = cacheMap.get(file.path);
    let sha = null;
    let techMeta = null;
    let isCorrupted = false;

    if (cached && cached.size === file.size && cached.mtime_ms === file.mtime_ms && cached.ctime_ms === file.ctime_ms
        && (!computeSha256 || cached.sha256) && (!probeMedia || file.kind === 'document' || cached.technical_metadata)) {
      sha = cached.sha256;
      techMeta = cached.technical_metadata;
      isCorrupted = Boolean(cached.corrupted);
      reusedCacheCount++;
    } else {
      if (computeSha256) {
        try {
          sha = await sha256File(file.path);
        } catch (err) {
          isCorrupted = true;
          techMeta = { error: err.message };
        }
      }

      if (!isCorrupted && probeMedia) {
        if ((file.kind === 'video' || file.kind === 'audio') && ffprobeBin) {
          const probeRes = await probeMediaWithFfprobe(ffprobeBin, file.path);
          techMeta = probeRes;
          if (probeRes.corrupted) isCorrupted = true;
        } else if (file.kind === 'image' && sharpModule) {
          const probeRes = await probeImageWithSharp(sharpModule, file.path);
          techMeta = probeRes;
          if (probeRes.corrupted) isCorrupted = true;
        }
      }
    }

    if (isCorrupted) {
      corruptedCount++;
    }

    const entry = {
      id: fileId,
      path: file.path,
      name: file.name,
      ext: file.ext,
      kind: file.kind,
      mime: file.mime,
      size: file.size,
      mtime_ms: file.mtime_ms,
      ctime_ms: file.ctime_ms,
      sha256: sha,
      corrupted: isCorrupted,
      technical_metadata: techMeta,
      is_duplicate: false
    };

    if (sha && shaMap.has(sha)) {
      const canonical = shaMap.get(sha);
      entry.is_duplicate = true;
      entry.duplicate_of = canonical.id;
      duplicateReferences.push({
        duplicate_id: entry.id,
        duplicate_path: entry.path,
        canonical_id: canonical.id,
        canonical_path: canonical.path,
        sha256: sha,
        size: entry.size
      });
    } else if (sha) {
      shaMap.set(sha, entry);
    }

    indexedFiles.push(entry);
  }

  const result = {
    schema_version: 1,
    summary: {
      total_indexed: indexedFiles.length,
      unique_content_count: shaMap.size,
      duplicate_count: duplicateReferences.length,
      corrupted_count: corruptedCount,
      cache_reused_count: reusedCacheCount,
      truncated: state.count >= maxFiles
    },
    duplicates: duplicateReferences,
    files: indexedFiles,
    indexed_at: new Date().toISOString()
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf8');

  return {
    summary: result.summary,
    total_files: indexedFiles.length,
    output_path: outputPath,
    technical_status: 'passed',
    quality_status: corruptedCount > 0 ? 'review_required' : 'passed',
    quality_note: `索引完成：收录 ${indexedFiles.length} 个文件，唯一内容 ${shaMap.size} 项，重复引用 ${duplicateReferences.length} 项（源文件已全部保留）。技术规格已提取，语义与高光由下游组合。`
  };
}

module.exports = {
  id: 'local.media.index',
  title: '有界可恢复本地媒体去重索引',
  kind: 'document',
  output_extension: 'json',
  component_id: null,
  additional_components: ['media.ffmpeg', 'media.sharp'],
  defaults: {
    max_files: 2000,
    max_depth: 10,
    follow_symlinks: false,
    compute_sha256: true,
    probe_media: true,
    include_kinds: ['video', 'audio', 'image', 'document']
  },
  executeNative: executeIndex,
  traverseDirectory,
  probeMediaWithFfprobe,
  probeImageWithSharp,
  sha256File
};