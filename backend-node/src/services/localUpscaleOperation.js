const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { run } = require('./componentRuntime');

const models = { general: 'realesrgan-x4plus', anime: 'realesr-animevideov3' };
function parametersFor(input = {}) {
  const scale = Number(input.scale ?? 2);
  const tile = Number(input.tile ?? 128);
  const model = input.model || 'general';
  if (![2, 3, 4].includes(scale) || !Number.isInteger(tile) || tile < 32 || tile > 512 || !models[model]) {
    throw Object.assign(Error('放大倍率为2/3/4，分块为32至512像素，模型为general或anime'), { code: 'INVALID_PARAMETERS' });
  }
  return { scale, tile, model };
}

async function executeNative({ inputPath, outputPath, parameters, components, report = () => {} }) {
  const { scale, tile, model } = parametersFor(parameters);
  const runtime = components['vision.realesrgan'];
  const sharp = createRequire(path.join(components['media.sharp'].directory, 'package.json'))('sharp');
  const working = path.dirname(outputPath);
  const preparedPath = path.join(working, 'upscale-input.png');
  const nativePath = path.join(working, 'upscale-native.png');
  const started = Date.now();
  const source = sharp(inputPath, { failOn: 'error', limitInputPixels: 25000000 });
  const metadata = await source.metadata();
  if ((metadata.pages || 1) > 1) throw Object.assign(Error('当前超分操作接收单张图片，动画请先按帧处理'), { code: 'ANIMATED_INPUT_UNSUPPORTED' });
  const oriented = await source.rotate().toColourspace('srgb').png().toBuffer();
  const before = await sharp(oriented).metadata();
  const nativeScale = model === 'general' ? 4 : scale;
  if (before.width * before.height * nativeScale ** 2 > 100000000) {
    throw Object.assign(Error('此图放大后的像素量超过本地处理内存范围，请先分块处理'), { code: 'OUTPUT_PIXEL_LIMIT' });
  }
  await sharp(oriented).removeAlpha().png().toFile(preparedPath);
  let lastProgress = 0;
  let remainder = '';
  const inferenceStart = Date.now();
  report({ stage: 'executing', message: '正在用Real-ESRGAN处理图片', engine: 'ncnn-vulkan', model });
  await run(runtime.executables.realesrgan, [
    '-i', preparedPath, '-o', nativePath,
    '-m', 'models',
    '-n', models[model], '-s', String(nativeScale), '-t', String(tile), '-j', '1:1:1', '-f', 'png',
  ], {
    cwd: path.dirname(runtime.executables.realesrgan), timeout: 10 * 60 * 1000,
    onErrorOutput: chunk => {
      remainder = (remainder + chunk).slice(-4096);
      const values = [...remainder.matchAll(/(?:^|[\r\n])\s*(\d+(?:\.\d+)?)%/g)];
      const percent = Number(values.at(-1)?.[1]);
      if (values.length && percent >= 0 && percent <= 100 && Date.now() - lastProgress > 1000) {
        lastProgress = Date.now();
        report({ stage: 'executing', percent, message: `Real-ESRGAN处理进度 ${percent.toFixed(0)}%`, engine: 'ncnn-vulkan' });
        remainder = '';
      }
    },
  });
  const inferenceSeconds = (Date.now() - inferenceStart) / 1000;
  const native = await sharp(nativePath, { failOn: 'error', limitInputPixels: 100000000 }).metadata();
  if (native.width !== before.width * nativeScale || native.height !== before.height * nativeScale) {
    throw Object.assign(Error('模型输出尺寸与原生倍率不一致，未登记成品'), { code: 'UPSCALE_OUTPUT_MISMATCH' });
  }
  const target = { width: before.width * scale, height: before.height * scale };
  // Finish RGB transforms before adding alpha; Sharp can otherwise remove the newly joined channel.
  const rgb = await sharp(nativePath).resize(target).removeAlpha().png().toBuffer();
  let output = sharp(rgb);
  if (before.hasAlpha) {
    const alpha = await sharp(oriented).extractChannel('alpha').resize(target).raw().toBuffer();
    output = output.joinChannel(alpha, { raw: { ...target, channels: 1 } });
  }
  await output.png().toFile(outputPath);
  const after = await sharp(outputPath).metadata();
  const [sourceStats, resultStats] = await Promise.all([sharp(oriented).stats(), sharp(outputPath).stats()]);
  if (resultStats.channels.slice(0, 3).every(channel => channel.max <= 1) && sourceStats.channels.slice(0, 3).some(channel => channel.max > 10)) {
    throw Object.assign(Error('模型输出异常全黑，原素材已保留；需要检查Vulkan设备和驱动'), { code: 'UPSCALE_BLACK_OUTPUT' });
  }
  for (const file of [preparedPath, nativePath]) fs.unlinkSync(file);
  return {
    before: { width: before.width, height: before.height, format: metadata.format, has_alpha: before.hasAlpha },
    after: { width: after.width, height: after.height, format: after.format, has_alpha: after.hasAlpha },
    engine: 'Real-ESRGAN ncnn Vulkan', model: models[model], native_scale: nativeScale,
    inference_seconds: inferenceSeconds, processing_seconds: (Date.now() - started) / 1000,
    quality_status: 'review_required', quality_note: '已完成模型放大；请核对文字、面部和商品纹理，模型可能改写细节。',
  };
}

module.exports = {
  id: 'local.image.realesrgan', title: 'Real-ESRGAN图片超分放大', kind: 'image',
  description: 'Real-ESRGAN image upscale and super resolution for photos or anime; requires a compatible Vulkan GPU.',
  description_zh: '本地图片超分放大，支持照片和动漫模型、2/3/4倍；自动准备组件，需要可用的Vulkan显卡，效果需核对原图。',
  component_id: 'vision.realesrgan', additional_components: ['media.sharp'], resource_group: 'gpu',
  defaults: { scale: 2, model: 'general', tile: 128 }, executeNative,
  source: 'https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan',
  validateResult: ({ before, after }, parameters) => {
    const { scale } = parametersFor(parameters);
    if (after.width !== before.width * scale || after.height !== before.height * scale) throw Error('超分输出尺寸不符合请求');
    if (Boolean(before.has_alpha) !== Boolean(after.has_alpha)) throw Object.assign(Error('超分输出透明通道与原图不一致，未登记成品'), { code: 'UPSCALE_ALPHA_MISMATCH' });
  },
};
