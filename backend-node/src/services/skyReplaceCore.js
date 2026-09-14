const fs = require('node:fs');
const path = require('node:path');
const { ADE20K_ID2LABEL } = require('./ade20kLabels');
const { resolveOptions: resolveEdgeOptions } = require('./skyMaskRefinement');

const fail = (code, message) => Object.assign(new Error(message), { code });

const SKY_NAME = /^(sky|clouds?)$/i;
const DEFAULTS = {
  feather_px: 0,
  ambient_strength: 0.18,
  temporal_smooth: 0.25,
  route: 'auto',
  horizon_blend_px: 0,
  min_sky_coverage: 0.01,
  max_sky_coverage: 0.985,
  inference_size: 512,
};

function parametersFor(input = {}) {
  const number = (key, fallback, min, max) => {
    const n = Number(input[key] ?? fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw fail('INVALID_PARAMETERS', `参数 ${key} 应在 ${min} 到 ${max} 之间`);
    return n;
  };
  const route = input.route ?? DEFAULTS.route;
  if (!['auto', 'user_mask'].includes(route)) throw fail('INVALID_PARAMETERS', 'route 仅支持 auto 或 user_mask');
  const skySource = input.sky_source;
  if (!Number.isInteger(Number(skySource)) || Number(skySource) < 0) throw fail('INVALID_PARAMETERS', 'sky_source 必须是 sources 中的非负整数索引');
  const maskSource = input.mask_source == null ? null : Number(input.mask_source);
  if (maskSource != null && (!Number.isInteger(maskSource) || maskSource < 0)) throw fail('INVALID_PARAMETERS', 'mask_source 必须是 sources 中的非负整数索引');
  if (route === 'user_mask' && maskSource == null) throw fail('INVALID_PARAMETERS', 'user_mask 路线需要 mask_source');
  if (input.refine_edges != null && typeof input.refine_edges !== 'boolean') throw fail('INVALID_PARAMETERS', 'refine_edges 必须是布尔值');
  if(input.model_dir != null && typeof input.model_dir !== 'string')throw fail('INVALID_PARAMETERS','model_dir 必须是目录路径字符串');
  if(!Number.isInteger(Number(input.inference_size ?? DEFAULTS.inference_size)))throw fail('INVALID_PARAMETERS','inference_size 必须是整数');
  return {
    refine_edges: input.refine_edges ?? route === 'auto',
    edge_options: resolveEdgeOptions(input.edge_options ?? {}),
    model_dir:input.model_dir,
    sky_source: Number(skySource),
    mask_source: maskSource,
    feather_px: number('feather_px', DEFAULTS.feather_px, 0, 64),
    ambient_strength: number('ambient_strength', DEFAULTS.ambient_strength, 0, 1),
    temporal_smooth: number('temporal_smooth', DEFAULTS.temporal_smooth, 0, 1),
    horizon_blend_px: number('horizon_blend_px', DEFAULTS.horizon_blend_px, 0, 128),
    min_sky_coverage: number('min_sky_coverage', DEFAULTS.min_sky_coverage, 0, 0.5),
    max_sky_coverage: number('max_sky_coverage', DEFAULTS.max_sky_coverage, 0.5, 1),
    inference_size: number('inference_size', DEFAULTS.inference_size, 64, 1024),
    route,
  };
}

function findSkyClassIds(id2label) {
  if (!id2label || typeof id2label !== 'object') throw fail('SKY_LABEL_MISSING', '模型缺少 id2label，无法确认是否含天空类别');
  const ids = [];
  for (const [key, value] of Object.entries(id2label)) {
    const name = String(value || '').trim();
    if (SKY_NAME.test(name)) ids.push(Number(key));
  }
  if (!ids.length || ids.some(id => !Number.isInteger(id))) {
    throw fail('SKY_LABEL_MISSING', '模型标签不含 sky/clouds，禁止把 VOC 等无天空类别权重当作换天模型');
  }
  return ids;
}

function loadLabelMap(modelDir) {
  const configPath = path.join(modelDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    return { id2label: ADE20K_ID2LABEL, source: 'embedded_ade20k', config_path: null };
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const id2label = config.id2label || config.label2id && Object.fromEntries(Object.entries(config.label2id).map(([name, id]) => [String(id), name]));
  findSkyClassIds(id2label);
  return { id2label, source: 'model_config', config_path: configPath, model_type: config.model_type || config.architectures };
}

function resolveModelDir(candidates = []) {
  for (const dir of candidates.filter(Boolean)) {
    const resolved = path.resolve(dir);
    const onnx = ['model.onnx', 'sky.onnx', 'segformer.onnx'].map(name => path.join(resolved, name)).find(file => fs.existsSync(file));
    if (onnx) return { directory: resolved, onnx };
  }
  return null;
}

function modelCandidates(componentDir, parameters = {}) {
  const extras = [];
  if (parameters.model_dir) extras.push(parameters.model_dir);
  if (process.env.YINZI_SKY_MODEL_DIR) {
    extras.push(process.env.YINZI_SKY_MODEL_DIR);
  }
  if (componentDir) extras.push(path.join(componentDir, 'models'));
  return extras;
}

function maskStats(mask) {
  if (!mask?.length) throw fail('SKY_MASK_EMPTY', '天空蒙版为空');
  let sum = 0, sumSq = 0, min = 1, max = 0;
  for (const value of mask) {
    const v = value / 255;
    sum += v; sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / mask.length;
  const variance = Math.max(0, sumSq / mask.length - mean * mean);
  return { mean, std: Math.sqrt(variance), min, max, pixels: mask.length };
}

function classifyMask(stats, parameters) {
  if (!stats || !stats.pixels) {
    return { usable: false, unchanged: false, reason: 'invalid', code: 'SKY_MASK_INVALID', message: '天空蒙版为空或无法统计' };
  }
  if (stats.max <= 1 / 255 || stats.mean < parameters.min_sky_coverage) {
    return {
      usable: false,
      unchanged: true,
      reason: 'no_sky',
      code: 'SKY_UNCHANGED',
      message: `画面中没有可用天空（mean=${stats.mean.toFixed(4)}），已原样保留`,
    };
  }
  // A frame may consist entirely of sky; a full user mask is intentional.
  // Coverage alone does not establish malformed data.
  return { usable: true, unchanged: false, reason: 'ok' };
}

function assertMaskUsable(stats, parameters) {
  const verdict = classifyMask(stats, parameters);
  if (!verdict.usable) throw fail(verdict.code, verdict.message);
  return stats;
}

function boxBlur(mask, width, height, radius) {
  if (!radius) return mask;
  const pass = (src, w, h, r) => {
    const out = new Float32Array(src.length);
    const window = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        out[y * w + x] = acc / window;
        acc += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
      }
    }
    return out;
  };
  const horizontal = pass(Float32Array.from(mask), width, height, radius);
  const vertical = pass(horizontal, height, width, radius);
  // pass() always blurs along the packed row; transpose mentally by swapping loops via a second orientation.
  const restored = new Float32Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) restored[y * width + x] = vertical[x * height + y];
  }
  const out = Buffer.alloc(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(restored[i])));
  return out;
}

function transposePacked(src, width, height) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[x * height + y] = src[y * width + x];
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

function horizonBlend(mask, width, height, extraPx) {
  if (!extraPx) return mask;
  const out = Buffer.from(mask);
  for (let x = 0; x < width; x++) {
    let bottom = -1;
    for (let y = 0; y < height; y++) if (mask[y * width + x] > 24) bottom = y;
    if (bottom < 0) continue;
    for (let y = bottom; y <= Math.min(height - 1, bottom + extraPx); y++) {
      const t = 1 - (y - bottom) / (extraPx + 1);
      const idx = y * width + x;
      out[idx] = Math.max(out[idx], Math.round(mask[bottom * width + x] * t));
    }
  }
  return out;
}

function temporalSmooth(previous, current, mix) {
  if (!previous || mix <= 0) return current;
  const out = Buffer.alloc(current.length);
  const keep = mix, take = 1 - mix;
  for (let i = 0; i < current.length; i++) out[i] = Math.round(previous[i] * keep + current[i] * take);
  return out;
}

function luminanceMask(rgba, width, height) {
  const out = Buffer.alloc(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = Math.round((0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) * (rgba[p + 3] / 255));
  }
  return out;
}

function meanColor(rgba, mask, threshold = 12) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (mask[i] <= threshold) continue;
    const w = mask[i] / 255;
    r += rgba[p] * w; g += rgba[p + 1] * w; b += rgba[p + 2] * w; n += w;
  }
  if (n <= 0) return { r: 140, g: 170, b: 210 };
  return { r: r / n, g: g / n, b: b / n };
}

function compositeSky({ baseRgba, skyRgba, mask, width, height, ambientStrength }) {
  const out = Buffer.from(baseRgba);
  const skyMean = meanColor(skyRgba, mask);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const m = mask[i] / 255;
    const nearby = edgeHint(mask, width, height, i);
    const ambient = (m < 0.85 && nearby > 0.12) ? ambientStrength * (1 - m) * nearby : 0;
    for (let c = 0; c < 3; c++) {
      const ground = baseRgba[p + c] * (1 - m) + skyRgba[p + c] * m;
      const tint = c === 0 ? skyMean.r : c === 1 ? skyMean.g : skyMean.b;
      out[p + c] = Math.max(0, Math.min(255, Math.round(ground * (1 - ambient) + tint * ambient)));
    }
    out[p + 3] = 255;
  }
  return out;
}

function edgeHint(mask, width, height, index) {
  const x = index % width, y = (index / width) | 0;
  let maxN = 0;
  for (let dy = -2; dy <= 2; dy++) {
    const yy = y + dy; if (yy < 0 || yy >= height) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx; if (xx < 0 || xx >= width) continue;
      const v = mask[yy * width + xx];
      if (v > maxN) maxN = v;
    }
  }
  return maxN / 255;
}

function softmax2d(logits, classes, spatial) {
  const out = new Float32Array(spatial * classes);
  for (let i = 0; i < spatial; i++) {
    let max = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = logits[c * spatial + i];
      if (v > max) max = v;
    }
    let sum = 0;
    for (let c = 0; c < classes; c++) {
      const e = Math.exp(logits[c * spatial + i] - max);
      out[i * classes + c] = e;
      sum += e;
    }
    for (let c = 0; c < classes; c++) out[i * classes + c] /= sum;
  }
  return out;
}

function layoutFromShape(shape) {
  const [n, a, b, c] = shape;
  if (n !== 1) throw fail('SKY_MODEL_OUTPUT', '分割输出 batch 不是 1');
  const nchwSpatial = Math.abs(b - c);
  const nhwcSpatial = Math.abs(a - b);
  if (nchwSpatial < nhwcSpatial || (nchwSpatial === nhwcSpatial && a >= c)) {
    return { classes: a, height: b, width: c, layout: 'nchw' };
  }
  return { height: a, width: b, classes: c, layout: 'nhwc' };
}

function maskFromLogits(logits, shape, skyIds) {
  const { classes, height, width, layout } = layoutFromShape(shape);
  const spatial = height * width;
  const mask = Buffer.alloc(spatial);
  const probability = Buffer.alloc(spatial);
  const skySet = new Set(skyIds);
  for (let i = 0; i < spatial; i++) {
    let best = 0, bestV = -Infinity, max = -Infinity;
    for (let cls = 0; cls < classes; cls++) {
      const v = layout === 'nchw' ? logits[cls * spatial + i] : logits[i * classes + cls];
      if (v > bestV) { bestV = v; best = cls; }
      if (v > max) max = v;
    }
    let sum = 0, sky = 0;
    for (let cls = 0; cls < classes; cls++) {
      const v = layout === 'nchw' ? logits[cls * spatial + i] : logits[i * classes + cls];
      const e = Math.exp(v - max);
      sum += e;
      if (skySet.has(cls)) sky += e;
    }
    const p = sky / sum;
    probability[i] = Math.max(0, Math.min(255, Math.round(p * 255)));
    mask[i] = skySet.has(best) ? 255 : 0;
  }
  return { mask, probability, width, height, classes, layout };
}

function imageNetNchw(rgb, width, height) {
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0, p = 0; i < plane; i++, p += 3) {
    out[i] = (rgb[p] / 255 - mean[0]) / std[0];
    out[plane + i] = (rgb[p + 1] / 255 - mean[1]) / std[1];
    out[plane * 2 + i] = (rgb[p + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

async function runOnnxMask({ session, rgb, width, height, skyIds, ort }) {
  const input = imageNetNchw(rgb, width, height);
  const names = session.inputNames;
  const feeds = { [names[0]]: new ort.Tensor('float32', input, [1, 3, height, width]) };
  const results = await session.run(feeds);
  const output = results[session.outputNames[0]];
  return maskFromLogits(output.data, output.dims, skyIds);
}

function prepareMask(raw, width, height, parameters) {
  const feathered = blur2d(raw, width, height, Math.round(parameters.feather_px));
  return horizonBlend(feathered, width, height, Math.round(parameters.horizon_blend_px));
}

async function upsampleGray(sharp, gray, srcW, srcH, width, height) {
  const out = Buffer.from(await sharp(gray, { raw: { width: srcW, height: srcH, channels: 1 } })
    // Inference stretches the whole image to a square. Restore the same
    // normalized coordinates; Sharp's default cover would crop the mask.
    .resize(width, height, { fit: 'fill', kernel: 'cubic' })
    .toColourspace('b-w')
    .raw({ depth: 'uchar' })
    .toBuffer());
  if (out.length !== width * height) {
    throw fail('SKY_MASK_INVALID', `天空蒙版尺寸异常：期望 ${width * height} 字节，实际 ${out.length}`);
  }
  return out;
}

module.exports = {
  DEFAULTS,
  fail,
  parametersFor,
  findSkyClassIds,
  loadLabelMap,
  resolveModelDir,
  modelCandidates,
  maskStats,
  classifyMask,
  assertMaskUsable,
  blur2d,
  boxBlur,
  transposePacked,
  horizonBlend,
  temporalSmooth,
  luminanceMask,
  meanColor,
  compositeSky,
  maskFromLogits,
  layoutFromShape,
  imageNetNchw,
  runOnnxMask,
  prepareMask,
  upsampleGray,
};