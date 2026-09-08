// Real, no-provider acceptance. Use an isolated directory; receipts and outputs
// are retained for inspection. This never reads production configuration.
const fs=require('node:fs'),path=require('node:path');
const {createComponentManager,run,writeJson}=require('../src/services/componentRuntime');
const {operations}=require('../src/services/localMediaOperations');
const {execute}=require('../src/services/localMediaExecutor');
const {sourceFingerprints}=require('../src/services/localMediaValidation');
async function main(){
  const root=path.resolve(process.argv[2]);fs.mkdirSync(root,{recursive:true});
  const manager=createComponentManager({root:path.join(root,'components')});
  const ff=await manager.ensureComponent('media.ffmpeg'),sh=await manager.ensureComponent('media.sharp');
  const video=path.join(root,'source.mp4'),audio=path.join(root,'source.wav'),image=path.join(root,'source.png');
  if(!fs.existsSync(video))await run(ff.executables.ffmpeg,['-nostdin','-y','-v','error','-f','lavfi','-i','testsrc2=size=160x96:rate=12:duration=1','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=1','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',video]);
  if(!fs.existsSync(audio))await run(ff.executables.ffmpeg,['-nostdin','-y','-v','error','-i',video,'-vn','-c:a','pcm_s16le',audio]);
  if(!fs.existsSync(image))await run(ff.executables.ffmpeg,['-nostdin','-y','-v','error','-i',video,'-frames:v','1',image]);
  const selection=process.argv[3],results=[],start=Date.now(),fingerprints=sourceFingerprints();
  for(const op of operations.filter(o=>!selection||o.id.includes(selection))){
    const dir=path.join(root,'outputs',op.id);let result;
    try{const receipt=await execute({module_id:op.id,input_path:op.kind==='image'?image:op.kind==='audio'?audio:video},{manager,outputDir:dir});
      result={id:op.id,status:'passed',bytes:receipt.bytes,output_sha256:receipt.output_sha256,receipt:path.join(dir,'receipt.json')};
    }catch(e){result={id:op.id,status:'failed',message:e.message};}
    results.push(result);writeJson(path.join(root,selection?'acceptance-selected.json':'acceptance.json'),{at:new Date().toISOString(),elapsed_ms:Date.now()-start,source_fingerprints:fingerprints,registered_components:[{id:ff.component_id,version:ff.version},{id:sh.component_id,version:sh.version}],total:results.length,passed:results.filter(r=>r.status==='passed').length,results});
    console.log(result.status,op.id,result.status==='failed'?result.message:'');
  }
  console.log('RESULT',results.filter(r=>r.status==='passed').length,'/',results.length);if(results.some(r=>r.status==='failed'))process.exitCode=1;
}
main().catch(e=>{console.error(e);process.exitCode=1;});
