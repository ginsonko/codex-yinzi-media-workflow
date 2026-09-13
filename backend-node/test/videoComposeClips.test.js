const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {executeNative,validateAndPlanTimeline}=require('../src/services/videoComposeClips');
const {execute}=require('../src/services/localMediaExecutor');
const {run,sha256}=require('../src/services/componentRuntime');
const {getFfmpegPath,getFfprobePath,hasLocalFfmpeg}=require('../src/utils/ffmpegPath');
const component=()=>({component_id:'media.ffmpeg',version:'test-existing',reused:true,executables:{ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()}});
function temp(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-compose-'));t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true});});return root;}
async function color(root,name,c,{offset=0,delayed=false,silent=false}={}){
 const file=path.join(root,name+'.mp4');const args=['-y','-v','error','-f','lavfi','-i',`color=c=${c}:s=160x96:r=24:d=3`];
 if(!silent)args.push('-itsoffset',delayed?'0.5':'0','-f','lavfi','-i','sine=frequency=700:sample_rate=48000:duration=1');
 args.push('-c:v','libx264');if(!silent)args.push('-c:a','aac');if(offset)args.push('-output_ts_offset',String(offset));
 await run(getFfmpegPath(),[...args,file]);return file;
}
function pcm(file,t){const r=spawnSync(getFfmpegPath(),['-v','error','-ss',String(t),'-i',file,'-t','0.1','-vn','-ac','1','-ar','48000','-f','f32le','pipe:1'],{windowsHide:true});assert.equal(r.status,0,r.stderr.toString());let sum=0;for(let i=0;i<r.stdout.length;i+=4)sum+=r.stdout.readFloatLE(i)**2;return Math.sqrt(sum/Math.max(1,r.stdout.length/4));}
function rgb(file,t){const r=spawnSync(getFfmpegPath(),['-v','error','-ss',String(t),'-i',file,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true});assert.equal(r.status,0,r.stderr.toString());assert.equal(r.stdout.length,3);return [...r.stdout];}
test('256 short clips render through a filter file with exact frame count and audio',{skip:!hasLocalFfmpeg()},async t=>{
 const root=temp(t),input=await color(root,'source','red');
 const output=path.join(root,'large edit.mp4');
 const receipt=await executeNative({inputPath:input,outputPath:output,parameters:{clips:Array.from({length:256},()=>({source:0,source_in:0,source_out:1/24}))},components:{'media.ffmpeg':component()}});
 const metadata=JSON.parse((await run(getFfprobePath(),['-v','error','-count_frames','-show_streams','-of','json',output])).stdout);
 assert.equal(receipt.total_frames,256);assert.equal(Number(metadata.streams.find(s=>s.codec_type==='video').nb_read_frames),256);
 assert.ok(metadata.streams.some(s=>s.codec_type==='audio'));assert.ok(pcm(output,1)>.05);
 const graph=fs.readdirSync(root).find(n=>n.startsWith('.media-filter-'));assert.ok(fs.statSync(path.join(root,graph)).size>32767);
});
test('timeline rejects invalid source intervals and colliding transitions',()=>{
 assert.throws(()=>validateAndPlanTimeline([{source:2,source_in:0,source_out:1}],[3]),{code:'COMPOSE_CLIPS_INVALID_INPUT'});
 assert.throws(()=>validateAndPlanTimeline([{source:0,source_in:1,source_out:0}],[3]));
 assert.throws(()=>validateAndPlanTimeline([{source:0,source_in:0,source_out:1},{source:0,source_in:0,source_out:1,transition:'fade',transition_duration:.6},{source:0,source_in:0,source_out:1,transition:'fade',transition_duration:.6}],[3]));
});
test('all transition names use overlap rules and reject filter expressions or ignored first transitions',()=>{
 const {transitionIds}=require('../src/services/videoTransitions');
 for(const name of transitionIds.filter(n=>n!=='cut')) {
  const clips=[{source:0,source_in:0,source_out:1},{source:0,source_in:0,source_out:1,transition:name,transition_duration:.25}];
  const plan=validateAndPlanTimeline(clips,[3]);assert.equal(plan.totalDuration,1.75);assert.equal(plan.plannedClips[1].transition,name);
  assert.throws(()=>validateAndPlanTimeline([{...clips[0],transition:name}],[3]));
  assert.throws(()=>validateAndPlanTimeline([clips[0],{...clips[1],transition_duration:.6},{...clips[1],transition_duration:.6}],[3]));
 }
 assert.throws(()=>validateAndPlanTimeline([{source:0,source_in:0,source_out:1},{source:0,source_in:0,source_out:1,transition:'fade;movie=secret'}],[3]));
});
test('mixed wipe and circle transitions preserve timeline and clip ordering',{skip:!hasLocalFfmpeg()},async t=>{
 const root=temp(t),red=await color(root,'red','red'),blue=await color(root,'blue','blue',{silent:true});
 const output=path.join(root,'mixed.mp4');const receipt=await executeNative({inputPath:red,outputPath:output,sources:[{path:red},{path:blue}],parameters:{clips:[{source:0,source_in:0,source_out:1},{source:1,source_in:0,source_out:1,transition:'wipeleft',transition_duration:.25},{source:0,source_in:0,source_out:1,transition:'circleopen',transition_duration:.25}]},components:{'media.ffmpeg':component()}});
 assert.equal(receipt.total_frames,60);assert.ok(rgb(output,.2)[0]>220);assert.ok(rgb(output,1.2)[2]>220);assert.ok(rgb(output,2.2)[0]>220);
 assert.ok(pcm(output,1.2)<.001);assert.ok(pcm(output,2.2)>.05);
});
test('real compose keeps delayed audio and early silence relative to nonzero video origin',{skip:!hasLocalFfmpeg()},async t=>{
 const root=temp(t);const input=await color(root,'带空格 延迟音轨','red',{offset:2,delayed:true});const hash=await sha256(input);
 const output=path.join(root,'result.mp4');const result=await executeNative({inputPath:input,outputPath:output,components:{'media.ffmpeg':component()}});
 assert.equal(result.total_frames,72);assert.ok(pcm(output,.1)<.001);assert.ok(pcm(output,.7)>.05);assert.ok(pcm(output,1.9)<.001);assert.equal(await sha256(input),hash);
 const tail=path.join(root,'tail.mp4');await executeNative({inputPath:input,outputPath:tail,parameters:{clips:[{source:0,source_in:1.8,source_out:2.8}]},components:{'media.ffmpeg':component()}});assert.ok(pcm(tail,.1)<.001);
 const trimmed=path.join(root,'trimmed.mp4');await executeNative({inputPath:input,outputPath:trimmed,parameters:{clips:[{source:0,source_in:.75,source_out:1.25}]},components:{'media.ffmpeg':component()}});assert.ok(pcm(trimmed,.1)>.05);
 await assert.rejects(executeNative({inputPath:input,outputPath:input,components:{'media.ffmpeg':component()}}),{code:'COMPOSE_CLIPS_INVALID_INPUT'});
});
test('mixed sources, repeated clips and consecutive fades retain order, sound and frame count',{skip:!hasLocalFfmpeg()},async t=>{
 const root=temp(t),red=await color(root,'red','red'),blue=await color(root,'blue','blue',{silent:true});
 const receipt=await execute({module_id:'local.video.compose-clips',input_path:red,sources:[{path:red},{path:blue}],parameters:{clips:[{source:0,source_in:0,source_out:1},{source:1,source_in:0,source_out:1,transition:'fade',transition_duration:.25},{source:0,source_in:0,source_out:1,transition:'fade',transition_duration:.25}]}},{outputDir:path.join(root,'out'),manager:{ensureComponent:async()=>component()}});
 assert.equal(receipt.details.total_frames,60);assert.equal(receipt.sources.length,2);assert.ok(receipt.sources.every(s=>s.sha256));
 const a=rgb(receipt.output_path,.2),b=rgb(receipt.output_path,1.2),c=rgb(receipt.output_path,2.2);assert.ok(a[0]>220&&a[2]<20);assert.ok(b[2]>220&&b[0]<20);assert.ok(c[0]>220&&c[2]<20);
 assert.ok(pcm(receipt.output_path,.2)>.05);assert.ok(pcm(receipt.output_path,1.2)<.001);assert.ok(pcm(receipt.output_path,2.2)>.05);
});
test('short cuts quantize cumulative boundaries without multiplying roundoff',{skip:!hasLocalFfmpeg()},async t=>{
 const root=temp(t),input=await color(root,'short','red',{silent:true});
 const result=await executeNative({inputPath:input,outputPath:path.join(root,'many.mp4'),parameters:{audio_mode:'none',clips:Array.from({length:40},()=>({source:0,source_in:0,source_out:.101}))},components:{'media.ffmpeg':component()}});
 assert.equal(result.total_frames,97);assert.equal(result.after.has_audio,false);assert.ok(Math.abs(result.after.duration-4.04)<1/24);
 const tiny=await executeNative({inputPath:input,outputPath:path.join(root,'tiny-fade.mp4'),parameters:{audio_mode:'none',clips:[{source:0,source_in:0,source_out:1},{source:0,source_in:0,source_out:1,transition:'fade',transition_duration:.01}]},components:{'media.ffmpeg':component()}});
 assert.equal(tiny.timeline[1].transition,'cut');assert.equal(tiny.total_frames,48);
});
test('offset Matroska without stream duration uses playable packet span',{skip:!hasLocalFfmpeg()},async t=>{
 const root=temp(t),input=path.join(root,'offset.mkv');
 await run(getFfmpegPath(),['-y','-v','error','-f','lavfi','-i','color=c=red:s=160x96:r=24:d=1','-c:v','ffv1','-output_ts_offset','4',input]);
 const receipt=await executeNative({inputPath:input,outputPath:path.join(root,'out.mp4'),components:{'media.ffmpeg':component()}});
 assert.equal(receipt.total_frames,24);assert.ok(Math.abs(receipt.after.duration-1)<.05);assert.ok(rgb(path.join(root,'out.mp4'),.8)[0]>235);
});
