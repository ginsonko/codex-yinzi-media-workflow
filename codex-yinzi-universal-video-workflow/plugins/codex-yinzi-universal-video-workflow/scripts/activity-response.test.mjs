import assert from 'node:assert/strict'
import {test} from 'node:test'
import http from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {activityResponse} from '../skills/codex-yinzi-universal-video/scripts/activity-response.mjs'

const legacy = {session:{id:'existing',status:'paused',version:9,source_context:{analysis_report:'r'.repeat(100000),activity:{stage:'edit',state:'working',message:'已完成剪辑',next_action:'检查',needs_user:false}}},events:[{payload:'x'.repeat(200000)}],artifacts:[{id:'keep'}]}

test('legacy receipt is small, explicit full is lossless, unknown replay stays unknown',()=>{
  const result=activityResponse(legacy)
  assert.equal(result.session.status,'paused')
  assert.equal(result.activity.message,'已完成剪辑')
  assert.equal(result.reused,null)
  assert.equal(result.event,null)
  assert.equal(result.analysis_report_available,true)
  assert.ok(JSON.stringify(result).length<1000)
  assert.strictEqual(activityResponse(legacy,'full'),legacy)
  assert.equal(legacy.events[0].payload.length,200000)
})
test('new summary preserves replay and event identity, bounds Unicode text with a full-read pointer',()=>{
  const result=activityResponse({response_detail:'summary',reused:true,session:legacy.session,event:{id:123,event_type:'activity.reported',payload:'omit'},analysis_report_available:true,activity:{message:'🎬'.repeat(10000),state:'waiting',needs_user:true}})
  assert.equal(result.reused,true)
  assert.equal(result.event.id,123)
  assert.equal(result.event.payload,undefined)
  assert.equal([...result.activity.message].length,1601)
  assert.deepEqual(result.truncated_fields,['activity.message'])
  assert.equal(result.details_path,'/api/v1/orchestration-sessions/existing')
  assert.ok(!result.activity.message.includes('\ufffd'))
  assert.deepEqual(activityResponse({error:{code:'failure'}}),{error:{code:'failure'}})
})
test('real CLI defaults to compact against old runtime and supports explicit full',async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'yinzi-activity-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const bodies=[]
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json')
    if(req.url==='/health')return res.end(JSON.stringify({status:'ok'}))
    if(req.url==='/api/v1/runtime-identity')return res.end(JSON.stringify({data:{schema:'test',orchestration_router:true}}))
    if(req.url.includes('__codex_capability_probe__')){res.statusCode=404;return res.end(JSON.stringify({error:{code:'ORCHESTRATION_NOT_FOUND'}}))}
    if(req.url==='/api/v1/orchestration-sessions/existing/activity'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk)
      bodies.push(JSON.parse(Buffer.concat(chunks)))
      return res.end(JSON.stringify({success:true,data:legacy}))
    }
    res.statusCode=404;res.end('{}')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const cli=fileURLToPath(new URL('../skills/codex-yinzi-universal-video/scripts/orchestration-cli.mjs',import.meta.url))
  const input=path.join(dir,'input.json')
  async function run(body){
    await writeFile(input,JSON.stringify(body))
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[cli,'activity','existing','--input',input],{windowsHide:true,env:{...process.env,YINZI_WORKFLOW_URL:`http://127.0.0.1:${server.address().port}`}})
      let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
      child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}))
    })
  }
  const small=await run({message:'检查',event_idempotency_key:'once'})
  assert.equal(small.code,0,small.stderr)
  assert.equal(bodies[0].response_detail,'summary')
  assert.ok(small.stdout.length<1500)
  assert.equal(JSON.parse(small.stdout).session.id,'existing')
  const full=await run({message:'检查',event_idempotency_key:'once',response_detail:'full'})
  assert.equal(full.code,0,full.stderr)
  assert.equal(bodies[1].response_detail,'full')
  assert.deepEqual(JSON.parse(full.stdout),legacy)
})
