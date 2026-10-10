// Starts this checkout as an isolated local preview. No installed runtime,
// credentials or user database is copied or replaced.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const data = path.resolve(process.env.YINZI_CANVAS_PREVIEW_DATA || path.join(root, '.yinzi-local', 'canvas-preview'));
const manifest = path.join(data, 'preview.json');
async function availablePort(preferred) {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', error => preferred && error.code === 'EADDRINUSE' ? availablePort(0).then(resolve,reject) : reject(error)); server.listen(preferred,'127.0.0.1',() => { const port=server.address().port; server.close(() => resolve(port)); }); });
}
(async () => {
  if (fs.existsSync(manifest)) {
    const old = JSON.parse(fs.readFileSync(manifest));
    try { const health = await fetch(old.url + '/api/v1/runtime-identity', { signal: AbortSignal.timeout(1200) }); const body = await health.json(); if (body.data?.pid === old.pid) { console.log(JSON.stringify({ ...old, reused:true })); return; } } catch (_) {}
  }
  fs.mkdirSync(path.join(data,'storage'), {recursive:true});
  const yaml = require(path.join(root,'backend-node/node_modules/js-yaml'));
  const cfg = yaml.load(fs.readFileSync(path.join(root,'backend-node/configs/config.yaml'),'utf8'));
  const port = await availablePort(Number(process.env.YINZI_CANVAS_PREVIEW_PORT) || 64410), url = 'http://127.0.0.1:' + port;
  cfg.database.path = path.join(data,'canvas-preview.db');
  cfg.storage.local_path = path.join(data,'storage'); cfg.storage.base_url = url + '/static';
  cfg.server.port=port; cfg.server.host='127.0.0.1'; cfg.server.cors_origins=[url];
  const config = path.join(data,'config.json'); fs.writeFileSync(config,JSON.stringify(cfg,null,2));
  const child = spawn(process.execPath,[path.join(root,'backend-node/src/server.js')],{cwd:path.join(root,'backend-node'),windowsHide:true,stdio:'inherit',env:{...process.env,
    YINZI_WORKFLOW_ISOLATED:'1',YINZI_WORKFLOW_CONFIG:config,PORT:String(port),HOST:'127.0.0.1',WEB_DIST_PATH:path.join(root,'frontweb/dist'),YINZI_WORKFLOW_RUNTIME_ORIGIN:url}});
  const receipt={pid:child.pid,url,canvas_url:url+'/create-canvas',source:root,data,config,started_at:new Date().toISOString()};
  fs.writeFileSync(manifest,JSON.stringify(receipt,null,2)); console.log(JSON.stringify(receipt));
  child.on('exit',code=>{process.exitCode=code || 0;});
  child.on('error',error=>{console.error(error.message);process.exitCode=1;});
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
})().catch(error=>{console.error(error);process.exitCode=1;});
