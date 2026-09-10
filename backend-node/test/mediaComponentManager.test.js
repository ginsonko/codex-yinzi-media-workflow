const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const AdmZip=require('adm-zip');
const {createComponentManager,download,extractZip,sha256}=require('../src/services/componentRuntime');
const tmp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-component-test-'));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function archive(text){const z=new AdmZip();z.addFile('payload.txt',Buffer.from(text));return z.toBuffer();}
const manifest=(bytes,version='1')=>({component_id:'test.component',version,kind:'zip',platforms:[process.platform+'-'+process.arch],urls:['https://github.com/test/component.zip'],sha256:hash(bytes),disk_bytes:1,executables:{file:'payload.txt'}});
const response=bytes=>new Response(bytes,{headers:{'content-length':String(bytes.length)}});
test('trusted registry rejects arbitrary manifests and unknown components',()=>{
 const bytes=archive('ok'),m=createComponentManager({root:tmp(),registry:[manifest(bytes)]});
 assert.throws(()=>m.ensureComponent({component_id:'test.component',url:'https://evil.invalid/x'}),/任意/);
 assert.throws(()=>m.ensureComponent('../escape'));
 assert.throws(()=>m.ensureComponent('unknown.component'));
});
test('fresh install, concurrent ensure, cached reuse, and broken files repair',async()=>{
 const root=tmp(),bytes=archive('ok');let calls=0,checks=0;
 const m=createComponentManager({root,registry:[manifest(bytes)],fetch:async()=>{calls++;return response(bytes);},probe:async(_,dir)=>{checks++;assert.equal(fs.readFileSync(path.join(dir,'payload.txt'),'utf8'),'ok');return 'ok';}});
 const [a,b]=await Promise.all([m.ensureComponent('test.component'),m.ensureComponent('test.component')]);assert.equal(a.directory,b.directory);assert.equal(calls,1);
 assert.equal((await m.ensureComponent('test.component')).reused,true);assert.equal(calls,1);
 fs.writeFileSync(path.join(a.directory,'payload.txt'),'broken');const repaired=await m.ensureComponent('test.component');assert.notEqual(repaired.directory,a.directory);assert.equal(calls,1);assert.ok(checks>=2);
 fs.rmSync(root,{recursive:true,force:true});
});
test('failed new health check preserves installed current version',async()=>{
 const root=tmp(),one=archive('ok'),two=archive('bad');
 const first=createComponentManager({root,registry:[manifest(one)],fetch:async()=>response(one),probe:async()=>true});const old=await first.ensureComponent('test.component');
 const next=createComponentManager({root,registry:[manifest(two,'2')],fetch:async()=>response(two),probe:async()=>{throw Error('health failed');}});
 await assert.rejects(next.ensureComponent('test.component'),/health failed/);assert.equal(next.readState('test.component').directory,old.directory);assert.equal(fs.readFileSync(path.join(old.directory,'payload.txt'),'utf8'),'ok');
 fs.rmSync(root,{recursive:true,force:true});
});
test('bad SHA is rejected and corrupt cache is removed',async()=>{
 const root=tmp(),target=path.join(root,'file.part');await assert.rejects(download('https://github.com/test/x',target,'a'.repeat(64),()=>{},async()=>response(Buffer.from('bad'))),/SHA/);assert.equal(fs.existsSync(target),false);fs.rmSync(root,{recursive:true,force:true});
});
test('partial downloads resume with a verified Content-Range',async()=>{
 const root=tmp(),target=path.join(root,'file.part'),bytes=Buffer.from('abcdef');fs.writeFileSync(target,bytes.subarray(0,3));
 await download('https://github.com/test/x',target,hash(bytes),()=>{},async(_,o)=>{assert.equal(o.headers.Range,'bytes=3-');return new Response(bytes.subarray(3),{status:206,headers:{'content-range':'bytes 3-5/6','content-length':'3'}});});assert.equal(await sha256(target),hash(bytes));fs.rmSync(root,{recursive:true,force:true});
});
test('wrong Range and redirected untrusted hosts never reach extraction',async()=>{
 const root=tmp(),target=path.join(root,'file.part');fs.writeFileSync(target,'abc');
 await assert.rejects(download('https://github.com/test/x',target,'a'.repeat(64),()=>{},async()=>new Response('x',{status:206,headers:{'content-range':'bytes 0-0/1'}})),/断点/);
 await assert.rejects(download('https://github.com/test/x',target,'a'.repeat(64),()=>{},async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}})),/HTTPS/);fs.rmSync(root,{recursive:true,force:true});
});
test('unsafe zip ADS names are rejected before file write',()=>{
 const root=tmp(),z=new AdmZip();z.addFile('file.txt:stream',Buffer.from('bad'));const file=path.join(root,'archive.zip');fs.writeFileSync(file,z.toBuffer());assert.throws(()=>extractZip(file,path.join(root,'out')),/不安全/);fs.rmSync(root,{recursive:true,force:true});
});
test('two independent managers share a cross-process installation lock',async()=>{
 const root=tmp(),bytes=archive('ok');let calls=0;const options={root,registry:[manifest(bytes)],fetch:async()=>{calls++;return response(bytes);},probe:async()=>true};
 const [a,b]=await Promise.all([createComponentManager(options).ensureComponent('test.component'),createComponentManager(options).ensureComponent('test.component')]);assert.equal(a.directory,b.directory);assert.equal(calls,1);fs.rmSync(root,{recursive:true,force:true});
});

test('native component integrity includes weights and repairs a changed model from verified cache',async()=>{
 const root=tmp(),zip=new AdmZip();zip.addFile('engine.exe',Buffer.from('fixture executable'));zip.addFile('models/weights.bin',Buffer.from('original weights'));
 const bytes=zip.toBuffer();let downloads=0;
 const definition={...manifest(bytes),verify_all_files:true,executables:{engine:'engine.exe'}};
 const manager=createComponentManager({root,registry:[definition],fetch:async()=>{downloads++;return response(bytes);},probe:async()=>true});
 try{
  const first=await manager.ensureComponent(definition.component_id);
  assert.ok(first.files[path.join('models','weights.bin')]);
  fs.writeFileSync(path.join(first.directory,'models/weights.bin'),'broken weights');
  const next=await manager.ensureComponent(definition.component_id);
  assert.notEqual(first.directory,next.directory);assert.equal(downloads,1);
  assert.equal(fs.readFileSync(path.join(next.directory,'models/weights.bin'),'utf8'),'original weights');
  assert.equal(fs.readFileSync(path.join(first.directory,'models/weights.bin'),'utf8'),'broken weights');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('resource execution lock releases after failure and serializes managers',async()=>{
 const root=tmp(),one=createComponentManager({root,registry:[]}),two=createComponentManager({root,registry:[]});let active=0,peak=0;
 const action=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,30));active--;};
 try{
  await Promise.all([one.withResource('gpu',action),two.withResource('gpu',action)]);assert.equal(peak,1);
  await assert.rejects(one.withResource('gpu',async()=>{throw Error('fixture');}),/fixture/);
  await two.withResource('gpu',action);assert.equal(active,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('decoded compressed component text uses its hash instead of compressed Content-Length',async()=>{
 const root=tmp(),target=path.join(root,'license.part'),bytes=Buffer.from('OFL LICENSE '.repeat(100));const progress=[];
 try {
  await download('https://raw.githubusercontent.com/example/LICENSE',target,hash(bytes),event=>progress.push(event),async(_,options)=>{
   assert.equal(options.headers['Accept-Encoding'],'identity');
   return new Response(bytes,{headers:{'content-encoding':'gzip','content-length':'40'}});
  });
  assert.equal(await sha256(target),hash(bytes));
  assert.equal(progress.at(-1).total_bytes,null);
  assert.equal(progress.at(-1).bytes,bytes.length);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('an encoded partial response falls back to a complete request without appending decoded ranges',async()=>{
 const root=tmp(),target=path.join(root,'file.part'),bytes=Buffer.from('complete license');let calls=0;
 fs.writeFileSync(target,'old partial');
 try {
  await download('https://raw.githubusercontent.com/example/LICENSE',target,hash(bytes),()=>{},async(_,options)=>{
   calls++;
   if(calls===1){assert.ok(options.headers.Range);return new Response('suffix',{status:206,headers:{'content-encoding':'gzip','content-range':'bytes 11-16/17'}});}
   assert.equal(options.headers.Range,undefined);return new Response(bytes,{headers:{'content-encoding':'gzip','content-length':'4'}});
  });
  assert.equal(calls,2);assert.equal(await sha256(target),hash(bytes));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('compressed content still obeys the decoded size limit',async()=>{
 const root=tmp(),target=path.join(root,'oversized.part');let chunks=0;
 const stream=new ReadableStream({pull(controller){if(chunks++<513)controller.enqueue(new Uint8Array(1024*1024));else controller.close();}});
 try {
  await assert.rejects(download('https://github.com/example/x',target,'a'.repeat(64),()=>{},async()=>new Response(stream,{headers:{'content-encoding':'gzip','content-length':'4'}})),{code:'COMPONENT_TOO_LARGE'});
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('failed repair never reports corrupted current files as ready after restart',async()=>{
 const root=tmp(),bytes=archive('ok');let healthy=true;
 const options={root,registry:[manifest(bytes)],fetch:async()=>response(bytes),probe:async()=>{if(!healthy)throw Error('health failed');return true;}};
 const manager=createComponentManager(options),installed=await manager.ensureComponent('test.component');
 fs.writeFileSync(path.join(installed.directory,'payload.txt'),'corrupted');healthy=false;
 await assert.rejects(manager.ensureComponent('test.component'),/health failed/);
 const state=createComponentManager(options).runtimeComponents()[0];
 assert.equal(state.status,'repair_required');assert.equal(state.available,false);assert.equal(state.installed,true);assert.equal(state.retryable,true);
 assert.equal(fs.readFileSync(path.join(installed.directory,'payload.txt'),'utf8'),'corrupted');
 healthy=true;await manager.ensureComponent('test.component');assert.equal(manager.runtimeComponents()[0].status,'ready');
 fs.rmSync(root,{recursive:true,force:true});
});

test('runtime component status preserves ready copies after a failed update and exposes progress',()=>{
 const root=tmp(),bytes=archive('ok'),m=manifest(bytes,'1'),dir=path.join(root,'test.component','versions','ready');
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'payload.txt'),'ok');
 fs.writeFileSync(path.join(root,'test.component','current.json'),JSON.stringify({component_id:'test.component',version:'1',sha256:m.sha256,status:'ready',directory:dir,files:{'payload.txt':hash(Buffer.from('ok'))}}));
 fs.writeFileSync(path.join(root,'test.component','progress.json'),JSON.stringify({component_id:'test.component',stage:'failed',message:'new version failed'}));
 const item=createComponentManager({root,registry:[m]}).runtimeComponents()[0];
 assert.equal(item.status,'ready');assert.equal(item.installed,true);assert.equal(item.progress.stage,'failed');assert.equal(item.retryable,false);
 fs.rmSync(root,{recursive:true,force:true});
});
