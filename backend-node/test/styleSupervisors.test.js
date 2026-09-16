const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const Database = require('better-sqlite3');
const express = require('express');
const {createOrchestrationService} = require('../src/services/orchestrationService');
const {createStyleSupervisors} = require('../src/services/styleSupervisors');
const supervisorRoutes = require('../src/routes/styleSupervisors');
const prefs = require('../src/services/creativePreferences');
const root=path.resolve(__dirname,'../..');
const plugin=path.join(root,'codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow');
let db, service, supervisors;

beforeEach(()=>{db=new Database(':memory:');service=createOrchestrationService(db);supervisors=createStyleSupervisors(db);});
afterEach(()=>db.close());
const custom = ()=>({name:'小测试',style:'优先真实细节',suitable_for:'旅行',audience_feeling:'置身现场',tradeoff:'节奏可能更慢',tags:['测试目标'],visual_rules:['先交代空间'],audio_rules:['保留环境声'],review_criteria:['声音来源可以解释'],enabled:true});

test('ships 20 rich profiles and recommends one primary plus two alternatives from editable tags',()=>{
  const items=supervisors.list().items;
  assert.equal(items.length,20);assert.equal(new Set(items.map(i=>i.id)).size,20);
  assert.ok(items.every(i=>i.visual_rules.length && i.audio_rules.length && i.review_criteria.length && i.tradeoff));
  const recommendation=supervisors.recommend({user_goal:'MAD 鬼畜，热梗角色和原声反转'});
  assert.equal(recommendation.main.supervisor_id,'builtin-mischief');assert.equal(recommendation.alternatives.length,2);
  assert.equal(supervisors.recommend({user_goal:'a homemade cut'}).needs_context_review,true);
  const added=supervisors.create(custom());assert.equal(supervisors.recommend({user_goal:'测试目标'}).main.supervisor_id,added.id);
  supervisors.update(added.id,{enabled:false,expected_revision:1});assert.notEqual(supervisors.recommend({user_goal:'测试目标'}).main.supervisor_id,added.id);
});

test('CRUD enforces optimistic revisions and restores deleted builtins without resurrecting on service restart',()=>{
  const original=supervisors.get('builtin-mischief');
  const edited=supervisors.update(original.id,{name:'小乐子本机版',expected_revision:1});assert.equal(edited.revision,2);
  assert.throws(()=>supervisors.update(original.id,{name:'stale',expected_revision:1}),{code:'SUPERVISOR_REVISION_CONFLICT'});
  supervisors.remove(original.id,{expected_revision:2});assert.equal(supervisors.get(original.id),null);
  assert.equal(supervisors.list().items.length,19);assert.equal(supervisors.list({include_deleted:true}).items.length,20);
  assert.equal(createStyleSupervisors(db).get(original.id),null);
  const restored=supervisors.restore(original.id,{expected_revision:3});assert.equal(restored.name,original.name);assert.equal(restored.revision,4);
});

test('imports validated pure data as copies and rolls back the whole invalid package',()=>{
  const exported=supervisors.exportProfiles(), before=supervisors.list().total;
  assert.throws(()=>supervisors.importProfiles({...exported,profiles:[custom(),{...custom(),command:'powershell bad'}]}),{code:'SUPERVISOR_INVALID'});
  assert.equal(supervisors.list().total,before);
  assert.throws(()=>supervisors.importProfiles({...exported,profiles:[{...custom(),tags:0}]}),{code:'SUPERVISOR_INVALID'});
  assert.throws(()=>supervisors.importProfiles({...exported,profiles:[{...custom(),name:'sk-thisIsATestSecretOnlyNotARealKey12345'}]}),{code:'SUPERVISOR_SECRET'});
  const result=supervisors.importProfiles(exported);assert.equal(result.imported,20);assert.equal(result.overwrite,false);
  assert.ok(result.items.every(i=>!i.builtin && i.id.startsWith('custom-')));
  assert.equal(supervisors.get('builtin-mischief').revision,1);
});

test('120 and 300 profile directories round-trip without a row-count limit',()=>{
  for (const total of [120,300]) {
    const sourceDb=new Database(':memory:'),targetDb=new Database(':memory:');
    try {
      const source=createStyleSupervisors(sourceDb),target=createStyleSupervisors(targetDb);
      for(let index=20;index<total;index++)source.create({...custom(),name:`目录往返-${index}`});
      const bundle=source.exportProfiles();assert.equal(bundle.profiles.length,total);
      const receipt=target.importProfiles(JSON.parse(JSON.stringify(bundle,null,2)));
      assert.equal(receipt.imported,total);assert.deepEqual(target.exportProfiles({offset:20}),bundle);
      const empty=target.exportProfiles({q:'no-such-profile'});assert.equal(target.importProfiles(empty).imported,0);
    } finally {sourceDb.close();targetDb.close();}
  }
});

test('shared UTF-8 byte boundary rejects oversized import and export and keeps explicit batches complete',()=>{
  const longRules=Array.from({length:24},(_,index)=>`${index}${'界'.repeat(1197)}`);
  for(let index=0;index<20;index++)supervisors.create({...custom(),name:`超长交换目录-${index}`,visual_rules:longRules,audio_rules:longRules,review_criteria:longRules});
  let exportError;
  try{supervisors.exportProfiles({q:'超长交换目录'});}catch(error){exportError=error;}
  assert.equal(exportError?.code,'SUPERVISOR_BUNDLE_TOO_LARGE');
  assert.ok(exportError.details.bytes>supervisors.list().exchange_limits.max_bundle_bytes);
  assert.match(exportError.message,/分批导出/);
  const first=supervisors.exportProfiles({q:'超长交换目录',offset:0,limit:10});
  const second=supervisors.exportProfiles({q:'超长交换目录',offset:10,limit:10});
  assert.equal(first.profiles.length,10);assert.equal(second.profiles.length,10);
  const oversized={...first,profiles:[...first.profiles,...second.profiles]};
  assert.ok(JSON.stringify(oversized,null,2).length<4*1024*1024,'multibyte fixture would pass an incorrect character-count check');
  assert.throws(()=>supervisors.importProfiles(oversized),{code:'SUPERVISOR_BUNDLE_TOO_LARGE'});assert.equal(supervisors.list().total,40);
  const targetDb=new Database(':memory:');
  try {const target=createStyleSupervisors(targetDb);target.importProfiles(first);target.importProfiles(second);assert.deepEqual(target.exportProfiles({offset:20,limit:10}),first);assert.deepEqual(target.exportProfiles({offset:30,limit:10}),second);}
  finally{targetDb.close();}
  assert.throws(()=>supervisors.exportProfiles({offset:-1}),{code:'SUPERVISOR_EXPORT_RANGE'});
  assert.throws(()=>supervisors.exportProfiles({limit:1.5}),{code:'SUPERVISOR_EXPORT_RANGE'});
});

test('real HTTP exports and reimports complete 120-to-300 item directories and filtered ranges',async()=>{
  const app=express();app.use(express.json({limit:'10mb'}));app.use('/api/v1',supervisorRoutes(db));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}/api/v1/media-supervisors`;
  const request=async(route,method='GET',body)=>{const response=await fetch(base+route,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result.data;};
  const bundle=profiles=>({schema_version:1,kind:'yinzi-style-supervisors',profiles});
  try {
    await request('/import','POST',bundle(Array.from({length:100},(_,index)=>({...custom(),name:`HTTP目录-${index}`}))));
    const first=await request('/export');assert.equal(first.profiles.length,120);assert.equal((await request('/import','POST',first)).imported,120);
    await request('/import','POST',bundle(Array.from({length:60},(_,index)=>({...custom(),name:`额外目录-${index}`}))));
    const complete=await request('/export');assert.equal(complete.profiles.length,300);assert.equal((await request('/import','POST',complete)).imported,300);
    assert.deepEqual(await request('/export?offset=300&limit=300'),complete);
    const selected=await request('/export?'+new URLSearchParams({q:'HTTP目录-',offset:100,limit:100}));assert.equal(selected.profiles.length,100);assert.ok(selected.profiles.every(p=>p.name.startsWith('HTTP目录-')));
    const tooLarge=bundle(Array.from({length:20},()=>({...custom(),visual_rules:Array.from({length:24},(_,i)=>i+'界'.repeat(1197)),audio_rules:Array.from({length:24},(_,i)=>i+'界'.repeat(1197)),review_criteria:Array.from({length:24},(_,i)=>i+'界'.repeat(1197))})));
    const rejected=await fetch(base+'/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(tooLarge)});
    assert.equal(rejected.status,413);const rejectedBody=await rejected.json();assert.equal(rejectedBody.error.code,'SUPERVISOR_BUNDLE_TOO_LARGE');assert.equal((await request('')).total,600);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test('ordinary tasks suggest, auto and unattended select, explicit off overrides and reuse freezes choice',()=>{
  const ordinary=service.beginWork({idempotency_key:'ordinary',user_goal:'鬼畜'}).session;
  assert.equal(ordinary.supervisor.mode,'suggested');assert.equal(ordinary.supervisor.active,false);
  assert.equal(ordinary.supervisor.recommendation.alternatives.length,2);
  const auto=service.createSession({idempotency_key:'auto',user_goal:'鬼畜',mode:'auto'}).session;
  assert.equal(auto.supervisor.active,true);assert.match(auto.supervisor.prompt_context,/小乐子/);
  db.exec('CREATE TABLE global_settings (key TEXT PRIMARY KEY,value TEXT,updated_at TEXT)');
  prefs.set(db,{unattended_mode:true});
  assert.equal(service.createSession({user_goal:'旅行'}).session.supervisor.active,true);
  assert.equal(service.createSession({user_goal:'旅行',supervisor:{mode:'off'}}).session.supervisor.active,false);
  const reused=service.createSession({idempotency_key:'ordinary',user_goal:'电商',supervisor:{mode:'manual',supervisor_id:'builtin-brand'}});
  assert.equal(reused.reused,true);assert.equal(reused.session.supervisor.mode,'suggested');
  assert.equal(service.getBundle(auto.id).session.supervisor.profile.id,'builtin-mischief');
});

test('task snapshot survives catalog edits/deletion, source-context updates and explicit switches',()=>{
  const session=service.createSession({user_goal:'鬼畜',mode:'auto'}).session;
  supervisors.update('builtin-mischief',{name:'新版小乐子',expected_revision:1});
  assert.equal(service.getBundle(session.id).session.supervisor.profile.name,'小乐子');
  supervisors.remove('builtin-mischief',{expected_revision:2});
  service.updateSession(session.id,{source_context:{note:'later'}});
  assert.equal(service.getBundle(session.id).session.supervisor.profile.name,'小乐子');
  const next=supervisors.choose(session.id,{mode:'manual',supervisor_id:'builtin-comedy',expected_revision:1,reason:'增加喜剧停顿'});
  assert.equal(next.profile.name,'小喜剧');assert.equal(next.revision,2);
  assert.throws(()=>supervisors.choose(session.id,{mode:'off',expected_revision:1}),{code:'SUPERVISOR_REVISION_CONFLICT'});
  const off=supervisors.choose(session.id,{mode:'off',expected_revision:2});assert.equal(off.prompt_context,'');assert.equal(off.active,false);
  assert.equal(supervisors.history(session.id).items[0].profile.name,'小乐子');
  assert.equal(service.exportSession(session.id).supervisor_history.length,3);
});

test('invalid explicit selection cannot leave a half-created task',()=>{
  assert.throws(()=>service.createSession({idempotency_key:'bad',user_goal:'A clip',supervisor:{mode:'manual',supervisor_id:'missing'}}),{code:'SUPERVISOR_NOT_FOUND'});
  assert.equal(service.listSessions().items.length,0);
  const long=service.createSession({user_goal:'很长的需求'.repeat(5000)}).session;assert.ok(long.id);
});

test('review opinions require evidence, preserve attribution, reject blocking passes and reconcile same keys',()=>{
  const {id}=service.createSession({user_goal:'MAD',mode:'auto'}).session;
  const review={request_key:'v1',selection_revision:1,stage:'rough_cut',outcome:'passed',summary:'节奏和反转成立',reviewer:'codex-self-review',evidence_refs:[],findings:[]};
  assert.throws(()=>supervisors.recordReview(id,review),{code:'SUPERVISOR_REVIEW_EVIDENCE'});
  review.evidence_refs=['/local/actual-review.md'];
  assert.throws(()=>supervisors.recordReview(id,{...review,findings:[{timecode:'00:03',severity:'blocking',issue:'黑帧',change:'补回源帧'}]}),{code:'SUPERVISOR_REVIEW_INVALID'});
  const first=supervisors.recordReview(id,review);assert.equal(first.attribution,'reported_review');assert.equal(first.reused,false);
  assert.equal(supervisors.recordReview(id,review).reused,true);
  assert.throws(()=>supervisors.recordReview(id,{...review,summary:'changed'}),{code:'SUPERVISOR_REVISION_CONFLICT'});
  supervisors.choose(id,{mode:'off',expected_revision:1});
  assert.equal(supervisors.recordReview(id,review).id,first.id);
  assert.equal(service.exportSession(id).supervisor_reviews.length,1);
  assert.notEqual(service.getBundle(id).session.status,'succeeded');
});

test('disk restore retains user edits, deleted builtins, snapshots and opinions',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-supervisor-')),file=path.join(dir,'test.sqlite');
  let local=new Database(file);
  try {
    let orchestration=createOrchestrationService(local),profiles=createStyleSupervisors(local);
    const session=orchestration.createSession({user_goal:'MAD',mode:'auto'}).session;
    profiles.update('builtin-mischief',{name:'改过的目录',expected_revision:1});profiles.remove('builtin-premium',{expected_revision:1});local.close();
    local=new Database(file);orchestration=createOrchestrationService(local);profiles=createStyleSupervisors(local);
    assert.equal(profiles.get('builtin-mischief').name,'改过的目录');assert.equal(profiles.get('builtin-premium'),null);
    assert.equal(orchestration.getBundle(session.id).session.supervisor.profile.name,'小乐子');
  } finally {local.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('real HTTP, MCP and CLI expose catalog, task prompt and revision conflicts with no provider calls',async()=>{
  const app=express();app.use(express.json({limit:'600kb'}));app.use('/api/v1',supervisorRoutes(db));
  app.get('/health',(req,res)=>res.json({status:'ok'}));
  app.get('/api/v1/runtime-identity',(req,res)=>res.json({success:true,data:{schema:'yinzi.workflow-runtime-identity/v1',orchestration_router:true,source_revision:'supervisor-test',database:{fingerprint:'isolated-memory'}}}));
  app.post('/api/v1/orchestration-sessions/__codex_capability_probe__/nodes/__probe__/actions/start',(req,res)=>res.status(404).json({success:false,error:{code:'ORCHESTRATION_NOT_FOUND'}}));
  const {id}=service.createSession({user_goal:'鬼畜',mode:'auto'}).session;
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const child=spawn(process.execPath,[path.join(plugin,'mcp/server.mjs')],{env:{...process.env,YINZI_WORKFLOW_URL:base},stdio:['pipe','pipe','pipe'],windowsHide:true});
  let requestId=0;const pending=new Map();const lines=readline.createInterface({input:child.stdout});
  lines.on('line',line=>{const result=JSON.parse(line);pending.get(result.id)?.(result);});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const n=++requestId,timer=setTimeout(()=>{pending.delete(n);reject(new Error('MCP timeout'));},10000);pending.set(n,result=>{clearTimeout(timer);pending.delete(n);resolve(result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method,params})+'\n');});
  try {
    const list=await fetch(`${base}/api/v1/media-supervisors`).then(r=>r.json());assert.equal(list.data.items.length,20);
    const conflict=await fetch(`${base}/api/v1/media-supervisors/builtin-mischief`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({name:'stale',expected_revision:0})});assert.equal(conflict.status,409);
    const missing=await fetch(`${base}/api/v1/orchestration-sessions/missing/supervisor`);assert.equal(missing.status,404);
    const listed=(await rpc('tools/list',{})).result.tools;assert.ok(listed.some(t=>t.name==='task_supervisor'));assert.ok(listed.find(t=>t.name==='begin_media_task').inputSchema.properties.supervisor);
    const reply=await rpc('tools/call',{name:'task_supervisor',arguments:{action:'get',session_id:id}});
    assert.equal(reply.result.isError,false,JSON.stringify(reply));const result=JSON.parse(reply.result.content[0].text);assert.match(result.selection.prompt_context,/原声/);
    const selected=await rpc('tools/call',{name:'task_supervisor',arguments:{action:'select',session_id:id,input:{mode:'off',expected_revision:1}}});assert.equal(JSON.parse(selected.result.content[0].text).active,false);
    supervisors.importProfiles({schema_version:1,kind:'yinzi-style-supervisors',profiles:Array.from({length:3081},()=>custom())});
    const largeExport=await rpc('tools/call',{name:'style_supervisors',arguments:{action:'export'}});
    assert.equal(largeExport.result.isError,false);assert.equal(JSON.parse(largeExport.result.content[0].text).profiles.length,3101,'MCP sanitizer must not silently truncate a valid portable bundle');
    const cli=spawn(process.execPath,[path.join(plugin,'skills/codex-yinzi-universal-video/scripts/orchestration-cli.mjs'),'task-supervisor',id],{env:{...process.env,YINZI_WORKFLOW_URL:base},windowsHide:true});
    let output='',stderr='';cli.stdout.on('data',chunk=>output+=chunk);cli.stderr.on('data',chunk=>stderr+=chunk);
    const code=await new Promise(resolve=>cli.on('exit',resolve));assert.equal(code,0,stderr);assert.equal(JSON.parse(output).selection.mode,'off');
  } finally {child.stdin.end();child.kill();lines.close();await new Promise(resolve=>server.close(resolve));}
});
