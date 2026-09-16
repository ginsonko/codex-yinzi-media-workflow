const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const api = import('../src/services/promptAdapter/index.mjs');
const shot = (changes={}) => ({version:'shot-ir/v1',shots:[{shot_id:1,subject:'仙尊挡在地球前',action:'挥剑击退敌首',raw_text:'旧稿里的角色仍站着',time:{duration:10},...changes}]});

test('mixed reference slots and edited IR preserve identities, constraints and prose', async()=>{
  const {executePromptRequest} = await api;
  const ir = shot({subject:'主角已消失，留下空镜',negative:'不要角色残影，也不要新增星球',references:[{type:'image',index:1,asset_id:'hero'},{type:'video',index:1,asset_id:'motion'},{type:'audio',index:1,asset_id:'beat'}]});
  for (const profile of ['Seedance 2.5','minimax-h3']) {
    const out=executePromptRequest({ir,profile});
    assert.equal(out.success,true);
    for(const fragment of ['@图片1','@视频1','@音频1','不要角色残影','主角已消失']) assert.ok(out.compiled.prompt.includes(fragment));
    assert.ok(!out.compiled.prompt.includes('旧稿'));
    assert.equal(out.compiled.metadata.generation_submitted,false);
    assert.deepEqual(out.ir,ir);
  }
});
test('plain language, mixed timing and explicit fields do not lose remaining clauses', async()=>{
  const {executePromptRequest} = await api;
  for(const text of ['少女站在桥上，随后转身跃下，伞沿遮住镜头。','时长：5秒，角色冲刺并挥剑。','运镜：特写，向左绕行，军团退向远处。','主体：少女\n动作：拔剑，挡下光束\n声音：剑鸣\n约束：避免穿模']) {
    const out=executePromptRequest({text,profile:'minimax-h3'});
    assert.equal(out.success,true);
    for(const fragment of text.split(/[，,。\n]/).filter(Boolean).map(s=>s.replace(/^[^：]+：/,''))) assert.ok(out.compiled.prompt.includes(fragment),fragment);
    assert.equal(out.ir.metadata.original_text,text);
  }
});
test('malformed nested structures return actionable errors for every mode', async()=>{
  const {executePromptRequest,compileShotIR,getProfile} = await api;
  for(const changes of [{references:[null]},{references:{}},{camera:{description:5}},{camera:[]},{time:{duration:-1}},{time:{start:NaN}},{negative:{}},{unsupported:'oops'},{audio:[]},{custom_extensions:[]}]) {
    const out=executePromptRequest({ir:shot(changes),profile:'Seedance 2.5'});
    assert.equal(out.success,false,JSON.stringify(changes));
    assert.ok(out.errors.length);
    assert.doesNotThrow(()=>compileShotIR(shot(changes),getProfile('Seedance 2.5')));
  }
  assert.equal(executePromptRequest({ir:shot({time:null}),profile:'Seedance 2.5'}).success,true);
});
test('contracts, exact model names, unknowns and custom reference syntax stay separate', async()=>{
  const {getProfile,executePromptRequest,registerCustomProfile} = await api;
  assert.notEqual(getProfile('Seedance 2.0'),getProfile('Seedance 2.0-720'));
  assert.equal(getProfile('Seedance 2.5').duration_min,4);
  assert.equal(getProfile('Seedance 2.5-720').fixed_duration_seconds,30);
  const h3=getProfile('minimax-h3');
  assert.equal(h3.max_prompt_length,null);
  assert.equal(h3.first_last_frame_supported,null);
  const custom={...h3,profile_id:'my-channel',reference_template:'[{type}{index}]',supported_resolutions:['custom']};
  registerCustomProfile(custom);
  custom.supported_resolutions.push('mutated');
  assert.deepEqual(getProfile('my-channel').supported_resolutions,['custom']);
  assert.throws(()=>registerCustomProfile({...custom,reference_template:'{index}'}));
  const out=executePromptRequest({profile:custom,ir:shot({references:[{type:'video',index:2}]})});
  assert.ok(out.compiled.prompt.includes('[视频2]'));
});
test('reference collisions fail without selecting an asset silently; overlimits preserve all references',async()=>{
  const {executePromptRequest}=await api;
  const ir=shot({references:[{type:'image',index:1,path:'a.png'},{type:'image',index:1,path:'b.png'}]});
  const out=executePromptRequest({ir,profile:'Seedance 2.5'});
  assert.equal(out.success,false);
  assert.ok(out.compiled.loss_report.some(r=>r.field==='references.image:1'));
  const many=executePromptRequest({profile:'Seedance 2.5',ir:shot({references:Array.from({length:31},(_,i)=>({index:i+1,type:'image'}))})});
  assert.equal(many.compiled.reference_manifest.length,31);
  assert.ok(many.compiled.loss_report.some(r=>r.field==='references.image'));
});
test('strict checking explains timing, resolution and prohibited frame roles without changing IR',async()=>{
  const {executePromptRequest}=await api;
  const ir=shot({time:{duration:40},references:[{type:'image',index:1,role:'first_frame'}]});
  const out=executePromptRequest({ir,profile:'Seedance 2.5',options:{strict:true,resolution:'4K'}});
  assert.equal(out.success,false);
  assert.deepEqual(out.ir,ir);
  for(const field of ['time.duration','resolution','first_last_frame']) assert.ok(out.compiled.loss_report.some(r=>r.field===field));
});
test('real local CLI and HTTP use the same service without generation or database',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-prompts-'));
  const input=path.join(dir,'request.json');
  const request={text:'仙尊一剑破阵，随后回望地球。',profile:'Seedance 2.5'};
  fs.writeFileSync(input,JSON.stringify(request));
  try {
    const cli=spawnSync(process.execPath,[path.join(__dirname,'../scripts/prompt-adapter.mjs'),'--input',input],{encoding:'utf8',timeout:15000});
    assert.equal(cli.status,0,cli.stderr);
    const app=require('express')(); app.use(require('express').json()); app.use('/api/v1/prompt-adapter',require('../src/routes/promptAdapter')());
    const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}/api/v1/prompt-adapter`;
    try {
      const response=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
      assert.equal(response.status,200);
      assert.equal((await response.json()).data.compiled.prompt,JSON.parse(cli.stdout).compiled.prompt);
      const bad=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ir:shot({negative:{}}),profile:'Seedance 2.5'})});
      assert.equal(bad.status,400);
      const collision=await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ir:shot({references:[{type:'image',index:1,path:'a.png'},{type:'image',index:1,url:'https://example.invalid/b.png'}]}),profile:'Seedance 2.5'})});
      assert.equal(collision.status,400);
      const collisionBody=await collision.json();
      assert.equal(collisionBody.success,false);
      assert.equal(collisionBody.error.code,'REFERENCE_CONFLICT');
      const profiles=await (await fetch(base+'/profiles')).json(); assert.ok(profiles.data.profiles.length>=5);
    } finally { await new Promise(resolve=>server.close(resolve)); }
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('review regressions retain ambiguous reference variants and preserve whitespace-only field fallback',async()=>{
  const {executePromptRequest,parseTextToShotIR}=await api;
  assert.deepEqual(parseTextToShotIR('构图1要对称，地图1在远处。').shots[0].references,[]);
  assert.equal(parseTextToShotIR('使用@图片1参考主体，@视频1参考动作。').shots[0].references.length,2);
  const fallback=executePromptRequest({ir:shot({subject:'   ',action:'\t',raw_text:'仙尊回望地球'}),profile:'Seedance 2.5'});
  assert.match(fallback.compiled.prompt,/仙尊回望地球/);
  for(const second of [{path:'b.png'},{url:'https://example.invalid/b.png'}]){
    const ir=shot({references:[{type:'image',index:1,path:'a.png'},{type:'image',index:1,...second}]});
    const out=executePromptRequest({ir,profile:'Seedance 2.5'});
    assert.equal(out.success,false);assert.equal(out.code,'REFERENCE_CONFLICT');
    assert.equal(out.compiled.reference_manifest.length,0);
    assert.equal(out.compiled.reference_conflicts[0].variants.length,2);
    assert.deepEqual(out.ir,ir);
  }
});
