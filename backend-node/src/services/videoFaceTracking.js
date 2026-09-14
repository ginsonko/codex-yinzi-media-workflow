const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const {
  LIMITATIONS, TRACKING_PARAMETER_KEYS, fail, round, formatTimecode, parseShowinfoLine, parseRate,
  mapPtsToCfr, frameSceneMetrics, FaceTracker,
} = require('./videoFaceTracker');

function faceOpsCandidates() {
  const files = [path.join(__dirname, 'faceImageOperations.js')];
  if (process.env.YINZI_FACE_IMAGE_OPS) files.push(process.env.YINZI_FACE_IMAGE_OPS);
  if (process.env.YINZI_BACKEND_NODE) files.push(path.join(process.env.YINZI_BACKEND_NODE, 'src/services/faceImageOperations.js'));
  return files;
}

function loadFaceImageOps() {
  const tried = [];
  for (const file of faceOpsCandidates()) {
    tried.push(file);
    try { if (fs.existsSync(file)) return require(file); } catch { /* try next */ }
  }
  throw fail('FACE_TRACK_INPUT', `未找到 faceImageOperations.js。请把该文件放在 candidate/ 旁，或设置 YINZI_FACE_IMAGE_OPS / YINZI_BACKEND_NODE。已试：${tried.join(' | ')}`);
}

let faceOpsMemo = null;
function faceOps() {
  if (!faceOpsMemo) faceOpsMemo = loadFaceImageOps();
  return faceOpsMemo;
}
function imageParametersFor(raw) { return faceOps().parametersFor(raw); }
function decodeYuNet(...args) { return faceOps().decodeYuNet(...args); }
function applyMasks(...args) { return faceOps().applyMasks(...args); }
function chooseFaces(...args) { return faceOps().chooseFaces(...args); }
function faceDetectOperation() { return faceOps().faceDetectOperation; }

const videoDefaults = {
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
  contact_columns: 4,
  thumbnail_width: 160,
  max_contact_frames: 8,
  output_fps: 0,
};
const videoBounds = {
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
  contact_columns: [2, 8],
  thumbnail_width: [64, 480],
  max_contact_frames: [2, 16],
  output_fps: [0, 120],
};
const videoIntegers = new Set(['analysis_width', 'analysis_height', 'max_frames', 'contact_columns', 'thumbnail_width', 'max_contact_frames']);

function parametersFor(raw = {}) {
  const image = imageParametersFor(raw);
  const p = { ...videoDefaults, ...image, ...raw, ...image };
  p.predict_motion = raw.predict_motion === true;
  for (const [key, [min, max]] of Object.entries(videoBounds)) {
    const value = p[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (videoIntegers.has(key) && !Number.isInteger(value))) {
      throw fail('INVALID_PARAMETERS', `${key} 需为 ${min}–${max} 的${videoIntegers.has(key) ? '整数' : '数值'}`);
    }
  }
  if (typeof p.predict_motion !== 'boolean') throw fail('INVALID_PARAMETERS', 'predict_motion 需为布尔值');
  if (p.tracks_path !== undefined && (typeof p.tracks_path !== 'string' || !p.tracks_path)) {
    throw fail('INVALID_PARAMETERS', 'tracks_path 需为已有轨迹 JSON 路径');
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

function chooseOutputFps(media, p) {
  if (p.output_fps > 0) return p.output_fps;
  const avg = parseRate(media.avg_frame_rate);
  if (avg && avg >= 1 && avg <= 120) return avg;
  const declared = parseRate(media.r_frame_rate);
  if (declared && declared >= 1 && declared <= 120) return declared;
  return Math.min(60, Math.max(1, media.fps || 24));
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
  if (!dir) throw fail('FACE_TRACK_INPUT', '需要 media.sharp 组件目录');
  return createRequire(path.join(dir, 'package.json'))('sharp');
}

function loadOrt(components) {
  const dir = components?.['vision.face-detector']?.directory;
  if (!dir) throw fail('FACE_TRACK_INPUT', '需要 vision.face-detector 组件目录');
  return { ort: createRequire(path.join(dir, 'package.json'))('onnxruntime-node'), componentDir: dir };
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
      else reject(fail('FACE_TRACK_DECODE', `本地进程未完成 (${code}): ${stderr.slice(-1500)}`));
    });
  });
}

function contentDuration(video, format, origin, fps = null) {
  const streamDur = Number(video?.duration);
  if (streamDur > 0) return streamDur;
  const fmtDur = Number(format?.duration);
  if (fmtDur > 0) {
    if (Math.abs(origin) > 0.001 && fmtDur - origin >= 0.01) return fmtDur - origin;
    return fmtDur;
  }
  const frames = Number(video?.nb_frames);
  if (frames > 0 && fps > 0) return frames / fps;
  return 0;
}

function extraTrackSources(moduleId, parameters = {}) {
  if (moduleId !== 'local.video.face-mask' && moduleId !== 'local.video.track-faces') return [];
  const file = parameters.tracks_path;
  if (typeof file !== 'string' || !file.trim()) return [];
  return [{ role: 'tracks', path: path.resolve(file) }];
}

async function probeMedia(ffprobe, inputPath) {
  const result = await runProcess(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', inputPath], { timeout: 60000 });
  let probe;
  try { probe = JSON.parse(result.stdout); }
  catch { throw fail('FACE_TRACK_DECODE', 'ffprobe 无法解析该文件'); }
  const video = probe.streams?.find(s => s.codec_type === 'video');
  if (!video) throw fail('FACE_TRACK_NO_VIDEO', '素材没有视频轨');
  const audio = probe.streams?.find(s => s.codec_type === 'audio') || null;
  const origin = Number(video.start_time ?? probe.format?.start_time ?? 0);
  if (!Number.isFinite(origin)) throw fail('FACE_TRACK_TIME', '无法确定素材时间原点');
  const width = Number(video.width) || 0, height = Number(video.height) || 0;
  if (!(width > 0 && height > 0)) throw fail('FACE_TRACK_GEOMETRY', '无法读取视频画幅');
  if (width % 2 || height % 2) throw fail('FACE_TRACK_GEOMETRY', '画幅宽高需为偶数（yuv420p），不偷偷 padding 后宣称原画幅');
  const rRate = parseRate(video.r_frame_rate);
  const avgRate = parseRate(video.avg_frame_rate);
  const fps = avgRate || rRate;
  if (!Number.isFinite(fps) || fps <= 0) throw fail('FACE_TRACK_TIME', '无法确定帧率');
  return {
    probe, video, audio,
    duration: contentDuration(video, probe.format, origin, avgRate || rRate),
    origin, width, height, fps,
    r_frame_rate: video.r_frame_rate || null,
    avg_frame_rate: video.avg_frame_rate || null,
    time_base: video.time_base || null,
    has_audio: Boolean(audio),
    audio_start_time: audio ? Number(audio.start_time ?? 0) : null,
    audio_offset_seconds: audio ? Number(audio.start_time ?? 0) - origin : null,
    vfr_hint: rRate && avgRate ? Math.abs(rRate - avgRate) / Math.max(rRate, avgRate) > 0.02 : false,
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

function xmlText(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
}

function maskTargets(tracks) {
  return tracks.filter(track => track.state === 'detected' || track.state === 'held').map(track => ({
    box: track.box,
    landmarks: track.landmarks,
    source: track.source,
    index: track.matched_detection_index,
    target_id: track.target_id,
  }));
}

async function keepContactCandidate(sharp, rgba, width, height, frame, p, store) {
  if (store.length >= p.max_contact_frames && !frame.shot_cut) return;
  const scale = p.thumbnail_width / width;
  const tw = p.thumbnail_width, th = Math.max(1, Math.round(height * scale));
  const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).resize(tw, th, { fit: 'fill' }).png().toBuffer();
  const boxes = (frame.tracks || []).filter(t => t.box && t.state !== 'lost').map(t => ({
    id: t.target_id, state: t.state,
    x: Math.round(t.box.x * scale), y: Math.round(t.box.y * scale),
    w: Math.max(1, Math.round(t.box.width * scale)), h: Math.max(1, Math.round(t.box.height * scale)),
  }));
  const item = { n: frame.n, seconds: frame.seconds, timecode: frame.timecode, shot_cut: frame.shot_cut, detection_count: frame.detections.length, png, boxes, width: tw, height: th };
  if (store.length < p.max_contact_frames) store.push(item);
  else if (frame.shot_cut) store[store.length - 1] = item;
}

async function buildContactSheet(sharp, items, dir, p) {
  if (!items.length) return null;
  const cellW = Math.max(...items.map(item => item.width));
  const labelH = 36;
  const cellH = Math.max(...items.map(item => item.height)) + labelH;
  const columns = Math.min(p.contact_columns, items.length);
  const rows = Math.ceil(items.length / columns);
  const boardW = columns * cellW, boardH = rows * cellH;
  const composite = [];
  for (const [index, item] of items.entries()) {
    const col = index % columns, row = Math.floor(index / columns);
    const left = col * cellW, top = row * cellH;
    const boxSvg = item.boxes.map(b => `<rect x="${b.x}" y="${labelH + b.y}" width="${b.w}" height="${b.h}" fill="none" stroke="${b.state === 'detected' ? '#39ff14' : '#ffd000'}" stroke-width="2"/>`).join('');
    const svg = `<svg width="${cellW}" height="${cellH}"><rect width="100%" height="${labelH}" fill="#111"/><text x="6" y="22" font-family="Consolas,monospace" font-size="12" fill="#f3f3f3">${xmlText(`${item.timecode} n${item.n}`)}</text>${boxSvg}</svg>`;
    composite.push({ input: Buffer.from(svg), left, top });
    composite.push({ input: item.png, left, top: top + labelH });
  }
  const file = 'contact-sheet.png';
  await sharp({ create: { width: boardW, height: boardH, channels: 3, background: '#181818' } }).composite(composite).png().toFile(path.join(dir, file));
  return { file, columns, rows, width: boardW, height: boardH, frame_count: items.length };
}

async function streamVideo({ ffmpeg, inputPath, media, p, sharp, session, ort, cached, mode, report, signal }) {
  const { width, height, fps, origin } = media;
  const outputFps = chooseOutputFps(media, p);
  const frameBytes = width * height * 4;
  if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0 || frameBytes > 160000000) throw fail('FACE_TRACK_GEOMETRY', '解码画幅无效');
  const work = path.join(path.dirname(media.outputPath), 'face-stream-tmp');
  if (mode === 'mask') fs.mkdirSync(work, { recursive: true });
  const encoded = mode === 'mask' ? path.join(work, 'processed.mp4') : null;
  let stderr = '', lastActivity = Date.now(), failure = null;
  function launch(args, stdio) {
    const child = spawn(ffmpeg, args, { stdio, windowsHide: true, shell: false });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.done = new Promise(resolve => { child.once('error', error => resolve({ error })); child.once('close', code => resolve({ code })); });
    return child;
  }
  const decoder = launch([
    '-nostdin', '-hide_banner', '-v', 'info', '-nostats', '-threads', '2', '-filter_threads', '1',
    '-copyts', '-protocol_whitelist', 'file,pipe', '-i', inputPath,
    '-map', '0:v:0', '-an', '-vf', `scale=${width}:${height}:flags=bilinear,format=rgba,showinfo`,
    '-fps_mode', 'passthrough', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
  ], ['ignore', 'pipe', 'pipe']);
  const encoder = mode === 'mask' ? launch([
    '-nostdin', '-y', '-v', 'error', '-threads', '2', '-filter_threads', '2',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`,
    '-framerate', String(outputFps), '-r', String(outputFps), '-i', 'pipe:0',
    '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-fps_mode', 'cfr', '-movflags', '+faststart', encoded,
  ], ['pipe', 'ignore', 'pipe']) : null;
  let pipeError;
  if (encoder) encoder.stdin.on('error', error => { pipeError = error; decoder.kill(); });
  const abort = () => { decoder.kill(); encoder?.kill(); };
  signal?.addEventListener('abort', abort, { once: true });
  const idle = setInterval(() => { if (Date.now() - lastActivity > 180000) abort(); }, 1000); idle.unref();

  const tracker = cached ? null : new FaceTracker(p, width, height, chooseFaces);
  const frames = [];
  const thumbs = [];
  const pts = [];
  const pending = [];
  let prevSmall = null, prevStats = null, lastCut = origin, lastReport = 0, sessionRuns = 0;
  let frame = Buffer.allocUnsafe(frameBytes), filled = 0, count = 0, stderrTail = '';
  let chain = Promise.resolve();
  let lastOutput = null, encodedCount = 0;

  async function writeEncoded(buf) {
    if (mode !== 'mask') return;
    if (pipeError) throw pipeError;
    if (!encoder.stdin.write(buf)) await once(encoder.stdin, 'drain');
    encodedCount += 1;
  }

  async function fillSlots(untilTime, inclusive) {
    if (mode !== 'mask' || !lastOutput) return;
    const maxEncoded = Math.ceil(p.max_duration * outputFps) + Math.ceil(outputFps) + 8;
    while (encodedCount <= maxEncoded) {
      const slotT = origin + encodedCount / outputFps;
      if (inclusive ? slotT > untilTime + 1e-9 : slotT >= untilTime - 1e-9) break;
      await writeEncoded(lastOutput);
      if (encodedCount > maxEncoded) throw fail('FACE_TRACK_LIMIT', 'CFR 映射帧数超过时长上限');
    }
  }

  function ingestPts(text) {
    const lines = (stderrTail + text).split(/\r?\n/);
    stderrTail = lines.pop();
    for (const line of lines) {
      const info = parseShowinfoLine(line);
      if (info) pts.push(info);
    }
  }

  decoder.stderr.on('data', chunk => { ingestPts(String(chunk)); pump(); });

  function pump() {
    chain = chain.then(async () => {
      while (!failure && pending.length && pts.length > count) {
        const rgba = pending.shift();
        await consumeFrame(rgba);
      }
    }).catch(error => {
      failure = error;
      abort();
    });
    return chain;
  }

  async function consumeFrame(rgba) {
    if (failure) return;
    const info = pts[count];
    if (!info) throw fail('FACE_TRACK_DECODE', `第 ${count} 帧缺少 showinfo pts_time（frames=${count + 1}, pts=${pts.length}）。请确认 fps_mode=passthrough。`);
    if (count && info.pts_time < pts[count - 1].pts_time) throw fail('FACE_TRACK_TIME', '帧时间不递增，请先修复原片时间戳');
    const seconds = round(info.pts_time - origin);
    const source_seconds = round(info.pts_time);
    if (seconds > p.max_duration + 1e-6) throw fail('FACE_TRACK_LIMIT', `素材超过时长上限 ${p.max_duration}s，请分段或提高 max_duration`);
    if (count + 1 > p.max_frames) throw fail('FACE_TRACK_LIMIT', `分析帧数超过上限 ${p.max_frames}，请缩短片段或提高 max_frames`);

    const small = await sharp(rgba, { raw: { width, height, channels: 4 } })
      .resize(p.analysis_width, p.analysis_height, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const scene = frameSceneMetrics(small, p.analysis_width, p.analysis_height, prevSmall, prevStats);
    const shotCut = count > 0 && scene.score >= p.scene_threshold && (info.pts_time - lastCut) >= p.min_shot_seconds;
    if (shotCut) lastCut = info.pts_time;
    prevSmall = small; prevStats = scene;

    let detections, snap;
    if (cached) {
      const cachedFrame = cached.frames[count];
      if (!cachedFrame) throw fail('FACE_TRACK_CACHE', `缓存轨迹缺少第 ${count} 帧`);
      if (cachedFrame.n != null && Number(cachedFrame.n) !== count) {
        throw fail('FACE_TRACK_CACHE', `缓存帧序号 ${cachedFrame.n} 与解码第 ${count} 帧不一致`);
      }
      if (!Number.isFinite(Number(cachedFrame.pts)) || Number(cachedFrame.pts) !== info.pts) {
        throw fail('FACE_TRACK_CACHE', `缓存第 ${count} 帧整数 PTS 与源不一致（cache=${cachedFrame.pts}, source=${info.pts}）`);
      }
      if (!Number.isFinite(Number(cachedFrame.pts_time)) || Math.abs(Number(cachedFrame.pts_time) - info.pts_time) > 1e-3) {
        throw fail('FACE_TRACK_CACHE', `缓存第 ${count} 帧 pts_time 与源不一致（cache=${cachedFrame.pts_time}, source=${info.pts_time}）`);
      }
      detections = cachedFrame.detections || [];
      snap = { shot_index: cachedFrame.shot_index, detections, tracks: cachedFrame.tracks };
    } else {
      detections = await detectWithSession({ session, ort, sharp, rgba, width, height, parameters: p });
      sessionRuns += 1;
      snap = tracker.step({ seconds, detections, shotCut, scene_score: scene.score, source_seconds });
    }

    const record = {
      n: count,
      pts: info.pts,
      pts_time: round(info.pts_time),
      duration_time: Number.isFinite(info.duration_time) ? round(info.duration_time) : null,
      seconds,
      source_seconds,
      timecode: formatTimecode(seconds),
      shot_index: snap.shot_index,
      scene_score: round(scene.score),
      shot_cut: shotCut,
      detections: snap.detections,
      tracks: snap.tracks,
    };
    frames.push(record);

    let output = rgba;
    if (mode === 'mask') {
      const targets = maskTargets(snap.tracks);
      output = targets.length ? (await applyMasks(sharp, rgba, width, height, targets, p)).output : Buffer.from(rgba);
      await fillSlots(info.pts_time, false);
      lastOutput = output;
      await fillSlots(info.pts_time, true);
    }
    const keep = count === 0 || shotCut || count % Math.max(1, Math.round(fps / 2)) === 0;
    if (keep) await keepContactCandidate(sharp, output, width, height, record, p, thumbs);
    count += 1;
    lastActivity = Date.now();
    if (Date.now() - lastReport > 1000) {
      report({ stage: 'executing', message: `正在逐帧处理人脸，已完成 ${count} 帧`, frames: count });
      lastReport = Date.now();
    }
  }

  try {
    if (signal?.aborted) throw fail('FACE_TRACK_CANCELLED', '处理已取消');
    for await (const chunk of decoder.stdout) {
      if (failure) break;
      let offset = 0;
      while (offset < chunk.length) {
        const n = Math.min(chunk.length - offset, frameBytes - filled);
        chunk.copy(frame, filled, offset, offset + n);
        filled += n; offset += n;
        if (filled === frameBytes) {
          pending.push(frame);
          frame = Buffer.allocUnsafe(frameBytes);
          filled = 0;
          pump();
          await chain;
          if (failure) break;
        }
      }
    }
    const decoderResult = await decoder.done;
    ingestPts('');
    if (stderrTail) {
      const info = parseShowinfoLine(stderrTail);
      if (info) pts.push(info);
      stderrTail = '';
    }
    pump();
    await chain;
    if (pending.length) throw fail('FACE_TRACK_DECODE', `帧字节与 showinfo 数量不一致（pending=${pending.length}, pts=${pts.length}, frames=${count}）`);
    if (failure) throw failure;
    if (filled) throw fail('FACE_TRACK_DECODE', `原始帧字节未对齐（tail=${filled}）`);
    if (!count) throw fail('FACE_TRACK_DECODE', `视频未完整解码：${stderr}`);
    if (pts.length !== count) throw fail('FACE_TRACK_DECODE', `帧字节与 showinfo 数量不一致（frames=${count}, pts=${pts.length}）`);
    if (cached && cached.frames.length !== count) throw fail('FACE_TRACK_CACHE', `缓存帧数 ${cached.frames.length} 与解码帧数 ${count} 不一致`);
    const lastSeconds = frames.at(-1).seconds;
    const lastDur = Number.isFinite(frames.at(-1).duration_time) && frames.at(-1).duration_time > 0
      ? frames.at(-1).duration_time
      : (1 / outputFps);
    const decodedDuration = lastSeconds + lastDur;
    const outputTiming = mapPtsToCfr(frames, { origin, fps: outputFps, endTime: origin + decodedDuration });
    if (mode === 'mask') {
      if (!lastOutput) throw fail('FACE_TRACK_DECODE', '没有可写入的遮罩帧');
      while (encodedCount < outputTiming.frame_count) await writeEncoded(lastOutput);
      if (encodedCount !== outputTiming.frame_count) {
        throw fail('FACE_TRACK_TIME', `CFR 映射帧数 ${encodedCount} 与计划 ${outputTiming.frame_count} 不一致`);
      }
    }
    encoder?.stdin.end();
    const results = await Promise.all([Promise.resolve(decoderResult), encoder ? encoder.done : Promise.resolve({ code: 0 })]);
    if (results.some(r => r.error || r.code !== 0)) throw fail('FACE_TRACK_DECODE', `视频未完整解码：${stderr}`);
    const summaries = cached ? (cached.tracks || []) : tracker.finish(lastSeconds);
    return {
      frames, thumbs, summaries, cuts: cached ? (cached.cuts || []) : tracker.cuts,
      encoded, work, sessionRuns, frame_count: count, decodedDuration, outputFps, encodedCount,
      outputTiming: {
        mode: 'pts_mapped_cfr',
        fps: outputFps,
        source_frames: count,
        output_frames: mode === 'mask' ? encodedCount : outputTiming.frame_count,
        duration: round(outputTiming.end - origin),
      },
    };
  } catch (error) {
    abort();
    await Promise.all([decoder.done, encoder ? encoder.done : Promise.resolve({})]).catch(() => {});
    if (encoded) fs.rmSync(encoded, { force: true });
    throw error;
  } finally {
    clearInterval(idle);
    signal?.removeEventListener('abort', abort);
  }
}

async function muxAudio({ ffmpeg, encoded, inputPath, outputPath, media }) {
  const duration = media.duration > 0 ? media.duration : null;
  const args = ['-nostdin', '-y', '-v', 'error', '-i', encoded];
  if (media.audio) {
    const offset = media.audio_offset_seconds || 0;
    args.push('-i', inputPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac');
    const filters = ['asetpts=PTS-STARTPTS'];
    if (offset > 0) filters.push(`adelay=${Math.round(offset * 1000)}:all=1`);
    else if (offset < 0) filters.push(`atrim=start=${-offset}`, 'asetpts=PTS-STARTPTS');
    if (duration > 0) filters.push('apad', `atrim=duration=${duration}`);
    args.push('-af', filters.join(','));
  } else args.push('-map', '0:v:0', '-c:v', 'copy');
  if (duration > 0) args.push('-t', String(duration));
  args.push('-movflags', '+faststart', outputPath);
  await runProcess(ffmpeg, args, { timeout: 180000 });
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
  if (!sameTrackingFingerprint(cached, p)) throw fail('FACE_TRACK_CACHE', '缓存跟踪参数与当前请求不一致（mask_mode 等绘制参数可单独改）');
  return cached;
}

async function executeNative(context, mode) {
  const { inputPath, outputPath, parameters: raw = {}, components, report = () => {}, signal } = context;
  const p = parametersFor(raw);
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw fail('FACE_OUTPUT_OVERWRITES_INPUT', '输出不能覆盖原始素材');
  const bins = components?.['media.ffmpeg']?.executables;
  if (!bins?.ffmpeg || !bins?.ffprobe) throw fail('FACE_TRACK_INPUT', '需要 media.ffmpeg 的 ffmpeg/ffprobe');
  const sharp = loadSharp(components);
  sharp.cache(false);
  sharp.concurrency(2);
  const started = Date.now();
  report({ stage: 'probe', message: '正在读取视频流时间基，不按猜测帧率换算' });
  const media = await probeMedia(bins.ffprobe, inputPath);
  media.outputPath = outputPath;
  if (media.duration > p.max_duration) throw fail('FACE_TRACK_LIMIT', `素材时长 ${round(media.duration)}s 超过上限 ${p.max_duration}s，请分段处理`);
  if (media.width * media.height > p.max_pixels) throw fail('FACE_TRACK_LIMIT', '源帧像素超过 max_pixels，请先缩小或裁切');
  const sourceHash = await sha256File(inputPath);
  const cached = loadCachedTracks(p, sourceHash, media.width, media.height);
  if (cached) report({ stage: 'cache', message: '复用 tracks_path 轨迹，跳过 ONNX 检测' });
  let session = null, ort = null;
  try {
    if (!cached) {
      ({ ort } = loadOrt(components));
      const modelPath = path.join(components['vision.face-detector'].directory, 'models/yunet.onnx');
      session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 });
    }
    const streamed = await streamVideo({
      ffmpeg: bins.ffmpeg, inputPath, media, p, sharp, session, ort, cached, mode, report, signal,
    });
    const containerDuration = media.duration;
    if (streamed.outputTiming?.duration > 0) media.duration = streamed.outputTiming.duration;
    else if (streamed.decodedDuration > 0) media.duration = streamed.decodedDuration;
    const dir = path.dirname(outputPath);
    const contact = await buildContactSheet(sharp, streamed.thumbs, dir, p);
    if (mode === 'mask') {
      await muxAudio({ ffmpeg: bins.ffmpeg, encoded: streamed.encoded, inputPath, outputPath, media });
      media.container_duration = containerDuration;
      const after = JSON.parse((await runProcess(bins.ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outputPath])).stdout);
      const outVideo = after.streams?.find(s => s.codec_type === 'video');
      if (!outVideo) throw fail('OUTPUT_UNPLAYABLE', '输出缺少视频轨');
      if (media.audio && !after.streams.some(s => s.codec_type === 'audio')) throw fail('OUTPUT_UNPLAYABLE', '输出缺少预期音轨');
      if (outVideo.width !== media.width || outVideo.height !== media.height) throw fail('OUTPUT_GEOMETRY', '输出画幅与源不一致');
    }
    const appliedFrames = streamed.frames.filter(frame => maskTargets(frame.tracks).length).length;
    const document = {
      schema_version: 1,
      schema: 'yinzi.video-face-tracking/v1',
      operation: mode === 'mask' ? 'local.video.face-mask' : 'local.video.track-faces',
      method: cached ? 'cached_tracks' : 'yunet_cpu_iou_landmark',
      quality_status: streamed.frames.some(frame => frame.detections.length) ? 'review_required' : 'unchanged',
      source: {
        path: inputPath,
        sha256: sourceHash,
        width: media.width,
        height: media.height,
        duration_seconds: round(media.duration),
        container_duration_seconds: round(Number.isFinite(media.container_duration) ? media.container_duration : containerDuration),
        start_time: round(media.origin),
        r_frame_rate: media.r_frame_rate,
        avg_frame_rate: media.avg_frame_rate,
        time_base: media.time_base,
        has_audio: media.has_audio,
        audio_start_time: media.audio_start_time == null ? null : round(media.audio_start_time),
        audio_offset_seconds: media.audio_offset_seconds == null ? null : round(media.audio_offset_seconds),
        vfr_hint: media.vfr_hint,
      },
      source_timeline_origin: round(media.origin),
      onnx_session_runs: streamed.sessionRuns,
      onnx_sessions_created: cached ? 0 : 1,
      cache_reused: Boolean(cached),
      parameters: {
        face_selection: p.face_selection,
        mask_mode: p.mask_mode,
        hold_seconds: p.hold_seconds,
        predict_motion: p.predict_motion,
        scene_threshold: p.scene_threshold,
        min_shot_seconds: p.min_shot_seconds,
        max_duration: p.max_duration,
        max_frames: p.max_frames,
        detection_size: p.detection_size,
        output_fps: p.output_fps,
        tracking: trackingFingerprint(p),
      },
      output_timing: streamed.outputTiming,
      sample: {
        frames_analyzed: streamed.frame_count,
        first_seconds: streamed.frames[0]?.seconds ?? null,
        last_seconds: streamed.frames.at(-1)?.seconds ?? null,
        first_pts_time: streamed.frames[0]?.pts_time ?? null,
        last_pts_time: streamed.frames.at(-1)?.pts_time ?? null,
        output_fps: streamed.outputFps,
        output_frames: streamed.outputTiming?.output_frames ?? null,
      },
      cuts: streamed.cuts,
      tracks: streamed.summaries,
      frames: streamed.frames,
      contact_sheet: contact,
      limitations: LIMITATIONS,
      quality_note: '跟踪不是身份识别。请打开接触表与抽帧核对遮罩是否跟脸；合成 Lena 运动只证明工程链路。',
    };
    const jsonPath = mode === 'mask'
      ? path.join(dir, `${path.basename(outputPath, path.extname(outputPath))}-faces.json`)
      : outputPath;
    writeJson(jsonPath, document);
    const assets = [];
    if (contact) assets.push({ file: contact.file, type: 'image', role: 'contact_sheet', title: '人脸跟踪接触表' });
    if (mode === 'mask') assets.push({ file: path.basename(jsonPath), type: 'document', role: 'face_tracks', title: '逐帧 PTS 与轨迹' });
    const detectedAny = streamed.frames.some(frame => frame.detections.length);
    return {
      status: mode === 'mask' ? (appliedFrames ? 'succeeded' : 'unchanged') : 'succeeded',
      before: {
        width: media.width, height: media.height, duration: media.duration, fps: media.fps,
        has_audio: media.has_audio, source_timeline_origin: media.origin,
        audio_offset_seconds: media.audio_offset_seconds,
      },
      after: mode === 'mask'
        ? {
          width: media.width, height: media.height, format: 'mp4', has_audio: media.has_audio,
          applied_frame_count: appliedFrames, duration: media.duration,
          output_fps: streamed.outputFps, output_frames: streamed.encodedCount,
        }
        : { format: 'json', frame_count: streamed.frame_count, track_count: streamed.summaries.length, cut_count: streamed.cuts.length },
      quality_status: detectedAny ? 'review_required' : 'unchanged',
      quality_note: document.quality_note,
      onnx_sessions_created: document.onnx_sessions_created,
      onnx_session_runs: streamed.sessionRuns,
      cache_reused: Boolean(cached),
      audio_handling: media.audio ? [{ mode: mode === 'mask' ? 'encode_aac' : 'analysis_only', offset_seconds: media.audio_offset_seconds }] : [],
      assets,
      processing_seconds: (Date.now() - started) / 1000,
    };
  } finally {
    await session?.release?.();
    const work = path.join(path.dirname(outputPath), 'face-stream-tmp');
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function parameter_schema() {
  return {
    type: 'object',
    properties: {
      ...faceDetectOperation().parameter_schema.properties,
      hold_seconds: { type: 'number', minimum: 0, maximum: 2, default: 0.15 },
      predict_motion: { type: 'boolean', default: false },
      predict_max_seconds: { type: 'number', minimum: 0, maximum: 2, default: 0.4 },
      scene_threshold: { type: 'number', minimum: 0.02, maximum: 0.9, default: 0.28 },
      min_shot_seconds: { type: 'number', minimum: 0.04, maximum: 30, default: 0.2 },
      analysis_width: { type: 'integer', minimum: 32, maximum: 640, default: 160 },
      analysis_height: { type: 'integer', minimum: 18, maximum: 360, default: 90 },
      max_duration: { type: 'number', minimum: 0.2, maximum: 120, default: 30 },
      max_frames: { type: 'integer', minimum: 8, maximum: 3600, default: 900 },
      match_min_score: { type: 'number', minimum: 0.05, maximum: 0.99, default: 0.25 },
      match_iou: { type: 'number', minimum: 0, maximum: 1, default: 0.1 },
      match_center_ratio: { type: 'number', minimum: 0.1, maximum: 2, default: 1 },
      tracks_path: { type: 'string', description: '复用 local.video.track-faces 的 JSON，跳过 ONNX；须作为 extra source 登记' },
      output_fps: { type: 'number', minimum: 0, maximum: 120, default: 0, description: '0=按平均/声明帧率做 PTS→CFR；>0 强制该 CFR' },
    },
  };
}

function attachFaceContract(op) {
  Object.defineProperties(op, {
    parameter_schema: { enumerable: true, get: parameter_schema },
    defaults: { enumerable: true, get: () => ({ ...faceDetectOperation().defaults, ...videoDefaults }) },
  });
  return op;
}

const common = {
  component_id: 'vision.face-detector',
  additional_components: ['media.sharp', 'media.ffmpeg'],
  validateParameters: parametersFor,
  source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
};

const trackFacesOperation = attachFaceContract({
  ...common,
  id: 'local.video.track-faces',
  title: '视频人脸框跟踪',
  kind: 'document',
  phase: 'analyze',
  output_extension: 'json',
  description: '逐帧定位视频中的人脸并记录连续轨迹，方便自动跟随遮罩和检查人物进出画面。',
  description_zh: '逐帧定位视频中的人脸并记录连续轨迹，方便自动跟随遮罩和检查人物进出画面。',
  executeNative: context => executeNative(context, 'track'),
});

const faceMaskOperation = attachFaceContract({
  ...common,
  id: 'local.video.face-mask',
  title: '视频人脸连续局部遮罩',
  kind: 'video',
  output_extension: 'mp4',
  description: '让模糊、马赛克、眼罩或网格随人脸移动，保留原画幅、音轨与画面节奏。',
  description_zh: '让模糊、马赛克、眼罩或网格随人脸移动，保留原画幅、音轨与画面节奏。',
  executeNative: context => executeNative(context, 'mask'),
});

module.exports = {
  trackFacesOperation,
  faceMaskOperation,
  executeNative,
  parametersFor,
  loadFaceImageOps,
  extraTrackSources,
  trackingFingerprint,
  chooseOutputFps,
  loadCachedTracks,
};