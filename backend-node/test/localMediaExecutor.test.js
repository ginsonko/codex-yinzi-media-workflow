const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {operations,contracts}=require('../src/services/localMediaOperations');
const {execute}=require('../src/services/localMediaExecutor');
const {getFfmpegPath,getFfprobePath,hasLocalFfmpeg}=require('../src/utils/ffmpegPath');
const {run}=require('../src/services/componentRuntime');
test('every local contract has a concrete executor and unique operation',()=>{
 assert.ok(operations.length>=100);assert.equal(new Set(operations.map(o=>o.id)).size,operations.length);
 for(const o of operations)assert.equal(typeof(o.apply||o.build),'function');assert.equal(contracts().length,operations.length);
});
test('actual isolated image transform preserves source and validates dimensions',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-image-executor-')),file=path.join(root,'input.png');const sharp=require('sharp');sharp.cache(false);
 await sharp({create:{width:160,height:96,channels:3,background:'red'}}).png().toFile(file);
 const manager={ensureComponent:async()=>({component_id:'media.sharp',version:require('sharp').versions.sharp,directory:path.resolve(__dirname,'..'),reused:true})};
 const r=await execute({module_id:'local.image.resize',input_path:file,parameters:{width:80,height:48}},{manager,outputDir:path.join(root,'result')});
 assert.equal(r.details.after.width,80);assert.equal(r.details.after.height,48);assert.equal(r.status,'succeeded');assert.ok(r.input_sha256&&r.output_sha256);fs.rmSync(root,{recursive:true,force:true});
});
test('actual local video processing keeps audio and changes resolution',async t=>{
 if(!hasLocalFfmpeg())return t.skip('FFmpeg unavailable on this CI host');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-video-executor-')),file=path.join(root,'input.mp4');
 const executables={ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()};await run(executables.ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=160x96:duration=0.4','-f','lavfi','-i','sine=duration=0.4','-c:v','libx264','-c:a','aac','-shortest',file]);
 const r=await execute({module_id:'local.video.scale',input_path:file,parameters:{width:80,height:48}},{manager:{ensureComponent:async()=>({component_id:'media.ffmpeg',version:'local',executables,reused:true})},outputDir:path.join(root,'result')});
 assert.ok(r.details.after.streams.some(s=>s.codec_type==='audio'));assert.equal(r.details.after.streams.find(s=>s.codec_type==='video').width,80);fs.rmSync(root,{recursive:true,force:true});
});
