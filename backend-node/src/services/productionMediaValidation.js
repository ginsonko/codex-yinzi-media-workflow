const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');
const { validateProductionMediaAspect } = require('./productionAspectRatio');

function storageRoot(cfg) {
  const configured = cfg?.storage?.local_path || './data/storage';
  return path.resolve(path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured));
}

function resolveLocalMediaPath(cfg, value) {
  if (!value) throw new Error('媒体路径为空');
  const root = storageRoot(cfg);
  const raw = String(value).trim();
  let source = raw;
  const baseUrl = String(cfg?.storage?.base_url || '').replace(/\/$/, '');
  let storageUrl = false;
  if (baseUrl && source.startsWith(baseUrl)) {
    source = source.slice(baseUrl.length);
    storageUrl = true;
  }
  const staticUrl = /^\/?static\//i.test(source);
  if (!storageUrl && !staticUrl && /^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new Error('媒体必须先下载到项目存储目录');
  }
  source = source.replace(/^\/static\//, '').replace(/^static\//, '').replace(/^\/+/, '');
  // On Windows, path.isAbsolute('/static/...') is true even though it is an app URL.
  const filesystemAbsolute = !storageUrl && !staticUrl && path.isAbsolute(raw);
  const resolved = filesystemAbsolute
    ? path.resolve(raw)
    : path.resolve(root, source.replace(/\//g, path.sep));
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('媒体路径超出项目存储目录');
  if (!fs.existsSync(resolved)) throw new Error(`媒体文件不存在：${source}`);
  return { absolute_path: resolved, relative_path: rel.replace(/\\/g, '/'), storage_root: root };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function probeMedia(filePath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`FFprobe 失败：${result.error?.message || result.stderr?.slice(-500) || '未知错误'}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); }
  catch (_) { throw new Error('FFprobe 返回无效 JSON'); }
  return parsed;
}

function durationFromPackets(packets) {
  let latestEnd = 0;
  for (const packet of Array.isArray(packets) ? packets : []) {
    const pts = Number(packet?.pts_time);
    const dts = Number(packet?.dts_time);
    const start = Number.isFinite(pts) ? pts : Number.isFinite(dts) ? dts : null;
    if (start == null) continue;
    const packetDuration = Number(packet?.duration_time);
    const end = start + (Number.isFinite(packetDuration) && packetDuration > 0 ? packetDuration : 0);
    if (Number.isFinite(end)) latestEnd = Math.max(latestEnd, end);
  }
  return latestEnd;
}

function probePacketDuration(filePath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-show_packets',
    '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'json', filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`FFprobe 数据包时间轴失败：${result.error?.message || result.stderr?.slice(-500) || '未知错误'}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); }
  catch (_) { throw new Error('FFprobe 数据包时间轴返回无效 JSON'); }
  return durationFromPackets(parsed.packets);
}

async function imageStats(filePath) {
  const image = sharp(filePath);
  const [metadata, stats] = await Promise.all([image.metadata(), image.stats()]);
  const deviations = (stats.channels || []).slice(0, 3).map((channel) => Number(channel.stdev || 0));
  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    format: metadata.format || '',
    channel_stdev: deviations,
    nonblank: deviations.some((value) => value >= 1.5),
  };
}

async function validateImage(cfg, mediaPath, options = {}) {
  const resolved = resolveLocalMediaPath(cfg, mediaPath);
  const stat = fs.statSync(resolved.absolute_path);
  if (stat.size < (options.min_bytes || 1024)) throw new Error('图片文件过小或为空');
  const stats = await imageStats(resolved.absolute_path);
  if (stats.width < (options.min_width || 128) || stats.height < (options.min_height || 128)) {
    throw new Error('图片尺寸不足');
  }
  if (!stats.nonblank && options.allow_uniform !== true) throw new Error('图片像素近似空白');
  const aspectReceipt = options.expected_aspect_ratio
    ? validateProductionMediaAspect(stats.width, stats.height, options.expected_aspect_ratio, options)
    : {};
  return {
    ...resolved,
    bytes: stat.size,
    sha256: sha256File(resolved.absolute_path),
    ...stats,
    ...aspectReceipt,
  };
}

function fileSignature(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(16);
    fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (buffer.slice(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'webm';
    if (buffer.slice(4, 8).toString('ascii') === 'ftyp') return 'mp4';
    return 'unknown';
  } finally { fs.closeSync(fd); }
}

async function validateVideo(cfg, mediaPath, options = {}) {
  const resolved = resolveLocalMediaPath(cfg, mediaPath);
  const stat = fs.statSync(resolved.absolute_path);
  if (stat.size < (options.min_bytes || 8192)) throw new Error('视频文件过小或为空');
  const signature = fileSignature(resolved.absolute_path);
  if (!['webm', 'mp4'].includes(signature)) throw new Error('视频容器签名无效');
  const probe = probeMedia(resolved.absolute_path);
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  if (!video || Number(video.width) < 128 || Number(video.height) < 128) throw new Error('视频缺少有效画面流');
  let duration = Number(probe.format?.duration || video.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0.2) {
    duration = probePacketDuration(resolved.absolute_path);
  }
  if (!Number.isFinite(duration) || duration <= 0.2) throw new Error('视频时长无效');
  if (options.expected_duration != null) {
    const tolerance = Number(options.duration_tolerance ?? Math.max(1.25, Number(options.expected_duration) * 0.25));
    if (Math.abs(duration - Number(options.expected_duration)) > tolerance) {
      throw new Error(`视频时长 ${duration.toFixed(2)} 秒与预期 ${Number(options.expected_duration).toFixed(2)} 秒不符`);
    }
  }
  const aspectReceipt = options.expected_aspect_ratio
    ? validateProductionMediaAspect(video.width, video.height, options.expected_aspect_ratio, options)
    : {};
  const framePath = path.join(os.tmpdir(), `production-frame-${crypto.randomUUID()}.png`);
  try {
    const at = Math.max(0, Math.min(duration * 0.5, Math.max(0, duration - 0.1)));
    const frame = spawnSync(getFfmpegPath(), [
      '-v', 'error', '-ss', String(at), '-i', resolved.absolute_path,
      '-frames:v', '1', '-y', framePath,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (frame.error || frame.status !== 0 || !fs.existsSync(framePath)) throw new Error('无法提取视频验收帧');
    const stats = await imageStats(framePath);
    if (!stats.nonblank) throw new Error('视频验收帧近似空白');
    return {
      ...resolved,
      bytes: stat.size,
      sha256: sha256File(resolved.absolute_path),
      signature,
      duration,
      width: Number(video.width),
      height: Number(video.height),
      fps: video.avg_frame_rate || video.r_frame_rate || null,
      video_codec: video.codec_name || null,
      audio_codec: (probe.streams || []).find((stream) => stream.codec_type === 'audio')?.codec_name || null,
      nonblank: true,
      ...aspectReceipt,
    };
  } finally {
    try { if (fs.existsSync(framePath)) fs.unlinkSync(framePath); } catch (_) {}
  }
}

module.exports = {
  storageRoot,
  resolveLocalMediaPath,
  sha256File,
  probeMedia,
  durationFromPackets,
  probePacketDuration,
  validateImage,
  validateVideo,
};
