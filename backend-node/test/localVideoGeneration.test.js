const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {validateParameters,operations,runOwned}=require('../src/services/localVideoGeneration');

test('local video rejects unsupported precision/schedules and preserves valid configurable dimensions',()=>{
  assert.equal(validateParameters({}).frames,107);
  assert.equal(validateParameters({width:640,height:384,frames:35}).width,640);
  for(const value of [{frames:30},{width:513},{fps:30},{profile:'hybrid'},{steps:4},{seed:NaN},{threads:true},{timeout_seconds:Infinity},{reference_video:'clip.mp4'}])assert.throws(()=>validateParameters(value),{code:'INVALID_PARAMETERS'});
  assert.throws(()=>validateParameters({frames:107},true),{code:'INVALID_PARAMETERS'});
  assert.equal(validateParameters({timeout_seconds:300},true).timeout_seconds,300);
});
test('missing local configuration returns actionable setup error and cannot silently call cloud',async()=>{
  const previous=process.env.YINZI_LOCAL_VIDEO_CONFIG;
  process.env.YINZI_LOCAL_VIDEO_CONFIG=path.join(os.tmpdir(),'missing-local-video-'+Date.now()+'.json');
  try{
    await assert.rejects(operations[0].executeNative({parameters:{},inputPath:__filename,outputPath:path.join(os.tmpdir(),'unused.mp4'),components:{}}),{code:'LOCAL_VIDEO_SETUP_REQUIRED'});
  }finally{if(previous===undefined)delete process.env.YINZI_LOCAL_VIDEO_CONFIG;else process.env.YINZI_LOCAL_VIDEO_CONFIG=previous;}
});
test('owned process forwards real JSON phases and reports failure',async()=>{
  const events=[];
  await runOwned(process.execPath,['-e','console.log(JSON.stringify({stage:"sampling",completed:2,total:8}));console.log("diagnostic")'],{timeout:5000,onEvent:e=>events.push(e)});
  assert.deepEqual(events,[{stage:'sampling',completed:2,total:8}]);
  await assert.rejects(runOwned(process.execPath,['-e','process.stderr.write("failed fixture");process.exit(3)'],{timeout:5000,onEvent:()=>{}}),{code:'LOCAL_VIDEO_FAILED'});
});
test('owned timeout kills its subprocess, not unrelated work',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'local-video-process-'));
  const file=path.join(dir,'child.json');
  const script='const {spawn}=require("node:child_process");const fs=require("fs");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(process.argv[1],JSON.stringify({pid:c.pid}));setInterval(()=>{},1000)';
  try{
    await assert.rejects(runOwned(process.execPath,['-e',script,file],{timeout:800,onEvent:()=>{}}),{code:'LOCAL_VIDEO_TIMEOUT'});
    if(process.platform==='win32')assert.throws(()=>process.kill(JSON.parse(fs.readFileSync(file)).pid,0));
    assert.doesNotThrow(()=>process.kill(process.pid,0));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
