const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parsePage, readPage} = require('../src/services/bilibiliPublicMetadata');
const url = 'https://www.bilibili.com/video/BVtest123/';
test('public JSON is parsed without evaluating script and preserves unknown counts', () => {
  const html = '<script>window.__INITIAL_STATE__=' + JSON.stringify({videoData:{bvid:'BVtest123', title:'a "} {" title', owner:{name:'作者'},pubdate:1789976303,stat:{view:0,like:7}}}) + ';throw new Error("must not run")</script>';
  const item = parsePage(html,url,'2026-09-22T00:00:00Z');
  assert.equal(item.metrics.views,0);
  assert.equal(item.metrics.comments,null);
  assert.equal(item.published_at,'2026-09-21T07:38:23.000Z');
  assert.equal(item.region,null);
  assert.equal(item.analysis_basis,'metadata_only');
});
test('missing data, mismatching ID and invalid JSON do not masquerade as success', () => {
  assert.throws(()=>parsePage('<title>验证码</title>',url),{code:'PLATFORM_METADATA_UNAVAILABLE'});
  assert.throws(()=>parsePage('window.__INITIAL_STATE__={"videoData":{"bvid":"BVother","title":"x"}}',url),{code:'PLATFORM_ID_MISMATCH'});
  assert.throws(()=>parsePage('window.__INITIAL_STATE__={evil:true}',url),{code:'PLATFORM_METADATA_INVALID'});
  assert.throws(()=>readPage('https://www.bilibili.com.evil.invalid/video/BVtest123/'),{code:'UNSUPPORTED_BILIBILI_URL'});
});
