'use strict';

// Shared by the offline report and its contract tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ResearchReport = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const metrics = { views: '播放', likes: '点赞', comments: '评论', shares: '分享', saves: '收藏' };
  const verified = row => ['platform_page', 'authorized_export'].includes(row.evidence.kind);
  const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const counted = (rows, key) => Object.entries(rows.reduce((out, row) => {
    const value = key(row); out[value] = (out[value] || 0) + 1; return out;
  }, {})).map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  function filterRows(rows, filters = {}) {
    const search = (filters.search || '').trim().toLocaleLowerCase();
    return rows.filter(row => (!filters.platform || row.platform === filters.platform)
      && (!filters.evidence || row.evidence.kind === filters.evidence)
      && (!filters.content_kind || row.content_kind === filters.content_kind)
      && (!filters.since || row.published_at && row.published_at >= filters.since)
      && (filters.scope === 'all' || row.scope_match)
      && (!search || [row.title, row.author, row.id].some(v => v.toLocaleLowerCase().includes(search))));
  }
  function view(rows, metric = 'views') {
    if (!metrics[metric]) metric = 'views';
    const sourced = rows.filter(verified);
    const metricRows = sourced.filter(row => row.scope_match && known(row.metrics[metric]));
    const groups = new Map();
    for (const row of metricRows) {
      const duration = row.duration_seconds;
      const band = duration == null ? '时长未核验' : duration <= 180 ? '3分钟内' : duration <= 600 ? '3–10分钟' : '10分钟以上';
      const key = JSON.stringify([row.platform, row.region, row.content_kind, band]);
      if (!groups.has(key)) groups.set(key, { platform: row.platform, region: row.region, content_kind: row.content_kind, band, rows: [] });
      groups.get(key).rows.push(row);
    }
    const comparisons = [...groups.values()].filter(group => group.rows.length >= 2 && new Set(group.rows.map(row=>row.metrics[metric])).size > 1).sort((a,b)=>b.rows.length-a.rows.length).map(group => {
      group.rows.sort((a, b) => b.metrics[metric] - a.metrics[metric] || a.id.localeCompare(b.id));
      group.maximum = Math.max(...group.rows.map(row => row.metrics[metric]));
      return group;
    });
    // A publication histogram counts observed samples; it is not a heat trend.
    const dated = sourced.filter(row => row.scope_match && row.published_at);
    const months = counted(dated, row => row.published_at.slice(0, 7)).sort((a, b) => a.label.localeCompare(b.label));
    return {
      total: rows.length, sourced: sourced.length,
      platforms: counted(rows, row => row.platform), evidence: counted(rows, row => row.evidence.kind),
      availableMetrics: Object.keys(metrics).filter(key => sourced.some(row => row.scope_match && known(row.metrics[key]))),
      metricRows, comparisons,
      singleSamples: metricRows.filter(row => !comparisons.some(group => group.rows.includes(row))),
      months: dated.length >= 2 && months.length >= 2 ? months : [], datedCount: dated.length,
      analyses: rows.filter(row => row.analysis && row.analysis_basis !== 'metadata_only'),
    };
  }
  function csv(rows) {
    const cell = value => {
      let text = value == null ? '' : String(value);
      if (/^[\s\uFEFF]*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    return '\uFEFF' + [['ID', '平台', '标题', '作者', '发布日期', '观察时间', '播放', '点赞', '评论', '分享', '收藏', '时长秒', '原链接', '证据类型', '证据说明', '分析依据', '符合查询'],
      ...rows.map(row => [row.id, row.platform, row.title, row.author, row.published_at, row.observed_at,
        ...Object.keys(metrics).map(key => row.metrics[key]), row.duration_seconds, row.url, row.evidence.kind, row.evidence.note, row.analysis_basis, row.scope_match])]
      .map(values => values.map(cell).join(',')).join('\r\n');
  }
  function analysis(rows) {
    const eligible=rows.filter(row=>verified(row)&&row.scope_match);
    const byPlatform=new Map();
    for(const row of eligible){if(!byPlatform.has(row.platform))byPlatform.set(row.platform,[]);byPlatform.get(row.platform).push(row);}
    const shortlists=[],relationships=[],efficiency=[],durationGroups=[];
    const median=values=>{const v=values.slice().sort((a,b)=>a-b);return v.length%2?v[(v.length-1)/2]:(v[v.length/2-1]+v[v.length/2])/2;};
    for(const [platform,samples] of byPlatform){
      const selected=new Set();
      for(const metric of ['saves','likes','comments']){
        const ranked=samples.filter(r=>known(r.metrics[metric])).sort((a,b)=>b.metrics[metric]-a.metrics[metric]);
        if(ranked.length<2 || ranked[0].metrics[metric]===ranked.at(-1).metrics[metric])continue;
        const pick=ranked.find(r=>!selected.has(r.id));if(!pick)continue;selected.add(pick.id);
        shortlists.push({row:pick,platform,metric,rank:ranked.indexOf(pick)+1,population:ranked.length,value:pick.metrics[metric],basis:'public_metric_screening'});
      }
      const points=samples.filter(r=>known(r.duration_seconds)&&r.duration_seconds>0&&known(r.metrics.likes));
      if(points.length>=3)relationships.push({platform,rows:points});
      const ratios=samples.filter(r=>known(r.metrics.saves)&&known(r.metrics.views)&&r.metrics.views>0).map(row=>({row,value:row.metrics.saves/row.metrics.views*1000})).sort((a,b)=>b.value-a.value);
      if(ratios.length>=3)efficiency.push({platform,rows:ratios.slice(0,8),population:ratios.length});
      const bins=[[0,15,'15秒内'],[15,30,'15–30秒'],[30,60,'30–60秒'],[60,180,'1–3分钟'],[180,Infinity,'3分钟以上']].map(([low,high,label],i)=>{
        const group=points.filter(r=>r.duration_seconds>low&&r.duration_seconds<=high);
        return {label,count:group.length,median:group.length?median(group.map(r=>r.metrics.likes)):null};
      }).filter(g=>g.count);
      if(bins.length>=2)durationGroups.push({platform,bins,population:points.length});
    }
    return {shortlists,relationships,efficiency,durationGroups};
  }
  return { metrics, verified, known, filterRows, view, csv, analysis };
});
