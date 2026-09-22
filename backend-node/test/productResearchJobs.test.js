'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const express=require('express');
const {createResearchJobs}=require('../src/services/productResearchJobs');
const {buildCreative}=require('../src/services/productResearchCreative');
const row=(id='d1',platform='douyin')=>({id,platform,url:`https://www.${platform==='douyin'?'douyin.com/video/':'bilibili.com/video/'}${id}`,title:'针织毛衣试穿',published_at:'2026-09-20',observed_at:'2026-09-21T12:00:00Z',metrics:{likes:100,comments:10},evidence:{kind:'platform_page'},analysis_basis:'metadata_only'});
function setup(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-jobs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return createResearchJobs({root,sessionManager:{},ensureComponent:()=>{throw Error('unexpected install');},...options});}
const input=(extra={})=>({request_key:'test-key',mode:'import',query:{product:'针织毛衣',platforms:['douyin']},items:[row()],...extra});
async function ready(service,body=input()){const {job}=service.create(body);await service.settle(job.id);return service.get(job.id);}
function deliver(ctx,items,status='collected',blocked=null){const collection={status,blocked_status:blocked,attempts:[],warnings:[]};fs.writeFileSync(ctx.outputPath,JSON.stringify({items,collection}));return {collection};}

test('full sample pagination reaches rows outside shortlist and freezes report revisions',async t=>{
  const s=setup(t),j=await ready(s,input({items:Array.from({length:125},(_,i)=>row('video'+i))}));
  const first=s.records(j.id,{limit:100}),last=s.records(j.id,{offset:first.next_offset,limit:100});
  assert.equal(first.total,125);assert.equal(first.items.length,100);assert.equal(last.items.length,25);assert.equal(last.next_offset,null);
  const selected=last.items.at(-1).id;s.update(j.id,{selected_ids:[selected]});
  assert.deepEqual(s.get(j.id).selected_ids,[selected]);assert.equal(s.records(j.id,{v:1}).report_revision,1);
  assert.throws(()=>s.records(j.id,{offset:-1}),{code:'INVALID_PAGE'});assert.throws(()=>s.records(j.id,{limit:101}),{code:'INVALID_PAGE'});
  assert.throws(()=>s.records(j.id,{v:999}),{code:'RESEARCH_NOT_FOUND'});
});
test('offline ZIP contains only fixed public artifacts and selected snapshot',async t=>{
  const s=setup(t),j=await ready(s);fs.writeFileSync(path.join(s.root,j.id,'private-token.txt'),'PRIVATE');
  s.update(j.id,{product_facts:['真实商品资料']});
  const zip=new (require('adm-zip'))(s.download(j.id,1));
  assert.deepEqual(zip.getEntries().map(e=>e.entryName).sort(),['README.txt','creative-brief.json','references.csv','references.md','report.html','result.json','video-plan.md'].sort());
  assert.ok(!zip.readAsText('creative-brief.json').includes('真实商品资料'));
  assert.ok(s.get(j.id).download_url.endsWith('?v=2'));assert.match(s.get(j.id).url,/research=/);
});

test('import builds source-backed report, editable directions, and stable replay without external requests',async t=>{
  const s=setup(t,{collect:()=>{throw Error('must not collect');}}), j=await ready(s);
  assert.equal(j.state,'completed');assert.equal(j.summary.total_items,1);assert.equal(j.summary.candidates_count,1);
  assert.equal(s.create(input()).reused,true);assert.equal(s.list().length,1);
  assert.throws(()=>s.create(input({query:{product:'鞋',platforms:['douyin']}})),{code:'REQUEST_KEY_CONFLICT'});
  for(const name of ['report.html','references.csv','result.json','creative-brief.json','video-plan.md'])assert.ok(fs.statSync(s.artifact(j.id,name)).size>10);
  const b=JSON.parse(fs.readFileSync(s.artifact(j.id,'creative-brief.json')));
  assert.equal(b.paid_generation_started,false);assert.ok(b.selected_sources[0].watch_required);
  assert.ok(b.directions.every(d=>d.origin==='editable_filming_framework'));
  assert.throws(()=>s.artifact(j.id,'../../job.json'),{code:'RESEARCH_NOT_FOUND'});
  assert.throws(()=>s.get('../no'),{code:'RESEARCH_NOT_FOUND'});
});
test('partial sources survive verification, resume collects only unresolved platforms',async t=>{
  const calls=[];let verified=false;
  const s=setup(t,{collect:async(ctx,p)=>{calls.push(p);return p==='douyin'&&!verified?deliver(ctx,[],'verification_required','verification_required'):deliver(ctx,[row(p,p)]);}});
  let j=await ready(s,input({mode:'collect',items:[],query:{product:'毛衣',platforms:['bilibili','douyin']}}));
  assert.equal(j.state,'needs_action');assert.equal(j.summary.total_items,1);
  verified=true;s.resume(j.id);await s.settle(j.id);j=s.get(j.id);
  assert.deepEqual(calls,['bilibili','douyin','douyin']);assert.equal(j.state,'completed');assert.equal(j.summary.total_items,2);
  assert.equal(j.platforms[1].attempts.length,2);
});
test('cancel retains late result but starts no further platform; active replay stays single',async t=>{
  let unblock,entered;const started=new Promise(resolve=>entered=resolve);const calls=[];
  const s=setup(t,{collect:async(ctx,p)=>{calls.push(p);entered();await new Promise(resolve=>unblock=resolve);return deliver(ctx,[row('one',p)]);}});
  const body=input({mode:'collect',items:[],query:{product:'毛衣',platforms:['douyin','bilibili']}});
  const {job}=s.create(body);await started;
  assert.equal(s.create(body).reused,true);assert.equal(s.resume(job.id).active,true);
  assert.throws(()=>s.update(job.id,{product_facts:['针织']}),{code:'RESEARCH_BUSY'});
  s.cancel(job.id);unblock();await s.settle(job.id);
  assert.equal(s.get(job.id).state,'cancelled');assert.equal(s.get(job.id).summary.total_items,1);assert.deepEqual(calls,['douyin']);
});
test('failed collection is bounded, secrets redacted, explicit retry can recover',async t=>{
  let fail=true;const s=setup(t,{collect:async(ctx)=>{if(fail)throw Object.assign(Error('failure sk-testsecret Bearer secret'),{code:'NETWORK_ERROR'});return deliver(ctx,[row()]);}});
  let j=await ready(s,input({mode:'collect',items:[]}));assert.equal(j.state,'empty');assert.equal(j.platforms[0].error.code,'NETWORK_ERROR');assert.ok(!j.platforms[0].error.message.includes('testsecret'));
  fail=false;s.resume(j.id);await s.settle(j.id);assert.equal(s.get(j.id).state,'completed');
});
test('dead runner becomes interrupted, keeps report and permits recovery after restart',async t=>{
  const s=setup(t),j=await ready(s),p=path.join(s.root,j.id,'job.json');const stored=JSON.parse(fs.readFileSync(p));
  stored.state='running';stored.owner_pid=99999999;fs.writeFileSync(p,JSON.stringify(stored));fs.writeFileSync(path.join(s.root,j.id,'runner.lock'),JSON.stringify({pid:99999999}));
  const restored=createResearchJobs({root:s.root,sessionManager:{}});
  assert.equal(restored.get(j.id).state,'interrupted');restored.resume(j.id);await restored.settle(j.id);assert.equal(restored.get(j.id).state,'completed');
});
test('generic accepts different platforms; unknown date never becomes a current hit',async t=>{
  const s=setup(t),j=await ready(s,input({query:{product:'毛衣',platforms:['generic']},items:[row(),row('b1','bilibili')]}));assert.equal(j.summary.candidates_count,2);
  const newer=await ready(s,input({request_key:'dates',query:{product:'毛衣',platforms:['douyin'],since:'2026-09-22'}}));assert.equal(newer.summary.candidates_count,0);assert.equal(newer.shortlist.length,0);
  assert.throws(()=>s.create(input({request_key:'bad',mode:'other'})),{code:'INVALID_INPUT'});
  assert.throws(()=>s.create(input({request_key:'bad2',query:{product:'毛衣',platforms:['douyin'],since:'2026-02-30'}})),{code:'INVALID_QUERY_DATE'});
});
test('observed structures require viewing range and original evidence remains retained',async t=>{
  const s=setup(t),j=await ready(s);
  assert.throws(()=>s.update(j.id,{observations:[{id:'d1',analysis_basis:'video_viewed',analysis:{hook:'nice'}}]}),{code:'INVALID_INPUT'});
  const next=s.update(j.id,{selected_ids:['d1'],product_facts:['用户提供：有S/M/L三个尺码'],observations:[{id:'d1',analysis_basis:'user_supplied',analysis:{viewed_range:'00:00–00:08',hook:'试穿对照'}}]});
  const brief=JSON.parse(fs.readFileSync(s.artifact(j.id,'creative-brief.json')));
  assert.equal(next.report_revision,2);assert.equal(brief.observed_patterns[0].viewed_range,'00:00–00:08');assert.equal(brief.selected_sources[0].watch_required,false);
  const markdown=fs.readFileSync(s.artifact(j.id,'video-plan.md'),'utf8');
  assert.ok(markdown.includes('实际观看范围：00:00–00:08'));assert.ok(markdown.includes('开场：试穿对照'));
  assert.ok(fs.existsSync(path.join(s.root,j.id,'reports','1','result.json')));
  assert.equal(JSON.parse(fs.readFileSync(s.artifact(j.id,'creative-brief.json',1))).observed_patterns.length,0);
  const cleared=s.update(j.id,{selected_ids:[]});assert.ok(cleared.shortlist.length);assert.equal(JSON.parse(fs.readFileSync(s.artifact(j.id,'creative-brief.json'))).selected_sources.length,0);
});
test('creation handoff uses existing console and identical revision key on repeated clicks',async t=>{
  const requests=[];const s=setup(t,{createSession:body=>{requests.push(body);return {session:{id:'draft-123'}};}}),j=await ready(s);
  assert.equal(s.handoff(j.id).url,'/codex-console/draft-123');s.handoff(j.id);
  assert.equal(requests[0].idempotency_key,requests[1].idempotency_key);assert.equal(requests[0].source_context.paid_generation_authorized,false);assert.equal(requests[0].source_context.research_job_id,j.id);
  assert.ok(requests[0].user_goal.includes('实际观看'));
});
test('only known observation provenance creates a viewed claim',()=>{
  const r={query:{product:'衣服'},items:[{...row(),analysis_basis:'inferred',analysis:{viewed_range:'all'},metrics:{likes:20}}],groups:{},excluded:[]};
  const b=buildCreative(r,[],['d1']).brief;assert.equal(b.selected_sources[0].watch_required,true);assert.equal(b.observed_patterns.length,0);
});
test('HTTP job and artifact routes enforce local origin, export files and return actionable errors',async t=>{
  const s=setup(t),app=express();app.use(express.json());app.use('/api/v1/research/jobs',require('../src/routes/researchJobs')({service:s}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}/api/v1/research/jobs`;
  assert.equal((await fetch(base,{headers:{Origin:'https://foreign.example'}})).status,403);
  const created=await (await fetch(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input())})).json();await s.settle(created.data.job.id);
  const report=await fetch(base+'/'+created.data.job.id+'/files/report.html');assert.equal(report.status,200);assert.ok(report.headers.get('content-security-policy').includes("connect-src 'none'"));assert.ok((await report.text()).includes('针织毛衣'));
  assert.equal((await fetch(base+'/not-an-id')).status,404);
  assert.equal((await fetch(base+'/'+created.data.job.id+'/files/job.json')).status,404);
});
