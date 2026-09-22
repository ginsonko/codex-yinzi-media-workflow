<template>
  <section class="product-research" aria-labelledby="product-research-title">
    <header class="research-intro"><div><span class="research-kicker">商品视频研究 / 有出处，才有参考</span><h3 id="product-research-title">先看看，同类商品怎么拍。</h3><p>说清商品，选好平台。把公开数据整理成图表，再带着重点参考进入视频策划。</p></div><span class="local-badge">研究资料保存在本机</span></header>
    <ol class="research-steps"><li><b>01</b> 找到同类视频</li><li><b>02</b> 看热度与证据</li><li><b>03</b> 选参考、做策划</li></ol>
    <div class="research-fields">
      <label>商品或主题<input v-model="product" maxlength="160" placeholder="例如：针织毛衣、通勤双肩包" /></label>
      <label>发布时间<select v-model="period"><option value="30">近 30 天</option><option value="7">近 7 天</option><option value="1">近 1 天</option><option value="all">不限时间</option><option v-if="savedRange" value="saved">已保存的日期范围</option></select></label>
      <label>目标市场<input v-model="region" maxlength="80" placeholder="选填，如：中国大陆、美国" /></label>
      <label>每个平台最多<select v-model.number="limit"><option :value="30">30 条</option><option :value="60">60 条</option><option :value="100">100 条</option><option :value="200">200 条</option></select></label>
    </div>
    <fieldset class="platform-picks"><legend>参考来自哪些平台？可多选</legend><label v-for="p in platforms" :key="p.id" :class="{ chosen: chosen.includes(p.id) }"><input type="checkbox" :checked="chosen.includes(p.id)" @change="choose(p.id)" />{{ p.name }}</label></fieldset>
    <details class="research-extra"><summary>补充商品资料、已有链接，或导入以前的研究</summary><label>自己的商品事实 · 每行一条<textarea v-model="facts" rows="3" placeholder="填写真实材质、规格、用途、卖点或限制；也可以研究完成后再补。" /></label><label>已有参考链接 · 每行一条<textarea v-model="links" rows="2" placeholder="可直接贴原视频地址，优先读取这些视频。" /></label><label class="import-file">导入研究 JSON<input ref="fileInput" type="file" accept=".json,application/json" @change="importFile" /></label><p v-if="imported">已载入 {{ imported.items.length }} 条历史记录。本次整理这些资料，不重新联网采集。<button class="text-button" @click="imported = null">改回在线采集</button></p><p>日期与地区只用可核验字段筛选；暂时无法核实的记录保留为线索。只显示有数据支撑的图表。</p></details>
    <div class="research-actions"><el-button type="primary" size="large" :loading="busy" :disabled="!product.trim() || !chosen.length || current?.active" @click="start">{{ imported ? '整理导入资料' : '开始找参考' }}</el-button><el-button :disabled="refreshing" @click="refresh">刷新进度</el-button><span>采集和整理不调用付费生成模型。</span></div>
    <p v-if="error" class="research-error" role="alert">{{ error }}</p>
    <div v-if="jobs.length" class="history-picker"><label>已保存的研究<select :disabled="busy" :value="current?.id || ''" @change="selectJob($event.target.value)"><option value="" disabled>新研究</option><option v-for="job in jobs" :key="job.id" :value="job.id">{{ job.query.product }} · {{ status(job.state) }} · {{ formatTime(job.created_at) }}</option></select></label><button class="text-button" @click="newStudy">新建另一份研究</button></div>
    <article v-if="current" class="research-result" aria-label="研究进度与成果">
      <header><div><span class="research-kicker">{{ status(current.state) }}</span><h4>{{ current.query.product }} · 参考研究</h4></div><el-button v-if="current.active" size="small" :disabled="busy || current.state === 'cancelling'" @click="action('cancel')">停止并保留资料</el-button><el-button v-else size="small" :loading="busy" @click="action('resume')">{{ current.platforms.every(p => ['collected','imported'].includes(p.status)) ? '更新平台数据' : '继续补采' }}</el-button></header>
      <p role="status">{{ current.message }}</p>
      <div class="platform-progress"><div v-for="p in current.platforms" :key="p.id"><strong>{{ p.name }}</strong><span>{{ status(p.status) }}</span><small v-if="p.count">本次取得 {{ p.count }} 条</small><small v-if="p.error">{{ p.error.message }}</small><small v-for="note in p.warnings || []" :key="note">{{ note }}</small><a v-if="p.status === 'requires_discovery'" href="#platform-connections-title">连接官方平台，或补充原视频链接后再研究</a><a v-if="['verification_required','access_required'].includes(p.status)" href="#platform-connections-title">{{ p.status === 'verification_required' ? '去完成官方验证，再继续补采' : '去扫码登录，再继续补采' }}</a><small v-if="p.status === 'rate_limited'">平台暂时限流，已有资料保留；稍后再试。</small></div></div>
      <template v-if="current.report_revision">
        <div class="research-stats"><div><strong>{{ current.summary.total_items }}</strong><span>去重参考</span></div><div><strong>{{ sourceCount }}</strong><span>原站 / 授权数据</span></div><div><strong>{{ current.summary.candidates_count }}</strong><span>当前范围可比较</span></div></div>
        <div class="research-actions"><a class="primary-link" :href="artifact('report.html')" target="_blank" rel="noopener">打开可视化研究报告 ↗</a><a :href="artifact('references.csv')" download>下载数据表</a><a :href="current.download_url" download>下载完整研究包 ZIP</a><a :href="artifact('video-plan.md')" download>下载策划交接</a></div>
        <section v-if="current.shortlist?.length" class="research-shortlist"><h4>先看这几条</h4><p>按同平台实测指标筛选；观看后，再判断哪些镜头和卖点适合自己的商品。</p><label v-for="item in current.shortlist" :key="item.id"><input v-model="selected" type="checkbox" :value="item.id" /><div><a v-if="item.url" :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.title || '打开原视频' }} ↗</a><span v-else>{{ item.title }}</span><small>{{ item.recommendation }}</small><small>{{ item.watch_required ? '待观看内容，暂不推断镜头结构' : '已有观看记录' }}</small></div></label></section>
        <div v-else class="research-empty">当前范围内还没有可排名的参考。可以查看报告里的原始线索，补充链接，或用新的范围再研究。</div>
        <details class="research-shortlist"><summary @click="loadRecords(true)">从全部 {{ current.summary.total_items }} 条资料中选择参考</summary><label v-for="item in allRecords" :key="item.id"><input v-model="selected" type="checkbox" :value="item.id" /><div><a :href="item.url" target="_blank" rel="noopener noreferrer">{{ item.title || item.id }} ↗</a><small>{{ item.platform }} · {{ item.analysis_basis === 'metadata_only' ? '待观片' : '有分析记录，请核对观看范围' }}</small></div></label><button v-if="nextOffset !== null" class="text-button" :disabled="recordsLoading" @click.prevent="loadRecords(false)">{{ recordsLoading ? '读取中…' : '查看更多参考' }}</button></details>
        <div class="planning-box"><h4>把参考带进自己的视频</h4><label>补充或修改商品事实<textarea v-model="facts" rows="3" placeholder="例如实际材质、尺码、适用场景。不要把竞品参数当成自己的。" /></label><div class="research-actions"><el-button :loading="busy" :disabled="current.active" @click="saveFacts">保存选项与商品资料</el-button><el-button type="primary" :loading="busy" :disabled="current.active" @click="handoff">进入视频策划 →</el-button><el-button :disabled="busy" @click="copyPrompt">复制给 Codex</el-button></div><p>会带上参考来源、商品事实和三种可修改的拍摄框架。让 Agent 实际看重点视频，再出原创脚本、分镜和制作方案；支持继续提要求、局部修改。</p><p v-if="copyStatus" role="status">{{ copyStatus }}</p></div>
      </template>
    </article>
    <details><summary>需要 Agent 协助寻找更多来源？</summary><textarea v-model="editablePrompt" rows="6" aria-label="电商调研需求" /><el-button @click="copyPrompt">复制调研需求</el-button></details>
    <p class="research-note">热门参考能帮助选方向。销量和成交效果仍需用自己的投放、点击与购买数据检验。</p>
  </section>
  <PlatformResearchConnections @connected="resumeConnected" />
</template>

<script setup>
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import PlatformResearchConnections from './PlatformResearchConnections.vue'
import { createResearchClient, requestKey, queryFor, platformReadyToResume, resolveResearchJob } from '../api/productResearch'
const props = defineProps({ modules: { type: Array, default: () => [] } })
const router = useRouter(), client = createResearchClient()
const defaults = [{ id: 'douyin', name: '抖音' }, { id: 'tiktok', name: 'TikTok' }, { id: 'xiaohongshu', name: '小红书' }, { id: 'bilibili', name: 'B站' }, { id: 'youtube', name: 'YouTube' }, { id: 'generic', name: '其他平台 / 通用' }]
const platforms = computed(() => { const entries = props.modules.filter(m => m.research_platform).map(m => m.research_platform); return entries.length ? entries : defaults })
const product = ref(''), chosen = ref(['douyin']), region = ref(''), period = ref('30'), limit = ref(30), facts = ref(''), links = ref('')
const current = ref(null), jobs = ref([]), selected = ref([]), imported = ref(null), busy = ref(false), refreshing = ref(false), error = ref(''), copyStatus = ref(''), editablePrompt = ref(''), fileInput = ref(null)
const savedRange = ref(null), allRecords = ref([]), nextOffset = ref(0), recordsLoading = ref(false)
let selectionEpoch = 0
let timer, disposed = false, pendingBody, pendingKey, restoring = true
const labels = { queued: '等待开始', running: '正在采集', compiling: '整理报告', completed: '研究已整理', partial: '已有部分结果', needs_action: '部分平台需要处理', empty: '暂未取得数据', interrupted: '可继续上次研究', failed: '本次未完成', cancelling: '正在保存并停止', cancelled: '已停止，资料保留', collected: '已采集', imported: '已导入', verification_required: '需要官方验证', access_required: '需要登录', rate_limited: '平台暂时限流', discovery_only: '取得搜索线索', requires_discovery: '需要补充来源' }
const status = value => labels[value] || value
const formatTime = value => new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const sourceCount = computed(() => { const counts = current.value?.summary?.evidence_distribution || {}; return (counts.platform_page || 0) + (counts.authorized_export || 0) })
const artifact = name => current.value?.artifacts?.find(a => a.name === name)?.url
const prompt = computed(() => '请研究' + (current.value?.query.product || product.value.trim() || '我的商品') + '的热门短视频。按平台分别采集和比较，保留来源、观察时间和原始证据；未知数据不当零，图表只展示有依据的内容。优先使用 product_video_research 工具或 research CLI 持久研究入口，登录或验证由用户在官方窗口完成，已有结果保留。' + (current.value ? '当前研究ID：' + current.value.id + '；读取该任务的 report.html、creative-brief.json 和 video-plan.md。' : '') + '实际观看重点参考，记录观看范围、前3秒、卖点证明、节奏、CTA及出处。结合我的商品事实设计三种原创脚本、分镜和A/B测试，继续用媒体工作流执行；不要把标题分析当作已观看，不编造商品参数。按我的既有生成预算执行，没有预算时先交方案。')
watch(prompt, value => { editablePrompt.value = value }, { immediate: true })
function choose(id) { chosen.value = id === 'generic' ? (chosen.value.includes(id) ? [] : [id]) : chosen.value.includes(id) ? chosen.value.filter(p => p !== id) : [...chosen.value.filter(p => p !== 'generic'), id] }
function sync(job, reset = false) {
  if (disposed) return
  const changed = job?.id !== current.value?.id, revisionChanged = job?.report_revision !== current.value?.report_revision
  const firstReport = job?.report_revision && !current.value?.report_revision
  current.value = job
  if (changed || revisionChanged || reset) { allRecords.value = []; nextOffset.value = 0 }
  if (job && (changed || reset || firstReport)) {
    selected.value = Array.isArray(job.selected_ids) ? [...job.selected_ids] : (job.shortlist || []).map(r => r.id)
    facts.value = (job.product_facts || []).map(f => typeof f === 'string' ? f : JSON.stringify(f)).join('\n')
  }
  if (job && (changed || reset)) {
    product.value = job.query.product; chosen.value = [...job.query.platforms]; region.value = job.query.region || ''
    savedRange.value = job.query.since || job.query.until ? { since: job.query.since, until: job.query.until } : null
    period.value = savedRange.value ? 'saved' : 'all'; limit.value = job.parameters?.limit || 30
    links.value = (job.urls || []).join('\n'); imported.value = null
  }
}
function schedule() { clearTimeout(timer); if (!disposed && current.value?.active) timer = setTimeout(refresh, 1800) }
async function refresh() {
  if (refreshing.value || disposed) return
  refreshing.value = true; const epoch = selectionEpoch
  const id = current.value?.id || (restoring ? new URLSearchParams(location.search).get('research') : null)
  try {
    const data = await client.request()
    const job = await resolveResearchJob(client, data.items, id, restoring)
    if (disposed || epoch !== selectionEpoch) return
    jobs.value = job && !data.items.some(j => j.id === job.id) ? [job, ...data.items] : data.items
    sync(job); restoring = false; error.value = ''
  } catch (e) { if (!disposed && epoch === selectionEpoch) error.value = e.message }
  finally { refreshing.value = false; schedule() }
}
async function selectJob(id) {
  if (busy.value) return
  clearTimeout(timer); const epoch = ++selectionEpoch
  try { const data = await client.request('/' + id); if (!disposed && epoch === selectionEpoch) { sync(data.job, true); schedule() } }
  catch (e) { if (!disposed && epoch === selectionEpoch) error.value = e.message }
}
async function loadRecords(first) {
  if (recordsLoading.value || !current.value?.report_revision || (first && allRecords.value.length)) return
  const id = current.value.id, revision = current.value.report_revision, offset = first ? 0 : nextOffset.value
  if (offset === null) return
  recordsLoading.value = true
  try {
    const result = await client.request('/' + id + '/records?v=' + revision + '&offset=' + offset + '&limit=50')
    if (disposed || current.value?.id !== id || current.value?.report_revision !== revision) return
    allRecords.value = first ? result.items : [...allRecords.value, ...result.items]; nextOffset.value = result.next_offset
  } catch (e) { if (!disposed && current.value?.id === id) error.value = e.message }
  finally { recordsLoading.value = false }
}
async function perform(fn) { if (busy.value) return; busy.value = true; error.value = ''; try { await fn() } catch (e) { if (!disposed) error.value = e.message } finally { busy.value = false; schedule() } }
const factLines = () => facts.value.split('\n').map(s => s.trim()).filter(Boolean)
async function start() { await perform(async () => { const body = { mode: imported.value ? 'import' : 'collect', query: queryFor({ product: product.value, platforms: chosen.value, region: region.value, period: period.value, savedRange: savedRange.value }), parameters: { limit: limit.value }, product_facts: factLines(), urls: links.value.split('\n').map(s => s.trim()).filter(Boolean), ...(imported.value ? { items: imported.value.items } : {}) }; const signature = JSON.stringify(body); if (pendingBody !== signature) { pendingKey = await requestKey(body); pendingBody = signature } const data = await client.request('', 'POST', { ...body, request_key: pendingKey }); sync(data.job, true); if (!disposed) await refresh() }) }
async function action(name) { const id = current.value.id; await perform(async () => { const params = name === 'resume' && current.value.platforms.every(p => ['collected','imported'].includes(p.status)) ? { platforms: current.value.platforms.map(p => p.id) } : {}; const data = await client.request('/' + id + '/' + name, 'POST', params); sync(data.job); await refresh() }) }
async function resumeConnected(platform) {
  if (disposed || busy.value || !platformReadyToResume(current.value, platform)) return
  const id = current.value.id
  await perform(async () => {
    const data = await client.request('/' + id + '/resume', 'POST', { platforms: [platform] })
    if (disposed || current.value?.id !== id) return
    sync(data.job)
    copyStatus.value = '平台已连接，正在接着采集这份研究。'
    await refresh()
  })
}
async function persistFacts() { const data = await client.request('/' + current.value.id, 'PATCH', { product_facts: factLines(), selected_ids: selected.value }); sync(data.job); return data.job }
async function saveFacts() { await perform(async () => { await persistFacts(); copyStatus.value = '商品资料与参考选择已保存，策划交接已更新。' }) }
async function handoff() { await perform(async () => { const changed = JSON.stringify(factLines()) !== JSON.stringify(current.value.product_facts) || JSON.stringify(selected.value) !== JSON.stringify(current.value.selected_ids); if (changed) await persistFacts(); const result = await client.request('/' + current.value.id + '/handoff', 'POST', {}); if (!disposed) await router.push(result.url) }) }
async function importFile(event) { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; try { if (file.size > 8 * 1024 * 1024) throw new Error('请选择8 MiB以内的研究JSON文件。'); const data = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); if (!Array.isArray(data.items) || !data.items.length) throw new Error('文件中没有 items 视频记录，请导入研究的 result.json。'); imported.value = data; product.value = data.query?.product || product.value; const ids = [...new Set(data.items.map(r => r.platform).filter(Boolean))]; chosen.value = ids.every(id => platforms.value.some(p => p.id === id)) ? ids : ['generic']; region.value = data.query?.region || ''; period.value = 'all'; facts.value = (data.product_facts || []).map(f => typeof f === 'string' ? f : JSON.stringify(f)).join('\n'); error.value = '' } catch (e) { error.value = e.message } }
function newStudy() { if (busy.value) return; if (current.value?.active) { error.value = '当前研究还在进行，可先停止并保留资料，再创建另一份。'; return } pendingBody = undefined; pendingKey = undefined; try { localStorage.removeItem('yinzi-research-pending') } catch {} selectionEpoch++; current.value = null; imported.value = null; allRecords.value = []; nextOffset.value = 0; copyStatus.value = ''; error.value = ''; restoring = false; clearTimeout(timer) }
async function copyPrompt() { try { await navigator.clipboard.writeText(editablePrompt.value); copyStatus.value = '已复制，粘贴给 Codex 或你的 Agent 即可继续。' } catch { copyStatus.value = '请展开下方调研需求，选中文字复制。' } }
onMounted(refresh)
onUnmounted(() => { disposed = true; clearTimeout(timer); client.dispose() })
</script>

<style scoped>
.product-research{padding:28px;border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);display:grid;gap:20px;color:var(--text-primary)}.research-intro,.research-result>header{display:flex;justify-content:space-between;align-items:start;gap:18px}.research-kicker{font-size:12px;color:var(--ui-accent);letter-spacing:.04em}.research-intro h3{margin:9px 0;font-size:27px;font-weight:600}.product-research p{margin:0;color:var(--text-muted);font-size:13px;line-height:1.8}.local-badge{padding:7px 10px;border:1px solid var(--border-color);border-radius:20px;font-size:11px;white-space:nowrap;color:var(--text-muted)}.research-steps{display:flex;gap:24px;padding:14px 0;margin:0;list-style:none;border-block:1px solid var(--border-color);font-size:13px}.research-steps b{font-size:11px;color:var(--ui-accent);margin-right:8px}.research-fields{display:grid;grid-template-columns:1.6fr 1fr 1fr .8fr;gap:14px}.product-research label{display:grid;gap:7px;font-size:12px;color:var(--text-muted)}.product-research input:not([type=checkbox]),.product-research select,.product-research textarea{box-sizing:border-box;width:100%;border:1px solid var(--border-color);background:var(--bg-inner);color:var(--text-primary);border-radius:7px;padding:11px;font:inherit;min-width:0}.product-research textarea{resize:vertical;line-height:1.7;font-size:13px}.platform-picks{border:0;margin:0;padding:0;display:flex;gap:9px;flex-wrap:wrap}.platform-picks legend{font-size:12px;margin-bottom:10px;color:var(--text-muted)}.platform-picks label{display:flex;align-items:center;gap:6px;padding:9px 12px;border:1px solid var(--border-color);border-radius:7px;cursor:pointer}.platform-picks .chosen{border-color:var(--ui-accent);color:var(--text-primary);background:color-mix(in srgb,var(--ui-accent) 8%,transparent)}.product-research input[type=checkbox]{accent-color:var(--ui-accent)}.research-actions{display:flex;gap:14px;align-items:center;flex-wrap:wrap}.research-actions span{font-size:12px;color:var(--text-muted)}.product-research a{color:var(--ui-accent);text-decoration:none;font-size:13px}.product-research a:hover{text-decoration:underline}.primary-link{padding:11px 15px;border:1px solid var(--ui-accent);border-radius:7px}.product-research summary{cursor:pointer;color:var(--text-muted);font-size:13px;margin-bottom:10px}.research-extra[open]{display:grid;gap:12px}.research-error{color:var(--el-color-danger)!important;padding:10px 13px;border:1px solid currentColor;border-radius:7px;overflow-wrap:anywhere}.history-picker{display:flex;gap:16px;align-items:end;border-top:1px solid var(--border-color);padding-top:18px}.history-picker label{flex:1;max-width:550px}.text-button{background:none;border:0;color:var(--ui-accent);cursor:pointer;font:inherit;font-size:12px;padding:8px}.research-result{border:1px solid var(--border-color);border-radius:10px;padding:22px;display:grid;gap:18px;background:var(--bg-inner)}.research-result h4{font-size:18px;font-weight:600;margin:7px 0}.platform-progress{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.platform-progress>div{display:grid;gap:6px;padding:13px;background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px}.platform-progress strong{font-size:13px}.platform-progress span,.platform-progress small{font-size:12px;color:var(--text-muted);overflow-wrap:anywhere}.research-stats{display:flex;gap:36px;padding:18px 0;border-block:1px solid var(--border-color)}.research-stats>div{display:grid;gap:4px}.research-stats strong{font-size:30px;font-weight:500;font-variant-numeric:tabular-nums}.research-stats span{font-size:12px;color:var(--text-muted)}.research-shortlist{display:grid;gap:8px}.research-shortlist>label{display:flex;align-items:start;gap:10px;padding:12px 0;border-bottom:1px solid var(--border-color)}.research-shortlist>label>div{display:grid;gap:5px;min-width:0}.research-shortlist a{line-height:1.6;overflow-wrap:anywhere}.research-shortlist small{font-size:11px;line-height:1.5}.planning-box{display:grid;gap:13px;background:var(--bg-card);border-radius:8px;padding:18px}.research-empty{color:var(--text-muted);font-size:13px;line-height:1.8}.research-note{font-size:12px!important}.product-research input:focus-visible,.product-research textarea:focus-visible,.product-research select:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}@media(max-width:900px){.research-fields{grid-template-columns:1fr 1fr}.research-intro{flex-direction:column}.research-steps{gap:14px;flex-wrap:wrap}}@media(max-width:480px){.product-research{padding:17px;gap:17px}.research-fields{grid-template-columns:1fr}.research-intro h3{font-size:24px}.research-result{padding:14px}.research-stats{gap:22px}.research-stats strong{font-size:27px}.research-steps{font-size:11px;gap:10px}.research-steps b{margin-right:4px}.history-picker{align-items:stretch;flex-direction:column}.planning-box{padding:12px}.research-actions{gap:10px}.research-actions .el-button+.el-button{margin-left:0}}
</style>
