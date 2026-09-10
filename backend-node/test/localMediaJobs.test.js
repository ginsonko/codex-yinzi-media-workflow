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
 assert.equal(service.getBundle(id).session.status,'running');
 assert.throws(()=>jobs.create({...body,request_key:'bad',parameters:'width=80'}),/结构化对象/);
 assert.throws(()=>jobs.create({...body,request_key:'bad-size',parameters:{width:-1}}),/width/);
 assert.throws(()=>jobs.create({...body,request_key:'fractional-size',parameters:{height:32.5}}),/height/);
 assert.throws(()=>jobs.create({...body,parameters:{width:80}}),/请求键/);
 await new Promise(setImmediate);await jobs.waitForIdle();const done=jobs.get(first.id);assert.equal(done.status,'succeeded',JSON.stringify(done.error));assert.equal(runs,1);assert.ok(done.result.url.startsWith('/static/'));assert.ok(service.listArtifacts(id).length);assert.ok(done.events.some(e=>e.stage==='download'));
 assert.equal(done.result.artifact.bundle,undefined);assert.equal(done.result.artifact.artifact.artifact_id,'local-media:'+first.id);
 assert.equal(service.getBundle(id).session.status,'succeeded');
 assert.equal(service.completeSession(id).bundle.session.status,'succeeded');
 assert.equal(service.completeSession(id).reused,true);
 assert.equal(jobs.resume(first.id).reused,true);await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});
test('replacing a source at the same path cannot reuse an old result',async()=>{
 const {root,db,service,id,input}=fixture();const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async()=>{throw Error('fixture');}});
 const body={session_id:id,request_key:'source',module_id:'local.image.resize',input_path:input};jobs.create(body);fs.writeFileSync(input,'replacement source');assert.throws(()=>jobs.create(body),/素材或参数已变化/);
 await jobs.waitForIdle();await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});

test('multiple tool outputs are hashed and registered, while escaped paths are rejected',async()=>{
 const {root,db,service,id,input}=fixture();
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async(req,options)=>{
  fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.json');fs.writeFileSync(output,'{}');fs.writeFileSync(path.join(options.outputDir,'frame.png'),'frame');
  return{output_path:output,bytes:2,output_sha256:'hash',details:{quality_status:'review_required',assets:[{file:req.parameters.escape?input:'frame.png',type:'image',role:'source_frame',title:'K001'}]}};
 }});
 try{
  const job=jobs.create({session_id:id,request_key:'multi',module_id:'local.video.reverse-prepare',input_path:input});await jobs.waitForIdle();
  assert.equal(jobs.get(job.id).status,'succeeded');assert.equal(jobs.get(job.id).result.attachments.length,1);assert.equal(service.listArtifacts(id).length,2);
  assert.match(jobs.get(job.id).result.attachments[0].sha256,/^[0-9a-f]{64}$/);
  const bad=jobs.create({session_id:id,request_key:'escape',module_id:'local.video.reverse-prepare',input_path:input,parameters:{escape:true}});await jobs.waitForIdle();
  assert.equal(jobs.get(bad.id).error.code,'OUTPUT_PATH_INVALID');assert.equal(service.listArtifacts(id).length,2);
 }finally{await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('successful OCR execution does not claim the transcription was quality approved',async()=>{
 const {root,db,service,id,input}=fixture();
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async(req,options)=>{
  fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.txt');fs.writeFileSync(output,'recognized text');
  return{output_path:output,bytes:15,output_sha256:'abc',status:'succeeded',details:{quality_status:'review_required'}};
 }});
 try{
  const job=jobs.create({session_id:id,request_key:'ocr-review',module_id:'local.image.ocr',input_path:input});
  await jobs.waitForIdle();const done=jobs.get(job.id),artifact=service.listArtifacts(id)[0];
  assert.equal(done.status,'succeeded');assert.equal(artifact.type,'document');assert.equal(artifact.status,'review_required');
  assert.equal(artifact.validation.status,'review_required');assert.equal(artifact.validation.technical_status,'passed');
  const completed=service.completeSession(id);assert.equal(completed.bundle.session.status,'succeeded');
  assert.equal(completed.bundle.artifacts[0].status,'review_required');
 }finally{await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('completion observes direct jobs in flight, failed history and later work',async()=>{
 const {root,db,service,id,input}=fixture();let release,started;
 const ready=new Promise(resolve=>{started=resolve;});
 const pending=new Promise(resolve=>{release=resolve;});
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async(req,options)=>{
  if(req.parameters.width===99)throw Error('actual operation failed');
  started();await pending;
  fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.png');fs.writeFileSync(output,'result');
  return{output_path:output,bytes:6,output_sha256:'hash',status:'succeeded'};
 }});
 try{
  assert.throws(()=>service.completeSession(id),{code:'COMPLETION_NO_EXECUTED_WORK'});
  const failed=jobs.create({session_id:id,request_key:'failed',module_id:'local.image.resize',input_path:input,parameters:{width:99}});
  assert.throws(()=>service.completeSession(id),error=>error.code==='COMPLETION_UNFINISHED_NODES'&&error.details.unfinished_local_jobs[0].id===failed.id);
  await jobs.waitForIdle();assert.equal(service.completeSession(id).bundle.session.status,'failed');
  const next=jobs.create({session_id:id,request_key:'new-result',module_id:'local.image.resize',input_path:input});
  assert.equal(service.getBundle(id).session.status,'running');assert.equal(service.getBundle(id).session.completed_at,null);
  await ready;
  assert.throws(()=>service.completeSession(id),error=>error.details.unfinished_local_jobs.some(job=>job.id===next.id&&job.status==='running'));
  release();await jobs.waitForIdle();
  assert.equal(service.getBundle(id).session.status,'partial');
  const completed=service.completeSession(id);assert.equal(completed.reused,false);assert.equal(completed.bundle.session.status,'partial');
  assert.equal(service.completeSession(id).reused,true);assert.equal(jobs.get(failed.id).status,'failed');
  assert.equal(service.listEvents(id).filter(event=>event.event_type==='session.completed').length,2);
 }finally{release();await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('direct job status synchronization preserves an explicit pause',async()=>{
 const {root,db,service,id,input}=fixture();
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async()=>{throw Error('failure while background job is finishing');}});
 try{
  jobs.create({session_id:id,request_key:'pause',module_id:'local.image.resize',input_path:input});
  service.pauseSession(id,{reason:'User paused subsequent steps'});
  await jobs.waitForIdle();assert.equal(service.getBundle(id).session.status,'paused');
  assert.equal(jobs.list(id)[0].status,'failed');
 }finally{await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('temporary download failure automatically resumes the same job',async()=>{
 const {root,db,service,id,input}=fixture();let attempts=0;
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{retryDelayMs:1,execute:async(req,options)=>{if(++attempts===1)throw Object.assign(Error('connection interrupted'),{code:'INCOMPLETE_DOWNLOAD'});fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.png');fs.writeFileSync(output,'recovered');return{output_path:output,bytes:9,output_sha256:'abc',status:'succeeded'};}});
 const job=jobs.create({session_id:id,request_key:'automatic',module_id:'local.image.resize',input_path:input});await jobs.waitForIdle();const done=jobs.get(job.id);assert.equal(done.status,'succeeded');assert.equal(done.attempt,2);assert.ok(done.events.some(e=>e.stage==='retry_wait'));assert.equal(jobs.list(id).length,1);await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});

test('GPU operations serialize while an ordinary image operation can advance',async()=>{
 const {root,db,service,id,input}=fixture();let activeGpu=0,peakGpu=0,cpuAlongsideGpu=false;
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async(req,options)=>{
  const gpu=req.module_id==='local.image.realesrgan';
  if(gpu){activeGpu++;peakGpu=Math.max(peakGpu,activeGpu);}else cpuAlongsideGpu=activeGpu>0;
  await new Promise(resolve=>setTimeout(resolve,30));
  fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.png');fs.writeFileSync(output,'fixture');
  if(gpu)activeGpu--;
  return{output_path:output,bytes:7,output_sha256:'abc',status:'succeeded'};
 }});
 try{
  for(const key of ['gpu1','gpu2','gpu3'])jobs.create({session_id:id,request_key:key,module_id:'local.image.realesrgan',input_path:input});
  jobs.create({session_id:id,request_key:'cpu',module_id:'local.image.resize',input_path:input});
  await jobs.waitForIdle();assert.equal(peakGpu,1);assert.ok(jobs.list(id).every(job=>job.status==='succeeded'));
  if(require('../src/services/componentRuntime').machineProfile().recommended_concurrency>1)assert.equal(cpuAlongsideGpu,true);
 }finally{await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});}
});
test('failed local jobs recover in place without another logical job',async()=>{
 const {root,db,service,id,input}=fixture();let attempts=0;
 const jobs=createLocalMediaJobs(db,{storage:{local_path:root}},service,{execute:async(req,options)=>{if(++attempts===1)throw Error('download interrupted');fs.mkdirSync(options.outputDir,{recursive:true});const output=path.join(options.outputDir,'result.png');fs.writeFileSync(output,'recovered');return{output_path:output,bytes:9,output_sha256:'abc',status:'succeeded'};}});
 const job=jobs.create({session_id:id,request_key:'resume',module_id:'local.image.resize',input_path:input});await new Promise(setImmediate);await jobs.waitForIdle();assert.equal(jobs.get(job.id).status,'failed');jobs.resume(job.id);await new Promise(setImmediate);await jobs.waitForIdle();assert.equal(jobs.get(job.id).status,'succeeded');assert.equal(jobs.get(job.id).attempt,2);assert.equal(jobs.list(id).length,1);await jobs.close();db.close();fs.rmSync(root,{recursive:true,force:true});
});
