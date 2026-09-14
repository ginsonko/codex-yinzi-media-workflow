const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const op=require('../src/services/localSystemSpeech');
const {getFfmpegPath,getFfprobePath,hasLocalFfmpeg}=require('../src/utils/ffmpegPath');
test('local speech rejects ambiguous parameters before queuing or speaking',()=>{
 for(const p of [{voice:3},{language:'-Command'},{rate:'1'},{rate:0.5},{volume:101},{sample_rate:Infinity},{max_characters:0}])assert.throws(()=>op.validateParameters(p),{code:'INVALID_PARAMETERS'});
 const {getOperation}=require('../src/services/localMediaOperations');assert.equal(getOperation(op.id),op);
});
test('offline Windows voices render Chinese and English with preserved text, while missing voices fail explicitly',{skip:process.platform!=='win32'||!hasLocalFfmpeg()},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-speech-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const components={'media.ffmpeg':{executables:{ffmpeg:getFfmpegPath(),ffprobe:getFfprobePath()}}};
 for(const [language,text]of [['zh-CN','这是一次离线配音测试。'],['en-US','This is an offline speech test.']]){
  const input=path.join(root,language+' 原文.txt'),output=path.join(root,language+'.wav');fs.writeFileSync(input,text,'utf8');const before=fs.readFileSync(input);
  let r;try{r=await op.executeNative({inputPath:input,outputPath:output,parameters:{language,rate:1,sample_rate:24000},components});}catch(e){if(e.code==='SPEECH_LANGUAGE_UNAVAILABLE'){t.diagnostic('Requested test voice is not installed: '+language);continue}throw e}
  assert.ok(r.duration_seconds>0.3);assert.equal(r.sample_rate,24000);assert.equal(r.channels,1);assert.ok(r.language.startsWith(language.split('-')[0]));assert.equal(r.quality_status,'review_required');assert.deepEqual(fs.readFileSync(input),before);
  assert.equal(fs.readFileSync(path.join(root,language+'-text.txt'),'utf8'),text);assert.equal(r.assets.length,2);
 }
 const input=path.join(root,'plain.txt'),output=path.join(root,'missing.wav');fs.writeFileSync(input,'Hello');
 await assert.rejects(op.executeNative({inputPath:input,outputPath:output,parameters:{voice:'definitely absent test voice'},components}),e=>e.code==='SPEECH_VOICE_UNAVAILABLE'&&e.message.includes('可用声音'));
 assert.equal(fs.existsSync(output),false);
 await assert.rejects(op.executeNative({inputPath:input,outputPath:input,components}),{code:'SPEECH_OUTPUT_OVERWRITES_INPUT'});
 fs.writeFileSync(input,' ');await assert.rejects(op.executeNative({inputPath:input,outputPath:output,components}),{code:'SPEECH_TEXT_EMPTY'});
 fs.writeFileSync(input,Buffer.from([0xff,0xfe,0x80]));await assert.rejects(op.executeNative({inputPath:input,outputPath:output,components}),{code:'SPEECH_TEXT_ENCODING'});
 fs.writeFileSync(input,'Long');await assert.rejects(op.executeNative({inputPath:input,outputPath:output,parameters:{max_characters:2},components}),{code:'SPEECH_TEXT_LIMIT'});
 const marker=path.join(root,'unexpected.txt');
 const literal=`A quote: \". $([IO.File]::WriteAllText('${marker.replaceAll('\\','/')}', 'unexpected'))`;
 fs.writeFileSync(input,literal,'utf8');
 await op.executeNative({inputPath:input,outputPath:output,parameters:{rate:5},components});
 assert.equal(fs.existsSync(marker),false,'plain narration text must never execute PowerShell');
 assert.equal(fs.readFileSync(path.join(root,'missing-text.txt'),'utf8'),literal);
 assert.equal(fs.readdirSync(root).some(x=>x.startsWith('.speech-')),false);
});