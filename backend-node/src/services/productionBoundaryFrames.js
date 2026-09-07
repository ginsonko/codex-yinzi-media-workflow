const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const validation = require('./productionMediaValidation');
const { getFfmpegPath } = require('../utils/ffmpegPath');

function safeSegment(value, fallback) {
  const normalized = String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function continuityFrameRelativePath(input = {}) {
  const run = safeSegment(input.run_id, 'run');
  const shot = safeSegment(input.shot_scope_id, 'shot');
  const source = safeSegment(input.source_artifact_id, 'source');
  const fingerprint = safeSegment(String(input.source_hash || '').slice(0, 20), 'unhashed');
  return `production/continuity-frames/${run}/shot-${shot}-source-${source}-${fingerprint}.png`;
}

function runFfmpeg(args, label) {
  const result = spawnSync(getFfmpegPath(), args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label}：${result.error?.message || result.stderr?.slice(-800) || '未知错误'}`);
  }
}

async function extractTailFrame(cfg, mediaPath, input = {}) {
  const source = validation.resolveLocalMediaPath(cfg, mediaPath);
  const relativePath = input.output_relative_path || continuityFrameRelativePath(input);
  const storageRoot = validation.storageRoot(cfg);
  const targetPath = path.resolve(storageRoot, relativePath.replace(/\//g, path.sep));
  const rel = path.relative(storageRoot, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('严格首帧输出路径超出项目存储目录');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });

  const validateCached = () => validation.validateImage(cfg, relativePath, { min_bytes: 64, allow_uniform: true });
  if (fs.existsSync(targetPath)) {
    try {
      return { ...(await validateCached()), cache_reused: true };
    } catch (_) {
      // A deterministic derived cache may be rebuilt from its immutable source.
    }
  }

  const tempPath = `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp.png`;
  try {
    // -update 1 decodes the selected stream to completion and repeatedly writes
    // the same PNG, leaving the final decoded frame rather than a near-tail seek.
    runFfmpeg([
      '-v', 'error', '-y', '-i', source.absolute_path,
      '-map', '0:v:0', '-an', '-vsync', '0', '-update', '1', tempPath,
    ], '无法提取上一镜头的最终解码帧');
    if (!fs.existsSync(tempPath)) throw new Error('严格首帧提取后没有生成文件');

    if (fs.existsSync(targetPath)) {
      try {
        return { ...(await validateCached()), cache_reused: true };
      } catch (_) {
        const quarantined = `${targetPath}.invalid-${crypto.randomUUID()}`;
        fs.renameSync(targetPath, quarantined);
      }
    }
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      if (!fs.existsSync(targetPath)) throw error;
      try {
        return { ...(await validateCached()), cache_reused: true };
      } catch (_) {
        throw error;
      }
    }
    return { ...(await validation.validateImage(cfg, relativePath, { min_bytes: 64, allow_uniform: true })), cache_reused: false };
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

function extractTemporaryFrame(cfg, mediaPath, position) {
  const source = validation.resolveLocalMediaPath(cfg, mediaPath);
  const target = path.join(os.tmpdir(), `production-boundary-${position}-${crypto.randomUUID()}.png`);
  const args = ['-v', 'error', '-y', '-i', source.absolute_path, '-map', '0:v:0', '-an'];
  if (position === 'tail') args.push('-vsync', '0', '-update', '1');
  else args.push('-frames:v', '1');
  args.push(target);
  runFfmpeg(args, `无法提取视频${position === 'tail' ? '尾帧' : '首帧'}`);
  if (!fs.existsSync(target)) throw new Error('边界帧提取后没有生成文件');
  return target;
}

async function pixelSimilarity(leftPath, rightPath) {
  const options = { width: 256, height: 256, fit: 'fill' };
  const [left, right] = await Promise.all([
    sharp(leftPath).removeAlpha().resize(options).raw().toBuffer(),
    sharp(rightPath).removeAlpha().resize(options).raw().toBuffer(),
  ]);
  if (!left.length || left.length !== right.length) throw new Error('边界帧像素格式不一致');
  let absoluteDifference = 0;
  for (let index = 0; index < left.length; index += 1) {
    absoluteDifference += Math.abs(left[index] - right[index]);
  }
  return Math.max(0, Math.min(1, 1 - (absoluteDifference / left.length / 255)));
}

async function compareStrictFirstFrame(cfg, expectedImagePath, generatedVideoPath, options = {}) {
  const expected = validation.resolveLocalMediaPath(cfg, expectedImagePath);
  const generatedFirst = extractTemporaryFrame(cfg, generatedVideoPath, 'first');
  try {
    const similarity = await pixelSimilarity(expected.absolute_path, generatedFirst);
    const threshold = Number(options.threshold ?? 0.9);
    return {
      mode: 'strict_continuation',
      metric: 'rgb_mean_absolute_similarity_256',
      similarity,
      threshold,
      passed: similarity >= threshold,
      expected_frame_path: expected.relative_path,
    };
  } finally {
    try { if (fs.existsSync(generatedFirst)) fs.unlinkSync(generatedFirst); } catch (_) {}
  }
}

async function probeHardCutBoundary(cfg, previousVideoPath, generatedVideoPath) {
  const previousTail = extractTemporaryFrame(cfg, previousVideoPath, 'tail');
  const generatedFirst = extractTemporaryFrame(cfg, generatedVideoPath, 'first');
  try {
    return {
      mode: 'hard_cut',
      metric: 'rgb_mean_absolute_similarity_256',
      similarity: await pixelSimilarity(previousTail, generatedFirst),
      informational_only: true,
    };
  } finally {
    try { if (fs.existsSync(previousTail)) fs.unlinkSync(previousTail); } catch (_) {}
    try { if (fs.existsSync(generatedFirst)) fs.unlinkSync(generatedFirst); } catch (_) {}
  }
}

module.exports = {
  continuityFrameRelativePath,
  extractTailFrame,
  compareStrictFirstFrame,
  probeHardCutBoundary,
  pixelSimilarity,
};
