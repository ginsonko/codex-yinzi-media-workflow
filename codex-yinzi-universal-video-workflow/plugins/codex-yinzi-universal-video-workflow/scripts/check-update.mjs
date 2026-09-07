#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readRegistry, stateRoot, localOrigin } from './runtime-state.mjs'
const execute = promisify(execFile)
const official = /^(?:https:\/\/github\.com\/|git@github\.com:)ginsonko\/codex-yinzi-media-workflow(?:\.git)?\/?$/i
async function git(root, args, timeout=6000) { return (await execute('git',args,{cwd:root,timeout,windowsHide:true,maxBuffer:1024*1024})).stdout.trim() }
async function busyRuntime(registry) {
 if (!registry?.api_base) return false
 const origin=localOrigin(registry.api_base)
 try {
  const read=async route=>{const r=await fetch(origin+route,{signal:AbortSignal.timeout(2000)});if(!r.ok)throw new Error('runtime read failed');const j=await r.json();return j.data??j}
  const [identity,work]=await Promise.all([read('/api/v1/runtime-identity'),read('/api/v1/runtime-work-status')])
  if (registry.database_fingerprint && registry.database_fingerprint!==identity.database?.fingerprint) return true
  if (typeof work.busy!=='boolean') return true
  return work.busy
 } catch { // A listening but unreadable service must not be interrupted by an update.
  try { const r=await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)});return r.ok } catch { return false }
 }
}
function activation(root, revision, previous, status='updated') {
 return {status,revision,previous,install_required:true,project_root:root,
   install_command:process.platform==='win32'?['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'install.ps1'),'-NoBrowser','-StateRoot',stateRoot()]:['bash',path.join(root,'install.sh'),'--no-browser','--state-root='+stateRoot()],
   message:'现在执行对应安装器同步依赖、Skills 和工作台，再读取新版 Skill。'}
}
export async function acknowledgeUpdate(root) {
 const file=path.join(stateRoot(),'update-pending.json')
 const pending=await fs.readFile(file,'utf8').then(JSON.parse).catch(()=>null)
 if (pending && path.resolve(pending.project_root)===path.resolve(root)) await fs.unlink(file)
 return {status:'activation_acknowledged'}
}
export async function checkUpdate(options={}) {
 if (process.env.YINZI_WORKFLOW_AUTO_UPDATE==='0') return {status:'disabled'}
 const registry=options.registry??await readRegistry()
 const root=options.projectRoot||process.env.YINZI_WORKFLOW_PROJECT_ROOT||registry?.source_root
 if (!root) return {status:'source_not_registered',message:'当前安装目录尚未登记，继续使用现有工作流'}
 const run=options.git||((args,timeout)=>git(root,args,timeout))
 let unlock
 try {
  const remote=await run(['remote','get-url','origin'])
  if (!official.test(remote)) return {status:'custom_repository',message:'自定义仓库保留现状，可由 Codex 按你的分支策略更新'}
  const head=await run(['rev-parse','HEAD'])
  const latest=(await run(['ls-remote','--heads','origin','main'],5000)).split(/\s+/)[0]
  if (!/^[a-f0-9]{40,64}$/.test(latest)) throw new Error('invalid remote revision')
  if (head===latest) {
   const pending=options.pending ?? (options.git ? null : await fs.readFile(path.join(stateRoot(),'update-pending.json'),'utf8').then(JSON.parse).catch(()=>null))
   if (pending && path.resolve(pending.project_root)===path.resolve(root) && pending.revision===head) {
    if (await run(['status','--porcelain']) || await run(['branch','--show-current'])!=='main') return {status:'local_changes',latest,message:'安装尚未完成，已保留你本地的源码改动'}
    if (await (options.busy||(()=>busyRuntime(registry)))()) return {status:'deferred',latest,message:'已下载新版，等待当前任务结束后完成安装'}
    return activation(root,head,pending.previous,'activation_required')
   }
   return {status:'current',revision:head}
  }
  if (!options.apply) return {status:'available',revision:head,latest}
  if (await run(['status','--porcelain']) || await run(['branch','--show-current'])!=='main') return {status:'local_changes',latest,message:'发现新版；保留本地修改与分支，稍后由 Codex 协助合并'}
  if (await (options.busy||(()=>busyRuntime(registry)))()) return {status:'deferred',latest,message:'发现新版，当前任务结束后再更新，避免中断生成或下载'}
  if (!options.git) {
   const folder=path.join(stateRoot(),'update.lock');await fs.mkdir(path.dirname(folder),{recursive:true})
   try { await fs.mkdir(folder) } catch { return {status:'update_in_progress'} }
   unlock=()=>fs.rmdir(folder)
  }
  await run(['fetch','--no-tags','origin','main'],15000)
  const fetched=await run(['rev-parse','FETCH_HEAD'])
  await run(['merge-base','--is-ancestor',head,fetched])
  // Persist activation work before moving HEAD, so an interrupted installation is resumed.
  if (!options.git) {
   const file=path.join(stateRoot(),'update-pending.json')
   await fs.writeFile(file,JSON.stringify({project_root:root,revision:fetched,previous:head}),{mode:0o600})
  }
  // Fast-forward never overwrites a diverged history or a local source edit.
  await run(['merge','--ff-only',fetched],15000)
  const revision=await run(['rev-parse','HEAD'])
  return activation(root,revision,head)
 } catch (error) { return {status:'unavailable',message:'本次更新检查未完成，继续使用现有工作流',reason:error.code||'CHECK_FAILED'} }
 finally { if(unlock) await unlock().catch(()=>{}) }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const args=process.argv.slice(2);const i=args.indexOf('--project-root')
 const root=i>=0?args[i+1]:undefined
 console.log(JSON.stringify(args.includes('--acknowledge') && root ? await acknowledgeUpdate(root) : await checkUpdate({apply:args.includes('--apply'),projectRoot:root}),null,2))
}
