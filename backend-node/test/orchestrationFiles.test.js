const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { EventEmitter } = require('events');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createOrchestrationService } = require('../src/services/orchestrationService');
const routesFactory = require('../src/routes/orchestration');
const { openWorkDirectory } = require('../src/services/orchestrationFiles');

test('activity publishes local previews atomically, resumes idempotently and keeps review separate', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-artifacts-'));
  const db = new Database(':memory:');
  t.after(() => { db.close(); fs.rmSync(root, { recursive:true, force:true }); });
  const oldLog = console.log; console.log = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = oldLog; }
  const svc = createOrchestrationService(db);
  const id = svc.beginWork({ idempotency_key:'begin', user_goal:'Preview while editing', work_dir:root }).session.id;
  const file = path.join(root, 'preview.mp4'); fs.writeFileSync(file, 'a real file of bytes');
  const report = { event_idempotency_key:'preview-1', stage:'preview', message:'First preview', next_action:'Refine edges', response_detail:'summary', artifacts:[{artifact_id:'cut-v1',type:'video',title:'Cut v1',path:file}] };
  const first = svc.reportActivity(id, report);
  assert.equal(first.artifacts[0].status, 'review_required');
  assert.equal(first.workspace.path, root);
  assert.equal(first.session.status, 'draft');
  assert.match(first.artifacts[0].url, /\/artifacts\/cut-v1\/file$/);
  const replay = svc.reportActivity(id, report);
  assert.equal(replay.reused, true);
  assert.equal(svc.listArtifacts(id).length, 1);
  assert.equal(svc.listEvents(id).filter(e => e.event_type === 'artifact.registered').length, 1);
  const before = svc.getBundle(id);
  assert.throws(() => svc.reportActivity(id,{...report,event_idempotency_key:'bad',artifacts:[{...report.artifacts[0],artifact_id:'valid'}, {artifact_id:'bad',path:path.join(root,'absent.mp4')}] }), { code:'ARTIFACT_FILE_MISSING' });
  assert.equal(svc.listArtifacts(id).length, 1);
  assert.equal(svc.getBundle(id).session.version, before.session.version);
  assert.equal(svc.listEvents(id).length, before.events.length);
  for (const item of [null,{}, {artifact_id:'no-file',type:'video',title:'Missing source'}]) {
    assert.throws(()=>svc.reportActivity(id,{...report,event_idempotency_key:'invalid-source',artifacts:[item]}),{code:'ACTIVITY_ARTIFACT_SOURCE_REQUIRED'});
  }
  assert.equal(svc.listEvents(id).length,before.events.length);
  const app = express(); const routes = routesFactory(db, {error(){}}, {}, {});
  app.use(express.json());
  app.get('/api/v1/orchestration-sessions/:id/artifacts/:artifactId/file',routes.artifactFile);
  app.post('/api/v1/orchestration-sessions/:id/activity',routes.reportActivity);
  app.post('/api/v1/orchestration-sessions/:id/artifacts',routes.registerArtifact);
  const server = await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}${first.artifacts[0].url}`;
  const range=await fetch(url,{headers:{range:'bytes=0-3'}});
  assert.equal(range.status,206); assert.equal(await range.text(),'a re');
  const hostileHeaders={origin:'https://untrusted.example','content-type':'application/json'};
  const denied=await fetch(url,{headers:hostileHeaders});
  assert.equal(denied.status,400); assert.equal((await denied.json()).error.code,'LOCAL_ONLY');
  const api=url.slice(0,url.indexOf('/artifacts/'));
  const blockedReport=await fetch(api+'/activity',{method:'POST',headers:hostileHeaders,body:JSON.stringify({...report,event_idempotency_key:'hostile-report'})});
  assert.equal(blockedReport.status,400); assert.equal((await blockedReport.json()).error.code,'LOCAL_ONLY');
  const blockedForgery=await fetch(api+'/artifacts',{method:'POST',headers:hostileHeaders,body:JSON.stringify({...svc.listArtifacts(id)[0],artifact_id:'forged'})});
  assert.equal(blockedForgery.status,400); assert.equal((await blockedForgery.json()).error.code,'LOCAL_ONLY');
  const noCors=await fetch(url,{headers:{'sec-fetch-site':'cross-site'}});
  assert.equal(noCors.status,400);
  assert.equal((await fetch(url,{headers:{origin:`http://localhost:${server.address().port}`}})).status,200);
  let destroyed=false;
  routes.artifactFile({params:{id,artifactId:'cut-v1'},headers:{},socket:{remoteAddress:'127.0.0.1'}}, {
    headersSent:true,setHeader(){},sendFile(file,callback){callback(new Error('EIO'));},destroy(){destroyed=true;},
  });
  assert.equal(destroyed,true);
  fs.writeFileSync(file,'changed content');
  assert.throws(()=>svc.reportActivity(id,{...report,event_idempotency_key:'changed-same-id'}),{code:'ARTIFACT_VERSION_CONFLICT'});
  assert.equal(svc.reportActivity(id,report).reused,true);
  assert.equal((await fetch(url)).status,400);
  const missing=await fetch(url.replace('cut-v1','not-registered'));
  assert.equal(missing.status,404);
  svc.updateSession(id,{status:'succeeded'});
  const next=svc.reportActivity(id,{...report,event_idempotency_key:'v2',artifacts:[{...report.artifacts[0],artifact_id:'cut-v2'}]});
  assert.equal(next.session.status,'succeeded');
  assert.equal(svc.getBundle(id).artifacts.length,2);
});

test('directory opening uses only saved path, never shell interpolation, and rejects remote origins', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-folder-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  let call;
  const launch=(command,args,options)=>{call={command,args,options};const child=new EventEmitter();child.unref=()=>{};process.nextTick(()=>child.emit('spawn'));return child;};
  const source={work_dir:root};
  assert.throws(()=>openWorkDirectory({socket:{remoteAddress:'10.0.0.1'},headers:{}},source,launch),{code:'LOCAL_ONLY'});
  assert.throws(()=>openWorkDirectory({socket:{remoteAddress:'127.0.0.1'},headers:{origin:'https://attacker.example'}},source,launch),{code:'LOCAL_ONLY'});
  assert.throws(()=>openWorkDirectory({socket:{remoteAddress:'127.0.0.1'},headers:{host:'attacker.example'}},source,launch),{code:'LOCAL_ONLY'});
  const opened=await openWorkDirectory({socket:{remoteAddress:'127.0.0.1'},headers:{origin:'http://localhost:5679'},body:{path:'/ignored'}},source,launch);
  assert.equal(opened.path,root); assert.deepEqual(call.args,[root]); assert.equal(call.options.shell,false);
});
