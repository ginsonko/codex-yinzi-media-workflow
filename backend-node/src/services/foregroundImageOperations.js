'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  FOREGROUND_INFERENCE_SIZE,
  FOREGROUND_MEAN,
  FOREGROUND_STD,
  MODELS,
} = require('./foregroundModelManifest');

const fail = (code, message) => Object.assign(new Error(message), { code });
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const defaults = {
  model: 'u2netp',
  strength: 1,
  threshold: 0,
  feather_px: 0,
  max_pixels: 24_000_000,
  min_foreground_coverage: 0.004,
  max_foreground_coverage: 0.985,
  route: 'auto',
  keep_source_alpha: true,
};

const bounds = {
  strength: [0.25, 4],
  threshold: [0, 250],
  feather_px: [0, 64],
  max_pixels: [1024, 40_000_000],
  min_foreground_coverage: [0, 0.5],
  max_foreground_coverage: [0.5, 1],
};

const integerKeys = new Set(['threshold', 'feather_px', 'max_pixels']);

function parametersFor(raw = {}) {
  const p = { ...defaults, ...raw };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < min || p[key] > max
      || (integerKeys.has(key) && !Number.isInteger(p[key]))) {
      throw fail('INVALID_PARAMETERS', `${key} 需为 ${min}–${max} 的${integerKeys.has(key) ? '整数' : '数值'}`);
    }
  }
  if (!['u2netp', 'u2net'].includes(p.model)) throw fail('INVALID_PARAMETERS', 'model 仅支持 u2netp 或 u2net');
  if (!['auto', 'user_mask'].includes(p.route)) throw fail('INVALID_PARAMETERS', 'route 仅支持 auto 或 user_mask');
  if (typeof p.keep_source_alpha !== 'boolean') throw fail('INVALID_PARAMETERS', 'keep_source_alpha 需为布尔值');
  if (p.mask_source != null && (!Number.isInteger(p.mask_source) || p.mask_source < 0)) {
    throw fail('INVALID_PARAMETERS', 'mask_source 必须是 sources 中的非负整数索引');
  }
  if (p.route === 'user_mask' && p.mask_source == null) throw fail('INVALID_PARAMETERS', 'user_mask 路线需要 mask_source');
  if (p.model_dir != null && typeof p.model_dir !== 'string') throw fail('INVALID_PARAMETERS', 'model_dir 必须是目录路径字符串');
  return p;
}

function sourceAt(sources, index, role) {
  if (!Number.isInteger(index) || !sources[index]) throw fail('INVALID_SOURCES', `${role} 需要指向有效的 sources 数字索引`);
  return sources[index].path;
}

function maskStats(mask) {
  if (!mask?.length) throw fail('FOREGROUND_MASK_EMPTY', '主体蒙版为空');
  let sum = 0, sumSq = 0, min = 1, max = 0, above = 0;
  for (const value of mask) {
    const v = value / 255;
    sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (value >= 16) above++;
  }
  const mean = sum / mask.length;
  return { mean, std: Math.sqrt(Math.max(0, sumSq / mask.length - mean * mean)), min, max, pixels: mask.length, occupied: above / mask.length };
}

function classifyMask(stats, parameters, rawRange) {
  if (!stats?.pixels) return { usable: false, unchanged: false, reason: 'invalid', code: 'FOREGROUND_MASK_INVALID', message: '主体蒙版为空' };
  // Explicit masks describe the user's chosen region, including tiny details.
  if (parameters.route === 'user_mask') return { usable: stats.max > 0, unchanged: false, reason: 'user_mask', review_required: true };
  const span = rawRange && Number.isFinite(rawRange.max - rawRange.min) ? rawRange.max - rawRange.min : null;
  if (span != null && (span < 0.08 || rawRange.max < 0.12)) {
    return { usable: false, unchanged: true, reason: 'no_foreground', code: 'FOREGROUND_UNCHANGED', message: `模型响应过弱（span=${span.toFixed(4)}），按零对象处理` };
  }
  if (stats.max <= 1 / 255 || stats.mean < parameters.min_foreground_coverage) {
    return { usable: false, unchanged: true, reason: 'no_foreground', code: 'FOREGROUND_UNCHANGED', message: `未检出可用主体（mean=${stats.mean.toFixed(4)}）` };
  }
  if (stats.mean > parameters.max_foreground_coverage && stats.min > 0.2) {
    return { usable: true, unchanged: false, reason: 'near_full', review_required: true };
  }
  return { usable: true, unchanged: false, reason: 'ok', review_required: true };
}

function rembgNormalize(rgb, width, height, mean = FOREGROUND_MEAN, std = FOREGROUND_STD) {
  if (rgb.length !== width * height * 3) throw fail('FOREGROUND_INPUT_INVALID', 'RGB 缓冲尺寸不匹配');
  let peak = 1e-6;
  for (let i = 0; i < rgb.length; i++) if (rgb[i] > peak) peak = rgb[i];
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  for (let i = 0, p = 0; i < plane; i++, p += 3) {
    out[i] = (rgb[p] / peak - mean[0]) / std[0];
    out[plane + i] = (rgb[p + 1] / peak - mean[1]) / std[1];
    out[plane * 2 + i] = (rgb[p + 2] / peak - mean[2]) / std[2];
  }
  return out;
}

function decodeU2Net(output) {
  const data = output?.data;
  const dims = output?.dims || [];
  if (!data?.length || !dims.length) throw fail('FOREGROUND_MODEL_OUTPUT_INVALID', 'U2Net 输出为空');
  if (![2, 3, 4].includes(dims.length) || dims.some(d => !Number.isSafeInteger(d) || d <= 0)
    || dims.slice(0, -2).some(d => d !== 1)) throw fail('FOREGROUND_MODEL_OUTPUT_INVALID', 'U2Net 需要单张单通道主体蒙版');
  let spatial = data.length;
  let width = FOREGROUND_INFERENCE_SIZE;
  let height = FOREGROUND_INFERENCE_SIZE;
  if (dims.length === 4) {
    height = dims[2];
    width = dims[3];
    spatial = width * height;
  } else if (dims.length === 3) {
    height = dims[1];
    width = dims[2];
    spatial = width * height;
  } else if (dims.length === 2) {
    height = dims[0];
    width = dims[1];
    spatial = width * height;
  }
  if (spatial <= 0 || data.length !== spatial) throw fail('FOREGROUND_MODEL_OUTPUT_INVALID', 'U2Net 输出布局不匹配');
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < spatial; i++) {
    const v = data[i];
    if (!Number.isFinite(v)) throw fail('FOREGROUND_MODEL_OUTPUT_INVALID', 'U2Net 输出含无效数值');
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  const mask = Buffer.alloc(spatial);
  if (!(span > 0) || !Number.isFinite(span)) return { mask, width, height, min, max };
  for (let i = 0; i < spatial; i++) mask[i] = Math.max(0, Math.min(255, Math.round(((data[i] - min) / span) * 255)));
  return { mask, width, height, min, max };
}

function applyStrength(mask, parameters) {
  const out = Buffer.alloc(mask.length);
  const strength = parameters.strength;
  const threshold = parameters.threshold;
  for (let i = 0; i < mask.length; i++) {
    let v = mask[i];
    if (v < threshold) v = 0;
    if (strength !== 1 && v > 0) v = Math.max(0, Math.min(255, Math.round(255 * ((v / 255) ** (1 / strength)))));
    out[i] = v;
  }
  return out;
}

function blur2d(mask, width, height, radius) {
  if (!radius) return Buffer.from(mask);
  const horiz = new Float32Array(mask.length);
  const window = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    let acc = 0;
    const row = y * width;
    for (let x = -radius; x <= radius; x++) acc += mask[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x++) {
      horiz[row + x] = acc / window;
      acc += mask[row + Math.min(width - 1, x + radius + 1)] - mask[row + Math.max(0, x - radius)];
    }
  }
  const vert = Buffer.alloc(mask.length);
  for (let x = 0; x < width; x++) {
    let acc = 0;
    for (let y = -radius; y <= radius; y++) acc += horiz[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y++) {
      vert[y * width + x] = Math.max(0, Math.min(255, Math.round(acc / window)));
      acc += horiz[Math.min(height - 1, y + radius + 1) * width + x] - horiz[Math.max(0, y - radius) * width + x];
    }
  }
  return vert;
}

function compositeRgba(src, mask, width, height, keepSourceAlpha) {
  if (src.length !== width * height * 4 || mask.length !== width * height) {
    throw fail('FOREGROUND_MASK_INVALID', '主体蒙版与画面尺寸不一致');
  }
  const out = Buffer.from(src);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const sourceA = keepSourceAlpha ? src[p + 3] : 255;
    out[p + 3] = Math.max(0, Math.min(255, Math.round(sourceA * (mask[i] / 255))));
  }
  return out;
}

function luminanceMask(rgba, width, height) {
  const out = Buffer.alloc(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round((0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) * (rgba[p + 3] / 255));
  }
  return out;
}

function resolveModelFile(componentDir, parameters) {
  const extras = [];
  if (parameters.model_dir) extras.push(parameters.model_dir);
  if (process.env.YINZI_FOREGROUND_MODEL_DIR) extras.push(process.env.YINZI_FOREGROUND_MODEL_DIR);
  if (componentDir) extras.push(path.join(componentDir, 'models'), componentDir);
  const wanted = MODELS[parameters.model].filename;
  for (const dir of extras.filter(Boolean)) {
    const resolved = path.resolve(dir);
    const file = path.join(resolved, wanted);
    if (fs.existsSync(file)) return { directory: resolved, onnx: file, model: parameters.model };
  }
  throw fail('FOREGROUND_MODEL_MISSING', `主体分割模型尚未准备（需要 ${wanted}）。未把用户蒙版当作自动分割成功。`);
}

async function upsampleGray(sharp, gray, srcW, srcH, width, height) {
  const out = Buffer.from(await sharp(gray, { raw: { width: srcW, height: srcH, channels: 1 } })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .toColourspace('b-w')
    .raw({ depth: 'uchar' })
    .toBuffer());
  if (out.length !== width * height) throw fail('FOREGROUND_MASK_INVALID', `蒙版尺寸异常：期望 ${width * height}，实际 ${out.length}`);
  return out;
}

async function runOnnxMask({ sharp, ort, rgba, width, height, onnx }) {
  const size = FOREGROUND_INFERENCE_SIZE;
  const rgb = await sharp(rgba, { raw: { width, height, channels: 4 } })
    .flatten({ background: '#000000' })
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer();
  const input = rembgNormalize(rgb, size, size);
  const session = await ort.InferenceSession.create(onnx, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 });
  try {
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, size, size]) });
    const fused = outputs['1959'] || outputs[session.outputNames[0]];
    const decoded = decodeU2Net(fused);
    const mask = await upsampleGray(sharp, decoded.mask, decoded.width, decoded.height, width, height);
    return { mask, raw: decoded, input_names: session.inputNames, output_names: session.outputNames };
  } finally {
    await session.release?.();
  }
}

async function loadUserMask(sharp, maskPath, width, height, maxPixels) {
  const raw = await sharp(maskPath, { failOn: 'error', limitInputPixels: maxPixels })
    .autoOrient()
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer();
  return luminanceMask(raw, width, height);
}

const LIMITATIONS = [
  '自动路径是 U2Net 显著性主体分割，不是实例分割或语义类别识别。',
  '细发丝、半透明玻璃、网纱、水花在本候选中不保证完整保留。',
  '多主体图会尽量保留显著前景，不保证只留用户指定的那一件商品。',
  '空白或极低对比画面可能判为零对象；不可靠结果一律 review_required。',
];

async function processImage({ inputPath, outputPath, parameters: raw = {}, requireComponent, requireComponents, componentDir, sources = [] }, mode) {
  const p = parametersFor(raw);
  if (path.resolve(inputPath) === path.resolve(outputPath)) throw fail('FOREGROUND_OUTPUT_OVERWRITES_INPUT', '输出不能覆盖原始素材');
  const sharp = (requireComponents?.['media.sharp'] || requireComponent)('sharp');
  sharp.cache(false); sharp.concurrency(2);
  const started = Date.now();
  const { data: rgba, info } = await sharp(inputPath, { failOn: 'error', limitInputPixels: p.max_pixels })
    .autoOrient()
    .toColourspace('srgb')
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (rgba.length !== width * height * 4) throw fail('FOREGROUND_INPUT_INVALID', '原图像素缓冲不是 RGBA');

  let segmentation;
  if (p.route === 'user_mask') {
    const maskPath = sourceAt(sources.length ? sources : [{ path: inputPath }], p.mask_source, 'mask_source');
    segmentation = { mask: await loadUserMask(sharp, maskPath, width, height, p.max_pixels), route: 'user_mask', model: null };
  } else {
    const located = resolveModelFile(componentDir, p);
    const ort = requireComponent('onnxruntime-node');
    const inferred = await runOnnxMask({ sharp, ort, rgba, width, height, onnx: located.onnx });
    segmentation = { mask: inferred.mask, route: 'auto', model: { ...located, raw_range: { min: inferred.raw.min, max: inferred.raw.max }, input_names: inferred.input_names, output_names: inferred.output_names } };
  }

  const prepared = blur2d(applyStrength(segmentation.mask, p), width, height, p.feather_px);
  const stats = maskStats(prepared);
  const verdict = classifyMask(stats, p, segmentation.model?.raw_range);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const quality = {
    quality_status: 'review_required',
    quality_note: segmentation.route === 'auto'
      ? '已用本地 CPU U2Net 显著性分割；请对照原图检查边缘、孔洞和误检。不保证发丝或透明玻璃完整。'
      : '本结果使用用户蒙版路线，不是自动主体分割。',
    limitations: LIMITATIONS,
  };
  if (verdict.unchanged) {
    quality.quality_status = 'review_required';
    quality.quality_note = `${verdict.message}。已按零对象处理，请核对照片或改用用户蒙版。`;
  }

  const result = {
    status: verdict.unchanged ? 'unchanged' : 'succeeded',
    schema: 'yinzi.image-foreground/v1',
    mode,
    dimensions: { width, height },
    before: { width, height },
    after: { width, height, format: 'png' },
    route: segmentation.route,
    model: segmentation.model,
    mask_coverage: { mean: stats.mean, std: stats.std, min: stats.min, max: stats.max, occupied: stats.occupied },
    verdict: { reason: verdict.reason, usable: verdict.usable, unchanged: Boolean(verdict.unchanged) },
    parameters: { model: p.model, strength: p.strength, threshold: p.threshold, feather_px: p.feather_px, route: p.route },
    processing_seconds: 0,
    ...quality,
  };

  const maskForWrite = verdict.unchanged ? Buffer.alloc(prepared.length, 0) : prepared;
  const writeGray = (file, gray) => sharp(gray, { raw: { width, height, channels: 1 } }).toColourspace('b-w').png().toFile(file);
  if (mode === 'mask') {
    await writeGray(outputPath, maskForWrite);
  } else {
    const cutout = compositeRgba(rgba, maskForWrite, width, height, p.keep_source_alpha);
    await sharp(cutout, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
    const maskFile = path.join(path.dirname(outputPath), 'foreground-mask.png');
    await writeGray(maskFile, maskForWrite);
    result.assets = [{ file: 'foreground-mask.png', type: 'image', role: 'foreground_mask', title: '主体灰度蒙版' }];
  }
  result.raw_mask_coverage = { mean: stats.mean, std: stats.std, min: stats.min, max: stats.max, occupied: stats.occupied };
  if (verdict.unchanged) result.mask_coverage = { mean: 0, std: 0, min: 0, max: 0, occupied: 0 };

  result.processing_seconds = (Date.now() - started) / 1000;
  const receiptFile = path.join(path.dirname(outputPath), path.basename(outputPath, path.extname(outputPath)) + '-foreground.json');
  fs.writeFileSync(receiptFile, JSON.stringify(result, null, 2));
  result.assets = [...(result.assets || []), { file: path.basename(receiptFile), type: 'document', role: 'foreground_receipt', title: '主体分割回执' }];
  return result;
}

const parameter_schema = {
  type: 'object',
  properties: {
    model: { type: 'string', enum: ['u2netp', 'u2net'], default: 'u2netp', description: '轻量 u2netp 为默认；完整 u2net 更慢、体积更大' },
    strength: { type: 'number', minimum: 0.25, maximum: 4, default: 1, description: '>1 提高主体不透明度' },
    threshold: { type: 'integer', minimum: 0, maximum: 250, default: 0 },
    feather_px: { type: 'integer', minimum: 0, maximum: 64, default: 0 },
    max_pixels: { type: 'integer', minimum: 1024, maximum: 40000000, default: 24000000 },
    min_foreground_coverage: { type: 'number', minimum: 0, maximum: 0.5, default: 0.004 },
    max_foreground_coverage: { type: 'number', minimum: 0.5, maximum: 1, default: 0.985 },
    route: { type: 'string', enum: ['auto', 'user_mask'], default: 'auto' },
    mask_source: { type: 'integer', minimum: 0, description: '用户蒙版在 sources 中的索引' },
    keep_source_alpha: { type: 'boolean', default: true, description: '输出 alpha = 原 alpha × 蒙版；原透明区不会被填实' },
    model_dir: { type: 'string' },
  },
};

const common = {
  kind: 'image',
  component_id: 'vision.foreground-seg',
  additional_components: ['media.sharp'],
  worker_timeout_ms: 180000,
  validateParameters: parametersFor,
  defaults,
  parameter_schema,
  source: 'https://github.com/xuebinqin/U-2-Net',
  output_extension: 'png',
  inputs: ['input_path', 'sources', 'parameters'],
};

const foregroundMaskOperation = {
  ...common,
  id: 'local.image.foreground-mask',
  title: '图片主体灰度蒙版',
  description: '自动识别图片主体，生成可用于换背景、局部调色和图层合成的灰度蒙版。',
  description_zh: '自动识别图片主体，生成可用于换背景、局部调色和图层合成的灰度蒙版。',
  processFile: context => processImage(context, 'mask'),
};

const removeBackgroundOperation = {
  ...common,
  id: 'local.image.remove-background',
  title: '图片透明抠图',
  description: '自动抠出人物、商品等画面主体，输出透明PNG，方便更换背景与制作宣传图。',
  description_zh: '自动抠出人物、商品等画面主体，输出透明PNG，方便更换背景与制作宣传图。',
  processFile: context => processImage(context, 'cutout'),
};

module.exports = {
  foregroundMaskOperation,
  removeBackgroundOperation,
  parametersFor,
  rembgNormalize,
  decodeU2Net,
  applyStrength,
  blur2d,
  compositeRgba,
  luminanceMask,
  maskStats,
  classifyMask,
  resolveModelFile,
  LIMITATIONS,
};