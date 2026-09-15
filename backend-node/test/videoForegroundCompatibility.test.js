const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {alphaDecoderArgs,parametersFor,videoForegroundReplaceOperation}=require('../src/services/videoForegroundOperations');
const {createVideoFrameReader}=require('../src/services/videoForegroundStream');
const ffmpeg=process.env.FFMPEG_PATH||'ffmpeg';
const available=spawnSync(ffmpeg,['-version'],{windowsHide:true,stdio:'ignore'}).status===0;

test('alpha decoder follows stream codec and metadata',()=>{
  const probe=(codec,tags)=>({streams:[{codec_type:'video',codec_name:codec,tags}]});
  assert.deepEqual(alphaDecoderArgs(probe('vp8',{})),[]);
  assert.deepEqual(alphaDecoderArgs(probe('vp9',{})),[]);
  assert.deepEqual(alphaDecoderArgs(probe('vp8',{ALPHA_MODE:'1'})),['-c:v','libvpx']);
  assert.deepEqual(alphaDecoderArgs(probe('vp9',{alpha_mode:'1'})),['-c:v','libvpx-vp9']);
  assert.deepEqual(alphaDecoderArgs(probe('h264',{alpha_mode:'1'})),[]);
});

test('transparent output chooses a compatible extension and explicit masks have no eager model dependency',()=>{
  const op=videoForegroundReplaceOperation;
  assert.equal(op.outputExtension({output_format:'mov_alpha'}),'mov');
  assert.equal(op.outputExtension({output_format:'webm_alpha'}),'webm');
  assert.ok(![op.component_id,...op.additional_components].includes('vision.foreground-seg'));
  assert.throws(()=>parametersFor({route:'user_mask',mask_source:0,transparent_bg:true,output_format:'mp4'},true),/mov_alpha/);
});

test('slow frame consumers keep auxiliary decoding bounded and report real EOF', {skip:!available},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-foreground-stream-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'source.mp4');
  const made=spawnSync(ffmpeg,['-nostdin','-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=1','-c:v','libx264',file],{windowsHide:true,encoding:'utf8'});
  assert.equal(made.status,0,made.stderr);
  const options={ffmpeg,inputPath:file,width:160,height:90,fps:24};
  const reader=createVideoFrameReader({...options,duration:120});
  try{
    assert.equal((await reader.nextFrame()).length,160*90*4);
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.ok(reader.bufferedBytes<1024*1024);
  }finally{await reader.close();}
  const finite=createVideoFrameReader({...options,duration:0.5});
  try{let count=0;while(await finite.nextFrame())count++;assert.equal(count,12);}finally{await finite.close();}
  const broken=createVideoFrameReader({...options,inputPath:path.join(dir,'missing.mp4'),duration:1});
  try{await assert.rejects(broken.nextFrame(),/Video frame reader failed/);}finally{await broken.close();}
});
