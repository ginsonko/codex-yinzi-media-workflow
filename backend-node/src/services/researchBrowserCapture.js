'use strict';
const {parsePayload}=require('./researchPlatformPayloads');
const {decodeBodies}=require('./researchResponseBodies');
const captures=new WeakMap();
function searchQuery(url,profile) {
  try {
    const u=new URL(url);
    if(u.protocol!=='https:'||!profile.hosts.some(h=>u.hostname===h||u.hostname.endsWith('.'+h)))return null;
    if(!profile.response_paths.some(p=>u.pathname.startsWith(p))||!u.pathname.includes('search'))return null;
    return u.searchParams.get('keyword')||u.searchParams.get('search_query')||u.searchParams.get('q')||null;
  }catch{return null;}
}
// Keep only normalized public search records, never response URLs, cookies,
// request headers, account state or raw payloads. Listen during user verification
// too, so resuming does not have to issue the same search again.
function observeSearch(context,profile) {
  if(captures.has(context))return captures.get(context);
  const results=new Map(),pending=new Set();
  const listener=response=>{
    const query=searchQuery(response.url(),profile);
    if(!query||response.status()!==200||Number(response.headers()['content-length']||0)>12*1024*1024)return;
    const observedAt=new Date().toISOString();
    const work=(async()=>{
      const bodies=decodeBodies(await response.body());
      const parsed=parsePayload(profile.id,bodies,{observedAt,limit:200});
      if(!parsed.items.length)return;
      if(!results.has(query)&&results.size>=6)results.delete(results.keys().next().value);
      const entry=results.get(query)||new Map();
      for(const row of parsed.items){if(row.content_kind==='image_post')continue;entry.set(row.id,{...row,discovery_queries:[query]});if(entry.size>200)entry.delete(entry.keys().next().value);}
      results.set(query,entry);
    })().catch(()=>{}).finally(()=>pending.delete(work));
    pending.add(work);
  };
  context.on('response',listener);
  const capture={read:query=>[...(results.get(query)?.values()||[])],flush:()=>Promise.allSettled([...pending])};
  captures.set(context,capture);return capture;
}
module.exports={observeSearch,searchQuery};
