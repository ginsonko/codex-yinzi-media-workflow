const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {operations,contracts}=require('../src/services/localMediaOperations');
const {execute}=require('../src/services/localMediaExecutor');
const {getFfmpegPath,getFfprobePath,hasLocalFfmpeg}=require('../src/utils/ffmpegPath');
const {run}=require('../src/services/componentRuntime');
test('every local contract has a concrete executor and unique operation',()=>{
 assert.ok(operations.length>=100);assert.equal(new Set(operations.map(o=>o.id)).size,operations.length);
 for(const o of operations)assert.equal(typeof(o.apply||o.build||o.processFile||o.executeNative),'function');assert.equal(contracts().length,operations.length);
});
test('actual isolated image transform preserves source and validates dimensions',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-image-executor-')),file=path.join(root,'input.png');const sharp=require('sharp');sharp.cache(false);
 await sharp({create:{width:160,height:96,channels:3,background:'red'}}).png().toFile(file);
 const manager={ensureComponent:async()=>({component_id:'media.sharp',version:require('sharp').versions.sharp,directory:path.resolve(__dirname,'..'),reused:true})};
 const r=await execute({module_id:'local.image.resize',input_path:file,parameters:{width:80,height:48}},{manager,outputDir:path.join(root,'result')});
 assert.equal(r.details.after.width,80);assert.equal(r.details.after.height,48);assert.equal(r.status,'succeeded');assert.ok(r.input_sha256&&r.output_sha256);fs.rmSync(root,{recursive:true,force:true});
});
test('resize respects a single dimension and inside bounds on real landscape and portrait images',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-resize-intent-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sharp=require('sharp');sharp.cache(false);
 const manager={ensureComponent:async()=>({component_id:'media.sharp',version:sharp.versions.sharp,directory:path.resolve(__dirname,'..'),reused:true})};
 const cases=[
  {source:[1200,800],params:{width:640},expected:[640,427]},
  {source:[800,1200],params:{width:320},expected:[320,480]},
  {source:[1200,800],params:{height:320},expected:[480,320]},
  {source:[800,1200],params:{height:640},expected:[427,640]},
  {source:[1200,800],params:{width:640,height:320},expected:[480,320]},
  {source:[800,1200],params:{width:320,height:640},expected:[320,480]},
  {source:[1024,1024],params:{width:640},expected:[640,640]},
  {source:[1024,1024],params:{width:320},expected:[320,320]},
  {source:[160,96],params:{},expected:[96,58]},
  {source:[80,48],params:{width:160},expected:[160,96]},
 ];
 for (const [i,c] of cases.entries()) {
  await t.test(JSON.stringify(c),async()=>{
   const file=path.join(root,`source-${i}.png`);
   await sharp({create:{width:c.source[0],height:c.source[1],channels:3,background:'red'}}).png().toFile(file);
   const r=await execute({module_id:'local.image.resize',input_path:file,parameters:c.params},{manager,outputDir:path.join(root,`result-${i}`)});
   const actual=await sharp(r.output_path).metadata();
   assert.deepEqual([actual.width,actual.height],c.expected);
   assert.deepEqual([r.details.after.width,r.details.after.height],c.expected);
   const original=await sharp(file).metadata();assert.deepEqual([original.width,original.height],c.source);
  });
 }
});

test('resize rejects the old 64px output and does not inject an unrequested opposite dimension',()=>{
 const op=operations.find(o=>o.id==='local.image.resize');
 for (const width of [320,640]) assert.throws(()=>op.validateResult({before:{width:1024,height:1024},after:{width:64,height:64}},{width}),{code:'OUTPUT_DIMENSIONS_MISMATCH'});
 const properties=contracts().find(c=>c.module_id===op.id).parameter_schema.properties;
 assert.equal(properties.width.default,undefined);assert.equal(properties.height.default,undefined);
});

test('phone orientation is applied before resizing, padding, cropping, and explicit rotation',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-exif-geometry-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const sharp=require('sharp');sharp.cache(false);
 const manager={ensureComponent:async()=>({component_id:'media.sharp',version:sharp.versions.sharp,directory:path.resolve(__dirname,'..'),reused:true})};
 const pixels=Buffer.alloc(160*112*3);
 for(let y=0;y<112;y++)for(let x=0;x<160;x++){const i=(y*160+x)*3;pixels[i]=x;pixels[i+1]=y*2;pixels[i+2]=(x+y)%256;}
 for(const orientation of [2,6,8]){
  const file=path.join(root,`source-${orientation}.jpg`);
  await sharp(pixels,{raw:{width:160,height:112,channels:3}}).withMetadata({orientation}).jpeg().toFile(file);
  const original=fs.readFileSync(file),oriented=await sharp(file).autoOrient().png().toBuffer();
  const cases=[
   {id:'resize',params:{width:80},expected:s=>s.resize({width:80})},
   {id:'crop',params:{left:8,top:12,width:60,height:70},expected:s=>s.extract({left:8,top:12,width:60,height:70})},
   {id:'rotate',params:{angle:90},expected:s=>s.rotate(90)},
   {id:'pad-square-white',params:{},expected:s=>s.extend(orientation===2?{left:0,right:0,top:24,bottom:24,background:'#fff'}:{left:24,right:24,top:0,bottom:0,background:'#fff'})},
  ];
  for(const c of cases){
   const r=await execute({module_id:'local.image.'+c.id,input_path:file,parameters:c.params},{manager,outputDir:path.join(root,`${orientation}-${c.id}`)});
   const expected=await c.expected(sharp(oriented)).removeAlpha().raw().toBuffer({resolveWithObject:true});
   const actual=await sharp(r.output_path).removeAlpha().raw().toBuffer({resolveWithObject:true});
   assert.deepEqual([actual.info.width,actual.info.height],[expected.info.width,expected.info.height]);
   assert.ok(actual.data.equals(expected.data),`orientation ${orientation}, operation ${c.id}`);
   assert.deepEqual(fs.readFileSync(file),original);
  }
 }
});

test('upscale validation rejects the alpha loss observed in the actual anime trial',()=>{
 const op=operations.find(o=>o.id==='local.image.realesrgan');
 const observed={before:{width:384,height:353,has_alpha:true},after:{width:1152,height:1059,has_alpha:false}};
 assert.throws(()=>op.validateResult(observed,{scale:3,model:'anime'}),{code:'UPSCALE_ALPHA_MISMATCH'});
 op.validateResult({...observed,after:{...observed.after,has_alpha:true}},{scale:3,model:'anime'});
});

test('actual local video processing keeps audio and changes resolution',async t=>{
 if(!hasLocalFfmpeg())return t.skip('FFmpeg unavailable on this CI host');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-video-executor-')),file=path.join(root,'input.mp4');
 const executables={ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()};await run(executables.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x96:duration=0.4','-f','lavfi','-i','sine=duration=0.4','-c:v','libx264','-c:a','aac','-shortest',file]);
 const r=await execute({module_id:'local.video.scale',input_path:file,parameters:{width:80,height:48}},{manager:{ensureComponent:async()=>({component_id:'media.ffmpeg',version:'local',executables,reused:true})},outputDir:path.join(root,'result')});
 assert.ok(r.details.after.streams.some(s=>s.codec_type==='audio'));assert.equal(r.details.after.streams.find(s=>s.codec_type==='video').width,80);fs.rmSync(root,{recursive:true,force:true});
});

test('picture-only video edits preserve every compatible audio track and encode incompatible audio',async t=>{
 if(!hasLocalFfmpeg())return t.skip('FFmpeg unavailable on this CI host');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-original-audio-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const executables={ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()};
 const manager={ensureComponent:async()=>({component_id:'media.ffmpeg',version:'local',executables,reused:true})};
 const file=path.join(root,'two-tracks.mkv');
 await run(executables.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x96:duration=1','-f','lavfi','-i','sine=duration=1','-f','lavfi','-i','sine=frequency=660:duration=1','-map','0:v','-map','1:a','-map','2:a','-c:v','libx264','-c:a:0','aac','-c:a:1','pcm_s16le',file]);
 const hash=async input=>(await run(executables.ffmpeg,['-v','error','-i',input,'-map','0:a:0','-c','copy','-f','hash','-hash','sha256','-'])).stdout.trim();
 const edited=await execute({module_id:'local.video.hflip',input_path:file,parameters:{}},{manager,outputDir:path.join(root,'mirror')});
 assert.equal(await hash(file),await hash(edited.output_path));
 assert.deepEqual(edited.details.audio_handling.map(track=>track.mode),['copy','encode_aac']);
 assert.equal(edited.details.after.streams.filter(s=>s.codec_type==='audio').length,2);
 const speed=await execute({module_id:'local.video.speed',input_path:file,parameters:{speed:2}},{manager,outputDir:path.join(root,'speed')});
 assert.deepEqual(speed.details.audio_handling.map(track=>track.reason),['audio_filter','audio_filter']);
 assert.ok(Number(speed.details.after.format.duration)<0.7);
});
