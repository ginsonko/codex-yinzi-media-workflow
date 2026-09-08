import crypto from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const execute=promisify(execFile)
const alive=pid=>{try{process.kill(pid,0);return true}catch(error){return error.code!=='ESRCH'}}
export async function requireIdle(origin) {
  const response=await fetch(origin+'/api/v1/runtime-work-status',{signal:AbortSignal.timeout(4000)})
  if(!response.ok) throw new Error('无法核对正在执行的任务，原后台保持运行；稍后重试更新')
  const result=await response.json();if((result.data??result).busy!==false) throw new Error('工作流仍有运行或待核对任务，保留原后台与记录，稍后继续更新')
}
async function nodePids() {
  if(process.platform==='win32') {
    const result=await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.ProcessId }"],{windowsHide:true,timeout:8000,maxBuffer:65536})
    return result.stdout.trim().split(/\s+/).map(Number).filter(Number.isInteger)
  }
  const result=await execute('ps',['-eo','pid=,comm='],{timeout:4000,maxBuffer:65536})
  return result.stdout.split('\n').filter(x=>/\bnode(?:js)?$/.test(x.trim())).map(x=>Number(x.trim().split(/\s+/)[0]))
}
export async function verifiedRuntimePid(identity,root) {
  const match=pid=>'yinzi-'+crypto.createHash('sha256').update(`${pid}:${root}`).digest('hex').slice(0,12)===identity.runtime_id
  if(identity.pid && match(identity.pid) && alive(identity.pid))return identity.pid
  return (await nodePids()).find(match) || null
}
export async function consolidateLegacy(instances,registered,root,probe) {
  if(instances.length<2)return {primary:instances[0],stopped:[]}
  const primary=instances.find(x=>x.identity.runtime_id===registered?.runtime_id)||instances[0]
  const pids=await nodePids()
  const records=instances.filter(x=>x!==primary).map(instance=>{
    // Older runtime identity binds pid + cwd. Do not terminate a process based
    // merely on its executable name, listening port, or a recycled registry PID.
    const pid=pids.find(pid=>'yinzi-'+crypto.createHash('sha256').update(`${pid}:${root}`).digest('hex').slice(0,12)===instance.identity.runtime_id)
    if(!pid || pid===process.pid)throw new Error('旧重复后台的进程身份无法完整核对；已保留数据并阻止新增，请运行 doctor')
    return {...instance,pid}
  })
  for(const entry of records)await requireIdle(entry.api)
  const stopped=[]
  for(const entry of records) {
    const identity=await probe(entry.api)
    if(identity?.runtime_id!==entry.identity.runtime_id || identity?.database?.fingerprint!==primary.identity.database.fingerprint)
      throw new Error('重复后台身份已变化，停止整理并保留现有实例')
    process.kill(entry.pid)
    for(let i=0;i<80&&alive(entry.pid);i++)await new Promise(resolve=>setTimeout(resolve,125))
    if(alive(entry.pid))throw new Error('旧后台尚未退出；不再启动新后台')
    stopped.push({pid:entry.pid,api_base:entry.api,runtime_id:entry.identity.runtime_id})
  }
  return {primary,stopped}
}
