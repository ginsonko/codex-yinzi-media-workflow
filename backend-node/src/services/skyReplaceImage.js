const fs = require('node:fs');
const path = require('node:path');
const { refineSkyMask, DEFAULTS: EDGE_DEFAULTS, OPTION_BOUNDS } = require('./skyMaskRefinement');
const {
  parametersFor, findSkyClassIds, loadLabelMap, resolveModelDir, modelCandidates, maskStats, classifyMask,
  luminanceMask, compositeSky, runOnnxMask, prepareMask, fail, upsampleGray,
} = require('./skyReplaceCore');

function sourceAt(sources, index, role) {
  if (!Number.isInteger(index) || !sources[index]) throw fail('INVALID_SOURCES', `${role} 需要指向有效的 sources 数字索引`);
  return sources[index].path;
}

async function writeUnchangedImage(sharp, inputPath, outputPath, extras) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await sharp(inputPath, { failOn: 'error', limitInputPixels: 40000000 }).rotate().png().toFile(outputPath);
  return {
    status: 'unchanged',
    no_sky: true,
    quality_status: 'unchanged',
    ...extras,
  };
}

async function segmentAuto({ sharp, ort, inputPath, width, height, componentDir, parameters }) {
  const located = resolveModelDir(modelCandidates(componentDir, parameters));
  if (!located) throw fail('SKY_MODEL_MISSING', '天空分割模型尚未通过组件运行时准备（需要含 sky 标签的 ONNX）。未把用户蒙版当作自动分割成功。');
  const labels = loadLabelMap(located.directory);
  const skyIds = findSkyClassIds(labels.id2label);
  const size = parameters.inference_size;
  const rgb = await sharp(inputPath, { failOn: 'error', limitInputPixels: 40000000 })
    .rotate().resize(size, size, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
  const session = await ort.InferenceSession.create(located.onnx, { executionProviders: ['cpu'], intraOpNumThreads: 2, interOpNumThreads: 1 });
  let inferred;
  try {
    inferred = await runOnnxMask({ session, rgb, width: size, height: size, skyIds, ort });
  } finally {
    await session.release?.();
  }
  const hard = await upsampleGray(sharp, inferred.mask, inferred.width, inferred.height, width, height);
  const soft = inferred.probability
    ? await upsampleGray(sharp, inferred.probability, inferred.width, inferred.height, width, height)
    : hard;
  const resized = Buffer.alloc(hard.length);
  for (let i = 0; i < hard.length; i++) resized[i] = Math.max(hard[i], soft[i] >= 64 ? soft[i] : 0);
  return {
    mask: Buffer.from(resized),
    route: 'auto',
    model: { directory: located.directory, onnx: located.onnx, sky_class_ids: skyIds, label_source: labels.source, output_layout: inferred.layout, classes: inferred.classes },
  };
}

async function loadUserMask(sharp, maskPath, width, height) {
  const raw = await sharp(maskPath, { failOn: 'error', limitInputPixels: 40000000 }).rotate().resize(width, height, { fit: 'fill' }).ensureAlpha().raw().toBuffer();
  return luminanceMask(raw, width, height);
}

async function processFile({ inputPath, outputPath, parameters: raw = {}, requireComponent, requireComponents, componentDir, sources = [] }) {
  const parameters = parametersFor(raw);
  const sharp = (requireComponents?.['media.sharp'] || requireComponent)('sharp');
  sharp.cache(false); sharp.concurrency(2);
  const list = sources.length ? sources : [{ path: inputPath, role: 'primary' }];
  const skyPath = sourceAt(list, parameters.sky_source, 'sky_source');
  const started = Date.now();
  const base = sharp(inputPath, { failOn: 'error', limitInputPixels: 40000000 }).rotate().toColourspace('srgb').ensureAlpha();
  const { data: baseRgba, info } = await base.raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (baseRgba.length !== width * height * 4) throw fail('SKY_MASK_INVALID', '原图像素缓冲不是 RGBA');
  let segmentation;
  if (parameters.route === 'user_mask') {
    const maskPath = sourceAt(list, parameters.mask_source, 'mask_source');
    segmentation = { mask: await loadUserMask(sharp, maskPath, width, height), route: 'user_mask', model: null };
  } else {
    const ort = requireComponent('onnxruntime-node');
    segmentation = await segmentAuto({ sharp, ort, inputPath, width, height, componentDir, parameters });
  }
  if (segmentation.mask.length !== width * height) throw fail('SKY_MASK_INVALID', `天空蒙版与画面尺寸不一致（${segmentation.mask.length} vs ${width * height}）`);
  const refined = parameters.refine_edges ? refineSkyMask(baseRgba, segmentation.mask, width, height, parameters.edge_options) : null;
  const prepared = prepareMask(refined?.mask || segmentation.mask, width, height, parameters);
  const stats = maskStats(prepared);
  const verdict = classifyMask(stats, parameters);
  if (verdict.unchanged) {
    return writeUnchangedImage(sharp, inputPath, outputPath, {
      before: { width, height },
      after: { width, height, format: 'png' },
      route: segmentation.route,
      mask_coverage: { mean: stats.mean, std: stats.std, min: stats.min, max: stats.max },
      model: segmentation.model,
      processing_seconds: (Date.now() - started) / 1000,
      quality_note: segmentation.route === 'auto'
        ? '自动分割未检测到天空，已原样保留，不是分割失败。'
        : '用户蒙版没有可用天空区域，已原样保留，不是分割失败。',
    });
  }
  if (!verdict.usable) throw fail(verdict.code, verdict.message);
  const skyRgba = await sharp(skyPath, { failOn: 'error', limitInputPixels: 40000000 })
    .rotate().resize(width, height, { fit: 'cover', position: 'centre' }).ensureAlpha().toColourspace('srgb').raw().toBuffer();
  const out = compositeSky({ baseRgba, skyRgba, mask: prepared, width, height, ambientStrength: parameters.ambient_strength });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await sharp(out, { raw: { width, height, channels: 4 } }).png().toFile(outputPath);
  const maskPathOut = path.join(path.dirname(outputPath), 'sky-mask.png');
  await sharp(prepared, { raw: { width, height, channels: 1 } }).png().toFile(maskPathOut);
  const after = await sharp(outputPath).metadata();
  return {
    before: { width, height },
    after: { width: after.width, height: after.height, format: after.format },
    edge_refinement: refined ? { changed: refined.changed, working: refined.working } : null,
    route: segmentation.route,
    mask_coverage: { mean: stats.mean, std: stats.std, min: stats.min, max: stats.max },
    model: segmentation.model,
    processing_seconds: (Date.now() - started) / 1000,
    assets: [{ file: 'sky-mask.png', type: 'image', role: 'sky_mask', title: '天空蒙版' }],
    quality_status: 'review_required',
    quality_note: segmentation.route === 'auto'
      ? '已用含 sky 标签的 CPU 分割模型换天；边缘与环境色为工程结果，需对照原图检查电线、地平线和误检。'
      : '本结果使用用户蒙版路线，不是自动天空识别。',
  };
}

const parameter_schema = {
  type: 'object',
  required: ['sky_source'],
  properties: {
    sky_source: { type: 'integer', minimum: 0, description: '替换天空图在 sources 中的索引' },
    mask_source: { type: 'integer', minimum: 0, description: '可选用户蒙版；route=auto 时忽略自动分割以外的覆盖用途' },
    feather_px: { type: 'number', minimum: 0, maximum: 64, default: 0 },
    ambient_strength: { type: 'number', minimum: 0, maximum: 1, default: 0.18 },
    temporal_smooth: { type: 'number', minimum: 0, maximum: 1, default: 0.25 },
    refine_edges: {type:'boolean', description:'按当前画面细化蒙版；auto默认开启，user_mask默认关闭'},
    edge_options: {type:'object', properties:Object.fromEntries(Object.entries(EDGE_DEFAULTS).map(([key,value])=>[key,typeof value==='boolean'?{type:'boolean',default:value}:{type:'number',minimum:OPTION_BOUNDS[key][0],maximum:OPTION_BOUNDS[key][1],default:value}]))},
    horizon_blend_px: { type: 'number', minimum: 0, maximum: 128, default: 0 },
    min_sky_coverage: { type: 'number', minimum: 0, maximum: 0.5, default: 0.01 },
    max_sky_coverage: { type: 'number', minimum: 0.5, maximum: 1, default: 0.985 },
    model_dir: {type:'string',description:'可选本地模型目录；默认使用按需安装组件'},
    inference_size:{type:'integer',minimum:64,maximum:1024,default:512},
    route: { type: 'string', enum: ['auto', 'user_mask'], default: 'auto' },
  },
};

module.exports = {
  id: 'local.image.sky-replace',
  title: '图片天空分割与换天',
  kind: 'image',
  description: 'CPU ONNX semantic sky segmentation and still-image sky replacement with feathering and optional ambient tint.',
  description_zh: '使用含 sky 类别的 CPU 语义分割模型生成天空蒙版，替换天空图并做边缘羽化与弱环境色融合；无天空时原样保留；用户蒙版仅作可选退路。',
  component_id: 'vision.sky-seg',
  additional_components: ['media.sharp'],
  output_extension: 'png',
  worker_timeout_ms: 180000,
  processFile,
  validateParameters: parametersFor,
  defaults: { feather_px: 0, ambient_strength: 0.18, route: 'auto', horizon_blend_px: 0 },
  inputs: ['input_path', 'sources', 'parameters'],
  source: 'https://huggingface.co/nvidia/segformer-b0-finetuned-ade-512-512',
  parameter_schema,
  segmentAuto,
};

module.exports.parameter_schema = parameter_schema;
