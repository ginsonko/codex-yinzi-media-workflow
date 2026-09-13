const {test}=require('node:test');
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const sharp=require('sharp');
const {executeNative}=require('../src/services/videoCompositeLayers');
const {run,sha256}=require('../src/services/componentRuntime');
const {getFfmpegPath,getFfprobePath,hasLocalFfmpeg}=require('../src/utils/ffmpegPath');
const components=()=>({'media.ffmpeg':{executables:{ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()}}});
function temp(t){const base=path.resolve(os.tmpdir()),dir=fs.mkdtempSync(path.join(base,'yinzi-layers-'));t.after(()=>{assert.equal(path.dirname(dir),base);fs.rmSync(dir,{recursive:true,force:true});});return dir;}
async function color(file,c,{offset=0,audio=false,duration=3}={}){const args=['-y','-v','error','-f','lavfi','-i',`color=c=${c}:s=160x120:r=24:d=${duration}`];if(audio)args.push('-itsoffset','0.5','-f','lavfi','-i','sine=frequency=700:sample_rate=48000:duration=1');args.push('-c:v','libx264','-pix_fmt','yuv420p');if(audio)args.push('-c:a','aac');if(offset)args.push('-output_ts_offset',String(offset));await run(getFfmpegPath(),[...args,file]);return file;}
function pixel(file,t,x,y){const r=spawnSync(getFfmpegPath(),['-v','error','-ss',String(t),'-i',file,'-frames:v','1','-vf',`format=rgb24,crop=1:1:${x}:${y}`,'-f','rawvideo','pipe:1'],{windowsHide:true});assert.equal(r.status,0,r.stderr.toString());assert.equal(r.stdout.length,3);return [...r.stdout];}
function rms(file,t){const r=spawnSync(getFfmpegPath(),['-v','error','-ss',String(t),'-i',file,'-t','0.1','-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],{windowsHide:true});assert.equal(r.status,0,r.stderr.toString());let sum=0;for(let i=0;i<r.stdout.length;i+=4)sum+=r.stdout.readFloatLE(i)**2;return Math.sqrt(sum/Math.max(1,r.stdout.length/4));}
async function image(file,width,height,background){await sharp({create:{width,height,channels:4,background}}).png().toFile(file);return file;}
test('64 masked layers render beyond Windows command-line length with stable pixels',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),base=await color(path.join(dir,'base.mp4'),'blue',{duration:.25});
 const layer=await image(path.join(dir,'red.png'),16,16,{r:255,g:0,b:0,alpha:1});
 const mask=await image(path.join(dir,'white.png'),16,16,{r:255,g:255,b:255,alpha:1});
 const output=path.join(dir,'large layers.mp4');
 await executeNative({inputPath:base,outputPath:output,sources:[{path:base},{path:layer},{path:mask}],components:components(),parameters:{layers:Array.from({length:64},()=>({source:1,mask_source:2,width:16,height:16,opacity:.5}))}});
 assert.ok(pixel(output,.1,8,8)[0]>230);assert.ok(pixel(output,.1,80,80)[2]>230);
 const graph=fs.readdirSync(dir).find(n=>n.startsWith('.media-filter-'));assert.ok(fs.statSync(path.join(dir,graph)).size>32767);
});
test('one-frame MP4 stays a video as base and layer and does not freeze after EOF',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),base=await color(path.join(dir,'base.mp4'),'blue',{duration:.5}),one=path.join(dir,'one.mp4');
 await run(getFfmpegPath(),['-y','-v','error','-f','lavfi','-i','color=c=red:s=40x40:r=24','-frames:v','1','-c:v','libx264',one]);
 const result=await executeNative({inputPath:one,outputPath:path.join(dir,'single-out.mp4'),components:components()});
 assert.equal(result.before[0].is_image,false);assert.ok(result.after.duration<.1);
 const output=path.join(dir,'layer-out.mp4');
 await executeNative({inputPath:base,outputPath:output,sources:[{path:base},{path:one}],components:components(),parameters:{layers:[{source:1,end:.5}]}});
 assert.ok(pixel(output,0,15,15)[0]>235);assert.ok(pixel(output,.25,15,15)[2]>235);
});
test('real alpha, transparent contain and odd-sized mask retain geometry and display interval',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),base=await color(path.join(dir,'base.mp4'),'blue');
 const layer=await image(path.join(dir,'layer.png'),60,40,{r:255,g:0,b:0,alpha:.5});
 const mask=await image(path.join(dir,'mask.png'),63,63,{r:255,g:255,b:255,alpha:1});
 const out=path.join(dir,'out.mp4');const hash=await sha256(base);
 const result=await executeNative({inputPath:base,outputPath:out,sources:[{path:base},{path:layer},{path:mask}],components:components(),parameters:{layers:[{source:1,start:.5,end:1.5,x:30,y:20,width:63,height:63,mask_source:2}]}});
 assert.equal(result.planned_layers[0].width,63);assert.equal(result.after.has_audio,false);assert.ok(pixel(out,.2,50,50)[2]>235);
 const center=pixel(out,1,50,50);assert.ok(center[0]>105&&center[0]<155&&center[2]>105&&center[2]<155,JSON.stringify(center));
 assert.ok(pixel(out,1,50,22)[2]>235,'contain padding must remain transparent');assert.ok(pixel(out,1.5,50,50)[2]>235,'end is exclusive');assert.equal(await sha256(base),hash);
});
test('nonzero layer PTS, delayed base audio and short source EOF preserve visible timeline',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),base=await color(path.join(dir,'base.mp4'),'blue',{offset:2,audio:true}),layer=await color(path.join(dir,'layer.mp4'),'red',{offset:5,duration:1});
 const out=path.join(dir,'out.mp4');const result=await executeNative({inputPath:base,outputPath:out,sources:[{path:layer},{path:base}],components:components(),parameters:{layers:[{source:0,start:.5,end:2,source_in:.25,x:0,y:0,width:80,height:60}]}});
 assert.equal(result.base_source_index,1);assert.equal(result.planned_layers[0].end,1.25);assert.ok(pixel(out,.2,20,20)[2]>235);assert.ok(pixel(out,.75,20,20)[0]>235);assert.ok(pixel(out,1.5,20,20)[2]>235);
 assert.ok(rms(out,.1)<.001);assert.ok(rms(out,.7)>.05);assert.ok(rms(out,1.8)<.001);
 const frames=JSON.parse((await run(getFfprobePath(),['-v','error','-count_frames','-show_streams','-of','json',out])).stdout).streams.find(s=>s.codec_type==='video');assert.equal(Number(frames.nb_read_frames),72);
});
test('alpha mask inversion and repeat use preserve input bytes and reject empty intervals',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),base=await color(path.join(dir,'base.mp4'),'blue'),layer=await image(path.join(dir,'layer.png'),40,40,{r:255,g:0,b:0,alpha:1}),mask=await image(path.join(dir,'mask.png'),40,40,{r:255,g:255,b:255,alpha:0});
 const out=path.join(dir,'out.mp4');const args={inputPath:base,outputPath:out,sources:[{path:base},{path:layer},{path:mask}],components:components()};
 await executeNative({...args,parameters:{audio_mode:'none',layers:[{source:1,mask_source:2,mask_mode:'alpha',mask_invert:true},{source:1,x:80,opacity:.5}]}});assert.ok(pixel(out,1,20,20)[0]>235);const c=pixel(out,1,100,20);assert.ok(c[0]>105&&c[2]>105);
 await assert.rejects(executeNative({...args,parameters:{layers:[{source:1,start:1,end:1}]}}),{code:'COMPOSITE_LAYERS_INVALID_INPUT'});
 await assert.rejects(executeNative({...args,outputPath:layer}),{code:'COMPOSITE_LAYERS_INVALID_INPUT'});
});
test('dynamic mask follows its own timestamps, moves the reveal, and ends without freezing',{skip:!hasLocalFfmpeg()},async t=>{
 const dir=temp(t),base=await color(path.join(dir,'base.mp4'),'blue');
 const layer=await image(path.join(dir,'layer.png'),80,60,{r:255,g:0,b:0,alpha:1});
 const mask=path.join(dir,'moving-mask.mkv');
 await run(getFfmpegPath(),['-y','-v','error','-f','lavfi','-i',"nullsrc=s=80x60:r=24:d=1,geq=lum='if(lt(X,80*T),255,0)':cb=128:cr=128",'-c:v','ffv1','-output_ts_offset','4',mask]);
 const sources=[{path:layer},{path:base},{path:mask}],before=await Promise.all(sources.map(s=>sha256(s.path)));
 const out=path.join(dir,'out.mp4');
 const result=await executeNative({inputPath:base,outputPath:out,sources,components:components(),parameters:{layers:[{source:0,start:.5,end:2,source_in:0,x:20,y:20,mask_source:2}]}});
 assert.equal(result.base_source_index,1);assert.equal(result.audio_handling[0].source_index,1);assert.ok(Math.abs(result.planned_layers[0].end-1.5)<.002,'MKV millisecond timebase');
 assert.ok(pixel(out,.7,60,40)[2]>235,'mask has not reached the middle');
 assert.ok(pixel(out,1.2,60,40)[0]>235,'mask reveals the middle later');
 assert.ok(pixel(out,1.2,92,40)[2]>235,'unrevealed right edge retains the base');
 assert.ok(pixel(out,1.5,60,40)[2]>235,'short mask disappears at its actual end');
 assert.deepEqual(await Promise.all(sources.map(s=>sha256(s.path))),before);
});
