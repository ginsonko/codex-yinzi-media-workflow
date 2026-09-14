const path = require('node:path');
async function main() {
  const ort = require('onnxruntime-node');
  const session = await ort.InferenceSession.create(path.join(__dirname, 'models/yunet.onnx'), {executionProviders:['cpu'], intraOpNumThreads:1, interOpNumThreads:1});
  try {
    const result = await session.run({[session.inputNames[0]]:new ort.Tensor('float32',new Float32Array(3*640*640),[1,3,640,640])});
    for(const stride of [8,16,32]) for(const prefix of ['cls','obj','bbox','kps']) {
      const value=result[`${prefix}_${stride}`];
      if(!value?.data?.length || !Number.isFinite(value.data[0])) throw Error('YuNet inference output invalid');
    }
    console.log(JSON.stringify({engine:'YuNet',device:'cpu',outputs:Object.keys(result),inference:'passed'}));
  } finally { await session.release(); }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});