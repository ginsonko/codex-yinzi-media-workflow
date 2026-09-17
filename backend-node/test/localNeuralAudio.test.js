const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {operations,validateParameters}=require('../src/services/localNeuralAudio');
const {snapshot,verify}=require('../src/services/localMediaSources');

test('neural audio validates resources, scope and voice references before inference',async()=>{
 for(const p of [{threads:0},{threads:'4'},{seconds:31},{seed:-1},{purpose:'anything'},{reference_path:3},{segment_characters:0},{checkpoint:'override'},{text:'override'},{mode:'music'}])assert.throws(()=>validateParameters(p),{code:'INVALID_PARAMETERS'});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'neural-audio-'));
 try{
  const input=path.join(root,'text.txt'),ref=path.join(root,'reference.wav');fs.writeFileSync(input,'测试文本');fs.writeFileSync(ref,'reference');
  const sources=snapshot({module_id:'local.audio.clone-voice',input_path:input,parameters:{reference_path:ref}});
  assert.equal(sources.length,2);verify(sources);fs.appendFileSync(ref,'changed');assert.throws(()=>verify(sources),{code:'INPUT_CHANGED'});
  for(const op of operations)await assert.rejects(op.executeNative({inputPath:input,outputPath:path.join(root,'result.wav'),parameters:{purpose:'commercial'}}),{code:'MODEL_LICENSE_NOT_SUITABLE'});
  await assert.rejects(operations[1].executeNative({inputPath:input,outputPath:path.join(root,'result.wav'),parameters:{}}),{code:'VOICE_REFERENCE_REQUIRED'});
  const before=process.env.YINZI_NEURAL_AUDIO_CONFIG;process.env.YINZI_NEURAL_AUDIO_CONFIG=path.join(root,'absent.json');
  try{await assert.rejects(operations[0].executeNative({inputPath:input,outputPath:path.join(root,'result.wav'),parameters:{}}),{code:'NEURAL_AUDIO_SETUP_REQUIRED'});}
  finally{if(before===undefined)delete process.env.YINZI_NEURAL_AUDIO_CONFIG;else process.env.YINZI_NEURAL_AUDIO_CONFIG=before;}
  assert.equal(fs.existsSync(path.join(root,'result.wav')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
