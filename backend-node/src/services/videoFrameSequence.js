const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SCHEMA_VERSION = 'frame-sequence/v1';
const LIMITATIONS = [
  '这两个合同只做本地逐帧导出与按清单回组，不是 AI 绘画、补帧、视频生成或完整角色替换。',
  '时长来自真实 PTS + duration_time，禁止用 n/avg_frame_rate 把 VFR 压成平均帧率。',
  '改帧必须写入 replacements 并授权新 SHA；未授权哈希变化会失败，不会悄悄恢复原图。',
  '音轨按原相对起点回放，audio_offset_seconds 是额外偏移，不是重新生成配乐。',
];

const fail = (code, message) => Object.assign(new Error(message), { code });
const round = n => Math.round(Number(n) * 1000000) / 1000000;

function number(value, fallback, min, max, name, integer = false) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw fail('FRAME_SEQUENCE_INPUT', `${name} 应在 ${min} 到 ${max} 之间${integer ? '的整数' : ''}`);
  }
  return n;
}

function parseRate(value) {
  if (value == null || value === 'N/A' || value === '0/0') return null;
  const text = String(value);
  if (text.includes('/')) {
    const [a, b] = text.split('/').map(Number);
    if (!b) return null;
    const n = a / b;
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseShowinfoLine(line) {
  const match = /(?:^|\s)n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:(\S+)/.exec(line);
  if (!match) return null;
  const ptsTime = Number(match[3]);
  if (!Number.isFinite(ptsTime)) return null;
  const info = { n: Number(match[1]), pts: Number(match[2]), pts_time: ptsTime };
  const durationPts = /\bduration:\s*(-?\d+)/.exec(line);
  const durationTime = /\bduration_time:(\S+)/.exec(line);
  if (durationPts) info.duration = Number(durationPts[1]);
  if (durationTime) {
    const value = Number(durationTime[1]);
    if (Number.isFinite(value)) info.duration_time = value;
  }
  return info;
}

function frameDurationSeconds(info, timeBase) {
  if (Number.isFinite(info?.duration_time) && info.duration_time > 0) return info.duration_time;
  const tb = parseRate(timeBase);
  if (tb && Number.isFinite(info?.duration) && info.duration > 0) return info.duration * tb;
  return null;
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function fileIdentity(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw fail('INPUT_MISSING', '输入必须是可读取的非空普通文件');
  return { size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, ino: stat.ino };
}

function identitiesEqual(expected, current) {
  if (!expected) return true;
  return !Object.keys(expected).some(key => current[key] !== expected[key]);
}

function concatEscape(filePath) {
  const normalized = path.resolve(filePath).replaceAll('\\', '/');
  return normalized.replaceAll("'", "'\\''");
}

function concatEntry(filePath, duration) {
  return `file '${concatEscape(filePath)}'\nduration ${duration}`;
}

function isInsideRoot(file, root) {
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return file === root || file.startsWith(base);
}

function realpathOrThrow(file, code = 'PATH_ESCAPE') {
  try {
    return fs.realpathSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw fail('FRAME_MISSING', `找不到帧文件：${file}`);
    throw fail(code, `无法解析路径：${file}`);
  }
}

function assertNotSourceOverwrite(outputPath, sourcePath) {
  if (!sourcePath || !fs.existsSync(outputPath) && !fs.existsSync(path.dirname(outputPath))) return;
  try {
    if (!fs.existsSync(sourcePath) || !fs.existsSync(outputPath)) return;
    if (fs.realpathSync(outputPath) === fs.realpathSync(sourcePath)) {
      throw fail('OUTPUT_OVERWRITES_SOURCE', '拒绝覆盖源视频；请把输出写到独立成果目录');
    }
  } catch (error) {
    if (error.code === 'OUTPUT_OVERWRITES_SOURCE') throw error;
  }
}

function directoryBytes(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const item of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) stack.push(full);
      else if (item.isFile()) total += fs.statSync(full).size;
    }
  }
  return total;
}

function runProcess(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeout || 120000);
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-1024 * 1024);
      options.onOutput?.(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-1024 * 1024);
      options.onErrorOutput?.(String(chunk));
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if ((options.exitCodes || [0]).includes(code)) resolve({ stdout, stderr, code });
      else reject(fail(options.failCode || 'FRAME_SEQUENCE_PROCESS', `本地进程未完成 (${code}): ${stderr.slice(-1500)}`));
    });
  });
}

function ffmpegBins(components) {
  const bins = components?.['media.ffmpeg']?.executables;
  if (!bins?.ffmpeg || !bins?.ffprobe) throw fail('FRAME_SEQUENCE_INPUT', '需要 media.ffmpeg 的 ffmpeg/ffprobe');
  return bins;
}

async function probeMedia(ffprobe, inputPath) {
  const result = await runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath], {
    timeout: 60000,
    failCode: 'FRAME_SEQUENCE_PROBE',
  });
  let probe;
  try { probe = JSON.parse(result.stdout); }
  catch { throw fail('FRAME_SEQUENCE_PROBE', 'ffprobe 无法解析该文件'); }
  const video = probe.streams?.find(s => s.codec_type === 'video');
  if (!video) throw fail('FRAME_SEQUENCE_NO_VIDEO', '素材没有视频轨');
  const audio = probe.streams?.find(s => s.codec_type === 'audio') || null;
  const origin = Number(video.start_time ?? probe.format?.start_time ?? 0);
  if (!Number.isFinite(origin)) throw fail('FRAME_SEQUENCE_TIME', '无法确定素材时间原点');
  const rRate = parseRate(video.r_frame_rate);
  const avgRate = parseRate(video.avg_frame_rate);
  const width = Number(video.width) || 0;
  const height = Number(video.height) || 0;
  return {
    probe, video, audio,
    origin,
    width, height,
    pixels: width * height,
    r_frame_rate: video.r_frame_rate || null,
    avg_frame_rate: video.avg_frame_rate || null,
    time_base: video.time_base || null,
    has_audio: Boolean(audio),
    audio_start_time: audio ? Number(audio.start_time ?? 0) : null,
    audio_codec: audio?.codec_name || null,
    video_start_time: origin,
    vfr_hint: rRate && avgRate ? Math.abs(rRate - avgRate) / Math.max(rRate, avgRate) > 0.02 : false,
    format_duration: Number(probe.format?.duration) || 0,
    stream_duration: Number(video.duration) || 0,
  };
}

function exportSettings(p = {}) {
  return {
    keep_audio: p.keep_audio !== false,
    max_frames: number(p.max_frames, 3600, 1, 200000, 'max_frames', true),
    max_pixels: number(p.max_pixels, 1920 * 1088, 256, 4096 * 4096, 'max_pixels', true),
    max_duration: number(p.max_duration, 120, 0.04, 3600, 'max_duration'),
    max_temp_bytes: number(p.max_temp_bytes, 2 * 1024 ** 3, 1024 * 1024, 16 * 1024 ** 3, 'max_temp_bytes', true),
  };
}

function assembleSettings(p = {}) {
  const timing = p.timing_strategy || 'pts';
  if (!['pts', 'bounded_cfr'].includes(timing)) {
    throw fail('FRAME_SEQUENCE_INPUT', 'timing_strategy 只能是 pts 或 bounded_cfr');
  }
  const durationPolicy = p.duration_policy || (timing === 'bounded_cfr' ? 'strict' : 'preserve_pts_span');
  if (!['strict', 'preserve_pts_span'].includes(durationPolicy)) {
    throw fail('FRAME_SEQUENCE_INPUT', 'duration_policy 只能是 strict 或 preserve_pts_span');
  }
  const replacements = Array.isArray(p.replacements) ? p.replacements : [];
  if (replacements.length > 4096) throw fail('FRAME_SEQUENCE_INPUT', 'replacements 超过上限');
  return {
    timing_strategy: timing,
    duration_policy: durationPolicy,
    cfr_fps: p.cfr_fps == null || p.cfr_fps === '' ? null : number(p.cfr_fps, 24, 1, 120, 'cfr_fps'),
    keep_audio: p.keep_audio !== false,
    audio_offset_seconds: number(p.audio_offset_seconds, 0, -30, 30, 'audio_offset_seconds'),
    audio_path: p.audio_path ? String(p.audio_path) : null,
    replacements,
    max_frames: number(p.max_frames, 3600, 1, 200000, 'max_frames', true),
    max_pixels: number(p.max_pixels, 1920 * 1088, 256, 4096 * 4096, 'max_pixels', true),
    max_duration: number(p.max_duration, 120, 0.04, 3600, 'max_duration'),
    max_temp_bytes: number(p.max_temp_bytes, 2 * 1024 ** 3, 1024 * 1024, 16 * 1024 ** 3, 'max_temp_bytes', true),
    comparison_count: number(p.comparison_count, 4, 1, 24, 'comparison_count', true),
  };
}

function presentationGaps(frames) {
  const gaps = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    const gap = frames[i + 1].pts_time - frames[i].pts_time;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  const last = frames.at(-1);
  const lastDur = frameDurationSeconds(last, last?.time_base);
  if (lastDur > 0) gaps.push(lastDur);
  return gaps;
}

function detectVfr(frames, media) {
  if (media?.vfr_hint) return true;
  const gaps = presentationGaps(frames);
  if (gaps.length < 2) return Boolean(media?.vfr_hint);
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  return min > 0 && max / min > 1.05;
}

function timelineFromFrames(frames, media) {
  if (!frames.length) throw fail('FRAME_SEQUENCE_EMPTY', '没有可导出的视频帧');
  const first = frames[0];
  const last = frames.at(-1);
  const lastDur = frameDurationSeconds(last, media.time_base);
  if (!(lastDur > 0)) throw fail('FRAME_SEQUENCE_TIME', '末帧缺少真实 duration，无法计算 PTS 跨度');
  const ptsSpan = round(last.pts_time + lastDur - first.pts_time);
  const contentDuration = round(last.pts_time + lastDur - media.origin);
  if (!(ptsSpan > 0) || !(contentDuration > 0)) throw fail('FRAME_SEQUENCE_TIME', 'PTS 跨度不是正数');
  const guessed = frames.length / (parseRate(media.avg_frame_rate) || Infinity);
  return {
    origin: round(media.origin),
    first_pts: first.pts,
    first_pts_time: round(first.pts_time),
    last_pts: last.pts,
    last_pts_time: round(last.pts_time),
    last_duration_time: round(lastDur),
    pts_span: ptsSpan,
    content_duration: contentDuration,
    time_base: media.time_base,
    r_frame_rate: media.r_frame_rate,
    avg_frame_rate: media.avg_frame_rate,
    vfr: detectVfr(frames, media),
    avg_frame_rate_guess_seconds: Number.isFinite(guessed) && guessed > 0 ? round(guessed) : null,
  };
}

function planFrameDurations(frames, options) {
  const strategy = options.timing_strategy || 'pts';
  const ptsSpan = Number(options.pts_span);
  if (!(ptsSpan > 0)) throw fail('FRAME_SEQUENCE_TIME', '缺少原 PTS 跨度');
  if (strategy === 'pts') {
    return frames.map((frame, index) => {
      if (index + 1 < frames.length) {
        const gap = frames[index + 1].pts_time - frame.pts_time;
        if (!(gap > 0)) throw fail('FRAME_SEQUENCE_TIME', `第 ${index} 帧 PTS 差不是正数`);
        return gap;
      }
      const remaining = ptsSpan - (frame.pts_time - frames[0].pts_time);
      if (remaining > 0) return remaining;
      const duration = frameDurationSeconds(frame, options.time_base);
      if (!(duration > 0)) throw fail('FRAME_SEQUENCE_TIME', `第 ${index} 帧无法确定真实时长`);
      return duration;
    });
  }
  if (strategy !== 'bounded_cfr') throw fail('FRAME_SEQUENCE_INPUT', '未知时序策略');
  if (options.vfr && options.duration_policy !== 'preserve_pts_span') {
    throw fail('VFR_CFR_REFUSED', 'VFR 源默认拒绝按恒定帧率映射；请用 timing_strategy=pts，或 duration_policy=preserve_pts_span 仅保总跨度');
  }
  const fps = options.cfr_fps || parseRate(options.r_frame_rate);
  if (!(fps > 0)) throw fail('FRAME_SEQUENCE_TIME', 'bounded_cfr 需要 cfr_fps 或恒定 r_frame_rate，不能用 avg_frame_rate 猜时间');
  const frameDur = 1 / fps;
  const naive = frameDur * frames.length;
  if (options.duration_policy === 'strict' && Math.abs(naive - ptsSpan) > frameDur + 0.02) {
    throw fail('CFR_DURATION_MISMATCH', `恒定帧率 ${fps} 会把真实 PTS 跨度 ${ptsSpan}s 映射成 ${round(naive)}s，已拒绝。请改用 pts 或 preserve_pts_span`);
  }
  const durations = frames.map(() => frameDur);
  if (options.duration_policy === 'preserve_pts_span') {
    const head = frameDur * Math.max(0, frames.length - 1);
    const last = ptsSpan - head;
    if (!(last > 0)) throw fail('CFR_DURATION_MISMATCH', 'preserve_pts_span 无法用末帧补齐到原 PTS 跨度');
    durations[durations.length - 1] = last;
  }
  return durations;
}

function frameFileName(index) {
  return `frame-${String(index).padStart(6, '0')}.png`;
}

async function exportPngSequence(ffmpeg, inputPath, framesDir, p, report) {
  fs.mkdirSync(framesDir, { recursive: true });
  const pattern = path.join(framesDir, 'frame-%06d.png');
  const pts = [];
  let stderrTail = '';
  const args = [
    '-nostdin', '-hide_banner', '-y', '-v', 'info', '-nostats', '-threads', '2',
    '-copyts', '-protocol_whitelist', 'file,pipe', '-i', inputPath,
    '-an', '-vf', 'showinfo', '-fps_mode', 'passthrough',
    '-start_number', '0', pattern,
  ];
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      child.kill();
    }, 10 * 60 * 1000);
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      const lines = (stderrTail + text).split(/\r?\n/);
      stderrTail = lines.pop();
      for (const line of lines) {
        const info = parseShowinfoLine(line);
        if (info) {
          pts.push(info);
          if (pts.length > p.max_frames) {
            child.kill();
          }
        }
      }
      if (pts.length && pts.length % 30 === 0) {
        report({ stage: 'exporting_frames', message: `正在导出 PNG，已记录 ${pts.length} 帧`, frames: pts.length });
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (stderrTail) {
        const info = parseShowinfoLine(stderrTail);
        if (info) pts.push(info);
      }
      if (pts.length > p.max_frames) {
        return reject(fail('FRAMES_LIMIT', `导出帧数超过 max_frames=${p.max_frames}，请分段或提高上限`));
      }
      if (code !== 0) return reject(fail('FRAME_SEQUENCE_DECODE', `逐帧导出未完成 (${code})`));
      resolve();
    });
  });
  return pts;
}

async function extractSourceAudio(ffmpeg, inputPath, audioDir, media) {
  if (!media.has_audio) return null;
  fs.mkdirSync(audioDir, { recursive: true });
  const mkv = path.join(audioDir, 'source-audio.mkv');
  const wav = path.join(audioDir, 'source-audio.wav');
  try {
    await runProcess(ffmpeg, [
      '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe',
      '-i', inputPath, '-vn', '-map', '0:a:0', '-c:a', 'copy', mkv,
    ], { timeout: 180000, failCode: 'AUDIO_EXTRACT' });
    if (fs.existsSync(mkv) && fs.statSync(mkv).size) {
      return { file: 'audio/source-audio.mkv', codec: 'copy', path: mkv };
    }
  } catch {
    // Fall through to PCM. Copy can fail on exotic codecs or mp4-in-mkv mismatches.
  }
  await runProcess(ffmpeg, [
    '-nostdin', '-y', '-v', 'error', '-protocol_whitelist', 'file,pipe',
    '-i', inputPath, '-vn', '-map', '0:a:0', '-c:a', 'pcm_s16le', wav,
  ], { timeout: 180000, failCode: 'AUDIO_EXTRACT' });
  if (!fs.existsSync(wav) || !fs.statSync(wav).size) throw fail('AUDIO_EXTRACT', '未能保存原音轨');
  return { file: 'audio/source-audio.wav', codec: 'pcm_s16le', path: wav };
}

async function hashAndMeasureFrames(framesDir, pts, media, p) {
  const files = fs.readdirSync(framesDir).filter(name => /^frame-\d{6}\.png$/.test(name)).sort();
  if (files.length !== pts.length) {
    throw fail('FRAME_SEQUENCE_DECODE', `PNG 数量与 showinfo 不一致（files=${files.length}, pts=${pts.length}）。请确认 fps_mode=passthrough，不要按平均帧率补帧。`);
  }
  const frames = [];
  let lastPts = null;
  let bytes = 0;
  for (let i = 0; i < files.length; i++) {
    const file = path.join(framesDir, files[i]);
    const expected = frameFileName(i);
    if (files[i] !== expected) throw fail('FRAME_SEQUENCE_DECODE', `帧文件名乱序：预期 ${expected}，实际 ${files[i]}`);
    const stat = fs.statSync(file);
    if (!stat.size) throw fail('FRAME_SEQUENCE_DECODE', `${expected} 是空文件`);
    bytes += stat.size;
    if (bytes > p.max_temp_bytes) throw fail('TEMP_BYTES_LIMIT', '导出临时字节超过 max_temp_bytes');
    const info = pts[i];
    if (lastPts != null && info.pts_time < lastPts) throw fail('PTS_NOT_MONOTONIC', '帧时间不递增，请先修复原片时间戳');
    if (lastPts != null && info.pts_time === lastPts) throw fail('DUPLICATE_PTS', `重复时间戳 pts_time=${info.pts_time}`);
    lastPts = info.pts_time;
    const durationTime = frameDurationSeconds(info, media.time_base);
    const relative = info.pts_time - media.origin;
    if (relative > p.max_duration + 1e-6) throw fail('DURATION_LIMIT', '素材超过 max_duration，请分段处理');
    frames.push({
      index: i,
      file: `frames/${expected}`,
      decoder_n: info.n,
      pts: info.pts,
      pts_time: round(info.pts_time),
      duration: Number.isFinite(info.duration) ? info.duration : null,
      duration_time: durationTime == null ? null : round(durationTime),
      time_base: media.time_base,
      width: media.width,
      height: media.height,
      sha256: await sha256File(file),
      bytes: stat.size,
    });
  }
  return { frames, bytes };
}

function replacementMap(replacements) {
  const map = new Map();
  for (const item of replacements || []) {
    if (!item || !Number.isInteger(Number(item.index))) throw fail('FRAME_SEQUENCE_INPUT', 'replacements.index 必须是整数');
    const index = Number(item.index);
    if (map.has(index)) throw fail('FRAME_SEQUENCE_INPUT', `replacements 重复了 index=${index}`);
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
      throw fail('FRAME_HASH_UNAUTHORIZED', `index=${index} 缺少 64 位授权 SHA-256`);
    }
    if (typeof item.path !== 'string' || !item.path.trim()) throw fail('FRAME_SEQUENCE_INPUT', `index=${index} 缺少 replacement path`);
    map.set(index, { index, path: item.path, sha256: item.sha256.toLowerCase() });
  }
  return map;
}

function resolveOwnedFile(filePath, roots, { allowSymlink = false } = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw fail('FRAME_MISSING', `找不到文件：${resolved}`);
  const stat = fs.lstatSync(resolved);
  const real = realpathOrThrow(resolved);
  if (stat.isSymbolicLink() && !allowSymlink) {
    const owned = roots.some(root => isInsideRoot(real, root));
    if (!owned) throw fail('SYMLINK_ESCAPE', `符号链接指向清单目录之外：${resolved} -> ${real}`);
  }
  if (!roots.some(root => isInsideRoot(real, root))) {
    throw fail('PATH_ESCAPE', `路径越界：${real}`);
  }
  if (!fs.statSync(real).isFile() || !fs.statSync(real).size) throw fail('FRAME_MISSING', `不是可读取的非空文件：${real}`);
  return real;
}

async function authorizeFrame(frame, manifestDir, replacements) {
  const replacement = replacements.get(frame.index);
  if (replacement) {
    const resolved = path.resolve(manifestDir, replacement.path);
    if (!fs.existsSync(resolved)) throw fail('FRAME_MISSING', `找不到授权替换帧：${resolved}`);
    if (fs.lstatSync(resolved).isSymbolicLink()) throw fail('SYMLINK_ESCAPE', `替换帧不能是符号链接：${resolved}`);
    const real = realpathOrThrow(resolved);
    if (!fs.statSync(real).isFile() || !fs.statSync(real).size) throw fail('FRAME_MISSING', `替换帧不是非空文件：${real}`);
    const hash = await sha256File(real);
    if (hash !== replacement.sha256) {
      throw fail('FRAME_HASH_UNAUTHORIZED', `index=${frame.index} 文件 SHA ${hash} 与授权 ${replacement.sha256} 不一致`);
    }
    return { ...frame, path: real, sha256: hash, replaced: true, original_sha256: frame.sha256 };
  }
  const listed = path.resolve(manifestDir, frame.file);
  const real = resolveOwnedFile(listed, [path.resolve(manifestDir)]);
  const hash = await sha256File(real);
  if (hash !== frame.sha256) {
    throw fail('FRAME_HASH_UNAUTHORIZED', `index=${frame.index} 已被修改但未授权新哈希（现 ${hash}，原 ${frame.sha256}）`);
  }
  return { ...frame, path: real, sha256: hash, replaced: false, original_sha256: frame.sha256 };
}

async function probeImageSize(ffprobe, file) {
  const result = await runProcess(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], {
    timeout: 30000,
    failCode: 'FRAME_SEQUENCE_PROBE',
  });
  const probe = JSON.parse(result.stdout);
  const stream = probe.streams?.[0];
  return { width: Number(stream?.width) || 0, height: Number(stream?.height) || 0 };
}

function writeConcatList(file, frames, durations, { repeatLast = false } = {}) {
  const lines = ['ffconcat version 1.0'];
  for (let i = 0; i < frames.length; i++) {
    lines.push(concatEntry(frames[i].path, durations[i]));
  }
  // Duration-based concat ignores the last duration unless the last file is
  // repeated. CFR PNG concat uses input -r instead, so a repeat becomes an
  // extra frame whose PTS can still sit under -t and survive muxing.
  if (repeatLast) lines.push(`file '${concatEscape(frames.at(-1).path)}'`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function writeFileConcatList(file, files) {
  const lines = ['ffconcat version 1.0', ...files.map(item => `file '${concatEscape(item)}'`)];
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function constantFrameRate(durations, options = {}) {
  if (!durations.length) return null;
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  if (!(min > 0) || max / min > 1.02) return null;
  const span = durations.reduce((sum, value) => sum + value, 0);
  if (!(span > 0)) return null;
  const declared = options.cfr_fps || parseRate(options.r_frame_rate);
  if (declared > 0) {
    const declaredSpan = durations.length / declared;
    if (Math.abs(declaredSpan - span) <= 1 / declared + 0.02) return declared;
  }
  return durations.length / span;
}

async function mapPool(count, limit, worker) {
  const results = new Array(count);
  let next = 0;
  let failure = null;
  async function runWorker() {
    while (next < count && !failure) {
      const index = next++;
      try { results[index] = await worker(index); }
      catch (error) { failure ||= error; }
    }
  }
  const n = Math.max(1, Math.min(limit, count));
  await Promise.all(Array.from({ length: n }, runWorker));
  if (failure) throw failure;
  return results;
}

async function countStreamPackets(ffprobe, file, streamSpecifier) {
  const result = await runProcess(ffprobe, [
    '-v', 'error', '-select_streams', streamSpecifier, '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-of', 'json', file,
  ], { timeout: 60000, failCode: 'FRAME_SEQUENCE_PROBE' });
  const probe = JSON.parse(result.stdout);
  return Number(probe.streams?.[0]?.nb_read_packets) || 0;
}

async function encodeAssembledVideo(ffmpeg, frames, durations, outDir, plannedDuration, maxTemp, report, options = {}) {
  const fps = constantFrameRate(durations, options);
  if (fps) {
    const concatPath = path.join(outDir, 'concat.ffconcat');
    writeConcatList(concatPath, frames, durations, { repeatLast: false });
    const videoPath = path.join(outDir, 'assembled-video.mp4');
    await runProcess(ffmpeg, [
      '-nostdin', '-y', '-v', 'error', '-threads', '2',
      '-protocol_whitelist', 'file,pipe,concat',
      '-f', 'concat', '-safe', '0', '-r', String(fps), '-i', concatPath,
      '-fps_mode', 'cfr', '-r', String(fps),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-an', '-frames:v', String(frames.length), '-movflags', '+faststart', videoPath,
    ], { timeout: 10 * 60 * 1000, failCode: 'ASSEMBLE_ENCODE' });
    return { videoPath, fps, mode: 'png_concat_cfr', frame_count: frames.length };
  }
  // PNG concat defaults to 25 fps and compresses VFR packet spans. Multi-input
  // image concat does the same. Encode one still clip per frame so each
  // duration_time is a real packet span. Clips stay on disk; do not load the
  // whole film as RGBA. Two concurrent ffmpeg processes cut wall time without
  // holding decoded frames.
  const clipDir = path.join(outDir, 'clips');
  fs.mkdirSync(clipDir, { recursive: true });
  const clips = await mapPool(frames.length, 2, async i => {
    const clip = path.join(clipDir, `clip-${String(i).padStart(6, '0')}.mkv`);
    const rate = 1 / durations[i];
    await runProcess(ffmpeg, [
      '-nostdin', '-y', '-v', 'error',
      '-loop', '1', '-framerate', String(rate), '-i', frames[i].path,
      '-frames:v', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage',
      '-pix_fmt', 'yuv420p', '-an', clip,
    ], { timeout: 60000, failCode: 'ASSEMBLE_ENCODE' });
    if ((i + 1) % 15 === 0) report({ stage: 'assembling', message: `正在按真实时长编码第 ${i + 1}/${frames.length} 帧` });
    if (directoryBytes(clipDir) > maxTemp) throw fail('TEMP_BYTES_LIMIT', 'VFR 片段字节超过 max_temp_bytes');
    return clip;
  });
  const clipList = path.join(outDir, 'clips.ffconcat');
  writeFileConcatList(clipList, clips);
  const packed = path.join(outDir, 'assembled-video.mkv');
  await runProcess(ffmpeg, [
    '-nostdin', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', clipList, '-c', 'copy', packed,
  ], { timeout: 10 * 60 * 1000, failCode: 'ASSEMBLE_ENCODE' });
  return { videoPath: packed, fps: null, mode: 'clip_concat_vfr', frame_count: frames.length, clip_count: clips.length };
}

async function muxAssembledOutput(ffmpeg, videoPath, audioInput, audioFilter, outputPath, plannedDuration) {
  const args = ['-nostdin', '-y', '-v', 'error', '-i', videoPath];
  if (audioInput) {
    args.push('-i', audioInput, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-af', audioFilter, '-c:a', 'aac');
  } else {
    args.push('-map', '0:v:0', '-c:v', 'copy');
  }
  args.push('-t', String(plannedDuration), '-movflags', '+faststart', outputPath);
  await runProcess(ffmpeg, args, { timeout: 180000, failCode: 'ASSEMBLE_ENCODE' });
}

function audioFilters(baseOffset, extraOffset, duration) {
  const offset = (Number(baseOffset) || 0) + (Number(extraOffset) || 0);
  const filters = ['asetpts=PTS-STARTPTS'];
  if (offset > 0.0005) filters.push(`adelay=${Math.round(offset * 1000)}:all=1`);
  else if (offset < -0.0005) filters.push(`atrim=start=${-offset}`, 'asetpts=PTS-STARTPTS');
  filters.push('apad', `atrim=duration=${duration}`);
  return { offset, filters };
}

async function extractStillByIndex(ffmpeg, inputPath, index, outputPath) {
  await runProcess(ffmpeg, [
    '-nostdin', '-y', '-v', 'error', '-i', inputPath,
    '-vf', `select=eq(n\\,${Number(index)})`, '-frames:v', '1', outputPath,
  ], { timeout: 60000, failCode: 'COMPARISON_FRAME' });
}

async function extractStillByPts(ffmpeg, inputPath, pts, outputPath) {
  await runProcess(ffmpeg, [
    '-nostdin', '-y', '-v', 'error', '-copyts', '-i', inputPath,
    '-vf', `select=eq(pts\\,${Number(pts)})`, '-frames:v', '1', '-fps_mode', 'passthrough', outputPath,
  ], { timeout: 60000, failCode: 'COMPARISON_FRAME' });
}

function extraAssembleSources(moduleId, parameters = {}, inputPath = '') {
  if (moduleId !== 'local.video.assemble-frames') return [];
  const extras = [];
  const manifestDir = path.dirname(path.resolve(inputPath));
  const add = (role, file) => {
    if (!file) return;
    const resolved = path.resolve(manifestDir, file);
    if (!extras.some(item => item.path === resolved) && fs.existsSync(resolved)) {
      extras.push({ role, path: resolved });
    }
  };
  let manifest = null;
  try {
    if (inputPath && fs.existsSync(inputPath)) {
      manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, ''));
    }
  } catch {
    return extras;
  }
  add('source_video', manifest?.source?.path);
  add('source_audio', parameters.audio_path || manifest?.audio?.path);
  for (const item of parameters.replacements || []) add('replacement', item.path);
  return extras;
}

async function exportFrames({ inputPath, outputPath, parameters = {}, components, report = () => {} }) {
  const p = exportSettings(parameters);
  const bins = ffmpegBins(components);
  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  assertNotSourceOverwrite(outputPath, inputPath);
  const media = await probeMedia(bins.ffprobe, inputPath);
  if (media.pixels > p.max_pixels) throw fail('PIXELS_LIMIT', `画面 ${media.width}x${media.height} 超过 max_pixels`);
  if (media.stream_duration > p.max_duration || media.format_duration > p.max_duration + Math.abs(media.origin) + 1) {
    // format_duration on offset containers can be an end timestamp; still bound obvious oversize.
    if (media.stream_duration > p.max_duration) throw fail('DURATION_LIMIT', '视频流时长超过 max_duration');
  }
  report({ stage: 'exporting_frames', message: '正在按真实 PTS 导出 PNG 序列' });
  const framesDir = path.join(outDir, 'frames');
  const pts = await exportPngSequence(bins.ffmpeg, inputPath, framesDir, p, report);
  const hashed = await hashAndMeasureFrames(framesDir, pts, media, p);
  const timeline = timelineFromFrames(hashed.frames, media);
  if (timeline.content_duration > p.max_duration + 1e-6) throw fail('DURATION_LIMIT', 'PTS 跨度超过 max_duration');
  if (timeline.avg_frame_rate_guess_seconds && Math.abs(timeline.avg_frame_rate_guess_seconds - timeline.content_duration) > 0.05) {
    timeline.avg_frame_rate_would_distort = true;
  }
  let audio = null;
  if (p.keep_audio && media.has_audio) {
    report({ stage: 'exporting_audio', message: '正在保存原音轨' });
    audio = await extractSourceAudio(bins.ffmpeg, inputPath, path.join(outDir, 'audio'), media);
    audio = {
      ...audio,
      start_time: Number.isFinite(media.audio_start_time) ? round(media.audio_start_time) : 0,
      video_start_time: round(media.video_start_time),
      relative_offset_seconds: round((Number(media.audio_start_time) || 0) - media.video_start_time),
      source_codec: media.audio_codec,
      sha256: await sha256File(audio.path),
    };
  }
  const sourceSha = await sha256File(inputPath);
  const document = {
    schema: SCHEMA_VERSION,
    module_id: 'local.video.export-frames',
    limitations: LIMITATIONS,
    source: {
      path: path.resolve(inputPath),
      identity: fileIdentity(inputPath),
      sha256: sourceSha,
      width: media.width,
      height: media.height,
      r_frame_rate: media.r_frame_rate,
      avg_frame_rate: media.avg_frame_rate,
      time_base: media.time_base,
      has_audio: media.has_audio,
    },
    timeline,
    audio,
    frames: hashed.frames,
    frame_count: hashed.frames.length,
    temp_bytes: hashed.bytes + (audio ? fs.statSync(path.join(outDir, audio.file)).size : 0),
    parameters: p,
  };
  writeJson(outputPath, document);
  const assets = [
    { file: hashed.frames[0].file, type: 'image', role: 'first_frame', title: '导出首帧' },
    { file: hashed.frames.at(-1).file, type: 'image', role: 'last_frame', title: '导出末帧' },
  ];
  if (audio) assets.push({ file: audio.file, type: 'audio', role: 'source_audio', title: '原音轨' });
  return {
    before: { width: media.width, height: media.height, has_audio: media.has_audio, origin: media.origin },
    after: { format: 'json', frame_count: hashed.frames.length, pts_span: timeline.pts_span, vfr: timeline.vfr },
    timeline,
    audio_handling: audio ? [{ mode: audio.codec, offset_seconds: audio.relative_offset_seconds }] : [],
    quality_status: 'review_required',
    quality_note: '已按真实 PTS 导出可编辑 PNG；改帧后必须授权新哈希再回组。不是角色替换。',
    assets,
    limitations: LIMITATIONS,
  };
}

async function assembleFrames({ inputPath, outputPath, parameters = {}, components, sources = [], report = () => {} }) {
  const p = assembleSettings(parameters);
  const bins = ffmpegBins(components);
  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  for (const source of sources) {
    if (!source?.path || !source.identity) continue;
    const current = fileIdentity(source.path);
    if (!identitiesEqual(source.identity, current)) {
      throw fail('INPUT_CHANGED', `排队期间素材已变化（${source.role || 'source'}），请用当前素材建立新处理请求`);
    }
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^﻿/, '')); }
  catch { throw fail('MANIFEST_INVALID', '无法解析帧序列清单 JSON'); }
  if (manifest.schema !== SCHEMA_VERSION || !Array.isArray(manifest.frames) || !manifest.frames.length) {
    throw fail('MANIFEST_INVALID', `清单 schema 必须是 ${SCHEMA_VERSION} 且含有 frames`);
  }
  const manifestDir = path.dirname(path.resolve(inputPath));
  const sourcePath = manifest.source?.path ? path.resolve(manifestDir, manifest.source.path) : null;
  if (sourcePath) {
    assertNotSourceOverwrite(outputPath, sourcePath);
    if (fs.existsSync(sourcePath)) {
      const current = fileIdentity(sourcePath);
      if (manifest.source.identity && !identitiesEqual(manifest.source.identity, current)) {
        throw fail('INPUT_CHANGED', '排队期间源视频身份已变化，请用当前素材重新导出');
      }
    }
  }
  if (manifest.frames.length > p.max_frames) throw fail('FRAMES_LIMIT', '清单帧数超过 max_frames');
  const ordered = [...manifest.frames].sort((a, b) => a.index - b.index);
  if (ordered.some((frame, i) => frame.index !== i)) throw fail('FRAME_INDEX_GAP', '帧 index 必须从 0 连续递增，缺帧或乱序已拒绝');
  const ptsSeen = new Set();
  for (const frame of ordered) {
    if (ptsSeen.has(frame.pts_time)) throw fail('DUPLICATE_PTS', `清单含重复 pts_time=${frame.pts_time}`);
    ptsSeen.add(frame.pts_time);
    if (frame.width * frame.height > p.max_pixels) throw fail('PIXELS_LIMIT', `帧 ${frame.index} 像素超过上限`);
  }
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].pts_time < ordered[i - 1].pts_time) throw fail('PTS_NOT_MONOTONIC', '清单 PTS 乱序');
    if (ordered[i].width !== ordered[0].width || ordered[i].height !== ordered[0].height) {
      throw fail('FRAME_SIZE_MISMATCH', `帧 ${ordered[i].index} 尺寸 ${ordered[i].width}x${ordered[i].height} 与首帧不一致`);
    }
  }
  const replacements = replacementMap(p.replacements);
  if ([...replacements.keys()].some(index => index < 0 || index >= ordered.length)) throw fail('FRAME_SEQUENCE_INPUT', '替换帧 index 超出清单范围');
  report({ stage: 'authorizing_frames', message: `正在核对 ${ordered.length} 帧哈希与路径归属` });
  const authorized = [];
  for (const frame of ordered) {
    authorized.push(await authorizeFrame(frame, manifestDir, replacements));
  }
  const firstSize = await probeImageSize(bins.ffprobe, authorized[0].path);
  if (!firstSize.width || !firstSize.height) throw fail('FRAME_SEQUENCE_PROBE', '无法读取帧尺寸');
  if (firstSize.width % 2 || firstSize.height % 2) {
    // x264 yuv420p needs even canvas; fail instead of silently pad/crop time or picture.
    throw fail('FRAME_SIZE_MISMATCH', `回组需要偶数宽高，实际 ${firstSize.width}x${firstSize.height}`);
  }
  for (const frame of authorized.filter(item => item.replaced)) {
    const size = await probeImageSize(bins.ffprobe, frame.path);
    if (size.width !== firstSize.width || size.height !== firstSize.height) {
      throw fail('FRAME_SIZE_MISMATCH', `替换帧 ${frame.index} 尺寸 ${size.width}x${size.height} 与序列不一致`);
    }
  }
  const timeline = manifest.timeline || timelineFromFrames(ordered, {
    origin: manifest.source ? 0 : ordered[0].pts_time,
    time_base: ordered[0].time_base,
    r_frame_rate: manifest.source?.r_frame_rate,
    avg_frame_rate: manifest.source?.avg_frame_rate,
  });
  if (timeline.content_duration > p.max_duration + 1e-6) throw fail('DURATION_LIMIT', '回组时长超过 max_duration');
  const durations = planFrameDurations(authorized, {
    timing_strategy: p.timing_strategy,
    duration_policy: p.duration_policy,
    cfr_fps: p.cfr_fps,
    r_frame_rate: timeline.r_frame_rate || manifest.source?.r_frame_rate,
    avg_frame_rate: timeline.avg_frame_rate,
    vfr: timeline.vfr,
    pts_span: timeline.pts_span,
    time_base: timeline.time_base,
  });
  const plannedDuration = durations.reduce((sum, value) => sum + value, 0);
  if (p.timing_strategy === 'pts' && Math.abs(plannedDuration - timeline.pts_span) > 0.02) {
    throw fail('FRAME_SEQUENCE_TIME', `按 PTS 映射的总时长 ${round(plannedDuration)} 与原跨度 ${timeline.pts_span} 不一致`);
  }
  if (directoryBytes(path.join(manifestDir, 'frames')) > p.max_temp_bytes) {
    throw fail('TEMP_BYTES_LIMIT', '回组临时字节超过 max_temp_bytes');
  }
  report({ stage: 'assembling', message: `正在按 ${p.timing_strategy} 回组 ${authorized.length} 帧` });
  const encoded = await encodeAssembledVideo(
    bins.ffmpeg, authorized, durations, outDir, plannedDuration, p.max_temp_bytes, report,
    { cfr_fps: p.cfr_fps, r_frame_rate: timeline.r_frame_rate || manifest.source?.r_frame_rate },
  );
  const encodedPackets = await countStreamPackets(bins.ffprobe, encoded.videoPath, 'v:0');
  if (encodedPackets !== authorized.length) {
    throw fail('OUTPUT_TIMING', `回组视频包数 ${encodedPackets} 与清单帧数 ${authorized.length} 不一致；拒绝末帧重复造成的额外帧`);
  }
  const audioPath = p.audio_path
    ? path.resolve(manifestDir, p.audio_path)
    : (manifest.audio?.path ? path.resolve(manifestDir, manifest.audio.path) : null);
  let audioHandling = [];
  const audioExists = audioPath && fs.existsSync(audioPath);
  if (p.keep_audio && p.audio_path && !audioExists) throw fail('AUDIO_MISSING', '找不到指定的 audio_path，请检查新配音路径');
  if (p.keep_audio && audioExists && !p.audio_path && manifest.audio?.sha256 && await sha256File(audioPath) !== manifest.audio.sha256) {
    throw fail('INPUT_CHANGED', '导出原音轨已改变；请使用 audio_path 明确选择新的配音或重新导出');
  }
  let audioInput = null;
  if (p.keep_audio && (audioExists || manifest.source?.has_audio && sourcePath && fs.existsSync(sourcePath))) {
    audioInput = audioExists ? audioPath : sourcePath;
    const baseOffset = manifest.audio?.relative_offset_seconds ?? 0;
    const planned = audioFilters(baseOffset, p.audio_offset_seconds, plannedDuration);
    audioHandling = [{ mode: 'encode_aac', offset_seconds: planned.offset, source: audioExists ? 'extracted' : 'original_video' }];
    await muxAssembledOutput(bins.ffmpeg, encoded.videoPath, audioInput, planned.filters.join(','), outputPath, plannedDuration);
  } else {
    if (p.keep_audio && manifest.source?.has_audio) {
      throw fail('AUDIO_MISSING', '清单声明有音轨，但找不到可回放的原音频文件');
    }
    await muxAssembledOutput(bins.ffmpeg, encoded.videoPath, null, null, outputPath, plannedDuration);
  }
  const after = await probeMedia(bins.ffprobe, outputPath);
  const outputDuration = after.stream_duration > 0
    ? after.stream_duration
    : (after.format_duration > 0 ? after.format_duration - after.origin : 0);
  if (!(outputDuration > 0)) throw fail('OUTPUT_UNPLAYABLE', '回组视频没有正时长');
  if (Math.abs(outputDuration - plannedDuration) > 0.05) {
    throw fail('OUTPUT_TIMING', `回组时长 ${round(outputDuration)}s 与计划 ${round(plannedDuration)}s 相差过大`);
  }
  const outputPackets = await countStreamPackets(bins.ffprobe, outputPath, 'v:0');
  if (outputPackets !== authorized.length) {
    throw fail('OUTPUT_TIMING', `成片视频包数 ${outputPackets} 与清单帧数 ${authorized.length} 不一致（计划 ${round(plannedDuration)}s，探测 ${round(outputDuration)}s）`);
  }
  if (audioHandling.length && !after.has_audio) throw fail('OUTPUT_UNPLAYABLE', '回组结果缺少音轨');
  const compareDir = path.join(outDir, 'compare');
  fs.mkdirSync(compareDir, { recursive: true });
  const replaced = authorized.filter(frame => frame.replaced).slice(0, p.comparison_count);
  const compareTargets = replaced.length ? replaced : [authorized[0], authorized[Math.floor(authorized.length / 2)], authorized.at(-1)].filter(Boolean).slice(0, p.comparison_count);
  const assets = [];
  for (const frame of compareTargets) {
    const afterStill = path.join(compareDir, `assembled-${String(frame.index).padStart(6, '0')}.png`);
    await extractStillByIndex(bins.ffmpeg, outputPath, frame.index, afterStill);
    assets.push({
      file: path.relative(outDir, afterStill).replaceAll('\\', '/'),
      type: 'image',
      role: frame.replaced ? 'replaced_frame_after' : 'timeline_still',
      title: `回组第 ${frame.index} 帧 @ ${frame.pts_time}s`,
    });
    if (sourcePath && fs.existsSync(sourcePath)) {
      const beforeStill = path.join(compareDir, `source-${String(frame.index).padStart(6, '0')}.png`);
      try {
        await extractStillByPts(bins.ffmpeg, sourcePath, frame.pts, beforeStill);
        assets.push({
          file: path.relative(outDir, beforeStill).replaceAll('\\', '/'),
          type: 'image',
          role: 'replaced_frame_before',
          title: `源第 ${frame.index} 帧 @ ${frame.pts_time}s`,
        });
      } catch {
        // Source seek can fail on odd containers; stills from the assembled file remain.
      }
    }
  }
  const assembleManifest = {
    schema: SCHEMA_VERSION,
    module_id: 'local.video.assemble-frames',
    timing_strategy: p.timing_strategy,
    duration_policy: p.duration_policy,
    planned_duration: round(plannedDuration),
    output_duration: round(outputDuration),
    pts_span: timeline.pts_span,
    replaced_indexes: authorized.filter(frame => frame.replaced).map(frame => frame.index),
    audio_handling: audioHandling,
    encode_mode: encoded.mode,
    frame_count: authorized.length,
    video_packets: outputPackets,
    limitations: LIMITATIONS,
  };
  for (const frame of authorized) {
    if (await sha256File(frame.path) !== frame.sha256) throw fail('INPUT_CHANGED', `回组期间第 ${frame.index} 帧发生变化，请核对素材后继续`);
  }
  writeJson(path.join(outDir, 'assemble-manifest.json'), assembleManifest);
  assets.unshift({ file: 'assemble-manifest.json', type: 'document', role: 'assemble_manifest', title: '回组清单' });
  return {
    before: { frame_count: authorized.length, pts_span: timeline.pts_span, vfr: timeline.vfr },
    after: { duration: round(outputDuration), has_audio: after.has_audio, width: after.width, height: after.height },
    audio_handling: audioHandling,
    quality_status: 'review_required',
    quality_note: '已按授权帧与所选时序策略回组；请核对照片切点、改帧位置和音画相对起点。不是角色替换。',
    assets,
    limitations: LIMITATIONS,
    replaced_indexes: assembleManifest.replaced_indexes,
  };
}

const exportParameterSchema = {
  type: 'object',
  properties: {
    keep_audio: { type: 'boolean', default: true, title: '保存原音轨' },
    max_frames: { type: 'integer', minimum: 1, maximum: 200000, default: 3600, title: '最大导出帧数' },
    max_pixels: { type: 'integer', minimum: 256, maximum: 16777216, default: 1920 * 1088, title: '单帧像素上限' },
    max_duration: { type: 'number', minimum: 0.04, maximum: 3600, default: 120, title: '最大时长秒' },
    max_temp_bytes: { type: 'integer', minimum: 1048576, maximum: 17179869184, default: 2147483648, title: '临时字节上限' },
  },
};

const assembleParameterSchema = {
  type: 'object',
  properties: {
    timing_strategy: { type: 'string', enum: ['pts', 'bounded_cfr'], default: 'pts', title: '时序策略' },
    duration_policy: { type: 'string', enum: ['strict', 'preserve_pts_span'], default: 'preserve_pts_span', title: '时长策略' },
    cfr_fps: { type: 'number', minimum: 1, maximum: 120, title: '有界 CFR 帧率（不用 avg_frame_rate）' },
    keep_audio: { type: 'boolean', default: true, title: '回放原音轨' },
    audio_offset_seconds: { type: 'number', minimum: -30, maximum: 30, default: 0, title: '相对清单偏移再叠加的秒数' },
    audio_path: { type: 'string', title: '覆盖音轨路径' },
    replacements: {
      type: 'array',
      title: '授权改帧（index + path + 新 sha256）',
      items: {
        type: 'object',
        required: ['index', 'path', 'sha256'],
        properties: {
          index: { type: 'integer', minimum: 0 },
          path: { type: 'string' },
          sha256: { type: 'string', minLength: 64, maxLength: 64 },
        },
      },
    },
    max_frames: { type: 'integer', minimum: 1, maximum: 200000, default: 3600 },
    max_pixels: { type: 'integer', minimum: 256, maximum: 16777216, default: 1920 * 1088 },
    max_duration: { type: 'number', minimum: 0.04, maximum: 3600, default: 120 },
    max_temp_bytes: { type: 'integer', minimum: 1048576, maximum: 17179869184, default: 2147483648 },
  },
};

const exportFramesOperation = {
  id: 'local.video.export-frames',
  title: '逐帧导出可编辑 PNG 序列',
  description: 'Decode a local video with passthrough timestamps, write PNG frames with real PTS/time_base/duration/SHA, and optionally keep the original audio.',
  description_zh: '按真实 PTS 导出可编辑 PNG 与清单，可选保存原音轨；不是抽关键帧，也不是角色替换。',
  kind: 'document',
  phase: 'edit',
  output_extension: 'json',
  component_id: 'media.ffmpeg',
  source: 'https://ffmpeg.org/ffmpeg-filters.html#showinfo',
  defaults: { keep_audio: true },
  inputs: ['input_path', 'parameters'],
  executeNative: exportFrames,
  validateParameters: exportSettings,
  parameter_schema: exportParameterSchema,
};

const assembleFramesOperation = {
  id: 'local.video.assemble-frames',
  title: '按清单回组帧序列',
  description: 'Reassemble an exported frame sequence, allowing authorized replacement hashes, configurable PTS or bounded-CFR timing, and original audio with relative offset.',
  description_zh: '按 PTS 或有界 CFR 把 PNG 序列回组成片，支持授权改帧和原音轨相对偏移；缺帧/未授权哈希/路径逃逸会失败。',
  kind: 'video',
  phase: 'edit',
  output_extension: 'mp4',
  component_id: 'media.ffmpeg',
  source: 'https://ffmpeg.org/ffmpeg-formats.html#concat',
  defaults: { timing_strategy: 'pts', keep_audio: true, audio_offset_seconds: 0 },
  inputs: ['input_path', 'parameters', 'sources'],
  executeNative: assembleFrames,
  validateParameters: assembleSettings,
  parameter_schema: assembleParameterSchema,
};

module.exports = {
  SCHEMA_VERSION,
  LIMITATIONS,
  parseRate,
  parseShowinfoLine,
  frameDurationSeconds,
  concatEscape,
  concatEntry,
  writeConcatList,
  constantFrameRate,
  mapPool,
  planFrameDurations,
  timelineFromFrames,
  replacementMap,
  extraAssembleSources,
  exportSettings,
  assembleSettings,
  audioFilters,
  exportFrames,
  assembleFrames,
  exportFramesOperation,
  assembleFramesOperation,
};
