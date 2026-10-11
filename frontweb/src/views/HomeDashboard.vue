<template>
  <div class="workbench-view">
    <div class="dashboard-page">

      <!-- ── Always-on hero: 液态银背景 + contextual state ─── -->
      <section class="dash-hero" aria-label="工作台状态">
        <canvas ref="heroCanvas" class="dash-hero-canvas" aria-hidden="true"></canvas>
        <div class="dash-hero-veil" aria-hidden="true"></div>
        <div class="dash-hero-text">
          <div class="dash-hero-eyebrow">
            <label class="dash-unattended-row">
              <el-checkbox :model-value="unattendedMode" :disabled="preferencesSaving || !preferencesLoaded" @change="saveUnattendedMode" />
              <span>自主执行</span>
              <small role="status">{{ preferencesSaving ? '保存中…' : preferencesError || (unattendedMode ? '已开启' : '') }}</small>
            </label>
            <span :class="['dash-freshness', { stale: runtimeError }]">
              <el-icon><component :is="runtimeError ? 'Warning' : 'CircleCheck'" /></el-icon>
              {{ freshnessText }}<small v-if="runtimeError">{{ runtimeError }}</small>
            </span>
          </div>

          <template v-if="activeSession">
            <div class="dash-hero-status"><span :class="['status-dot', statusTone(activeSession.status)]"></span><span :class="['status-label', statusTone(activeSession.status)]">{{ statusLabel(activeSession.status) }}</span></div>
            <h1>{{ activeSession.title || 'AI 正在工作' }}</h1>
            <p>{{ activeSession.user_goal || progressLabel }}</p>
            <div class="dash-hero-actions">
              <el-button type="primary" size="large" @click="openAttention">打开任务</el-button>
              <el-button v-if="attentionSession?.status === 'paused'" size="large" plain @click="resumeAttention">继续任务</el-button>
              <el-button v-else-if="['running','planned','waiting_confirmation'].includes(attentionSession?.status)" size="large" plain @click="pauseAttention">暂停任务</el-button>
            </div>
          </template>

          <template v-else-if="activeBatch">
            <h1>{{ activeBatch.title }}</h1>
            <p>{{ activeBatch.settings?._origin === 'manual' ? '手动创作' : '批量生成' }} · {{ dashboardBatchMessage(activeBatch) }} · {{ activeBatch.completed || 0 }} / {{ activeBatch.total }} 已完成</p>
            <div class="dash-hero-actions">
              <el-button type="primary" size="large" @click="router.push(activeBatch.settings?._origin === 'manual' ? '/free-create' : `/batch?batch=${activeBatch.id}`)">查看进度</el-button>
            </div>
          </template>

          <template v-else>
            <h1>把想法交给<br><em>AI 智能体</em></h1>
            <p>直接说要做什么，AI 会先说明计划、素材和费用，按你的授权继续执行。</p>
            <div class="dash-hero-actions">
              <el-button type="primary" size="large" @click="router.push('/free-create')"><el-icon><VideoPlay /></el-icon>手动创作</el-button>
              <el-button size="large" plain @click="router.push('/batch')"><el-icon><CopyDocument /></el-icon>批量生成</el-button>
              <el-button class="desktop-shortcut-button" text size="small" :loading="shortcutSaving" @click="addDesktopShortcut"><el-icon><Monitor /></el-icon>添加到桌面</el-button>
            </div>
            <span v-if="shortcutHint" class="shortcut-hint" role="status">{{ shortcutHint }}</span>
          </template>
        </div>
      </section>

      <WorkActivity v-if="activeSession?.source_context?.activity" :session="activeSession" :nodes="activeBundle?.nodes || []"><el-button plain size="small" @click="openAttention">打开当前任务</el-button></WorkActivity>

      <section v-if="attentionSession && !attentionSession.source_context?.activity" class="attention-banner" role="status"><span class="attention-icon"><el-icon><VideoPlay /></el-icon></span><div><strong>{{ attentionSession.title || '有一个任务正在进行' }}</strong><p>{{ attentionText }}</p></div><div class="attention-actions"><el-button v-if="attentionSession.status === 'paused'" size="small" type="primary" @click="resumeAttention">继续任务</el-button><el-button v-else-if="['running','planned','waiting_confirmation'].includes(attentionSession.status)" size="small" type="warning" plain @click="pauseAttention">暂停任务</el-button><el-button size="small" plain @click="openAttention">查看详情</el-button></div></section>

      <section v-if="firstRunVisible" class="first-run-guide" aria-labelledby="first-run-title">
        <div class="first-run-heading"><div><span class="kicker">第一次使用 · 可跳过</span><h3 id="first-run-title">先用起来，再决定要不要接入模型</h3><p>不配置也可以整理素材、导入已有媒体、做本地剪辑和让 AI 规划任务。需要 AI 生图、生视频或特定文本风格时，再按需补充 URL、Key 和模型。推荐先配置银子 API：站点是 yinziapi.top，访问端点是 api.yinziapi.top/v1；登录后创建 Key，复制完整的 sk- 开头内容粘贴进去。</p></div><el-button text @click="dismissFirstRun">暂时隐藏</el-button></div>
        <div class="first-run-steps">
          <article><span>1</span><div><strong>先看一个示例</strong><p>用一句话创建一个不产生费用的计划，理解任务、节点和成果如何回来。</p><el-button size="small" plain @click="useExample(examples.find(example => !example.target))">打开示例</el-button></div></article>
          <article><span>2</span><div><strong>按需接入 AI</strong><p>文本、图片、视频可以分别保存多个候选；推荐从银子 API 开始，配置后 AI 才能调用对应的生图和视频模型。Key 只保存在本机，配置什么就会解锁什么。</p><div class="first-run-actions"><el-button size="small" type="primary" plain @click="router.push('/ai-config?action=yinzi')">配置银子 API</el-button><el-button size="small" plain @click="router.push('/ai-config?action=yinzi')">查看配置步骤</el-button></div></div></article>
          <article><span>3</span><div><strong>不懂就问 AI 助手</strong><p>可以把 URL、Key、模型名和备注直接发给 AI 助手，让它代填配置；也可以随时回到"模型与 Key"修改。</p><el-button size="small" text @click="router.push('/help')">查看帮助</el-button></div></article>
        </div>
        <div class="first-run-footnote">当前配置：文本 {{ onboarding?.active_config_counts?.text || 0 }} · 图片 {{ onboarding?.active_config_counts?.image || 0 }} · 视频 {{ onboarding?.active_config_counts?.video || 0 }}；推荐目录只作参考，AI 会保留你选定的模型，并按你的授权和预算执行。</div>
      </section>

      <section class="canvas-feature-card" aria-label="画布创作入口"><div><h2>在画布上制作漫剧与视频</h2><p>上传素材、连接参考、逐镜生成；专用创作助手和你一起整理剧本与镜头。</p><el-button type="primary" plain @click="router.push('/create-canvas')">打开画布创作</el-button></div><span class="canvas-feature-badge" aria-hidden="true"><el-icon><Grid /></el-icon></span></section>

      <section class="metric-strip" aria-label="工作台摘要">
        <article v-for="metric in metrics" :key="metric.label" class="metric-item">
          <div class="metric-top"><el-icon :class="metric.tone"><component :is="metric.icon" /></el-icon></div>
          <strong :class="{ 'is-text': typeof metric.value === 'string' && !metric.value.startsWith('¥') }">{{ metric.value }}</strong>
          <span>{{ metric.label }}</span>
          <small>{{ metric.note }}</small>
        </article>
      </section>

      <div class="dashboard-columns" :class="{ 'has-work-activity': activeSession?.source_context?.activity || activeBatch }">
        <section v-if="!activeSession?.source_context?.activity && !activeBatch" class="panel current-panel"><header class="panel-heading"><div><span class="kicker">当前进行</span><h3>AI 正在做什么</h3></div><router-link to="/codex-console">查看全部任务 <el-icon><ArrowRight /></el-icon></router-link></header><template v-if="activeSession"><div class="current-session"><div class="current-session-title"><span :class="['status-dot', statusTone(activeSession.status)]"></span><div><strong>{{ activeSession.title || '未命名任务' }}</strong><p>{{ activeSession.user_goal || 'AI 正在准备制作目标' }}</p></div><span :class="['status-label', statusTone(activeSession.status)]">{{ statusLabel(activeSession.status) }}</span></div><div class="current-progress"><div><span>{{ progressLabel }}</span><strong>{{ progressPercent === null ? '阶段制' : `${progressPercent}%` }}</strong></div><el-progress v-if="progressPercent !== null" :percentage="progressPercent" :show-text="false" :status="activeSession.status === 'failed' ? 'exception' : 'success'" /><div class="stage-row"><span v-for="stage in stages" :key="stage.label" :class="stage.state"><i></i>{{ stage.label }}</span></div></div><div class="current-footer"><span><el-icon><Clock /></el-icon> {{ relativeTime(activeSession.updated_at) }}</span><el-button size="small" type="primary" plain @click="openAttention">打开任务</el-button></div></div></template><div v-else class="empty-current"><span><el-icon><Sunny /></el-icon></span><strong>现在没有运行中的任务</strong><p>从一句描述开始，AI 会把计划放在这里持续展示。</p><el-button type="primary" plain @click="router.push('/free-create')">开始一个任务</el-button></div></section>

        <section class="panel latest-panel"><header class="panel-heading"><div><span class="kicker">最新产出</span><h3>刚刚生成的成果</h3></div><router-link to="/media-library">打开素材库 <el-icon><ArrowRight /></el-icon></router-link></header><div v-if="latestArtifacts.length" class="latest-grid"><article v-for="item in latestArtifacts.slice(0,4)" :key="item.id" class="latest-card" @click="openArtifact(item)"><div class="latest-media"><img v-if="item.type === 'image' && item.url && !brokenArtifacts.has(item.id)" :src="item.url" :alt="item.title" @error="markArtifactBroken(item.id)" /><video v-else-if="item.type === 'video' && item.url && !brokenArtifacts.has(item.id)" :src="item.url" preload="metadata" muted @error="markArtifactBroken(item.id)" /><div v-else class="latest-fallback"><el-icon><component :is="mediaIcon(item.type)" /></el-icon><span>{{ brokenArtifacts.has(item.id) ? '预览暂不可用' : '等待可预览文件' }}</span></div><span class="latest-type">{{ mediaLabel(item.type) }}</span></div><footer><strong :title="item.title">{{ item.title }}</strong><small>{{ relativeTime(item.created_at) }}</small></footer></article></div><div v-else class="empty-latest"><el-icon><Picture /></el-icon><p>成果会在每一步完成后第一时间出现在这里。</p></div></section>
      </div>

      <div class="dashboard-columns lower-columns">
        <section class="panel chart-panel"><header class="panel-heading"><div><span class="kicker">执行节奏</span><h3>最近 30 分钟的推进速度</h3></div><span class="panel-meta">{{ samples.length ? `${samples.length} 个记录点` : '等待任务开始' }}</span></header><div v-if="samples.length > 1" class="sparkline-wrap"><svg viewBox="0 0 640 180" preserveAspectRatio="none" aria-label="任务推进速度图表"><defs><linearGradient id="speedFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--ui-accent)" stop-opacity=".25" /><stop offset="1" stop-color="var(--ui-accent)" stop-opacity="0" /></linearGradient></defs><path :d="sparklineArea" fill="url(#speedFill)" /><polyline :points="sparklinePoints" fill="none" stroke="var(--ui-accent)" stroke-width="3" vector-effect="non-scaling-stroke" /><circle v-for="point in sparklineCircles" :key="point.key" :cx="point.x" :cy="point.y" r="4" fill="var(--bg-card)" stroke="var(--ui-accent)" stroke-width="2" vector-effect="non-scaling-stroke" /></svg><div class="chart-axis"><span>{{ samples[0]?.at ? new Date(samples[0].at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '开始记录' }}</span><span>现在</span></div><p class="chart-note">纵轴：每分钟完成步骤数。按实际记录时间显示最近 30 分钟。</p></div><div v-else class="chart-empty"><div class="chart-bars"><i v-for="n in 8" :key="n" :style="{ height: `${18 + n * 4}px` }"></i></div><strong>任务开始后，这里会显示实际推进曲线</strong><span>你可以看出哪些阶段变慢，并回到任务详情调整计划。</span></div></section>

        <section class="panel quick-panel"><header class="panel-heading"><div><span class="kicker">使用示例</span><h3>不知道怎么说？照着改</h3></div></header><div class="example-list"><button v-for="example in examples" :key="example.title" type="button" @click="useExample(example)"><span :class="['example-icon', example.tone]"><el-icon><component :is="example.icon" /></el-icon></span><span><strong>{{ example.title }}</strong><small>{{ example.prompt }}</small></span><el-icon><ArrowRight /></el-icon></button></div></section>
      </div>

      <section class="panel recent-panel"><header class="panel-heading"><div><span class="kicker">任务索引</span><h3>最近的任务</h3></div><router-link to="/history">查看历史 <el-icon><ArrowRight /></el-icon></router-link></header><div v-if="recentWork.length" class="recent-table"><div class="recent-row recent-head"><span>任务</span><span>状态</span><span>更新时间</span><span>操作</span></div><button v-for="item in recentWork.slice(0,6)" :key="item.key" class="recent-row" type="button" @click="router.push(item.href)"><span><strong>{{ item.title }}</strong><small>{{ item.goal }}</small></span><span :class="['status-label', statusTone(item.status)]">{{ statusLabel(item.status) }}</span><span>{{ relativeTime(item.updated_at) }}</span><span class="row-action"><el-icon><ArrowRight /></el-icon></span></button></div><div v-else class="table-empty">还没有任务，先从首页开始一个简单目标。</div></section>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { useSilverHero } from '@/composables/useSilverHero'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'
import WorkActivity from '@/components/orchestration/WorkActivity.vue'
import orchestrationAPI from '@/api/orchestration'
import mediaBatchAPI from '@/api/mediaBatch'
import { normalizeArtifacts } from '@/utils/orchestrationExperience'
import { artifactMediaUrl } from '@/utils/mediaUrl'
import { describeWorkActivity } from '@/utils/workActivity'
import { dashboardBatchMessage, dashboardBundle, dashboardDetailTargets, selectDashboardBatch, selectDashboardSession } from '@/utils/dashboardWork'

const router = useRouter()
const unattendedMode = ref(false)
const preferencesSaving = ref(false)
const preferencesLoaded = ref(false)
const preferencesError = ref('')
let preferenceReadVersion = 0
async function loadPreferences() {
  if (preferencesSaving.value) return
  const version = ++preferenceReadVersion
  try {
    const value = await orchestrationAPI.preferences()
    if (preferencesSaving.value || version !== preferenceReadVersion) return
    unattendedMode.value = value.unattended_mode === true
    preferencesLoaded.value = true
    preferencesError.value = ''
  } catch (error) { preferencesError.value = '设置暂未同步，保留上次状态' }
}
async function saveUnattendedMode(enabled) {
  ++preferenceReadVersion
  preferencesSaving.value = true
  preferencesError.value = ''
  try {
    const value = await orchestrationAPI.savePreferences({ unattended_mode: enabled })
    unattendedMode.value = value.unattended_mode === true
    ElMessage.success(unattendedMode.value ? '挂机模式已开启并保存' : '挂机模式已关闭并保存')
  } catch (error) { preferencesError.value = '保存未确认，正在重新读取'; ElMessage.error('设置保存未确认，请查看同步后的状态') }
  finally { preferencesSaving.value = false; await loadPreferences() }
}
const loading = ref(false); const runtimeError = ref(''); const sessions = ref([]); const bundles = ref([]); const batches = ref([]); const batchBundles = ref([]); const samples = ref([]); const lastSuccessfulAt = ref(''); const brokenArtifacts = ref(new Set()); const onboarding = ref(null); const firstRunDismissed = ref(localStorage.getItem('yinzi-first-run-guide-dismissed-v1') === '1'); const shortcutSaving = ref(false); const shortcutHint = ref(''); let timer = null
const firstRunVisible = computed(() => !firstRunDismissed.value && !sessions.value.length && !batches.value.length && Boolean(onboarding.value))
const sampleKey = 'yinzi-dashboard-progress-samples-v1'
try { samples.value = JSON.parse(localStorage.getItem(sampleKey) || '[]').filter((item) => item && Number.isFinite(Number(item.progress))).filter((item) => new Date(item.at).getTime() >= Date.now() - 30 * 60000).slice(-240) } catch (_) {}
const snapshotKey = 'yinzi-dashboard-last-success-v2'
try { const cached = JSON.parse(localStorage.getItem(snapshotKey) || '{}'); sessions.value = cached.sessions || []; bundles.value = cached.bundles || []; batches.value = cached.batches || []; batchBundles.value = cached.batchBundles || []; lastSuccessfulAt.value = cached.saved_at || '' } catch (_) {}
const activeSession = computed(() => selectDashboardSession(sessions.value, batches.value))
const activeBatch = computed(() => selectDashboardBatch(batches.value))
const attentionSession = computed(() => activeSession.value)
const batchArtifacts = computed(() => batchBundles.value.flatMap((batch) => (batch.items || []).filter((item) => item.media_url).map((item) => ({ id: `batch-${item.id}`, type: item.kind, title: item.request?.prompt || batch.title, media_url: item.media_url, created_at: item.completed_at || item.updated_at }))))
const latestArtifacts = computed(() => normalizeArtifacts([...bundles.value.flatMap((bundle) => bundle.artifacts || []), ...batchArtifacts.value].sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)).map((item) => ({ ...item, url: artifactMediaUrl(item) }))))
const activeBundle = computed(() => dashboardBundle(activeSession.value, bundles.value))
const progressPercent = computed(() => { const nodes = activeBundle.value?.nodes || []; if (!nodes.length) return null; const done = nodes.filter((node) => ['succeeded', 'skipped', 'partial', 'failed', 'cancelled'].includes(node.status)).length; return Math.round(done / nodes.length * 100) })
const progressLabel = computed(() => describeWorkActivity(activeBundle.value?.session || activeSession.value || {}, activeBundle.value?.nodes || []).message)
const stages = computed(() => { const nodes = activeBundle.value?.nodes || []; return [['准备', ['intake','research','plan']], ['创作', ['create','edit']], ['检查', ['qa']], ['交付', ['deliver']]].map(([label, phases]) => { const items = nodes.filter(node => phases.includes(node.phase)); return { label, state: items.length && items.every(node => ['succeeded','skipped','partial','failed','cancelled'].includes(node.status)) ? 'done' : items.some(node => node.status === 'running') ? 'current' : '' } }) })
const metrics = computed(() => { const batch = readBatchSummary(); const unfinished = sessions.value.filter((item) => ['draft', 'running', 'planned', 'waiting_confirmation', 'paused'].includes(item.status)).length + batch.running + batch.queued; const queued = sessions.value.filter((item) => ['planned', 'waiting_confirmation'].includes(item.status)).length + batch.queued; const complete = sessions.value.filter((item) => ['succeeded', 'partial'].includes(item.status)).length + batch.completed; const costs = sessions.value.reduce((sum, item) => sum + Number(item.usage?.total_cost_cny || item.usage?.cost_cny || 0), 0); return [{ label: '待完成任务', value: unfinished, note: unfinished ? '执行情况见任务进展' : '等待新的任务', icon: 'VideoPlay', tone: 'mint' }, { label: '待开始 / 待确认', value: queued, note: queued ? '查看任务了解下一步' : '暂无等待事项', icon: 'Timer', tone: 'amber' }, { label: '已有结果', value: complete, note: '完整或部分结果见记录', icon: 'CircleCheck', tone: 'green' }, { label: '本地已记录费用', value: costs ? `¥${costs.toFixed(2)}` : '等待回执', note: '没有回执时不显示为零', icon: 'Coin', tone: 'blue' }] })
const attentionText = computed(() => attentionSession.value?.status === 'paused' ? '已暂停后续步骤，计划和成果已保存；已提交的上游任务会继续收口。' : `${progressLabel.value}。打开任务查看下一步与成果。`)
const examples = [{ title: '找电商热门视频参考', prompt: '按商品和平台找参考，拆解开场、卖点与拍法', icon: 'VideoCamera', tone: 'mint', target: '/research' }, { title: '做一张宣传图', prompt: '为我的工作流做一张一图流介绍海报', icon: 'Picture', tone: 'mint' }, { title: '批量整理图片', prompt: '把这个文件夹的图片按人物和场景分类', icon: 'FolderOpened', tone: 'amber' }, { title: '做一段教程视频', prompt: '用清晰步骤介绍如何从 AI 开始创作', icon: 'VideoCamera', tone: 'blue' }]
function readBatchSummary() { return batches.value.reduce((result, item) => { result.running += Number(item.running) || 0; result.queued += Number(item.queued) || 0; result.completed += Number(item.completed) || 0; return result }, { running: 0, queued: 0, completed: 0 }) }
function statusLabel(status) { return ({ running: '执行中', queued: '准备中', planned: '待开始', waiting_confirmation: '待确认', paused: '已暂停', succeeded: '已完成', completed: '已完成', partial: '部分完成', needs_review: '待核对', failed: '失败', cancelled: '已取消', draft: '准备与分析' })[status] || '待处理' }
function statusTone(status) { return ['succeeded','completed'].includes(status) ? 'success' : ['failed'].includes(status) ? 'danger' : ['paused','waiting_confirmation','planned','partial','needs_review'].includes(status) ? 'warning' : ['running','queued'].includes(status) ? 'active' : 'muted' }
function mediaLabel(type) { return ({ image: '图片', video: '视频', audio: '音频', glb: '3D', model: '3D' })[type] || '文件' }
function mediaIcon(type) { return type === 'video' ? 'VideoPlay' : type === 'audio' ? 'Headset' : type === 'glb' || type === 'model' ? 'Box' : 'Picture' }
function relativeTime(value) { if (!value) return '刚刚'; const diff = Math.max(0, Date.now() - new Date(value).getTime()); if (diff < 60000) return '刚刚'; if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`; if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`; return new Date(value).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) }
const recentWork = computed(() => [...sessions.value.map((item) => ({ key: `session-${item.id}`, title: item.title || '未命名任务', goal: item.user_goal || '等待 AI 写入目标', status: item.status, updated_at: item.updated_at, href: `/codex-console/${item.id}` })), ...batches.value.map((item) => ({ key: `batch-${item.id}`, title: item.title || '批量任务', goal: `${item.total} 项 · ${item.kind === 'video' ? '视频' : '图片'}批次`, status: item.status, updated_at: item.updated_at, href: item.settings?._origin === 'manual' ? '/free-create' : `/batch?batch=${encodeURIComponent(item.id)}` }))].sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0)))
const freshnessText = computed(() => lastSuccessfulAt.value ? `数据更新于 ${new Date(lastSuccessfulAt.value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${runtimeError.value ? '，当前显示上次成功结果' : ''}` : '正在读取本地工作台')
async function loadDashboard() {
  if (loading.value) return
  loading.value = true
  const errors = []
  void loadPreferences()
  try {
    if (!onboarding.value) { try { onboarding.value = await orchestrationAPI.onboarding() } catch (_) {} }
    const [sessionResult,batchResult] = await Promise.allSettled([orchestrationAPI.sessions({limit:20}),mediaBatchAPI.list({limit:30})])
    if (sessionResult.status === 'fulfilled') {
      sessions.value = sessionResult.value?.items || []
      const loaded = await Promise.all(dashboardDetailTargets(sessions.value, batchResult.status === 'fulfilled' ? batchResult.value?.items || [] : batches.value).map(async item => {
        const old = bundles.value.find(bundle => bundle.session?.id === item.id)
        if (old && old._event_id === item.last_event_id && old.session?.version === item.version) return old
        try { return {...await orchestrationAPI.get(item.id,{event_limit:10}),_event_id:item.last_event_id} } catch { errors.push('部分任务详情暂时无法刷新');return old }
      }))
      bundles.value = loaded.filter(Boolean)
    } else errors.push(sessionResult.reason?.message || '编排任务连接失败')
    if (batchResult.status === 'fulfilled') {
      batches.value = batchResult.value?.items || []
      const loaded = await Promise.all(batches.value.slice(0,5).map(async item => {
        const old = batchBundles.value.find(batch => batch.id === item.id)
        if (old && old.updated_at === item.updated_at) return old
        try { return await mediaBatchAPI.get(item.id,{item_page:1,item_page_size:20}) } catch { errors.push('部分批次暂时无法刷新');return old }
      }))
      batchBundles.value = loaded.filter(Boolean)
    } else errors.push(batchResult.reason?.message || '批量队列连接失败')
    if (!errors.length) {
      lastSuccessfulAt.value = new Date().toISOString()
      const done=bundles.value.reduce((sum,bundle)=>sum+(bundle.nodes || []).filter(node=>['succeeded','skipped'].includes(node.status)).length,0)+batches.value.reduce((sum,batch)=>sum+Number(batch.completed || 0),0)
      const previous=samples.value.at(-1)
      if (!previous || Date.now()-Date.parse(previous.at)>=10000) {
        const minutes=previous ? Math.max((Date.now()-Date.parse(previous.at))/60000,1/60) : 1
        samples.value=[...samples.value,{at:lastSuccessfulAt.value,progress:progressPercent.value || 0,completed:done,rate:previous ? Math.max(0,done-previous.completed)/minutes : 0}].filter(item=>Date.parse(item.at)>=Date.now()-30*60000).slice(-240)
        try { localStorage.setItem(sampleKey,JSON.stringify(samples.value)); localStorage.setItem(snapshotKey,JSON.stringify({sessions:sessions.value,bundles:bundles.value,batches:batches.value,batchBundles:batchBundles.value,saved_at:lastSuccessfulAt.value})) } catch { /* storage capacity must not interrupt live progress */ }
      }
    }
    runtimeError.value=errors.join('；')
  } finally { loading.value=false }
}
function dismissFirstRun() { firstRunDismissed.value = true; localStorage.setItem('yinzi-first-run-guide-dismissed-v1', '1') }
function openAttention() { if (attentionSession.value) router.push(`/codex-console/${attentionSession.value.id}`) }
async function pauseAttention() { if (!attentionSession.value) return; try { await orchestrationAPI.pause(attentionSession.value.id, { note: '用户从总览首页暂停' }); await loadDashboard() } catch (error) { ElMessage.error(error?.message || '操作失败，请查看连接状态') } }
async function resumeAttention() { if (!attentionSession.value) return; try { await orchestrationAPI.resume(attentionSession.value.id, { note: '用户从总览首页继续' }); await loadDashboard() } catch (error) { ElMessage.error(error?.message || '操作失败，请查看连接状态') } }
function openArtifact(item) { if (item.url) window.open(item.url, '_blank', 'noopener') }
function markArtifactBroken(id) { brokenArtifacts.value = new Set([...brokenArtifacts.value, id]) }
function useExample(example) { router.push(example.target || { path: '/free-create', query: { prompt: example.prompt } }) }
async function addDesktopShortcut() {
  if (shortcutSaving.value) return
  shortcutSaving.value = true
  shortcutHint.value = ''
  try {
    const result = await orchestrationAPI.createDesktopShortcut()
    shortcutHint.value = '已添加到 Windows 桌面，双击会自动启动并打开当前工作台。'
    ElMessage.success('桌面快捷方式已准备好')
    return result
  } catch (error) {
    shortcutHint.value = error?.message || '桌面快捷方式创建失败，请检查安装目录和 Windows 权限。'
    ElMessage.error(shortcutHint.value)
  } finally { shortcutSaving.value = false }
}
function pointFor(index, width = 640, height = 180) { const values = samples.value.map((item) => Math.max(0, Number(item.rate) || 0)); const ceiling = Math.max(1, ...values); const x = values.length <= 1 ? 0 : index / (values.length - 1) * width; const y = height - values[index] / ceiling * (height - 18) - 9; return { x, y } }
const sparklinePoints = computed(() => samples.value.map((_, index) => { const point = pointFor(index); return `${point.x},${point.y}` }).join(' ')); const sparklineCircles = computed(() => samples.value.map((item, index) => { const point = pointFor(index); return { ...point, key: `${item.at}-${index}` } })); const sparklineArea = computed(() => { if (!samples.value.length) return ''; const first = pointFor(0); const last = pointFor(samples.value.length - 1); return `M ${first.x},180 L ${sparklinePoints.value.replaceAll(' ', ' L ')} L ${last.x},180 Z` })
useLiveRefresh(loadDashboard, { active: () => sessions.value.some(item => ['draft','running'].includes(item.status)) || batches.value.some(item => ['running','queued'].includes(item.status)), failed: () => Boolean(runtimeError.value) })
useWorkbenchPage({ refresh: loadDashboard, error: () => runtimeError.value, loading: () => loading.value })

const { heroCanvas, live: heroLive, mount: mountHero } = useSilverHero()
// 工作越忙，银液翻涌得越明显；空闲时它安静地慢慢流
watchEffect(() => {
  const busy = activeSession.value || activeBatch.value
  heroLive.value = busy ? 0.75 : 0.35
})
onMounted(() => { mountHero() })
onBeforeUnmount(() => { heroCanvas.value = null })
</script>

<style scoped>
/* ── Page layout ─────────────────────────────────────────── */
.dashboard-page{display:grid;gap:18px}

/* ── Hero ────────────────────────────────────────────────── */
.dash-hero{display:grid;grid-template-columns:1fr;align-items:center;gap:32px;min-height:300px;padding:36px 40px;border:1px solid var(--border-color);background:var(--gradient-hero);border-radius:var(--radius-lg);overflow:hidden;position:relative}
.dash-hero-eyebrow{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.dash-unattended-row{display:flex;align-items:center;gap:7px;cursor:pointer}
.dash-unattended-row>span{font-size:13px;font-weight:600;color:var(--text-muted)}
.dash-unattended-row small{font-size:11px;color:var(--ui-accent);margin-left:3px}
.dash-freshness{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-subtle)}
.dash-freshness small{color:var(--text-subtle);margin-left:3px}
.dash-freshness.stale{color:var(--ui-warning)}
.dash-freshness.stale small{color:var(--ui-warning)}
.dash-hero-status{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.dash-hero h1{font-family:var(--font-display);font-size:clamp(30px,3.8vw,50px);font-weight:700;line-height:1.1;letter-spacing:-.01em;margin:0 0 12px;max-width:600px;color:var(--text-bright)}
.dash-hero h1 em{font-style:normal;background:var(--gradient-chrome-text);-webkit-background-clip:text;background-clip:text;color:transparent}
.dash-hero-text>p{color:var(--text-muted);font-size:14px;line-height:1.7;max-width:500px;margin:0 0 20px}
.dash-hero-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.dash-hero-actions :deep(.el-button--primary:not(.is-plain)){box-shadow:0 0 0 1px rgba(255,255,255,.22) inset, var(--shadow-sm)}
.desktop-shortcut-button{color:var(--text-subtle)!important}
.shortcut-hint{display:block;margin-top:8px;font-size:12px;color:var(--text-subtle)}
.dash-hero-visual{position:relative;width:240px;height:200px;justify-self:end;flex-shrink:0}

/* ── Metric strip ────────────────────────────────────────── */
.metric-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--border-color);background:var(--bg-card);border-radius:var(--radius-md);overflow:hidden}
.metric-item{display:flex;flex-direction:column;gap:3px;padding:18px 22px;border-right:1px solid var(--border-color)}
.metric-item:last-child{border-right:0}
.metric-top{margin-bottom:6px}.metric-top .el-icon{font-size:16px}
.metric-item>strong{font-family:var(--font-mono);font-size:30px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.025em;color:var(--text-bright);line-height:1}
.metric-item>span{font-size:11.5px;font-weight:600;color:var(--text-muted);letter-spacing:.01em;margin-top:3px}
.metric-item small{font-size:11px;color:var(--text-subtle)}
.metric-item>strong.is-text{font-family:var(--font-ui);font-size:18px;font-weight:600;color:var(--text-muted);letter-spacing:0;padding:6px 0 4px}
.metric-top .mint{color:var(--ui-accent)}.metric-top .amber{color:var(--ui-warning)}.metric-top .green{color:var(--ui-success)}.metric-top .blue{color:var(--ui-info)}

/* ── Panels ──────────────────────────────────────────────── */
.panel{padding:20px 22px;border:1px solid var(--border-color);background:var(--bg-card);border-radius:var(--radius-md)}
.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.panel-heading a,.panel-heading .panel-meta{font-size:12px;color:var(--text-muted);text-decoration:none;display:flex;align-items:center;gap:4px;white-space:nowrap;flex-shrink:0}
.panel-heading a:hover{color:var(--ui-accent)}
.panel-heading h3{margin:4px 0 0;font-size:16px;font-weight:700}
.kicker{display:block;color:var(--text-subtle);font-size:11px;letter-spacing:.04em;font-weight:500}

/* ── Canvas card ─────────────────────────────────────────── */
.canvas-feature-card{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:20px 24px;border:1px solid var(--border-color);background:var(--bg-card);border-radius:var(--radius-md)}
.canvas-feature-card h2{margin:0 0 5px;font-size:17px;font-weight:700}
.canvas-feature-card p{margin:0 0 14px;color:var(--text-muted);font-size:13px;line-height:1.6}
.canvas-feature-badge{width:42px;height:42px;display:grid;place-items:center;color:var(--ui-accent);border:1px solid var(--border-color);border-radius:var(--radius-sm);flex-shrink:0;font-size:18px}

/* ── Columns layout ──────────────────────────────────────── */
.dashboard-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px}
.dashboard-columns.has-work-activity{grid-template-columns:1fr}
.lower-columns{grid-template-columns:minmax(0,1.4fr) minmax(0,1fr)}

/* ── Current panel ───────────────────────────────────────── */
.current-session{display:grid;gap:14px}
.current-session-title{display:flex;align-items:flex-start;gap:10px}
.current-session-title div{flex:1;min-width:0}
.current-session-title strong{display:block;font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.current-session-title p{margin:4px 0 0;color:var(--text-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.current-progress{display:grid;gap:9px}
.current-progress>div{display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted)}
.current-progress>div strong{color:var(--text-primary)}
.stage-row{display:flex;gap:8px;flex-wrap:wrap}
.stage-row span{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--text-subtle)}
.stage-row span i{width:6px;height:6px;border-radius:50%;background:var(--text-subtle);flex-shrink:0}
.stage-row span.current{color:var(--ui-accent)}.stage-row span.current i{background:var(--ui-accent);box-shadow:0 0 6px var(--ui-accent)}
.stage-row span.done{color:var(--ui-success)}.stage-row span.done i{background:var(--ui-success)}
.current-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--text-muted)}
.current-footer .el-icon{vertical-align:-2px}
.empty-current{display:flex;flex-direction:column;align-items:center;gap:12px;padding:28px 0;text-align:center}
.empty-current>span{width:44px;height:44px;display:grid;place-items:center;border:1px solid var(--border-color);border-radius:50%;color:var(--text-subtle);font-size:18px}
.empty-current strong{font-size:14px}.empty-current p{color:var(--text-muted);font-size:13px;margin:0}

/* ── Latest panel ────────────────────────────────────────── */
.latest-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.latest-card{border:1px solid var(--border-color);background:var(--bg-inner);border-radius:var(--radius-sm);overflow:hidden;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.latest-card:hover{border-color:var(--ui-accent);box-shadow:var(--shadow-xs)}
.latest-media{position:relative;padding-top:60%;background:var(--bg-inner)}
.latest-media img,.latest-media video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.latest-fallback{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--text-subtle);font-size:11px}
.latest-type{position:absolute;bottom:5px;left:6px;padding:2px 6px;background:rgba(0,0,0,.55);color:#fff;font-size:10px;border-radius:4px;backdrop-filter:blur(4px)}
.latest-card footer{padding:7px 9px 8px;display:grid;gap:2px}
.latest-card footer strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.latest-card footer small{font-size:10.5px;color:var(--text-subtle)}
.empty-latest{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:32px 0;color:var(--text-subtle)}
.empty-latest .el-icon{font-size:28px}.empty-latest p{font-size:12px;color:var(--text-muted);margin:0;text-align:center}

/* ── Status dots & labels ────────────────────────────────── */
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0;margin-top:3px}
.status-dot.active{background:var(--ui-accent);box-shadow:0 0 0 3px var(--ui-accent-soft),0 0 8px var(--ui-accent)}
.status-dot.success{background:var(--ui-success)}.status-dot.warning{background:var(--ui-warning)}
.status-dot.danger{background:var(--ui-danger)}.status-dot.muted{background:var(--text-subtle)}
.status-label{font-size:11px;font-weight:600;padding:2px 7px;border-radius:var(--radius-full)}
.status-label.active{color:var(--ui-accent);background:var(--ui-accent-soft)}
.status-label.success{color:var(--ui-success);background:var(--ui-success-soft)}
.status-label.warning{color:var(--ui-warning);background:var(--ui-warning-soft)}
.status-label.danger{color:var(--ui-danger);background:var(--ui-danger-soft)}
.status-label.muted{color:var(--text-muted);background:var(--bg-inner)}

/* ── Attention banner ────────────────────────────────────── */
.attention-banner{display:flex;align-items:center;gap:13px;padding:14px 17px;border:1px solid var(--border-color);background:var(--bg-hover);border-radius:var(--radius-md)}
.attention-icon{width:36px;height:36px;display:grid;place-items:center;color:var(--ui-accent);border:1px solid var(--ui-accent);border-radius:50%;font-size:15px;flex-shrink:0}
.attention-banner div{flex:1;min-width:0}
.attention-banner strong{display:block;font-size:13px;font-weight:700}
.attention-banner p{margin:3px 0 0;color:var(--text-muted);font-size:12px;line-height:1.5;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.attention-actions{display:flex;gap:7px;flex-shrink:0}

/* ── First-run guide ─────────────────────────────────────── */
.first-run-guide{display:grid;gap:16px;padding:20px 22px;border:1px solid var(--border-color);background:var(--bg-card);border-radius:var(--radius-md)}
.first-run-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.first-run-heading h3{margin:6px 0;font-size:17px}
.first-run-heading p{max-width:780px;margin:0;color:var(--text-muted);font-size:12px;line-height:1.7}
.first-run-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.first-run-steps article{display:flex;gap:11px;min-width:0;padding:14px;border:1px solid var(--border-color);background:var(--bg-inner);border-radius:var(--radius-sm)}
.first-run-steps article>span{display:grid;place-items:center;width:26px;height:26px;flex:none;color:var(--el-color-primary);border:1px solid var(--el-color-primary);font-weight:700;border-radius:4px}
.first-run-steps strong{font-size:12px}.first-run-steps p{min-height:43px;margin:5px 0 9px;color:var(--text-muted);font-size:12px;line-height:1.55}
.first-run-actions{display:flex;flex-wrap:wrap;gap:6px}.first-run-footnote{color:var(--text-subtle);font-size:12px}

/* ── Manual batch panel ──────────────────────────────────── */
.manual-current{display:flex;flex-direction:column;align-items:flex-start;gap:12px;padding:24px}

/* ── Sparkline ───────────────────────────────────────────── */
.sparkline-wrap{display:grid;gap:6px}.sparkline-wrap svg{width:100%;height:180px;border-radius:var(--radius-sm)}
.chart-axis{display:flex;justify-content:space-between;font-size:11px;color:var(--text-subtle)}
.chart-note{margin:2px 0 0;font-size:11px;color:var(--text-faint)}
.chart-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:20px 0;text-align:center}
.chart-bars{display:flex;align-items:flex-end;gap:5px;height:48px}.chart-bars i{width:10px;background:var(--border-muted);border-radius:2px}
.chart-empty strong{font-size:13px}.chart-empty span{font-size:12px;color:var(--text-muted)}

/* ── Examples ────────────────────────────────────────────── */
.example-list{display:grid;gap:1px;background:var(--border-color);border:1px solid var(--border-color);border-radius:var(--radius-sm);overflow:hidden}
.example-list button{display:flex;align-items:center;gap:10px;padding:11px 12px;text-align:left;border:0;background:var(--bg-card);color:var(--text-primary);cursor:pointer;width:100%;transition:background .12s}
.example-list button:hover{background:var(--bg-hover)}
.example-list button>span:nth-child(2){min-width:0;flex:1;display:grid;gap:3px}
.example-list strong{font-size:12px}.example-list small{overflow:hidden;color:var(--text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.example-list>.el-icon{color:var(--ui-accent)}
.example-icon{width:29px;height:29px;display:grid;place-items:center;flex:none;border-radius:6px}
.example-icon.mint{color:var(--ui-accent);background:var(--ui-accent-soft)}
.example-icon.amber{color:var(--ui-warning);background:var(--ui-warning-soft)}
.example-icon.blue{color:var(--ui-info);background:var(--ui-info-soft)}

/* ── Recent table ────────────────────────────────────────── */
.recent-panel{padding-bottom:8px}
.recent-table{display:grid}
.recent-row{display:grid;grid-template-columns:minmax(0,2fr) 100px 110px 38px;align-items:center;gap:12px;min-height:52px;padding:7px 8px;border:0;border-top:1px solid var(--border-color);background:transparent;color:var(--text-muted);text-align:left}
.recent-row:not(.recent-head){width:100%;cursor:pointer}.recent-row:not(.recent-head):hover{background:var(--bg-hover)}
.recent-row span:first-child{min-width:0;display:grid;gap:3px}
.recent-row strong{overflow:hidden;color:var(--text-primary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.recent-row small{overflow:hidden;color:var(--text-muted);font-size:11px;text-overflow:ellipsis;white-space:nowrap}
.recent-head{min-height:30px;padding-top:0;color:var(--text-muted);font-size:11px}
.row-action{display:grid;place-items:center;color:var(--ui-accent)}
.table-empty{padding:30px;color:var(--text-muted);text-align:center;font-size:12px}

/* ── Responsive ──────────────────────────────────────────── */
@media(max-width:1100px){.metric-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.dashboard-columns,.lower-columns{grid-template-columns:minmax(0,1fr)}.dash-hero{padding:28px 30px;min-height:260px}}
@media(max-width:760px){.dash-hero{grid-template-columns:1fr;min-height:auto;padding:22px 20px;gap:0}.dash-hero-visual{display:none}.metric-strip{grid-template-columns:1fr 1fr}.metric-item{padding:14px 16px}.metric-item>strong{font-size:24px}.first-run-steps{grid-template-columns:1fr}.panel{padding:16px}.attention-banner{align-items:flex-start;flex-wrap:wrap}.attention-actions{width:100%;padding-left:49px}.recent-row{grid-template-columns:minmax(0,1fr) 76px 32px}.recent-row span:nth-child(3){display:none}.recent-head span:nth-child(3){display:none}.latest-card footer small{display:none}}
@media(max-width:460px){.dash-hero-eyebrow{flex-direction:column;align-items:flex-start;gap:6px}.metric-strip{grid-template-columns:1fr 1fr}}
</style>
<style scoped>
/* ── 液态银 hero ───────────────────────────────────────────
   一片域扭曲的 fbm 高度场按拉丝金属打光，铺满整张 hero，文字压在上面。
   由 useSilverHero 驱动，档位低到不渲染时 canvas 是空的，
   露出 hero 自己的渐变底色，视觉上不掉档。 */
.dash-hero-canvas { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 0; pointer-events: none; }
/* 左边深、右边亮的遮罩：既保证标题可读，又让银液在右侧显出来 */
.dash-hero-veil {
  position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background:
    linear-gradient(96deg, var(--bg-card) 0%, rgba(18,20,24,.94) 26%, rgba(18,20,24,.72) 46%, rgba(18,20,24,.18) 72%, transparent 100%),
    linear-gradient(180deg, transparent 58%, rgba(18,20,24,.55) 100%);
}
html.light .dash-hero-veil {
  background:
    linear-gradient(96deg, var(--bg-card) 0%, rgba(246,243,238,.94) 26%, rgba(246,243,238,.70) 46%, rgba(246,243,238,.16) 72%, transparent 100%),
    linear-gradient(180deg, transparent 58%, rgba(246,243,238,.5) 100%);
}
.dash-hero-text { position: relative; z-index: 2; }
@media (max-width: 760px) {
  /* 窄屏没有右侧空间，遮罩改成整片上到下 */
  .dash-hero-veil { background: linear-gradient(180deg, rgba(18,20,24,.90) 0%, rgba(18,20,24,.72) 100%); }
  html.light .dash-hero-veil { background: linear-gradient(180deg, rgba(246,243,238,.92) 0%, rgba(246,243,238,.76) 100%); }
}
@media (prefers-reduced-motion: reduce) {
  .dash-hero-canvas { opacity: .55; }
}
</style>
