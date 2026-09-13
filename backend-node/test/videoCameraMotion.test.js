const{test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const{spawnSync}=require('node:child_process'),sharp=require('sharp');
const{executeNative,buildZoompanFilter,validateKeyframes}=require('../src/services/videoCameraMotion');
const{run,sha256}=require('../src/services/componentRuntime');
const{getFfmpegPath,getFfprobePath,hasLocalFfmpeg}=require('../src/utils/ffmpegPath');
const components={'media.ffmpeg':{executables:{ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()}}};
function temp(t){const root=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(root,'yinzi-camera-'));t.after(()=>{assert.equal(path.dirname(dir),root);fs.rmSync(dir,{recursive:true,force:true})});return dir;}
function frame(file,time){const r=spawnSync(getFfmpegPath(),['-v','error','-ss',String(time),'-i',file,'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,maxBuffer:4e6});assert.equal(r.status,0,r.stderr.toString());return r.stdout;}
function rms(file,t){const r=spawnSync(getFfmpegPath(),['-v','error','-ss',String(t),'-i',file,'-t','0.1','-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],{windowsHide:true});assert.equal(r.status,0,r.stderr.toString());let s=0;for(let i=0;i<r.stdout.length;i+=4)s+=r.stdout.readFloatLE(i)**2;return Math.sqrt(s/Math.max(1,r.stdout.length/4));}
async function video(dir,{fps=24,offset=0,audio=false,codec='libx264'}={}){const file=path.join(dir,`source-${fps}-${offset}-${codec}.mkv`),args=['-y','-v','error','-f','lavfi','-i',`testsrc2=s=160x120:r=${fps}:d=3`];if(audio)args.push('-itsoffset','0.5','-f','lavfi','-i','sine=frequency=600:sample_rate=48000:duration=1');args.push('-c:v',codec);if(audio)args.push('-c:a','pcm_s16le');if(offset)args.push('-output_ts_offset',String(offset));await run(getFfmpegPath(),[...args,file]);return file;}
test('expressions grow linearly and 100 subframe keyframes render on real FFmpeg',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),input=await video(dir),keyframes=Array.from({length:100},(_,i)=>({time:i*.02,center_x:.5,center_y:.5,zoom:1.1+i*.003,easing:'ease-in-out'}));
 const expr=buildZoompanFilter(validateKeyframes(keyframes,3),160,120,30);assert.ok(expr.length<200000);
 const result=await executeNative({inputPath:input,outputPath:path.join(dir,'out.mp4'),components,parameters:{fps:30,source_out:2,keyframes}});
 assert.equal(result.total_frames,60);assert.equal(result.after.duration,2);
 assert.notDeepEqual(frame(path.join(dir,'out.mp4'),.1),frame(path.join(dir,'out.mp4'),1.5));
});
test('PNG motion preserves geometry and static keyframes stay still',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),input=path.join(dir,'square.png');
 await sharp({create:{width:160,height:120,channels:3,background:'black'}}).composite([{input:await sharp({create:{width:40,height:40,channels:3,background:'white'}}).png().toBuffer(),left:60,top:40}]).png().toFile(input);
 const out=path.join(dir,'still.mp4'),h=await sha256(input);
 await executeNative({inputPath:input,outputPath:out,components,parameters:{width:160,height:240,duration:1,fps:24,keyframes:[{time:0,zoom:1}]}});
 const pixels=frame(out,.2);let xs=[],ys=[];for(let y=0;y<240;y++)for(let x=0;x<160;x++)if(pixels[(y*160+x)*3]>220){xs.push(x);ys.push(y)}
 assert.ok(Math.abs((Math.max(...xs)-Math.min(...xs))-(Math.max(...ys)-Math.min(...ys)))<=2,'square must not stretch');
 assert.deepEqual(frame(out,.2),frame(out,.7));
 const move=path.join(dir,'move.mp4');await executeNative({inputPath:input,outputPath:move,components,parameters:{duration:1,keyframes:[{time:0,zoom:1},{time:1,zoom:2}]}});assert.notDeepEqual(frame(move,.1),frame(move,.8));assert.equal(await sha256(input),h);
});
test('offset video selection preserves delayed audio, silent tail and actual frame count',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),input=await video(dir,{offset:4,audio:true}),out=path.join(dir,'out.mp4');
 const result=await executeNative({inputPath:input,outputPath:out,components,parameters:{source_in:.25,source_out:2.25,fps:30,keyframes:[{time:.2,zoom:1.1,easing:'hold'},{time:1,zoom:1.4}]}});
 assert.equal(result.total_frames,60);assert.ok(rms(out,.05)<.001);assert.ok(rms(out,.5)>.05);assert.ok(rms(out,1.6)<.001);
 const silent=path.join(dir,'silent.mp4');const tail=await executeNative({inputPath:input,outputPath:silent,components,parameters:{source_in:2,source_out:2.8,keyframes:[{time:0}]}});assert.equal(tail.audio_handling.mode,'silent_source_interval');assert.ok(rms(silent,.2)<.001);
});
test('MJPEG remains video, input selects the correct source and files cannot be overwritten',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),input=await video(dir,{codec:'mjpeg',fps:30}),other=await video(dir),out=path.join(dir,'out.mp4');
 const result=await executeNative({inputPath:input,outputPath:out,sources:[{path:other},{path:input}],components,parameters:{source_in:.13,source_out:1.13,keyframes:[{time:0}]}});
 assert.equal(result.before.is_image,false);assert.equal(result.output_fps,30);assert.equal(result.total_frames,30);assert.notDeepEqual(frame(out,.1),frame(out,.8));
 await assert.rejects(executeNative({inputPath:input,outputPath:other,sources:[{path:other},{path:input}],components}),{code:'CAMERA_MOTION_INVALID_INPUT'});
});
