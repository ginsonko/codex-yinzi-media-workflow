(function () {
  'use strict';
  const data = JSON.parse(document.getElementById('report-data').textContent);
  const model = window.ResearchReport;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const names = {platform_page:'原站数据',authorized_export:'授权导出',search_snippet:'搜索索引',unverified:'待核验来源',unknown:'未标注来源'};
  const colors = ['#167960','#7865a0','#c6803b','#cf7787','#4f8fac'];
  const platformName = id => data.platform_labels[id] || id;
  const kindName = value => ({product_video_reference:'商品视频线索'}[value] || value || '未分类');
  const num = value => Number(value).toLocaleString('zh-CN');
  const date = value => { const parsed = new Date(value); return value && Number.isFinite(+parsed) ? parsed.toLocaleString('zh-CN',{timeZone:'Asia/Hong_Kong',hour12:false}).replace(/\//g,'-') : '未记录'; };
  const shortDate = value => value ? value.slice(0,10) : null;
  const objectText = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  let currentRows = [];
  let metric = 'views';
  function options(id, entries) { $(id).insertAdjacentHTML('beforeend', entries.map(([key,label])=>`<option value="${esc(key)}">${esc(label)}</option>`).join('')); }
  options('platform', [...new Set(data.items.map(row=>row.platform))].map(id=>[id,platformName(id)]));
  options('evidence', [...new Set(data.items.map(row=>row.evidence.kind))].map(id=>[id,names[id] || id]));
  const kinds=[...new Set(data.items.map(row=>row.content_kind).filter(Boolean))];
  options('content-kind',kinds.map(id=>[id,kindName(id)]));
  $('kind-label').hidden=kinds.length<2;
  $('scope-label').hidden = !data.items.some(row=>!row.scope_match);
  const range = data.query.since || data.query.until ? `${data.query.since || '起始不限'} 至 ${data.query.until || '截至不限'}` : '发布时间不限';
  $('query-caption').textContent = [data.query.platforms.map(platformName).join('、') || '跨平台采样', data.query.region || '市场未限定', range].join(' · ');
  const observed = data.items.map(row=>Date.parse(row.observed_at)).filter(Number.isFinite);
  const anchor=observed.length?Math.max(...observed):Date.parse(data.generated_at);
  function filters() { return {platform:$('platform').value,evidence:$('evidence').value,search:$('search').value,scope:$('scope').value,content_kind:$('content-kind').value,since:$('period').value?new Date(anchor-Number($('period').value)*86400000).toISOString().slice(0,10):null}; }
  $('snapshot-time').textContent = observed.length ? date(new Date(Math.max(...observed)).toISOString()) + ' HKT' : '观察时间未记录';
  $('scope-description').textContent = $('query-caption').textContent + '。报告生成于 ' + date(data.generated_at) + ' HKT。';
  function distribution(title, entries, lookup) {
    if (entries.length<2) return '';
    const total = entries.reduce((sum,row)=>sum+row.value,0);
    return `<div class="distribution-panel"><div class="chart-header"><h3>${esc(title)}</h3><span class="chart-caption">${num(total)} 条去重样本</span></div><div class="distribution" role="img" aria-label="${esc(entries.map(row=>(lookup(row.label)||row.label)+' '+row.value+'条').join('，'))}">${entries.map((row,i)=>`<span style="width:${row.value/total*100}%;background:${colors[i%colors.length]}" title="${esc(lookup(row.label))}：${num(row.value)}"></span>`).join('')}</div><div class="legend-list">${entries.map((row,i)=>`<span class="legend"><i class="swatch" style="background:${colors[i%colors.length]}"></i>${esc(lookup(row.label))}<strong>${num(row.value)}</strong></span>`).join('')}</div></div>`;
  }
  function openSource(id) {
    const el = [...document.querySelectorAll('.reference')].find(el=>el.dataset.id===id);
    if (el) { el.open = true; el.scrollIntoView({behavior:'smooth',block:'start'}); el.querySelector('summary').focus({preventScroll:true}); }
  }
  function metricList(row) { return Object.entries(model.metrics).filter(([key])=>model.known(row.metrics[key])).map(([key,label])=>`<div><strong>${num(row.metrics[key])}</strong><span>${label}</span></div>`).join(''); }
  function fieldList(value) {
    const labels = {hook:'开场',selling_point:'卖点',proof:'卖点证明',pacing:'节奏',cta:'行动引导',shots:'镜头',source_ids:'来源 ID',hypothesis:'待验证假设',title:'方向',description:'说明',changes:'原创变化',required_facts:'商品证据',metric:'验证指标',name:'名称',basis:'依据',watch_range:'观看范围',viewed_range:'实际观看范围',limitations:'观察限制'};
    if (!value || typeof value !== 'object') return `<p>${esc(value)}</p>`;
    return `<dl class="field-list">${Object.entries(value).map(([key,val])=>`<dt>${esc(labels[key]||key)}</dt><dd>${esc(objectText(val))}</dd>`).join('')}</dl>`;
  }
  function reference(row, index) {
    const details = [['采集时间',date(row.observed_at)+' HKT'], ...(row.published_at?[['发布日期',shortDate(row.published_at)]]:[]), ...(row.duration_seconds!=null?[['视频时长',row.duration_seconds+' 秒']]:[]), ['来源说明',row.evidence.note || names[row.evidence.kind]], ['分析依据',row.analysis_basis==='metadata_only'?'仅元数据，尚未观片':row.analysis_basis], ...(row.exclusion_reason?[['未排名原因',row.exclusion_reason]]:[])];
    const visibleMetric = Object.keys(model.metrics).find(key=>model.known(row.metrics[key]));
    return `<details class="reference" data-id="${esc(row.id)}"><summary><span class="ref-index">${String(index+1).padStart(2,'0')}</span><div><div class="ref-title">${esc(row.title)}</div><div class="ref-sub"><span>${esc(platformName(row.platform))}</span>${row.author?`<span>${esc(row.author)}</span>`:''}${row.published_at?`<span>${esc(row.published_at)}</span>`:''}</div></div><div class="ref-meta"><span class="evidence-tag ${esc(row.evidence.kind)}">${esc(names[row.evidence.kind]||row.evidence.kind)}</span>${visibleMetric?`<span>${model.metrics[visibleMetric]} ${num(row.metrics[visibleMetric])}</span>`:''}</div><span class="ref-toggle" aria-hidden="true">+</span></summary><div class="ref-details"><div class="detail-metrics">${metricList(row)}</div><dl class="provenance">${details.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div class="ref-actions">${row.url?`<a href="${esc(row.url)}" target="_blank" rel="noopener noreferrer">打开原视频 ↗</a>`:''}${row.evidence.url&&row.evidence.url!==row.url?`<a href="${esc(row.evidence.url)}" target="_blank" rel="noopener noreferrer">查看证据来源 ↗</a>`:''}<button class="text-button copy-source" data-id="${esc(row.id)}">复制来源</button></div><details><summary>完整记录${row.observations.length?'与历史快照':''}</summary><pre class="raw-record">${esc(JSON.stringify(row,null,2))}</pre></details></div></details>`;
  }
  function render() {
    currentRows = model.filterRows(data.items, filters());
    let v = model.view(currentRows, metric);
    if (!v.availableMetrics.includes(metric)) metric=v.availableMetrics[0] || 'views';
    v = model.view(currentRows,metric);
    $('metric').innerHTML = v.availableMetrics.map(key=>`<option value="${key}" ${key===metric?'selected':''}>${model.metrics[key]}</option>`).join('');
    const stats = [{name:'参考视频',value:v.total,unit:'条',note:'当前筛选 · 按链接去重'},...(v.sourced?[{name:'原站 / 授权样本',value:v.sourced,unit:'条',note:'保留来源与采集时间'}]:[]),...(v.platforms.length?[{name:'覆盖平台',value:v.platforms.length,unit:'个',note:v.platforms.map(row=>platformName(row.label)).join(' / ')}]:[]),...(v.analyses.length?[{name:'已记录内容分析',value:v.analyses.length,unit:'条',note:'观看范围见逐条记录'}]:[])];
    $('stats').innerHTML = v.total?stats.map(s=>`<div class="stat"><div class="stat-name">${s.name}</div><div class="stat-value">${num(s.value)}<small>${s.unit}</small></div><div class="stat-note">${esc(s.note)}</div></div>`).join(''):'';
    $('overview').hidden=!v.total;
    $('overview-charts').innerHTML=distribution('样本来自哪些平台',v.platforms,platformName)+distribution('来源构成',v.evidence,id=>names[id]||id);
    const a=model.analysis(currentRows);
    $('shortlist').hidden=!a.shortlists.length;
    $('shortlist-content').innerHTML=a.shortlists.map(p=>`<article class="shortlist-item"><div class="pick-label">${esc(platformName(p.platform))} · ${model.metrics[p.metric]}表现</div><h3>${esc(p.row.title)}</h3><div class="pick-value">${num(p.value)}<small>${model.metrics[p.metric]}</small></div><p class="chart-meta">同平台当前 ${p.population} 条已知样本中第 ${p.rank} · ${p.row.published_at?esc(p.row.published_at):'日期未核验'}</p><p class="pick-author">${esc(p.row.author)}</p><div class="ref-actions"><button class="text-button" data-source="${esc(p.row.id)}">核对数据</button><a href="${esc(p.row.url)}" target="_blank" rel="noopener noreferrer">观看原视频 ↗</a><button class="text-button" data-brief="${esc(p.row.id)}">复制拆片任务</button></div></article>`).join('');
    const charts=[];
    for(const group of a.relationships){
      const maxX=Math.max(...group.rows.map(r=>r.duration_seconds)),maxY=Math.max(1,...group.rows.map(r=>r.metrics.likes));
      const x=v=>50+v/maxX*510,y=v=>245-Math.log10(v+1)/Math.log10(maxY+1)*210;
      const ticks=[0,...Array.from({length:Math.ceil(Math.log10(maxY+1))},(_,i)=>10**i)].filter((v,i,all)=>v<=maxY&&all.indexOf(v)===i);
      charts.push(`<article class="research-chart"><div class="chart-header"><h3>${esc(platformName(group.platform))} · 片长与点赞</h3><span class="chart-caption">${group.rows.length} 条</span></div><svg viewBox="0 0 600 285" role="img" aria-label="视频时长与累计点赞散点图，点赞采用对数刻度">${ticks.map(t=>`<line x1="50" x2="565" y1="${y(t)}" y2="${y(t)}" stroke="#e3e8e5"/><text x="42" y="${y(t)+4}" text-anchor="end">${num(t)}</text>`).join('')}<line x1="50" x2="565" y1="245" y2="245" stroke="#b7c5be"/>${[0,.25,.5,.75,1].map(f=>`<text x="${x(f*maxX)}" y="268" text-anchor="middle">${Math.round(f*maxX)}秒</text>`).join('')}${group.rows.map(row=>`<circle data-source="${esc(row.id)}" cx="${x(row.duration_seconds)}" cy="${y(row.metrics.likes)}" r="6" tabindex="0"><title>${esc(row.title)}：${row.duration_seconds}秒，${num(row.metrics.likes)}赞</title></circle>`).join('')}</svg><p class="chart-meta">横轴：时长；纵轴：累计点赞（对数刻度）。反映采集样本差异，不代表片长导致热度。</p></article>`);
    }
    for(const group of a.efficiency){const max=Math.max(...group.rows.map(p=>p.value));charts.push(`<article class="research-chart"><div class="chart-header"><h3>${esc(platformName(group.platform))} · 每千次播放收藏数</h3><span class="chart-caption">${group.population} 条有分母的样本</span></div><div class="ratio-list">${group.rows.map(p=>`<div><button class="rank-label" data-source="${esc(p.row.id)}">${esc(p.row.title)}</button><div class="ratio-value"><div class="bar-track"><div class="bar-fill" style="width:${max?p.value/max*100:0}%"></div></div><strong>${p.value.toFixed(1)}</strong></div><span class="chart-caption">${num(p.row.metrics.saves)} 收藏 / ${num(p.row.metrics.views)} 播放</span></div>`).join('')}</div><p class="chart-meta">收藏 ÷ 播放 × 1000。同一用户可能产生多次播放，数值不等于用户比例或转化率。</p></article>`);}
    for(const group of a.durationGroups){const max=Math.max(1,...group.bins.map(b=>b.median));charts.push(`<article class="research-chart"><div class="chart-header"><h3>${esc(platformName(group.platform))} · 不同片长的样本表现</h3><span class="chart-caption">点赞中位数</span></div><div class="duration-bars">${group.bins.map(b=>`<div><span>${esc(b.label)}</span><div class="bar-track"><div class="bar-fill" style="width:${b.median/max*100}%"></div></div><strong>${num(b.median)}</strong><small>${b.count} 条</small></div>`).join('')}</div><p class="chart-meta">不同组的发布时间、作者及题材并未控制；小样本只用于寻找后续观片方向。</p></article>`);}
    $('relationships').hidden=!charts.length;$('relationships-content').innerHTML=charts.join('');
    $('comparison').hidden=!v.metricRows.length;
    $('comparison-content').innerHTML=v.comparisons.map(group=>`<article class="metric-panel"><div class="chart-header"><h3>${esc(platformName(group.platform))} · ${esc(group.band)}</h3><span class="chart-caption">${group.rows.length} 条 / ${model.metrics[metric]}数</span></div><p class="chart-meta">${esc([group.region,group.content_kind].filter(Boolean).join(' · '))}${group.region||group.content_kind?' · ':''}已采集样本内比较</p><div class="ranking">${group.rows.map((row,i)=>`<div class="rank-item"><span class="rank-number">${String(i+1).padStart(2,'0')}</span><div class="rank-body"><button class="rank-label" data-source="${esc(row.id)}" title="${esc(row.title)}">${esc(row.title)}</button><div class="bar-track"><div class="bar-fill" style="width:${group.maximum?row.metrics[metric]/group.maximum*100:0}%"></div></div></div><span class="rank-value">${num(row.metrics[metric])}</span></div>`).join('')}</div><div class="rank-axis"><span>0</span><span>${num(group.maximum)}</span></div></article>`).join('')+v.singleSamples.map(row=>`<article class="metric-panel"><div class="chart-header"><h3>${esc(platformName(row.platform))} · 样本指标</h3><span class="chart-caption">单条记录</span></div><button class="rank-label" data-source="${esc(row.id)}" title="${esc(row.title)}">${esc(row.title)}</button><div class="sample-stats">${metricList(row)}</div><p class="chart-meta">观察于 ${esc(date(row.observed_at))} HKT</p></article>`).join('');
    $('publication').hidden=!v.months.length;
    $('publication-count').textContent=v.datedCount+' 条已核验发布日期';
    const maximum=Math.max(1,...v.months.map(row=>row.value));
    $('publication-chart').innerHTML=v.months.map(row=>`<div class="month"><strong>${row.value}</strong><div class="month-track"><div class="month-bar" style="height:${row.value/maximum*100}%"></div></div><span>${row.label}</span></div>`).join('');
    $('reference-count').textContent=currentRows.length+' 条';
    $('reference-list').innerHTML=currentRows.map(reference).join('');
    $('empty-state').hidden=Boolean(currentRows.length);
    $('analysis').hidden=!v.analyses.length;
    $('analysis-content').innerHTML=v.analyses.map(row=>`<article class="analysis-item"><h3>${esc(row.title)}</h3>${fieldList(row.analysis)}<button class="text-button" data-source="${esc(row.id)}">核对来源与观看依据</button></article>`).join('');
    const ids=new Set(currentRows.map(row=>row.id));
    const experiments=data.experiments.filter(entry=>!entry.source_ids?.length || entry.source_ids.every(id=>ids.has(id)));
    $('creative').hidden=!experiments.length || !currentRows.length;
    $('creative-content').innerHTML=experiments.map(entry=>`<article class="analysis-item">${fieldList(entry)}</article>`).join('');
    $('footer-scope').textContent=`当前显示 ${currentRows.length} / ${data.items.length} 条 · 观察时间 HKT / 发布日期 UTC`;
    $('export-csv').disabled=$('export-json').disabled=!currentRows.length;
  }
  function download(content,type,name) { const url=URL.createObjectURL(new Blob([content],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('notice').textContent='已导出当前内容'; }
  function reset() { ['platform','evidence','search','period','content-kind'].forEach(id=>$(id).value='');$('scope').value='matched';render(); }
  ['platform','evidence','scope','period','content-kind'].forEach(id=>$(id).addEventListener('change',render));
  $('search').addEventListener('input',render);$('reset').onclick=reset;$('empty-reset').onclick=reset;
  $('metric').onchange=()=>{metric=$('metric').value;render();};
  $('recent-focus').onclick=()=>{$('period').value='30';render();};
  $('export-csv').onclick=()=>download(model.csv(currentRows),'text/csv;charset=utf-8','research-filtered.csv');
  $('export-json').onclick=()=>download(JSON.stringify({...data,items:currentRows,experiments:data.experiments.filter(entry=>!entry.source_ids?.length||entry.source_ids.every(id=>currentRows.some(row=>row.id===id))),filters:filters()},null,2),'application/json','research-filtered.json');
  $('save-report').onclick=()=>download('<!doctype html>\n'+document.documentElement.outerHTML,'text/html;charset=utf-8','research-report.html');
  document.addEventListener('click',async event=>{
    const source=event.target.closest('[data-source]');if(source)openSource(source.dataset.source);
    const copy=event.target.closest('.copy-source');if(copy){const row=currentRows.find(row=>row.id===copy.dataset.id);try{await navigator.clipboard.writeText([row.title,row.url,row.evidence.note,'观察时间：'+row.observed_at].filter(Boolean).join('\n'));$('notice').textContent='已复制视频与出处';}catch{$('notice').textContent='浏览器未开放剪贴板，可从来源详情复制';}}
    const brief=event.target.closest('[data-brief]');if(brief){const row=currentRows.find(r=>r.id===brief.dataset.brief);const prompt=`请实际观看并拆解这条${platformName(row.platform)}参考视频：${row.title}\n${row.url}\n数据观察时间：${row.observed_at}。已知公开指标：${JSON.stringify(row.metrics)}。先核对实际观看范围，再按时间码提炼开场、商品痛点、卖点证明、镜头节奏、字幕/配乐和行动引导。区分原片事实与创作建议，不把热度当成交。基于我的真实商品资料，输出同类型但原创的15秒/30秒镜头脚本，以及只改一个变量的两组开场测试；标出还缺哪些商品证据。`;try{await navigator.clipboard.writeText(prompt);$('notice').textContent='已复制该视频的拆片与脚本任务';}catch{$('notice').textContent='浏览器未开放剪贴板，请保存报告后使用';}}
  });
  document.addEventListener('keydown',event=>{const target=event.target.closest('circle[data-source]');if(target&&['Enter',' '].includes(event.key)){event.preventDefault();openSource(target.dataset.source);}});
  render();
})();
