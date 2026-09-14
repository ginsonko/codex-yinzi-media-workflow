const fail = (code, message) => Object.assign(new Error(message), { code });
const round = n => Math.round(Number(n) * 1000000) / 1000000;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const LIMITATIONS = [
  '跟踪只按框、中心距和五点关键点做一对一匹配，不是身份重识别，也不能在切镜或长时间遮挡后认回同一个人。',
  'all：每个镜头首次检出的每个人脸获得 target_id，之后新进入的脸获得新 ID。largest/primary/index：只锁定选中的脸，其他人进出不会抢走已有 ID。',
  '默认失踪 hold_seconds=0.15，框冻结为最后一次检出，不外推。超时标记 lost 并停止绘制。predict_motion 才写 predicted，且与 detections 分开。',
  '切镜看缩小画面的像素差，不是脸框。切后全部 ID 结束（lost_reason=shot_cut），新镜头重新初始选择。',
  '局部遮罩不保证匿名化。MP4 默认按真实 PTS 做有界 CFR 映射（按槽复制/丢弃），不是把 N 个源帧按声明 -r 连续写入。轨迹真值在 JSON 的 pts_time/seconds。',
];

const TRACKING_PARAMETER_KEYS = [
  'face_selection', 'hold_seconds', 'predict_motion', 'predict_max_seconds',
  'scene_threshold', 'min_shot_seconds', 'match_min_score', 'match_iou',
  'match_center_ratio', 'detection_size', 'score_threshold', 'nms_threshold',
  'top_k', 'max_faces', 'target_index', 'force_user_rect',
  'analysis_width', 'analysis_height',
];

const DRAW_PARAMETER_KEYS = [
  'mask_mode', 'blur_sigma', 'pixelate_block_size', 'grid_cells', 'grid_opacity', 'expand_ratio',
];

function formatTimecode(seconds) {
  const sign = seconds < 0 ? '-' : '';
  const t = Math.abs(Number(seconds));
  if (!Number.isFinite(t)) throw fail('FACE_TRACK_TIME', '时间码不是有限秒数');
  const ms = Math.round(t * 1000);
  const milli = ms % 1000;
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${sign}${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(milli, 3)}`;
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

function mapPtsToCfr(frames, { origin = 0, fps, endTime } = {}) {
  if (!Array.isArray(frames) || !frames.length) throw fail('FACE_TRACK_TIME', '没有可映射的源帧');
  if (!Number.isFinite(fps) || fps < 1 || fps > 120) throw fail('FACE_TRACK_TIME', 'CFR 输出帧率需为 1–120');
  const last = frames.at(-1);
  const lastDur = Number.isFinite(last.duration_time) && last.duration_time > 0 ? last.duration_time : 1 / fps;
  const end = Number.isFinite(endTime) ? endTime : last.pts_time + lastDur;
  const endRel = end - origin;
  if (!(endRel > 0)) throw fail('FACE_TRACK_TIME', 'CFR 映射时长无效');
  const frameCount = Math.max(1, Math.round(endRel * fps));
  const mapping = [];
  let src = 0;
  for (let n = 0; n < frameCount; n++) {
    const t = origin + n / fps;
    while (src + 1 < frames.length && frames[src + 1].pts_time <= t + 1e-9) src++;
    mapping.push({ n, source_index: src, t: round(t) });
  }
  return { fps, origin, end: origin + frameCount / fps, frame_count: frameCount, mapping };
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

function iou(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function boxCenter(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function boxDiag(box) {
  return Math.hypot(box.width, box.height);
}

function landmarkMeanDistance(a, b) {
  if (!a || !b) return null;
  const names = ['right_eye', 'left_eye', 'nose_tip', 'mouth_right', 'mouth_left'];
  let sum = 0, n = 0;
  for (const name of names) {
    if (a[name] && b[name]) {
      sum += Math.hypot(a[name][0] - b[name][0], a[name][1] - b[name][1]);
      n++;
    }
  }
  return n ? sum / n : null;
}

function matchScore(trackBox, trackLandmarks, det, imageDiag) {
  const overlap = iou(trackBox, det.box);
  const c1 = boxCenter(trackBox), c2 = boxCenter(det.box);
  const centerDistance = Math.hypot(c1.x - c2.x, c1.y - c2.y);
  const centerScore = 1 - Math.min(1, centerDistance / Math.max(1, imageDiag * 0.5));
  const lm = landmarkMeanDistance(trackLandmarks, det.landmarks);
  const lmScore = lm == null ? centerScore : 1 - Math.min(1, lm / Math.max(1, imageDiag * 0.25));
  return {
    score: 0.5 * overlap + 0.3 * centerScore + 0.2 * lmScore,
    iou: overlap,
    center_distance: centerDistance,
  };
}

function associationBox(track, width, height, seconds, p = {}) {
  const box = track.last_detected_box;
  if (!box) return null;
  if (seconds == null || track.last_detected_seconds == null || !track.velocity) return box;
  const dt = seconds - track.last_detected_seconds;
  const horizon = (p.hold_seconds ?? 0.15) + ((p.predict_motion ? p.predict_max_seconds : 0) || 0);
  if (!(dt > 0) || dt > horizon + 1e-6) return box;
  return translateBox(box, track.velocity.x * dt, track.velocity.y * dt, width, height);
}

function greedyMatch(tracks, detections, width, height, p = {}, seconds = null) {
  const imageDiag = Math.hypot(width, height);
  const minScore = p.match_min_score ?? 0.25;
  const minIou = p.match_iou ?? 0.1;
  const centerRatio = p.match_center_ratio ?? 1;
  const pairs = [];
  for (const track of tracks) {
    const lastBox = track.last_detected_box;
    if (!lastBox) continue;
    const assoc = associationBox(track, width, height, seconds, p) || lastBox;
    for (const det of detections) {
      const last = matchScore(lastBox, track.last_detected_landmarks, det, imageDiag);
      const pred = assoc === lastBox ? last : matchScore(assoc, track.last_detected_landmarks, det, imageDiag);
      const measured = pred.score >= last.score ? pred : last;
      const centerLimit = centerRatio * Math.max(boxDiag(lastBox), boxDiag(det.box));
      if (measured.score >= minScore && (measured.iou >= minIou || measured.center_distance <= centerLimit)) {
        pairs.push({ track, det, ...measured });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedTracks = new Set(), usedDets = new Set(), assigned = [];
  for (const pair of pairs) {
    if (usedTracks.has(pair.track) || usedDets.has(pair.det)) continue;
    usedTracks.add(pair.track);
    usedDets.add(pair.det);
    assigned.push(pair);
  }
  return assigned;
}

function hellinger(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.sqrt(a[i] * b[i]);
  return Math.sqrt(Math.max(0, 1 - sum));
}

function frameSceneMetrics(buffer, width, height, previousBuffer, previousStats) {
  const pixels = width * height;
  const hist = new Float64Array(16);
  let lumaSum = 0, madSum = 0;
  for (let i = 0, p = 0; p < pixels; i += 3, p++) {
    const r = buffer[i], g = buffer[i + 1], b = buffer[i + 2];
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lumaSum += luma;
    hist[Math.min(15, luma >> 4)]++;
    if (previousBuffer) {
      madSum += Math.abs(r - previousBuffer[i]) + Math.abs(g - previousBuffer[i + 1]) + Math.abs(b - previousBuffer[i + 2]);
    }
  }
  const meanLuma = lumaSum / pixels / 255;
  for (let i = 0; i < 16; i++) hist[i] /= pixels;
  const motion = previousBuffer ? madSum / (pixels * 3 * 255) : 0;
  const lumaDelta = previousStats ? Math.abs(meanLuma - previousStats.luma) : 0;
  const histDistance = previousStats ? hellinger(hist, previousStats.hist) : 0;
  const score = previousStats ? 0.55 * motion + 0.35 * histDistance + 0.10 * lumaDelta : 0;
  return { luma: meanLuma, motion, score, hist };
}

function cloneBox(box) {
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function cloneLandmarks(landmarks) {
  if (!landmarks) return null;
  return Object.fromEntries(Object.entries(landmarks).map(([name, point]) => [name, [point[0], point[1]]]));
}

function translateBox(box, dx, dy, width, height) {
  const x = clamp(box.x + dx, 0, Math.max(0, width - 1));
  const y = clamp(box.y + dy, 0, Math.max(0, height - 1));
  const w = Math.max(1, Math.min(box.width, width - x));
  const h = Math.max(1, Math.min(box.height, height - y));
  return { x, y, width: w, height: h };
}

function translateLandmarks(landmarks, dx, dy, width, height) {
  if (!landmarks) return null;
  return Object.fromEntries(Object.entries(landmarks).map(([name, point]) => [
    name,
    [clamp(point[0] + dx, 0, width), clamp(point[1] + dy, 0, height)],
  ]));
}

class FaceTracker {
  constructor(p, width, height, chooseFaces) {
    this.p = p;
    this.width = width;
    this.height = height;
    this.chooseFaces = chooseFaces;
    this.nextId = 1;
    this.shotIndex = 0;
    this.locked = false;
    this.tracks = [];
    this.summaries = [];
    this.cuts = [];
    this.lastCutSeconds = 0;
  }

  newId() {
    return `T${String(this.nextId++).padStart(3, '0')}`;
  }

  spawn(det, seconds) {
    const center = boxCenter(det.box);
    const track = {
      id: this.newId(),
      shot_index: this.shotIndex,
      state: 'detected',
      box: cloneBox(det.box),
      landmarks: cloneLandmarks(det.landmarks),
      confidence: det.confidence,
      last_detected_box: cloneBox(det.box),
      last_detected_landmarks: cloneLandmarks(det.landmarks),
      last_detected_seconds: seconds,
      first_seconds: seconds,
      detection_count: 1,
      held_count: 0,
      predicted_count: 0,
      prev_center: center,
      velocity: { x: 0, y: 0 },
      detection_index: det.index ?? null,
    };
    this.tracks.push(track);
    return track;
  }

  closeTrack(track, seconds, reason) {
    this.summaries.push({
      target_id: track.id,
      shot_index: track.shot_index,
      first_seconds: round(track.first_seconds),
      last_detected_seconds: round(track.last_detected_seconds),
      lost_seconds: round(seconds),
      lost_reason: reason,
      detection_count: track.detection_count,
      held_count: track.held_count,
      predicted_count: track.predicted_count,
    });
  }

  resetShot(seconds, sample) {
    for (const track of this.tracks) this.closeTrack(track, seconds, 'shot_cut');
    this.tracks = [];
    this.locked = false;
    this.cuts.push({
      seconds: round(seconds),
      source_seconds: sample?.source_seconds ?? null,
      timecode: formatTimecode(seconds),
      score: sample?.scene_score ?? null,
      shot_index_closed: this.shotIndex,
    });
    this.shotIndex += 1;
    this.lastCutSeconds = seconds;
  }

  updateDetected(track, det, seconds, score) {
    const center = boxCenter(det.box);
    const dt = Math.max(1e-6, seconds - track.last_detected_seconds);
    track.velocity = {
      x: (center.x - track.prev_center.x) / dt,
      y: (center.y - track.prev_center.y) / dt,
    };
    track.prev_center = center;
    track.state = 'detected';
    track.box = cloneBox(det.box);
    track.landmarks = cloneLandmarks(det.landmarks);
    track.confidence = det.confidence;
    track.last_detected_box = cloneBox(det.box);
    track.last_detected_landmarks = cloneLandmarks(det.landmarks);
    track.last_detected_seconds = seconds;
    track.detection_count += 1;
    track.detection_index = det.index ?? null;
    track.match_score = score;
  }

  updateMissing(track, seconds) {
    const missing = seconds - track.last_detected_seconds;
    track.detection_index = null;
    track.match_score = null;
    if (missing <= this.p.hold_seconds) {
      track.state = 'held';
      track.box = cloneBox(track.last_detected_box);
      track.landmarks = cloneLandmarks(track.last_detected_landmarks);
      track.held_count += 1;
      return;
    }
    if (this.p.predict_motion && missing <= this.p.predict_max_seconds) {
      const dt = missing;
      const dx = track.velocity.x * dt;
      const dy = track.velocity.y * dt;
      track.state = 'predicted';
      track.box = translateBox(track.last_detected_box, dx, dy, this.width, this.height);
      track.landmarks = translateLandmarks(track.last_detected_landmarks, dx, dy, this.width, this.height);
      track.predicted_count += 1;
      return;
    }
    track.state = 'lost';
    track.box = null;
    track.landmarks = null;
  }

  snapshot(seconds, detections) {
    const live = [];
    const remaining = [];
    for (const track of this.tracks) {
      if (track.state === 'lost') {
        this.closeTrack(track, seconds, 'hold_timeout');
        continue;
      }
      remaining.push(track);
      live.push({
        target_id: track.id,
        state: track.state,
        box: track.box ? cloneBox(track.box) : null,
        last_detected_box: cloneBox(track.last_detected_box),
        landmarks: cloneLandmarks(track.landmarks),
        confidence: track.confidence ?? null,
        source: track.state === 'detected' ? 'detection'
          : track.state === 'held' ? 'hold_last_box'
            : track.state === 'predicted' ? 'predicted_constant_velocity' : null,
        predicted_box: track.state === 'predicted' && track.box ? cloneBox(track.box) : null,
        matched_detection_index: track.detection_index,
        match_score: track.match_score == null ? null : round(track.match_score),
        missing_seconds: round(Math.max(0, seconds - track.last_detected_seconds)),
        shot_index: track.shot_index,
      });
    }
    this.tracks = remaining;
    return {
      shot_index: this.shotIndex,
      detections: detections.map(det => ({
        box: cloneBox(det.box),
        confidence: det.confidence,
        landmarks: cloneLandmarks(det.landmarks),
        source: det.source || 'yunet_cpu',
        index: det.index ?? null,
        norm_box: det.norm_box || {
          x: det.box.x / this.width,
          y: det.box.y / this.height,
          width: det.box.width / this.width,
          height: det.box.height / this.height,
        },
      })),
      tracks: live,
    };
  }

  step({ seconds, detections, shotCut, scene_score, source_seconds }) {
    if (shotCut) this.resetShot(seconds, { scene_score, source_seconds });
    const candidates = this.tracks.filter(track => track.state !== 'lost');
    const assigned = greedyMatch(candidates, detections, this.width, this.height, this.p, seconds);
    const usedTracks = new Set(assigned.map(item => item.track));
    const usedDets = new Set(assigned.map(item => item.det));
    for (const item of assigned) this.updateDetected(item.track, item.det, seconds, item.score);
    for (const track of candidates) {
      if (!usedTracks.has(track)) this.updateMissing(track, seconds);
    }
    const unmatched = detections.filter(det => !usedDets.has(det));
    if (unmatched.length) {
      if (!this.locked) {
        if (!this.chooseFaces) throw fail('FACE_TRACK_INPUT', 'FaceTracker 需要图片 chooseFaces 做初始选择');
        const chosen = this.chooseFaces(unmatched, this.p, this.width, this.height);
        for (const det of chosen) this.spawn(det, seconds);
        this.locked = true;
      } else if (this.p.face_selection === 'all') {
        for (const det of unmatched) this.spawn(det, seconds);
      }
    }
    return this.snapshot(seconds, detections);
  }

  finish(seconds) {
    for (const track of this.tracks) this.closeTrack(track, seconds, 'eof');
    this.tracks = [];
    return this.summaries;
  }
}

module.exports = {
  LIMITATIONS,
  TRACKING_PARAMETER_KEYS,
  DRAW_PARAMETER_KEYS,
  fail,
  round,
  clamp,
  formatTimecode,
  parseShowinfoLine,
  parseRate,
  mapPtsToCfr,
  iou,
  boxCenter,
  matchScore,
  greedyMatch,
  frameSceneMetrics,
  FaceTracker,
};