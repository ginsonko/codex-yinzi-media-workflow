'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const profiles=require('./researchBrowserProfiles.json');
const {needsVerification}=require('./researchBrowserVerification');
const fail=(code,message)=>Object.assign(new Error(message),{code});
function browserCandidates(platform=process.platform,env=process.env) {
  if(env.YINZI_RESEARCH_BROWSER)return [env.YINZI_RESEARCH_BROWSER];
  if(platform==='win32')return [env.PROGRAMFILES,env['PROGRAMFILES(X86)'],env.LOCALAPPDATA].filter(Boolean).flatMap(root=>[path.join(root,'Microsoft/Edge/Application/msedge.exe'),path.join(root,'Google/Chrome/Application/chrome.exe')]);
  if(platform==='darwin')return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return ['/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser','/opt/google/chrome/chrome','/usr/bin/microsoft-edge'];
}
function hostMatches(host, domains) {return domains.some(d=>host===d||host.endsWith('.'+d));}
function createSessionManager(options={}) {
  const root=path.resolve(options.root || process.env.YINZI_RESEARCH_SESSION_DIR || path.join(process.env.YINZI_WORKFLOW_RUNTIME_DIR || path.join(os.homedir(),'.yinzi-media'),'private','research-browser'));
  const contexts=new Map(), pending=new Map(), metadata=new Map(), busy=new Set();
  const resolveExecutable=()=>options.executable || browserCandidates().find(file=>fs.existsSync(file));
  const chromium=options.chromium || require('playwright-core').chromium;
  const file=id=>path.join(root,id,'connection.json');
  const profile=id=>{const p=profiles.find(p=>p.id===id);if(!p)throw fail('UNKNOWN_PLATFORM','未注册的平台');return p;};
  const read=id=>{if(metadata.has(id))return metadata.get(id);try{const data=JSON.parse(fs.readFileSync(file(id),'utf8'));metadata.set(id,data);return data;}catch{return {};}};
  const save=(id,patch)=>{const data={...read(id),...patch};fs.mkdirSync(path.dirname(file(id)),{recursive:true,mode:0o700});fs.writeFileSync(file(id),JSON.stringify(data,null,2),{mode:0o600});metadata.set(id,data);return data;};
  function status(id) {
    const p=profile(id),m=read(id);let state=m.state || 'not_connected';
    if(m.expires_at&&Date.parse(m.expires_at)<=Date.now()&&state==='connected')state='expired';
    const executable=resolveExecutable();if(!executable)state='unavailable';
    const messages={not_connected:'未连接',login_pending:'请在打开的平台页面扫码或登录',connected:'已保存本机登录态',expired:'登录已过期，请重新扫码',verification_required:'请在平台窗口完成验证',unavailable:'未找到Chrome或Edge，可安装浏览器后重试'};
    return {id,name:p.name,state,message:m.message || messages[state],has_session:state==='connected',profile_saved:fs.existsSync(path.join(root,id,'profile')),browser_available:Boolean(executable),last_verified_at:m.last_verified_at || null};
  }
  async function getContext(id,{allowCreate=false}={}) {
    profile(id);
    if(contexts.has(id))return contexts.get(id);
    if(pending.has(id))return pending.get(id);
    if(!allowCreate && !status(id).has_session)throw fail('PLATFORM_LOGIN_REQUIRED','请先在工具页连接该平台并扫码登录');
    const executable=resolveExecutable();if(!executable)throw fail('RESEARCH_BROWSER_MISSING','请安装Chrome或Edge，或设置YINZI_RESEARCH_BROWSER浏览器路径');
    const promise=(async()=>{
      fs.mkdirSync(path.join(root,id),{recursive:true,mode:0o700});
      const context=await chromium.launchPersistentContext(path.join(root,id,'profile'),{executablePath:executable,headless:false,viewport:null,acceptDownloads:false,args:['--no-first-run','--no-default-browser-check']});
      require('./researchBrowserCapture').observeSearch(context,profile(id));
      contexts.set(id,context);context.on('close',()=>contexts.delete(id));return context;
    })();
    pending.set(id,promise);try{return await promise;}catch{throw fail('RESEARCH_BROWSER_START_FAILED','平台窗口无法启动。请关闭此工具上次打开的平台窗口后重试。');}finally{pending.delete(id);}
  }
  async function check(id) {
    const p=profile(id);let context=contexts.get(id);
    if(!context&&status(id).profile_saved){
      context=await getContext(id,{allowCreate:true});
      const pages=context.pages();
      if(!pages.some(page=>{try{return hostMatches(new URL(page.url()).hostname,p.hosts);}catch{return false;}})){
        const page=pages[0]||await context.newPage();
        await page.goto(p.login_url,{waitUntil:'domcontentloaded',timeout:30000}).catch(()=>{});
      }
    }
    if(!context)return status(id);
    let officialPageReady=false;
    for(const page of context.pages()) {
      let url;try{url=new URL(page.url());}catch{continue;}
      if(url.protocol!=='https:'||!hostMatches(url.hostname,p.hosts))continue;
      if(await needsVerification(page,p)){save(id,{state:'verification_required',message:null});return status(id);}
      const ready=await page.locator('body').innerText({timeout:1500}).catch(()=>'');
      if(ready.trim().length>20)officialPageReady=true;
    }
    const cookies=await context.cookies();
    const valid=cookies.filter(c=>p.session_cookies.includes(c.name)&&hostMatches(c.domain.replace(/^\./,''),p.hosts)&&c.value&&(c.expires===-1||c.expires*1000>Date.now()));
    if(read(id).state==='verification_required'&&!officialPageReady)return status(id);
    if(valid.length){const expiry=valid.map(c=>c.expires).filter(x=>x>0);save(id,{state:'connected',message:null,expires_at:expiry.length?new Date(Math.min(...expiry)*1000).toISOString():null});}
    else if(read(id).state==='connected')save(id,{state:'expired',message:null});
    return status(id);
  }
  async function open(id) {
    const p=profile(id);if(busy.has(id))throw fail('PLATFORM_BUSY','该平台正在采集，完成后可重新登录');
    const context=await getContext(id,{allowCreate:true});
    for(const existing of context.pages()) {
      let url;try{url=new URL(existing.url());}catch{continue;}
      if(url.protocol==='https:'&&hostMatches(url.hostname,p.hosts)&&await needsVerification(existing,p)) {
        save(id,{state:'verification_required',message:null});
        await existing.bringToFront();return status(id);
      }
    }
    const page=context.pages()[0]||await context.newPage();
    save(id,{state:'login_pending',message:null});
    await page.bringToFront();
    try{await page.goto(p.login_url,{waitUntil:'domcontentloaded',timeout:30000});}catch{save(id,{message:'窗口已打开；页面网络较慢，可在窗口内刷新'});}
    for(const label of p.login_buttons){const button=page.getByRole('button',{name:label,exact:true}).first();try{if(await button.isVisible())await button.click({timeout:1500});}catch{}}
    return check(id);
  }
  async function disconnect(id) {
    profile(id);if(busy.has(id))throw fail('PLATFORM_BUSY','请等待该平台当前采集结束再断开');
    if(pending.has(id))await pending.get(id);
    const context=contexts.get(id);if(context)await context.close();
    const target=path.resolve(root,id,'profile');
    if(!target.startsWith(root+path.sep))throw fail('INVALID_PROFILE_PATH','平台目录无效');
    fs.rmSync(target,{recursive:true,force:true});
    save(id,{state:'not_connected',message:null,expires_at:null,last_verified_at:null});return status(id);
  }
  async function using(id,run) {
    if(busy.has(id))throw fail('PLATFORM_BUSY','同一平台已有采集正在执行，请稍后重试');
    busy.add(id);try{return await run(await getContext(id));}finally{busy.delete(id);}
  }
  return {root,status,list:()=>profiles.map(p=>status(p.id)),check,open,disconnect,getContext,using,
    markVerified:id=>save(id,{last_verified_at:new Date().toISOString(),message:null}),
    markRequired:(id,state='verification_required')=>save(id,{state,message:null}),
    close:async()=>{await Promise.allSettled([...contexts.values()].map(c=>c.close()));},profiles};
}
let singleton;
module.exports={createSessionManager,browserCandidates,hostMatches,getManager:()=>singleton ||= createSessionManager()};
