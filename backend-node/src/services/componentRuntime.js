const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Transform, Readable } = require('node:stream');
const AdmZip = require('adm-zip');
const dependencyLock = require('../../../scripts/dependencies.json');
const ROOT = path.resolve(__dirname, '../..');
const MAX_BYTES = 512 * 1024 ** 2;
const HOSTS = new Set(['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com','www.gyan.dev']);
const fail = (code, message) => Object.assign(new Error(message), { code });
function safeId(value) { if (!/^[a-z][a-z0-9.-]{1,99}$/.test(value || '')) throw fail('INVALID_COMPONENT_ID','组件编号无效'); return value; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return null; } }
function writeJson(file, value) { fs.mkdirSync(path.dirname(file),{recursive:true}); const tmp=file+'.'+crypto.randomUUID()+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(value,null,2)); fs.renameSync(tmp,file); }
async function sha256(file) { const h=crypto.createHash('sha256'); for await(const b of fs.createReadStream(file)) h.update(b); return h.digest('hex'); }
function installedFiles(root,relative='') { return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).flatMap(item=>{const name=path.join(relative,item.name);if(item.isSymbolicLink())throw fail('UNSAFE_COMPONENT_LINK','组件目录含有未支持的链接');return item.isDirectory()?installedFiles(root,name):[name];}); }
function machineProfile() { return { platform:process.platform,arch:process.arch,cpu_count:os.cpus().length,memory_gib:Math.round(os.totalmem()/1024**3*10)/10,free_memory_gib:Math.round(os.freemem()/1024**3*10)/10,gpu:'not_probed',acceleration:'cpu',recommended_concurrency:Math.max(1,Math.min(4,Math.floor(os.freemem()/1024**3/2),os.cpus().length>>1)) }; }
function registry() { return [
  { component_id:'media.ffmpeg',version:dependencyLock.ffmpeg.version,kind:'zip',platforms:['win32-x64'],urls:[dependencyLock.ffmpeg.url,dependencyLock.ffmpeg.fallback_url],sha256:dependencyLock.ffmpeg.sha256,license:dependencyLock.ffmpeg.license,source:dependencyLock.ffmpeg.source,disk_bytes:800*1024**2,executables:{ffmpeg:'ffmpeg-9.0.1-essentials_build/bin/ffmpeg.exe',ffprobe:'ffmpeg-9.0.1-essentials_build/bin/ffprobe.exe'} },
  { component_id:'media.sharp',version:'0.35.3',kind:'npm',platforms:['win32-x64'],sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT,'components/sharp/package-lock.json'))).digest('hex'),license:'Apache-2.0; libvips LGPL-2.1-or-later',source:'https://github.com/lovell/sharp',disk_bytes:300*1024**2 }
]; }
function trustedUrl(url) { const u=new URL(url); if(u.protocol!=='https:'||u.username||u.password||!HOSTS.has(u.hostname)) throw fail('UNTRUSTED_COMPONENT_SOURCE','组件来源不在受信 HTTPS 清单'); return u.href; }
function run(executable,args,options={}) { return new Promise((resolve,reject)=>{
  const child=spawn(executable,args,{cwd:options.cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']}); let stdout='',stderr='';
  const timer=setTimeout(()=>child.kill(),options.timeout||30000);
  child.stdout.on('data',b=>{stdout=(stdout+b).slice(-1024*1024);options.onOutput?.(String(b));}); child.stderr.on('data',b=>{stderr=(stderr+b).slice(-1024*1024);});
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);code===0?resolve({stdout,stderr}):reject(fail('COMPONENT_PROCESS_FAILED',`本地进程未完成 (${code}): ${stderr.slice(-1500)}`));});
}); }
async function download(url,target,digest,onProgress=()=>{},fetcher=fetch) {
  if(fs.existsSync(target)&&await sha256(target)===digest){onProgress({stage:'cache_reused',bytes:fs.statSync(target).size});return;}
  let offset=fs.existsSync(target)?fs.statSync(target).size:0,response,next=trustedUrl(url);
  const controller=new AbortController();let idle;const reset=()=>{clearTimeout(idle);idle=setTimeout(()=>controller.abort(),45000);};reset();
  try {
    for(let hop=0;hop<6;hop++) { response=await fetcher(next,{redirect:'manual',headers:offset?{Range:`bytes=${offset}-`}:{},signal:controller.signal}); if(![301,302,303,307,308].includes(response.status))break;const location=response.headers.get('location');await response.body?.cancel();next=trustedUrl(new URL(location,next).href); }
    if(response.status===416&&offset){await response.body?.cancel();fs.unlinkSync(target);return download(url,target,digest,onProgress,fetcher);}
    if(![200,206].includes(response.status)||!response.body)throw fail('COMPONENT_DOWNLOAD_FAILED',`组件下载 HTTP ${response.status}`);
    let total=Number(response.headers.get('content-length'))||null;
    if(response.status===206){const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');if(!match||Number(match[1])!==offset){await response.body.cancel();throw fail('INVALID_CONTENT_RANGE','下载断点不匹配');}total=Number(match[3]);}else offset=0;
    if(total>MAX_BYTES){await response.body.cancel();throw fail('COMPONENT_TOO_LARGE','组件包超过大小限制');}
    let bytes=offset,last=0;const meter=new Transform({transform(chunk,encoding,cb){reset();bytes+=chunk.length;if(bytes>MAX_BYTES||(total&&bytes>total))return cb(fail('COMPONENT_TOO_LARGE','下载字节超出限制'));if(Date.now()-last>250){last=Date.now();onProgress({stage:'download',bytes,total_bytes:total,percent:total?Math.round(bytes/total*100):null});}cb(null,chunk);}});
    await pipeline(Readable.fromWeb(response.body),meter,fs.createWriteStream(target,{flags:offset?'a':'w'}));
    if(total&&bytes!==total)throw fail('INCOMPLETE_DOWNLOAD','下载尚未完整，已保存断点');onProgress({stage:'verify',bytes,total_bytes:total});
    if(await sha256(target)!==digest){fs.unlinkSync(target);throw fail('COMPONENT_HASH_MISMATCH','组件 SHA-256 不匹配，已丢弃损坏缓存');}
  }finally{clearTimeout(idle);}
}
function extractZip(archive,destination){const zip=new AdmZip(archive);let bytes=0;const names=new Set();
  for(const entry of zip.getEntries()){
    const name=entry.entryName.replaceAll('\\','/'),parts=name.replace(/\/$/,'').split('/'),mode=(entry.attr>>>16)&0xf000;
    if(!name||path.posix.isAbsolute(name)||parts.some(p=>!p||p==='.'||p==='..'||/[:\x00-\x1f]/.test(p)||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p))||mode===0xa000||names.has(name.toLowerCase()))throw fail('UNSAFE_ARCHIVE','组件归档包含不安全路径或链接');
    names.add(name.toLowerCase());bytes+=entry.header.size;if(bytes>2*1024**3||names.size>10000)throw fail('ARCHIVE_TOO_LARGE','组件解压内容超限');
    const target=path.resolve(destination,...parts);if(!target.startsWith(path.resolve(destination)+path.sep))throw fail('UNSAFE_ARCHIVE','组件路径越界');
    if(entry.isDirectory)fs.mkdirSync(target,{recursive:true});else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,entry.getData());}
  }
}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
async function lock(root,id){fs.mkdirSync(root,{recursive:true});const file=path.join(root,'.'+id+'.lock'),start=Date.now();
  while(true){try{fs.mkdirSync(file);writeJson(path.join(file,'owner.json'),{pid:process.pid});return()=>fs.rmSync(file,{recursive:true,force:true});}catch(e){
    if(e.code!=='EEXIST')throw e;const owner=readJson(path.join(file,'owner.json'));
    if((owner?.pid&&!alive(owner.pid))||(!owner&&Date.now()-fs.statSync(file).mtimeMs>30000)){try{fs.renameSync(file,file+'.stale-'+crypto.randomUUID());}catch{}continue;}
    if(Date.now()-start>20*60*1000)throw fail('COMPONENT_BUSY','组件仍在另一任务中准备');await new Promise(r=>setTimeout(r,150));
  }}
}
function createComponentManager(options={}){
  const root=path.resolve(options.root||process.env.YINZI_WORKFLOW_COMPONENT_DIR||path.join(ROOT,'data/media-components')),manifests=options.registry||registry(),inFlight=new Map(), verified=new Map();
  function manifestFor(id){const m=manifests.find(m=>m.component_id===safeId(id));if(!m)throw fail('COMPONENT_NOT_REGISTERED','组件尚未通过注册验收');return m;}
  function readState(id){manifestFor(id);return readJson(path.join(root,id,'current.json'));}
  function readProgress(id){manifestFor(id);return readJson(path.join(root,id,'progress.json'));}
  async function probe(m,dir){
    if(options.probe)return options.probe(m,dir);
    if(m.kind==='npm'){const code="(async()=>{const s=require('sharp');const b=await s({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();if(!b.length)throw Error('empty');console.log(JSON.stringify({sharp:s.versions.sharp,bytes:b.length}))})().catch(e=>{console.error(e.message);process.exit(1)})";return(await run(process.execPath,['-e',code],{cwd:dir})).stdout.trim();}
    return Promise.all(Object.values(m.executables).map(async file=>(await run(path.join(dir,file),['-version'])).stdout.split(/\r?\n/)[0]));
  }
  async function install(id,listeners){
    const m=manifestFor(id);if(!m.platforms.includes(process.platform+'-'+process.arch))throw fail('COMPONENT_PLATFORM_UNVERIFIED','此组件尚未通过当前系统实机验收，原任务保留');
    const release=await lock(root,id),dir=path.join(root,id);
    const report=event=>{const value={component_id:id,...event,updated_at:new Date().toISOString()};writeJson(path.join(dir,'progress.json'),value);for(const fn of listeners)fn(value);};
    try{
      const current=readState(id);
      if(current?.sha256===m.sha256&&current.status==='ready'){try{
        if(m.kind==='npm'&&!Object.keys(current.files||{}).some(file=>file.endsWith('.node')))throw Error('native integrity receipt missing');
        const signature=JSON.stringify([current.directory,...Object.keys(current.files||{}).map(f=>{const s=fs.statSync(path.join(current.directory,f));return[f,s.size,s.mtimeMs];})]);
        if(verified.get(id)!==signature){for(const[f,h]of Object.entries(current.files||{}))if(await sha256(path.join(current.directory,f))!==h)throw Error('changed');await probe(m,current.directory);verified.set(id,signature);}
        report({stage:'reused',percent:100});return{...current,reused:true};
      }catch{verified.delete(id);report({stage:'repair',message:'组件文件失效，自动重新准备'});}}
      const stat=fs.statfsSync(root);if(stat.bavail*stat.bsize<m.disk_bytes)throw fail('INSUFFICIENT_DISK','组件安装空间不足，原任务已保留');
      const next=path.join(dir,'versions',m.sha256.slice(0,12)+'-'+crypto.randomUUID());fs.mkdirSync(next,{recursive:true});report({stage:'preparing',message:'正在准备组件，完成后自动继续'});
      if(m.kind==='zip'){
        const cache=path.join(root,'.cache');fs.mkdirSync(cache,{recursive:true});const archive=path.join(cache,m.sha256+'.part');let error;
        for(const url of m.urls){try{await download(url,archive,m.sha256,report,options.fetch);error=null;break;}catch(e){error=e;}}if(error)throw error;
        report({stage:'install',message:'下载已验证，正在解压'});extractZip(archive,next);
      }else{
        const template=path.join(ROOT,'components/sharp');for(const file of ['package.json','package-lock.json'])fs.copyFileSync(path.join(template,file),path.join(next,file));
        const cli=[process.env.npm_execpath,path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')].find(p=>p&&fs.existsSync(p));
        if(!cli)throw fail('NPM_RUNTIME_MISSING','工作流 Node/npm 运行时不完整');report({stage:'install',message:'正在下载锁定版本的图像组件'});
        await run(process.execPath,[cli,'ci','--ignore-scripts','--no-audit','--no-fund','--registry=https://registry.npmjs.org','--fetch-retries=2'],{cwd:next,timeout:15*60*1000});
      }
      report({stage:'healthcheck',message:'组件已安装，正在实际运行检查'});const health=await probe(m,next),files={};for(const file of m.kind==='npm'?installedFiles(next):Object.values(m.executables))files[file]=await sha256(path.join(next,file));
      const state={component_id:id,version:m.version,sha256:m.sha256,status:'ready',directory:next,files,installed_at:new Date().toISOString(),healthcheck_result:health,platform:process.platform,arch:process.arch,executables:m.executables?Object.fromEntries(Object.entries(m.executables).map(([k,v])=>[k,path.join(next,v)])):{},previous:current?.directory||null};
      // Activate only after health succeeds. Old files survive every failure.
      writeJson(path.join(dir,'current.json'),state);report({stage:'ready',percent:100});return state;
    }catch(error){report({stage:'failed',code:error.code||'COMPONENT_INSTALL_FAILED',message:error.message,retryable:true});throw error;}finally{release();}
  }
  function ensureComponent(input,onProgress=()=>{}){const id=typeof input==='string'?input:input?.component_id;manifestFor(id);
    if(typeof input==='object'&&Object.keys(input).some(k=>k!=='component_id'))throw fail('UNTRUSTED_MANIFEST','请按组件编号选择受信版本，不接受任意安装清单');
    if(inFlight.has(id)){const item=inFlight.get(id);item.listeners.add(onProgress);return item.promise;}
    const listeners=new Set([onProgress]),promise=install(id,listeners).finally(()=>inFlight.delete(id));inFlight.set(id,{promise,listeners});return promise;
  }
  function runtimeComponents(){return manifests.map(m=>({component_id:m.component_id,version:m.version,license:m.license,source:m.source,status:readState(m.component_id)?.status||'missing',auto_install:m.platforms.includes(process.platform+'-'+process.arch),progress:readProgress(m.component_id)}));}
  return{ensureComponent,readState,readProgress,runtimeComponents,machineProfile,root};
}
let singleton;function instance(){return singleton||=createComponentManager();}
module.exports={createComponentManager,machineProfile,sha256,download,extractZip,run,writeJson,readJson,registry,
  ensureComponent:(...args)=>instance().ensureComponent(...args),readState:(...args)=>instance().readState(...args),readProgress:(...args)=>instance().readProgress(...args),runtimeComponents:()=>instance().runtimeComponents()};
