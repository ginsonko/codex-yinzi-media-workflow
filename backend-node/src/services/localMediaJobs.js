const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createComponentManager,machineProfile,sha256}=require('./componentRuntime');
const {execute}=require('./localMediaExecutor');
const {getOperation}=require('./localMediaOperations');
const parameterSchemas=require('./localMediaParameterSchemas.json');
const {sanitize}=require('./orchestrationService');
const {createMediaExperiences,redact,summarizeParameters}=require('./mediaExperiences');
const {snapshot:snapshotSources}=require('./localMediaSources');
const connections=new WeakMap();
const stamp=()=>new Date().toISOString();
const fail=(code,message)=>Object.assign(new Error(message),{code});
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
function alive(pid){if(!pid)return false;try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
function createLocalMediaJobs(db,cfg={},orchestration,injected={}){
  if(connections.has(db))return connections.get(db);
  db.exec(`CREATE TABLE IF NOT EXISTS local_media_jobs (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,owner_pid INTEGER,job_json TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(session_id,request_key))`);
  db.exec(`CREATE TABLE IF NOT EXISTS local_media_attempt_receipts (request_key TEXT PRIMARY KEY,job_id TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,receipt_json TEXT NOT NULL)`);
  const storage=path.resolve(cfg.storage?.local_path||'./data/storage');
  const manager=injected.manager||createComponentManager({root:path.resolve(cfg.media_components?.root||path.join(storage,'../media-components'))});
  const running=new Map();let closed=false,retryTimer,experienceRecovery;const limit=machineProfile().recommended_concurrency;
  function remember(job){
    try{
      const key=`local-job:${job.id}:${job.attempt}:${job.status}`,result=job.result||{};
      const snapshot=redact({id:job.id,session_id:job.session_id,attempt:job.attempt,status:job.status,operation_title:job.operation_title,
        request:{module_id:job.request.module_id,parameters:summarizeParameters(redact(job.request.parameters||{})),input_identity:job.request.input_identity,sources:job.request.sources},
        result:{component_id:result.component_id,component_version:result.component_version,components:result.components,input_sha256:result.input_sha256,
          output_sha256:result.output_sha256,output_path:result.output_path,bytes:result.bytes,sources:result.sources,details:{quality_status:result.details?.quality_status}},error:job.error});
      db.prepare('INSERT OR IGNORE INTO local_media_attempt_receipts VALUES (?,?,?,?,?)').run(key,job.id,job.attempt,job.status,JSON.stringify(snapshot));
      const archived=JSON.parse(db.prepare('SELECT receipt_json FROM local_media_attempt_receipts WHERE request_key=?').get(key).receipt_json);
      (injected.experiences||createMediaExperiences(db)).recordJob(archived);
    }
    catch(error){try{(injected.log||console).warn?.('media experience recording deferred',{job_id:job.id,code:error.code||'EXPERIENCE_WRITE_FAILED'});}catch{}}
  }
  const get=id=>{const row=db.prepare('SELECT job_json FROM local_media_jobs WHERE id=?').get(id);return row?JSON.parse(row.job_json):null;};
  const save=db.transaction(job=>{const previous=db.prepare('SELECT status FROM local_media_jobs WHERE id=?').get(job.id);job.updated_at=stamp();db.prepare('UPDATE local_media_jobs SET status=?,owner_pid=?,job_json=?,updated_at=? WHERE id=?').run(job.status,job.owner_pid||null,JSON.stringify(job),job.updated_at,job.id);if(!job.node_id&&previous?.status!==job.status)orchestration?.syncLocalJobStatus(job.session_id);return job;});
  function list(sessionId){return db.prepare('SELECT job_json FROM local_media_jobs WHERE session_id=? ORDER BY updated_at DESC LIMIT 100').all(sessionId).map(row=>JSON.parse(row.job_json));}
  function emit(job,event){
    job.progress=sanitize(event);job.events=[...(job.events||[]),{...job.progress,at:stamp()}].slice(-80);save(job);
    if(orchestration&&job.session_id){
      orchestration.recordEvent(job.session_id,{event_type:'local-media.'+event.stage,actor:'system',node_id:job.node_id||undefined,
        event_idempotency_key:`local:${job.id}:${job.attempt}:${job.events.length}:${job.updated_at}`,payload:{job_id:job.id,...job.progress}});
      if(job.node_id)orchestration.updateNode(job.session_id,job.node_id,{progress:{job_id:job.id,state:event.stage,...job.progress},actor:'system'});
    }
  }
  async function perform(job){
    job.status='running';job.owner_pid=process.pid;job.attempt=(job.attempt||0)+1;save(job);
    try{
      if(job.node_id)orchestration.updateNode(job.session_id,job.node_id,{status:'running',actor:'system'});
      const receipt=await(injected.execute||execute)(job.request,{manager,outputDir:path.join(storage,'local-media/jobs',job.id,'attempt-'+job.attempt),onProgress:event=>emit(job,event)});
      const attachments=[];
      for(const item of receipt.details?.assets||[]){
        const base=fs.realpathSync(path.dirname(receipt.output_path));
        const file=fs.realpathSync(path.resolve(base,item.file));
        if(!file.startsWith(base+path.sep)||!fs.statSync(file).isFile())throw fail('OUTPUT_PATH_INVALID','工具附属成果路径越界');
        const relative=path.relative(storage,file).replaceAll('\\','/');
        attachments.push({...item,path:relative,url:'/static/'+relative.split('/').map(encodeURIComponent).join('/'),bytes:fs.statSync(file).size,sha256:await sha256(file)});
      }
      const relative=path.relative(storage,receipt.output_path).replaceAll('\\','/');
      const url='/static/'+relative.split('/').map(encodeURIComponent).join('/');
      db.transaction(()=>{
      let artifact;
      if(orchestration){const needsReview=receipt.details?.quality_status==='review_required';artifact=orchestration.recordArtifact(job.session_id,{artifact_id:'local-media:'+job.id,node_id:job.node_id||undefined,
        type:getOperation(job.request.module_id).kind,title:getOperation(job.request.module_id).title,path:relative,url,bytes:receipt.bytes,status:needsReview?'review_required':'validated',validation:{status:needsReview?'review_required':'passed',technical_status:'passed',output_sha256:receipt.output_sha256},source_refs:[{type:'local_media_job',id:job.id}]});}
      if(orchestration)for(const item of attachments)orchestration.recordArtifact(job.session_id,{artifact_id:`local-media:${job.id}:${item.file}`,node_id:job.node_id||undefined,type:item.type||'document',title:item.title||item.file,path:item.path,url:item.url,bytes:item.bytes,status:'review_required',validation:{technical_status:'passed',output_sha256:item.sha256,role:item.role},source_refs:[{type:'local_media_job',id:job.id}]});
      // The registration bundle predates node completion; keep only the artifact receipt.
      job.result={...receipt,url,attachments,artifact:artifact?{reused:artifact.reused,artifact:artifact.artifact}:undefined};job.status='succeeded';job.error=null;save(job);
      if(job.node_id)orchestration.updateNode(job.session_id,job.node_id,{status:'succeeded',output_refs:[{type:'artifact',id:'local-media:'+job.id}],actor:'system'});
      emit(job,{stage:'succeeded',message:receipt.details?.quality_status==='review_required'?'处理结果已保存，内容待核对':'成果已保存并验证，可继续下一步'});
      })();
      remember(job);
    }catch(e){
      const transient=['COMPONENT_DOWNLOAD_FAILED','INCOMPLETE_DOWNLOAD','ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN'].includes(e.code)||e.name==='AbortError'||e.name==='TypeError'&&/fetch failed/.test(e.message);
      if(transient&&job.attempt<3){remember({...job,status:'failed',error:{code:e.code||'LOCAL_MEDIA_FAILED',message:sanitize(String(e.message)).slice(-1800)}});job.status='queued';job.next_retry_at=Date.now()+(injected.retryDelayMs??Math.min(30000,3000*job.attempt));save(job);emit(job,{stage:'retry_wait',message:'下载暂时中断，已保留进度，将自动重试并继续原任务',retry_at:new Date(job.next_retry_at).toISOString()});return;}
      job.status='failed';job.error={code:e.code||'LOCAL_MEDIA_FAILED',message:sanitize(String(e.message)).slice(-1800),retryable:true};save(job);emit(job,{stage:'failed',message:job.error.message});
      if(job.node_id){try{orchestration.updateNode(job.session_id,job.node_id,{status:'failed',error:job.error,actor:'system'});}catch{}}
      remember(job);
    }finally{running.delete(job.id);if(!closed)pump();}
  }
  function pump(){if(closed)return;clearTimeout(retryTimer);const available=limit-running.size;if(available<=0)return;
    const pending=db.prepare("SELECT * FROM local_media_jobs WHERE status='queued' ORDER BY updated_at").all();
    const busyGroups=new Set(db.prepare("SELECT job_json FROM local_media_jobs WHERE status='running'").all()
      .map(row=>getOperation(JSON.parse(row.job_json).request.module_id)?.resource_group).filter(Boolean));
    const rows=[];
    for(const row of pending){
      const job=JSON.parse(row.job_json),group=getOperation(job.request.module_id)?.resource_group;
      if((job.next_retry_at||0)>Date.now()||group&&busyGroups.has(group))continue;
      rows.push(row);if(group)busyGroups.add(group);if(rows.length>=available)break;
    }
    for(const row of rows){if(running.has(row.id))continue;const won=db.prepare("UPDATE local_media_jobs SET status='running',owner_pid=? WHERE id=? AND status='queued'").run(process.pid,row.id);if(!won.changes)continue;
      const promise=Promise.resolve().then(()=>perform(JSON.parse(row.job_json)));running.set(row.id,promise);}
    const next=pending.map(row=>JSON.parse(row.job_json).next_retry_at||0).filter(at=>at>Date.now()).sort((a,b)=>a-b)[0];
    if(next)retryTimer=setTimeout(pump,Math.max(1,next-Date.now()));
  }
  function create(body){
    const sessionId=String(body.session_id||''),requestKey=String(body.request_key||'');
    if(!requestKey||requestKey.length>200||!orchestration.getBundle(sessionId))throw fail('LOCAL_JOB_CONTEXT','需要已有任务和稳定请求键');
    const op=getOperation(body.module_id);if(!op)throw fail('MODULE_NOT_EXECUTABLE','该合同尚无已实现的执行器');
    const input=path.resolve(String(body.input_path||''));const stat=fs.statSync(input);if(!stat.isFile()||!stat.size)throw fail('INPUT_MISSING','输入素材不可读取');fs.accessSync(input,fs.constants.R_OK);
    const parameters=body.parameters??{};if(typeof parameters!=='object'||Array.isArray(parameters)||JSON.stringify(parameters).length>16000)throw fail('INVALID_PARAMETERS','参数必须是结构化对象');
    for(const [key,schema] of Object.entries((op.parameter_schema||parameterSchemas[op.id])?.properties||{})){
      if(parameters[key]==null)continue;const value=parameters[key];
      if(['number','integer'].includes(schema.type)&&(!Number.isFinite(Number(value))||Number(value)<schema.minimum||Number(value)>schema.maximum||(schema.type==='integer'&&!Number.isInteger(Number(value)))))throw fail('INVALID_PARAMETERS',`参数 ${key} 应在 ${schema.minimum} 到 ${schema.maximum} 之间${schema.type==='integer'?'且为整数':''}`);
      if(schema.enum&&!schema.enum.includes(value))throw fail('INVALID_PARAMETERS',`参数 ${key} 不支持该选项`);
    }
    if(op.build)op.build(parameters);
    const input_identity={size:stat.size,mtime_ms:stat.mtimeMs,ctime_ms:stat.ctimeMs,ino:stat.ino};
    const legacyRequest={module_id:op.id,input_path:input,input_identity,parameters};
    const sources=snapshotSources({...legacyRequest,sources:body.sources});
    const request={...legacyRequest,sources};const hash=crypto.createHash('sha256').update(JSON.stringify(stable({...request,node_key:body.node_key||null}))).digest('hex');
    return db.transaction(()=>{
      const previous=db.prepare('SELECT id,request_hash FROM local_media_jobs WHERE session_id=? AND request_key=?').get(sessionId,requestKey);
      if(previous){
        const old=get(previous.id);
        const legacyHash=!body.sources&&!old.request.sources?crypto.createHash('sha256').update(JSON.stringify(stable({...legacyRequest,node_key:body.node_key||null}))).digest('hex'):null;
        if(previous.request_hash!==hash&&previous.request_hash!==legacyHash)throw fail('REQUEST_HASH_CONFLICT','同一请求键的素材或参数已变化');return{...old,reused:true};
      }
      let nodeId=null;if(body.node_key){const node=orchestration.getBundle(sessionId).nodes.find(n=>n.node_key===body.node_key||n.id===body.node_key);if(!node||node.module_id!==op.id)throw fail('NODE_MISMATCH','节点与所选操作不匹配');nodeId=node.id;}
      const job={id:crypto.randomUUID(),session_id:sessionId,request_key:requestKey,request_hash:hash,node_id:nodeId,operation_title:op.title,request,status:'queued',attempt:0,created_at:stamp(),updated_at:stamp(),events:[],progress:{stage:'queued',message:'已排队，组件就绪后自动处理'}};
      db.prepare('INSERT INTO local_media_jobs (id,session_id,request_key,request_hash,status,job_json,updated_at) VALUES (?,?,?,?,?,?,?)').run(job.id,sessionId,requestKey,hash,job.status,JSON.stringify(job),job.updated_at);
      if(!nodeId)orchestration.syncLocalJobStatus(sessionId);
      setImmediate(pump);return job;
    })();
  }
  function resume(id){const job=get(id);if(!job)throw fail('LOCAL_JOB_MISSING','找不到本地任务');if(job.status==='succeeded'||job.status==='running'||job.status==='queued')return{...job,reused:true};
    if(job.node_id)orchestration.retryNode(job.session_id,job.node_id,{actor:'system'});job.status='queued';job.error=null;save(job);setImmediate(pump);return job;}
  function recover(){for(const row of db.prepare("SELECT * FROM local_media_jobs WHERE status IN ('queued','running')").all()){
    if(row.status==='running'&&alive(row.owner_pid))continue;const job=JSON.parse(row.job_json);job.status='queued';job.owner_pid=null;save(job);
  }pump();
    // Rebuild only missing experience receipts from persisted terminal jobs.
    // This never runs media again, and history is traversed in bounded pages.
    let after='';
    function backfill(){
      if(closed)return;
      try{
        createMediaExperiences(db);
        const rows=db.prepare(`SELECT id,job_json FROM local_media_jobs j WHERE status IN ('succeeded','failed') AND id>?
          AND NOT EXISTS (SELECT 1 FROM media_experiences e WHERE e.request_key='local-job:'||j.id||':'||json_extract(j.job_json,'$.attempt')||':'||j.status)
          ORDER BY id LIMIT 100`).all(after);
        for(const row of rows)remember(JSON.parse(row.job_json));
        if(rows.length===100){after=rows[rows.length-1].id;experienceRecovery=setImmediate(backfill);}
        else experienceRecovery=setImmediate(()=>backfillAttempts(''));
      }catch(error){try{(injected.log||console).warn?.('media experience recovery deferred',{code:error.code||'EXPERIENCE_RECOVERY_FAILED'});}catch{}}
    }
    function backfillAttempts(afterKey){
      if(closed)return;
      try{
        const rows=db.prepare(`SELECT request_key,receipt_json FROM local_media_attempt_receipts a WHERE request_key>?
          AND NOT EXISTS (SELECT 1 FROM media_experiences e WHERE e.request_key=a.request_key) ORDER BY request_key LIMIT 100`).all(afterKey);
        for(const row of rows)remember(JSON.parse(row.receipt_json));
        if(rows.length===100)experienceRecovery=setImmediate(()=>backfillAttempts(rows[rows.length-1].request_key));
      }catch(error){try{(injected.log||console).warn?.('media attempt experience recovery deferred',{code:error.code||'EXPERIENCE_RECOVERY_FAILED'});}catch{}}
    }
    clearImmediate(experienceRecovery);experienceRecovery=setImmediate(backfill);
  }
  const api={create,get,list,resume,manager,recover,activeCount:()=>db.prepare("SELECT COUNT(*) n FROM local_media_jobs WHERE status IN ('queued','running')").get().n,
    waitForIdle:async()=>{pump();while(running.size||db.prepare("SELECT COUNT(*) n FROM local_media_jobs WHERE status='queued'").get().n){if(running.size)await Promise.allSettled([...running.values()]);else await new Promise(resolve=>setTimeout(resolve,25));}},close:async()=>{closed=true;clearTimeout(retryTimer);clearImmediate(experienceRecovery);await Promise.allSettled([...running.values()]);}};
  connections.set(db,api);return api;
}
module.exports={createLocalMediaJobs};
