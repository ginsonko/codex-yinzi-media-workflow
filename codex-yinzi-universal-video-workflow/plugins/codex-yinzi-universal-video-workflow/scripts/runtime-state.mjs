import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
export function stateRoot() {
  if (process.env.YINZI_WORKFLOW_RUNTIME_DIR) return path.resolve(process.env.YINZI_WORKFLOW_RUNTIME_DIR)
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'Yinzi','CodexVideoWorkflow')
  if (process.platform === 'darwin') return path.join(os.homedir(),'Library','Application Support','Yinzi','CodexVideoWorkflow')
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(),'.local','state'),'yinzi-codex-video-workflow')
}
export async function readRegistry() { try { return JSON.parse(await fs.readFile(path.join(stateRoot(),'runtime.json'),'utf8')) } catch { return null } }
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
