'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const collectors=require('./videoPlatformCollectors');
const research=require('./productReferenceResearch');
const {buildCreative}=require('./productResearchCreative');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const stamp=()=>new Date().toISOString();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const files=['report.html','result.json','references.csv','references.md','creative-brief.json','video-plan.md'];
const activeRoots=new Map();
function write(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8');fs.renameSync(temp,file);}
function read(file){return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
function createResearchJobs(options={}) {
  const root=path.resolve(options.root||path.join(process.env.YINZI_WORKFLOW_RUNTIME_DIR||path.join(os.homedir(),'.yinzi-media'),'research-jobs'));
  const active=activeRoots.get(root)||new Map();activeRoots.set(root,active);
  const collect=options.collect||collectors.collect;
  const sessionManager=options.sessionManager||require('./researchBrowserSessions').getManager();
  const ensureComponent=options.ensureComponent||require('./mediaComponentManager').ensureComponent;
  const folder=id=>{if(!/^[a-f0-9]{32}$/.test(String(id)))throw fail('RESEARCH_NOT_FOUND','研究任务不存在');return path.join(root,id);};
  const jobFile=id=>path.join(folder(id),'job.json');
  function isRunning(id){
    if(active.has(id))return true;
    try{const lock=read(path.join(folder(id),'runner.lock'));return Number.isInteger(lock.pid)&&alive(lock.pid);}catch{return false;}
  }
  const save=job=>{job.updated_at=stamp();write(jobFile(job.id),job);return job;};
  function get(id){
    let job;try{job=read(jobFile(id));}catch(error){if(error.code==='ENOENT')throw fail('RESEARCH_NOT_FOUND','研究任务不存在');throw error;}
    if(['queued','running','compiling','cancelling'].includes(job.state)&&!isRunning(id)) {
      job.state='interrupted';job.message='上次研究中断，已有资料已保存，可以继续。';save(job);
    }
    return job;
  }
  function list(){if(!fs.existsSync(root))return [];return fs.readdirSync(root).filter(id=>/^[a-f0-9]{32}$/.test(id)).map(id=>{try{return get(id);}catch{return null;}}).filter(Boolean).sort((a,b)=>b.updated_at.localeCompare(a.updated_at)).slice(0,50).map(present);}
  function normalize(body){
    if(!body||typeof body!=='object')throw fail('INVALID_INPUT','请填写商品和平台');
    const query={...body.query};
    query.product=typeof query.product==='string'?query.product.trim():'';
    if(!query.product||query.product.length>160)throw fail('INVALID_QUERY','商品关键词请填写1至160字');
    if(!Array.isArray(query.platforms)||!query.platforms.length||query.platforms.length>6||query.platforms.some(p=>!collectors.profiles.some(x=>x.id===p)))throw fail('INVALID_QUERY','请选择支持的平台；其他平台可用通用入口');
    query.platforms=[...new Set(query.platforms)];
    if(query.platforms.includes('generic')&&query.platforms.length>1)throw fail('INVALID_QUERY','通用入口无需与专用平台同时选择');
    if(query.region!=null&&(typeof query.region!=='string'||query.region.length>80))throw fail('INVALID_QUERY','目标市场请控制在80字以内');
    const input=collectors.validateInput({query,urls:body.urls,product_facts:body.product_facts},'generic');
    const parameters={limit:30,max_pages:5,timeout_ms:20000,discovery:'auto',auth_mode:'auto',...body.parameters};
    collectors.validateParameters(parameters);
    const mode=body.mode==='import'?'import':'collect';
    if(body.mode!=null&&!['import','collect'].includes(body.mode))throw fail('INVALID_INPUT','研究方式须为在线采集或资料导入');
    const source=research.compile({query,items:body.items||[],product_facts:body.product_facts||[]});
    research.groupAndSort(source,'auto'); // validates actual dates/ranges before network
    if(source.product_facts.length>50||JSON.stringify(source.product_facts).length>20000)throw fail('INVALID_INPUT','商品资料过长，请保留关键事实');
    if(mode==='import'&&!source.items.length)throw fail('INVALID_INPUT','导入文件没有视频记录');
    return {...input,parameters,items:source.items,mode};
  }
  function present(job){
    const {input_hash,owner_pid,seed,...publicJob}=job;
    const base='/api/v1/research/jobs/'+job.id;
    return {...publicJob,url:'/research?research='+job.id,download_url:job.report_revision?base+'/download?v='+job.report_revision:null,artifacts:job.report_revision?files.map(name=>({name,url:base+'/files/'+name+'?v='+job.report_revision})):[],
      active:['queued','running','compiling','cancelling'].includes(job.state)};
  }
  function acquire(id){
    const lock=path.join(folder(id),'runner.lock');
    try{const fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);}
    catch(error){if(error.code!=='EEXIST')throw error;let held;try{held=read(lock);}catch{throw fail('RESEARCH_BUSY','研究正在恢复，请稍后刷新');}
      if(alive(held.pid))throw fail('RESEARCH_BUSY','这个研究仍在执行，无需重复开始');fs.unlinkSync(lock);return acquire(id);}
    return ()=>{try{fs.unlinkSync(lock);}catch{}};
  }
  function resultInputs(job){
    const inputs=[job.seed];
    for(const platform of job.platforms)for(const attempt of platform.attempts)if(attempt.result_file){
      try{inputs.push(read(path.join(folder(job.id),attempt.result_file)));}catch(error){throw fail('RESEARCH_RESULT_UNREADABLE','已保存的资料暂时无法读取，请保留任务并重试：'+error.code);}
    }
    const byId=new Map((job.observations||[]).map(row=>[row.id,row]));
    const items=inputs.flatMap(data=>data.items||[]).map(item=>{
      const update=byId.get(item.id);return update?{...item,analysis:update.analysis,analysis_basis:update.analysis_basis}:item;
    });
    // Deduplicate without deleting prior per-attempt files. Newer coherent
    // observations win; the report includes the older snapshots.
    return {query:job.query,items,product_facts:job.product_facts,collection:{platforms:job.platforms.map(p=>({platform:p.id,status:p.status,attempts:p.attempts})),sample_scope:'observed_search_sample'}};
  }
  function compile(id){
    const job=get(id), dir=path.join(folder(id),'reports',String((job.report_revision||0)+1));fs.mkdirSync(dir,{recursive:true});
    const input=resultInputs(job);
    // Each platform's collector is bounded; retain all 1000 rows that the
    // report supports without silently truncating a retry-expanded dataset.
    if(input.items.length>1000){
      const chunks=[];for(let i=0;i<input.items.length;i+=1000)chunks.push(...research.compile({...input,items:input.items.slice(i,i+1000)}).items);
      input.items=research.groupAndSort({...input,items:chunks},'auto').items;
      if(input.items.length>1000)throw fail('RESEARCH_SAMPLE_LIMIT','本研究已有超过1000条不同参考，原始采集已保存；请缩小范围或新建研究。');
    }
    const compiled=research.compile(input), grouped=research.groupAndSort(compiled,'auto');
    const output=research.generateOutputs(compiled,grouped,dir);
    const suggestions=buildCreative(output.result,job.product_facts);
    const creative=Array.isArray(job.selected_ids)?buildCreative(output.result,job.product_facts,job.selected_ids):suggestions;
    write(path.join(dir,'creative-brief.json'),creative.brief);fs.writeFileSync(path.join(dir,'video-plan.md'),creative.markdown,'utf8');
    fs.writeFileSync(path.join(dir,'report.html'),require('./productReferenceReport').renderReport(output.result,{product_facts:job.product_facts,experiments:creative.brief.directions.map(d=>({title:d.title,source_ids:d.source_ids,hypothesis:d.hypothesis,basis:'可修改的拍摄框架，尚未完成观片验证',shots:d.scenes.map(s=>s.seconds+'秒：'+s.visual+'；'+s.line).join('\n'),metric:d.measure}))}),'utf8');
    job.report_revision=(job.report_revision||0)+1;job.summary=output.result.summary;
    job.shortlist=[...new Map([...suggestions.brief.selected_sources,...creative.brief.selected_sources].map(r=>[r.id,r])).values()].map(r=>({id:r.id,title:r.title,url:r.url,platform:r.platform,recommendation:r.recommendation,watch_required:r.watch_required}));
    job.data_gaps=creative.brief.data_gaps;save(job);return job;
  }
  async function execute(id,targets){
    let job=get(id);
    for(const platformId of targets){
      job=get(id);if(job.cancel_requested)break;
      const platform=job.platforms.find(p=>p.id===platformId);
      platform.status='running';job.state='running';job.message='正在读取'+platform.name+'的参考视频';save(job);
      const number=platform.attempts.length+1,relative=path.join('collections',platformId,String(number)),dir=path.join(folder(id),relative);
      fs.mkdirSync(dir,{recursive:true});
      const inputPath=path.join(dir,'input.json'),outputPath=path.join(dir,'result.json');
      const urls=job.urls.filter(url=>platformId==='generic'||require('./videoReferenceDiscovery').platformFor(url)===platformId);
      write(inputPath,{query:job.query,urls,product_facts:job.product_facts});
      const attempt={number,started_at:stamp(),request_key:job.id+':'+platformId+':'+number};
      platform.attempts.push(attempt);save(job);
      try{
        const details=await collect({inputPath,outputPath,parameters:job.parameters,ensureComponent,shouldStop:()=>Boolean(get(id).cancel_requested),
          report:progress=>{const current=get(id);if(!current.cancel_requested){current.message=String(progress.message||'正在采集').slice(0,300);save(current);}}},platformId,{sessionManager});
        job=get(id);const p=job.platforms.find(x=>x.id===platformId),a=p.attempts.at(-1);
        const data=read(outputPath);a.result_file=path.join(relative,'result.json');a.completed_at=stamp();
        a.status=details.collection?.status||details.summary?.status||'requires_discovery';a.count=data.items?.length||0;
        a.blocked_status=details.collection?.blocked_status||null;a.routes=details.collection?.attempts||[];
        p.status=a.blocked_status||a.status;p.count=a.count;p.warnings=details.collection?.warnings||[];
        p.required_action=details.collection?.required_action||null;p.next_steps=details.collection?.next_steps||[];
        p.error=details.collection?.attempts?.find(a=>a.status==='failed')||null;save(job);
      }catch(error){
        job=get(id);const p=job.platforms.find(x=>x.id===platformId),a=p.attempts.at(-1);
        a.status='failed';a.completed_at=stamp();a.error={code:error.code||'RESEARCH_FAILED',message:String(error.message).replace(/Bearer\s+\S+|sk-[\w-]+/gi,'[redacted]').slice(0,500)};
        p.status='failed';p.error=a.error;save(job);
      }
    }
    job=get(id);const cancelled=job.cancel_requested;job.state='compiling';job.message='正在整理图表、参考来源和拍摄方向';save(job);
    job=compile(id);
    const allGood=job.platforms.every(p=>['collected','imported'].includes(p.status));
    const needsAction=job.platforms.some(p=>['verification_required','access_required','rate_limited'].includes(p.status));
    job.state=cancelled?'cancelled':needsAction?'needs_action':job.summary.total_items?(allGood?'completed':'partial'):'empty';
    job.message=cancelled?'研究已停止，已取得的资料可继续查看':job.state==='completed'?'研究报告与拍摄方向已整理好':job.state==='needs_action'?'已有资料已整理；部分平台需要完成登录或验证':job.state==='partial'?'已生成部分资料报告，可继续补采未完成的平台':'当前没有取得可用记录，可补充链接、导入资料或重试';
    save(job);
  }
  function start(id,targets){
    if(active.has(id))return present(get(id));
    const release=acquire(id),job=get(id);job.cancel_requested=false;job.state='queued';job.owner_pid=process.pid;save(job);
    const promise=Promise.resolve().then(()=>execute(id,targets)).catch(error=>{const j=get(id);j.state='failed';j.message=error.message;j.error={code:error.code||'RESEARCH_FAILED',message:error.message};save(j);}).finally(()=>{active.delete(id);release();});
    active.set(id,promise);return present(job);
  }
  function create(body){
    if(typeof body?.request_key!=='string'||!body.request_key.trim()||body.request_key.length>200)throw fail('INVALID_REQUEST_KEY','研究请求缺少有效标识，请重试');
    const input=normalize(body),id=digest(body.request_key).slice(0,32),hash=digest(input);
    if(fs.existsSync(jobFile(id))){const existing=get(id);if(existing.input_hash!==hash)throw fail('REQUEST_KEY_CONFLICT','此请求已用于另一份内容，请新建研究');return {job:present(existing),reused:true};}
    const job={id,input_hash:hash,created_at:stamp(),query:input.query,parameters:input.parameters,urls:input.urls,product_facts:input.product_facts,
      seed:{items:input.items},state:'queued',owner_pid:process.pid,report_revision:0,selected_ids:null,observations:[],
      platforms:input.query.platforms.map(id=>({id,name:collectors.profiles.find(p=>p.id===id).name,status:input.mode==='import'?'imported':'queued',count:input.items.filter(r=>r.platform===id).length,attempts:[]}))};
    save(job);return {job:start(id,input.mode==='import'?[]:input.query.platforms),reused:false};
  }
  function resume(id,body={}){
    const job=get(id);if(active.has(id))return present(job);
    const targets=body.platforms||job.platforms.filter(p=>!['collected','imported'].includes(p.status)).map(p=>p.id);
    if(!Array.isArray(targets)||targets.some(id=>!job.platforms.some(p=>p.id===id)))throw fail('INVALID_PLATFORM','请选择本任务的平台');
    return start(id,[...new Set(targets)]);
  }
  function cancel(id){const job=get(id);job.cancel_requested=true;job.state=isRunning(id)?'cancelling':'cancelled';job.message=isRunning(id)?'正在结束当前请求并保存资料，不再开始下一平台':'研究已停止，资料已保留';save(job);return present(job);}
  function artifact(id,name,revision){const job=get(id),version=revision==null?job.report_revision:Number(revision);if(!files.includes(name)||!Number.isInteger(version)||version<1||version>job.report_revision)throw fail('RESEARCH_NOT_FOUND','成果尚未生成');return path.join(folder(id),'reports',String(version),name);}
  function records(id,params={}){
    const offset=params.offset==null?0:Number(params.offset),limit=params.limit==null?50:Number(params.limit);
    if(!Number.isInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw fail('INVALID_PAGE','每页可读取1至100条，起点须为非负整数');
    const revision=params.v==null?get(id).report_revision:Number(params.v),data=read(artifact(id,'result.json',revision));
    return {job_id:id,report_revision:revision,query:data.query,total:data.items.length,offset,items:data.items.slice(offset,offset+limit),next_offset:offset+limit<data.items.length?offset+limit:null};
  }
  function download(id,revision){
    const archive=new (require('adm-zip'))();
    for(const name of files)archive.addFile(name,fs.readFileSync(artifact(id,name,revision)));
    archive.addFile('README.txt',Buffer.from('银子媒体工作流 · 商品视频研究\n用浏览器打开 report.html 查看离线图表。references.csv 可在表格软件中查看；result.json 可导入工作台。creative-brief.json 和 video-plan.md 可交给 Agent 继续观片、核对商品事实并制作原创视频。\n数据为采集时可见的样本；互动热度不等于销量。具体观看范围和来源保留在记录中。\n此包不包含平台登录态或视频文件。\n','utf8'));
    return archive.toBuffer();
  }
  function update(id,body){
    const job=get(id);if(isRunning(id))throw fail('RESEARCH_BUSY','正在保存研究结果，请稍后补充资料');
    if(body.product_facts!=null){research.compile({query:job.query,items:[],product_facts:body.product_facts});if(body.product_facts.length>50||JSON.stringify(body.product_facts).length>20000)throw fail('INVALID_INPUT','商品资料过长');job.product_facts=body.product_facts;}
    if(body.selected_ids!=null){if(!Array.isArray(body.selected_ids)||body.selected_ids.length>30||body.selected_ids.some(x=>typeof x!=='string'))throw fail('INVALID_INPUT','最多选择30条视频');const data=read(artifact(id,'result.json'));if(body.selected_ids.some(id=>!data.items.some(r=>r.id===id)))throw fail('INVALID_INPUT','选中的视频不在本研究里');job.selected_ids=body.selected_ids;}
    if(body.observations!=null){
      if(!Array.isArray(body.observations)||body.observations.length>30||JSON.stringify(body.observations).length>60000)throw fail('INVALID_INPUT','请提供最多30条有观看范围的分析');
      const data=read(artifact(id,'result.json'));
      for(const row of body.observations)if(!data.items.some(r=>r.id===row.id)||!['video_viewed','user_supplied'].includes(row.analysis_basis)||typeof row.analysis?.viewed_range!=='string'||!row.analysis.viewed_range.trim())throw fail('INVALID_INPUT','观片分析须注明视频ID、依据和实际观看范围');
      job.observations=[...new Map([...job.observations,...body.observations].map(row=>[row.id,row])).values()];
    }
    save(job);return present(compile(id));
  }
  function handoff(id){
    const job=get(id);if(isRunning(id))throw fail('RESEARCH_BUSY','正在保存研究结果，请稍后进入策划');
    const brief=read(artifact(id,'creative-brief.json'));
    if(!options.createSession)throw fail('RESEARCH_BRIDGE_UNAVAILABLE','创作工作台未连接，仍可下载策划文件交给 Agent');
    const result=options.createSession({idempotency_key:'research:'+id+':report:'+job.report_revision,title:job.query.product+' · 商品视频策划',
      mode:'collaborate',user_goal:'请为「'+job.query.product+'」策划自己的商品视频。研究报告、重点参考和拍摄方向已附在项目文件中。请实际观看重点样本，结合我的商品事实，提出原创脚本、分镜、素材需求和A/B测试方案，再按已有授权进入制作。尚未提供的商品参数请先补齐。',
      source_context:{research_job_id:id,report_revision:job.report_revision,work_dir:path.dirname(artifact(id,'video-plan.md')),creative_brief:brief,research_artifacts:present(job).artifacts,intent:'analyze',paid_generation_authorized:false},actor:'user'});
    job.handoff={session_id:result.session.id,url:'/codex-console/'+result.session.id,report_revision:job.report_revision,next_action:'读取附带的 creative_brief，实际观看重点参考并核对商品事实；继续原任务的脚本、分镜与制作，不要求用户重复描述。此交接本身未启动付费生成。'};save(job);return job.handoff;
  }
  return {root,create,get:id=>present(get(id)),list,resume,cancel,compile:id=>present(compile(id)),artifact,records,download,update,handoff,settle:id=>active.get(id)||Promise.resolve()};
}
module.exports={createResearchJobs,activeResearchCount:()=>[...activeRoots.values()].reduce((count,active)=>count+active.size,0)};
