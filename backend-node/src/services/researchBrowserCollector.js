'use strict';
const {getManager,hostMatches}=require('./researchBrowserSessions');
const {parsePayload}=require('./researchPlatformPayloads');
const {decodeBodies}=require('./researchResponseBodies');
const {needsVerification}=require('./researchBrowserVerification');
const profiles=require('./researchBrowserProfiles.json');
const fail=(code,message)=>Object.assign(new Error(message),{code});
function matchesSearch(page,profile,query) {
  if(!query)return false;
  try {
    const url=new URL(page.url());
    if(url.protocol!=='https:'||!hostMatches(url.hostname,profile.hosts))return false;
    return (profile.search_locations || []).some(location=>{
      const match=url.pathname.match(new RegExp(location.path));
      if(!match)return false;
      const value=location.query_param?url.searchParams.get(location.query_param):decodeURIComponent(match[1]||'');
      return value===query;
    });
  }catch{return false;}
}
function embeddedPayload(text) {
  try{return JSON.parse(text);}catch{}
  try{return JSON.parse(decodeURIComponent(text));}catch{return null;}
}
function acceptedResponse(platform,url) {
  const p=profiles.find(p=>p.id===platform);if(!p)return false;
  try{const u=new URL(url);return u.protocol==='https:'&&hostMatches(u.hostname,p.hosts)&&p.response_paths.some(part=>u.pathname.startsWith(part));}catch{return false;}
}
async function researchPage(context,profile,query) {
  const official=(context.pages?.() || []).filter(page=>{
    try { const url=new URL(page.url());return url.protocol==='https:'&&hostMatches(url.hostname,profile.hosts); } catch { return false; }
  });
  // A challenge is a continuation point. Never open a fresh page to get around
  // it, or discard the page the user has just verified.
  for(const page of official)if(await needsVerification(page,profile))return page;
  return official.filter(page=>matchesSearch(page,profile,query)).at(-1) || official.at(-1) || await context.newPage();
}
async function collect(platform,input,parameters={},dependencies={}) {
  const manager=dependencies.manager || getManager();
  const shouldStop=dependencies.shouldStop || (()=>false);
  const profile=profiles.find(p=>p.id===platform);if(!profile)throw fail('UNKNOWN_PLATFORM','请选择具体平台');
  if(!manager.status(platform).has_session)throw fail('PLATFORM_LOGIN_REQUIRED','请先在工具页连接'+profile.name+'，扫码后再采集');
  const limit=parameters.limit || 30, maxPages=parameters.max_pages || 5, waitMs=parameters.page_wait_ms || 2500;
  const keywords=[...new Set([input.query?.product,...(input.query?.keywords || [])].filter(Boolean))].slice(0,12);
  const targets=input.urls?.length?input.urls.map(url=>({url,query:null})):keywords.map(query=>({url:profile.search_url.replace('{query}',encodeURIComponent(query)),query}));
  const items=new Map(),comments=new Map(),attempts=[];
  return manager.using(platform,async context=>{
    const capture=context.on?require('./researchBrowserCapture').observeSearch(context,profile):null;
    const page=await researchPage(context,profile,targets[0]?.query);let activeQuery=null,keepPage=false;const pending=new Set();
    const restoreSearch=async()=>{
      if(!capture||!activeQuery)return;
      await capture.flush();
      for(const row of capture.read(activeQuery))if(items.size<limit||items.has(row.id))items.set(row.id,row);
    };
    const checkVerification=async()=>{
      if(!await needsVerification(page,profile))return false;
      if(!attempts.some(a=>a.status==='verification_required'))attempts.push({route:'browser_page',query:activeQuery,status:'verification_required'});
      keepPage=true;manager.markRequired(platform);
      await page.bringToFront().catch(()=>{});return true;
    };
    const listener=response=>{
      if(!acceptedResponse(platform,response.url()))return;
      const query=activeQuery;
      const job=(async()=>{
        if([401,403].includes(response.status())){attempts.push({route:'browser_response',status:'access_required',http_status:response.status()});return;}
        if(response.status()===429){attempts.push({route:'browser_response',status:'rate_limited',http_status:429});return;}
        if(response.status()!==200)return;
        const size=Number(response.headers()['content-length'] || 0);if(size>12*1024*1024)return;
        let payload;try{payload=decodeBodies(await response.body());}catch{attempts.push({route:'browser_response',path:new URL(response.url()).pathname,status:'body_unavailable'});return;}
        if(!payload.length){attempts.push({route:'browser_response',path:new URL(response.url()).pathname,status:'unrecognized_payload'});return;}
        const parsed=parsePayload(platform,payload,{limit});
        for(const row of parsed.items){if(row.content_kind==='image_post')continue;const prior=items.get(row.id);if(!prior&&items.size>=limit)continue;const allQueries=[...new Set([...(prior?.discovery_queries || []),query].filter(Boolean))];items.set(row.id,{...row,discovery_queries:allQueries});}
        for(const c of parsed.comments){if(comments.size<200)comments.set(c.id,c);}
      })().catch(()=>{attempts.push({route:'browser_response',status:'unrecognized_payload'});}).finally(()=>pending.delete(job));pending.add(job);
    };
    page.on('response',listener);
    try {
      for(const target of targets) {
        if(shouldStop()||items.size>=limit)break;
        const destination=new URL(target.url);
        if(destination.protocol!=='https:'||!hostMatches(destination.hostname,profile.hosts)||destination.username||destination.password)throw fail('PLATFORM_URL_MISMATCH','浏览器采集地址必须属于选中平台');
        activeQuery=target.query;
        await restoreSearch();
        if(items.size>=limit)break;
        const before=items.size;let stagnant=0,previousSize=items.size;
        try{
          if(await checkVerification())break;
          if(matchesSearch(page,profile,target.query)) {
            attempts.push({route:'browser_existing_search',query:target.query,status:'resumed'});
          }else if(target.query && profile.search_ui) {
            let search=page.getByPlaceholder(profile.search_ui.placeholder,{exact:true}).first();
            if(!await search.isVisible()) {
              await page.goto(profile.login_url,{waitUntil:'commit',timeout:Math.min(parameters.timeout_ms || 30000,15000)}).catch(()=>{});
              await page.waitForTimeout(2500);
            }
            if(await checkVerification())break;
            try { await search.waitFor({state:'visible',timeout:15000}); }
            catch {
              // The official home page can finish navigation after Playwright's
              // timeout. A bounded reload makes the first query recoverable
              // without treating saved cookies as proof of collection.
              await page.reload({waitUntil:'commit',timeout:15000}).catch(()=>{});
              await search.waitFor({state:'visible',timeout:15000});
            }
            await search.fill(target.query);await search.press('Enter');
            const tab=page.getByText(profile.search_ui.tab,{exact:true}).first();
            await tab.waitFor({state:'visible',timeout:20000});
            if(await checkVerification())break;
            await tab.click({timeout:3000});
          }else await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:parameters.timeout_ms || 30000});
        }catch(error){if(await checkVerification())break;attempts.push({route:'browser_navigation',query:target.query,status:'navigation_timeout'});}
        for(let pageIndex=0;pageIndex<maxPages && items.size<limit;pageIndex++) {
          if(shouldStop())break;
          await page.waitForTimeout(waitMs);await Promise.allSettled([...pending]);
          await restoreSearch();
          if(await checkVerification())break;
          // Read only embedded public content; never serialize browser storage.
          const embedded=await page.locator('script[type="application/json"]').allTextContents().catch(()=>[]);
          for(const text of embedded){if(text.length>8*1024*1024)continue;try{for(const row of parsePayload(platform,embeddedPayload(text),{limit}).items){if(row.content_kind==='image_post')continue;if(items.size<limit||items.has(row.id))items.set(row.id,{...row,discovery_queries:[activeQuery].filter(Boolean)});}}catch{}}
          if(attempts.some(a=>a.status==='access_required'||a.status==='rate_limited'))break;
          const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
          await page.mouse.move(viewport.width*0.65,viewport.height*0.7);
          await page.mouse.wheel(0,Math.max(viewport.height*0.85,600));
          stagnant=items.size===previousSize?stagnant+1:0;
          previousSize=items.size;
          if(stagnant>=3)break;
        }
        attempts.push({route:'browser_search',query:target.query,status:items.size>before?'collected':'no_public_records',count:items.size-before});
        if(attempts.some(a=>['access_required','rate_limited','verification_required'].includes(a.status)))break;
      }
      await Promise.allSettled([...pending]);
      await restoreSearch();
      if(items.size)manager.markVerified(platform);
      if(attempts.some(a=>['access_required','verification_required'].includes(a.status)))manager.markRequired(platform);
      else await manager.check(platform);
      const commentList=[...comments.values()];
      return {items:[...items.values()].map(row=>({...row,comment_samples:commentList.filter(c=>row.id===platform+'-'+c.video_id)})),comments:commentList,attempts,status:keepPage?'verification_required':items.size?'collected':attempts.some(a=>a.status==='access_required')?'access_required':'no_public_records'};
    }finally{page.off('response',listener);await Promise.allSettled([...pending]);}
  });
}
module.exports={collect,acceptedResponse,researchPage,matchesSearch,embeddedPayload};
