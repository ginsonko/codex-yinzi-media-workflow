import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import {fileURLToPath} from 'node:url'
import {stateRoot,readJson} from './runtime-state.mjs'
import {atomicJson} from './runtime-data.mjs'

async function digestTree(root) {
  const hash=crypto.createHash('sha256')
  async function visit(relative) {
    for(const e of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const name=path.join(relative,e.name)
      if(e.isDirectory()) await visit(name)
      else {hash.update(name.replaceAll('\\','/'));hash.update(await fs.readFile(path.join(root,name)))}
    }
  }
  await visit('');return hash.digest('hex').slice(0,20)
}
export async function installSkills({projectRoot,skillsRoots,codexHome=process.env.CODEX_HOME || path.join(os.homedir(),'.codex')}={}) {
  const plugin=path.join(projectRoot,'codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow')
  const digest=await digestTree(plugin)
  const installed=path.join(stateRoot(),'skill-runtime',digest,'codex-yinzi-universal-video-workflow')
  const complete=path.join(path.dirname(installed),'complete.json')
  if(!await readJson(complete)) {
    await fs.mkdir(path.dirname(installed),{recursive:true})
    await fs.cp(plugin,installed,{recursive:true})
    await atomicJson(complete,{digest})
  }
  const recordFile=path.join(stateRoot(),'skill-installation.json')
  const previous=await readJson(recordFile)
  const roots=[...new Set((skillsRoots || [path.join(os.homedir(),'.agents/skills'),path.join(codexHome,'skills')]).map(p=>path.resolve(p)))]
  const pending=[]
  for(const e of await fs.readdir(path.join(installed,'skills'),{withFileTypes:true})) {
    if(!e.isDirectory()) continue
    const target=path.join(installed,'skills',e.name)
    await fs.access(path.join(target,'SKILL.md'))
    for(const root of roots) {
      const destination=path.join(root,e.name)
      const existing=await fs.lstat(destination).catch(error=>{if(error.code!=='ENOENT')throw error;return null})
      if(existing) {
        if(!existing.isSymbolicLink()) throw new Error(`保留用户已有 Skill：${destination}；请将同名自定义副本移到其他名称后重试`)
        const link=path.resolve(path.dirname(destination),await fs.readlink(destination))
        const owned=link===target || link===path.join(plugin,'skills',e.name) || previous?.links?.some(x=>path.resolve(x.path)===destination && path.resolve(x.target)===link)
        if(!owned) throw new Error(`保留来源未知的 Skill 链接：${destination}`)
        if(link===target) {pending.push({path:destination,target,unchanged:true});continue}
      }
      pending.push({path:destination,target,replace:Boolean(existing)})
    }
  }
  // Preflight ALL destinations before replacing any link. Never recurse through
  // a junction or erase its source; old copies remain available for rollback.
  const links=[]
  for(const entry of pending) {
    await fs.mkdir(path.dirname(entry.path),{recursive:true})
    if(!entry.unchanged) {
      if(entry.replace) await fs.unlink(entry.path)
      await fs.symlink(entry.target,entry.path,process.platform==='win32'?'junction':'dir')
    }
    await fs.access(path.join(entry.path,'SKILL.md'))
    links.push({path:entry.path,target:entry.target})
  }
  const receipt={ok:true,source_root:projectRoot,digest,installed_plugin:installed,links,mcp_entry:path.join(installed,'mcp/server.mjs')}
  await atomicJson(recordFile,receipt)
  return receipt
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);const option=n=>args[args.indexOf(n)+1]
  try {
    if(args.includes('--runtime-dir'))process.env.YINZI_WORKFLOW_RUNTIME_DIR=path.resolve(option('--runtime-dir'))
    const roots=args.flatMap((x,i)=>x==='--skills-root'?[args[i+1]]:[])
    const result=await installSkills({projectRoot:path.resolve(option('--project-root')),skillsRoots:roots.length?roots:undefined,codexHome:args.includes('--codex-home')?option('--codex-home'):undefined})
    console.log(JSON.stringify(result))
  } catch(error) {console.log(JSON.stringify({ok:false,error:error.message}));process.exitCode=3}
}
