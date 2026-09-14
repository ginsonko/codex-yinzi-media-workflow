const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const ort = require('onnxruntime-node');
  const modelDir = process.env.YINZI_FOREGROUND_MODEL_DIR || path.join(__dirname, 'models');
  const onnx = ['u2netp.onnx', 'u2net.onnx'].map(name => path.join(modelDir, name)).find(file => fs.existsSync(file));
  if (!onnx) {
    console.error('FOREGROUND_MODEL_MISSING');
    process.exitCode = 1;
    return;
  }
  const session = await ort.InferenceSession.create(onnx, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
  try {
    const size = 320;
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(1 * 3 * size * size), [1, 3, size, size]) });
    const output = result[session.outputNames[0]];
    if (!output?.data?.length || !Number.isFinite(output.data[0])) throw Error('U2Net inference output invalid');
    const spatial = output.data.length >= size * size ? size * size : output.data.length;
    if (spatial < 16) throw Error('U2Net output too small for a saliency map');
    console.log(JSON.stringify({
      engine: 'onnxruntime-node',
      device: 'cpu',
      model: path.basename(onnx),
      input: session.inputNames[0],
      output: session.outputNames[0],
      output_dims: output.dims,
      inference: 'passed',
    }));
  } finally {
    await session.release();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });