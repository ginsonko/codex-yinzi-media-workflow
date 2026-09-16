const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require('sharp');
const { execute } = require('../src/services/localMediaExecutor');
const { contracts, getOperation } = require('../src/services/localMediaOperations');
const { TRACKING_PARAMETER_KEYS } = require('../src/services/videoFaceTracker');
const { parametersForVideoBeauty } = require('../src/services/videoFaceBeauty');
const { sourcesFor } = require('../src/services/localMediaSources');
const { run } = require('../src/services/componentRuntime');
const { getFfmpegPath, getFfprobePath } = require('../src/utils/ffmpegPath');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-beauty-'));
const backend = path.resolve(__dirname, '..');
const bins = { ffmpeg: getFfmpegPath(), ffprobe: getFfprobePath() };
const hasFfmpeg = Object.values(bins).every(bin => spawnSync(bin, ['-version'], { windowsHide: true, timeout: 10000 }).status === 0);
const imageIds = ['frequency-separation','bilateral-denoise','dodge-burn','color-grade','vignette','film-grain'];
const source = path.join(root, 'source.mkv');
const cache = path.join(root, 'tracks.json');
const image = path.join(root, 'source.png');
let pixels;
before(async () => {
  pixels = Buffer.alloc(64*48*4);
  for(let i=0;i<pixels.length;i++) pixels[i]=i%4===3?150:(i*13+i%17)%256;
  await sharp(pixels,{raw:{width:64,height:48,channels:4}}).png().toFile(image);
  if(hasFfmpeg) await run(bins.ffmpeg,['-v','error','-f','lavfi','-i','testsrc2=s=128x96:r=10:d=2','-c:v','ffv1',source]);
});
after(() => fs.rmSync(root,{recursive:true,force:true}));
function manager() {
  const calls=[];
  return {calls,async ensureComponent(id){
    calls.push(id);
    if(id==='media.ffmpeg')return {component_id:id,reused:true,executables:bins};
    assert.ok(['media.sharp','vision.face-detector'].includes(id));
    return {component_id:id,reused:true,directory:backend};
  }};
}
function writeCache(frames) {
  const p=parametersForVideoBeauty();
  fs.writeFileSync(cache,JSON.stringify({schema:'yinzi.video-face-tracking/v1',source:{sha256:crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),width:128,height:96},
    parameters:{tracking:Object.fromEntries(TRACKING_PARAMETER_KEYS.map(k=>[k,p[k]]))},frames,tracks:[]}));
}
const cachedFrames=()=>Array.from({length:20},(_,n)=>({frame:n,pts_time:n/10,seconds:n/10,detections:[],tracks:[]}));
test('nine beauty operations have unique complete contracts',()=>{
  for(const id of [...imageIds.map(id=>'local.image.'+id),'local.image.face-beauty','local.image.skin-tone','local.video.face-beauty']) {
    const found=contracts().filter(c=>c.module_id===id);assert.equal(found.length,1,id);
    for(const key of Object.keys(getOperation(id).defaults))assert.ok(found[0].parameter_schema.properties[key],id+':'+key);
  }
});
test('six image operations execute through the actual worker and preserve dimensions and alpha',async()=>{
  for(const id of imageIds){
    const receipt=await execute({module_id:'local.image.'+id,input_path:image},{manager:manager(),outputDir:path.join(root,id)});
    const result=await sharp(receipt.output_path).raw().toBuffer({resolveWithObject:true});
    assert.equal(result.info.width,64);assert.equal(result.info.height,48);assert.equal(result.info.channels,4);
    assert.ok(!result.data.equals(pixels),id);
    for(let i=3;i<pixels.length;i+=4)assert.equal(result.data[i],pixels[i],id);
  }
});
test('video validation rejects invalid duration before component installation',async()=>{
  const m=manager();
  await assert.rejects(execute({module_id:'local.video.face-beauty',input_path:image,parameters:{max_duration:0}},{manager:m,outputDir:path.join(root,'invalid')}),{code:'INVALID_PARAMETERS'});
  assert.deepEqual(m.calls,[]);
});
test('vignette tint changes edge color while leaving the center unchanged',async()=>{
  const input=path.join(root,'tint-source.png');
  await sharp({create:{width:64,height:48,channels:4,background:'#808080'}}).png().toFile(input);
  const receipt=await execute({module_id:'local.image.vignette',input_path:input,parameters:{tint_color:'#ff0000',darkness:1}},{manager:manager(),outputDir:path.join(root,'tint')});
  const pixels=await sharp(receipt.output_path).raw().toBuffer();
  assert.deepEqual([...pixels.subarray(0,4)],[255,0,0,255]);
  const center=(24*64+32)*4;assert.deepEqual([...pixels.subarray(center,center+4)],[128,128,128,255]);
});
test('tracks remain part of source integrity even with explicitly supplied sources',()=>{
  const sources=sourcesFor({module_id:'local.video.face-beauty',input_path:source,parameters:{tracks_path:cache},sources:[{path:source}]});
  assert.deepEqual(sources.map(s=>s.path),[source,cache]);assert.equal(sources[1].role,'tracks');
});
test('one-second cap produces ten frames, cache gaps skip safely, and source hashes are retained',{skip:!hasFfmpeg},async()=>{
  writeCache(cachedFrames().filter(f=>f.frame<4||f.frame>7));
  const receipt=await execute({module_id:'local.video.face-beauty',input_path:source,parameters:{output_fps:10,max_duration:1,tracks_path:cache}},{manager:manager(),outputDir:path.join(root,'video')});
  assert.equal(receipt.details.frames_processed,10);assert.equal(receipt.details.actual_duration_seconds,1);
  assert.equal(receipt.details.cache_timing.uncovered_frames,4);
  assert.equal(receipt.sources.find(s=>s.role==='tracks').sha256.length,64);
  await run(bins.ffmpeg,['-v','error','-i',receipt.output_path,'-f','null','-']);
});
test('null timestamps use relative seconds and fail policy stops uncovered output',{skip:!hasFfmpeg},async()=>{
  writeCache(cachedFrames().map(f=>({...f,pts_time:null})));
  const receipt=await execute({module_id:'local.video.face-beauty',input_path:source,parameters:{output_fps:12,tracks_path:cache}},{manager:manager(),outputDir:path.join(root,'null')});
  assert.equal(receipt.details.frames_processed,24);assert.equal(receipt.details.cache_timing.uncovered_frames,0);
  writeCache([cachedFrames()[0]]);
  await assert.rejects(execute({module_id:'local.video.face-beauty',input_path:source,parameters:{output_fps:10,tracks_path:cache,cache_gap_policy:'fail'}},{manager:manager(),outputDir:path.join(root,'gap-fail')}),{code:'FACE_TRACK_CACHE'});
  assert.equal(fs.existsSync(path.join(root,'gap-fail','receipt.json')),false);
  assert.equal(fs.readdirSync(path.join(root,'gap-fail')).some(f=>f.startsWith('tmp-vbeauty')),false);
});
test('truncated input cannot produce a successful partial movie',{skip:!hasFfmpeg},async()=>{
  const input=path.join(root,'truncated.mkv'),bytes=fs.readFileSync(source);
  fs.writeFileSync(input,bytes.subarray(0,Math.floor(bytes.length*0.55)));
  await assert.rejects(execute({module_id:'local.video.face-beauty',input_path:input},{manager:manager(),outputDir:path.join(root,'truncated')}),{code:'VIDEO_BEAUTY_DECODE'});
  assert.equal(fs.existsSync(path.join(root,'truncated','receipt.json')),false);
});
