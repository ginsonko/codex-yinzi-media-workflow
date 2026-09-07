const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

const YINZI_REFERENCE_IMAGE_PROFILE = 'yinzi-image-v1-jpeg1920-2m';
const YINZI_REFERENCE_IMAGE_MAX_LONG_EDGE = 1920;
const YINZI_REFERENCE_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function inspectImage(filePath) {
  const stat = fs.statSync(filePath);
  const metadata = await sharp(filePath, { failOn: 'error' }).metadata();
  const width = Number(metadata.width) || 0;
  const height = Number(metadata.height) || 0;
  if (!width || !height) throw new Error('The local Yinzi reference image has no valid dimensions');
  return {
    bytes: stat.size,
    width,
    height,
    format: String(metadata.format || '').toLowerCase(),
  };
}

function boundedImage(probe, maxLongEdge, maxBytes) {
  return probe.bytes <= maxBytes
    && Math.max(probe.width, probe.height) <= maxLongEdge
    && ['jpeg', 'png', 'webp'].includes(probe.format);
}

async function validCachedImage(filePath, maxLongEdge, maxBytes) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  try {
    const probe = await inspectImage(filePath);
    return probe.format === 'jpeg' && boundedImage(probe, maxLongEdge, maxBytes) ? probe : null;
  } catch (_) {
    return null;
  }
}

async function prepareYinziReferenceImage(filePath, options = {}) {
  const sourcePath = path.resolve(filePath);
  const maxLongEdge = Math.max(768, Number(options.max_long_edge) || YINZI_REFERENCE_IMAGE_MAX_LONG_EDGE);
  const maxBytes = Math.max(512 * 1024, Number(options.max_bytes) || YINZI_REFERENCE_IMAGE_MAX_BYTES);
  const sourceProbe = await inspectImage(sourcePath);
  if (boundedImage(sourceProbe, maxLongEdge, maxBytes)) {
    return { file_path: sourcePath, normalized: false, probe: sourceProbe };
  }

  const storageRoot = path.resolve(options.storage_root || path.dirname(sourcePath));
  const cacheDir = path.join(storageRoot, '.provider-reference-cache', 'yinzi', 'images');
  fs.mkdirSync(cacheDir, { recursive: true });
  const sourceHash = sha256File(sourcePath);
  const targetPath = path.join(cacheDir, `${sourceHash}-${YINZI_REFERENCE_IMAGE_PROFILE}.jpg`);
  const cachedProbe = await validCachedImage(targetPath, maxLongEdge, maxBytes);
  if (cachedProbe) {
    options.log?.info?.('[YinziAPI] Reference image cache reused', {
      video_gen_id: options.video_gen_id,
      index: options.index,
      bytes: cachedProbe.bytes,
      width: cachedProbe.width,
      height: cachedProbe.height,
    });
    return { file_path: targetPath, normalized: true, cache_reused: true, probe: cachedProbe };
  }

  const tempPath = path.join(cacheDir, `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp.jpg`);
  const edgeCandidates = [...new Set([
    maxLongEdge,
    Math.min(maxLongEdge, 1728),
    Math.min(maxLongEdge, 1536),
    Math.min(maxLongEdge, 1280),
    Math.min(maxLongEdge, 1024),
  ])].filter((value) => value >= 768);
  const qualityCandidates = [92, 86, 80, 74, 68, 62];
  let output = null;
  let selectedQuality = null;
  let selectedEdge = null;

  try {
    for (const edge of edgeCandidates) {
      for (const quality of qualityCandidates) {
        output = await sharp(sourcePath, { failOn: 'error' })
          .rotate()
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' })
          .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true })
          .toBuffer();
        if (output.length <= maxBytes) {
          selectedQuality = quality;
          selectedEdge = edge;
          break;
        }
      }
      if (selectedQuality != null) break;
    }
    if (!output || selectedQuality == null) {
      throw new Error(`The bounded Yinzi reference image could not be reduced below ${maxBytes} bytes`);
    }
    const preparedMetadata = await sharp(output, { failOn: 'error' }).metadata();
    const preparedProbe = {
      bytes: output.length,
      width: Number(preparedMetadata.width) || 0,
      height: Number(preparedMetadata.height) || 0,
      format: String(preparedMetadata.format || '').toLowerCase(),
    };
    if (preparedProbe.format !== 'jpeg' || !boundedImage(preparedProbe, maxLongEdge, maxBytes)) {
      throw new Error(
        `The bounded Yinzi reference image failed validation: ${preparedProbe.width}x${preparedProbe.height}, ${preparedProbe.bytes} bytes, ${preparedProbe.format || 'unknown format'}`
      );
    }
    fs.writeFileSync(tempPath, output, { flag: 'wx' });

    const raceWinner = await validCachedImage(targetPath, maxLongEdge, maxBytes);
    if (raceWinner) {
      fs.unlinkSync(tempPath);
      return { file_path: targetPath, normalized: true, cache_reused: true, probe: raceWinner };
    }
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      const concurrentProbe = await validCachedImage(targetPath, maxLongEdge, maxBytes);
      if (!concurrentProbe) throw error;
      fs.unlinkSync(tempPath);
      return { file_path: targetPath, normalized: true, cache_reused: true, probe: concurrentProbe };
    }
    options.log?.info?.('[YinziAPI] Reference image normalized', {
      video_gen_id: options.video_gen_id,
      index: options.index,
      source_bytes: sourceProbe.bytes,
      source_width: sourceProbe.width,
      source_height: sourceProbe.height,
      bytes: preparedProbe.bytes,
      width: preparedProbe.width,
      height: preparedProbe.height,
      quality: selectedQuality,
      max_long_edge: selectedEdge,
    });
    return { file_path: targetPath, normalized: true, cache_reused: false, probe: preparedProbe };
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

module.exports = {
  prepareYinziReferenceImage,
  inspectImage,
  boundedImage,
  YINZI_REFERENCE_IMAGE_PROFILE,
  YINZI_REFERENCE_IMAGE_MAX_LONG_EDGE,
  YINZI_REFERENCE_IMAGE_MAX_BYTES,
};
