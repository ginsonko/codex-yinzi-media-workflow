import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {readRegistry} from '../../../scripts/runtime-state.mjs'

const sha=value=>crypto.createHash('sha256').update(value).digest('hex')
const redact=(value,key)=>String(value).split(key||'\0').join('[REDACTED]').replace(/\bsk-[\w-]{8,}\b/g,'[REDACTED]').replace(/Bearer\s+\S+/gi,'Bearer [REDACTED]')
export async function runTextTask({request,config,output,post}) {
  if(!config || config.service_type!=='text' || config.is_active===false || config.is_active===0) throw new Error('请选择已启用的文字模型配置')
  if(!request.prompt?.trim()) throw new Error('prompt 不能为空')
  const model=request.model||config.default_model||config.model?.[0]
  if(!model) throw new Error('所选配置需要模型名称')
  const root=new URL(config.base_url)
  if(!['https:','http:'].includes(root.protocol) || root.username || root.password) throw new Error('模型 URL 无效')
  const endpoint=config.endpoint||'/chat/completions'
  const url=/\/chat\/completions\/?$/.test(root.pathname) ? root.href : root.href.replace(/\/$/,'')+'/'+endpoint.replace(/^\//,'')
  const body={model,messages:[...(request.system?[{role:'system',content:request.system}]:[]),{role:'user',content:request.prompt}],stream:false}
  for(const name of ['temperature','max_tokens','top_p']) if(request[name]!=null && Number.isFinite(Number(request[name]))) body[name]=Number(request[name])
  const fingerprint=sha(JSON.stringify({config_id:config.id,url,body})),receiptPath=output+'.receipt.json'
  await fs.mkdir(path.dirname(output),{recursive:true})
  let prior
  try {prior=JSON.parse(await fs.readFile(receiptPath,'utf8'))} catch(error) {if(error.code!=='ENOENT') throw error}
  if(prior) {
    if(prior.request_hash!==fingerprint) throw new Error('输出位置已有不同请求，请使用新的文件名')
    if(prior.status==='succeeded' && sha(await fs.readFile(output))===prior.output_sha256) return {...prior,reused:true}
    throw new Error('该请求已有提交记录，请先核对结果；不会自动重放')
  }
  try {await fs.access(output);throw new Error('输出文件已存在，请选择新文件名')} catch(error) {if(error.code!=='ENOENT')throw error}
  const receipt={schema:'yinzi.text-task/v1',config_id:config.id,model,request_hash:fingerprint,status:'submitted',started_at:new Date().toISOString()}
  await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2),{flag:'wx'})
  try {
    const response=await post(url,{Authorization:'Bearer '+config.api_key},body,Number(request.timeout_ms)||180000)
    if(response.statusCode<200||response.statusCode>=300) throw Object.assign(new Error('HTTP '+response.statusCode+': '+response.raw.slice(0,500)),{known:true,statusCode:response.statusCode})
    const json=JSON.parse(response.raw);let value=json.choices?.[0]?.message?.content??json.output_text??json.choices?.[0]?.text
    if(Array.isArray(value))value=value.map(x=>typeof x==='string'?x:x.text||'').join('')
    if(typeof value!=='string'||!value.trim())throw new Error('模型响应没有可用文本；保留提交记录以核对')
    await fs.writeFile(output,value,{flag:'wx'})
    Object.assign(receipt,{status:'succeeded',finished_at:new Date().toISOString(),output_sha256:sha(value),bytes:Buffer.byteLength(value),usage:json.usage||null})
    await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));return {...receipt,reused:false}
  } catch(error) {
    Object.assign(receipt,{status:error.known?'failed':'needs_review',finished_at:new Date().toISOString(),error:redact(error.message,config.api_key),http_status:error.statusCode||null})
    await fs.writeFile(receiptPath,JSON.stringify(receipt,null,2));throw new Error(receipt.error)
  }
}
async function main() {
  const idx=process.argv.indexOf('--input');if(idx<0)throw new Error('用法：text-task.mjs --input 请求.json')
  const input=path.resolve(process.argv[idx+1]);const request=JSON.parse(await fs.readFile(input,'utf8'))
  const registry=await readRegistry();if(!registry?.source_root||!registry.runtime_root)throw new Error('请先调用 open_workflow 或 runtime-launcher ensure')
  const require=createRequire(path.join(registry.source_root,'backend-node/package.json'))
  const yaml=require('js-yaml'),Database=require('better-sqlite3')
  let cfg
  for(const relative of ['configs/config.yaml','config.yaml']) {
    try {cfg=yaml.load(await fs.readFile(path.join(registry.runtime_root,relative),'utf8'));break} catch(error) {if(error.code!=='ENOENT')throw error}
  }
  if(!cfg?.database?.path)throw new Error('运行时数据库配置缺失')
  const db=new Database(path.resolve(registry.runtime_root,cfg.database.path),{readonly:true,fileMustExist:true})
  try {
    const service=require('./src/services/aiConfigService.js');const config=service.getConfig(db,Number(request.config_id))
    const output=path.resolve(path.dirname(input),request.output||'text-result.txt')
    const r=await runTextTask({request,config,output,post:require('./src/services/aiClient.js').postJSONWithTimeout})
    console.log(JSON.stringify({ok:true,...r,output}))
  } finally {db.close()}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1})
