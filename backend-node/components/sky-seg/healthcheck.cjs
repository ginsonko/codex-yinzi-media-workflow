const fs = require('node:fs');
const path = require('node:path');

function findSky(id2label) {
  return Object.entries(id2label || {}).filter(([, name]) => /^(sky|clouds?)$/i.test(String(name || '').trim())).map(([id]) => Number(id));
}

async function main() {
  const ort = require('onnxruntime-node');
  const modelDir = process.env.YINZI_SKY_MODEL_DIR || path.join(__dirname, 'models');
  const onnx = ['model.onnx', 'sky.onnx', 'segformer.onnx'].map(name => path.join(modelDir, name)).find(file => fs.existsSync(file));
  if (!onnx) {
    console.error('SKY_MODEL_MISSING');
    process.exitCode = 1;
    return;
  }
  const configPath = path.join(modelDir, 'config.json');
  const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null;
  const id2label = config?.id2label;
  const skyIds = findSky(id2label);
  if (!skyIds.length) {
    console.error('SKY_LABEL_MISSING');
    process.exitCode = 1;
    return;
  }
  const session = await ort.InferenceSession.create(onnx, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
  const size = 512;
  const input = new ort.Tensor('float32', new Float32Array(1 * 3 * size * size), [1, 3, size, size]);
  const names = session.inputNames;
  const result = await session.run({ [names[0]]: input });
  const output = result[session.outputNames[0]];
  if (!output?.data?.length) throw Error('empty logits');
  console.log(JSON.stringify({
    engine: 'onnxruntime-node',
    device: 'cpu',
    sky_class_ids: skyIds,
    output_dims: output.dims,
    providers: session.getProviders ? session.getProviders() : ['cpu'],
  }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });