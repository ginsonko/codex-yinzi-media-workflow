const fs = require('node:fs');
const path = require('node:path');
const { FACE_INFERENCE_SIZE } = require('./faceModelManifest');

const fail = (code, message) => Object.assign(new Error(message), { code });
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// ==========================================
// 1. 本地保纹理人脸美颜 (local.image.face-beauty)
// ==========================================

const beautyDefaults = {
  score_threshold: 0.6,
  nms_threshold: 0.3,
  top_k: 500,
  max_faces: 100,
  max_pixels: 24000000,
  detection_size: 640,
  face_selection: 'all',
  target_index: 0,
  expand_ratio: 0.2,
  smooth_strength: 0.6,       // 磨皮平滑强度 (0~1)
  texture_retention: 0.7,     // 皮肤纹理保留比例 (0~1)
  feature_protection: 0.85,   // 五官（眼、唇、眉）保护力度 (0~1)
  skin_tone_warmth: 0.05,     // 肤色暖度微调 (-0.5 ~ 0.5)
  skin_brighten: 0.08,        // 肤色提亮微调 (-0.5 ~ 0.5)
  skin_rosiness: 0.04,        // 肤色红润微调 (-0.5 ~ 0.5)
  feather_ratio: 0.25,        // 边缘羽化过渡带比例 (0.05 ~ 0.5)
  force_user_rect: false,
};

const beautyBounds = {
  score_threshold: [0.1, 0.99],
  nms_threshold: [0, 1],
  top_k: [1, 5000],
  max_faces: [1, 100],
  max_pixels: [1024, 40000000],
  detection_size: [FACE_INFERENCE_SIZE, FACE_INFERENCE_SIZE],
  target_index: [0, 99],
  expand_ratio: [0, 1],
  smooth_strength: [0, 1],
  texture_retention: [0, 1],
  feature_protection: [0, 1],
  skin_tone_warmth: [-0.5, 0.5],
  skin_brighten: [-0.5, 0.5],
  skin_rosiness: [-0.5, 0.5],
  feather_ratio: [0.05, 0.5],
};

const integerKeys = new Set(['top_k', 'max_faces', 'max_pixels', 'detection_size', 'target_index']);

function parametersForBeauty(raw = {}) {
  const p = { ...beautyDefaults, ...raw };
  for (const [key, [min, max]] of Object.entries(beautyBounds)) {
    if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < min || p[key] > max || (integerKeys.has(key) && !Number.isInteger(p[key]))) {
      throw fail('INVALID_PARAMETERS', `${key} 需为 ${min}–${max} 的${integerKeys.has(key) ? '整数' : '数值'}`);
    }
  }
  if (p.detection_size !== FACE_INFERENCE_SIZE) throw fail('INVALID_PARAMETERS', `当前锁定YuNet模型使用固定 ${FACE_INFERENCE_SIZE} 像素输入`);
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
  return p;
}

function overlap(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  return intersection / Math.max(1, a.width * a.height + b.width * b.height - intersection);
}

function decodeYuNet(outputs, { size, width, height, resizedWidth, resizedHeight, parameters: p }) {
  const candidates = [];
  const sx = width / resizedWidth, sy = height / resizedHeight;
  for (const stride of [8, 16, 32]) {
    const count = (size / stride) ** 2, cols = size / stride;
    const tensors = Object.fromEntries(['cls', 'obj', 'bbox', 'kps'].map(name => [name, outputs[`${name}_${stride}`]?.data]));
    if (['cls', 'obj', 'bbox', 'kps'].some(name => tensors[name]?.length !== count * ({ bbox: 4, kps: 10 }[name] || 1))) {
      throw fail('FACE_MODEL_OUTPUT_INVALID', 'YuNet模型输出布局不匹配');
    }
    for (let i = 0; i < count; i++) {
      const confidence = Math.sqrt(clamp(tensors.cls[i], 0, 1) * clamp(tensors.obj[i], 0, 1));
      if (!Number.isFinite(confidence) || confidence < p.score_threshold) continue;
      const col = i % cols, row = Math.floor(i / cols), b = tensors.bbox;
      const cx = (col + b[i * 4]) * stride, cy = (row + b[i * 4 + 1]) * stride;
      const bw = Math.exp(b[i * 4 + 2]) * stride, bh = Math.exp(b[i * 4 + 3]) * stride;
      if (![cx, cy, bw, bh].every(Number.isFinite)) continue;
      const x = clamp((cx - bw / 2) * sx, 0, width), y = clamp((cy - bh / 2) * sy, 0, height);
      const right = clamp((cx + bw / 2) * sx, 0, width), bottom = clamp((cy + bh / 2) * sy, 0, height);
      if (right <= x || bottom <= y) continue;
      const names = ['right_eye', 'left_eye', 'nose_tip', 'mouth_right', 'mouth_left'];
      const landmarks = Object.fromEntries(names.map((name, j) => [name, [(col + tensors.kps[i * 10 + j * 2]) * stride * sx, (row + tensors.kps[i * 10 + j * 2 + 1]) * stride * sy]]));
      if (!Object.values(landmarks).flat().every(Number.isFinite)) continue;
      candidates.push({ box: { x, y, width: right - x, height: bottom - y }, confidence, landmarks, source: 'yunet_cpu' });
    }
  }
  const selected = [];
  for (const face of candidates.sort((a, b) => b.confidence - a.confidence).slice(0, p.top_k)) {
    if (selected.some(other => overlap(face.box, other.box) > p.nms_threshold)) continue;
    selected.push({ ...face, index: selected.length, norm_box: { x: face.box.x / width, y: face.box.y / height, width: face.box.width / width, height: face.box.height / height } });
    if (selected.length >= p.max_faces) break;
  }
  return selected;
}

async function detectFaces({ sharp, ort, rgba, width, height, componentDir, parameters: p }) {
  const size = p.detection_size, scale = Math.min(size / width, size / height);
  const rw = Math.max(1, Math.round(width * scale)), rh = Math.max(1, Math.round(height * scale));
  const rgb = await sharp(rgba, { raw: { width, height, channels: 4 } }).flatten({ background: '#000000' }).resize(rw, rh, { fit: 'fill' }).extend({ right: size - rw, bottom: size - rh, top: 0, left: 0, background: '#000000' }).removeAlpha().raw().toBuffer();
  const pixels = size * size, input = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    input[i] = rgb[i * 3 + 2];
    input[pixels + i] = rgb[i * 3 + 1];
    input[2 * pixels + i] = rgb[i * 3];
  }
  const session = await ort.InferenceSession.create(path.join(componentDir, 'models/yunet.onnx'), { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 });
  try {
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) });
    return decodeYuNet(outputs, { size, width, height, resizedWidth: rw, resizedHeight: rh, parameters: p });
  } finally {
    await session.release();
  }
}

function chooseFaces(faces, p, width, height) {
  if (p.face_selection === 'index') {
    if (p.target_index >= faces.length) throw fail('FACE_INDEX_OUT_OF_RANGE', 'target_index 超出本次真实检出人脸范围');
    return [faces[p.target_index]];
  }
  if (p.face_selection === 'all') return faces;
  if (!faces.length) return [];
  const area = f => f.box.width * f.box.height;
  return [[...faces].sort((a, b) => p.face_selection === 'largest' ? area(b) - area(a) :
    (Math.hypot(a.box.x + a.box.width / 2 - width / 2, a.box.y + a.box.height / 2 - height / 2) - Math.hypot(b.box.x + b.box.width / 2 - width / 2, b.box.y + b.box.height / 2 - height / 2)))[0]];
}

function regionFor(box, width, height, expand = 0) {
  const left = clamp(Math.floor(box.x - box.width * expand / 2), 0, width - 1);
  const top = clamp(Math.floor(box.y - box.height * expand / 2), 0, height - 1);
  const right = clamp(Math.ceil(box.x + box.width * (1 + expand / 2)), left + 1, width);
  const bottom = clamp(Math.ceil(box.y + box.height * (1 + expand / 2)), top + 1, height);
  return { left, top, width: right - left, height: bottom - top };
}

async function applyBeautyEnhancement(sharp, originalBuffer, width, height, targets, p) {
  const output = Buffer.from(originalBuffer);
  const regions = [];

  for (const face of targets) {
    const r = regionFor(face.box, width, height, p.expand_ratio);
    regions.push({ ...r, source: face.source, index: face.index ?? null });

    const rw = r.width;
    const rh = r.height;
    if (rw < 4 || rh < 4) continue;

    const cropRgba = await sharp(originalBuffer, { raw: { width, height, channels: 4 } })
      .extract(r)
      .raw()
      .toBuffer();

    const smoothRadius = Math.max(1, Math.round(Math.min(rw, rh) * 0.02 * (0.5 + p.smooth_strength)));
    const lowFreqBuffer = await sharp(cropRgba, { raw: { width: rw, height: rh, channels: 4 } })
      .blur(smoothRadius)
      .raw()
      .toBuffer();

    const detailRadius = Math.max(0.5, smoothRadius * 0.25);
    const softLowBuffer = await sharp(cropRgba, { raw: { width: rw, height: rh, channels: 4 } })
      .blur(detailRadius)
      .raw()
      .toBuffer();

    const weights = new Float32Array(rw * rh);
    const featherPx = Math.max(2, Math.min(rw, rh) * p.feather_ratio);

    let re = null, le = null, mr = null, ml = null;
    let eyeDist = rw * 0.35;
    let ex = 1, ey = 0;
    let ux = 0, uy = -1;

    if (face.landmarks) {
      re = [face.landmarks.right_eye[0] - r.left, face.landmarks.right_eye[1] - r.top];
      le = [face.landmarks.left_eye[0] - r.left, face.landmarks.left_eye[1] - r.top];
      mr = [face.landmarks.mouth_right[0] - r.left, face.landmarks.mouth_right[1] - r.top];
      ml = [face.landmarks.mouth_left[0] - r.left, face.landmarks.mouth_left[1] - r.top];
      eyeDist = Math.max(8, Math.hypot(le[0] - re[0], le[1] - re[1]));
      ex = (le[0] - re[0]) / eyeDist;
      ey = (le[1] - re[1]) / eyeDist;
      ux = ey;
      uy = -ex; // 垂直于双眼连线、向上指向眉毛的单位法向量
    } else {
      re = [rw * 0.35, rh * 0.38];
      le = [rw * 0.65, rh * 0.38];
      mr = [rw * 0.4, rh * 0.72];
      ml = [rw * 0.6, rh * 0.72];
      ex = 1;
      ey = 0;
      ux = 0;
      uy = -1;
    }

    // 眉毛中心位置（沿向上法向量偏移约 0.40 * eyeDist）
    const rb = [re[0] + ux * eyeDist * 0.40, re[1] + uy * eyeDist * 0.40];
    const lb = [le[0] + ux * eyeDist * 0.40, le[1] + uy * eyeDist * 0.40];

    const eyeRadiusX = eyeDist * 0.42;
    const eyeRadiusY = eyeDist * 0.30;
    const browRadiusX = eyeDist * 0.45;
    const browRadiusY = eyeDist * 0.25;
    const mouthRadiusX = Math.max(8, Math.hypot(ml[0] - mr[0], ml[1] - mr[1]) * 0.80);
    const mouthRadiusY = mouthRadiusX * 0.55;
    const mouthCenter = [(mr[0] + ml[0]) / 2, (mr[1] + ml[1]) / 2];

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const idx = y * rw + x;
        const distLeft = x;
        const distRight = rw - 1 - x;
        const distTop = y;
        const distBottom = rh - 1 - y;
        const minEdgeDist = Math.min(distLeft, distRight, distTop, distBottom);
        let edgeWeight = 1.0;
        if (minEdgeDist < featherPx) {
          edgeWeight = 0.5 * (1 - Math.cos((Math.PI * minEdgeDist) / featherPx));
        }

        let featureFactor = 0.0;
        if (p.feature_protection > 0) {
          const testEllipse = (cx, cy, rx, ry) => {
            const dx = (x - cx) * ex + (y - cy) * ey;
            const dy = (x - cx) * ux + (y - cy) * uy;
            const d = Math.hypot(dx / rx, dy / ry);
            if (d < 1.0) {
              const f = d <= 0.5 ? 1.0 : 0.5 * (1 + Math.cos(Math.PI * (d - 0.5) / 0.5));
              featureFactor = Math.max(featureFactor, f);
            }
          };
          testEllipse(re[0], re[1], eyeRadiusX, eyeRadiusY);
          testEllipse(le[0], le[1], eyeRadiusX, eyeRadiusY);
          testEllipse(rb[0], rb[1], browRadiusX, browRadiusY);
          testEllipse(lb[0], lb[1], browRadiusX, browRadiusY);
          testEllipse(mouthCenter[0], mouthCenter[1], mouthRadiusX, mouthRadiusY);
        }

        const protectMult = Math.max(0, 1.0 - (featureFactor * p.feature_protection));
        weights[idx] = clamp(edgeWeight * p.smooth_strength * protectMult, 0, 1);
      }
    }

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const localIdx = (y * rw + x) * 4;
        const outIdx = ((y + r.top) * width + (x + r.left)) * 4;
        const w = weights[y * rw + x];

        const origR = cropRgba[localIdx];
        const origG = cropRgba[localIdx + 1];
        const origB = cropRgba[localIdx + 2];
        const origA = cropRgba[localIdx + 3];

        if (w <= 0.0001) continue;

        const lowR = lowFreqBuffer[localIdx];
        const lowG = lowFreqBuffer[localIdx + 1];
        const lowB = lowFreqBuffer[localIdx + 2];

        const softR = softLowBuffer[localIdx];
        const softG = softLowBuffer[localIdx + 1];
        const softB = softLowBuffer[localIdx + 2];

        const texR = origR - softR;
        const texG = origG - softG;
        const texB = origB - softB;

        let targetR = lowR + texR * p.texture_retention;
        let targetG = lowG + texG * p.texture_retention;
        let targetB = lowB + texB * p.texture_retention;

        if (p.skin_brighten !== 0 || p.skin_tone_warmth !== 0 || p.skin_rosiness !== 0) {
          targetR += p.skin_brighten * 25 + p.skin_tone_warmth * 20 + p.skin_rosiness * 15;
          targetG += p.skin_brighten * 25 + p.skin_tone_warmth * 10 - p.skin_rosiness * 5;
          targetB += p.skin_brighten * 25 - p.skin_tone_warmth * 15 - p.skin_rosiness * 10;
        }

        output[outIdx] = clamp(Math.round(origR * (1 - w) + targetR * w), 0, 255);
        output[outIdx + 1] = clamp(Math.round(origG * (1 - w) + targetG * w), 0, 255);
        output[outIdx + 2] = clamp(Math.round(origB * (1 - w) + targetB * w), 0, 255);
        output[outIdx + 3] = origA;
      }
    }
  }

  return { output, regions };
}

async function processBeautyImage({ inputPath, outputPath, parameters: raw = {}, requireComponent, requireComponents, componentDir }) {
  const p = parametersForBeauty(raw);
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw fail('FACE_OUTPUT_OVERWRITES_INPUT', '输出不能覆盖原始素材');
  }
  const sharp = (requireComponents?.['media.sharp'] || requireComponent)('sharp');
  sharp.cache(false);
  sharp.concurrency(2);

  const started = Date.now();
  const inputMeta = await sharp(inputPath).metadata();
  const rawOrientation = inputMeta.orientation;

  const { data: rgba, info } = await sharp(inputPath, { failOn: 'error', limitInputPixels: p.max_pixels })
    .autoOrient()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const ort = requireComponents?.['vision.face-detector'] ? requireComponents['vision.face-detector']('onnxruntime-node') : requireComponent('onnxruntime-node');

  const faces = p.force_user_rect ? [] : await detectFaces({ sharp, ort, rgba, width, height, componentDir, parameters: p });
  const manual = Boolean(p.user_rect && (p.force_user_rect || !faces.length));
  const targets = manual ? [{ box: { x: p.user_rect.x * width, y: p.user_rect.y * height, width: p.user_rect.width * width, height: p.user_rect.height * height }, source: 'user_rect' }] : chooseFaces(faces, p, width, height);

  const result = {
    status: targets.length ? 'succeeded' : 'unchanged',
    dimensions: { width, height },
    before: { width, height, orientation: rawOrientation || 1 },
    detected_count: faces.length,
    faces,
    detection_mode: p.force_user_rect ? 'skipped_manual' : 'yunet_cpu',
    manual_region_count: manual ? 1 : 0,
    applied_count: targets.length,
    metadata_policy: 'auto_oriented_pixels_exif_normalized',
    exif_orientation_applied: rawOrientation || 1,
    processing_seconds: 0,
    quality_status: targets.length ? 'review_required' : 'unchanged',
    quality_note: targets.length
      ? '已完成局部保纹理美颜处理，保留五官关键特征及皮肤纹理。像素方向已按EXIF自动定向标准化。视觉效果请打开成片人工确认。'
      : '本次未检出人脸，像素方向已按EXIF自动定向标准化，已原样保留画面。',
  };

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch (err) {
    throw fail('OUTPUT_DIRECTORY_UNWRITABLE', `无法创建输出目录: ${err.message}`);
  }

  if (!targets.length) {
    try {
      await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
    } catch (err) {
      throw fail('OUTPUT_WRITE_FAILED', `输出图像写入失败: ${err.message}`);
    }
    result.processing_seconds = (Date.now() - started) / 1000;
    result.after = { width, height, format: 'png', orientation: 1 };
    const receiptFile = path.join(path.dirname(outputPath), path.basename(outputPath, path.extname(outputPath)) + '-beauty.json');
    fs.writeFileSync(receiptFile, JSON.stringify(result, null, 2));
    result.assets = [{ file: path.basename(receiptFile), type: 'document', role: 'face_beauty', title: '美颜处理记录' }];
    return result;
  }

  const { output, regions } = await applyBeautyEnhancement(sharp, rgba, width, height, targets, p);
  try {
    await sharp(output, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
  } catch (err) {
    throw fail('OUTPUT_WRITE_FAILED', `输出图像写入失败: ${err.message}`);
  }

  Object.assign(result, {
    applied_regions: regions,
    after: { width, height, format: 'png', orientation: 1 },
    processing_seconds: (Date.now() - started) / 1000,
  });

  const receiptFile = path.join(path.dirname(outputPath), path.basename(outputPath, path.extname(outputPath)) + '-beauty.json');
  fs.writeFileSync(receiptFile, JSON.stringify(result, null, 2));
  result.assets = [{ file: path.basename(receiptFile), type: 'document', role: 'face_beauty', title: '美颜处理记录' }];
  return result;
}

const faceBeautyOperation = {
  kind: 'image',
  id: 'local.image.face-beauty',
  title: '本地保纹理人脸美颜',
  description: 'Local texture-preserving face smoothing, skin tone enhancement and facial feature protection.',
  description_zh: '本地自动定位单脸/多脸，采用分频纹理保留磨皮与五官特征保护，支持可调平滑度、纹理感与局部肤色微调；支持无脸安全退路与手动区域。',
  output_extension: 'png',
  component_id: 'vision.face-detector',
  additional_components: ['media.sharp'],
  worker_timeout_ms: 180000,
  validateParameters: parametersForBeauty,
  defaults: beautyDefaults,
  source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
  processFile: context => processBeautyImage(context),
};

// ==========================================
// 2. 肤色局部定向调整 (local.image.skin-tone)
// ==========================================

const skinToneDefaults = {
  score_threshold: 0.6,
  nms_threshold: 0.3,
  top_k: 500,
  max_faces: 100,
  max_pixels: 24000000,
  detection_size: 640,
  face_selection: 'all',
  target_index: 0,
  expand_ratio: 0.35,
  tone_mode: 'natural_fair', // natural_fair (自然透亮白皙), warm_glow (温暖气色), cool_tone (冷白皮), rosy (红润气色)
  intensity: 0.7,            // 调整力度 0~1
  brightness_boost: 0.06,    // 局部亮度微调 -0.3 ~ 0.3
  preserve_background: true, // 严格保护背景不受调色干扰
  feather_ratio: 0.3,
  force_user_rect: false,
};

const skinToneBounds = {
  score_threshold: [0.1, 0.99],
  nms_threshold: [0, 1],
  top_k: [1, 5000],
  max_faces: [1, 100],
  max_pixels: [1024, 40000000],
  detection_size: [FACE_INFERENCE_SIZE, FACE_INFERENCE_SIZE],
  target_index: [0, 99],
  expand_ratio: [0, 1],
  intensity: [0, 1],
  brightness_boost: [-0.3, 0.3],
  feather_ratio: [0.05, 0.5],
};

function parametersForSkinTone(raw = {}) {
  const p = { ...skinToneDefaults, ...raw };
  for (const [key, [min, max]] of Object.entries(skinToneBounds)) {
    if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < min || p[key] > max || (integerKeys.has(key) && !Number.isInteger(p[key]))) {
      throw fail('INVALID_PARAMETERS', `${key} 需为 ${min}–${max} 的${integerKeys.has(key) ? '整数' : '数值'}`);
    }
  }
  if (!['natural_fair', 'warm_glow', 'cool_tone', 'rosy'].includes(p.tone_mode)) {
    throw fail('INVALID_PARAMETERS', 'tone_mode 必须是 natural_fair, warm_glow, cool_tone 或 rosy');
  }
  if (!['all', 'largest', 'primary', 'index'].includes(p.face_selection)) throw fail('INVALID_PARAMETERS', '人脸选择无效');
  if (typeof p.force_user_rect !== 'boolean') throw fail('INVALID_PARAMETERS', 'force_user_rect 需为布尔值');
  if (typeof p.preserve_background !== 'boolean') throw fail('INVALID_PARAMETERS', 'preserve_background 需为布尔值');
  if (p.user_rect !== undefined) {
    const r = p.user_rect;
    if (!r || Array.isArray(r) || ['x', 'y', 'width', 'height'].some(k => typeof r[k] !== 'number' || !Number.isFinite(r[k])) ||
        r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1) {
      throw fail('INVALID_PARAMETERS', 'user_rect 需为图内完整归一化矩形');
    }
  }
  if (p.force_user_rect && !p.user_rect) throw fail('INVALID_PARAMETERS', '强制手动区域时需提供user_rect');
  return p;
}

// 肤色探测启发式（YCbCr/RGB色彩空间检测皮肤色度，避免头发和背景衣物被当做皮肤微调）
function isSkinTonePixel(r, g, b) {
  // 简易且鲁棒的 RGB 肤色色彩学判据
  // R > G > B, R - G >= 10, (max - min) >= 15
  if (r > 60 && g > 40 && b > 20 && r > g && g >= b && (r - g) >= 8 && (r - b) >= 12) {
    return true;
  }
  return false;
}

async function applySkinToneAdjustment(sharp, originalBuffer, width, height, targets, p) {
  const output = Buffer.from(originalBuffer);
  const regions = [];

  // 模式调色色彩矩阵偏移
  let dr = 0, dg = 0, db = 0;
  if (p.tone_mode === 'natural_fair') {
    dr = 14 * p.intensity;
    dg = 12 * p.intensity;
    db = 14 * p.intensity;
  } else if (p.tone_mode === 'warm_glow') {
    dr = 20 * p.intensity;
    dg = 10 * p.intensity;
    db = -5 * p.intensity;
  } else if (p.tone_mode === 'cool_tone') {
    dr = 5 * p.intensity;
    dg = 10 * p.intensity;
    db = 22 * p.intensity;
  } else if (p.tone_mode === 'rosy') {
    dr = 22 * p.intensity;
    dg = 6 * p.intensity;
    db = 10 * p.intensity;
  }

  const brightShift = p.brightness_boost * 40;

  for (const face of targets) {
    const r = regionFor(face.box, width, height, p.expand_ratio);
    regions.push({ ...r, source: face.source, index: face.index ?? null });

    const rw = r.width;
    const rh = r.height;
    if (rw < 4 || rh < 4) continue;

    const featherPx = Math.max(2, Math.min(rw, rh) * p.feather_ratio);

    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const outIdx = ((y + r.top) * width + (x + r.left)) * 4;

        const origR = output[outIdx];
        const origG = output[outIdx + 1];
        const origB = output[outIdx + 2];
        const origA = output[outIdx + 3];

        // 边缘余弦羽化
        const minEdgeDist = Math.min(x, rw - 1 - x, y, rh - 1 - y);
        let edgeWeight = 1.0;
        if (minEdgeDist < featherPx) {
          edgeWeight = 0.5 * (1 - Math.cos((Math.PI * minEdgeDist) / featherPx));
        }

        // 肤色软性判据 (Skin mask)
        let skinWeight = 1.0;
        if (p.preserve_background) {
          if (!isSkinTonePixel(origR, origG, origB)) {
            skinWeight = 0.15; // 非皮肤像素（头发、背景）大幅衰减，保留自然过渡
          }
        }

        const effWeight = edgeWeight * skinWeight * p.intensity;
        if (effWeight <= 0.001) continue;

        const targetR = clamp(origR + dr + brightShift, 0, 255);
        const targetG = clamp(origG + dg + brightShift, 0, 255);
        const targetB = clamp(origB + db + brightShift, 0, 255);

        output[outIdx] = Math.round(origR * (1 - effWeight) + targetR * effWeight);
        output[outIdx + 1] = Math.round(origG * (1 - effWeight) + targetG * effWeight);
        output[outIdx + 2] = Math.round(origB * (1 - effWeight) + targetB * effWeight);
      }
    }
  }

  return { output, regions };
}

async function processSkinToneImage({ inputPath, outputPath, parameters: raw = {}, requireComponent, requireComponents, componentDir }) {
  const p = parametersForSkinTone(raw);
  if (path.resolve(inputPath) === path.resolve(outputPath)) {
    throw fail('FACE_OUTPUT_OVERWRITES_INPUT', '输出不能覆盖原始素材');
  }
  const sharp = (requireComponents?.['media.sharp'] || requireComponent)('sharp');
  sharp.cache(false);
  sharp.concurrency(2);

  const started = Date.now();
  const inputMeta = await sharp(inputPath).metadata();
  const rawOrientation = inputMeta.orientation;

  const { data: rgba, info } = await sharp(inputPath, { failOn: 'error', limitInputPixels: p.max_pixels })
    .autoOrient()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const ort = requireComponents?.['vision.face-detector'] ? requireComponents['vision.face-detector']('onnxruntime-node') : requireComponent('onnxruntime-node');

  const faces = p.force_user_rect ? [] : await detectFaces({ sharp, ort, rgba, width, height, componentDir, parameters: p });
  const manual = Boolean(p.user_rect && (p.force_user_rect || !faces.length));
  const targets = manual ? [{ box: { x: p.user_rect.x * width, y: p.user_rect.y * height, width: p.user_rect.width * width, height: p.user_rect.height * height }, source: 'user_rect' }] : chooseFaces(faces, p, width, height);

  const result = {
    status: targets.length ? 'succeeded' : 'unchanged',
    dimensions: { width, height },
    before: { width, height, orientation: rawOrientation || 1 },
    detected_count: faces.length,
    faces,
    detection_mode: p.force_user_rect ? 'skipped_manual' : 'yunet_cpu',
    manual_region_count: manual ? 1 : 0,
    applied_count: targets.length,
    metadata_policy: 'auto_oriented_pixels_exif_normalized',
    exif_orientation_applied: rawOrientation || 1,
    processing_seconds: 0,
    quality_status: targets.length ? 'review_required' : 'unchanged',
    quality_note: targets.length
      ? `已完成局部肤色定向调整 [${p.tone_mode}]，保持背景与非皮肤区域稳定。像素方向已按EXIF自动定向标准化。视觉效果请打开成片人工确认。`
      : '本次未检出人脸，像素方向已按EXIF自动定向标准化，已原样保留画面。',
  };

  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  } catch (err) {
    throw fail('OUTPUT_DIRECTORY_UNWRITABLE', `无法创建输出目录: ${err.message}`);
  }

  if (!targets.length) {
    try {
      await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
    } catch (err) {
      throw fail('OUTPUT_WRITE_FAILED', `输出图像写入失败: ${err.message}`);
    }
    result.processing_seconds = (Date.now() - started) / 1000;
    result.after = { width, height, format: 'png', orientation: 1 };
    const receiptFile = path.join(path.dirname(outputPath), path.basename(outputPath, path.extname(outputPath)) + '-skintone.json');
    fs.writeFileSync(receiptFile, JSON.stringify(result, null, 2));
    result.assets = [{ file: path.basename(receiptFile), type: 'document', role: 'skin_tone', title: '肤色调整记录' }];
    return result;
  }

  const { output, regions } = await applySkinToneAdjustment(sharp, rgba, width, height, targets, p);
  try {
    await sharp(output, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
  } catch (err) {
    throw fail('OUTPUT_WRITE_FAILED', `输出图像写入失败: ${err.message}`);
  }

  Object.assign(result, {
    applied_regions: regions,
    after: { width, height, format: 'png' },
    processing_seconds: (Date.now() - started) / 1000,
  });

  const receiptFile = path.join(path.dirname(outputPath), path.basename(outputPath, path.extname(outputPath)) + '-skintone.json');
  fs.writeFileSync(receiptFile, JSON.stringify(result, null, 2));
  result.assets = [{ file: path.basename(receiptFile), type: 'document', role: 'skin_tone', title: '肤色调整记录' }];
  return result;
}

const skinToneOperation = {
  kind: 'image',
  id: 'local.image.skin-tone',
  title: '局部肤色定向修饰',
  description: 'Targeted skin tone enhancement, natural fair white, warm glow, or rosy complexion for detected faces while preserving surrounding context.',
  description_zh: '针对检测人脸或指定区域定向进行肤色白皙、暖阳、冷白或红润修饰，保护头发与背景不偏色。',
  output_extension: 'png',
  component_id: 'vision.face-detector',
  additional_components: ['media.sharp'],
  worker_timeout_ms: 180000,
  validateParameters: parametersForSkinTone,
  defaults: skinToneDefaults,
  source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
  processFile: context => processSkinToneImage(context),
};

module.exports = {
  faceBeautyOperation,
  parametersForBeauty,
  applyBeautyEnhancement,
  skinToneOperation,
  parametersForSkinTone,
  applySkinToneAdjustment,
  chooseFaces,
  regionFor,
  decodeYuNet,
};
