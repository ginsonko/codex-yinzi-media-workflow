'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const { copyVerifiedExecutable } = require('../runtime');

const repoRoot = path.join(__dirname, '..', '..');
const targetDir = path.join(repoRoot, 'backend-node', 'tools', 'ffmpeg');
const targetFfmpeg = path.join(targetDir, 'ffmpeg.exe');
const targetFfprobe = path.join(targetDir, 'ffprobe.exe');
const LFS_POINTER_PREFIX = 'version https://git-lfs.github.com/spec/v1';
const MIN_TRACKED_EXECUTABLE_BYTES = 1024 * 1024;

function run(file, args, label) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} 失败：${result.error?.message || result.stderr || `exit ${result.status}`}`);
  }
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function isMaterializedTrackedExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size < MIN_TRACKED_EXECUTABLE_BYTES) return false;
    const descriptor = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(LFS_POINTER_PREFIX.length);
      const bytes = fs.readSync(descriptor, header, 0, header.length, 0);
      return header.subarray(0, bytes).toString('utf8') !== LFS_POINTER_PREFIX;
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return false;
  }
}

function resolveSource(name, environment = process.env) {
  const explicit = environment[name === 'ffmpeg.exe' ? 'YINZI_FFMPEG_SOURCE' : 'YINZI_FFPROBE_SOURCE'];
  if (typeof explicit === 'string' && explicit.trim()) return path.resolve(explicit.trim());
  const tracked = path.join(targetDir, name);
  if (isMaterializedTrackedExecutable(tracked)) return tracked;
  const candidates = [
    path.join('C:\\Program Files', 'ffmpeg-2025-03-20-git-76f09ab647-essentials_build', 'bin', name),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function copyAtomic(source, destination) {
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
  const destinationHash = fs.existsSync(destination)
    ? crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex')
    : '';
  return copyVerifiedExecutable({
    source,
    destination,
    args: ['-version'],
    replaceExisting: sourceHash !== destinationHash,
  });
}

function verifyCapabilities() {
  const version = run(targetFfmpeg, ['-hide_banner', '-version'], 'FFmpeg 版本探针');
  const filters = run(targetFfmpeg, ['-hide_banner', '-filters'], 'FFmpeg 滤镜探针');
  const encoders = run(targetFfmpeg, ['-hide_banner', '-encoders'], 'FFmpeg 编码器探针');
  run(targetFfprobe, ['-hide_banner', '-version'], 'FFprobe 版本探针');

  if (!/--enable-gpl/i.test(version)) throw new Error('FFmpeg 必须启用 GPL，以提供 libx264');
  for (const filter of ['subtitles', 'drawtext', 'amix', 'atempo']) {
    if (!new RegExp(`\\b${filter}\\b`).test(filters)) throw new Error(`FFmpeg 缺少 ${filter} 滤镜`);
  }
  for (const encoder of ['libx264', 'aac', 'libmp3lame']) {
    if (!new RegExp(`\\b${encoder}\\b`).test(encoders)) throw new Error(`FFmpeg 缺少 ${encoder} 编码器`);
  }
}

function prepareMediaTools(environment = process.env) {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('本发布脚本仅支持 Windows x64');
  }

  const inputs = [
    { source: resolveSource('ffmpeg.exe', environment), destination: targetFfmpeg },
    { source: resolveSource('ffprobe.exe', environment), destination: targetFfprobe },
  ];
  if (inputs.some((item) => !item.source)) {
    throw new Error('未找到发布用 FFmpeg/FFprobe。请设置 YINZI_FFMPEG_SOURCE 与 YINZI_FFPROBE_SOURCE。');
  }

  for (const item of inputs) {
    if (path.resolve(item.source) !== path.resolve(item.destination)) {
      copyAtomic(item.source, item.destination);
    }
  }

  const externalInput = inputs.find((item) => path.resolve(item.source) !== path.resolve(item.destination));
  if (externalInput) {
    const sourceRoot = path.resolve(path.dirname(externalInput.source), '..');
    for (const [sourceName, targetName] of [
      ['LICENSE', 'LICENSE-FFMPEG-GPLv3.txt'],
      ['README.txt', 'README-FFMPEG-BUILD.txt'],
    ]) {
      const source = path.join(sourceRoot, sourceName);
      if (!fs.existsSync(source)) throw new Error(`FFmpeg 分发缺少 ${sourceName}`);
      fs.copyFileSync(source, path.join(targetDir, targetName));
    }
  }

  for (const name of ['LICENSE-FFMPEG-GPLv3.txt', 'README-FFMPEG-BUILD.txt']) {
    const notice = path.join(targetDir, name);
    if (!fs.existsSync(notice) || fs.statSync(notice).size === 0) {
      throw new Error(`FFmpeg 发布说明缺失或为空：${notice}`);
    }
  }

  for (const [downloaded, published] of [['LICENSE-DOWNLOADED.txt', 'LICENSE-FFMPEG-GPLv3.txt'], ['README-DOWNLOADED.txt', 'README-FFMPEG-BUILD.txt']]) {
    if (fs.existsSync(path.join(targetDir, downloaded))) fs.copyFileSync(path.join(targetDir, downloaded), path.join(targetDir, published));
  }
  verifyCapabilities();
  console.log('[media] FFmpeg/FFprobe 已就绪并通过版本、编码、字幕与混音能力探针。');
}

if (require.main === module) prepareMediaTools();

module.exports = {
  isMaterializedTrackedExecutable,
  prepareMediaTools,
  resolveSource,
};
