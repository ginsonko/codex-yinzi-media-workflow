import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { stateRoot, readRegistry, readJson, localOrigin, verifyUi, openBrowser } from './runtime-state.mjs'
import { atomicJson, resolveData, discoverData, backupData, verifyContinuity } from './runtime-data.mjs'
import {requireIdle,consolidateLegacy,verifiedRuntimePid} from './runtime-processes.mjs'
const here=path.dirname(fileURLToPath(import.meta.url))
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const alive=pid=>{try { process.kill(pid,0);return true } catch {return false}}
export async function fingerprint(root, entries) {
  const hash=crypto.createHash('sha256')
  async function visit(relative) {
    const full=path.join(root,relative); let stat;try { stat=await fsp.stat(full) } catch { hash.update(`${relative}:missing`);return }
    if(stat.isDirectory()) { for (const name of (await fsp.readdir(full)).sort()) await visit(path.join(relative,name));return }
    hash.update(relative.replaceAll('\\','/'));hash.update(await fsp.readFile(full))
  }
  for (const entry of entries) await visit(entry)
  return hash.digest('hex')
}
export function findProjectRoot(explicit, registered) {
  for (const start of [explicit,registered,process.cwd(),here].filter(Boolean)) {
    let current=path.resolve(start)
    for(let index=0;index<12;index++) {
      if(fs.existsSync(path.join(current,'backend-node/src/server.js')) && fs.existsSync(path.join(current,'frontweb/package.json'))) return current
      const parent=path.dirname(current);if(parent===current) break;current=parent
    }
    if(explicit===start) throw new Error('指定源码目录不包含 backend-node 和 frontweb')
  }
  throw new Error('未找到工作流源码，请运行仓库安装脚本，或设置 YINZI_WORKFLOW_PROJECT_ROOT')
}
export async function probe(origin) {
  try {
    localOrigin(origin)
    const [health,identity]=await Promise.all(['/health','/api/v1/runtime-identity'].map(async route=>{const r=await fetch(origin+route,{signal:AbortSignal.timeout(2500)});if(!r.ok) throw new Error('HTTP '+r.status);return r.json()}))
    const value=identity.data ?? identity
    return health.status==='ok' && value.orchestration_router===true ? value : null
  } catch {return null}
}
async function writeRegistry(value) {
  const file=path.join(stateRoot(),'runtime.json')
  await atomicJson(file,value)
  await atomicJson(file+'.bak',value)
}
async function lock() {
  await fsp.mkdir(stateRoot(),{recursive:true});const file=path.join(stateRoot(),'launch.lock');const end=Date.now()+180000
  while(Date.now()<end) {
    try { const handle=await fsp.open(file,'wx');await handle.writeFile(String(process.pid));return async()=>{await handle.close();await fsp.rm(file,{force:true})} }
    catch(error) {if(error.code!=='EEXIST') throw error; const pid=Number(await fsp.readFile(file,'utf8').catch(()=>''));if(pid && !alive(pid)) {await fsp.rm(file,{force:true});continue} await delay(250)}
  }
  throw new Error('另一安装或启动进程尚未结束，请查看运行时日志')
}
export async function findPort(preferred=5683) {
  for(const port of [...new Set([Number(preferred),5683,5679,5680,5682,0])].filter(p=>Number.isInteger(p)&&p>=0&&p<65536)) {
    // Windows can permit a loopback bind beside an existing wildcard listener.
    // A successful bind alone therefore does not prove the port is unoccupied.
    if (port) {
      const connected=await new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port});const done=value=>{socket.destroy();resolve(value)};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(400,()=>done(false))})
      if (connected) continue
    }
    const result=await new Promise(resolve=>{const server=net.createServer();server.once('error',()=>resolve(null));server.listen(port,'127.0.0.1',()=>{const selected=server.address().port;server.close(()=>resolve(selected))})})
    if(result) return result
  }
  throw new Error('无法申请本机监听端口')
}
export async function prepareRuntime(source,root) {
  await fsp.mkdir(path.join(root,'configs'),{recursive:true});await fsp.mkdir(path.join(root,'data/storage'),{recursive:true});await fsp.mkdir(path.join(root,'logs'),{recursive:true})
  // An existing runtime may use config.yaml in its root. Never shadow it.
  if(!fs.existsSync(path.join(root,'config.yaml')) && !fs.existsSync(path.join(root,'configs/config.yaml'))) {
    const original=await fsp.readFile(path.join(source,'backend-node/configs/config.yaml'),'utf8')
    await fsp.writeFile(path.join(root,'configs/config.yaml'),original.replace(/(^\s*host:\s*).+$/m,(_,prefix)=>`${prefix}127.0.0.1`),{flag:'wx',mode:0o600})
  }
}
export async function buildFrontend(source) {
  const root=path.join(source,'frontweb');const dist=path.join(root,'dist');const digest=await fingerprint(root,['src','public','index.html','package.json','package-lock.json','vite.config.js'])
  const marker=path.join(dist,'.source-digest');const prior=await fsp.readFile(marker,'utf8').catch(()=>'')
  if(prior===digest && fs.existsSync(path.join(dist,'index.html'))) return digest
  const vite=path.join(root,'node_modules/vite/bin/vite.js')
  if(!fs.existsSync(vite)) throw new Error('前端依赖未安装，请先运行安装脚本')
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[vite,'build'],{cwd:root,stdio:['ignore','ignore','pipe'],windowsHide:true});let error='';child.stderr.on('data',chunk=>{error=(error+chunk).slice(-6000)});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(new Error(`前端构建失败：${error}`)))})
  await fsp.writeFile(marker,digest);return digest
}
function startBackend(source,root,port,digest,token,configPath) {
  const log=path.join(root,'logs',`backend-${Date.now()}.log`);const fd=fs.openSync(log,'a')
  try {const child=spawn(process.execPath,[path.join(source,'backend-node/src/server.js')],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',WEB_DIST_PATH:path.join(source,'frontweb/dist'),YINZI_WORKFLOW_PROJECT_ROOT:source,YINZI_WORKFLOW_RUNTIME_DIR:stateRoot(),YINZI_WORKFLOW_CONFIG:configPath,YINZI_WORKFLOW_CANONICAL:'1',YINZI_WORKFLOW_SOURCE_DIGEST:digest,YINZI_WORKFLOW_LAUNCH_TOKEN:token},detached:true,stdio:['ignore',fd,fd],windowsHide:true});child.unref();return {pid:child.pid,log,child} }
  finally {fs.closeSync(fd)}
}
export async function ensure(options={}) {
  const unlock=await lock()
  try {
    const maintenance=await readJson(path.join(stateRoot(),'maintenance.json'))
    if(maintenance?.owner_pid && alive(maintenance.owner_pid) && Number(options.maintenanceOwner)!==maintenance.owner_pid)
      throw new Error('安装器正在更新，原任务和数据已保留；安装完成后继续使用同一工作台')
    const registered=await readRegistry(); const hint=options.apiBase || process.env.YINZI_WORKFLOW_URL
    const source=findProjectRoot(options.projectRoot || process.env.YINZI_WORKFLOW_PROJECT_ROOT,registered?.source_root)
    const data=await resolveData(source,registered,options.runtimeRoot)
    const root=data.runtime_root
    const frontendDigest=await buildFrontend(source)
    const sourceDigest=await fingerprint(path.join(source,'backend-node'),['src','package.json','package-lock.json'])
    const lease=await readJson(data.database_path+'.runtime-lock')
    let origin=hint ? localOrigin(hint) : lease?.api_base || registered?.api_base
    let live=origin ? await probe(origin) : null
    if(hint && live && live.database?.fingerprint!==data.database_fingerprint)throw new Error('指定地址不属于原数据库，已保留原绑定和任务')
    // Recover older entry points without creating another process beside them.
    let consolidated=[]
    {
      const candidates=[...new Set([origin,registered?.api_base,lease?.api_base,...[5679,5683,5680,5682].map(p=>`http://127.0.0.1:${p}`)].filter(Boolean))]
      const found=(await Promise.all(candidates.map(async api=>({api,identity:await probe(api)})))).filter(x=>x.identity?.database?.fingerprint===data.database_fingerprint)
      if(found.length>1) {
        await backupData(source,data,'before-duplicate-consolidation')
        const result=await consolidateLegacy(found,registered,root,probe)
        consolidated=result.stopped;origin=result.primary.api;live=result.primary.identity
      } else if(!live && found.length) {origin=found[0].api;live=found[0].identity}
    }
    const sameDatabase=live && data.database_fingerprint===live.database?.fingerprint
    const sameRoot=!registered?.runtime_root || path.resolve(registered.runtime_root)===root
    if(live && sameDatabase && sameRoot) {
      // Only a process launched by this registry is eligible for replacement.
      const ownerPid=registered?.runtime_id===live.runtime_id?registered.pid:
        lease?.launch_token && lease.launch_token===live.launch_token?lease.pid:await verifiedRuntimePid(live,root)
      const stale=ownerPid && live.source_digest!==sourceDigest
      let updateDeferred=null
      if(stale) {try {await requireIdle(origin)}catch(error){updateDeferred=error.message}}
      if(stale && !updateDeferred) { await backupData(source,data,'source-upgrade');process.kill(ownerPid);for(let i=0;i<80&&alive(ownerPid);i++) await delay(125);if(alive(ownerPid)) throw new Error('旧运行时仍在退出，已保留原数据库，请稍后重新打开') }
      else {
        if(!await verifyUi(origin)) throw new Error('后端在线，但首页或脚本资源不可读；请检查前端构建路径')
        const record={...registered,ok:true,api_base:origin,frontend_url:`${origin}/`,source_root:source,runtime_root:root,pid:ownerPid,runtime_id:live.runtime_id,database_fingerprint:live.database?.fingerprint,source_digest:live.source_digest || null,frontend_digest:frontendDigest,reused:true}
        await writeRegistry(record);return {...record,identity:live,consolidated,update_deferred:updateDeferred,...(options.open ? {browser:await openBrowser(record.frontend_url)}:{})}
      }
    } else if(live) {
      throw new Error('登记地址属于另一数据库，原运行时仍在运行；已保留实例和数据，请检查 runtime.json')
    }
    if(!live && ((lease?.pid && alive(lease.pid)) || (registered?.pid && alive(registered.pid)))) throw new Error('原后台进程仍在但暂时未响应；保留原实例，不会另开端口创建重复后台')
    await prepareRuntime(source,root)
    if(data.exists && !live) await backupData(source,data,'restart-before-migrations')
    const configPath=fs.existsSync(path.join(root,'configs/config.yaml'))?path.join(root,'configs/config.yaml'):path.join(root,'config.yaml')
    for(let attempt=0;attempt<4;attempt++) {
      const port=await findPort(attempt ? 0 : options.port);const apiBase=`http://127.0.0.1:${port}`;const token=crypto.randomUUID();const processInfo=startBackend(source,root,port,sourceDigest,token,configPath)
      let exited=false;let spawnError;processInfo.child.once('exit',()=>{exited=true});processInfo.child.once('error',error=>{spawnError=error;exited=true})
      let identity=null;let collided=false;const end=Date.now()+45000
      while(!exited && Date.now()<end) {identity=await probe(apiBase);if(identity?.launch_token===token && identity.source_digest===sourceDigest) break;if(identity) {collided=true;identity=null;break} await delay(250)}
      if(identity && await verifyUi(apiBase)) {
        let continuity
        try {continuity=await verifyContinuity(source,data)} catch(error) {try {process.kill(processInfo.pid)}catch{};throw error}
        const record={ok:true,schema:'yinzi.codex-runtime/v2',source_root:source,runtime_root:root,api_base:apiBase,frontend_url:`${apiBase}/`,pid:processInfo.pid,log:processInfo.log,started_at:new Date().toISOString(),runtime_id:identity.runtime_id,database_fingerprint:identity.database?.fingerprint,source_revision:identity.source_revision,source_digest:sourceDigest,frontend_digest:frontendDigest,paid_calls_started:false}
        await writeRegistry(record);return {...record,reused:false,identity,continuity,...(options.open?{browser:await openBrowser(record.frontend_url)}:{})}
      }
      if(!exited && processInfo.pid) {try {process.kill(processInfo.pid)}catch{}}
      const output=await fsp.readFile(processInfo.log,'utf8').catch(()=>'')
      if(!collided && !/EADDRINUSE/.test(output)) throw new Error(`工作流启动失败：${spawnError?.message || '请查看日志'} ${processInfo.log}`)
    }
    throw new Error('端口连续被其他程序抢占，请再次打开工作台')
  } finally {await unlock()}
}
export async function stopOwnedRuntime() {
  const unlock=await lock()
  try {
    let record=await readRegistry()
    if(!record?.pid) {
      const binding=await readJson(path.join(stateRoot(),'data-binding.json'))
      const lease=binding?.database_path?await readJson(binding.database_path+'.runtime-lock'):null
      if(lease?.pid && alive(lease.pid)) {
        const identity=await probe(lease.api_base)
        if(!lease.launch_token || identity?.launch_token!==lease.launch_token || identity.database?.fingerprint!==binding.database_fingerprint)
          throw new Error('原后台仍在，但丢失登记后无法核对身份；已保留进程与数据')
        record={...lease,runtime_id:identity.runtime_id,database_fingerprint:binding.database_fingerprint}
      }
    }
    if(!record?.pid || !alive(record.pid)) return {ok:true,stopped:false}
    const identity=record.api_base ? await probe(record.api_base) : null
    if(!identity || identity.runtime_id!==record.runtime_id ||
       (record.database_fingerprint && identity.database?.fingerprint!==record.database_fingerprint)) {
      throw new Error('登记的进程身份无法核对，已保留未知进程和数据；请让 Codex 检查运行状态')
    }
    process.kill(record.pid)
    for(let i=0;i<80&&alive(record.pid);i++) await delay(125)
    if(alive(record.pid)) throw new Error('工作流尚未退出，请稍后重试；原数据已保留')
    await writeRegistry({...record,pid:null,stopped_at:new Date().toISOString()})
    return {ok:true,stopped:true}
  } finally {await unlock()}
}
export async function prepareUpdate(options={}) {
  const unlock=await lock()
  try {
    const file=path.join(stateRoot(),'maintenance.json')
    const prior=await readJson(file)
    if(prior?.owner_pid && alive(prior.owner_pid) && Number(options.ownerPid)!==prior.owner_pid) throw new Error('另一个安装器仍在更新，保留当前安装并等待完成')
    const registered=await readRegistry()
    const source=findProjectRoot(options.projectRoot,registered?.source_root)
    const data=await resolveData(source,registered,options.runtimeRoot)
    const lease=await readJson(data.database_path+'.runtime-lock')
    const origin=lease?.api_base || registered?.api_base
    if(origin && await probe(origin)) await requireIdle(origin)
    const backup=await backupData(source,data,'installer-before-dependencies')
    if(Number.isInteger(Number(options.ownerPid)) && Number(options.ownerPid)>0)
      await atomicJson(file,{owner_pid:Number(options.ownerPid),runtime_root:data.runtime_root,started_at:new Date().toISOString()})
    return {ok:true,runtime_root:data.runtime_root,database_fingerprint:data.database_fingerprint,backup:backup?.backup || null}
  } finally {await unlock()}
}
export async function main(args=process.argv.slice(2)) {
  const option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]}
  if(option('--runtime-dir')) process.env.YINZI_WORKFLOW_RUNTIME_DIR=path.resolve(option('--runtime-dir'))
  try {
    const command=args[0] || 'status';let result
    if(command==='ensure') result=await ensure({projectRoot:option('--project-root'),runtimeRoot:option('--runtime-root'),port:option('--backend-port'),apiBase:option('--api-base'),maintenanceOwner:option('--maintenance-owner'),open:args.includes('--open')})
    else if(command==='status') {const record=await readRegistry();const identity=record?.api_base?await probe(record.api_base):null;result={ok:true,active:Boolean(identity && (!record.runtime_id || record.runtime_id===identity.runtime_id)),registry:path.join(stateRoot(),'runtime.json'),runtime:record}}
    else if(command==='stop') result=await stopOwnedRuntime()
    else if(command==='prepare-update') result=await prepareUpdate({projectRoot:option('--project-root'),runtimeRoot:option('--runtime-root'),ownerPid:option('--owner-pid')})
    else if(command==='state-root') result={ok:true,state_root:stateRoot()}
    else if(command==='doctor') {
      const record=await readRegistry();const source=findProjectRoot(option('--project-root'),record?.source_root)
      result={ok:true,registry:record,data_binding:await readJson(path.join(stateRoot(),'data-binding.json')),candidates:await discoverData(source,record,option('--search-root')?[option('--search-root')]:[])}
    }
    else {process.exitCode=2;result={ok:false,error:'可用命令：ensure、status、stop'}}
    process.stdout.write(JSON.stringify(result)+'\n')
  } catch(error) {process.exitCode=3;process.stdout.write(JSON.stringify({ok:false,error:error.message})+'\n')}
}
