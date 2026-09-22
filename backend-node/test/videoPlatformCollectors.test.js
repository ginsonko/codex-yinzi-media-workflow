const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {collect,operations,normalizeMetadata} = require('../src/services/videoPlatformCollectors');
const {parseIndex} = require('../src/services/videoReferenceDiscovery');
const {compile} = require('../src/services/productReferenceResearch');
function context(t,input,parameters={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'platform-research-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const inputPath=path.join(dir,'input.json'); fs.writeFileSync(inputPath,JSON.stringify(input));
  return {inputPath,outputPath:path.join(dir,'result.json'),parameters,ensureComponent:async()=>({executables:{'yt-dlp':'fixture-extractor'}})};
}

test('stop requested during one detail preserves it and skips remaining detail requests',async t=>{
  const ctx=context(t,{urls:['https://www.bilibili.com/video/BVone/','https://www.bilibili.com/video/BVtwo/']},{auth_mode:'public'});
  let stopped=false,calls=0;ctx.shouldStop=()=>stopped;
  const result=await collect(ctx,'bilibili',{bilibiliCollect:async url=>{calls++;stopped=true;return {id:'b1',url,platform:'bilibili',evidence:{kind:'platform_page'},metrics:{views:3}};}});
  assert.equal(calls,1);assert.equal(result.summary.items,1);
});
test('public index returns only platform-matching links, no fabricated time or heat',()=>{
  const html='<script><a class="mc_vtvc_link" href="https://www.douyin.com/video/99"></a></script>' +
    '<a aria-label="毛衣来源: douyin.com · 上传时间: 昨天 · 上传人: 作者 · 单击" class="mc_vtvc_link" href="https://www.douyin.com/video/1"></a>' +
    '<a class="mc_vtvc_link" href="https://youtube.com/watch?v=2"></a>';
  const items=parseIndex(html,{platform:'douyin',sourceUrl:'https://cn.bing.com/videos/search?q=x'});
  assert.equal(items.length,1); assert.equal(items[0].author,'作者');
  assert.equal(items[0].metrics.views,null); assert.equal(items[0].published_at,null);
  assert.equal(items[0].evidence.kind,'search_snippet');
});
test('five adapters and generic entry share the executor and configurable analysis profiles',()=>{
  assert.equal(operations.length,6);
  assert.equal(new Set(operations.map(op=>op.id)).size,6);
  assert.ok(operations.every(op=>op.research_platform.analysis_focus && op.executeNative));
});
test('YouTube native keyword search is bounded and metadata maps missing separately from zero',async t=>{
  const ctx=context(t,{query:{product:'knit sweater'}},{limit:2,discovery:'native'});
  let args;
  const result=await collect(ctx,'youtube',{runProcessToFile:async(bin,actual,file)=>{
    args=actual; fs.writeFileSync(file,JSON.stringify({entries:[{id:'1',webpage_url:'https://www.youtube.com/watch?v=1',title:'sweater',view_count:0,like_count:3}]}));
  }});
  assert.equal(args.at(-1),'ytsearch2:knit sweater');
  assert.ok(args.includes('--skip-download')); assert.ok(args.includes('--ignore-config'));
  assert.equal(result.summary.status,'collected');
  const data=JSON.parse(fs.readFileSync(ctx.outputPath));
  assert.equal(data.items[0].metrics.views,0); assert.equal(data.items[0].metrics.comments,null);
  assert.equal(compile(data).items.length,1);
});
test('public discovery plus blocked detail preserves snippet evidence and failure',async t=>{
  const ctx=context(t,{query:{product:'针织毛衣'}},{limit:2});
  const result=await collect(ctx,'douyin',{
    discover:async()=>({source_url:'https://cn.bing.com/videos/search?q=x',items:[{id:'d1',url:'https://www.douyin.com/video/1',platform:'douyin',title:'毛衣',metrics:{views:null},evidence:{kind:'search_snippet'},analysis_basis:'metadata_only'}]}),
    runProcessToFile:async()=>{throw Object.assign(Error('需要登录或验证码'),{code:'ACCESS_REQUIRED'});}
  });
  assert.equal(result.summary.status,'discovery_only');
  const data=JSON.parse(fs.readFileSync(ctx.outputPath));
  assert.equal(data.items[0].evidence.kind,'search_snippet');
  assert.equal(data.collection.attempts.at(-1).code,'PLATFORM_ACCESS_REQUIRED');
});
test('unsupported search stores next step, no unnecessary install, and cannot be marked collected',async t=>{
  const ctx=context(t,{query:{product:'毛衣'}},{discovery:'none'});
  ctx.ensureComponent=()=>{throw Error('must not install');};
  const result=await collect(ctx,'xiaohongshu');
  assert.equal(result.summary.status,'requires_discovery');
  assert.throws(()=>operations.find(op=>op.research_platform.id==='xiaohongshu').validateResult(result),{code:'RESEARCH_REQUIRES_DISCOVERY'});
  assert.ok(fs.existsSync(ctx.outputPath));
});
test('B站 public page adapter works without preparing yt-dlp',async t=>{
  const ctx=context(t,{urls:['https://www.bilibili.com/video/BVtest/']});
  ctx.ensureComponent=()=>{throw Error('unexpected installation');};
  const result=await collect(ctx,'bilibili',{bilibiliCollect:async()=>({id:'b1',url:'https://www.bilibili.com/video/BVtest/',platform:'bilibili',evidence:{kind:'platform_page'},metrics:{views:3}})});
  assert.equal(result.summary.platform_verified,1);
});
test('private, credentialed, wrong-platform URLs and invalid limits stop before network',async t=>{
  for (const url of ['http://127.0.0.1/','https://user:secret@www.douyin.com/video/1','https://www.youtube.com/watch?v=1']) {
    await assert.rejects(collect(context(t,{urls:[url]}),'douyin'));
  }
  await assert.rejects(collect(context(t,{query:{product:'x'}},{limit:201}),'youtube'),{code:'INVALID_PARAMETER'});
  assert.throws(()=>normalizeMetadata({webpage_url:'http://localhost/',id:'x'},null,'generic'));
});

test('browser challenge keeps partial evidence and does not retry that platform with another extractor',async t=>{
  const ctx=context(t,{urls:['https://www.douyin.com/video/123456789','https://www.douyin.com/video/234567890']},{auth_mode:'browser'});
  ctx.ensureComponent=()=>{throw Error('must not install an extractor after a platform challenge');};
  const result=await collect(ctx,'douyin',{
    sessionManager:{status:()=>({has_session:true})},
    browserCollect:async()=>({items:[{id:'douyin-123456789',url:'https://www.douyin.com/video/123456789',platform:'douyin',evidence:{kind:'platform_page'},metrics:{likes:30}}],attempts:[{route:'browser_page',status:'verification_required'}],status:'verification_required'}),
    runProcessToFile:async()=>{throw Error('must not retry details');}
  });
  assert.equal(result.summary.platform_verified,1);assert.equal(result.summary.status,'partial');
  assert.equal(result.collection.attempts.some(a=>a.route==='detail'),false);
});

test('an empty browser challenge never falls through to public discovery',async t=>{
  const ctx=context(t,{query:{product:'针织毛衣'}},{auth_mode:'browser'});
  const result=await collect(ctx,'douyin',{
    sessionManager:{status:()=>({has_session:true})},
    browserCollect:async()=>({items:[],attempts:[{status:'verification_required'}]}),
    discover:async()=>{throw Error('public discovery must not run after the challenge');}
  });
  assert.equal(result.summary.status,'verification_required');
  assert.equal(result.collection.attempts.length,1);
  assert.equal(result.collection.required_action,'complete_official_verification');
});

test('saved verification state blocks auto mode before any new network request',async t=>{
  let calls=0;
  const result=await collect(context(t,{query:{product:'毛衣'}}),'douyin',{
    sessionManager:{status:()=>({has_session:false,state:'verification_required'})},
    browserCollect:async()=>{calls++;throw Error('unexpected');},
    discover:async()=>{calls++;throw Error('unexpected');}
  });
  assert.equal(calls,0);
  assert.equal(result.summary.status,'verification_required');
});

test('expired browser login and rate limiting keep different recovery actions',async t=>{
  const noLogin=await collect(context(t,{query:{product:'毛衣'}},{auth_mode:'browser'}),'douyin',{
    sessionManager:{status:()=>({has_session:false,state:'expired'})},
    browserCollect:async()=>{throw Object.assign(Error('请先扫码登录'),{code:'PLATFORM_LOGIN_REQUIRED'});}
  });
  assert.equal(noLogin.summary.status,'access_required');
  assert.equal(noLogin.collection.required_action,'connect_platform');
  const rate=await collect(context(t,{query:{product:'毛衣'}},{auth_mode:'browser'}),'douyin',{
    sessionManager:{status:()=>({has_session:true})},
    browserCollect:async()=>({items:[],attempts:[{status:'rate_limited'}]})
  });
  assert.equal(rate.summary.status,'rate_limited');
  assert.equal(rate.collection.required_action,'retry_later');
});
