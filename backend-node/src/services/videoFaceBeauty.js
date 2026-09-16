const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { once } = require('node:events');


const {
  LIMITATIONS, TRACKING_PARAMETER_KEYS, fail, round, formatTimecode, parseRate,
  parseShowinfoLine, frameSceneMetrics, FaceTracker,
} = require('./videoFaceTracker');

const {
  applyBeautyEnhancement,
  decodeYuNet,
  chooseFaces,
} = require('./faceBeautyOperations');

const videoBeautyDefaults = {
  hold_seconds: 0.15,
  predict_motion: false,
  predict_max_seconds: 0.4,
  scene_threshold: 0.28,
  min_shot_seconds: 0.2,
  analysis_width: 160,
  analysis_height: 90,
  max_duration: 30,
  max_frames: 900,
  match_min_score: 0.25,
  match_iou: 0.1,
  match_center_ratio: 1,
  output_fps: 0,
  smooth_strength: 0.6,
  texture_retention: 0.7,
  feature_protection: 0.85,
  skin_tone_warmth: 0.05,
  skin_brighten: 0.08,
  skin_rosiness: 0.04,
  feather_ratio: 0.25,
  expand_ratio: 0.2,
  face_selection: 'all',
  target_index: 0,
  force_user_rect: false,
  score_threshold: 0.6,
  nms_threshold: 0.3,
  top_k: 500,
  max_faces: 100,
  detection_size: 640,
  cache_gap_policy: 'skip',
};

const videoBeautyBounds = {
  hold_seconds: [0, 2],
  predict_max_seconds: [0, 2],
  scene_threshold: [0.02, 0.9],
  min_shot_seconds: [0.04, 30],
  analysis_width: [32, 640],
  analysis_height: [18, 360],
  max_duration: [0.2, 120],
  max_frames: [8, 3600],
  match_min_score: [0.05, 0.99],
  match_iou: [0, 1],
  match_center_ratio: [0.1, 2],
  output_fps: [0, 120],
  smooth_strength: [0, 1],
  texture_retention: [0, 1],
  feature_protection: [0, 1],
  skin_tone_warmth: [-0.5, 0.5],
  skin_brighten: [-0.5, 0.5],
  skin_rosiness: [-0.5, 0.5],
  feather_ratio: [0.05, 0.5],
  expand_ratio: [0, 1],
  score_threshold: [0.1, 0.99],
  nms_threshold: [0, 1],
  top_k: [1, 5000],
  max_faces: [1, 100],
  detection_size: [640, 640],
  target_index: [0, 99],
};

const videoBeautyIntegers = new Set([
  'analysis_width', 'analysis_height', 'max_frames', 'top_k', 'max_faces',
  'detection_size', 'target_index',
]);

function parametersForVideoBeauty(raw = {}) {
  const p = { ...videoBeautyDefaults, ...raw };
  p.predict_motion = raw.predict_motion === true;
  for (const [key, [min, max]] of Object.entries(videoBeautyBounds)) {
    const value = p[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (videoBeautyIntegers.has(key) && !Number.isInteger(value))) {
      throw fail('INVALID_PARAMETERS', `${key} 需为 ${min}–${max} 的${videoBeautyIntegers.has(key) ? '整数' : '数值'}`);
    }
  }
  if (!['all', 'largest', 'primary', 'index'].includes(p.face_selection)) throw fail('INVALID_PARAMETERS', '人脸选择无效');
  if (typeof p.force_user_rect !== 'boolean') throw fail('INVALID_PARAMETERS', 'force_user_rect 需为布尔值');
  if (p.user_rect !== undefined) {
    const r = p.user_rect;
    if (!r || Array.isArray(r) || ['x', 'y', 'width', 'height'].some(k => typeof r[k] !== 'number' || !Number.isFinite(r[k])) ||
        r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1) {
      throw fail('INVALID_PARAMETERS', 'user_rect 需为图内完整归一化矩形');
    }
  }
  if (p.force_user_rect && !p.user_rect) throw fail('INVALID_PARAMETERS', '强制手动区域时需提供user_rect');
  if (p.tracks_path !== undefined && (typeof p.tracks_path !== 'string' || !p.tracks_path)) {
    throw fail('INVALID_PARAMETERS', 'tracks_path 需为已有轨迹 JSON 路径');
  }
  if (!['skip', 'fail'].includes(p.cache_gap_policy)) {
    throw fail('INVALID_PARAMETERS', 'cache_gap_policy 需为 skip 或 fail');
  }
  if (p.analysis_width % 2 || p.analysis_height % 2) throw fail('INVALID_PARAMETERS', '分析宽高需为偶数');
  if (p.output_fps !== 0 && (!Number.isFinite(p.output_fps) || p.output_fps < 1)) {
    throw fail('INVALID_PARAMETERS', 'output_fps 为 0（自动有界 CFR）或 1–120');
  }
  return p;
}

function trackingFingerprint(p) {
  const fingerprint = {};
  for (const key of TRACKING_PARAMETER_KEYS) fingerprint[key] = p[key];
  if (p.user_rect !== undefined) fingerprint.user_rect = p.user_rect;
  return fingerprint;
}

function sameTrackingFingerprint(cached, p) {
  const expected = trackingFingerprint(p);
  const stored = cached?.parameters?.tracking || cached?.tracking_parameters;
  if (!stored || typeof stored !== 'object') return false;
  for (const key of Object.keys(expected)) {
    if (JSON.stringify(stored[key]) !== JSON.stringify(expected[key])) return false;
  }
  return true;
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function loadCachedTracks(p, sourceHash, width, height) {
  if (!p.tracks_path) return null;
  if (!fs.existsSync(p.tracks_path)) throw fail('FACE_TRACK_CACHE', 'tracks_path 不存在');
  const cached = JSON.parse(fs.readFileSync(p.tracks_path, 'utf8'));
  if (cached.schema !== 'yinzi.video-face-tracking/v1') throw fail('FACE_TRACK_CACHE', '缓存不是 yinzi.video-face-tracking/v1');
  if (!cached.source?.sha256) throw fail('FACE_TRACK_CACHE', '缓存缺少 source.sha256，拒绝复用');
  if (cached.source.sha256 !== sourceHash) throw fail('FACE_TRACK_CACHE', '缓存源文件指纹与当前输入不一致');
  if (cached.source.width !== width || cached.source.height !== height) throw fail('FACE_TRACK_CACHE', '缓存画幅与当前输入不一致');
  if (!Array.isArray(cached.frames) || !cached.frames.length) throw fail('FACE_TRACK_CACHE', '缓存缺少逐帧轨迹');
  if (!sameTrackingFingerprint(cached, p)) throw fail('FACE_TRACK_CACHE', '缓存跟踪参数与当前请求不一致');
  return cached;
}

/**
 * 把缓存轨迹按真实时间建索引。
 *
 * 缓存是按【源帧】记录的（yinzi.video-face-tracking/v1 的 frames[].pts_time / seconds），
 * 而本执行器解码时用 fps 滤镜重采样，输出帧数与源帧数不一致。因此绝不能用输出帧序号
 * 去索引 cached.frames，必须按时间查找——与正式 mapPtsToCfr 的"取时间上不晚于当前槽位
 * 的最后一个源帧"语义保持一致。
 *
 * @param {object} cached 已校验过指纹的缓存对象
 * @param {number} origin 源时基原点（video.start_time），用于把只有相对 seconds 的旧缓存补回绝对时刻
 */
function buildCacheTimeIndex(cached, origin) {
  const finiteNumber = value => value !== null && value !== '' && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null;
  const entries = [];
  const frames = Array.isArray(cached.frames) ? cached.frames : [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame || typeof frame !== 'object') continue;
    // pts_time 是绝对时刻，最可靠；退路是相对 seconds 加回原点。
    const ptsTime = finiteNumber(frame.pts_time);
    const seconds = finiteNumber(frame.seconds);
    let time = null;
    let timeSource = null;
    if (ptsTime !== null) { time = ptsTime; timeSource = 'pts_time'; }
    else if (seconds !== null) { time = seconds + origin; timeSource = 'seconds+origin'; }
    if (time === null) continue;
    entries.push({
      time,
      time_source: timeSource,
      duration_time: Number.isFinite(Number(frame.duration_time)) && Number(frame.duration_time) > 0
        ? Number(frame.duration_time) : null,
      cache_frame_index: i,
      cache_n: finiteNumber(frame.n) ?? finiteNumber(frame.frame),
      shot_cut: frame.shot_cut === true,
      shot_index: frame.shot_index ?? null,
      detections: Array.isArray(frame.detections) ? frame.detections : [],
      tracks: Array.isArray(frame.tracks) ? frame.tracks : [],
    });
  }
  if (!entries.length) {
    throw fail('FACE_TRACK_CACHE', '缓存逐帧轨迹缺少 pts_time/seconds 时间戳，无法按时间对齐；请用当前版本重新生成轨迹');
  }
  entries.sort((a, b) => a.time - b.time);

  // 标称帧间隔：取相邻时间差的中位数，用于判断某个缓存帧的时间覆盖范围。
  const gaps = [];
  for (let i = 1; i < entries.length; i++) {
    const gap = entries[i].time - entries[i - 1].time;
    if (gap > 1e-9) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const nominalGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;

  return {
    entries,
    nominal_gap: nominalGap,
    first_time: entries[0].time,
    last_time: entries.at(-1).time,
    origin,
  };
}

/**
 * 找出时间上不晚于 time 的最后一个缓存帧，并判断它是否真的覆盖该时刻。
 * 覆盖窗口优先用明确时长；帧号不连续时不能跨越缓存缺口。
 * 返回 { entry, covered, reason }，不做任何"顺延旧框"的猜测。
 */
function lookupCacheAtTime(index, time, tolerance) {
  const { entries } = index;
  const slack = Number.isFinite(tolerance) ? tolerance : 1e-6;
  if (time + slack < entries[0].time) {
    return { entry: null, covered: false, reason: 'before_cache_start' };
  }
  let lo = 0, hi = entries.length - 1, found = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].time <= time + slack) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const entry = entries[found];
  const next = entries[found + 1] || null;
  // 覆盖窗口优先用缓存自报时长，其次用到下一帧的实际间隔，最后用标称间隔。
  let span = entry.duration_time;
  const consecutive = next && entry.cache_n !== null && next.cache_n === entry.cache_n + 1;
  if (span == null && consecutive) span = next.time - entry.time;
  if (span == null) span = index.nominal_gap;
  const covered = Math.abs(time - entry.time) <= slack || (span > 0 && time < entry.time + span - slack);
  if (!covered) {
    return { entry, covered: false, reason: next ? 'cache_gap' : 'after_cache_end' };
  }
  return { entry, covered: true, reason: null };
}

/** 缓存帧 -> 美颜 targets。lost 状态不参与，切镜/丢失不会被越过。 */
function targetsFromCacheEntry(entry) {
  return (entry.tracks || [])
    .filter(t => t && (t.state === 'detected' || t.state === 'held') && t.box)
    .map(t => ({
      box: t.box,
      landmarks: t.landmarks,
      source: t.source,
      index: t.matched_detection_index,
      target_id: t.target_id,
    }));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function runProcess(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), options.timeout || 120000);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1024 * 1024); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if ((options.exitCodes || [0]).includes(code)) resolve({ stdout, stderr, code });
      else reject(fail('VIDEO_BEAUTY_PROCESS', `本地进程未完成 (${code}): ${stderr.slice(-1500)}`));
    });
  });
}

function loadSharp(components) {
  const dir = components?.['media.sharp']?.directory;
  if (!dir) throw fail('VIDEO_BEAUTY_INPUT', '需要 media.sharp 组件目录');
  return createRequire(path.join(dir, 'package.json'))('sharp');
}

function loadOrt(components) {
  const dir = components?.['vision.face-detector']?.directory;
  if (!dir) throw fail('VIDEO_BEAUTY_INPUT', '需要 vision.face-detector 组件目录');
  return { ort: createRequire(path.join(dir, 'package.json'))('onnxruntime-node'), componentDir: dir };
}

async function probeMedia(ffprobe, inputPath) {
  const result = await runProcess(ffprobe, ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', inputPath], { timeout: 60000 });
  if (result.stderr.trim()) throw fail('VIDEO_BEAUTY_DECODE', `输入视频解码检查失败: ${result.stderr.slice(-1500)}`);
  let probe;
  try { probe = JSON.parse(result.stdout); }
  catch { throw fail('VIDEO_BEAUTY_DECODE', 'ffprobe 无法解析该文件'); }
  const video = probe.streams?.find(s => s.codec_type === 'video');
  if (!video) throw fail('VIDEO_BEAUTY_NO_VIDEO', '素材没有视频轨');
  const audio = probe.streams?.find(s => s.codec_type === 'audio') || null;
  const origin = Number(video.start_time ?? probe.format?.start_time ?? 0);
  const width = Number(video.width) || 0, height = Number(video.height) || 0;
  if (!(width > 0 && height > 0)) throw fail('VIDEO_BEAUTY_GEOMETRY', '无法读取视频画幅');
  const rRate = parseRate(video.r_frame_rate);
  const avgRate = parseRate(video.avg_frame_rate);
  const fps = avgRate || rRate || 24;
  return {
    probe, video, audio,
    origin, width, height, fps,
    duration: Number(probe.format?.duration || video.duration || 0),
    has_audio: Boolean(audio),
    audio_start_time: audio ? Number(audio.start_time ?? 0) : null,
    audio_offset_seconds: audio ? Number(audio.start_time ?? 0) - origin : null,
  };
}

async function detectWithSession({ session, ort, sharp, rgba, width, height, parameters: p }) {
  const size = p.detection_size, scale = Math.min(size / width, size / height);
  const rw = Math.max(1, Math.round(width * scale)), rh = Math.max(1, Math.round(height * scale));
  const rgb = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .flatten({ background: '#000000' })
    .resize(rw, rh, { fit: 'fill' })
    .extend({ right: size - rw, bottom: size - rh, top: 0, left: 0, background: '#000000' })
    .removeAlpha().raw().toBuffer();
  const pixels = size * size, input = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    input[i] = rgb[i * 3 + 2];
    input[pixels + i] = rgb[i * 3 + 1];
    input[2 * pixels + i] = rgb[i * 3];
  }
  const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) });
  return decodeYuNet(outputs, { size, width, height, resizedWidth: rw, resizedHeight: rh, parameters: p });
}

function beautyTargets(tracks) {
  return tracks.filter(track => track.state === 'detected' || track.state === 'held').map(track => ({
    box: track.box,
    landmarks: track.landmarks,
    source: track.source,
    index: track.matched_detection_index,
    target_id: track.target_id,
  }));
}

/**
 * 连续视频保纹理美颜执行器
 * 1. 严格依据 max_duration 与 max_frames 同时限制解码帧，通过 fps 重采样保持真实时间基准（不因 output_fps 导致播放速度变化）。
 * 2. 结合 FaceTracker 跟踪视频中人脸运动轨迹，接入 shotCut 镜头切分与小图度量。
 * 3. 针对每帧已定位人脸执行分频保纹理磨皮与五官保护。
 * 4. 音视频对齐裁剪：依据视频实际有效时长对音频流执行精确 atrim 裁剪，消除无画面音频。
 * 5. 最终生成输出后，用 ffprobe 回读音视频实际时长与帧数，据实生成回执（review_required / unchanged），不虚报 verified。
 */
async function executeVideoFaceBeauty({ inputPath, outputPath, parameters: raw = {}, components, report = () => {} }) {
  const p = parametersForVideoBeauty(raw);
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw fail('FACE_OUTPUT_OVERWRITES_INPUT', '输出不能覆盖原始素材');
  }

  const binaries = components?.['media.ffmpeg']?.executables;
  if (!binaries?.ffmpeg || !binaries?.ffprobe) throw fail('VIDEO_BEAUTY_INPUT', '需要 media.ffmpeg 组件');

  const sharp = loadSharp(components);
  sharp.cache(false);
  sharp.concurrency(2);

  const media = await probeMedia(binaries.ffprobe, inputPath);
  const outFps = p.output_fps > 0 ? p.output_fps : Math.round(media.fps);
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });

  const sourceHash = await sha256File(inputPath);
  const cached = loadCachedTracks(p, sourceHash, media.width, media.height);
  const cacheIndex = cached ? buildCacheTimeIndex(cached, media.origin) : null;
  // 时间容差取输出帧间隔的一小部分，避免浮点 PTS 抖动误判为缓存空洞。
  const timeTolerance = Math.max(1e-6, 1 / (outFps * 1000));
  const cacheTiming = {
    used: Boolean(cached),
    cache_frames: cacheIndex ? cacheIndex.entries.length : 0,
    cache_first_time: cacheIndex ? round(cacheIndex.first_time) : null,
    cache_last_time: cacheIndex ? round(cacheIndex.last_time) : null,
    cache_nominal_gap: cacheIndex && cacheIndex.nominal_gap != null ? round(cacheIndex.nominal_gap) : null,
    matched_frames: 0,
    uncovered_frames: 0,
    uncovered_reasons: {},
    uncovered_examples: [],
    frame_time_source: 'showinfo_pts_time',
    estimated_time_frames: 0,
  };

  let session = null;
  if (!cached) {
    const { ort, componentDir } = loadOrt(components);
    session = await ort.InferenceSession.create(path.join(componentDir, 'models/yunet.onnx'), {
      executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1,
    });
  }

  const tracker = cached ? null : new FaceTracker(p, media.width, media.height, chooseFaces);

  // 中间无音频视频文件路径
  const tmpVideoOnly = path.join(dir, `tmp-vbeauty-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.mp4`);

  // 解码器：通过 fps 重采样保证时间基准；-copyts + showinfo 让我们读到【重采样之后】
  // 每个输出帧的真实 pts_time，而不是靠 n/outFps 反推（VFR、非零起点下反推会错）。
  // max_duration 改在代码里按真实 pts_time - origin 裁剪：-copyts 下 -t 的语义不可靠。
  const decArgs = [
    '-nostdin', '-hide_banner', '-v', 'level+info', '-xerror', '-nostats',
    '-threads', '2', '-filter_threads', '1',
    '-copyts',
    '-i', inputPath,
    '-map', '0:v:0', '-an',
    // Round source timestamps up so each output uses the last source frame at
    // or before its time, matching lookupCacheAtTime for fractional rate ratios.
    '-vf', `fps=fps=${outFps}:round=up,format=rgba,showinfo`,
    '-frames:v', String(p.max_frames),
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-',
  ];

  // 编码器：纯视频编码写入临时文件
  const encArgs = [
    '-nostdin', '-y', '-v', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${media.width}x${media.height}`,
    '-r', String(outFps),
    '-i', '-',
    '-an',
    '-c:v', 'libx264',
    '-threads', '2',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    tmpVideoOnly,
  ];

  const frameBytes = media.width * media.height * 4;
  const dec = spawn(binaries.ffmpeg, decArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const enc = spawn(binaries.ffmpeg, encArgs, { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });

  let frameCount = 0;
  let detectedFacesTotal = 0;
  let appliedFramesTotal = 0;
  let buffer = Buffer.alloc(0);
  let prevSmall = null;
  let prevStats = null;
  let lastCutSeconds = 0;
  const cuts = [];

  /**
   * @param {Buffer} rawBuffer 输出帧 RGBA
   * @param {number} n 输出帧序号
   * @param {number} seconds 相对本次输出的时刻（sourceTime - origin）
   * @param {number} sourceTime 该输出帧在源时基上的绝对 pts_time，用于查缓存
   */
  const processFrameBuffer = async (rawBuffer, n, seconds, sourceTime) => {
    // a) 镜头切分与场景度量
    const small = await sharp(rawBuffer, { raw: { width: media.width, height: media.height, channels: 4 } })
      .resize(p.analysis_width, p.analysis_height, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer();

    const scene = frameSceneMetrics(small, p.analysis_width, p.analysis_height, prevSmall, prevStats);
    const shotCut = n > 0 && scene.score >= p.scene_threshold && (seconds - lastCutSeconds) >= p.min_shot_seconds;
    if (shotCut) {
      lastCutSeconds = seconds;
      cuts.push({ frame: n, seconds: round(seconds), score: round(scene.score) });
    }
    prevSmall = small;
    prevStats = scene;

    // b) 人脸检测或复用
    // 缓存按【源帧时间】记录，输出帧经过 fps 重采样，必须按时间查表，不能用输出序号索引。
    let faces = [];
    let cacheHit = null;
    if (cached) {
      cacheHit = lookupCacheAtTime(cacheIndex, sourceTime, timeTolerance);
      if (cacheHit.covered) {
        cacheTiming.matched_frames++;
        faces = cacheHit.entry.detections || [];
      } else {
        cacheTiming.uncovered_frames++;
        cacheTiming.uncovered_reasons[cacheHit.reason] = (cacheTiming.uncovered_reasons[cacheHit.reason] || 0) + 1;
        if (cacheTiming.uncovered_examples.length < 8) {
          cacheTiming.uncovered_examples.push({
            output_frame: n,
            output_seconds: round(seconds),
            source_pts_time: round(sourceTime),
            reason: cacheHit.reason,
            nearest_cache_time: cacheHit.entry ? round(cacheHit.entry.time) : null,
          });
        }
        if (p.cache_gap_policy === 'fail') {
          throw fail('FACE_TRACK_CACHE',
            `输出第 ${n} 帧（源时刻 ${round(sourceTime)}s）在缓存轨迹中没有覆盖帧（${cacheHit.reason}）；` +
            '请重新生成完整轨迹，或将 cache_gap_policy 设为 skip 以跳过这些帧');
        }
      }
    } else if (!p.force_user_rect && session) {
      faces = await detectWithSession({
        session, ort: loadOrt(components).ort, sharp, rgba: rawBuffer, width: media.width, height: media.height, parameters: p,
      });
    }
    detectedFacesTotal += faces.length;

    // c) 跟踪器状态更新与 targets 确定
    let targets = [];
    if (cached) {
      // 缺帧时 targets 保持为空：本帧原样输出，不顺延上一帧的框。
      targets = cacheHit && cacheHit.covered ? targetsFromCacheEntry(cacheHit.entry) : [];
    } else if (p.force_user_rect && p.user_rect) {
      targets = [{
        box: {
          x: p.user_rect.x * media.width,
          y: p.user_rect.y * media.height,
          width: p.user_rect.width * media.width,
          height: p.user_rect.height * media.height,
        },
        source: 'user_rect',
        index: 0,
        target_id: 1,
      }];
    } else {
      const frameState = tracker.step({ seconds, detections: faces, shotCut, scene_score: scene.score });
      targets = beautyTargets(frameState.tracks);
      if (targets.length === 0 && p.user_rect) {
        // 检测无脸时的回退手动区域
        targets = [{
          box: {
            x: p.user_rect.x * media.width,
            y: p.user_rect.y * media.height,
            width: p.user_rect.width * media.width,
            height: p.user_rect.height * media.height,
          },
          source: 'user_rect_fallback',
          index: 0,
          target_id: 1,
        }];
      }
    }

    // d) 逐帧保纹理美颜
    let outputFrameBuffer = rawBuffer;
    if (targets.length > 0) {
      const { output } = await applyBeautyEnhancement(sharp, rawBuffer, media.width, media.height, targets, p);
      outputFrameBuffer = output;
      appliedFramesTotal++;
    }

    return outputFrameBuffer;
  };

  const decExitPromise = new Promise(resolve => {
    dec.on('close', code => resolve(code));
    dec.on('error', () => resolve(null));
  });

  // showinfo 行：滤镜链中 showinfo 在 rawvideo 落盘之前打印，所以第 n 帧的字节到达时，
  // 第 n 行时间戳必已写入 stderr。这里按顺序累积，与输出帧一一配对。
  const ptsInfos = [];
  let stderrTail = '';
  let errOutput = '';
  let decodeError = false;
  const ingestShowinfo = text => {
    const lines = (stderrTail + text).split(/\r?\n/);
    stderrTail = lines.pop();
    for (const line of lines) {
      if (/\[(?:error|fatal|panic)\]/.test(line)) decodeError = true;
      const info = parseShowinfoLine(line);
      if (info) ptsInfos.push(info);
    }
  };
  dec.stderr.on('data', d => {
    const text = String(d);
    errOutput = (errOutput + text).slice(-8000);
    ingestShowinfo(text);
  });

  const takeFrameTime = async n => {
    // 极少数情况下 stderr 与 stdout 的调度顺序会让时间戳行稍晚到达，短暂等待。
    for (let attempt = 0; attempt < 20 && ptsInfos.length <= n; attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const info = ptsInfos[n];
    if (info && Number.isFinite(info.pts_time)) {
      return { time: info.pts_time, estimated: false, duration_time: info.duration_time ?? null };
    }
    // 拿不到真实时间戳时退回等间隔推算，并在回执里如实标注，不假称精确。
    cacheTiming.estimated_time_frames++;
    return { time: media.origin + n / outFps, estimated: true, duration_time: null };
  };

  let reachedDurationLimit = false;

  const decPromise = (async () => {
    try {
      for await (const chunk of dec.stdout) {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= frameBytes && frameCount < p.max_frames && !reachedDurationLimit) {
          const frameBuf = buffer.subarray(0, frameBytes);
          buffer = buffer.subarray(frameBytes);

          const n = frameCount;
          const timing = await takeFrameTime(n);
          const sourceTime = timing.time;
          const seconds = sourceTime - media.origin;
          // 时长上限按真实相对时刻裁剪（-copyts 下 -t 语义不可靠），非零起点也正确。
          if (seconds >= p.max_duration - 1e-9) {
            reachedDurationLimit = true;
            break;
          }
          frameCount++;

          const processed = await processFrameBuffer(frameBuf, n, seconds, sourceTime);
          if (!enc.stdin.write(processed)) {
            await once(enc.stdin, 'drain');
          }
        }
        if (frameCount >= p.max_frames || reachedDurationLimit) {
          dec.kill();
          break;
        }
      }
    } catch (err) {
      dec.kill();
      enc.kill();
      throw err;
    } finally {
      enc.stdin.end();
    }

    const exitCode = await decExitPromise;
    const stoppedAtLimit = reachedDurationLimit || frameCount >= p.max_frames;
    if (decodeError || (exitCode !== 0 && !stoppedAtLimit)) {
      throw fail('VIDEO_BEAUTY_DECODE', `ffmpeg 解码失败 (${exitCode}): ${errOutput}`);
    }
  })();

  const encPromise = new Promise((resolve, reject) => {
    let errOutput = '';
    enc.stderr.on('data', d => { errOutput += d; });
    enc.stdin.on('error', reject);
    enc.on('error', reject);
    enc.on('close', code => {
      if (code === 0) resolve();
      else reject(fail('VIDEO_BEAUTY_ENCODE', `ffmpeg 编码失败 (${code}): ${errOutput}`));
    });
  });

  try {
    await Promise.all([decPromise, encPromise]);
  } catch (error) {
    dec.kill();
    enc.kill();
    await Promise.allSettled([decPromise, encPromise]);
    try { fs.unlinkSync(tmpVideoOnly); } catch {}
    throw error;
  } finally {
    if (session) await session.release().catch(() => {});
  }

  if (frameCount === 0) {
    try { fs.unlinkSync(tmpVideoOnly); } catch {}
    throw fail('VIDEO_BEAUTY_NO_FRAMES', '未能从输入视频中解码出任何有效视频帧');
  }

  // 2. 使用 ffprobe 回读纯视频临时文件的真实时长和属性
  const vProbeRaw = await runProcess(binaries.ffprobe, [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', tmpVideoOnly,
  ]);
  const vProbe = JSON.parse(vProbeRaw.stdout);
  const vStream = vProbe.streams?.find(s => s.codec_type === 'video');
  const actualVideoDuration = Number(vStream?.duration || vProbe.format?.duration || (frameCount / outFps));

  // 3. 混流音视频并做协同精准对齐裁剪
  try {
    if (media.has_audio) {
      const offset = media.audio_offset_seconds || 0;
      const filters = ['asetpts=PTS-STARTPTS'];
      if (offset > 0) filters.push(`adelay=${Math.round(offset * 1000)}:all=1`);
      else if (offset < 0) filters.push(`atrim=start=${-offset}`, 'asetpts=PTS-STARTPTS');
      filters.push(`atrim=0:${actualVideoDuration}`);

      const muxArgs = [
        '-nostdin', '-y', '-v', 'error',
        '-i', tmpVideoOnly,
        '-i', inputPath,
        '-map', '0:v:0', '-map', '1:a:0?',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-af', filters.join(','),
        '-t', String(actualVideoDuration),
        '-movflags', '+faststart',
        outputPath,
      ];
      await runProcess(binaries.ffmpeg, muxArgs, { timeout: 180000 });
    } else {
      const muxArgs = [
        '-nostdin', '-y', '-v', 'error',
        '-i', tmpVideoOnly,
        '-map', '0:v:0',
        '-c:v', 'copy',
        '-t', String(actualVideoDuration),
        '-movflags', '+faststart',
        outputPath,
      ];
      await runProcess(binaries.ffmpeg, muxArgs, { timeout: 180000 });
    }
  } finally {
    try { fs.unlinkSync(tmpVideoOnly); } catch {}
  }

  // 4. 严格 probe 最终交付文件并比对音视频实际时长与帧数
  const finalProbeRaw = await runProcess(binaries.ffprobe, [
    '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', outputPath,
  ]);
  const finalProbe = JSON.parse(finalProbeRaw.stdout);
  const finalVideo = finalProbe.streams?.find(s => s.codec_type === 'video');
  const finalAudio = finalProbe.streams?.find(s => s.codec_type === 'audio') || null;

  if (!finalVideo) throw fail('OUTPUT_UNPLAYABLE', '输出文件缺少视频轨');
  if (media.has_audio && !finalAudio) throw fail('OUTPUT_UNPLAYABLE', '输出文件缺少预期音轨');

  const outVideoDur = Number(finalVideo.duration || finalProbe.format.duration);
  const outAudioDur = finalAudio ? Number(finalAudio.duration || finalProbe.format.duration) : null;
  const outFrames = Number(finalVideo.nb_read_frames || finalVideo.nb_frames || frameCount);

  if (finalAudio && Math.abs(outVideoDur - outAudioDur) > 0.15) {
    throw fail('AUDIO_VIDEO_DESYNC', `音视频时长严重脱节：视频 ${outVideoDur}s，音频 ${outAudioDur}s`);
  }

  const summaries = cached ? (cached.tracks || []) : (tracker ? tracker.finish(frameCount / outFps) : []);
  const appliedAny = appliedFramesTotal > 0;

  const receipt = {
    status: 'succeeded',
    input_path: inputPath,
    output_path: outputPath,
    frames_processed: frameCount,
    applied_frames_total: appliedFramesTotal,
    fps: outFps,
    dimensions: { width: media.width, height: media.height },
    detected_faces_total: detectedFacesTotal,
    has_audio: Boolean(finalAudio),
    actual_duration_seconds: round(outVideoDur),
    actual_output: {
      video: {
        duration: round(outVideoDur),
        frames: outFrames,
        fps: finalVideo.avg_frame_rate,
        width: finalVideo.width,
        height: finalVideo.height,
      },
      audio: finalAudio ? {
        duration: round(outAudioDur),
        frames: Number(finalAudio.nb_read_frames || finalAudio.nb_frames || 0),
      } : null,
    },
    cuts,
    tracks_summary_count: summaries.length,
    cache_timing: cacheTiming,
    duration_limit_reached: reachedDurationLimit,
    quality_status: appliedAny ? 'review_required' : 'unchanged',
    quality_note: appliedAny
      ? `视频保纹理美颜完成，共处理 ${frameCount} 帧，其中 ${appliedFramesTotal} 帧应用了人脸区域美颜，音视频有效时长已对齐为 ${round(outVideoDur)}s。请打开抽帧与成片人工审看人脸修饰及五官边缘。`
      : `视频处理完成，全片未检出人脸且未应用手动美颜区域，画面保持原样，音视频有效时长已对齐为 ${round(outVideoDur)}s。`,
    limitations: LIMITATIONS,
  };

  if (cacheTiming.used) {
    receipt.quality_note += ` 缓存轨迹按 pts_time 时间对齐：${cacheTiming.matched_frames}/${frameCount} 帧命中缓存帧`;
    if (cacheTiming.uncovered_frames > 0) {
      receipt.quality_note += `，${cacheTiming.uncovered_frames} 帧因缓存未覆盖（${Object.keys(cacheTiming.uncovered_reasons).join('/')}）按 cache_gap_policy=${p.cache_gap_policy} 跳过美颜、原样输出`;
    }
    if (cacheTiming.estimated_time_frames > 0) {
      receipt.quality_note += `；其中 ${cacheTiming.estimated_time_frames} 帧未读到 showinfo 时间戳，已按等间隔推算（精度较低）`;
    }
    receipt.quality_note += '。';
  }

  const receiptPath = path.join(dir, path.basename(outputPath, path.extname(outputPath)) + '-video-beauty.json');
  writeJson(receiptPath, receipt);
  return receipt;
}

const videoFaceBeautyOperation = {
  kind: 'video',
  id: 'local.video.face-beauty',
  title: '连续视频人脸保纹理美颜',
  description: 'Tracked video face beauty with texture-preserving skin smoothing and feature protection across shots.',
  description_zh: '跟踪视频中人脸运动轨迹，分频保纹理磨皮与五官特征保护，时间基准重采样，音视频协同裁剪保持对齐。',
  component_id: 'media.ffmpeg',
  additional_components: ['vision.face-detector', 'media.sharp'],
  executeNative: executeVideoFaceBeauty,
  validateParameters: parametersForVideoBeauty,
  defaults: videoBeautyDefaults,
};

module.exports = {
  videoFaceBeautyOperation,
  parametersForVideoBeauty,
  executeVideoFaceBeauty,
};
