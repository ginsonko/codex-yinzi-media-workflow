const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createComponentManager,run}=require('../src/services/componentRuntime');
const {execute}=require('../src/services/localMediaExecutor');
async function main(){
 const root=path.resolve(process.argv[2]),manager=createComponentManager({root:path.join(root,'components')}),ff=await manager.ensureComponent('media.ffmpeg'),sh=await manager.ensureComponent('media.sharp');
 const effects=path.join(root,'effects');fs.mkdirSync(effects,{recursive:true});
 const green=path.join(effects,'green.mp4');await run(ff.executables.ffmpeg,['-nostdin','-y','-v','error','-f','lavfi','-i','color=c=0x00ff00:size=64x64:duration=0.3','-c:v','libx264','-pix_fmt','yuv420p',green]);
 const keyed=await execute({module_id:'local.video.chromakey',input_path:green},{manager,outputDir:path.join(effects,'keyed')});
 const raw=path.join(effects,'keyed.rgb');await run(ff.executables.ffmpeg,['-nostdin','-y','-v','error','-i',keyed.output_path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24',raw]);const pixels=fs.readFileSync(raw);const mean=pixels.reduce((sum,n)=>sum+n,0)/pixels.length;assert.ok(mean<6,'green screen did not become black: '+mean);
 const wav=path.join(effects,'44100.wav');await run(ff.executables.ffmpeg,['-nostdin','-y','-v','error','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=1','-c:a','pcm_s16le',wav]);
 const pitched=await execute({module_id:'local.audio.pitch',input_path:wav,parameters:{factor:1.1}},{manager,outputDir:path.join(effects,'pitched')});const pcm=path.join(effects,'pitched.pcm');await run(ff.executables.ffmpeg,['-nostdin','-y','-v','error','-i',pitched.output_path,'-f','s16le','-ac','1',pcm]);
 const bytes=fs.readFileSync(pcm);let crossings=0;for(let i=2;i<bytes.length;i+=2)if(bytes.readInt16LE(i-2)<=0&&bytes.readInt16LE(i)>0)crossings++;const duration=bytes.length/2/48000,hz=crossings/duration;assert.ok(Math.abs(duration-1)<0.08);assert.ok(Math.abs(hz-484)<8,'pitch incorrect '+hz);
 const small=path.join(effects,'small.png');await run(process.execPath,['-e',"require('sharp')({create:{width:32,height:24,channels:3,background:'red'}}).png().toFile(process.argv[1])",small],{cwd:sh.directory});
 const bordered=await execute({module_id:'local.image.join-border',input_path:small},{manager,outputDir:path.join(effects,'bordered')});assert.equal(bordered.details.after.width,32);assert.equal(bordered.details.after.height,24);
 fs.writeFileSync(path.join(effects,'effects.json'),JSON.stringify({at:new Date().toISOString(),status:'passed',green_mean:mean,pitch_hz:hz,pitch_duration:duration,border_dimensions:[32,24]},null,2));console.log('Effect acceptance passed',JSON.stringify({mean,hz,duration}));
}main().catch(e=>{console.error(e);process.exitCode=1;});
