const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const sharp=require('sharp');
const download=require('../src/services/mediaDownload');
const index=require('../src/services/mediaIndex');
const {operations}=require('../src/services/sourceLibraryOperations');
const component=require('../src/services/componentRuntime').readState('media.ffmpeg');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-source-integration-'));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
let sequence=0;
async function serve(body,mime,action){
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':mime});res.end(body);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{return await action(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));}
}
async function run(items,parameters={},extras={}){
 const job=path.join(root,'job-'+sequence++);fs.mkdirSync(job);
 const inputPath=path.join(job,'input.json'),outputPath=path.join(job,'result.json');
 fs.writeFileSync(inputPath,JSON.stringify({items}));
 return download.executeNative({inputPath,outputPath,parameters,allowLoopback:true,components:{'media.ffmpeg':component},sharp,...extras});
}
test('web pages prepare extractor once and preserve both download and installation failure',async()=>{
 let installs=0;
 await serve('<!doctype html><html><video></video></html>','text/html',async base=>{
  const result=await run([{url:base+'/watch/1'},{url:base+'/watch/2'}],{}, {ensureComponent:async id=>{
   installs++;assert.equal(id,'tool.yt-dlp');throw Object.assign(new Error('offline component mirror'),{code:'COMPONENT_DOWNLOAD_FAILED'});
  }});
  assert.equal(installs,1);assert.equal(result.summary.failed_count,2);
  for(const item of result.summary.items){assert.equal(item.error_code,'COMPONENT_DOWNLOAD_FAILED');assert.equal(item.direct_error.code,'SITE_EXTRACTION_REQUIRED');}
 });
});
test('JSON error media and size constraints never install the extractor',async()=>{
 let installs=0;const ensureComponent=async()=>{installs++;throw new Error('unexpected install');};
 await serve('{"error":"busy"}','application/json',async base=>{
  const result=await run([{url:base+'/clip.mp4'},null],{}, {ensureComponent});
  assert.equal(result.summary.items[0].error_code,'UPSTREAM_ERROR_PAYLOAD');
  assert.equal(result.summary.items[1].error_code,'INVALID_URL');
 });
 await serve('A'.repeat(100),'application/octet-stream',async base=>{
  const result=await run([{url:base+'/clip.mp4'}],{max_bytes_per_file:10},{ensureComponent});
  assert.equal(result.summary.failed_count,1);
 });
 assert.equal(installs,0);
});
test('explicit extractor mode prepares it without a direct request',async()=>{
 let calls=0;
 const result=await run([{url:'https://example.com/watch/1'}],{prefer_direct:false},{ensureComponent:async()=>{calls++;throw Object.assign(new Error('unavailable'),{code:'COMPONENT_UNSUPPORTED_PLATFORM'});}});
 assert.equal(calls,1);assert.equal(result.summary.items[0].error_code,'COMPONENT_UNSUPPORTED_PLATFORM');
});
test('direct media enforces duration and removes overlong artifacts',async()=>{
 const samples=16000, wav=Buffer.alloc(44+samples*2);
 wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(samples*2,40);
 await serve(wav,'audio/wav',async base=>{
  const result=await run([{url:base+'/voice.wav'}],{max_duration_seconds:1});
  assert.equal(result.summary.items[0].error_code,'DURATION_EXCEEDED');assert.equal(result.assets.length,0);
 });
});
async function indexRun(roots,parameters={}){
 const job=path.join(root,'index-'+sequence++);fs.mkdirSync(job);
 const inputPath=path.join(job,'roots.json'),outputPath=path.join(job,'result.json');fs.writeFileSync(inputPath,JSON.stringify({roots}));
 await index.executeNative({inputPath,outputPath,parameters,components:{'media.ffmpeg':component},sharp});
 return {path:outputPath,data:JSON.parse(fs.readFileSync(outputPath,'utf8'))};
}
test('missing roots fail instead of silently producing an empty library',async()=>{
 await assert.rejects(()=>indexRun([path.join(root,'absent')]),{code:'INDEX_ROOT_MISSING'});
});
test('index cache refreshes subsecond edits and fulfills stronger probe and hash options',async()=>{
 const dir=path.join(root,'library');fs.mkdirSync(dir);const file=path.join(dir,'note.txt');fs.writeFileSync(file,'alpha');
 const first=await indexRun([dir]);
 const cached=await indexRun([dir],{cache_path:first.path});assert.equal(cached.data.summary.cache_reused_count,1);
 const previous=fs.statSync(file);fs.writeFileSync(file,'omega');fs.utimesSync(file,previous.atime,new Date(previous.mtimeMs+200));
 const second=await indexRun([dir],{cache_path:first.path});assert.equal(second.data.summary.cache_reused_count,0);assert.notEqual(second.data.files[0].sha256,first.data.files[0].sha256);
 const pic=path.join(root,'pictures');fs.mkdirSync(pic);await sharp({create:{width:8,height:8,channels:3,background:'#123456'}}).png().toFile(path.join(pic,'cover.png'));
 const cheap=await indexRun([pic],{compute_sha256:false,probe_media:false});
 const rich=await indexRun([pic],{cache_path:cheap.path});assert.equal(rich.data.summary.cache_reused_count,0);assert.ok(rich.data.files[0].sha256);assert.equal(rich.data.files[0].technical_metadata.width,8);
});
test('fully failed downloads fail the job; mixed results remain available for review',()=>{
 const operation=operations.find(o=>o.id==='local.media.download');
 assert.throws(()=>operation.validateResult({summary:{succeeded_count:0,items:[{status:'failed',error_code:'UPSTREAM_ERROR_PAYLOAD',error_message:'upstream'}]}}),{code:'UPSTREAM_ERROR_PAYLOAD'});
 operation.validateResult({summary:{succeeded_count:1}});
});
