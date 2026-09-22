'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { renderReport } = require('./productReferenceReport');

const fail = (code, message) => Object.assign(new Error(message), {code});
const mdCell = value => String(value ?? '未知').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\|/g,'&#124;').replace(/[\r\n]+/g,' ').replace(/([\\\x60*_\[\]])/g,'\\$1');
const mdLink = value => value ? '[链接](<' + value.replace(/</g,'%3C').replace(/>/g,'%3E') + '>)' : '无链接';

// Parse common count strings to numbers: "1.2万", "3.5M", "1.2K", "1亿"
function parseCount(text) {
  if (typeof text === 'number') return Number.isFinite(text) && text >= 0 ? Math.floor(text) : null;
  if (text == null || text === '') return null;
  const str = String(text).trim();
  if (/^\d+$/.test(str)) return Number.isSafeInteger(Number(str)) ? Number(str) : null;
  if (/^\d{1,3}(?:,\d{3})+$/.test(str)) return parseCount(str.replace(/,/g, ''));

  const match = str.match(/^(\d+(?:\.\d+)?)\s*([万亿KMBkmb])$/);
  if (!match) return null;

  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0) return null;

  const unit = match[2];
  const multipliers = {
    '万': 10000, '亿': 100000000,
    'K': 1000, 'k': 1000,
    'M': 1000000, 'm': 1000000,
    'B': 1000000000, 'b': 1000000000
  };

  const count = Math.floor(num * (multipliers[unit] || 1));
  return Number.isSafeInteger(count) ? count : null;
}

// Normalize URL by removing common tracking parameters, preserving platform identity
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) throw fail('URL_CONTAINS_CREDENTIALS', 'URL 不得包含凭据');
    // Remove common tracking params but keep platform video IDs
    const tracking = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
                      'from', 'share_source', 'timestamp', 'share_app_id'];
    tracking.forEach(p => parsed.searchParams.delete(p));
    parsed.searchParams.sort();
    return parsed.toString();
  } catch (error) {
    if (error?.code === 'URL_CONTAINS_CREDENTIALS') throw error;
    return null;
  }
}

// Parse date string to ISO date (YYYY-MM-DD) or null
function parseDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(dateStr)) return null;
  const day = dateStr.slice(0, 10);
  if (!Number.isFinite(Date.parse(day))) return null;
  if (new Date(day).toISOString().slice(0, 10) !== day) return null;
  const d = new Date(dateStr);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

// Validate item against schema limits
function validateItem(item, index) {
  if (!item || typeof item !== 'object') throw fail('INVALID_ITEM', `items[${index}] 不是对象`);
  if (!item.id || typeof item.id !== 'string' || item.id.length > 200) {
    throw fail('INVALID_ITEM_ID', `items[${index}].id 必须是不超过 200 字符的字符串`);
  }
  if (item.url && typeof item.url !== 'string') throw fail('INVALID_URL', `items[${index}].url 必须是字符串`);
  if (item.title && item.title.length > 500) throw fail('TITLE_TOO_LONG', `items[${index}].title 超过 500 字符`);
  if (item.author && item.author.length > 200) throw fail('AUTHOR_TOO_LONG', `items[${index}].author 超过 200 字符`);
  for (const key of ['url','title','author','platform','region','published_at','observed_at','analysis_basis']) {
    if (item[key] != null && typeof item[key] !== 'string') throw fail('INVALID_FIELD', key + ' 必须为字符串或 null');
  }
}

// Compile: normalize and validate input data
function compile(input) {
  if (!input || typeof input !== 'object') throw fail('INVALID_INPUT', '输入必须是对象');
  if (!input.query || typeof input.query !== 'object' || Array.isArray(input.query)) throw fail('INVALID_QUERY', 'query 字段必须存在且为对象');
  for (const key of ['product_facts', 'experiments']) {
    if (input[key] != null && !Array.isArray(input[key])) throw fail('INVALID_INPUT', key + ' 必须为数组');
  }
  if (input.query.platforms != null && !Array.isArray(input.query.platforms)) throw fail('INVALID_QUERY', 'query.platforms 必须为数组');

  const items = input.items || [];
  if (!Array.isArray(items)) throw fail('INVALID_ITEMS', 'items 必须是数组');
  if (items.length > 1000) throw fail('TOO_MANY_ITEMS', 'items 不得超过 1000 项');

  items.forEach((item, i) => validateItem(item, i));

  const normalized = items.map(item => {
    const url = normalizeUrl(item.url);
    const metrics = item.metrics || {};

    return {
      id: item.id,
      url,
      url_original: item.url || null,
      platform: item.platform || null,
      title: item.title || null,
      author: item.author || null,
      author_followers: parseCount(item.author_followers),
      description: typeof item.description === 'string' ? item.description.slice(0,3000) : null,
      discovery_queries: Array.isArray(item.discovery_queries) ? item.discovery_queries.filter(x=>typeof x==='string').slice(0,12) : [],
      comment_samples: Array.isArray(item.comment_samples) ? item.comment_samples.slice(0,100) : [],
      published_at: parseDate(item.published_at),
      published_at_original: item.published_at || null,
      region: item.region || null,
      observed_at: item.observed_at || null,
      evidence: item.evidence ? {...item.evidence, kind: ['platform_page','authorized_export','search_snippet','unverified'].includes(item.evidence.kind) ? item.evidence.kind : 'unverified'} : null,
      metrics: {
        views: parseCount(metrics.views),
        likes: parseCount(metrics.likes),
        comments: parseCount(metrics.comments),
        shares: parseCount(metrics.shares),
        saves: parseCount(metrics.saves),
        views_original: metrics.views,
        likes_original: metrics.likes,
        comments_original: metrics.comments,
        shares_original: metrics.shares,
        saves_original: metrics.saves
      },
      content_kind: item.content_kind || null,
      duration_seconds: typeof item.duration_seconds === 'number' && Number.isFinite(item.duration_seconds) && item.duration_seconds >= 0 ? item.duration_seconds : null,
      analysis_basis: item.analysis_basis || 'metadata_only',
      analysis: item.analysis || null,
      selected: Boolean(item.selected)
    };
  });

  return { query: input.query, product_facts: input.product_facts || [], items: normalized, experiments: input.experiments || [], collection: input.collection || null };
}

// Group and sort items by platform and region
function groupAndSort(compiled, sortBy = 'auto', maxItems = null) {
  const validSortKeys = ['auto', 'views', 'likes', 'comments', 'shares', 'saves'];
  if (!validSortKeys.includes(sortBy)) throw fail('INVALID_SORT_KEY', `sort_by 必须是 ${validSortKeys.join(', ')} 之一`);

  const groups = new Map();
  const excluded = [];
  const urlMap = new Map(); // Track URL duplicates
  const query = compiled.query || {};
  const requestedPlatforms = Array.isArray(query.platforms) ? query.platforms.filter(value => value && value !== 'generic').map(String) : [];
  const since = query.since ? parseDate(query.since) : null;
  const until = query.until ? parseDate(query.until) : null;
  if (query.since && !since) throw fail('INVALID_QUERY_DATE', 'query.since 不是有效日期');
  if (query.until && !until) throw fail('INVALID_QUERY_DATE', 'query.until 不是有效日期');
  if (since && until && since > until) throw fail('INVALID_QUERY_RANGE', 'query.since 不能晚于 query.until');

  // Choose one coherent snapshot per URL; do not splice stale snippet metrics
  // into a newer platform observation. Keep the other snapshots for inspection.
  const rank = item => ({platform_page:3, authorized_export:3, search_snippet:1}[item.evidence?.kind] || 0);
  for (const original of compiled.items) {
    const key = original.url || ('id:' + original.id);
    const existing = urlMap.get(key);
    if (!existing) { urlMap.set(key, {...original, duplicate_sources:[original.id], duplicate_observations:[]}); continue; }
    const prefer = rank(original) > rank(existing) || (rank(original) === rank(existing) && (Date.parse(original.observed_at)||0) > (Date.parse(existing.observed_at)||0));
    const sources = [...existing.duplicate_sources, original.id];
    const observations = [...existing.duplicate_observations, {id:prefer ? existing.id : original.id, observed_at:prefer ? existing.observed_at : original.observed_at, evidence:prefer ? existing.evidence : original.evidence, metrics:prefer ? existing.metrics : original.metrics}];
    urlMap.set(key, {...(prefer ? original : existing), duplicate_sources:sources, duplicate_observations:observations});
  }
  for (const item of urlMap.values()) {
    // Deduplicate URLs

    // Filter only when the user actually requested a platform, region or date range.
    const hasUncertainDate = !item.published_at && item.published_at_original;
    const reasons = [];
    if (hasUncertainDate) reasons.push('published_at_invalid');
    if (requestedPlatforms.length && (!item.platform || !requestedPlatforms.includes(item.platform))) {
      reasons.push(item.platform ? 'platform_mismatch' : 'platform_unknown');
    }
    if (since || until) {
      if (!item.published_at) reasons.push('published_at_unknown');
      else if (since && item.published_at < since) reasons.push('before_since');
      else if (until && item.published_at > until) reasons.push('after_until');
    }
    if (query.region) {
      if (!item.region) reasons.push('region_unknown');
      else if (String(item.region).toLowerCase() !== String(query.region).toLowerCase()) reasons.push('region_mismatch');
    }

    if (reasons.length) {
      excluded.push({
        ...item,
        exclusion_reason: reasons.join(', ')
      });
      continue;
    }

    if (!['platform_page','authorized_export'].includes(item.evidence?.kind)) {
      excluded.push({...item, exclusion_reason:'evidence_unverified'});
      continue;
    }
    // Explicit metric choices stay explicit. Automatic choices are made only
    // within one platform/region after applying the actual query constraints.
    if (sortBy !== 'auto' && item.metrics[sortBy] == null) {
      excluded.push({
        ...item,
        exclusion_reason: `missing_${sortBy}`
      });
      continue;
    }

    // Group by platform and region
    const key = `${item.platform || 'unknown'}:${item.region || 'unknown'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  const ranking = {};
  for (const [key, items] of groups.entries()) {
    const priorities=['views','likes','saves','comments','shares'];
    const coverage=Object.fromEntries(priorities.map(metric=>[metric,items.filter(row=>row.metrics[metric]!=null).length]));
    const metric=sortBy==='auto' ? priorities.find(metric=>coverage[metric]===items.length)
      || priorities.slice().sort((a,b)=>coverage[b]-coverage[a]).find(metric=>coverage[metric]>0) : sortBy;
    const eligible=items.filter(row=>metric&&row.metrics[metric]!=null);
    for(const row of items)if(!eligible.includes(row))excluded.push({...row,exclusion_reason:metric?'missing_'+metric:'missing_metrics'});
    eligible.sort((a,b)=>b.metrics[metric]-a.metrics[metric] || a.id.localeCompare(b.id));
    groups.set(key,eligible);
    if(eligible.length)ranking[key]={metric,population:eligible.length,basis:'public_platform_metrics',selection:sortBy};
  }

  // Preserve platform group boundaries in the output. `candidates` is a
  // deterministic presentation flattening, not a cross-platform heat ranking.
  const orderedGroups = [...groups.keys()].sort().map(key => groups.get(key));
  const groupedCandidates = orderedGroups.flat();
  // A total limit should not erase a later platform just because its name
  // sorts last. Allocate round-robin, preserving order within each platform.
  let limited = groupedCandidates;
  if (maxItems) {
    const picked = new Set();
    for (let i=0;picked.size<Math.min(maxItems,groupedCandidates.length);i++) {
      for (const group of orderedGroups) {
        if (group[i]) picked.add(group[i]);
        if (picked.size===maxItems) break;
      }
    }
    limited = groupedCandidates.filter(item=>picked.has(item));
  }

  const shown = new Set(limited);
  return { groups: Object.fromEntries([...groups].map(([key, rows])=>[key,rows.filter(item=>shown.has(item))]).filter(([,rows])=>rows.length)), ranking, candidates: limited, excluded, items:[...urlMap.values()] };
}

// Generate outputs
function generateOutputs(compiled, grouped, outputDir) {
  const warnings = [];

  // Count evidence types
  const evidenceCounts = { platform_page: 0, authorized_export: 0, search_snippet: 0, unverified: 0, unknown: 0 };
  for (const item of grouped.items) {
    const kind = item.evidence?.kind || 'unknown';
    evidenceCounts[kind] = (evidenceCounts[kind] || 0) + 1;
  }

  if (evidenceCounts.search_snippet > 0) {
    warnings.push('部分数据来源为搜索摘要，不代表平台确认榜单');
  }
  if (evidenceCounts.unverified > 0 || evidenceCounts.unknown > 0) {
    warnings.push(`${evidenceCounts.unverified + evidenceCounts.unknown} 项证据等级未验证`);
  }
  if (compiled.query.platforms?.length > 1) warnings.push('不同平台仅在各自分组内排序，不能把播放量直接跨平台比较');
  if (compiled.query.region || compiled.query.since || compiled.query.until) warnings.push('时间与地区筛选仅作用于已知字段，未知项保留在排除清单并注明原因');

  // result.json
  const result = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    query: compiled.query,
    summary: {
      total_items: grouped.items.length,
      collected_records: compiled.items.length,
      candidates_count: grouped.candidates.length,
      excluded_count: grouped.excluded.length,
      unranked_count: grouped.excluded.filter(item => item.exclusion_reason?.includes('missing_')).length,
      evidence_distribution: evidenceCounts,
      platform_groups: Object.keys(grouped.groups).length
    },
    groups: grouped.groups,
    ranking: grouped.ranking,
    items: grouped.items,
    collection: compiled.collection,
    candidates: grouped.candidates,
    excluded: grouped.excluded,
    warnings,
    next_steps: [
      '打开 report.html 查看可筛选的图表、参考视频与来源详情',
      '在 references.md 和 references.csv 中查看可点击清单',
      '使用 creative-brief.json 作为创意方向输入',
      '补充商品事实和实验提案以完善分析'
    ]
  };

  fs.writeFileSync(path.join(outputDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

  // references.md
  let md = `# 电商参考清单\n\n`;
  md += `**查询**: ${mdCell(JSON.stringify(compiled.query))}\n\n`;
  md += `**统计**: ${grouped.candidates.length} 个候选项，${grouped.excluded.length} 个被排除\n\n`;

  for (const [groupKey, items] of Object.entries(grouped.groups)) {
    const [platform, region] = groupKey.split(':');
    md += `## ${mdCell(platform)} - ${mdCell(region)}\n\n`;
    if(grouped.ranking?.[groupKey])md += `排序依据：${mdCell(({views:'播放量',likes:'点赞',saves:'收藏',comments:'评论',shares:'分享'})[grouped.ranking[groupKey].metric])}；仅比较本平台、当前范围内有原站或授权导出证据的样本。\n\n`;
    md += '| 标题 | 作者 | 发布日期 | 播放量 | 点赞 | 链接 | 证据 / 观察时间 |\n';
    md += '|------|------|----------|--------|------|------|------|\n';
    for (const item of items) {
      const title = mdCell(item.title || '无标题');
      const author = mdCell(item.author || '未知');
      const date = item.published_at || '未知';
      const views = item.metrics.views != null ? item.metrics.views.toLocaleString() : '未知';
      const likes = item.metrics.likes != null ? item.metrics.likes.toLocaleString() : '未知';
      const url = item.url || '无链接';
      md += `| ${title} | ${author} | ${date} | ${views} | ${likes} | ${mdLink(item.url)} | ${mdCell(item.evidence?.kind)} / ${mdCell(item.observed_at)} |\n`;
    }
    md += `\n`;
  }

  if (grouped.excluded.length > 0) {
    md += `## 待核验 / 未排名的项目\n\n`;
    md += `共 ${grouped.excluded.length} 项未进入按指标排序；它们仍保留为参考线索，原因写在最后一列。\n\n`;
    md += `| 标题 | 作者 | 平台 | 播放量 | 链接 | 原因 |\n|------|------|------|--------|------|------|\n`;
    for (const item of grouped.excluded) {
      const title = mdCell(item.title || '无标题');
      const author = mdCell(item.author || '未知');
      const reason = mdCell(item.exclusion_reason || '未通过当前筛选');
      md += `| ${title} | ${author} | ${mdCell(item.platform)} | ${item.metrics.views == null ? '未知' : item.metrics.views.toLocaleString()} | ${mdLink(item.url)} | ${reason} · ${mdCell(item.evidence?.kind)} |\n`;
    }
    md += `\n`;
  }

  fs.writeFileSync(path.join(outputDir, 'references.md'), md, 'utf8');

  // references.csv with formula injection protection
  const csvEscape = (val) => {
    if (val == null) return '';
    let str = String(val);
    // Protect against CSV formula injection
    if (/^[\s\uFEFF]*[=+\-@]/.test(str) || /^[\t\r\n]/.test(str)) str = "'" + str;
    if (str.includes('"')) str = str.replace(/"/g, '""');
    if (str.includes(',') || /[\r\n]/.test(str) || str.includes('"')) return `"${str}"`;
    return str;
  };

  let csv = '\uFEFFID,平台,地区,标题,作者,发布日期,播放量,点赞,评论,分享,收藏,链接,证据等级,观察时间,分析依据,未排名原因\n';
  for (const item of grouped.items) {
    csv += [
      csvEscape(item.id),
      csvEscape(item.platform),
      csvEscape(item.region),
      csvEscape(item.title),
      csvEscape(item.author),
      csvEscape(item.published_at),
      csvEscape(item.metrics.views),
      csvEscape(item.metrics.likes),
      csvEscape(item.metrics.comments),
      csvEscape(item.metrics.shares),
      csvEscape(item.metrics.saves),
      csvEscape(item.url),
      csvEscape(item.evidence?.kind),
      csvEscape(item.observed_at),
      csvEscape(item.analysis_basis),
      csvEscape(grouped.excluded.find(candidate=>candidate.id === item.id)?.exclusion_reason)
    ].join(',') + '\n';
  }

  fs.writeFileSync(path.join(outputDir, 'references.csv'), csv, 'utf8');

  // creative-brief.json
  const selectedItems = grouped.items.filter(item => item.selected);
  const brief = {
    selected_sources: selectedItems.map(item => ({
      id: item.id,
      url: item.url,
      platform: item.platform,
      title: item.title,
      analysis_basis: item.analysis_basis,
      analysis: item.analysis,
      evidence: item.evidence,
      caveat: grouped.excluded.find(candidate => candidate.id === item.id)?.exclusion_reason || null
    })),
    product_facts: compiled.product_facts,
    experiments: compiled.experiments,
    data_gaps: [
      compiled.product_facts.length === 0 && '商品事实尚未填写',
      selectedItems.length === 0 && '未选择参考来源',
      selectedItems.some(item => !item.analysis) && '部分选中来源缺少分析',
      selectedItems.some(item => item.analysis_basis === 'metadata_only') && '部分来源仅有元数据，尚未实际观看视频'
    ].filter(Boolean),
    next_steps: [
      '补充商品事实（材质、价位、用途等）',
      '标记 selected:true 并添加 analysis',
      '确认实验提案并准备脚本创作'
    ]
  };

  fs.writeFileSync(path.join(outputDir, 'creative-brief.json'), JSON.stringify(brief, null, 2), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'report.html'), renderReport(result, brief), 'utf8');

  return { result, references_md: md, references_csv: csv, creative_brief: brief };
}

// ExecuteNative: main entry point
async function executeNative(ctx) {
  const { inputPath, outputPath, parameters = {}, report = () => {} } = ctx;

  if (!fs.existsSync(inputPath)) throw fail('INPUT_NOT_FOUND', '输入文件不存在');

  if (fs.statSync(inputPath).size > 8 * 1024 * 1024) throw fail('INPUT_TOO_LARGE', '参考清单不得超过 8 MiB');
  const rawInput = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  operation.validateParameters(parameters);

  const sortBy = parameters.sort_by || 'auto';
  const maxItems = parameters.max_items || null;
  const limit = parameters.limit || null;

  report({ stage: 'compiling', message: '正在规范化输入数据' });
  const compiled = compile(rawInput);

  report({ stage: 'grouping', message: '正在分组和排序' });
  const grouped = groupAndSort(compiled, sortBy, limit || maxItems);

  report({ stage: 'generating', message: '正在生成输出文件' });
  const outputDir = path.dirname(outputPath);
  fs.mkdirSync(outputDir, {recursive:true});
  const outputs = generateOutputs(compiled, grouped, outputDir);

  // Write main JSON output
  fs.writeFileSync(outputPath, JSON.stringify(outputs.result, null, 2), 'utf8');

  report({ stage: 'complete', message: '成果已生成' });

  return {
    summary: outputs.result.summary,
    assets: [
      { path: outputPath, kind: 'result_json' },
      { path: path.join(outputDir, 'references.md'), kind: 'markdown_reference' },
      { path: path.join(outputDir, 'references.csv'), kind: 'csv_export' },
      { path: path.join(outputDir, 'creative-brief.json'), kind: 'brief_json' },
      { path: path.join(outputDir, 'report.html'), kind: 'html_report' }
    ].map(asset=>({...asset,file:path.basename(asset.path),type:'document',role:asset.kind}))
  };
}

// Operation contract for registry
const operation = {
  id: 'local.research.product-references',
  title: '电商视频研究：交互图表与参考报告',
  description: '整理平台参考数据，自动交付交互图表报告、可追溯清单与创意输入；图表按实际数据生成，支持筛选和导出',
  kind: 'document',
  phase: 'research',
  component_id: null, // No external component required
  output_extension: 'json',
  side_effects: { network: false, filesystem_write: true, database_write: false, external_write: false, paid: false },
  source: 'backend-node/src/services/productReferenceResearch.js',
  defaults: { sort_by: 'auto', max_items: null, limit: null },
  validateParameters(parameters) {
    for (const key of ['max_items', 'limit']) {
      const value = parameters[key];
      if (value != null && (!Number.isInteger(value) || value < 1 || value > 1000)) throw fail('INVALID_PARAMETER', key + ' 必须为 1–1000 的整数');
    }
  },
  parameter_schema: {
    type: 'object',
    properties: {
      sort_by: { type: 'string', enum: ['auto', 'views', 'likes', 'comments', 'shares', 'saves'] },
      max_items: { type: ['integer', 'null'], minimum: 1, maximum: 1000 },
      limit: { type: ['integer', 'null'], minimum: 1, maximum: 1000 }
    }
  },
  executeNative
};

module.exports = { operation, compile, executeNative, groupAndSort, generateOutputs };
