'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compile, groupAndSort, generateOutputs } = require('../src/services/productReferenceResearch');
const { snapshot, renderReport, publicLink } = require('../src/services/productReferenceReport');
const model = require('../src/services/productReferenceReportModel');
function records(items, query = {}) {
  const compiled = compile({ query, items });
  const grouped = groupAndSort(compiled);
  return snapshot({query,items:grouped.items,excluded:grouped.excluded});
}
const item = (id, platform, views, kind = 'platform_page') => ({id,url:`https://example.com/${id}`,platform,title:id,metrics:{views},evidence:{kind}});
test('charts use known values, keep zero, omit unavailable metrics and single-record rankings', () => {
  const data = records([item('missing','bilibili',null),item('zero','bilibili',0)]);
  const view = model.view(data.items);
  assert.deepEqual(view.availableMetrics,['views']);
  assert.equal(view.comparisons.length,0);
  assert.equal(view.singleSamples[0].metrics.views,0);
  const missing = model.view([data.items[0]]);
  assert.deepEqual(missing.availableMetrics,[]);
  assert.deepEqual(missing.metricRows,[]);
  assert.deepEqual(missing.months,[]);
});
test('comparison separates platform, region and duration and never ranks index metrics', () => {
  const data=records([item('a','bilibili',120),item('b','bilibili',240),item('c','douyin',9999),item('s','bilibili',99999,'search_snippet'),{...item('long','bilibili',900),duration_seconds:900}]);
  const view=model.view(data.items);
  assert.equal(view.comparisons.length,1);
  assert.deepEqual(view.comparisons[0].rows.map(row=>row.id),['b','a']);
  assert.deepEqual(view.singleSamples.map(row=>row.id),['c','long']);
});
test('query-ineligible samples stay out of plots even when shown in the source list', () => {
  const data=records([{...item('old','bilibili',500),published_at:'2025-01-01'},{...item('new','bilibili',100),published_at:'2026-09-01'}],{since:'2026-08-01'});
  assert.deepEqual(model.filterRows(data.items).map(row=>row.id),['new']);
  const all=model.filterRows(data.items,{scope:'all'});
  assert.equal(all.length,2);
  assert.deepEqual(model.view(all).metricRows.map(row=>row.id),['new']);
});
test('filter, source data and CSV retain exactly the same rows including null and zero', () => {
  const data=records([item('a','bilibili',0),{...item('b','douyin',null,'search_snippet'),title:'=1+1',author:'针织'},item('c','douyin',2)]);
  const filtered=model.filterRows(data.items,{platform:'douyin',evidence:'search_snippet',search:'针织'});
  assert.equal(filtered.length,1);
  assert.match(model.csv(filtered),/"'=1\+1"/);
  assert.equal(model.csv(filtered).split('\r\n').length,2);
  assert.equal(model.filterRows(data.items,{search:'not-found'}).length,0);
  assert.equal(model.filterRows(data.items,{}).length,3);
});
test('date and type filters only retain matching known dates, reset restores full population', () => {
  const data=records([{...item('recent','bilibili',1),published_at:'2026-09-20',content_kind:'穿搭'}, {...item('old','bilibili',2),published_at:'2023-01-01',content_kind:'穿搭'}, {...item('unknown','douyin',null),content_kind:'商品'}]);
  assert.deepEqual(model.filterRows(data.items,{since:'2026-08-22',content_kind:'穿搭'}).map(row=>row.id),['recent']);
  assert.equal(model.filterRows(data.items,{}).length,3);
});
test('equal observed counts do not generate a meaningless leaderboard', () => {
  const data=records([item('a','bilibili',0),item('b','bilibili',0)]);
  const view=model.view(data.items);
  assert.equal(view.comparisons.length,0);
  assert.equal(view.singleSamples.length,2);
});
test('script closure and malicious links cannot execute or leak URL tokens in report', () => {
  const row={...item('x','bilibili',12),title:'</script><img src=x onerror=alert(1)>',url:'https://example.com/video?token=secret#access',evidence:{kind:'platform_page',url:'javascript:alert(1)',note:'</script><script>alert(1)</script>'}};
  const compiled=compile({query:{product:'</title><script>bad()</script>'},items:[row]});
  const grouped=groupAndSort(compiled);
  const result={query:compiled.query,items:grouped.items,excluded:[]};
  const html=renderReport(result,{});
  assert.ok(!html.includes('token=secret'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.match(html,/\\u003c\/script>/);
  assert.equal(publicLink('https://user:secret@example.com/a'),null);
  assert.equal(publicLink('http://127.0.0.1/file'),null);
  assert.equal(publicLink('https://www.youtube.com/watch?v=abc&signature=secret'),'https://www.youtube.com/watch?v=abc');
});
test('unique sample totals reconcile with evidence counts and default report asset', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'research-report-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const compiled=compile({query:{},items:[item('same','bilibili',1,'search_snippet'),item('same','bilibili',2),item('other','douyin',null,'search_snippet')]});
  const result=generateOutputs(compiled,groupAndSort(compiled),dir).result;
  assert.equal(result.summary.total_items,2);
  assert.equal(result.summary.collected_records,3);
  assert.equal(Object.values(result.summary.evidence_distribution).reduce((a,b)=>a+b,0),2);
  assert.ok(fs.statSync(path.join(dir,'report.html')).size>10000);
});
