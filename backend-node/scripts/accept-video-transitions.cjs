// Real FFmpeg acceptance of built-in transition parameters. No provider calls.
const fs=require('node:fs'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createComponentManager,run,sha256,writeJson}=require('../src/services/componentRuntime');
const {executeNative}=require('../src/services/videoComposeClips');
const {transitions}=require('../src/services/videoTransitions');
async function main(){
 const root=path.resolve(process.argv[2]);fs.mkdirSync(root,{recursive:true});
 const manager=createComponentManager({root:process.argv[3]?path.resolve(process.argv[3]):path.join(root,'components')});
 const ff=await manager.ensureComponent('media.ffmpeg');const bins=ff.executables;
 const sources=[];
 for(const [name,color] of [['first','red'],['second','blue']]){
  const file=path.join(root,name+'.mp4');
  await run(bins.ffmpeg,['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=160x96:r=24:d=1`,'-f','lavfi','-i','sine=frequency=500:sample_rate=48000:duration=1','-c:v','libx264','-c:a','aac',file]);sources.push({path:file});
 }
 const rgb=(file,t)=>{const r=spawnSync(bins.ffmpeg,['-v','error','-ss',String(t),'-i',file,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true});if(r.status||r.stdout.length!==3)throw Error('端点帧读取失败');return [...r.stdout];};
 const results=[];
 for(const option of transitions){
  const output=path.join(root,option.id+'.mp4');let entry;
  try{
   const details=await executeNative({inputPath:sources[0].path,outputPath:output,sources,components:{'media.ffmpeg':ff},parameters:{clips:[{source:0,source_in:0,source_out:1},{source:1,source_in:0,source_out:1,transition:option.id,transition_duration:.5}]}});
   const a=rgb(output,.1),b=rgb(output,1.35);
   if(details.total_frames!==36||a[0]<220||a[2]>20||b[2]<220||b[0]>20)throw Error('帧数或首尾素材顺序不符');
   await run(bins.ffmpeg,['-v','error','-ss','0.75','-i',output,'-frames:v','1','-y',path.join(root,option.id+'.png')]);
   entry={id:option.id,title:option.title,status:'passed',output,sha256:await sha256(output),frames:details.total_frames,seconds:details.total_duration,endpoints:{first:a,last:b}};
  }catch(e){entry={id:option.id,status:'failed',message:e.message};}
  results.push(entry);writeJson(path.join(root,'acceptance.json'),{at:new Date().toISOString(),component:{id:ff.component_id,version:ff.version},total:results.length,passed:results.filter(r=>r.status==='passed').length,scope:'58 built-in parameters of one compose-clips operation; short colored video fixtures, not creative quality acceptance',results});console.log(entry.status,entry.id,entry.message||'');
 }
 if(results.some(r=>r.status!=='passed'))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
