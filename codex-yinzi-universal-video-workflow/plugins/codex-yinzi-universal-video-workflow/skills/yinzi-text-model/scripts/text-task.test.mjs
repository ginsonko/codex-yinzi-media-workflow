import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {runTextTask} from './text-task.mjs'
const config={id:17,service_type:'text',is_active:true,model:['same-model'],base_url:'https://example.invalid/v1',api_key:'test-private-credential'}
test('selected config and exact endpoint, unicode output and receipt reuse',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yinzi-text-'));const output=path.join(dir,'text.txt');let calls=0
 const args={config,request:{prompt:'写脚本'},output,post:async(url,headers,body)=>{
  calls++;assert.equal(url,'https://example.invalid/v1/chat/completions');assert.equal(body.model,'same-model');assert.equal(headers.Authorization,'Bearer test-private-credential')
  return {statusCode:200,raw:JSON.stringify({choices:[{message:{content:[{type:'text',text:'一段自然的中文。'}]}}],usage:{total_tokens:30}})}
 }}
 assert.equal((await runTextTask(args)).status,'succeeded');assert.equal((await runTextTask(args)).reused,true);assert.equal(calls,1)
 assert.equal(await fs.readFile(output,'utf8'),'一段自然的中文。')
 await assert.rejects(runTextTask({...args,request:{prompt:'另一段'}}),/不同请求/)
 assert.ok(!(await fs.readFile(output+'.receipt.json','utf8')).includes(config.api_key))
})
test('ambiguous response is not replayed; upstream errors redact the configured key',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yinzi-text-fail-'));const output=path.join(dir,'text.txt');let calls=0
 const args={config,request:{prompt:'test'},output,post:async()=>{calls++;throw new Error('connection lost '+config.api_key)}}
 await assert.rejects(runTextTask(args),/REDACTED/);await assert.rejects(runTextTask(args),/不会自动重放/);assert.equal(calls,1)
 const receipt=JSON.parse(await fs.readFile(output+'.receipt.json','utf8'));assert.equal(receipt.status,'needs_review');assert.ok(!receipt.error.includes(config.api_key))
})
test('existing output or disabled config sends no external request',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'yinzi-text-preserve-'));const output=path.join(dir,'keep.txt');await fs.writeFile(output,'keep');let calls=0
 const args={config,request:{prompt:'test'},output,post:async()=>{calls++}}
 await assert.rejects(runTextTask(args),/已存在/);await assert.rejects(runTextTask({...args,config:{...config,is_active:false}}),/启用/);assert.equal(calls,0);assert.equal(await fs.readFile(output,'utf8'),'keep')
})
