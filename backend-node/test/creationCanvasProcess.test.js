const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const { startCanvasHarness } = require('./helpers/canvasHarness');
const { uid } = require('../src/services/creationCanvas/store');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function wait(fn, predicate, timeout = 20000) { const start=Date.now(); let value; do { try { value=await fn(); if(predicate(value))return value; } catch (_) {} await sleep(60); }while(Date.now()-start<timeout);throw Error('Timeout: '+JSON.stringify(value)); }
test('actual server process cold restart preserves media and interrupts text without replaying providers', { timeout: 60000 }, async () => {
  let release; const held=new Promise(r=>{release=r;});
  const h=await startCanvasHarness({video:false,completion:async()=>{await held;return {content:'delayed response'};}});
  await h.canvas.close(); h.service.stop();
  const listener=net.createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const base='http://127.0.0.1:'+port;
  const config=path.join(h.root,'full-process.json');
  const cfg=require('js-yaml').load(fs.readFileSync(path.resolve(__dirname,'../configs/config.yaml'),'utf8'));
  Object.assign(cfg,{database:h.cfg.database,storage:h.cfg.storage});cfg.server={...cfg.server,port,host:'127.0.0.1'};
  fs.writeFileSync(config,JSON.stringify(cfg));
  let child, output='';
  async function start() { child=spawn(process.execPath,[path.resolve(__dirname,'../src/server.js')],{cwd:path.resolve(__dirname,'..'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,YINZI_WORKFLOW_ISOLATED:'1',YINZI_WORKFLOW_CONFIG:config,PORT:String(port),HOST:'127.0.0.1'}});child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);await wait(async()=>{const r=await fetch(base+'/health');return r.json();},v=>v.status==='ok'); }
  async function kill() { if(!child||child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited; }
  async function api(route,body,method=body?'POST':'GET') {const r=await fetch(base+'/api/v1/creation-canvases'+route,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const v=await r.json();assert.equal(r.ok,true,JSON.stringify(v));return v.data;}
  try {
    await start();const c=await api('/',{title:'cold restart'});
    await api('/'+c.id+'/operations',{request_id:uid(),operations:[{type:'add_node',id:'image',kind:'image',data:{prompt:'local test',settings:{image_config_id:h.configs.image.id,model:'gpt-image-2'}}}]});
    const job=await api('/'+c.id+'/generate',{request_id:uid(),node_ids:['image']});
    await wait(()=>api('/'+c.id+'/jobs/'+job.job_id),j=>j.status==='completed');
    await api('/'+c.id,{agent:{config_id:h.configs.text.id,model:'canvas-fixture-text'}},'PATCH');
    const run=await api('/'+c.id+'/messages',{request_id:uid(),message:'wait here'});
    await wait(()=>h.completions.length,n=>n===1);
    const mediaBefore=(await api('/'+c.id)).nodes[0].data.media;
    await kill();release();await start();
    const recovered=await api('/'+c.id);assert.equal(recovered.nodes[0].data.media.local_path,mediaBefore.local_path);
    assert.equal((await api('/'+c.id+'/runs/'+run.run_id)).status,'interrupted');
    await sleep(900);assert.equal(h.completions.length,1);assert.equal(h.submissions.length,1);
    const media=await fetch(base+'/api/v1/creation-canvases/'+c.id+'/nodes/image/media');assert.equal(media.status,200);assert.ok((await media.arrayBuffer()).byteLength>100);
  } catch(error) { console.error(output.slice(-3000));throw error; }
  finally {release();await kill();await h.close();}
});
