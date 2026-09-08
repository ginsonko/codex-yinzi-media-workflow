const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const Database=require('better-sqlite3');
const {createOrchestrationService}=require('../src/services/orchestrationService');
const {createLocalMediaJobs}=require('../src/services/localMediaJobs');
const {runMigrationsAndEnsure}=require('../src/db/migrate');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'yinzi-job-test-'));const db=new Database(':memory:');const log=console.log;console.log=()=>{};try{runMigrationsAndEnsure(db);}finally{console.log=log;}const service=createOrchestrationService(db);const id=service.createSession({user_goal:'本地媒体处理验收',idempotency_key:'local-test'}).session.id;const input=path.join(root,'input.png');fs.writeFileSync(input,'fixture');return{root,db,service,id,input};}
test('local jobs are idempotent, persist progress and register real outputs',async()=>{
 const {root,db,service,id,input}=fixture();let runs=0;
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async(req,options)=>{runs++;options.onProgress({stage:'download',bytes:20,total_bytes:40});options.onProgress({stage:'executing'});fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.png');fs.writeFileSync(output,'actual result');return{output_path:output,bytes:13,output_sha256:'abc',status:'succeeded'};}});
 const body={session_id:id,request_key:'one',module_id:'local.image.resize',input_path:input};const first=jobs.create(body),second=jobs.create(body);assert.equal(first.id,second.id);
 assert.throws(()=>jobs.create({...body,request_key:'bad',parameters:'width=80'}),/结构化对象/);
 assert.throws(()=>jobs.create({...body,request_key:'bad-size',parameters:{width:-1}}),/width/);
 assert.throws(()=>jobs.create({...body,parameters:{width:80}}),/请求键/);
 await new Promise(setImmediate);await jobs.waitForIdle();const done=jobs.get(first.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(runs,1);assert.ok(done.result.url.startsWith('/static/'));assert.ok(service.listArtifacts(id).length);assert.ok(done.events.some(e=>e.stage==='download'));
 assert.equal(jobs.resume(first.id).reused,true);await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});
test('replacing a source at the same path cannot reuse an old result',async()=>{
 const {root,db,service,id,input}=fixture();const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async()=>{throw Error('fixture');}});
 const body={session_id:id,request_key:'source',module_id:'local.image.resize',input_path:input};jobs.create(body);fs.writeFileSync(input,'replacement source');assert.throws(()=>jobs.create(body),/素材或参数已变化/);
 await jobs.waitForIdle();await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});
test('temporary download failure automatically resumes the same job',async()=>{
 const {root,db,service,id,input}=fixture();let attempts=0;
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{retryDelayMs:1,execute:async(req,options)=>{if(++attempts===1)throw Object.assign(Error('connection interrupted'),{code:'INCOMPLETE_DOWNLOAD'});fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.png');fs.writeFileSync(output,'recovered');return{output_path:output,bytes:9,output_sha256:'abc',status:'succeeded'};}});
 const job=jobs.create({session_id:id,request_key:'automatic',module_id:'local.image.resize',input_path:input});await jobs.waitForIdle();const done=jobs.get(job.id);assert.equal(done.status,'succeeded');assert.equal(done.attempt,2);assert.ok(done.events.some(e=>e.stage==='retry_wait'));assert.equal(jobs.list(id).length,1);await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});
test('failed local jobs recover in place without another logical job',async()=>{
 const {root,db,service,id,input}=fixture();let attempts=0;
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async(req,options)=>{if(++attempts===1)throw Error('download interrupted');fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.png');fs.writeFileSync(output,'recovered');return{output_path:output,bytes:9,output_sha256:'abc',status:'succeeded'};}});
 const job=jobs.create({session_id:id,request_key:'resume',module_id:'local.image.resize',input_path:input});await new Promise(setImmediate);await jobs.waitForIdle();assert.equal(jobs.get(job.id).status,'failed');jobs.resume(job.id);await new Promise(setImmediate);await jobs.waitForIdle();assert.equal(jobs.get(job.id).status,'succeeded');assert.equal(jobs.get(job.id).attempt,2);assert.equal(jobs.list(id).length,1);await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});
