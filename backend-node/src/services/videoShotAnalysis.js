const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');

const fail = (code, message) => Object.assign(new Error(message), { code });
const round = n => Math.round(Number(n) * 1000000) / 1000000;
const LIMITATIONS = [
  '切点来自缩小画面的像素差与亮度直方图，不是镜头语义、角色识别或转场类型判断。',
  '运动强度、亮度、对比度只描述像素变化，不能当作高光分数或自动优秀 MAD/Vlog 证明。',
  '淡入淡出、闪白、相似机位、字幕闪动和强压缩噪声可能漏切或误切，必须看接触表复核。',
  '黑场/静帧是亮度与帧差阈值结果：夜景、暗场演出、定机位讲话可能被标出，不等于废镜头。',
  '无音轨时本工具不会发明节拍；与 local.audio.analyze-beats 的合成只做时间邻近对照。',
  '纯蓝等低 Rec.709 亮度原色可能低于默认 black_luma；黑场是亮度阈值，不是“夜景/废片”语义。',
]

function number(value, fallback, min, max, name, integer = false) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw fail('SHOT_ANALYSIS_INPUT', `${name} 应在 ${min} 到 ${max} 之间${integer ? '的整数' : ''}`);
  }
  return n;
}

function settings(p = {}) {
  const result = {
    sample_fps: number(p.sample_fps, 8, 0, 30, '采样帧率'),
    analysis_width: number(p.analysis_width, 160, 32, 640, '分析宽度', true),
    analysis_height: number(p.analysis_height, 90, 18, 360, '分析高度', true),
    scene_threshold: number(p.scene_threshold, 0.22, 0.02, 0.9, '切点阈值'),
    min_shot_seconds: number(p.min_shot_seconds, 0.2, 0.04, 30, '最短镜头秒'),
    black_luma: number(p.black_luma, 0.08, 0, 0.5, '黑场亮度上限'),
    min_black_seconds: number(p.min_black_seconds, 0.2, 0.04, 30, '最短黑场秒'),
    freeze_motion: number(p.freeze_motion, 0.012, 0, 0.3, '静帧运动上限'),
    min_freeze_seconds: number(p.min_freeze_seconds, 0.4, 0.08, 30, '最短静帧秒'),
    max_duration: number(p.max_duration, 1800, 0.2, 14400, '分析时长上限秒'),
    max_frames: number(p.max_frames, 18000, 8, 200000, '分析帧数上限', true),
    max_keyframes: number(p.max_keyframes, 24, 2, 80, '关键帧上限', true),
    thumbnail_width: number(p.thumbnail_width, 160, 64, 480, '接触表单元格宽', true),
    contact_columns: number(p.contact_columns, 4, 2, 8, '接触表列数', true),
  };
  if (result.analysis_width % 2 || result.analysis_height % 2) {
    throw fail('SHOT_ANALYSIS_INPUT', '分析宽高需要为偶数，避免色度取样错位');
  }
  return result;
}

function formatTimecode(seconds) {
  const sign = seconds < 0 ? '-' : '';
  const t = Math.abs(Number(seconds));
  if (!Number.isFinite(t)) throw fail('SHOT_ANALYSIS_TIME', '时间码不是有限秒数');
  const ms = Math.round(t * 1000);
  const milli = ms % 1000;
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${sign}${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
}

function parseRate(value) {
  if (value == null || value === 'N/A' || value === '0/0') return null;
  const text = String(value);
  if (text.includes('/')) {
    const [a, b] = text.split('/').map(Number);
    if (!b) return null;
    return a / b;
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
  if (Number.isFinite(info?.duration_time) && info.duration_time >= 0) return info.duration_time;
  const tb = parseRate(timeBase);
  if (tb && Number.isFinite(info?.duration)) return info.duration * tb;
  return null;
}

function hellinger(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.sqrt(a[i] * b[i]);
  return Math.sqrt(Math.max(0, 1 - sum));
}

function frameMetrics(buffer, width, height, previousBuffer, previousStats) {
  const pixels = width * height;
  const hist = new Float64Array(16);
  let lumaSum = 0, lumaSq = 0, madSum = 0;
  for (let i = 0, p = 0; p < pixels; i += 3, p++) {
    const r = buffer[i], g = buffer[i + 1], b = buffer[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma;
    lumaSq += luma * luma;
    hist[Math.min(15, luma >> 4)]++;
    if (previousBuffer) {
      madSum += Math.abs(r - previousBuffer[i]) + Math.abs(g - previousBuffer[i + 1]) + Math.abs(b - previousBuffer[i + 2]);
    }
  }
  const meanLuma = lumaSum / pixels / 255;
  const variance = Math.max(0, lumaSq / pixels - (lumaSum / pixels) ** 2);
  for (let i = 0; i < 16; i++) hist[i] /= pixels;
  const motion = previousBuffer ? madSum / (pixels * 3 * 255) : 0;
  const lumaDelta = previousStats ? Math.abs(meanLuma - previousStats.luma) : 0;
  const histDistance = previousStats ? hellinger(hist, previousStats.hist) : 0;
  const score = previousStats ? 0.55 * motion + 0.35 * histDistance + 0.10 * lumaDelta : 0;
  return {
    luma: meanLuma,
    luma_std: Math.sqrt(variance) / 255,
    motion,
    score,
    hist,
  };
}

function runIntervals(samples, field, limit, minDuration, below) {
  const intervals = [];
  let start = null, last = null, sum = 0, count = 0;
  const close = () => {
    if (start == null || last == null || count === 0) return;
    const duration = last.seconds - start.seconds;
    if (duration + 1e-9 >= minDuration) {
      intervals.push({
        start: round(start.seconds),
        end: round(last.seconds),
        start_source: round(start.source_seconds),
        end_source: round(last.source_seconds),
        start_timecode: formatTimecode(start.seconds),
        end_timecode: formatTimecode(last.seconds),
        duration: round(duration),
        mean: round(sum / count),
      });
    }
    start = null; last = null; sum = 0; count = 0;
  };
  for (const sample of samples) {
    const hit = below ? sample[field] <= limit : sample[field] >= limit;
    if (hit) {
      if (!start) start = sample;
      last = sample;
      sum += sample[field];
      count++;
    } else close();
  }
  close();
  return intervals;
}

function clipEndFromLastFrame(lastFrame, origin = 0, timeBase = null) {
  if (!lastFrame || !Number.isFinite(lastFrame.pts_time)) return null;
  const frameDur = frameDurationSeconds(lastFrame, timeBase);
  if (!(frameDur >= 0)) return null;
  return round(lastFrame.pts_time + frameDur - origin);
}

function clipEndSeconds(samples, duration, origin = 0, lastFrame = null, timeBase = null) {
  const last = samples.at(-1);
  if (!last) return 0;
  const fromFrame = clipEndFromLastFrame(lastFrame, origin, timeBase);
  if (fromFrame != null && fromFrame >= last.seconds - 1e-9) return fromFrame;
  if (duration > 0) return round(duration);
  const sampleDur = frameDurationSeconds(last, timeBase);
  if (sampleDur > 0) return round(last.seconds + sampleDur);
  return last.seconds;
}

function analyzeSamples(samples, p, origin = 0, clipEnd = null) {
  if (!samples.length) throw fail('SHOT_ANALYSIS_EMPTY', '没有可分析的视频帧');
  const cuts = [];
  const shots = [];
  let shotStart = samples[0];
  let lastCut = samples[0].seconds;
  let sumMotion = 0, maxMotion = 0, maxMotionAt = samples[0];
  let sumLuma = 0, sumLumaSq = 0, blackFrames = 0, freezeFrames = 0, frameCount = 0;

  const closeShot = (endSample, reason) => {
    const end = endSample.seconds;
    const duration = Math.max(0, end - shotStart.seconds);
    const meanMotion = frameCount ? sumMotion / frameCount : 0;
    const meanLuma = frameCount ? sumLuma / frameCount : 0;
    const lumaVar = frameCount ? Math.max(0, sumLumaSq / frameCount - meanLuma * meanLuma) : 0;
    shots.push({
      id: `S${String(shots.length + 1).padStart(3, '0')}`,
      index: shots.length,
      start: round(shotStart.seconds),
      end: round(end),
      start_source: round(shotStart.source_seconds),
      end_source: round(endSample.source_seconds),
      start_timecode: formatTimecode(shotStart.seconds),
      end_timecode: formatTimecode(end),
      duration: round(duration),
      sample_count: frameCount,
      mean_motion: round(meanMotion),
      max_motion: round(maxMotion),
      max_motion_seconds: round(maxMotionAt.seconds),
      mean_luma: round(meanLuma),
      luma_std: round(Math.sqrt(lumaVar)),
      black_ratio: round(frameCount ? blackFrames / frameCount : 0),
      freeze_ratio: round(frameCount ? freezeFrames / frameCount : 0),
      close_reason: reason,
    });
  };

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const isCut = i > 0
      && sample.score >= p.scene_threshold
      && sample.seconds - lastCut >= p.min_shot_seconds;
    if (isCut) {
      closeShot(sample, 'scene_cut');
      cuts.push({
        seconds: round(sample.seconds),
        source_seconds: round(sample.source_seconds),
        timecode: formatTimecode(sample.seconds),
        score: round(sample.score),
        motion: round(sample.motion),
        luma: round(sample.luma),
      });
      shotStart = sample;
      lastCut = sample.seconds;
      sumMotion = 0; maxMotion = 0; maxMotionAt = sample;
      sumLuma = 0; sumLumaSq = 0; blackFrames = 0; freezeFrames = 0; frameCount = 0;
    }
    sumMotion += sample.motion;
    sumLuma += sample.luma;
    sumLumaSq += sample.luma * sample.luma;
    if (sample.motion > maxMotion) { maxMotion = sample.motion; maxMotionAt = sample; }
    if (sample.luma <= p.black_luma) blackFrames++;
    if (sample.motion <= p.freeze_motion) freezeFrames++;
    frameCount++;
  }
  const last = samples.at(-1);
  const endSeconds = clipEnd != null && clipEnd > last.seconds ? clipEnd : last.seconds;
  const eofSample = endSeconds === last.seconds ? last : {
    ...last,
    seconds: endSeconds,
    source_seconds: round(origin + endSeconds),
  };
  closeShot(eofSample, 'eof');
  if (shots.length) {
    shots.at(-1).end_basis = endSeconds > last.seconds ? 'last_frame_pts_duration' : 'last_sample';
    shots.at(-1).last_sample_seconds = round(last.seconds);
    shots.at(-1).clip_end_seconds = round(endSeconds);
  }

  const black = runIntervals(samples, 'luma', p.black_luma, p.min_black_seconds, true).map(({ mean, ...rest }) => ({ ...rest, mean_luma: mean }));
  const freeze = runIntervals(samples, 'motion', p.freeze_motion, p.min_freeze_seconds, true).map(({ mean, ...rest }) => ({ ...rest, mean_motion: mean }));
  return {
    shots,
    cuts,
    black_intervals: black,
    freeze_intervals: freeze,
    source_timeline_origin: origin,
  };
}

function selectKeyframes(samples, analysis, p) {
  const chosen = [];
  const used = new Set();
  const add = (sample, role, shotId) => {
    if (!sample) return;
    const key = round(sample.seconds).toFixed(6);
    if (used.has(key)) {
      const existing = chosen.find(item => item.seconds === round(sample.seconds));
      if (existing && !existing.roles.includes(role)) existing.roles.push(role);
      return;
    }
    if (chosen.length >= p.max_keyframes) return;
    used.add(key);
    chosen.push({
      id: `K${String(chosen.length + 1).padStart(3, '0')}`,
      seconds: round(sample.seconds),
      source_seconds: round(sample.source_seconds),
      source_pts: Number.isFinite(sample.source_pts) ? sample.source_pts : null,
      timecode: formatTimecode(sample.seconds),
      luma: round(sample.luma),
      motion: round(sample.motion),
      roles: [role],
      shot_id: shotId || null,
    });
  };
  const nearest = seconds => {
    let best = samples[0], dist = Infinity;
    for (const sample of samples) {
      const d = Math.abs(sample.seconds - seconds);
      if (d < dist) { best = sample; dist = d; }
    }
    return best;
  };
  add(samples[0], 'head', analysis.shots[0]?.id);
  for (const shot of analysis.shots) {
    add(nearest(shot.start), 'shot_start', shot.id);
    if (shot.duration >= p.min_shot_seconds * 2) add(nearest(shot.max_motion_seconds), 'shot_peak_motion', shot.id);
  }
  add(samples.at(-1), 'tail', analysis.shots.at(-1)?.id);
  return chosen;
}

function compressEnvelope(samples, limit = 1200) {
  const stride = Math.max(1, Math.ceil(samples.length / limit));
  const points = [];
  for (let i = 0; i < samples.length; i += stride) {
    const group = samples.slice(i, i + stride);
    points.push({
      seconds: round(group[0].seconds),
      motion: round(Math.max(...group.map(s => s.motion))),
      luma: round(group.reduce((a, s) => a + s.luma, 0) / group.length),
    });
  }
  return points;
}

function alignShotsWithBeats(shots, onsets, { max_distance = 0.12 } = {}) {
  if (!Array.isArray(shots) || !Array.isArray(onsets)) {
    throw fail('SHOT_ANALYSIS_INPUT', '镜头与节拍候选都需要数组；节拍分析请使用已有 local.audio.analyze-beats');
  }
  return shots.map(shot => {
    const nearby = onsets.filter(item => Number(item.seconds) >= shot.start - max_distance && Number(item.seconds) <= shot.end + max_distance);
    let nearest = null;
    for (const item of onsets) {
      const distance = Math.abs(Number(item.seconds) - shot.start);
      if (!nearest || distance < nearest.distance) nearest = { seconds: round(item.seconds), strength: item.strength, distance: round(distance) };
    }
    return {
      shot_id: shot.id,
      start: shot.start,
      end: shot.end,
      start_timecode: shot.start_timecode,
      nearby_onset_count: nearby.length,
      nearby_onsets: nearby.slice(0, 24).map(item => ({ seconds: round(item.seconds), strength: item.strength })),
      nearest_onset_to_start: nearest,
      auto_cut: false,
      note: '只做时间邻近对照，不按节拍自动切开，也不证明音乐卡点正确。',
    };
  });
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

function loadSharp(components) {
  const dir = components?.['media.sharp']?.directory;
  if (!dir) throw fail('SHOT_ANALYSIS_INPUT', '需要 media.sharp 组件目录');
  return createRequire(path.join(dir, 'package.json'))('sharp');
}

function runProcess(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeout || 120000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); options.onOutput?.(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); options.onErrorOutput?.(chunk); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if ((options.exitCodes || [0]).includes(code)) resolve({ stdout, stderr, code });
      else reject(fail('SHOT_ANALYSIS_DECODE', `本地进程未完成 (${code}): ${stderr.slice(-1500)}`));
    });
  });
}

function contentDuration(video, format, origin, lastFrame = null, timeBase = null) {
  const fromFrame = clipEndFromLastFrame(lastFrame, origin, timeBase || video?.time_base);
  if (fromFrame > 0) return fromFrame;
  const streamDur = Number(video?.duration);
  if (streamDur > 0) return streamDur;
  const fmtDur = Number(format?.duration);
  if (!(fmtDur > 0)) return 0;
  // Some containers store the last timestamp in format.duration. A 1s clip
  // starting at 5s then reports duration=6, which must not be treated as length.
  if (Math.abs(origin) > 0.001 && fmtDur - origin >= 0.01) return fmtDur - origin;
  return fmtDur;
}

async function probeMedia(ffprobe, inputPath) {
  const result = await runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath], { timeout: 60000 });
  let probe;
  try { probe = JSON.parse(result.stdout); }
  catch { throw fail('SHOT_ANALYSIS_DECODE', 'ffprobe 无法解析该文件'); }
  const video = probe.streams?.find(s => s.codec_type === 'video');
  if (!video) throw fail('SHOT_ANALYSIS_NO_VIDEO', '素材没有视频轨，镜头切分需要画面');
  const audio = probe.streams?.find(s => s.codec_type === 'audio') || null;
  const origin = Number(video.start_time ?? probe.format?.start_time ?? 0);
  if (!Number.isFinite(origin)) throw fail('SHOT_ANALYSIS_TIME', '无法确定素材时间原点');
  const duration = contentDuration(video, probe.format, origin, null, video.time_base);
  const rRate = parseRate(video.r_frame_rate);
  const avgRate = parseRate(video.avg_frame_rate);
  return {
    probe, video, audio,
    duration,
    origin,
    width: Number(video.width) || 0,
    height: Number(video.height) || 0,
    r_frame_rate: video.r_frame_rate || null,
    avg_frame_rate: video.avg_frame_rate || null,
    time_base: video.time_base || null,
    has_audio: Boolean(audio),
    audio_start_time: audio ? Number(audio.start_time ?? 0) : null,
    vfr_hint: rRate && avgRate ? Math.abs(rRate - avgRate) / Math.max(rRate, avgRate) > 0.02 : false,
  };
}

function zipSamplesWithPts(metrics, pts, origin, p) {
  if (metrics.length !== pts.length) {
    throw fail('SHOT_ANALYSIS_DECODE', `帧字节与 showinfo 时间戳数量不一致（frames=${metrics.length}, pts=${pts.length}）。请确认输出使用 fps_mode=passthrough，不要按猜测帧率补帧。`);
  }
  const samples = [];
  let lastPts = null;
  for (let i = 0; i < metrics.length; i++) {
    const ptsTime = pts[i].pts_time;
    if (lastPts != null && ptsTime < lastPts) throw fail('SHOT_ANALYSIS_TIME', '帧时间不递增，请先修复原片时间戳');
    lastPts = ptsTime;
    const relative = ptsTime - origin;
    if (relative > p.max_duration + 1e-6) {
      throw fail('SHOT_ANALYSIS_LIMIT', '素材超过分析时长上限，请分段处理或提高 max_duration');
    }
    samples.push({
      seconds: round(relative),
      source_seconds: round(ptsTime),
      source_pts: pts[i].pts,
      duration: Number.isFinite(pts[i].duration) ? pts[i].duration : null,
      duration_time: Number.isFinite(pts[i].duration_time) ? pts[i].duration_time : null,
      luma: metrics[i].luma,
      luma_std: metrics[i].luma_std,
      motion: metrics[i].motion,
      score: metrics[i].score,
    });
  }
  return samples;
}

function decodeSamples(ffmpeg, inputPath, p, origin, report) {
  const frameBytes = p.analysis_width * p.analysis_height * 3;
  const filters = [`scale=${p.analysis_width}:${p.analysis_height}:flags=area`, 'format=rgb24', 'showinfo'];
  if (p.sample_fps > 0) {
    const gap = round(1 / p.sample_fps);
    filters.unshift(`select='if(eq(n,0),1,gte(t-prev_selected_t,${gap}))'`);
  }
  const args = [
    '-nostdin', '-hide_banner', '-v', 'info', '-nostats', '-threads', '2', '-filter_threads', '1',
    '-copyts', '-protocol_whitelist', 'file,pipe', '-i', inputPath,
    '-an', '-vf', filters.join(','), '-fps_mode', 'passthrough',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const metrics = [];
    const pts = [];
    let stdoutTail = Buffer.alloc(0);
    let stderrTail = '';
    let errorLog = '';
    let previousRgb = null;
    let previousStats = null;
    let failure = null;
    let lastReport = 0;
    const timer = setTimeout(() => { failure = fail('SHOT_ANALYSIS_TIMEOUT', '视频分析超时，请缩短片段或降低采样'); child.kill(); }, 600000);

    child.stdout.on('data', chunk => {
      if (failure) return;
      const buffer = stdoutTail.length ? Buffer.concat([stdoutTail, chunk], stdoutTail.length + chunk.length) : chunk;
      const complete = buffer.length - (buffer.length % frameBytes);
      for (let offset = 0; offset < complete; offset += frameBytes) {
        const rgb = Buffer.from(buffer.subarray(offset, offset + frameBytes));
        const computed = frameMetrics(rgb, p.analysis_width, p.analysis_height, previousRgb, previousStats);
        metrics.push({ luma: computed.luma, luma_std: computed.luma_std, motion: computed.motion, score: computed.score });
        previousRgb = rgb;
        previousStats = computed;
        if (metrics.length > p.max_frames) {
          failure = fail('SHOT_ANALYSIS_LIMIT', '分析帧数超过上限，请降低 sample_fps、缩短片段或提高 max_frames');
          child.kill();
          return;
        }
        if (Date.now() - lastReport > 1000) {
          report({ stage: 'analyzing_video', message: `正在分析画面，已读取 ${metrics.length} 帧`, frames: metrics.length });
          lastReport = Date.now();
        }
      }
      stdoutTail = Buffer.from(buffer.subarray(complete));
    });
    child.stderr.on('data', chunk => {
      const text = String(chunk);
      errorLog = (errorLog + text).slice(-4000);
      const lines = (stderrTail + text).split(/\r?\n/);
      stderrTail = lines.pop();
      for (const line of lines) {
        const info = parseShowinfoLine(line);
        if (info) pts.push(info);
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (stderrTail) {
        const info = parseShowinfoLine(stderrTail);
        if (info) pts.push(info);
      }
      if (failure) return reject(failure);
      if (code !== 0) return reject(fail('SHOT_ANALYSIS_DECODE', `视频未完整解码 (${code})：${errorLog}`));
      if (stdoutTail.length) return reject(fail('SHOT_ANALYSIS_DECODE', `原始帧字节未对齐（tail=${stdoutTail.length}）`));
      try {
        const samples = zipSamplesWithPts(metrics, pts, origin, p);
        if (!samples.length) throw fail('SHOT_ANALYSIS_EMPTY', '解码后没有视频帧');
        resolve(samples);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function xmlText(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function contactLabel(frame) {
  const aliases = { head: 'head', tail: 'tail', shot_start: 'start', shot_peak_motion: 'peak' };
  const roles = (frame.roles || []).map(role => aliases[role] || role).join('+');
  return { line1: `${frame.id} ${frame.timecode}`, line2: roles };
}

function ptsSelect(sourcePts) {
  const pts = Number(sourcePts);
  if (!Number.isFinite(pts) || !Number.isInteger(pts)) {
    throw fail('SHOT_ANALYSIS_TIME', '关键帧缺少有限的整数源 PTS');
  }
  return `'eq(pts,${pts})'`;
}

function uniqueSeekTries(origin, durationHint) {
  const hint = Number(durationHint) > 0 ? Number(durationHint) : 0;
  const tries = [];
  const add = trySpec => {
    const key = JSON.stringify(trySpec);
    if (!tries.some(item => JSON.stringify(item) === key)) tries.push(trySpec);
  };
  if (hint > 2) add({ after: origin + Math.max(0, hint - 2) });
  if (!(Math.abs(origin) > 0.0005) && (hint > 2 || !(hint > 0))) add({ sseof: -2 });
  if (hint > 0 && hint <= 8) add({ after: origin });
  if (!tries.length) add({ after: origin });
  return tries;
}

function collectLastNamedShowinfo(ffmpeg, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'] });
    let last = null;
    let tail = '';
    const timer = setTimeout(() => child.kill(), 60000);
    child.stderr.on('data', chunk => {
      const lines = (tail + String(chunk)).split(/\r?\n/);
      tail = lines.pop();
      for (const line of lines) {
        if (!line.includes('showinfo@clipend')) continue;
        const info = parseShowinfoLine(line);
        if (info) last = info;
      }
    });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      if (tail.includes('showinfo@clipend')) {
        const info = parseShowinfoLine(tail);
        if (info) last = info;
      }
      resolve(last);
    });
  });
}

async function probeLastFrame(ffmpeg, inputPath, origin, durationHint) {
  const tries = uniqueSeekTries(origin, durationHint);
  for (const attempt of tries) {
    const args = ['-nostdin', '-hide_banner', '-v', 'info', '-nostats', '-threads', '2', '-copyts', '-protocol_whitelist', 'file,pipe'];
    if (Number.isFinite(attempt.sseof)) args.push('-sseof', String(attempt.sseof));
    args.push('-i', inputPath);
    if (Number.isFinite(attempt.after)) args.push('-ss', String(attempt.after));
    args.push('-an', '-vf', 'scale=32:18:flags=fast_bilinear,showinfo@clipend', '-fps_mode', 'passthrough', '-f', 'null', '-');
    try {
      const last = await collectLastNamedShowinfo(ffmpeg, args);
      if (last) return last;
    } catch {
      // Next bounded seek; missing last-frame evidence falls back to stream duration.
    }
  }
  return null;
}

async function extractKeyframes(ffmpeg, inputPath, frames, dir, width) {
  if (!frames.length) return;
  const height = -2;
  const outputs = frames.map(frame => path.join(dir, frame.file));
  const labels = frames.map((_, i) => `s${i}`);
  const graph = [`[0:v]split=${frames.length}${labels.map(l => `[${l}]`).join('')}`];
  for (const [i, frame] of frames.entries()) {
    if (!Number.isFinite(frame.source_pts)) throw fail('SHOT_ANALYSIS_TIME', `关键帧 ${frame.id} 缺少整数 source_pts`);
    graph.push(`[${labels[i]}]select=${ptsSelect(frame.source_pts)},scale=${width}:${height}:flags=area[${labels[i]}o]`);
  }
  const args = [
    '-nostdin', '-y', '-v', 'error', '-threads', '2',
    '-copyts', '-i', inputPath,
    '-filter_complex', graph.join(';'),
  ];
  for (const [i, frame] of frames.entries()) {
    args.push('-map', `[${labels[i]}o]`, '-frames:v', '1', '-fps_mode', 'passthrough', outputs[i]);
  }
  await runProcess(ffmpeg, args, { timeout: 600000 });
  for (const [i, frame] of frames.entries()) {
    if (!fs.existsSync(outputs[i]) || !fs.statSync(outputs[i]).size) {
      throw fail('SHOT_ANALYSIS_DECODE', `未能写出关键帧 ${frame.id}`);
    }
  }
}

async function buildContactSheet(sharp, frames, dir, p) {
  const images = [];
  for (const frame of frames) {
    const file = path.join(dir, frame.file);
    const image = sharp(file, { failOn: 'error', limitInputPixels: 40000000 }).rotate();
    const meta = await image.metadata();
    images.push({ frame, meta, file });
  }
  const cellW = Math.max(...images.map(item => item.meta.width || p.thumbnail_width));
  const labelH = 44;
  const cellH = Math.max(...images.map(item => item.meta.height || 90)) + labelH;
  const columns = Math.min(p.contact_columns, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const boardW = columns * cellW;
  const boardH = rows * cellH;
  if (boardW * boardH > 40000000) throw fail('SHOT_ANALYSIS_LIMIT', '接触表像素超过上限，请减少 max_keyframes');
  const composite = [];
  for (const [index, item] of images.entries()) {
    const col = index % columns, row = Math.floor(index / columns);
    const left = col * cellW, top = row * cellH;
    const label = contactLabel(item.frame);
    const svg = `<svg width="${cellW}" height="${labelH}"><rect width="100%" height="100%" fill="#111"/><text x="6" y="16" font-family="Consolas,monospace" font-size="12" fill="#f3f3f3">${xmlText(label.line1)}</text><text x="6" y="34" font-family="Consolas,monospace" font-size="11" fill="#c8c8c8">${xmlText(label.line2)}</text></svg>`;
    composite.push({ input: Buffer.from(svg), left, top });
    composite.push({ input: item.file, left, top: top + labelH });
  }
  const file = 'contact-sheet.png';
  await sharp({ create: { width: boardW, height: boardH, channels: 3, background: '#181818' } })
    .composite(composite)
    .png()
    .toFile(path.join(dir, file));
  return { file, columns, rows, cell_width: cellW, cell_height: cellH, width: boardW, height: boardH };
}

async function executeNative({ inputPath, outputPath, parameters = {}, components, report = () => {} }) {
  const p = settings(parameters);
  const bins = components?.['media.ffmpeg']?.executables;
  if (!bins?.ffmpeg || !bins?.ffprobe) throw fail('SHOT_ANALYSIS_INPUT', '需要 media.ffmpeg 的 ffmpeg/ffprobe');
  const sharp = loadSharp(components);
  sharp.cache(false);
  sharp.concurrency(2);
  report({ stage: 'probe', message: '正在读取视频流时间基，不按猜测帧率换算' });
  const media = await probeMedia(bins.ffprobe, inputPath);
  if (media.duration > p.max_duration) {
    throw fail('SHOT_ANALYSIS_LIMIT', `素材时长 ${round(media.duration)}s 超过上限 ${p.max_duration}s，请分段处理`);
  }
  report({ stage: 'probe_last_frame', message: '正在用命名 showinfo@clipend 读取末帧 PTS 与 duration_time' });
  const lastFrame = await probeLastFrame(bins.ffmpeg, inputPath, media.origin, media.duration);
  media.duration = contentDuration(media.video, media.probe.format, media.origin, lastFrame, media.time_base);
  media.last_frame = lastFrame;
  if (media.duration > p.max_duration) {
    throw fail('SHOT_ANALYSIS_LIMIT', `素材时长 ${round(media.duration)}s 超过上限 ${p.max_duration}s，请分段处理`);
  }
  if (media.width * media.height > 40000000) throw fail('SHOT_ANALYSIS_LIMIT', '源帧超过 4000 万像素，请先缩小或裁切后再分析');
  report({ stage: 'decode', message: '正在流式解码缩小画面并读取 pts_time' });
  const samples = await decodeSamples(bins.ffmpeg, inputPath, p, media.origin, report);
  const clipEnd = clipEndSeconds(samples, media.duration, media.origin, lastFrame, media.time_base);
  const analysis = analyzeSamples(samples, p, media.origin, clipEnd);
  const keyframes = selectKeyframes(samples, analysis, p);
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  report({ stage: 'keyframes', message: `正在一次解码提取 ${keyframes.length} 张可回读关键帧`, total: keyframes.length });
  const assets = [];
  for (const frame of keyframes) {
    frame.file = `${frame.id.toLowerCase()}-${frame.timecode.replaceAll(':', '-').replace('.', '_')}.png`;
  }
  await extractKeyframes(bins.ffmpeg, inputPath, keyframes, dir, p.thumbnail_width);
  for (const frame of keyframes) {
    frame.sha256 = await sha256File(path.join(dir, frame.file));
    assets.push({ file: frame.file, type: 'image', title: `${frame.id} · ${frame.timecode}`, role: 'shot_keyframe' });
  }
  const sheet = await buildContactSheet(sharp, keyframes, dir, p);
  sheet.sha256 = await sha256File(path.join(dir, sheet.file));
  assets.unshift({ file: sheet.file, type: 'image', title: '镜头接触表（看图选片）', role: 'contact_sheet' });
  for (const shot of analysis.shots) {
    shot.keyframe_ids = keyframes.filter(frame => frame.shot_id === shot.id).map(frame => frame.id);
  }
  const document = {
    schema_version: 1,
    schema: 'yinzi.video-shot-analysis/v1',
    method: 'sampled_rgb_mad_histogram',
    quality_status: 'review_required',
    source: {
      path: inputPath,
      duration_seconds: round(clipEnd),
      container_duration_seconds: round(Number(media.probe.format?.duration) || 0),
      width: media.width,
      height: media.height,
      r_frame_rate: media.r_frame_rate,
      avg_frame_rate: media.avg_frame_rate,
      time_base: media.time_base,
      has_audio: media.has_audio,
      audio_start_time: media.audio_start_time,
      vfr_hint: media.vfr_hint,
      start_time: round(media.origin),
      last_frame_pts: lastFrame ? lastFrame.pts : null,
      last_frame_pts_time: lastFrame ? round(lastFrame.pts_time) : null,
      last_frame_duration_time: lastFrame ? round(frameDurationSeconds(lastFrame, media.time_base)) : null,
    },
    source_timeline_origin: round(media.origin),
    decoded_duration: round(samples.at(-1).seconds - samples[0].seconds),
    sample: {
      width: p.analysis_width,
      height: p.analysis_height,
      sample_fps: p.sample_fps,
      frames_analyzed: samples.length,
      first_seconds: samples[0].seconds,
      last_seconds: samples.at(-1).seconds,
      first_source_seconds: samples[0].source_seconds,
      last_source_seconds: samples.at(-1).source_seconds,
      clip_end_seconds: clipEnd,
      last_sample_to_clip_gap: round(clipEnd - samples.at(-1).seconds),
    },
    parameters: p,
    shots: analysis.shots,
    cuts: analysis.cuts,
    black_intervals: analysis.black_intervals,
    freeze_intervals: analysis.freeze_intervals,
    keyframes,
    contact_sheet: sheet,
    envelope: compressEnvelope(samples),
    beat_alignment: {
      module_id: 'local.audio.analyze-beats',
      join_on: 'onsets[].seconds (and optional strength) relative to video origin; extra onset fields are ignored',
      helper: 'alignShotsWithBeats(shots, onsets)',
      auto_edit: false,
    },
    limitations: LIMITATIONS,
    next_step: '打开 contact-sheet.png 与关键帧，按 timecode 回看 JSON 中的 shots/black/freeze；需要配乐卡点时再读取已有节拍分析 onsets，用 alignShotsWithBeats 对照。不要把 mean_motion 当高光。',
  };
  writeJson(outputPath, document);
  return {
    before: {
      has_video: true,
      has_audio: media.has_audio,
      width: media.width,
      height: media.height,
      duration: media.duration,
      source_timeline_origin: media.origin,
    },
    after: {
      format: 'json',
      shot_count: analysis.shots.length,
      cut_count: analysis.cuts.length,
      keyframe_count: keyframes.length,
      black_interval_count: analysis.black_intervals.length,
      freeze_interval_count: analysis.freeze_intervals.length,
    },
    quality_status: 'review_required',
    quality_note: '已按真实 pts 切分镜头并生成接触表；运动/亮度不是语义理解，选片需看图。',
    assets,
    text_preview: document.next_step,
  };
}

const operation = {
  id: 'local.video.analyze-shots',
  title: '镜头切分与可复核选片分析',
  description: '本地分析视频镜头、切点与画面变化，生成带时间码的镜头表和关键帧总览，帮助 Agent 挑选高光并规划卡点剪辑。',
  kind: 'document',
  phase: 'analyze',
  output_extension: 'json',
  component_id: 'media.ffmpeg',
  additional_components: ['media.sharp'],
  source: 'https://ffmpeg.org/ffmpeg-filters.html#showinfo',
  defaults: {},
  executeNative,
  parameter_schema: {
    type: 'object',
    properties: {
      sample_fps: { type: 'number', minimum: 0, maximum: 30, default: 8, title: '采样帧率（0=解码后每帧，不重写时间戳）' },
      analysis_width: { type: 'integer', minimum: 32, maximum: 640, default: 160, title: '分析宽度' },
      analysis_height: { type: 'integer', minimum: 18, maximum: 360, default: 90, title: '分析高度' },
      scene_threshold: { type: 'number', minimum: 0.02, maximum: 0.9, default: 0.22, title: '切点阈值（大=更少切）' },
      min_shot_seconds: { type: 'number', minimum: 0.04, maximum: 30, default: 0.2, title: '最短镜头秒' },
      black_luma: { type: 'number', minimum: 0, maximum: 0.5, default: 0.08, title: '黑场亮度上限' },
      min_black_seconds: { type: 'number', minimum: 0.04, maximum: 30, default: 0.2, title: '最短黑场秒' },
      freeze_motion: { type: 'number', minimum: 0, maximum: 0.3, default: 0.012, title: '静帧运动上限' },
      min_freeze_seconds: { type: 'number', minimum: 0.08, maximum: 30, default: 0.4, title: '最短静帧秒' },
      max_duration: { type: 'number', minimum: 0.2, maximum: 14400, default: 1800, title: '分析时长上限秒' },
      max_frames: { type: 'integer', minimum: 8, maximum: 200000, default: 18000, title: '分析帧数上限' },
      max_keyframes: { type: 'integer', minimum: 2, maximum: 80, default: 24, title: '关键帧上限' },
      thumbnail_width: { type: 'integer', minimum: 64, maximum: 480, default: 160, title: '接触表单元格宽' },
      contact_columns: { type: 'integer', minimum: 2, maximum: 8, default: 4, title: '接触表列数' },
    },
  },
};

module.exports = {
  ...operation,
  operation,
  settings,
  formatTimecode,
  parseShowinfoLine,
  frameMetrics,
  analyzeSamples,
  selectKeyframes,
  alignShotsWithBeats,
  zipSamplesWithPts,
  clipEndSeconds,
  clipEndFromLastFrame,
  contentDuration,
  contactLabel,
  ptsSelect,
  probeLastFrame,
  executeNative,
};