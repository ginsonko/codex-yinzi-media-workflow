import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import {existsSync} from 'node:fs'
import { spawn } from 'node:child_process'
export function stateRoot() {
  if (process.env.YINZI_WORKFLOW_RUNTIME_DIR) return path.resolve(process.env.YINZI_WORKFLOW_RUNTIME_DIR)
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'Yinzi','CodexVideoWorkflow')
  const canonical=process.platform==='darwin'?path.join(os.homedir(),'Library','Application Support','Yinzi','CodexVideoWorkflow'):
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(),'.local','state'),'yinzi-codex-video-workflow')
  const legacy=path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(),'.local','state'),'codex-yinzi-media-workflow')
  const registered=root=>['runtime.json','data-binding.json','installation.json'].some(name=>existsSync(path.join(root,name)))
  if(registered(canonical) && registered(legacy)) throw new Error('发现两套旧安装状态目录；请通过 --runtime-dir 选择原数据目录，不会自动创建第三套数据')
  return registered(legacy)?legacy:canonical
}
export async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file,'utf8')).replace(/^\uFEFF/,'')) }
  catch(error) { if(error.code==='ENOENT') return null; throw new Error(`登记文件不可读，已保留数据：${file}`, {cause:error}) }
}
export async function readRegistry() {
  const file=path.join(stateRoot(),'runtime.json')
  try { const value=await readJson(file);if(value) return value }
  catch(error) { const backup=await readJson(file+'.bak');if(backup?.runtime_root) return {...backup,registry_recovered:true};throw error }
  return await readJson(file+'.bak')
}
export function localOrigin(value) { const url = new URL(value); if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('工作台地址必须是本机 HTTP 地址'); return url.origin }
export async function verifyUi(origin) {
  try {
    origin = localOrigin(origin)
    const response = await fetch(`${origin}/`, { signal:AbortSignal.timeout(5000) }); const html=await response.text()
    if (!response.ok || !/id=["']app["']/.test(html)) return false
    const scripts=[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map(match=>new URL(match[1],origin))
    if (!scripts.length || scripts.some(url=>url.origin!==new URL(origin).origin)) return false
    for (const url of scripts) { const asset=await fetch(url,{signal:AbortSignal.timeout(5000)}); if (!asset.ok || !/javascript/.test(asset.headers.get('content-type') || '') || /^\s*<!doctype/i.test(await asset.text())) return false }
    return true
  } catch { return false }
}
export async function openBrowser(url) {
  localOrigin(url)
  const executable = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler',url] : [url]
  try { await new Promise((resolve,reject)=> { const child=spawn(executable,args,{detached:true,stdio:'ignore',windowsHide:true}); child.once('error',reject); child.once('spawn',()=>{child.unref();resolve()}) }); return { requested:true } }
  catch(error) { return { requested:false, error:error.message, url } }
}
