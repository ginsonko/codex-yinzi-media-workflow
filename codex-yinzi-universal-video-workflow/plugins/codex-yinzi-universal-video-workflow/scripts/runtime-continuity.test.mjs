import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {createRequire} from 'node:module'
import {readRegistry} from './runtime-state.mjs'
import {resolveData,backupData} from './runtime-data.mjs'
import {installSkills} from './install-skills.mjs'
import {consolidateLegacy} from './runtime-processes.mjs'
import {probe} from './runtime-core.mjs'

const here=path.dirname(fileURLToPath(import.meta.url));const repo=path.resolve(here,'../../../..')
const require=createRequire(path.join(repo,'backend-node/package.json'))
const Database=require('better-sqlite3')
function run(file,args,env,cwd) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[file,...args],{env:{...process.env,...env},cwd,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x)
    child.once('error',reject);child.once('exit',code=>resolve({code,out,err}))
  })
}
async function temporary(fn) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'yinzi continuity '));const old=process.env.YINZI_WORKFLOW_RUNTIME_DIR
  process.env.YINZI_WORKFLOW_RUNTIME_DIR=path.join(root,'state')
  try {await fs.mkdir(process.env.YINZI_WORKFLOW_RUNTIME_DIR);await fn(root)}
  finally {if(old===undefined)delete process.env.YINZI_WORKFLOW_RUNTIME_DIR;else process.env.YINZI_WORKFLOW_RUNTIME_DIR=old;await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
}
test('BOM, damaged and missing registry retain the independent data binding; unavailable original never creates an empty DB',async()=>temporary(async root=>{
  const file=path.join(process.env.YINZI_WORKFLOW_RUNTIME_DIR,'runtime.json')
  const original={runtime_root:path.join(root,'original')}
  await fs.writeFile(file,'\uFEFF'+JSON.stringify(original));assert.deepEqual(await readRegistry(),original)
  await fs.copyFile(file,file+'.bak');await fs.writeFile(file,'{bad');assert.equal((await readRegistry()).runtime_root,original.runtime_root)
  await fs.mkdir(path.join(original.runtime_root,'data'),{recursive:true})
  const database=path.join(original.runtime_root,'data/drama_generator.db');const db=new Database(database)
  db.exec("CREATE TABLE orchestration_sessions(id TEXT); INSERT INTO orchestration_sessions VALUES ('previous-task')");db.close()
  const bound=await resolveData(repo,original)
  const backup=await backupData(repo,bound,'test')
  const saved=new Database(backup.backup,{readonly:true});assert.equal(saved.prepare('SELECT id FROM orchestration_sessions').get().id,'previous-task');saved.close()
  await fs.unlink(file);await fs.unlink(file+'.bak')
  assert.equal((await resolveData(repo,null)).database_path,database)
  await assert.rejects(resolveData(repo,null,path.join(root,'new-empty')),/绑定/)
  await fs.rename(database,database+'.retained')
  await assert.rejects(resolveData(repo,null),/不会建立新空库/)
  await assert.rejects(fs.access(database))
}))
test('skill installation survives checkout removal, refreshes both discovery roots, and preserves unrelated content',async()=>temporary(async root=>{
  const make=async(name,version)=>{
    const source=path.join(root,name),plugin=path.join(source,'codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow')
    await fs.mkdir(path.join(plugin,'skills/codex-yinzi-universal-video'),{recursive:true})
    await fs.mkdir(path.join(plugin,'mcp'),{recursive:true})
    await fs.writeFile(path.join(plugin,'skills/codex-yinzi-universal-video/SKILL.md'),'---\nname: codex-yinzi-universal-video\ndescription: task\n---\n'+version)
    await fs.writeFile(path.join(plugin,'mcp/server.mjs'),'// '+version)
    return source
  }
  const roots=[path.join(root,'.agents/skills'),path.join(root,'.codex/skills')]
  const source=await make('source-v1','v1')
  const first=await installSkills({projectRoot:source,skillsRoots:roots})
  await fs.rename(source,source+'-removed')
  for(const link of first.links)assert.match(await fs.readFile(path.join(link.path,'SKILL.md'),'utf8'),/v1/)
  const newer=await make('source-v2','v2')
  const second=await installSkills({projectRoot:newer,skillsRoots:roots})
  assert.notEqual(first.digest,second.digest)
  for(const link of second.links)assert.match(await fs.readFile(path.join(link.path,'SKILL.md'),'utf8'),/v2/)
  assert.equal((await installSkills({projectRoot:newer,skillsRoots:roots})).digest,second.digest)
  await fs.unlink(second.links[1].path);await fs.mkdir(second.links[1].path)
  await fs.writeFile(path.join(second.links[1].path,'mine.txt'),'preserve')
  await assert.rejects(installSkills({projectRoot:newer,skillsRoots:roots}),/保留用户已有/)
  assert.equal(await fs.readFile(path.join(second.links[1].path,'mine.txt'),'utf8'),'preserve')
}))
test('legacy duplicates consolidate only after matching process/database identity and idle status',async()=>temporary(async root=>{
  const children=[]
  async function legacy(busy) {
    const code=`const http=require('http'),crypto=require('crypto');let busy=${busy};const identity={orchestration_router:true,runtime_id:'yinzi-'+crypto.createHash('sha256').update(process.pid+':'+process.cwd()).digest('hex').slice(0,12),database:{fingerprint:'legacy-test-db'}};const server=http.createServer((req,res)=>{res.setHeader('content-type','application/json');if(req.url==='/idle')busy=false;res.end(JSON.stringify(req.url==='/health'?{status:'ok'}:req.url==='/api/v1/runtime-identity'?{data:identity}:{data:{busy}}))}).listen(0,'127.0.0.1',()=>console.log(JSON.stringify({api:'http://127.0.0.1:'+server.address().port,identity})));`
    const child=spawn(process.execPath,['-e',code],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child)
    return await new Promise((resolve,reject)=>{let out='';child.once('error',reject);child.stdout.on('data',x=>{out+=x;if(out.includes('\n'))resolve(JSON.parse(out))})})
  }
  try {
    const first=await legacy(false),second=await legacy(true)
    await assert.rejects(consolidateLegacy([first,second],{runtime_id:first.identity.runtime_id},root,probe),/仍有运行/)
    assert.ok(await probe(first.api));assert.ok(await probe(second.api))
    await fetch(second.api+'/idle')
    const result=await consolidateLegacy([first,second],{runtime_id:first.identity.runtime_id},root,probe)
    assert.equal(result.stopped.length,1);assert.equal(result.primary.api,first.api)
    assert.ok(await probe(first.api));assert.equal(await probe(second.api),null)
  } finally {for(const child of children)if(child.exitCode===null)child.kill()}
}))
test('real SQLite task, node, event and preferences survive source relocation, upgrade, registry recovery and concurrent launch', {timeout:120000},async()=>temporary(async root=>{
  const state=process.env.YINZI_WORKFLOW_RUNTIME_DIR
  const env={YINZI_WORKFLOW_RUNTIME_DIR:state,YINZI_WORKFLOW_URL:'',YINZI_WORKFLOW_PROJECT_ROOT:repo,YINZI_WORKFLOW_CONFIG:'',YINZI_WORKFLOW_AUTO_UPDATE:'0'}
  const launcher=path.join(here,'runtime-launcher.mjs')
  let record
  const launch=async(source=repo)=>{const r=await run(launcher,['ensure','--project-root',source,'--runtime-dir',state],env);assert.equal(r.code,0,r.out+r.err);return JSON.parse(r.out)}
  const api=async(route,method='GET',body)=>{
    const r=await fetch(record.api_base+'/api/v1/'+route,{method,headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})
    const j=await r.json();assert.ok(r.ok,JSON.stringify(j));return j.data
  }
  try {
    record=await launch();const dbFingerprint=record.database_fingerprint
    const created=await api('orchestration-sessions','POST',{idempotency_key:'retained-session',user_goal:'保留原任务与事件'})
    const id=created.session.id
    const maintenance=await run(launcher,['prepare-update','--project-root',repo,'--runtime-dir',state,'--owner-pid',String(process.pid)],env)
    assert.equal(maintenance.code,0,maintenance.out)
    const whileInstalling=await run(launcher,['ensure','--project-root',repo,'--runtime-dir',state],env)
    assert.equal(whileInstalling.code,3);assert.match(whileInstalling.out,/安装器正在更新/)
    const ownedLaunch=await run(launcher,['ensure','--project-root',repo,'--runtime-dir',state,'--maintenance-owner',String(process.pid)],env)
    assert.equal(ownedLaunch.code,0,ownedLaunch.out);assert.equal(JSON.parse(ownedLaunch.out).pid,record.pid)
    await fs.unlink(path.join(state,'maintenance.json'))
    const plan=await api(`orchestration-sessions/${id}/plan`,'PUT',{expected_revision:0,confirm:false,nodes:[{node_key:'facts',module_id:'product.extract-facts'}]})
    const nodeId=plan.nodes[0].id
    const event=await api(`orchestration-sessions/${id}/events`,'POST',{event_type:'decision',event_idempotency_key:'retained-event',payload:{summary:'原计划继续'}})
    await api('creative-preferences','PUT',{quality_profile:'speed',unattended_mode:true})
    const duplicate=await run(path.join(repo,'backend-node/src/server.js'),[],{...env,YINZI_WORKFLOW_CANONICAL:'1',YINZI_WORKFLOW_CONFIG:path.join(record.runtime_root,'configs/config.yaml'),PORT:'0'},record.runtime_root)
    assert.equal(duplicate.code,3,duplicate.out+duplicate.err);assert.match(duplicate.err,/WORKFLOW_ALREADY_RUNNING/)
    const direct=await run(path.join(repo,'backend-node/src/server.js'),[],env,repo)
    assert.equal(direct.code,0,direct.out+direct.err);assert.equal(JSON.parse(direct.out).pid,record.pid)
    const relocated=path.join(root,'new-checkout')
    for(const part of ['backend-node/src','backend-node/configs','frontweb/src','frontweb/public','frontweb/dist'])await fs.cp(path.join(repo,part),path.join(relocated,part),{recursive:true})
    for(const part of ['backend-node/package.json','backend-node/package-lock.json','frontweb/package.json','frontweb/package-lock.json','frontweb/index.html','frontweb/vite.config.js'])await fs.copyFile(path.join(repo,part),path.join(relocated,part))
    for(const component of ['backend-node','frontweb'])await fs.symlink(path.join(repo,component,'node_modules'),path.join(relocated,component,'node_modules'),process.platform==='win32'?'junction':'dir')
    await fs.appendFile(path.join(relocated,'backend-node/src/server.js'),'\n// upgrade fixture\n')
    const analysis=await api('orchestration-sessions/begin','POST',{idempotency_key:'active-analysis',user_goal:'分析仍在进行',intent:'analyze'})
    const deferred=await launch(relocated)
    assert.equal(deferred.pid,record.pid);assert.ok(deferred.update_deferred)
    await api(`orchestration-sessions/${analysis.session.id}/activity`,'POST',{stage:'analysis',state:'completed',message:'分析已完成',analysis_report:'确认活动期间复用原后台，完成后继续更新。',event_idempotency_key:'analysis-complete'})
    const priorPid=record.pid;record=await launch(relocated)
    assert.notEqual(record.pid,priorPid);assert.equal(record.database_fingerprint,dbFingerprint)
    let bundle=await api(`orchestration-sessions/${id}`)
    assert.equal(bundle.session.id,id);assert.equal(bundle.nodes[0].id,nodeId);assert.ok(bundle.events.some(e=>e.id===event.event.id))
    assert.equal((await api('creative-preferences')).unattended_mode,true)
    const backup=JSON.parse(await fs.readFile(path.join(state,'upgrade-backup.json'),'utf8'))
    const snapshot=new Database(backup.backup,{readonly:true});assert.equal(snapshot.prepare('SELECT id FROM orchestration_sessions WHERE id=?').get(id).id,id);snapshot.close()
    await fs.unlink(path.join(state,'runtime.json'));await fs.unlink(path.join(state,'runtime.json.bak'))
    const opens=await Promise.all([launch(relocated),launch(relocated)])
    for(const open of opens)assert.equal(open.pid,record.pid)
    await fs.unlink(path.join(state,'runtime.json'));await fs.unlink(path.join(state,'runtime.json.bak'))
    const stopped=await run(launcher,['stop','--runtime-dir',state],env);assert.equal(stopped.code,0,stopped.out)
    record=await launch(relocated);bundle=await api(`orchestration-sessions/${id}`)
    assert.equal(bundle.session.id,id);assert.equal(bundle.nodes[0].id,nodeId)
    assert.equal((await api('creative-preferences')).quality_profile,'speed')
  } finally {if(record)await run(launcher,['stop','--runtime-dir',state],env)}
}))
