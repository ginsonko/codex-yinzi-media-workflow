const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {validateSongParameters,operations,readConfiguration}=require('../src/services/localNeuralAudio');
const song=operations.find(op=>op.id==='local.audio.neural-song');

test('song operation exposes lyrics, score and tunable low-memory resources independently of CPU music',()=>{
 assert.ok(song);
 assert.equal(song.resource_group,'neural-audio');
 assert.equal(operations.find(x=>x.id==='local.audio.neural-music').defaults.seconds,12);
 assert.equal(validateSongParameters({seconds:95}).seconds,95);
 assert.equal(validateSongParameters({seconds:45,duration_seconds:28}).seconds,28);
 assert.equal(validateSongParameters({lyrics:'[Chorus]\n唱出自己的声音',gpu_fraction:.65,vae_tile:64,offload_profile:5}).gpu_fraction,.65);
 for(const raw of [{seconds:NaN},{seconds:361},{seconds:'30'},{steps:0},{gpu_fraction:0},{device:-1},{mode:3},{mode:2,score_file:'x.abc'},{score_file:''},{purpose:'unknown'},{lyrics:'甲',text:'乙'},{budgets:null,python:'override'},{budgets:{unknown:300}},{budgets:{vae:NaN}},{budgets:[]},{save_latents:'yes'},{lyrics:3},{text:'\0'}, {minimum_free_ram_gib:-1}])assert.throws(()=>validateSongParameters(raw),{code:'INVALID_PARAMETERS'});
 assert.equal(validateSongParameters({minimum_free_vram_gib:0}).minimum_free_vram_gib,0,'4.5GB is not an unconditional runtime lock');
});

test('song validates empty lyrics and commercial weights before GPU subprocess startup',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yue2-operation-'));
 try{
  const input=path.join(root,'lyrics.txt');fs.writeFileSync(input,'\ufeff[Verse]\n好天气里唱首歌');
  await assert.rejects(song.executeNative({inputPath:input,outputPath:path.join(root,'song.wav'),parameters:{purpose:'commercial'}}),{code:'MODEL_LICENSE_NOT_SUITABLE'});
  await assert.rejects(song.executeNative({inputPath:input,outputPath:path.join(root,'song.wav'),parameters:{lyrics:'  '}}),{code:'AUDIO_TEXT_INVALID'});
  const score=path.join(root,'score.abc');fs.writeFileSync(score,'\0');
  await assert.rejects(song.executeNative({inputPath:input,outputPath:path.join(root,'song.wav'),parameters:{score_file:score}}),{code:'INVALID_PARAMETERS'});
  const before=process.env.YINZI_NEURAL_AUDIO_CONFIG;process.env.YINZI_NEURAL_AUDIO_CONFIG=path.join(root,'config.json');
  try{
   assert.throws(()=>readConfiguration('song'),error=>error.code==='NEURAL_AUDIO_SETUP_REQUIRED'&&error.message.includes('setup-yue2.py'));
   fs.writeFileSync(process.env.YINZI_NEURAL_AUDIO_CONFIG,JSON.stringify({music:{python:process.execPath},song:{python:process.execPath,source_dir:path.join(root,'missing'),weights_dir:root}}));
   assert.throws(()=>readConfiguration('song'),{code:'NEURAL_AUDIO_SETUP_REQUIRED'});
   assert.equal(readConfiguration('music').python,process.execPath);
  }finally{if(before===undefined)delete process.env.YINZI_NEURAL_AUDIO_CONFIG;else process.env.YINZI_NEURAL_AUDIO_CONFIG=before;}
  assert.equal(fs.existsSync(path.join(root,'song.wav')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
