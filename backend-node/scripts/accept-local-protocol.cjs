// Uses only the isolated acceptance server and local media fixtures.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),readline=require('node:readline');
const {run}=require('../src/services/componentRuntime');
const plugin=path.resolve(__dirname,'../../codex-yinzi-universal-video-workflow/plugins/codex-yinzi-universal-video-workflow');
const root=path.resolve(process.argv[2]),sourceRoot=path.resolve(process.argv[3]),info=JSON.parse(fs.readFileSync(path.join(root,'server.json')));
async function main(){
 const child=spawn(process.execPath,[path.join(plugin,'mcp/server.mjs')],{env:{...process.env,YINZI_WORKFLOW_URL:info.url},stdio:['pipe','pipe','pipe'],windowsHide:true});let id=0;const pending=new Map();
 readline.createInterface({input:child.stdout}).on('line',line=>{const msg=JSON.parse(line);pending.get(msg.id)?.(msg);});
 function call(name,args){return new Promise((resolve,reject)=>{const i=++id,t=setTimeout(()=>reject(Error('MCP timed out')),20000);pending.set(i,msg=>{clearTimeout(t);pending.delete(i);try{assert.ok(!msg.error&&!msg.result?.isError,JSON.stringify(msg));resolve(JSON.parse(msg.result.content[0].text));}catch(e){reject(e);}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:i,method:'tools/call',params:{name,arguments:args}})+'\n');});}
 try{
  const profile=await call('local_media_components',{});assert.equal(profile.components.length,2);
  const req={session_id:info.session_id,request_key:'mcp-picture-'+Date.now(),module_id:'local.image.join-border',input_path:path.join(sourceRoot,'source.png')};
  const job=await call('local_media_run',req),duplicate=await call('local_media_run',req);assert.equal(job.id,duplicate.id);
  let current;for(let i=0;i<120;i++){current=await call('local_media_get_job',{job_id:job.id});if(['succeeded','failed'].includes(current.status))break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(current.status,'succeeded',JSON.stringify(current.error));assert.equal((await call('local_media_resume',{job_id:job.id})).id,job.id);
  const request=path.join(root,'cli-request.json');fs.writeFileSync(request,JSON.stringify({...req,request_key:'cli-audio-'+Date.now(),module_id:'local.audio.pitch',input_path:path.join(sourceRoot,'source.wav')}));
  // CLI discovery uses its explicit local runtime URL.
  process.env.YINZI_WORKFLOW_URL=info.url;
  const cli=path.join(plugin,'skills/codex-yinzi-universal-video/scripts/orchestration-cli.mjs');
  const cliJob=JSON.parse((await run(process.execPath,[cli,'local-run','--input',request])).stdout);
  let cliResult;for(let i=0;i<120;i++){cliResult=JSON.parse((await run(process.execPath,[cli,'local-job',cliJob.id])).stdout);if(['succeeded','failed'].includes(cliResult.status))break;await new Promise(r=>setTimeout(r,250));}
  assert.equal(cliResult.status,'succeeded',JSON.stringify(cliResult.error));
  fs.writeFileSync(path.join(root,'protocol.json'),JSON.stringify({at:new Date().toISOString(),status:'passed',mcp:current,cli:cliResult,idempotency:true},null,2));console.log('MCP and CLI actual media acceptance passed');
 }finally{child.kill();}
}main().catch(e=>{console.error(e);process.exitCode=1;});
