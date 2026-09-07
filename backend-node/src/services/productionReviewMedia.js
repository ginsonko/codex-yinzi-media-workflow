const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { getFfmpegPath } = require('../utils/ffmpegPath');
const mediaValidation = require('./productionMediaValidation');

const IMAGE_STAGES = new Set(['asset_images', 'storyboard_images']);
const VIDEO_STAGES = new Set(['director_preview', 'shot_video']);

function visualMediaKind(artifact) {
  if (!artifact?.media_path) return null;
  if (IMAGE_STAGES.has(artifact.stage) || String(artifact.mime_type || '').startsWith('image/')) return 'image';
  if (VIDEO_STAGES.has(artifact.stage) || String(artifact.mime_type || '').startsWith('video/')) return 'video';
  if (artifact.stage === 'final_edit' && artifact.content?.kind === 'final_video') return 'video';
  return null;
}

function sampleTimes(duration) {
  const safeDuration = Math.max(0.3, Number(duration) || 1);
  return [0.08, 0.5, 0.92].map((ratio) => Number(Math.min(
    Math.max(0, safeDuration - 0.08),
    Math.max(0, safeDuration * ratio)
  ).toFixed(3)));
}

function createVideoReviewSheet(sourcePath, duration, outputPath) {
  const times = sampleTimes(duration);
  const args = [];
  for (const at of times) args.push('-ss', String(at), '-i', sourcePath);
  const filters = times.map((_, index) => (
    `[${index}:v]scale=640:360:force_original_aspect_ratio=decrease,`+
    `pad=640:360:(ow-iw)/2:(oh-ih)/2:color=black[v${index}]`
  ));
  filters.push(`${times.map((_, index) => `[v${index}]`).join('')}hstack=inputs=${times.length}[out]`);
  const result = spawnSync(getFfmpegPath(), [
    '-v', 'error', ...args,
    '-filter_complex', filters.join(';'), '-map', '[out]',
    '-frames:v', '1', '-q:v', '3', '-y', outputPath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0 || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1024) {
    const error = new Error(`无法生成视频首中尾审查图：${result.error?.message || String(result.stderr || '').slice(-400) || '未知错误'}`);
    error.code = 'VIDEO_REVIEW_SHEET_FAILED';
    throw error;
  }
  return times;
}

async function prepareVisualReviewEvidence(cfg, artifact, injected = {}) {
  const kind = visualMediaKind(artifact);
  if (!kind) return null;
  const resolved = mediaValidation.resolveLocalMediaPath(cfg, artifact.media_path);
  const mediaHash = artifact.content_hash || mediaValidation.sha256File(resolved.absolute_path);
  if (kind === 'image') {
    return {
      imageSource: { localAbsPath: resolved.absolute_path },
      receipt: { kind: 'source_image', media_sha256: mediaHash, relative_path: resolved.relative_path },
      cleanup: () => {},
    };
  }

  const duration = Number(artifact.content?.validation?.duration)
    || Number(injected.duration)
    || Number(mediaValidation.probeMedia(resolved.absolute_path)?.format?.duration)
    || 1;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-video-review-'));
  const outputPath = path.join(tempDir, `${crypto.randomUUID()}.jpg`);
  try {
    const buildSheet = injected.createVideoReviewSheet || createVideoReviewSheet;
    const sampledAtSeconds = await buildSheet(resolved.absolute_path, duration, outputPath);
    return {
      imageSource: { localAbsPath: outputPath },
      receipt: {
        kind: 'video_first_middle_last_sheet',
        media_sha256: mediaHash,
        relative_path: resolved.relative_path,
        sampled_at_seconds: sampledAtSeconds,
      },
      cleanup: () => {
        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        try { if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir); } catch (_) {}
      },
    };
  } catch (error) {
    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
    try { if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir); } catch (_) {}
    throw error;
  }
}

module.exports = {
  createVideoReviewSheet,
  prepareVisualReviewEvidence,
  sampleTimes,
  visualMediaKind,
};
