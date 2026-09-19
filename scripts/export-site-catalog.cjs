// Export public built-in contracts without loading private registered tools.
// Optional --base retains editorial groups/examples from an existing site export.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const {MODULES} = require('../backend-node/src/services/orchestrationModuleCatalog');
const operations = require('../backend-node/src/services/localMediaOperations').operations;
const components = require('../backend-node/src/services/componentRuntime').registry();
const value = name => { const i=process.argv.indexOf(name); return i<0 ? null : process.argv[i+1]; };
const out = value('--output');
if (!out) throw new Error('Usage: node scripts/export-site-catalog.cjs --output SITE/data [--base existing-capabilities.json]');
const base = value('--base') ? JSON.parse(fs.readFileSync(value('--base'),'utf8')) : {};
const repository = 'https://github.com/ginsonko/codex-yinzi-media-workflow';
const revision = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const dirty = Boolean(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:root,encoding:'utf8'}).trim());
const date = new Date().toISOString().slice(0,10);
const old = new Map((base.items || []).map(x=>[x.id,x]));
const editorial = {
  'local.audio.neural-song': {group:'audio',featured:true,priority:0,demo_url:'/learn/studio/#song',usage_note:'YuE2 / WanGP 带歌词歌唱。先检查 GPU、空闲显存、内存与磁盘；需按需安装模型。约 4.5 GB 是低显存方案参考，实测原型为 8 GB NVIDIA 卡。模型权重限非商用；唱词与情绪须试听。'}
};
const local = new Set(operations.map(o=>o.id));
const groups = base.groups || ['video','image','audio','document','motion','assets','planning','workflow','extensions'].map((id,i)=>({id,label:['视频剪辑与后期','图像与修饰','声音与字幕','PPT 与文档','AE 与 3D 运镜','素材与整理','研究与创作','任务与恢复','扩展与维护'][i]}));
function group(m) {
  if (/\.ae\.|^director\.|blender/.test(m.module_id)) return 'motion';
  const kind=m.module_id.split('.');
  return groups.some(g=>g.id===kind[1]) ? kind[1] : 'workflow';
}
const items = MODULES.map(m=>{
  const prior=old.get(m.module_id), isLocal=local.has(m.module_id);
  const dependencies=[...new Set([m.component_id,...(m.additional_components||[])].filter(Boolean))].map(id=>{
    const c=components.find(c=>c.component_id===id);return {id,label:prior?.dependencies?.find(d=>d.id===id)?.label||c?.title||c?.name||id,declared_platforms:c?.platforms||[]};
  });
  return {...prior,id:m.module_id,title:m.title||prior?.title||m.module_id,
    summary:m.description_zh||m.description||prior?.summary||m.module_id,
    group:prior?.group||group(m),mode:m.executor==='manual'?'manual':m.executor==='local'?'local':m.executor==='codex'?'agent':'cloud',
    state:m.availability,enabled:m.enabled!==false,version:m.version,featured:prior?.featured||false,priority:prior?.priority??10,
    recent:prior?.recent||(!prior&&!dirty?{date,commit:revision,evidence:'Added built-in module',url:`${repository}/commit/${revision}`} : null),
    dependencies,external_software:prior?.external_software||null,paid_model:Boolean(m.side_effects?.paid),
    example:m.example||prior?.example||null,source_refs:m.source_refs||[],
    source_url:`${repository}/blob/${revision}/backend-node/src/services/${isLocal?'localMediaOperations.js':'orchestrationModuleCatalog.js'}`,
    runtime_readiness:'not_probed',validation_status:m.validation_status||'execution_receipt_required',...editorial[m.module_id]};
});
if (new Set(items.map(i=>i.id)).size!==items.length) throw new Error('Duplicate built-in module IDs');
const document={...base,schema_version:1,source:{repository,revision,date,candidate:dirty,paths:['backend-node/src/services/orchestrationModuleCatalog.js','backend-node/src/services/localMediaOperations.js'],contract_sha256:crypto.createHash('sha256').update(JSON.stringify(MODULES)).digest('hex')},groups,items,
  counts:{total:items.length,local_operations:local.size,other_modules:items.length-local.size,advisory:items.filter(x=>x.state==='advisory').length,recent:items.filter(x=>x.recent).length,components:components.length,transition_presets:operations.find(x=>x.id==='local.video.compose-clips')?.transitions?.length||0},
  notes:{counting:'模块按唯一 ID 统计；转场预设、研究候选、监督与导入工具不重复计入。',readiness:'目录来自源码；组件、模型、Key 和外部软件需按任务准备。',recent:'最新标记对应可核对的注册记录；不代表每项都在所有系统验收。'}};
fs.mkdirSync(out,{recursive:true});
fs.writeFileSync(path.join(out,'capabilities.json'),JSON.stringify(document,null,2)+'\n');
fs.writeFileSync(path.join(out,'capabilities.js'),'window.YINZI_CAPABILITIES = '+JSON.stringify(document)+';\n');
console.log(JSON.stringify({source:document.source,counts:document.counts}));
