const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {parsePayload}=require('../src/services/researchPlatformPayloads');
const {createSessionManager,browserCandidates}=require('../src/services/researchBrowserSessions');
const {acceptedResponse,researchPage}=require('../src/services/researchBrowserCollector');
const {localRequest}=require('../src/routes/researchPlatformSessions');
const {decodeBodies}=require('../src/services/researchResponseBodies');
const {collect:browserCollect}=require('../src/services/researchBrowserCollector');
const {needsVerification}=require('../src/services/researchBrowserVerification');
const {matchesSearch,embeddedPayload}=require('../src/services/researchBrowserCollector');

test('check restores dedicated profile after runtime restart without forcing new login',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-restore-'));
  fs.mkdirSync(path.join(root,'douyin','profile'),{recursive:true});
  fs.writeFileSync(path.join(root,'douyin','connection.json'),JSON.stringify({state:'verification_required'}));
  let launches=0,closed;
  const page={url:()=> 'https://www.douyin.com/search/test',locator:selector=>selector==='body'?{innerText:async()=> '已恢复的官方平台页面，包含正常公开内容，可继续浏览。'}:{first:()=>({isVisible:async()=>false})}};
  const context={pages:()=>[page],on:(_e,fn)=>{closed=fn;},cookies:async()=>[{name:'sessionid',domain:'.douyin.com',value:'PRIVATE',expires:-1}],close:async()=>closed()};
  const manager=createSessionManager({root,executable:'test',chromium:{launchPersistentContext:async()=>{launches++;return context;}}});
  t.after(async()=>{await manager.close();fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(manager.status('douyin').profile_saved,true);
  assert.equal((await manager.check('douyin')).state,'connected');assert.equal(launches,1);
  assert.ok(!JSON.stringify(manager.list()).includes('PRIVATE'));
});

test('official search stream decodes byte-counted UTF8 chunks and ignores acknowledgements',()=>{
  const data={data:[{aweme_info:{aweme_id:'123456789',desc:'针织毛衣',statistics:{digg_count:50}}}]};
  const chunk=obj=>{const body=JSON.stringify(obj);return Buffer.byteLength(body).toString(16)+'\r\n'+body+'\r\n';};
  const parsed=decodeBodies(chunk(data)+chunk({ack:-1})+'0\r\n\r\n');
  assert.equal(parsePayload('douyin',parsed).items[0].metrics.likes,50);
  assert.deepEqual(decodeBodies(JSON.stringify(data)),[data]);
  assert.deepEqual(decodeBodies('data: '+JSON.stringify(data)+'\n\ndata: [DONE]\n\n'),[data]);
  assert.deepEqual(decodeBodies('123\r\n{"broken":'),[]);
  assert.deepEqual(decodeBodies('<html>Loading</html>'),[]);
});
test('five platform payload contracts preserve real metrics and unavailable fields',()=>{
  const dy=parsePayload('douyin',{data:[{aweme_info:{aweme_id:'123456789',desc:'毛衣',create_time:1700000000,author:{nickname:'测试'},video:{duration:12000},statistics:{play_count:0,digg_count:52,comment_count:0,collect_count:8}}}]});
  assert.equal(dy.items.length,1);assert.equal(dy.items[0].metrics.views,null);assert.equal(dy.items[0].metrics.comments,0);assert.equal(dy.items[0].duration_seconds,12);
  const xhs=parsePayload('xiaohongshu',{data:{items:[{id:'abcdef123456',note_card:{display_title:'针织衫',interact_info:{liked_count:'1.2万',collected_count:'120'}}}]}});
  assert.equal(xhs.items[0].metrics.likes,12000);assert.equal(xhs.items[0].metrics.views,null);
  const tt=parsePayload('tiktok',{itemList:[{id:'123456789',desc:'sweater',author:{uniqueId:'test'},stats:{playCount:300,diggCount:20},video:{duration:10}}]});assert.equal(tt.items[0].metrics.views,300);
  const bili=parsePayload('bilibili',{data:{bvid:'BV1abcdef123',title:'毛衣合集',duration:'1:30',play:99,review:3}});assert.equal(bili.items[0].duration_seconds,90);
  const yt=parsePayload('youtube',{videoRenderer:{videoId:'abcdef12345',title:{runs:[{text:'sweater'}]},viewCountText:{simpleText:'1,234 views'},publishedTimeText:{simpleText:'2 days ago'}}});assert.equal(yt.items[0].metrics.views,1234);assert.equal(yt.items[0].published_at,null);
});
test('only exact platform public-content response paths accepted',()=>{
  assert.equal(acceptedResponse('douyin','https://www.douyin.com/aweme/v1/web/general/search/single/'),true);
  assert.equal(acceptedResponse('douyin','https://douyin.com.evil.test/aweme/v1/web/general/search/single/'),false);
  assert.equal(acceptedResponse('douyin','https://www.douyin.com/passport/auth'),false);
});
test('loopback API rejects DNS rebinding and cross-origin login mutations',()=>{
  const req=(host,origin,remote='127.0.0.1')=>({socket:{remoteAddress:remote},get:key=>({host,origin}[key])});
  assert.equal(localRequest(req('127.0.0.1:5000','http://127.0.0.1:5000')),true);
  assert.equal(localRequest(req('127.0.0.1:5000','http://evil.test')),false);
  assert.equal(localRequest(req('evil.test','http://evil.test')),false);
  assert.equal(localRequest(req('127.0.0.1:5000',null,'192.168.1.1')),false);
});
test('browser search paths cover Windows/macOS/Linux without assuming a single host',()=>{
  assert.ok(browserCandidates('win32',{PROGRAMFILES:'C:/Program Files'}).some(p=>p.endsWith('msedge.exe')));
  assert.ok(browserCandidates('darwin',{}).some(p=>p.startsWith('/Applications/')));
  assert.ok(browserCandidates('linux',{}).includes('/usr/bin/chromium'));
});
test('dedicated login persists only status metadata, detects expiry and disconnects only its profile',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-session-'));
  let cookies=[],closeHandler,launches=0;
  const page={bringToFront:async()=>{},goto:async()=>{},getByRole:()=>({first:()=>({isVisible:async()=>false})})};
  const context={pages:()=>[page],on:(event,fn)=>{closeHandler=fn;},cookies:async()=>cookies,close:async()=>closeHandler()};
  const manager=createSessionManager({root,executable:'test-browser',chromium:{launchPersistentContext:async()=>{launches++;return context;}}});
  try{
    assert.equal(manager.status('douyin').state,'not_connected');
    await Promise.all([manager.getContext('douyin',{allowCreate:true}),manager.getContext('douyin',{allowCreate:true})]);assert.equal(launches,1);
    assert.equal((await manager.open('douyin')).state,'login_pending');
    cookies=[{name:'sessionid',domain:'.douyin.com',value:'PRIVATE_TOKEN',expires:Date.now()/1000+3600}];
    assert.equal((await manager.check('douyin')).state,'connected');
    const saved=fs.readFileSync(path.join(root,'douyin/connection.json'),'utf8');assert.equal(saved.includes('PRIVATE_TOKEN'),false);
    assert.equal(JSON.stringify(manager.list()).includes('PRIVATE_TOKEN'),false);
    cookies=[];assert.equal((await manager.check('douyin')).state,'expired');
    assert.equal((await manager.disconnect('douyin')).state,'not_connected');
    assert.throws(()=>manager.status('../other'),/未注册/);
  }finally{await manager.close();fs.rmSync(root,{recursive:true,force:true});}
});

test('visible challenge remains required despite valid cookies; open preserves its page',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-challenge-'));
  let visible=true,navigations=0,fronts=0,closed;
  const page={url:()=> 'https://www.douyin.com/search/test?type=video',
    locator:selector=>selector==='body'?{innerText:async()=> '官方搜索页面的公开内容已经加载完成，可以继续浏览。'}:{first:()=>({isVisible:async()=>visible})},
    goto:async()=>{navigations++;},bringToFront:async()=>{fronts++;}};
  const context={pages:()=>[page],on:(_e,fn)=>{closed=fn;},cookies:async()=>[{name:'sessionid',domain:'.douyin.com',value:'PRIVATE_TOKEN',expires:-1}],close:async()=>closed()};
  const manager=createSessionManager({root,executable:'test',chromium:{launchPersistentContext:async()=>context}});
  t.after(async()=>{await manager.close();fs.rmSync(root,{recursive:true,force:true});});
  await manager.getContext('douyin',{allowCreate:true});
  assert.equal((await manager.check('douyin')).state,'verification_required');
  assert.equal((await manager.open('douyin')).state,'verification_required');
  assert.equal(navigations,0);assert.equal(fronts,1);
  assert.equal(JSON.stringify(manager.list()).includes('PRIVATE_TOKEN'),false);
  visible=false;
  assert.equal(await needsVerification(page,{verification_selectors:['#captcha_container']}),false);
  assert.equal((await manager.check('douyin')).state,'connected');
});

test('collector retains partial records and verification window without trying another query',async()=>{
  let listener,closed=false,fronts=0,presses=0,marked=false;
  const tab={waitFor:async()=>{},click:async()=>{throw Error('must not click challenge');}};
  const search={isVisible:async()=>true,waitFor:async()=>{},fill:async()=>{},press:async()=>{
    presses++;
    listener({url:()=> 'https://www.douyin.com/aweme/v1/web/search/item/',status:()=>200,headers:()=>({}),body:async()=>Buffer.from(JSON.stringify({aweme_list:[{aweme_id:'123456789',desc:'毛衣',statistics:{digg_count:30}}]}))});
  }};
  const page={on:(_e,fn)=>{listener=fn;},off:()=>{},getByPlaceholder:()=>({first:()=>search}),getByText:()=>({first:()=>tab}),
    locator:()=>({first:()=>({isVisible:async()=>presses>0})}),bringToFront:async()=>{fronts++;},close:async()=>{closed=true;}};
  const manager={status:()=>({has_session:true}),using:async(_p,run)=>run({newPage:async()=>page}),markRequired:()=>{marked=true;},markVerified:()=>{},check:async()=>{throw Error('must not overwrite challenge');}};
  const result=await browserCollect('douyin',{query:{product:'毛衣',keywords:['针织衫']}},{limit:60},{manager});
  assert.equal(result.status,'verification_required');assert.equal(result.items.length,1);
  assert.equal(result.items[0].metrics.likes,30);assert.equal(presses,1);
  assert.equal(closed,false);assert.ok(fronts>0&&marked);
});

test('reuse verified official page; a pending challenge takes precedence over any other tab',async()=>{
  const profile={hosts:['douyin.com'],verification_selectors:['#captcha_container']};
  const page=(url,visible=false)=>({url:()=>url,locator:()=>({first:()=>({isVisible:async()=>visible})})});
  const verified=page('https://www.douyin.com/search/test'),other=page('https://example.com/');
  const context={pages:()=>[verified,other],newPage:async()=>{throw Error('must reuse verified page');}};
  assert.equal(await researchPage(context,profile),verified);
  const challenge=page('https://www.douyin.com/search/test2',true);
  context.pages=()=>[challenge,verified,other];
  assert.equal(await researchPage(context,profile),challenge);
  const created=page('about:blank');
  assert.equal(await researchPage({pages:()=>[other],newPage:async()=>created},profile),created);
});

test('resume matching official search without submitting it again after verification',async()=>{
  const profile=require('../src/services/researchBrowserProfiles.json').find(p=>p.id==='douyin');
  const pageUrl='https://www.douyin.com/jingxuan/search/'+encodeURIComponent('针织毛衣')+'?type=general';
  assert.ok(matchesSearch({url:()=>pageUrl},profile,'针织毛衣'));
  assert.equal(matchesSearch({url:()=>pageUrl},profile,'毛衣'),false);
  assert.equal(matchesSearch({url:()=>pageUrl.replace('www.douyin.com','douyin.com.evil.test')},profile,'针织毛衣'),false);
  let listener,scrolled=0;
  const page={url:()=>pageUrl,on:(_e,fn)=>{listener=fn;},off:()=>{},
    locator:()=>({first:()=>({isVisible:async()=>false}),allTextContents:async()=>[]}),
    getByPlaceholder:()=>{throw Error('must not resubmit verified search');},
    goto:async()=>{throw Error('must not reload verified search');},waitForTimeout:async()=>{},evaluate:async()=>({width:1000,height:800}),
    mouse:{move:async()=>{},wheel:async()=>{scrolled++;listener({url:()=> 'https://www.douyin.com/aweme/v1/web/search/item/',status:()=>200,headers:()=>({}),body:async()=>Buffer.from(JSON.stringify({aweme_list:[{aweme_id:'123456789',desc:'毛衣',statistics:{digg_count:45}}]}))});}}};
  const manager={status:()=>({has_session:true}),using:async(_p,fn)=>fn({pages:()=>[page]}),markVerified:()=>{},check:async()=>{}};
  const result=await browserCollect('douyin',{query:{product:'针织毛衣'}},{limit:1},{manager});
  assert.equal(result.items.length,1);assert.equal(result.items[0].metrics.likes,45);
  assert.equal(scrolled,1);assert.equal(result.attempts[0].route,'browser_existing_search');
});

test('public embedded payload permits URI encoded JSON and ignores invalid content',()=>{
  const data={aweme_id:'123456789',desc:'毛衣'};
  assert.deepEqual(embeddedPayload(encodeURIComponent(JSON.stringify(data))),data);
  assert.deepEqual(embeddedPayload(JSON.stringify(data)),data);
  assert.equal(embeddedPayload('%ZZ'),null);
});

test('capture retains public search records returned during manual verification, scoped by query',async()=>{
  const {observeSearch,searchQuery}=require('../src/services/researchBrowserCapture');
  const profile=require('../src/services/researchBrowserProfiles.json').find(p=>p.id==='douyin');
  let listener,subscriptions=0;
  const context={on:(event,fn)=>{assert.equal(event,'response');listener=fn;subscriptions++;}};
  const cache=observeSearch(context,profile);
  assert.equal(observeSearch(context,profile),cache);assert.equal(subscriptions,1);
  const url='https://www.douyin.com/aweme/v1/web/general/search/single/?keyword='+encodeURIComponent('针织毛衣');
  const payload={aweme_list:[{aweme_id:'123456789',desc:'毛衣',statistics:{digg_count:28,play_count:0},private_account_token:'NEVER_PERSIST'}]};
  listener({url:()=>url,status:()=>200,headers:()=>({}),body:async()=>Buffer.from(JSON.stringify(payload))});
  await cache.flush();
  assert.equal(cache.read('针织毛衣')[0].metrics.likes,28);
  assert.equal(cache.read('针织毛衣')[0].metrics.views,null);
  assert.deepEqual(cache.read('另一商品'),[]);
  assert.equal(JSON.stringify(cache.read('针织毛衣')).includes('NEVER_PERSIST'),false);
  assert.equal(searchQuery(url.replace('www.douyin.com','evil.test'),profile),null);
  assert.equal(searchQuery('https://www.douyin.com/passport/login/?keyword=a',profile),null);
});
