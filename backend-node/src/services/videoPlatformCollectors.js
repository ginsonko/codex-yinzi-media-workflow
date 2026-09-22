'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {validateUrl,runProcessToFile} = require('./mediaDownload');
const profiles = require('./videoPlatformProfiles.json');
const discovery = require('./videoReferenceDiscovery');
const bili = require('./bilibiliPublicMetadata');
const fail = (code,message) => Object.assign(new Error(message),{code});
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
function validateParameters(p) {
  for (const [key,min,max] of [['limit',1,200],['max_pages',1,20],['timeout_ms',1000,120000]]) {
    if (p[key] != null && (!Number.isInteger(p[key]) || p[key]<min || p[key]>max)) throw fail('INVALID_PARAMETER',key+' 超出有效范围');
  }
  if (p.platform != null && !profiles.some(profile=>profile.id===p.platform)) throw fail('UNKNOWN_PLATFORM','未注册的平台请使用通用入口');
  if (p.discovery != null && !['auto','native','public_index','none'].includes(p.discovery)) throw fail('INVALID_PARAMETER','discovery 必须为 auto/native/public_index/none');
  if (p.auth_mode != null && !['auto','public','browser'].includes(p.auth_mode)) throw fail('INVALID_PARAMETER','auth_mode 必须为 auto/public/browser');
}
function validateInput(input,platform) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('INVALID_INPUT','输入必须是JSON对象');
  const urls=input.urls || [];
  if (!Array.isArray(urls) || urls.length>200) throw fail('INVALID_URLS','urls 必须为最多200条的数组');
  for (const url of urls) {
    validateUrl(url);
    if (platform!=='generic' && discovery.platformFor(url)!==platform) throw fail('PLATFORM_URL_MISMATCH','链接不属于当前平台专用入口');
  }
  const query=input.query || {};
  if (query.product != null && (typeof query.product!=='string' || query.product.length>300)) throw fail('INVALID_QUERY','商品关键词不得超过300字符');
  if (query.keywords != null && (!Array.isArray(query.keywords)||query.keywords.length>12||query.keywords.some(x=>typeof x!=='string'||!x.trim()||x.length>160))) throw fail('INVALID_QUERY','keywords 最多12个有效检索词，每个不超过160字符');
  if (!urls.length && !query.product?.trim()) throw fail('MISSING_QUERY','提供商品关键词或原视频链接');
  return {query,urls:[...new Set(urls)],product_facts:input.product_facts || []};
}
function normalizeMetadata(info,requestedUrl,platform) {
  const url=info.webpage_url || (requestedUrl?.startsWith('http') ? requestedUrl : null);
  if (!url) throw fail('MISSING_VIDEO_URL','提取器没有返回原视频链接');
  validateUrl(url);
  const actual=discovery.platformFor(url);
  if (platform!=='generic' && platform!==actual) throw fail('PLATFORM_URL_MISMATCH','提取结果来自其他平台');
  let published=null;
  if (typeof info.timestamp==='number' && info.timestamp>0 && info.timestamp<8640000000000) published=new Date(info.timestamp*1000).toISOString();
  else if (/^\d{8}$/.test(info.upload_date || '')) {
    const day=info.upload_date.slice(0,4)+'-'+info.upload_date.slice(4,6)+'-'+info.upload_date.slice(6,8);
    if (Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0,10)===day) published=day;
  }
  return {id:(actual+'-'+String(info.id || randomUUID())).slice(0,200),url,platform:actual,
    title:String(info.title || '待核验标题').slice(0,500),author:info.uploader || info.channel ? String(info.uploader || info.channel).slice(0,200) : null,
    published_at:published,observed_at:new Date().toISOString(),region:null,duration_seconds:count(info.duration),
    evidence:{kind:'platform_page',url,note:'yt-dlp公共详情提取；未观看视频，地区未推断'},
    metrics:{views:count(info.view_count),likes:count(info.like_count),comments:count(info.comment_count),shares:count(info.repost_count),saves:null},
    analysis_basis:'metadata_only',selected:false};
}
async function collect(ctx,fixedPlatform='generic',dependencies={}) {
  const parameters={limit:30,max_pages:5,timeout_ms:30000,discovery:'auto',auth_mode:'auto',...ctx.parameters};
  validateParameters(parameters);
  const platform=fixedPlatform==='generic' ? parameters.platform || 'generic' : fixedPlatform;
  const profile=profiles.find(item=>item.id===platform);
  if (fs.statSync(ctx.inputPath).size>1024*1024) throw fail('INPUT_TOO_LARGE','采集输入超过1 MiB');
  const content=fs.readFileSync(ctx.inputPath,'utf8');
  const input=validateInput(JSON.parse(content.replace(/^\uFEFF/,'')),platform);
  const report=ctx.report || (()=>{});
  const shouldStop=ctx.shouldStop || (()=>false);
  const attempts=[],warnings=[],items=[];
  let commentSamples=[],browserBlocked=false,blockedStatus=null;
  const block = status => { browserBlocked=true; blockedStatus=status; };
  const targetDir=path.dirname(ctx.outputPath); fs.mkdirSync(targetDir,{recursive:true});
  let component;
  const runner=dependencies.runProcessToFile || runProcessToFile;
  const extract=async (target) => {
    component ||= ctx.components?.['tool.yt-dlp'] || await ctx.ensureComponent('tool.yt-dlp');
    const bin=component.executables?.['yt-dlp'];
    if (!bin) throw fail('EXTRACTOR_UNAVAILABLE','yt-dlp尚未就绪');
    const file=path.join(targetDir,'.metadata-'+randomUUID()+'.json');
    try {
      await runner(bin,['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--no-warnings','--socket-timeout','15','--retries','0','--extractor-retries','0','--playlist-end',String(parameters.limit),'--',target],file,{timeout:parameters.timeout_ms,maxStdoutBytes:8*1024*1024});
      const raw=JSON.parse(fs.readFileSync(file,'utf8'));
      return (raw.entries || [raw]).filter(Boolean).slice(0,parameters.limit).map(info=>normalizeMetadata(info,target,platform));
    } finally { try { fs.unlinkSync(file); } catch {} }
  };
  const errorInfo=error=>{
    const message=String(error.message || error).replace(/https?:\/\/\S+/g,'[来源链接]').replace(/Bearer\s+\S+|sk-[\w-]+/g,'[redacted]').slice(0,600);
    const code=/cookies?|sign.?in|log.?in|验证码|captcha/i.test(message)?'PLATFORM_ACCESS_REQUIRED'
      :/429|too many requests|rate.?limit/i.test(message)?'PLATFORM_RATE_LIMIT'
      :typeof error.code==='string'?error.code:'PLATFORM_FETCH_FAILED';
    return {code,message};
  };
  const urls=input.urls.slice(0,parameters.limit);
  if(platform!=='generic'&&parameters.auth_mode!=='public') {
    const manager=dependencies.sessionManager || require('./researchBrowserSessions').getManager();
    const connection=manager.status(platform);
    // A saved challenge is a continuation point, not permission to fan out to
    // other extractors. The platform window's check action clears it.
    if(connection.state==='verification_required') {
      block('verification_required');
      attempts.push({route:'browser_session',status:'verification_required'});
    } else if(manager.status(platform).has_session||parameters.auth_mode==='browser') {
      try{
        const collected=await (dependencies.browserCollect || require('./researchBrowserCollector').collect)(platform,input,parameters,{manager,shouldStop});
        items.push(...collected.items);commentSamples=collected.comments || [];attempts.push(...collected.attempts);
        const blocked=collected.attempts.find(a=>['verification_required','access_required','rate_limited'].includes(a.status));
        if(blocked)block(blocked.status);
        if(browserBlocked)warnings.push('平台需要验证或暂时限制访问；已保留现有记录，请在官方窗口完成提示后继续。');
      }catch(error){
        const info=errorInfo(error);
        attempts.push({route:'browser_session',status:'failed',...info});
        if(['PLATFORM_ACCESS_REQUIRED','PLATFORM_LOGIN_REQUIRED'].includes(info.code))block('access_required');
        else if(info.code==='PLATFORM_RATE_LIMIT')block('rate_limited');
      }
    }
  }
  if (!shouldStop() && !browserBlocked && !urls.length && !items.length) {
    const native=profile.search_prefix && ['auto','native'].includes(parameters.discovery);
    if (native) {
      try { items.push(...await extract(profile.search_prefix+parameters.limit+':'+input.query.product)); attempts.push({route:'native_search',status:'succeeded',count:items.length}); }
      catch(error) { attempts.push({route:'native_search',status:'failed',...errorInfo(error)}); }
    }
    if (!items.length && ['auto','public_index'].includes(parameters.discovery)) {
      try {
        for(const query of [...new Set([input.query.product,...(input.query.keywords || [])])]) {
          if(shouldStop()||items.length>=parameters.limit)break;
          const found=await (dependencies.discover || discovery.discover)(query,{platform,limit:parameters.limit-items.length,timeout:parameters.timeout_ms});
          const unique=found.items.filter(item=>!items.some(old=>old.url===item.url));
          items.push(...unique.map(item=>({...item,discovery_queries:[query]})));
          attempts.push({route:'public_video_index',query,status:unique.length?'discovered':'empty',count:unique.length,source_url:found.source_url});
          urls.push(...unique.map(item=>item.url));
        }
        if (items.length) warnings.push('索引候选不代表原站热度或指定日期、地区的榜单；详情采集失败时保留摘要原级别');
      } catch(error) { attempts.push({route:'public_video_index',status:'failed',...errorInfo(error)}); }
    }
  }
  const unavailablePlatforms=new Set();
  if(browserBlocked)unavailablePlatforms.add(platform);
  for (const url of urls) {
    if(shouldStop())break;
    if(unavailablePlatforms.has(discovery.platformFor(url)))continue;
    if(items.some(item=>item.url===url&&item.evidence.kind==='platform_page'))continue;
    report({stage:'collecting',message:'读取公开视频详情 '+(attempts.filter(x=>x.route==='detail').length+1)+'/'+urls.length});
    try {
      let fetched;
      // This no-install path is independently verified against the public page.
      if (discovery.platformFor(url)==='bilibili' && /^https:\/\/(?:www\.)?bilibili\.com\/video\/(?:BV\w+|av\d+)\/?(?:\?.*)?$/.test(url)) {
        try { fetched=[await (dependencies.bilibiliCollect || bili.collect)(url,{timeout:parameters.timeout_ms})]; }
        catch (error) { warnings.push('B站公开页未取得详情，改用已注册提取器：'+errorInfo(error).code); }
      }
      fetched ||= await extract(url);
      for (const item of fetched) {
        const index=items.findIndex(previous=>previous.url===item.url || previous.url===url);
        if (index>=0) items[index]={...item,discovery_evidence:items[index].evidence}; else items.push(item);
      }
      attempts.push({route:'detail',url,status:'succeeded',count:fetched.length});
    } catch(error) {
      const info=errorInfo(error);
      attempts.push({route:'detail',url,status:'failed',...info});
      if(['PLATFORM_ACCESS_REQUIRED','PLATFORM_RATE_LIMIT'].includes(info.code)) {
        unavailablePlatforms.add(discovery.platformFor(url));
        if(platform!=='generic')block(info.code==='PLATFORM_RATE_LIMIT'?'rate_limited':'access_required');
        warnings.push('该平台详情读取需要登录或暂时限流，保留已取得记录；本轮不重复请求同类失败');
      }
    }
  }
  const verified=items.filter(item=>item.evidence.kind==='platform_page').length;
  const failed=attempts.filter(item=>item.status==='failed').length;
  const status=verified ? (failed || browserBlocked || verified<items.length ? 'partial':'collected') : items.length ? 'discovery_only' : blockedStatus || (attempts.length && attempts.every(item=>item.status==='empty') ? 'empty' : 'requires_discovery');
  const searchUrl=profile.public_search_url?.replace('{query}',encodeURIComponent(input.query.product || ''));
  const result={schema_version:1,query:input.query,product_facts:input.product_facts,items:items.slice(0,parameters.limit),comment_samples:commentSamples,
    collection:{adapter:platform,adapter_version:2,status,blocked_status:blockedStatus,attempts,warnings,analysis_focus:profile.analysis_focus,
      required_action:blockedStatus==='verification_required'?'complete_official_verification':blockedStatus==='access_required'?'connect_platform':blockedStatus==='rate_limited'?'retry_later':null,
      capabilities:{keyword_search:'saved_browser_session_then_public_routes',detail:'browser_or_public_page_or_ytdlp',comments:'when_returned_by_opened_platform_page',sales:false},
      next_steps:items.length?['将 result.json 交给 local.research.product-references 整理；实际观看重点视频后补写分析','日期与地区未核验的项不得放入严格筛选榜单；商品事实不足先补最少资料']:['使用Agent浏览器或用户提供的公开页面/导出取得原链接，再提交 urls；不自动提取Cookie',...(searchUrl?[searchUrl]:[]),'新平台先验证脚本和失败分支，再作为可复用工具注册'] }};
  fs.writeFileSync(ctx.outputPath,JSON.stringify(result,null,2),'utf8');
  return {summary:{status,items:result.items.length,platform_verified:verified,failed_attempts:failed},assets:[{file:path.basename(ctx.outputPath),type:'document',role:'reference_sources',title:'平台参考数据',path:ctx.outputPath,kind:'reference_sources'}],collection:result.collection};
}
const operations=profiles.map(profile=>({
  id:'local.research.collect-'+(profile.id==='generic'?'videos':profile.id),
  title:profile.name+'热门视频参考采集',
  description:'按商品关键词发现原视频，或按链接采集公开详情与实际热度；保留来源和失败原因，按平台分析。'+profile.analysis_focus,
  kind:'document',phase:'research',component_id:null,output_extension:'json',source:'https://github.com/yt-dlp/yt-dlp',
  defaults:{limit:30,max_pages:5,timeout_ms:30000,discovery:'auto',auth_mode:'auto',...(profile.id==='generic'?{platform:'generic'}:{})},
  research_platform:{id:profile.id,name:profile.name,analysis_focus:profile.analysis_focus},
  side_effects:{network:true,filesystem_write:true,database_write:false,external_write:false,paid:false},
  parameter_schema:{type:'object',properties:{limit:{type:'integer',minimum:1,maximum:200},max_pages:{type:'integer',minimum:1,maximum:20},auth_mode:{type:'string',enum:['auto','public','browser']},timeout_ms:{type:'integer',minimum:1000,maximum:120000},discovery:{type:'string',enum:['auto','native','public_index','none']},...(profile.id==='generic'?{platform:{type:'string',enum:profiles.map(item=>item.id)}}:{})}},
  validateParameters,
  executeNative:ctx=>collect(ctx,profile.id),
  validateResult(details) { if (details.summary.status==='requires_discovery') throw fail('RESEARCH_REQUIRES_DISCOVERY','未取得可用参考；具体采集原因、平台搜索入口和下一步已保存在 result.json'); }
}));
module.exports={operations,collect,normalizeMetadata,validateInput,validateParameters,profiles};
