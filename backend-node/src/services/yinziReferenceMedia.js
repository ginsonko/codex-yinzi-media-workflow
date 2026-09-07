const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  getFfmpegPath,
  getFfprobePath,
  hasLocalFfmpeg,
  hasLocalFfprobe,
} = require('../utils/ffmpegPath');

const YINZI_REFERENCE_FPS = 24;
const YINZI_REFERENCE_CACHE_PROFILE = 'yinzi-ref-v3-fps24';

function parseFrameRate(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  const match = raw.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const numerator = Number(match[1]);
    const denominator = Number(match[2]);
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return 0;
    const rate = numerator / denominator;
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  }
  const rate = Number(raw);
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

function exactReferenceFps(value) {
  return Number.isFinite(value) && Math.abs(value - YINZI_REFERENCE_FPS) < 1e-6;
}

function positiveDuration(probe) {
  const video = (probe.streams || []).find((stream) => stream.codec_type === 'video');
  const candidates = [probe.format?.duration, video?.duration].map(Number);
  return candidates.find((value) => Number.isFinite(value) && value > 0.2) || 0;
}

function packetDuration(filePath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-show_packets',
    '-show_entries', 'packet=pts_time,dts_time,duration_time', '-of', 'json', filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) return 0;
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); }
  catch (_) { return 0; }
  let latestEnd = 0;
  for (const packet of parsed.packets || []) {
    const pts = Number(packet.pts_time);
    const dts = Number(packet.dts_time);
    const start = Number.isFinite(pts) ? pts : Number.isFinite(dts) ? dts : null;
    if (start == null) continue;
    const packetLength = Number(packet.duration_time);
    latestEnd = Math.max(latestEnd, start + (Number.isFinite(packetLength) && packetLength > 0 ? packetLength : 0));
  }
  return latestEnd;
}

function probeReferenceVideo(filePath) {
  const result = spawnSync(getFfprobePath(), [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`FFprobe could not inspect the reference video: ${result.error?.message || result.stderr?.slice(-500) || 'unknown error'}`);
  }
  let parsed;
  try { parsed = JSON.parse(result.stdout || '{}'); }
  catch (_) { throw new Error('FFprobe returned invalid JSON for the reference video'); }
  const video = (parsed.streams || []).find((stream) => stream.codec_type === 'video');
  if (!video) throw new Error('The reference file has no video stream');
  const duration = positiveDuration(parsed) || packetDuration(filePath);
  if (!duration) throw new Error('The reference video has no finite positive duration');
  const audio = (parsed.streams || []).find((stream) => stream.codec_type === 'audio');
  return {
    duration,
    format: parsed.format?.format_name || '',
    video_codec: video.codec_name || '',
    pixel_format: video.pix_fmt || '',
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    r_frame_rate_raw: video.r_frame_rate || '',
    avg_frame_rate_raw: video.avg_frame_rate || '',
    r_frame_rate: parseFrameRate(video.r_frame_rate),
    avg_frame_rate: parseFrameRate(video.avg_frame_rate),
    audio_codec: audio?.codec_name || null,
    has_audio: !!audio,
  };
}

function providerSafeMp4(filePath, probe, expectedCanvas = null) {
  return path.extname(filePath).toLowerCase() === '.mp4'
    && /(^|,)mp4(,|$)/.test(probe.format)
    && probe.video_codec === 'h264'
    && ['yuv420p', 'yuvj420p'].includes(probe.pixel_format)
    && probe.width > 0
    && probe.width % 16 === 0
    && probe.height > 0
    && probe.height % 2 === 0
    && exactReferenceFps(probe.r_frame_rate)
    && exactReferenceFps(probe.avg_frame_rate)
    && (!expectedCanvas || (probe.width === expectedCanvas.width && probe.height === expectedCanvas.height))
    && (!probe.has_audio || probe.audio_codec === 'aac')
    && Number.isFinite(probe.duration)
    && probe.duration > 0.2;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function targetReferenceCanvas(aspectRatio, probe = {}) {
  const known = {
    '16:9': { width: 1280, height: 720 },
    '9:16': { width: 720, height: 1280 },
    '1:1': { width: 720, height: 720 },
    '4:3': { width: 960, height: 720 },
    '3:4': { width: 720, height: 960 },
    '3:2': { width: 1152, height: 768 },
    '2:3': { width: 768, height: 1152 },
    '21:9': { width: 1344, height: 576 },
  };
  const normalized = String(aspectRatio || '').replace(/\s+/g, '');
  if (known[normalized]) return known[normalized];
  if (probe.width === probe.height) return known['1:1'];
  return probe.width < probe.height ? known['9:16'] : known['16:9'];
}

function validCachedVideo(filePath, expectedCanvas, expectedDuration = null, windowed = false) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  try {
    const probe = probeReferenceVideo(filePath);
    if (!providerSafeMp4(filePath, probe, expectedCanvas)) return null;
    if (expectedDuration != null && !durationMatches(probe.duration, expectedDuration, windowed)) return null;
    return probe;
  } catch (_) {
    return null;
  }
}

function normalizeClipWindow(sourceDuration, options = {}) {
  const requestedStart = Number(options.clip_start_seconds);
  const requestedDuration = Number(options.clip_duration_seconds);
  const hasWindow = Number.isFinite(requestedStart) || Number.isFinite(requestedDuration);
  if (!hasWindow) {
    return { windowed: false, start_seconds: 0, duration_seconds: sourceDuration };
  }
  const start = Number.isFinite(requestedStart) ? Math.max(0, requestedStart) : 0;
  if (start >= sourceDuration - 0.2) throw new Error('The reference-video clip starts after the usable source duration');
  const available = sourceDuration - start;
  const duration = Number.isFinite(requestedDuration) ? Math.min(requestedDuration, available) : available;
  if (!Number.isFinite(duration) || duration <= 0.2) throw new Error('The reference-video clip has no finite positive duration');
  const windowed = start > 0.001 || duration < sourceDuration - 0.001;
  return { windowed, start_seconds: start, duration_seconds: duration };
}

function durationMatches(actual, expected, windowed) {
  const tolerance = windowed ? Math.max(0.25, expected * 0.05) : Math.max(0.5, expected * 0.1);
  return Math.abs(actual - expected) <= tolerance;
}

function prepareYinziReferenceVideo(filePath, options = {}) {
  if (!hasLocalFfmpeg() || !hasLocalFfprobe()) {
    throw new Error('FFmpeg and FFprobe are required to prepare local Yinzi reference videos');
  }
  const sourcePath = path.resolve(filePath);
  const sourceProbe = probeReferenceVideo(sourcePath);
  const canvas = targetReferenceCanvas(options.aspect_ratio, sourceProbe);
  const clip = normalizeClipWindow(sourceProbe.duration, options);
  if (!clip.windowed && providerSafeMp4(sourcePath, sourceProbe, canvas)) {
    return { file_path: sourcePath, normalized: false, probe: sourceProbe, clip };
  }

  const storageRoot = path.resolve(options.storage_root || path.dirname(sourcePath));
  const cacheDir = path.join(storageRoot, '.provider-reference-cache', 'yinzi');
  fs.mkdirSync(cacheDir, { recursive: true });
  const clipKey = clip.windowed
    ? `-clip-s${Math.round(clip.start_seconds * 1000)}-d${Math.round(clip.duration_seconds * 1000)}`
    : '';
  const targetPath = path.join(
    cacheDir,
    `${sha256File(sourcePath)}-${YINZI_REFERENCE_CACHE_PROFILE}-${canvas.width}x${canvas.height}${clipKey}.mp4`
  );
  const cachedProbe = validCachedVideo(targetPath, canvas, clip.duration_seconds, clip.windowed);
  if (cachedProbe) {
    options.log?.info?.('[YinziAPI] Reference video cache reused', {
      video_gen_id: options.video_gen_id,
      index: options.index,
      duration: Number(cachedProbe.duration.toFixed(3)),
      video_codec: cachedProbe.video_codec,
      width: cachedProbe.width,
      height: cachedProbe.height,
      r_frame_rate: cachedProbe.r_frame_rate_raw,
      avg_frame_rate: cachedProbe.avg_frame_rate_raw,
    });
    return { file_path: targetPath, normalized: true, cache_reused: true, probe: cachedProbe, clip };
  }

  const tempPath = path.join(cacheDir, `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp.mp4`);
  const args = [
    '-v', 'error', '-y', '-i', sourcePath,
  ];
  if (clip.windowed) {
    args.push('-ss', clip.start_seconds.toFixed(3), '-t', clip.duration_seconds.toFixed(3));
  }
  args.push(
    '-map', '0:v:0',
    '-vf', `scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease,pad=${canvas.width}:${canvas.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${YINZI_REFERENCE_FPS}`,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', String(YINZI_REFERENCE_FPS), '-fps_mode', 'cfr',
    '-movflags', '+faststart',
  );
  if (sourceProbe.has_audio) {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k');
  } else {
    args.push('-an');
  }
  args.push(tempPath);

  try {
    const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(`FFmpeg could not normalize the reference video: ${result.error?.message || result.stderr?.slice(-500) || 'unknown error'}`);
    }
    const normalizedProbe = probeReferenceVideo(tempPath);
    if (!providerSafeMp4(tempPath, normalizedProbe, canvas)) {
      throw new Error('The normalized reference video is not provider-safe H.264 MP4');
    }
    if (!durationMatches(normalizedProbe.duration, clip.duration_seconds, clip.windowed)) {
      throw new Error('The normalized reference video duration differs from its requested clip window');
    }

    const raceWinner = validCachedVideo(targetPath, canvas, clip.duration_seconds, clip.windowed);
    if (raceWinner) {
      fs.unlinkSync(tempPath);
      return { file_path: targetPath, normalized: true, cache_reused: true, probe: raceWinner, clip };
    }
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    try {
      fs.renameSync(tempPath, targetPath);
    } catch (error) {
      const concurrentProbe = validCachedVideo(targetPath, canvas, clip.duration_seconds, clip.windowed);
      if (!concurrentProbe) throw error;
      fs.unlinkSync(tempPath);
      return { file_path: targetPath, normalized: true, cache_reused: true, probe: concurrentProbe, clip };
    }
    options.log?.info?.('[YinziAPI] Reference video normalized', {
      video_gen_id: options.video_gen_id,
      index: options.index,
      source_format: sourceProbe.format,
      source_codec: sourceProbe.video_codec,
      duration: Number(normalizedProbe.duration.toFixed(3)),
      width: normalizedProbe.width,
      height: normalizedProbe.height,
      r_frame_rate: normalizedProbe.r_frame_rate_raw,
      avg_frame_rate: normalizedProbe.avg_frame_rate_raw,
      bytes: fs.statSync(targetPath).size,
      clip_start_seconds: clip.start_seconds,
      clip_duration_seconds: clip.duration_seconds,
    });
    return { file_path: targetPath, normalized: true, cache_reused: false, probe: normalizedProbe, clip };
  } finally {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
  }
}

module.exports = {
  prepareYinziReferenceVideo,
  probeReferenceVideo,
  providerSafeMp4,
  targetReferenceCanvas,
  parseFrameRate,
  YINZI_REFERENCE_FPS,
};
