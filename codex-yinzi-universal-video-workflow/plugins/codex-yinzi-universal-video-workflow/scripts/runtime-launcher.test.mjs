import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import os from 'node:os'
import net from 'node:net'

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'runtime-launcher.mjs')

function run(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

test('status is read-only when no runtime registry exists', async () => {
  const result = await run(['status', '--json'], { YINZI_WORKFLOW_RUNTIME_DIR: path.join(process.env.TEMP || '/tmp', `yinzi-runtime-status-${process.pid}`) })
  assert.equal(result.code, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.active, false)
})

test('unknown command fails with actionable JSON', async () => {
  const result = await run(['invalid', '--json'])
  assert.equal(result.code, 2)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, false)
  assert.match(payload.error, /ensure|status|stop/)
})

test('occupied port, concurrent opens, changed frontend, and existing configuration recover through one runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'yinzi launch space '))
  const source = path.join(root,'source');const state = path.join(root,'state')
  const env = { YINZI_WORKFLOW_RUNTIME_DIR:state, YINZI_WORKFLOW_URL:'', YINZI_WORKFLOW_PROJECT_ROOT:source }
  const listener=net.createServer()
  await new Promise(resolve=>listener.listen(0,'0.0.0.0',resolve))
  const occupied=listener.address().port
  let record
  try {
    for(const folder of ['backend-node/src','backend-node/configs','frontweb/src','frontweb/node_modules/vite/bin']) await fs.mkdir(path.join(source,folder),{recursive:true})
    await fs.writeFile(path.join(source,'backend-node/configs/config.yaml'),'app:\n  name: Test\nserver:\n  host: 0.0.0.0\n')
    await fs.writeFile(path.join(source,'backend-node/package.json'),'{}')
    await fs.writeFile(path.join(source,'frontweb/package.json'),'{}')
    await fs.writeFile(path.join(source,'frontweb/src/main.js'),'first version')
    await fs.writeFile(path.join(source,'frontweb/node_modules/vite/bin/vite.js'),`const fs=require('node:fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<div id="app"></div><script src="/app.js"></script>');fs.writeFileSync('dist/app.js','console.log('+JSON.stringify(fs.readFileSync('src/main.js','utf8'))+')');`)
    await fs.writeFile(path.join(source,'backend-node/src/server.js'),`const http=require('node:http'),fs=require('node:fs'),path=require('node:path');http.createServer((req,res)=>{if(req.url==='/health'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({status:'ok'}))}if(req.url==='/api/v1/runtime-identity'){res.setHeader('content-type','application/json');return res.end(JSON.stringify({data:{orchestration_router:true,runtime_id:'fixture-'+process.pid,database:{fingerprint:'fixture-db'},source_digest:process.env.YINZI_WORKFLOW_SOURCE_DIGEST,launch_token:process.env.YINZI_WORKFLOW_LAUNCH_TOKEN}}))}res.setHeader('content-type',req.url==='/app.js'?'application/javascript':'text/html');res.end(fs.readFileSync(path.join(process.env.WEB_DIST_PATH,req.url==='/app.js'?'app.js':'index.html')))}).listen(Number(process.env.PORT),'127.0.0.1');`)
    const args=['ensure','--json','--backend-port',String(occupied)]
    const results=await Promise.all([run(args,env),run(args,env)])
    for(const result of results) { assert.equal(result.code,0,result.stdout);const parsed=JSON.parse(result.stdout);assert.equal(parsed.ok,true);if(record) assert.equal(parsed.pid,record.pid);record=parsed }
    assert.notEqual(new URL(record.api_base).port,String(occupied))
    const configuration=path.join(record.runtime_root,'configs/config.yaml');await fs.appendFile(configuration,'custom_setting: preserve-me\n')
    await fs.writeFile(path.join(source,'frontweb/src/main.js'),'updated version')
    const third=await run(args,env);assert.equal(third.code,0,third.stdout);const reopened=JSON.parse(third.stdout)
    assert.equal(reopened.pid,record.pid);assert.equal(reopened.database_fingerprint,record.database_fingerprint)
    assert.match(await fs.readFile(configuration,'utf8'),/preserve-me/)
    assert.match(await (await fetch(record.api_base+'/app.js')).text(),/updated version/)
    // A stale registry must not authorize stopping an unrelated listener.
    const registryFile=path.join(state,'runtime.json')
    const original=await fs.readFile(registryFile,'utf8')
    await fs.writeFile(registryFile,JSON.stringify({...JSON.parse(original),runtime_id:'different-instance'}))
    const denied=await run(['stop','--json'],env)
    assert.equal(denied.code,3)
    assert.equal((await fetch(record.api_base+'/health')).status,200)
    await fs.writeFile(registryFile,original)
    const stopped=await run(['stop','--json'],env)
    assert.equal(stopped.code,0,stopped.stdout)
    const restarted=await run(args,env)
    assert.equal(restarted.code,0,restarted.stdout)
    const next=JSON.parse(restarted.stdout)
    assert.equal(next.runtime_root,record.runtime_root)
    assert.equal(next.database_fingerprint,record.database_fingerprint)
    assert.notEqual(next.pid,record.pid)
    record=next
    assert.match(await fs.readFile(configuration,'utf8'),/preserve-me/)
  } finally {
    if(record?.pid) await run(['stop','--json'],env)
    await new Promise(resolve=>listener.close(resolve))
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})
  }
})
