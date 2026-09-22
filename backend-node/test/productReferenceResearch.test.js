const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { compile, executeNative } = require('../src/services/productReferenceResearch.js');

test('automatic ranking uses the available metric per platform, without inventing views',()=>{
  const {groupAndSort}=require('../src/services/productReferenceResearch');
  const result=groupAndSort(compile({query:{},items:[
    {id:'d1',platform:'douyin',evidence:{kind:'platform_page'},metrics:{views:null,likes:30}},
    {id:'d2',platform:'douyin',evidence:{kind:'platform_page'},metrics:{views:null,likes:90}},
    {id:'b1',platform:'bilibili',evidence:{kind:'platform_page'},metrics:{views:200,likes:3}},
    {id:'index',platform:'douyin',evidence:{kind:'search_snippet'},metrics:{views:999999,likes:99999}}
  ]}));
  assert.equal(result.ranking['douyin:unknown'].metric,'likes');
  assert.equal(result.ranking['bilibili:unknown'].metric,'views');
  assert.deepEqual(result.groups['douyin:unknown'].map(row=>row.id),['d2','d1']);
  assert.equal(result.groups['douyin:unknown'][0].metrics.views,null);
  assert.equal(result.excluded.find(row=>row.id==='index').exclusion_reason,'evidence_unverified');
});

test('a requested empty date/region scope cannot be silently broadened by automatic ranking',()=>{
  const {groupAndSort}=require('../src/services/productReferenceResearch');
  const result=groupAndSort(compile({query:{region:'US',since:'2026-09-01'},items:[
    {id:'old',platform:'tiktok',region:'US',published_at:'2025-01-01',evidence:{kind:'platform_page'},metrics:{views:99}},
    {id:'unknown',platform:'tiktok',published_at:'2026-09-20',evidence:{kind:'platform_page'},metrics:{views:100}}
  ]}));
  assert.equal(result.candidates.length,0);
  assert.equal(result.items.length,2);
  assert.deepEqual(result.ranking,{});
});

test('compile: validates and normalizes basic input', () => {
  const input = {
    query: { product: '毛衣', platforms: ['douyin'], region: 'CN' },
    items: [
      { evidence: { kind: 'platform_page' }, id: 'item-1',
        url: 'https://example.com/video/123',
        platform: 'douyin',
        title: '爆款毛衣',
        author: '作者A',
        published_at: '2026-09-01',
        metrics: { views: '1.2万', likes: 500 }
      }
    ]
  };

  const result = compile(input);
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(result.items[0].metrics.views, 12000);
  assert.strictEqual(result.items[0].metrics.likes, 500);
  assert.strictEqual(result.items[0].published_at, '2026-09-01');
});

test('compile: rejects input without query', () => {
  assert.throws(() => compile({ items: [] }), { code: 'INVALID_QUERY' });
});

test('compile: rejects too many items', () => {
  const items = Array(1001).fill({ evidence: { kind: 'platform_page' }, id: 'x', url: 'https://example.com' });
  assert.throws(() => compile({ query: {}, items }), { code: 'TOO_MANY_ITEMS' });
});

test('compile: rejects invalid item ID', () => {
  const input = { query: {}, items: [{ evidence: { kind: 'platform_page' }, id: '', url: 'https://example.com' }] };
  assert.throws(() => compile(input), { code: 'INVALID_ITEM_ID' });
});

test('compile: parses Chinese count strings', () => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', metrics: { views: '3.5万', likes: '1.2亿', comments: '500K' } },
      { evidence: { kind: 'platform_page' }, id: '2', metrics: { views: '2M', likes: '100', shares: '1.5K' } }
    ]
  };

  const result = compile(input);
  assert.strictEqual(result.items[0].metrics.views, 35000);
  assert.strictEqual(result.items[0].metrics.likes, 120000000);
  assert.strictEqual(result.items[0].metrics.comments, 500000);
  assert.strictEqual(result.items[1].metrics.views, 2000000);
  assert.strictEqual(result.items[1].metrics.shares, 1500);
});

test('compile: handles unparseable counts as null', () => {
  const input = {
    query: {},
    items: [{ evidence: { kind: 'platform_page' }, id: '1', metrics: { views: 'abc', likes: '很多' } }]
  };

  const result = compile(input);
  assert.strictEqual(result.items[0].metrics.views, null);
  assert.strictEqual(result.items[0].metrics.likes, null);
});

test('compile: normalizes URLs and removes tracking params', () => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', url: 'https://example.com/video?v=123&utm_source=share&from=app' },
      { evidence: { kind: 'platform_page' }, id: '2', url: 'https://example.com/video?v=456' }
    ]
  };

  const result = compile(input);
  assert.strictEqual(result.items[0].url, 'https://example.com/video?v=123');
  assert.strictEqual(result.items[1].url, 'https://example.com/video?v=456');
});

test('compile: rejects URLs with credentials', () => {
  const input = {
    query: {},
    items: [{ evidence: { kind: 'platform_page' }, id: '1', url: 'https://user:pass@example.com/video' }]
  };

  assert.throws(() => compile(input), { code: 'URL_CONTAINS_CREDENTIALS' });
});

test('compile: deduplicates URLs and tracks sources', async (t) => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: 'a', url: 'https://example.com/v/1', metrics: { views: 1000 } },
      { evidence: { kind: 'platform_page' }, id: 'b', url: 'https://example.com/v/1?utm_source=x', metrics: { views: 2000 } },
      { evidence: { kind: 'platform_page' }, id: 'c', url: 'https://example.com/v/2', metrics: { views: 500 } }
    ]
  };

  const compiled = compile(input);
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');

  // Use internal function for this specific test
  const grouped = groupAndSort(compiled, 'views');

  // Should have 2 unique URLs (v/1 and v/2)
  assert.strictEqual(grouped.candidates.length, 2);

  // First item should have duplicate_sources
  const first = grouped.candidates.find(c => c.url === 'https://example.com/v/1');
  assert.ok(first.duplicate_sources);
  assert.ok(first.duplicate_sources.includes('b'));
});

test('compile: excludes items with invalid dates', async () => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', published_at: '2026-09-01', metrics: { views: 1000 } },
      { evidence: { kind: 'platform_page' }, id: '2', published_at: 'invalid-date', metrics: { views: 2000 } },
      { evidence: { kind: 'platform_page' }, id: '3', published_at: null, metrics: { views: 500 } }
    ]
  };

  const compiled = compile(input);
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');
  const grouped = groupAndSort(compiled, 'views');

  // Item 2 has invalid date, should be excluded
  assert.strictEqual(grouped.excluded.length, 1);
  assert.strictEqual(grouped.excluded[0].id, '2');
  assert.ok(grouped.excluded[0].exclusion_reason.includes('published_at_invalid'));
});

test('compile: excludes items without sort metric', async () => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', metrics: { views: 1000, likes: 50 } },
      { evidence: { kind: 'platform_page' }, id: '2', metrics: { views: null, likes: 100 } }
    ]
  };

  const compiled = compile(input);
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');
  const grouped = groupAndSort(compiled, 'views');

  assert.strictEqual(grouped.candidates.length, 1);
  assert.strictEqual(grouped.excluded.length, 1);
  assert.strictEqual(grouped.excluded[0].id, '2');
  assert.ok(grouped.excluded[0].exclusion_reason.includes('missing_views'));
});

test('compile: groups by platform and region', async () => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', platform: 'douyin', region: 'CN', metrics: { views: 1000 } },
      { evidence: { kind: 'platform_page' }, id: '2', platform: 'douyin', region: 'CN', metrics: { views: 2000 } },
      { evidence: { kind: 'platform_page' }, id: '3', platform: 'tiktok', region: 'US', metrics: { views: 1500 } }
    ]
  };

  const compiled = compile(input);
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');
  const grouped = groupAndSort(compiled, 'views');

  assert.strictEqual(Object.keys(grouped.groups).length, 2);
  assert.ok(grouped.groups['douyin:CN']);
  assert.ok(grouped.groups['tiktok:US']);
  assert.strictEqual(grouped.groups['douyin:CN'].length, 2);
  assert.strictEqual(grouped.groups['tiktok:US'].length, 1);
});

test('compile: sorts by different metrics', async () => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', metrics: { views: 1000, likes: 500 } },
      { evidence: { kind: 'platform_page' }, id: '2', metrics: { views: 2000, likes: 300 } },
      { evidence: { kind: 'platform_page' }, id: '3', metrics: { views: 1500, likes: 600 } }
    ]
  };

  const compiled = compile(input);
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');

  const byViews = groupAndSort(compiled, 'views');
  assert.strictEqual(byViews.candidates[0].id, '2');

  const byLikes = groupAndSort(compiled, 'likes');
  assert.strictEqual(byLikes.candidates[0].id, '3');
});

test('compile: respects maxItems limit', async () => {
  const input = {
    query: {},
    items: Array(10).fill(0).map((_, i) => ({ evidence: { kind: 'platform_page' }, id: `item-${i}`,
      metrics: { views: 1000 - i * 100 }
    }))
  };

  const compiled = compile(input);
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');
  const grouped = groupAndSort(compiled, 'views', 5);

  assert.strictEqual(grouped.candidates.length, 5);
});

test('compile: protects CSV against formula injection', () => {
  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', title: '=1+1', author: '+cmd', metrics: { views: 1000 } },
      { evidence: { kind: 'platform_page' }, id: '2', title: '@SUM(A1:A10)', metrics: { views: 2000 } }
    ]
  };

  const compiled = compile(input);
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');
  const grouped = groupAndSort(compiled, 'views');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-csv-'));
  const { generateOutputs } = require('../src/services/productReferenceResearch.js');

  generateOutputs(compiled, grouped, tmpDir);

  const csv = fs.readFileSync(path.join(tmpDir, 'references.csv'), 'utf8');
  assert.ok(csv.includes("'=1+1")); // Should be prefixed with '
  assert.ok(csv.includes("'+cmd"));

  fs.rmSync(tmpDir, { recursive: true });
});

test('executeNative: creates all output files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-execute-'));
  const inputPath = path.join(tmpDir, 'input.json');
  const outputPath = path.join(tmpDir, 'result.json');

  const input = {
    query: { product: '测试商品' },
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', platform: 'test', region: 'CN', metrics: { views: 1000 } },
      { evidence: { kind: 'platform_page' }, id: '2', platform: 'test', region: 'CN', metrics: { views: 2000 } }
    ]
  };

  fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

  const result = await executeNative({
    inputPath,
    outputPath,
    parameters: {},
    report: () => {}
  });

  assert.ok(fs.existsSync(outputPath));
  assert.ok(fs.existsSync(path.join(tmpDir, 'references.md')));
  assert.ok(fs.existsSync(path.join(tmpDir, 'references.csv')));
  assert.ok(fs.existsSync(path.join(tmpDir, 'creative-brief.json')));

  assert.strictEqual(result.assets.length, 5);
  assert.ok(fs.existsSync(path.join(tmpDir, 'report.html')));
  assert.strictEqual(result.summary.total_items, 2);
  assert.strictEqual(result.summary.candidates_count, 2);

  fs.rmSync(tmpDir, { recursive: true });
});

test('executeNative: handles empty metrics gracefully', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-empty-'));
  const inputPath = path.join(tmpDir, 'input.json');
  const outputPath = path.join(tmpDir, 'result.json');

  const input = {
    query: { product: '无数据商品' },
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', platform: 'test', metrics: {} },
      { evidence: { kind: 'platform_page' }, id: '2', platform: 'test', metrics: { views: 0 } }
    ]
  };

  fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

  const result = await executeNative({
    inputPath,
    outputPath,
    parameters: {},
    report: () => {}
  });

  // Item 1 has no views, should be excluded
  assert.strictEqual(result.summary.excluded_count, 1);
  // Item 2 has views:0 which is a valid number, should be included
  assert.strictEqual(result.summary.candidates_count, 1);

  fs.rmSync(tmpDir, { recursive: true });
});

test('cross-platform sorting does not mix platforms', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-platform-'));
  const inputPath = path.join(tmpDir, 'input.json');
  const outputPath = path.join(tmpDir, 'result.json');

  const input = {
    query: { product: '跨平台测试' },
    items: [
      { evidence: { kind: 'platform_page' }, id: 'd1', platform: 'douyin', region: 'CN', metrics: { views: 5000 } },
      { evidence: { kind: 'platform_page' }, id: 't1', platform: 'tiktok', region: 'US', metrics: { views: 8000 } },
      { evidence: { kind: 'platform_page' }, id: 'd2', platform: 'douyin', region: 'CN', metrics: { views: 3000 } }
    ]
  };

  fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

  const result = await executeNative({
    inputPath,
    outputPath,
    parameters: {},
    report: () => {}
  });

  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

  // Should have 2 platform groups
  assert.strictEqual(output.summary.platform_groups, 2);

  // Within douyin:CN group, d1 should be before d2
  const douyinGroup = output.groups['douyin:CN'];
  assert.strictEqual(douyinGroup[0].id, 'd1');
  assert.strictEqual(douyinGroup[1].id, 'd2');

  fs.rmSync(tmpDir, { recursive: true });
});

test('evidence levels are counted correctly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-evidence-'));
  const inputPath = path.join(tmpDir, 'input.json');
  const outputPath = path.join(tmpDir, 'result.json');

  const input = {
    query: {},
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', evidence: { kind: 'platform_page' }, metrics: { views: 100 } },
      { evidence: { kind: 'platform_page' }, id: '2', evidence: { kind: 'search_snippet' }, metrics: { views: 200 } },
      { evidence: { kind: 'platform_page' }, id: '3', evidence: { kind: 'unverified' }, metrics: { views: 300 } },
      { id: '4', metrics: { views: 400 } }
    ]
  };

  fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

  await executeNative({
    inputPath,
    outputPath,
    parameters: {},
    report: () => {}
  });

  const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));

  assert.strictEqual(output.summary.evidence_distribution.platform_page, 1);
  assert.strictEqual(output.summary.evidence_distribution.search_snippet, 1);
  assert.strictEqual(output.summary.evidence_distribution.unverified, 1);
  assert.strictEqual(output.summary.evidence_distribution.unknown, 1);

  assert.ok(output.warnings.some(w => w.includes('搜索摘要')));
  assert.ok(output.warnings.some(w => w.includes('证据等级未验证')));

  fs.rmSync(tmpDir, { recursive: true });
});

test('selected items appear in creative brief', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-brief-'));
  const inputPath = path.join(tmpDir, 'input.json');
  const outputPath = path.join(tmpDir, 'result.json');

  const input = {
    query: {},
    product_facts: ['材质：羊毛', '价位：200-300元'],
    items: [
      { evidence: { kind: 'platform_page' }, id: '1', selected: true, url: 'https://example.com/1', analysis: { hook: '测试' }, metrics: { views: 100 } },
      { evidence: { kind: 'platform_page' }, id: '2', selected: false, metrics: { views: 200 } }
    ],
    experiments: ['实验A：测试标题']
  };

  fs.writeFileSync(inputPath, JSON.stringify(input), 'utf8');

  await executeNative({
    inputPath,
    outputPath,
    parameters: {},
    report: () => {}
  });

  const brief = JSON.parse(fs.readFileSync(path.join(tmpDir, 'creative-brief.json'), 'utf8'));

  assert.strictEqual(brief.selected_sources.length, 1);
  assert.strictEqual(brief.selected_sources[0].id, '1');
  assert.strictEqual(brief.selected_sources[0].analysis_basis, 'metadata_only');
  assert.equal(brief.selected_sources[0].analysis.hook, '测试');
  assert.strictEqual(brief.product_facts.length, 2);
  assert.strictEqual(brief.experiments.length, 1);

  fs.rmSync(tmpDir, { recursive: true });
});

test('query filters are applied only when requested and retain unknowns otherwise', () => {
  const { groupAndSort } = require('../src/services/productReferenceResearch.js');
  const compiled = compile({ query: { platforms: ['douyin'], region: 'CN', since: '2026-09-01', until: '2026-09-30' }, items: [
    { evidence: { kind: 'platform_page' }, id: 'keep', platform: 'douyin', region: 'CN', published_at: '2026-09-10', metrics: { views: 2 } },
    { evidence: { kind: 'platform_page' }, id: 'platform', platform: 'tiktok', region: 'CN', published_at: '2026-09-10', metrics: { views: 3 } },
    { evidence: { kind: 'platform_page' }, id: 'region', platform: 'douyin', region: 'US', published_at: '2026-09-10', metrics: { views: 4 } },
    { evidence: { kind: 'platform_page' }, id: 'unknown', platform: 'douyin', published_at: null, metrics: { views: 5 } }
  ] });
  const filtered = groupAndSort(compiled, 'views');
  assert.deepEqual(filtered.candidates.map(item => item.id), ['keep']);
  assert.match(filtered.excluded.find(item => item.id === 'platform').exclusion_reason, /platform_mismatch/);
  assert.match(filtered.excluded.find(item => item.id === 'unknown').exclusion_reason, /region_unknown/);
  const unfiltered = groupAndSort(compile({ query: {}, items: [{ evidence: { kind: 'platform_page' }, id: 'unknown', metrics: { views: 1 } }] }), 'views');
  assert.equal(unfiltered.candidates.length, 1);
});

test('TikTok user handles are valid URL paths while credentials are rejected', () => {
  const result = compile({ query: {}, items: [{ evidence: { kind: 'platform_page' }, id: 't', url: 'https://www.tiktok.com/@creator/video/123?utm_source=x', metrics: { views: 1 } }] });
  assert.match(result.items[0].url, /tiktok\.com\/@creator\/video\/123/);
  assert.throws(() => compile({ query: {}, items: [{ evidence: { kind: 'platform_page' }, id: 'bad', url: 'https://user:pass@example.com/video' }] }), { code: 'URL_CONTAINS_CREDENTIALS' });
});

test('coherent dedup prefers platform evidence, keeps snapshots, and does not mutate input', () => {
  const {groupAndSort} = require('../src/services/productReferenceResearch');
  const input = compile({query:{},items:[
    { evidence: { kind: 'platform_page' }, id: 'snippet', url:'https://example.com/v?utm_source=x', metrics:{views:999999}, evidence:{kind:'search_snippet'}},
    { evidence: { kind: 'platform_page' }, id: 'platform', url:'https://example.com/v', metrics:{views:31}, evidence:{kind:'platform_page'}},
  ]});
  const before = JSON.stringify(input);
  const result = groupAndSort(input);
  assert.equal(result.items.length,1);
  assert.equal(result.items[0].metrics.views,31);
  assert.equal(result.items[0].duplicate_observations[0].metrics.views,999999);
  assert.equal(JSON.stringify(input),before);
});
test('invalid count/date values remain unknown and empty results are not viral claims', () => {
  const data = compile({query:{},items:[{ evidence: { kind: 'platform_page' }, id: 'x',published_at:'2026-02-30',metrics:{views:-1,likes:'1.2.3万',comments:'1,234'}}]});
  assert.equal(data.items[0].published_at,null);
  assert.equal(data.items[0].metrics.views,null);
  assert.equal(data.items[0].metrics.likes,null);
  assert.equal(data.items[0].metrics.comments,1234);
});
test('a total limit retains representation of multiple platforms without global heat ranking', () => {
  const {groupAndSort}=require('../src/services/productReferenceResearch');
  const result=groupAndSort(compile({query:{},items:[
    { evidence: { kind: 'platform_page' }, id: 'd1',platform:'douyin',metrics:{views:2}},
    { evidence: { kind: 'platform_page' }, id: 'd2',platform:'douyin',metrics:{views:1}},
    { evidence: { kind: 'platform_page' }, id: 'y1',platform:'youtube',metrics:{views:99999}}
  ]}),'views',2);
  assert.deepEqual(result.candidates.map(item=>item.id),['d1','y1']);
  assert.equal(Object.keys(result.groups).length,2);
});
