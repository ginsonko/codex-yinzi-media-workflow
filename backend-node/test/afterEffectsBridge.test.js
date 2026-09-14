const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { buildDemoScript, createDemo, findExecutable, runAfterEffects, readReceipt } = require('../src/services/afterEffectsBridge');
function temporary(t) { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-ae-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return dir; }

test('generated JSX is valid JavaScript and preserves untrusted text as a string', t => {
  const dir=temporary(t), title='"; app.quit(); //\n中文\r';
  const script=buildDemoScript({outputDir:dir,title});
  new vm.Script(script);
  assert.ok(script.includes(JSON.stringify(title)));
  assert.throws(()=>buildDemoScript({outputDir:dir,width:'1);app.quit()'}),{code:'INVALID_AE_PARAMETER'});
});

test('existing output is preserved and absent AE does not dispatch', async t => {
  const dir = temporary(t);
  const result = createDemo(dir, { title: 'Test' });
  const prior=fs.readFileSync(result.scriptPath,'utf8');
  assert.throws(()=>createDemo(dir),{code:'AFTERFX_OUTPUT_EXISTS'});
  assert.equal(fs.readFileSync(result.scriptPath,'utf8'),prior);
  assert.equal(findExecutable({ YINZI_AFTERFX_PATH: path.join(dir, 'missing.exe') }, 'win32'), null);
  await assert.rejects(runAfterEffects(result.scriptPath,{executable:null}),{code:'AFTERFX_MISSING'});
  assert.equal(fs.existsSync(path.join(dir,'yinzi-ai-ae-demo.dispatch.json')),false);
});

test('newer AE versions are discovered without changing a fixed year list',t=>{
  const dir=temporary(t), exe=path.join(dir,'Adobe','Adobe After Effects 2027','Support Files','AfterFX.exe');
  fs.mkdirSync(path.dirname(exe),{recursive:true}); fs.writeFileSync(exe,'fixture');
  assert.equal(findExecutable({ProgramFiles:dir},'win32'),exe);
});

test('a receipt alone cannot establish a rendered output',t=>{
  const dir=temporary(t), receipt=path.join(dir,'yinzi-ai-ae-demo.receipt.json');
  fs.writeFileSync(receipt,JSON.stringify({status:'rendered_pending_media_qa'}));
  assert.throws(()=>readReceipt(dir),{code:'AFTERFX_OUTPUT_MISSING'});
  fs.writeFileSync(path.join(dir,'yinzi-ai-ae-demo.aep'),'fixture');
  fs.writeFileSync(path.join(dir,'yinzi-ai-ae-demo.avi'),'');
  assert.throws(()=>readReceipt(dir),{code:'AFTERFX_OUTPUT_MISSING'});
  fs.writeFileSync(path.join(dir,'yinzi-ai-ae-demo.avi'),'fixture');
  assert.equal(readReceipt(dir).status,'rendered_pending_media_qa');
});

test('generated script refuses to replace an open user project',t=>{
  const dir=temporary(t), script=buildDemoScript({outputDir:dir}); let text='';
  const context={app:{project:{numItems:4},newProject(){throw Error('must not be called');}},
    Folder:function(){this.exists=true;this.fsName=dir;},
    File:function(){this.exists=false;this.open=()=>true;this.write=v=>{text=v;};this.close=()=>{};}};
  vm.runInNewContext(script,context);
  const receipt=JSON.parse(text);
  assert.equal(receipt.status,'failed'); assert.match(decodeURIComponent(receipt.message),/AE_PROJECT_BUSY/);
});