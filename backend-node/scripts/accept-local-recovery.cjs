const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process'),readline=require('node:readline');
const root=path.resolve(process.argv[2]),componentRoot=path.resolve(process.argv[3]),source=path.resolve(process.argv[4]);
const pause=ms=>new Promise(r=>setTimeout(r,ms));let active;
async function start(){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,'serve-local-media-acceptance.cjs'),root,componentRoot],{stdio:['ignore','pipe','pipe'],windowsHide:true});active=child;let stderr='';const timer=setTimeout(()=>reject(Error('server start timeout '+stderr)),20000);child.stderr.on('data',b=>stderr+=b);readline.createInterface({input:child.stdout}).on('line',line=>{if(line.startsWith('{"url":')){clearTimeout(timer);resolve({child,...JSON.parse(line)});}});});}
async function stop(child){if(child.exitCode!==null)return;await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
async function request(base,route,body,method=body?'POST':'GET'){const response=await fetch(base+'/api/v1/'+route,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.ok(response.ok&&data.success!==false,JSON.stringify(data));return data.data;}
async function main(){
 fs.mkdirSync(root,{recursive:true});const first=await start();
 const bundle=await request(first.url,'orchestration-sessions/'+first.session_id);
 const plan=await request(first.url,'orchestration-sessions/'+first.session_id+'/plan',{expected_revision:bundle.session.plan_revision||0,nodes:[{node_key:'image-border',module_id:'local.image.join-border',title:'恢复后继续加边框',executor:'local'}],edges:[]},'PUT');
 const body={session_id:first.session_id,request_key:'recovery-'+Date.now(),node_key:'image-border',module_id:'local.image.join-border',input_path:source};
 const created=await request(first.url,'local-media/jobs',body);await stop(first.child);
 const second=await start();let job;
 for(let i=0;i<160;i++){job=await request(second.url,'local-media/jobs/'+created.id);if(['failed','succeeded'].includes(job.status))break;await pause(250);}
 assert.equal(job.status,'succeeded',JSON.stringify(job.error));const after=await request(second.url,'orchestration-sessions/'+second.session_id);assert.equal(after.nodes.find(n=>n.node_key==='image-border').status,'succeeded');
 assert.equal((await request(second.url,'local-media/jobs',body)).id,created.id);
 fs.writeFileSync(path.join(root,'recovery.json'),JSON.stringify({at:new Date().toISOString(),status:'passed',old_pid:first.pid,new_pid:second.pid,job,node_status:'succeeded',idempotency:true},null,2));await stop(second.child);console.log('Actual process restart and node continuation passed');
}main().catch(e=>{active?.kill();console.error(e);process.exitCode=1;});
