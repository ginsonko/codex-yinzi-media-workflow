'use strict';
const {createHash} = require('node:crypto');
const {readPublicPage} = require('./publicResearchHttp');
const {validateUrl} = require('./mediaDownload');
const profiles = require('./videoPlatformProfiles.json');
const decode = text => String(text || '').replace(/&(?:quot|#34);/g,'"').replace(/&(?:apos|#39);/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#(x[\da-f]+|\d+);/gi,(_,code)=>{const n=code[0].toLowerCase()==='x'?parseInt(code.slice(1),16):Number(code);return n<=0x10ffff?String.fromCodePoint(n):'';});
function platformFor(url) {
  const host = new URL(url).hostname;
  return profiles.find(profile=>profile.hosts.some(suffix=>host===suffix || host.endsWith('.'+suffix)))?.id || 'generic';
}
function parseIndex(html, {platform = 'generic',sourceUrl,observedAt = new Date().toISOString(),limit = 10}) {
  const clean = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  const items=[], seen=new Set();
  for (const match of clean.matchAll(/<a\b([^>]*class\s*=\s*["'][^"']*\bmc_vtvc_link\b[^"']*["'][^>]*)>/gi)) {
    const attrs=match[1];
    const url=decode(attrs.match(/\bhref\s*=\s*"([^"]+)"/i)?.[1]);
    if (!url) continue;
    try { validateUrl(url); } catch { continue; }
    const detected=platformFor(url);
    if (platform!=='generic' && platform!==detected || seen.has(url)) continue;
    const label=decode(attrs.match(/\baria-label\s*=\s*"([^"]*)"/i)?.[1] || '');
    seen.add(url);
    items.push({id:detected+'-index-'+createHash('sha256').update(url).digest('hex').slice(0,16),url,platform:detected,
      title:(label.split('来源:')[0].trim() || '待核验标题').slice(0,500),author:label.match(/上传人:\s*(.*?)\s*·/)?.[1]?.slice(0,200) || null,
      published_at:null,region:null,observed_at:observedAt,
      evidence:{kind:'search_snippet',url:sourceUrl,note:label.slice(0,2000)},
      metrics:{views:null,likes:null,comments:null,shares:null,saves:null},analysis_basis:'metadata_only',selected:false});
    if (items.length>=limit) break;
  }
  return items;
}
async function discover(product, {platform='generic',limit=10,timeout=15000,read=readPublicPage}={}) {
  const profile=profiles.find(p=>p.id===platform);
  const query=String(product)+(profile?.hosts[0] ? ' site:'+profile.hosts[0] : '');
  const url='https://cn.bing.com/videos/search?q='+encodeURIComponent(query);
  const html=await read(url,{hosts:['cn.bing.com'],timeout});
  return {items:parseIndex(html,{platform,sourceUrl:url,limit}),source_url:url};
}
module.exports={discover,parseIndex,platformFor};
