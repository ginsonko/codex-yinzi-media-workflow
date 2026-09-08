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
