import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {stateRoot,readJson} from './runtime-state.mjs'

export const dbFingerprint=file=>crypto.createHash('sha256').update('database-path:'+path.resolve(file).replace(/[\\/]+/g,'/').toLowerCase()).digest('hex').slice(0,16)
const exists=async file=>Boolean(await fs.stat(file).catch(()=>null))
export async function atomicJson(file,value) {
  await fs.mkdir(path.dirname(file),{recursive:true})
  const tmp=file+'.'+process.pid+'.'+crypto.randomUUID()+'.tmp'
  await fs.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600})
  await fs.rename(tmp,file)
}
export async function inspectData(source,root) {
  root=path.resolve(root)
  const require=createRequire(path.join(source,'backend-node/package.json'))
  const configFile=await exists(path.join(root,'configs/config.yaml'))?path.join(root,'configs/config.yaml'):
    await exists(path.join(root,'config.yaml'))?path.join(root,'config.yaml'):path.join(source,'backend-node/configs/config.yaml')
  const config=require('js-yaml').load(await fs.readFile(configFile,'utf8'))
  if(!config?.database?.path || config.database.path===':memory:') throw new Error('缺少可持久化的数据库配置；原数据未改动')
  const database=path.resolve(root,config.database.path)
  const result={runtime_root:root,config_path:configFile,database_path:database,database_fingerprint:dbFingerprint(database),exists:await exists(database),counts:{}}
  if(result.exists) {
    const Database=require('better-sqlite3');const db=new Database(database,{readonly:true,fileMustExist:true})
    try {
      const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
      // Only counts and identity leave the database, never prompts or keys.
      for(const {name} of tables) result.counts[name]=db.prepare('SELECT COUNT(*) AS n FROM "'+name.replaceAll('"','""')+'"').get().n
    } finally {db.close()}
  }
  return result
}
function hasRecords(info) {
  return Object.entries(info.counts).some(([name,count])=>count>0 && /^(orchestration_|media_batches|video_generations|image_generations|dramas|episodes|production_|ai_configs)/.test(name))
}
export async function discoverData(source,registered,extraRoots=[]) {
  const install=await readJson(path.join(stateRoot(),'installation.json'))
  const roots=[registered?.runtime_root,install?.runtime_root,
    ...[source,install?.source_root].filter(Boolean).flatMap(root=>[root,path.join(root,'backend-node')]),
    path.join(stateRoot(),'runtimes/default'),...extraRoots].filter(Boolean)
  const found=[];const seen=new Set()
  for(const root of roots) {
    const info=await inspectData(source,root)
    if(info.exists && !seen.has(info.database_fingerprint)) {seen.add(info.database_fingerprint);found.push(info)}
  }
  return found
}
export async function resolveData(source,registered,explicitRoot) {
  const file=path.join(stateRoot(),'data-binding.json')
  const binding=await readJson(file)
  if(binding && explicitRoot && path.resolve(explicitRoot)!==path.resolve(binding.runtime_root))
    throw new Error('该安装已绑定原数据库；切换数据请使用独立 --runtime-dir 或先检查 doctor，不能覆盖原绑定')
  let root=binding?.runtime_root || explicitRoot || registered?.runtime_root
  if(!root) {
    const candidates=await discoverData(source,registered)
    const populated=candidates.filter(hasRecords)
    if(populated.length>1) throw new Error('发现多个包含任务的数据目录，已保留全部数据；运行 doctor 核对后用 --runtime-root 指定原目录')
    root=(populated[0] || candidates[0])?.runtime_root
    if(!root && await exists(path.join(stateRoot(),'installation.json')))
      throw new Error('已有安装记录但未定位原数据库；请运行 doctor 查找原数据，不会新建空库遮蔽历史')
    root ||= path.join(stateRoot(),'runtimes/default')
  }
  const info=await inspectData(source,root)
  const expected=binding?.database_fingerprint || registered?.database_fingerprint
  if(expected && expected!==info.database_fingerprint) throw new Error('数据库配置指向不同文件，已停止启动以保护原任务；请核对 data-binding.json 与原配置')
  if((binding?.initialized || registered?.database_fingerprint) && !info.exists)
    throw new Error('原数据库文件不可访问，可能磁盘未挂载或路径改变；不会建立新空库，请恢复原路径或备份')
  // Pin the data location BEFORE the process starts. runtime.json may be lost
  // or replaced later; source upgrades cannot change this independent binding.
  await atomicJson(file,{...binding,...info,initialized:binding?.initialized || info.exists,counts:undefined})
  return info
}
export async function backupData(source,info,reason) {
  if(!info.exists) return null
  const folder=path.join(stateRoot(),'backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID().slice(0,8))
  await fs.mkdir(folder,{recursive:true,mode:0o700})
  const require=createRequire(path.join(source,'backend-node/package.json'))
  const Database=require('better-sqlite3');const db=new Database(info.database_path,{readonly:true,fileMustExist:true})
  try { await db.backup(path.join(folder,'database.sqlite')) } finally {db.close()}
  // Copy only locally, keep private: configuration may contain credentials.
  await fs.copyFile(info.config_path,path.join(folder,'config.yaml'))
  await fs.chmod(path.join(folder,'config.yaml'),0o600)
  await fs.chmod(path.join(folder,'database.sqlite'),0o600)
  const receipt={schema:'yinzi.upgrade-backup/v1',...info,reason,backup:path.join(folder,'database.sqlite'),created_at:new Date().toISOString()}
  await atomicJson(path.join(folder,'receipt.json'),receipt)
  await atomicJson(path.join(stateRoot(),'upgrade-backup.json'),receipt)
  return receipt
}
export async function verifyContinuity(source,before) {
  const after=await inspectData(source,before.runtime_root)
  if(after.database_fingerprint!==before.database_fingerprint) throw new Error('升级后数据库身份变化；保留备份，未确认升级成功')
  // Session IDs and recorded actions are never pruned by normal startup.
  for(const table of ['orchestration_sessions','orchestration_nodes','orchestration_events','orchestration_receipts','orchestration_artifacts','media_batches']) {
    if((after.counts[table]||0)<(before.counts[table]||0)) throw new Error(`升级后 ${table} 记录减少；保留备份，未确认升级成功`)
  }
  await atomicJson(path.join(stateRoot(),'data-binding.json'),{...after,initialized:true,counts:undefined})
  return {verified:true,database_fingerprint:after.database_fingerprint,counts:after.counts}
}
