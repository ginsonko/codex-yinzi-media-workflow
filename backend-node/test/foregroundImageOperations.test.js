const {test}=require('node:test');
const assert=require('node:assert/strict');
const {parametersFor,decodeU2Net,rembgNormalize,compositeRgba,maskStats,classifyMask}=require('../src/services/foregroundImageOperations');

test('explicit tiny masks survive automatic saliency confidence thresholds',()=>{
  const mask=Buffer.alloc(10000);mask[555]=255;
  const stats=maskStats(mask),automatic=classifyMask(stats,parametersFor());
  assert.equal(automatic.unchanged,true);
  const explicit=classifyMask(stats,parametersFor({route:'user_mask',mask_source:1}));
  assert.equal(explicit.unchanged,false);
  assert.equal(explicit.usable,true);
  assert.equal(explicit.reason,'user_mask');
});
test('invalid inference data fails instead of reporting an empty foreground',()=>{
  for(const tensor of [
    {dims:[1,1,2,2],data:Float32Array.from([0,1,NaN,0])},
    {dims:[1,1,2,2],data:Float32Array.from([0,1,Infinity,0])},
    {dims:[2,1,1,2],data:Float32Array.from([0,1,0,1])},
    {dims:[1,1,2,2],data:Float32Array.from([0,1])},
    {dims:[1,1,-1,2],data:Float32Array.from([0,1])},
  ])assert.throws(()=>decodeU2Net(tensor),{code:'FOREGROUND_MODEL_OUTPUT_INVALID'});
  assert.deepEqual([...decodeU2Net({dims:[1,1,1,3],data:Float32Array.from([0.2,0.5,0.8])}).mask],[0,127,255]);
});
test('transparent holes and fractional alpha remain composable without changing RGB',()=>{
  const source=Buffer.from([12,34,56,0,78,90,12,128,90,80,70,255]);
  const out=compositeRgba(source,Buffer.from([255,128,64]),3,1,true);
  assert.deepEqual([...out],[12,34,56,0,78,90,12,64,90,80,70,64]);
  assert.deepEqual([...source],[12,34,56,0,78,90,12,128,90,80,70,255]);
});
test('preprocessing uses rembg image peak normalization and guards invalid options',()=>{
  const normalized=rembgNormalize(Buffer.from([100,50,0]),1,1);
  assert.ok(Math.abs(normalized[0]-(1-0.485)/0.229)<1e-5);
  assert.ok(Math.abs(normalized[1]-(0.5-0.456)/0.224)<1e-5);
  for(const p of [{max_pixels:0},{feather_px:0.5},{model:'missing'},{route:'user_mask'},{strength:Infinity}])assert.throws(()=>parametersFor(p),{code:'INVALID_PARAMETERS'});
});