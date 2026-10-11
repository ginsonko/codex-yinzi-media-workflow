<template>
  <div class="workbench-view">
    <div class="history-page">
      <section class="history-hero">
        <div>
          <span class="kicker">本机记录</span>
          <h2>找到上次停下的位置</h2>
          <p>这一页把本机跑过的编排任务和批量批次放在一起看。时间、类型、状态、关键词都在下面直接筛；筛出来的每一条都能点开当时的计划、队列和费用记录。失败和取消的记录不会被刷新成空白，也不会被隐藏。</p>
        </div>
        <div class="hero-actions">
          <el-button type="primary" @click="$router.push('/free-create')">手动创作</el-button>
          <el-button plain @click="$router.push('/batch')">批量生成</el-button>
          <el-button plain :loading="loading" @click="load">刷新记录</el-button>
        </div>
      </section>

      <section class="history-stats" aria-label="记录统计">
        <article><small>本机记录的任务</small><strong>{{ counts.all }}</strong><span>编排 {{ counts.session }} · 批量 {{ counts.batch }}</span></article>
        <article><small>有结果可看</small><strong>{{ counts.resultful }}</strong><span>已完成或部分完成的记录</span></article>
        <article><small>需要你处理</small><strong :class="{ attention: counts.attention > 0 }">{{ counts.attention }}</strong><span>失败、待确认或部分完成</span></article>
        <article><small>最近 7 天</small><strong>{{ counts.recent }}</strong><span>按记录最后更新时间统计</span></article>
      </section>

      <section class="panel filter-panel">
        <header class="panel-heading">
          <div><span class="kicker">筛选与排序</span><h3>只看你要找的那一批</h3></div>
          <div class="filter-actions">
            <el-button size="small" plain @click="resetFilters">重置筛选</el-button>
            <el-button size="small" plain :loading="loading" @click="load">刷新</el-button>
          </div>
        </header>
        <div class="filter-grid">
          <label class="field"><span>时间范围</span>
            <el-select v-model="filters.time" aria-label="时间范围">
              <el-option v-for="option in timeOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </label>
          <label class="field"><span>类型</span>
            <el-select v-model="filters.kind" aria-label="记录类型">
              <el-option label="全部类型" value="all" />
              <el-option label="编排任务" value="session" />
              <el-option label="批量批次" value="batch" />
              <el-option label="手动创作" value="manual" />
            </el-select>
          </label>
          <label class="field"><span>状态</span>
            <el-select v-model="filters.status" aria-label="记录状态">
              <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </label>
          <label class="field field-wide"><span>搜索名称或目标</span>
            <el-input v-model="filters.keyword" clearable placeholder="例如：月见山房、商品图、D:\素材" />
          </label>
          <label class="field"><span>排序</span>
            <el-select v-model="filters.sort" aria-label="排序字段">
              <el-option label="按最后更新" value="updated" />
              <el-option label="按状态" value="status" />
              <el-option label="按类型" value="kind" />
            </el-select>
          </label>
          <label class="field"><span>方向</span>
            <el-select v-model="filters.direction" aria-label="排序方向">
              <el-option label="新的在前" value="desc" />
              <el-option label="旧的在前" value="asc" />
            </el-select>
          </label>
        </div>
      </section>

      <section v-if="error" class="panel error-panel">
        <div>
          <strong>记录没有读出来：{{ error }}</strong>
          <p>这通常是本机后端没有启动或正在重启。已有记录不会因为读取失败而丢失，可以重新读一次；如果你正在跑任务，先不要重复提交同一个付费动作。</p>
        </div>
        <el-button type="primary" :loading="loading" @click="load">重新读取</el-button>
      </section>

      <section class="panel">
        <header class="panel-heading">
          <div><span class="kicker">记录列表</span><h3>{{ filters.kind === 'all' ? '全部记录' : kindLabel(filters.kind) }}</h3></div>
          <span class="count">{{ filtered.length }} / {{ rows.length }}</span>
        </header>

        <div v-if="loading && !rows.length" class="skeleton-list"><span v-for="i in 5" :key="i"></span></div>

        <template v-else-if="filtered.length">
          <div class="row-head" aria-hidden="true">
            <span>记录</span><span>现在到哪了</span><span>状态</span><span>时间</span><span></span>
          </div>
          <div class="record-list">
            <article v-for="row in paged" :key="row.key" class="record-row">
              <div class="record-main">
                <span :class="['dot', row.tone]"></span>
                <div>
                  <strong>{{ row.title }}</strong>
                  <p>{{ row.detail }}</p>
                  <small class="record-kind">{{ kindLabel(row.kind) }}</small>
                </div>
              </div>
              <div class="record-progress">
                <template v-if="row.percent !== null">
                  <el-progress :percentage="row.percent" :show-text="false" :stroke-width="4" />
                  <small>{{ row.progressText }}</small>
                </template>
                <small v-else>{{ row.progressText }}</small>
              </div>
              <div class="record-status" :class="row.tone">
                <span :class="['dot', row.tone]"></span>{{ row.statusLabel }}
              </div>
              <div class="record-time">
                <time>{{ formatDate(row.updatedAt) }}</time>
                <small>{{ relativeTime(row.updatedAt) }}</small>
              </div>
              <div class="record-action">
                <el-button size="small" plain @click="openRow(row)">{{ row.actionLabel }}</el-button>
              </div>
            </article>
          </div>
          <el-pagination v-if="filtered.length > pageSize" v-model:current-page="page" :page-size="pageSize" :total="filtered.length" layout="prev, pager, next" class="record-pagination" />
        </template>

        <div v-else-if="rows.length" class="empty">
          <strong>没有符合当前筛选的记录</strong>
          <p>换一个时间范围或清掉关键词试试，也可以直接重置全部筛选条件。</p>
          <div class="empty-actions">
            <el-button type="primary" @click="resetFilters">重置筛选</el-button>
            <el-button plain @click="filters.time = 'all'; filters.kind = 'all'">只看全部时间</el-button>
          </div>
        </div>

        <div v-else class="empty">
          <strong>这里还没有记录</strong>
          <p>编排任务、批量批次和手动创作都会记在这一页。从下面任选一种开始，跑起来之后就会在这里出现。</p>
          <div class="empty-actions">
            <el-button type="primary" @click="$router.push('/codex-console')">建立编排任务</el-button>
            <el-button plain @click="$router.push('/free-create')">先做一条手动创作</el-button>
            <el-button plain @click="$router.push('/batch')">设置一个批量批次</el-button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'
import orchestrationAPI from '@/api/orchestration'
import mediaBatchAPI from '@/api/mediaBatch'

const router = useRouter()
const sessions = ref([])
const batches = ref([])
const loading = ref(false)
const error = ref('')
const page = ref(1)
const pageSize = 30
const prefsKey = 'yinzi-history-prefs-v1'

const timeOptions = [
  { value: 'all', label: '全部时间', hours: null },
  { value: '24h', label: '最近 24 小时', hours: 24 },
  { value: '7d', label: '最近 7 天', hours: 24 * 7 },
  { value: '30d', label: '最近 30 天', hours: 24 * 30 },
]
const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'active', label: '执行中 / 待开始' },
  { value: 'attention', label: '失败 / 待确认 / 部分完成' },
  { value: 'done', label: '已完成' },
  { value: 'paused', label: '已暂停' },
  { value: 'archived', label: '已取消 / 已归档' },
]
const filters = reactive({ time: 'all', kind: 'all', status: 'all', keyword: '', sort: 'updated', direction: 'desc' })
try {
  const saved = JSON.parse(localStorage.getItem(prefsKey) || 'null')
  if (saved && typeof saved === 'object') for (const key of ['time', 'kind', 'status', 'sort', 'direction']) if (typeof saved[key] === 'string') filters[key] = saved[key]
} catch {}
watch(filters, () => { page.value = 1; try { localStorage.setItem(prefsKey, JSON.stringify({ ...filters, keyword: '' })) } catch {} }, { deep: true })

function sessionStatusLabel(status) { return ({ running: '执行中', planned: '待开始', waiting_confirmation: '待确认', paused: '已暂停', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', draft: '待规划' })[status] || '待处理' }
function batchStatusLabel(status) { return ({ queued: '准备中', running: '提交中', paused: '已暂停', completed: '已完成', partial: '部分完成', failed: '全部失败', needs_review: '有结果待核对' })[status] || '处理中' }
function toneFor(status) {
  if (status === 'succeeded' || status === 'completed') return 'success'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  if (['paused', 'partial', 'waiting_confirmation', 'needs_review', 'planned', 'draft'].includes(status)) return 'warning'
  if (['running', 'queued'].includes(status)) return 'active'
  return 'muted'
}
function kindLabel(kind) { return ({ session: '编排任务', batch: '批量批次', manual: '手动创作' })[kind] || '记录' }
function formatDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知' }
function relativeTime(value) {
  if (!value) return '时间未知'
  const diff = Date.now() - new Date(value).getTime()
  if (!Number.isFinite(diff)) return '时间未知'
  if (diff < 60000) return '不到 1 分钟前'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
function batchPercent(item) { return item.total ? Math.round((item.completed + item.failed + (item.needs_review || 0)) / item.total * 100) : null }

const rows = computed(() => {
  const sessionRows = sessions.value.map(item => {
    const session = item.session || item
    const counts = item.counts || {}
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0)
    const done = ['succeeded', 'skipped', 'partial', 'failed', 'cancelled'].reduce((sum, key) => sum + Number(counts[key] || 0), 0)
    return {
      key: `session:${session.id}`, kind: 'session', id: session.id,
      title: session.title || '未命名任务',
      detail: session.user_goal || '没有记录目标描述',
      status: session.status,
      statusLabel: sessionStatusLabel(session.status),
      tone: toneFor(session.status),
      updatedAt: session.updated_at || session.created_at || '',
      percent: total ? Math.round(done / total * 100) : null,
      progressText: total ? `节点 ${done} / ${total} 已完成` : '尚无分步计划',
      actionLabel: '打开任务',
      to: `/codex-console/${session.id}`,
    }
  })
  const batchRows = batches.value.map(item => {
    const manual = item.settings?._origin === 'manual'
    const failed = Number(item.failed || 0)
    return {
      key: `batch:${item.id}`, kind: manual ? 'manual' : 'batch', id: item.id,
      title: item.title || '未命名批次',
      detail: manual
        ? `手动创作 · 并发 ${item.concurrency || 1}`
        : `${item.kind === 'image' ? '批量图片' : item.kind === 'video' ? '批量视频' : '批量'} · ${item.total || 0} 项 · 并发 ${item.concurrency || 1}`,
      status: item.status,
      statusLabel: batchStatusLabel(item.status),
      tone: toneFor(item.status),
      updatedAt: item.updated_at || item.created_at || '',
      percent: batchPercent(item),
      progressText: `${item.completed || 0} 完成 · ${failed} 失败${item.needs_review ? ` · ${item.needs_review} 待核对` : ''}`,
      actionLabel: manual ? '看这批创作' : '打开队列',
      to: manual ? '/free-create' : `/batch?batch=${item.id}`,
    }
  })
  return [...sessionRows, ...batchRows]
})

const counts = computed(() => {
  const weekAgo = Date.now() - 7 * 86400000
  return {
    all: rows.value.length,
    session: rows.value.filter(row => row.kind === 'session').length,
    batch: rows.value.filter(row => row.kind === 'batch').length,
    resultful: rows.value.filter(row => ['succeeded', 'partial', 'completed'].includes(row.status)).length,
    attention: rows.value.filter(row => ['failed', 'cancelled', 'partial', 'waiting_confirmation', 'needs_review'].includes(row.status)).length,
    recent: rows.value.filter(row => row.updatedAt && new Date(row.updatedAt).getTime() >= weekAgo).length,
  }
})

const statusRank = { failed: 0, cancelled: 1, waiting_confirmation: 2, needs_review: 3, partial: 4, running: 5, queued: 6, paused: 7, planned: 8, draft: 9, succeeded: 10, completed: 11 }
const kindRank = { session: 0, batch: 1, manual: 2 }

const filtered = computed(() => {
  const range = timeOptions.find(option => option.value === filters.time)?.hours
  const since = range ? Date.now() - range * 3600000 : 0
  const keyword = filters.keyword.trim().toLowerCase()
  const direction = filters.direction === 'asc' ? 1 : -1
  const result = rows.value.filter(row => {
    if (filters.kind !== 'all' && row.kind !== filters.kind) return false
    if (since && (!row.updatedAt || new Date(row.updatedAt).getTime() < since)) return false
    if (keyword && !`${row.title} ${row.detail}`.toLowerCase().includes(keyword)) return false
    if (filters.status === 'active') return ['running', 'queued', 'planned', 'draft'].includes(row.status)
    if (filters.status === 'attention') return ['failed', 'cancelled', 'waiting_confirmation', 'needs_review', 'partial'].includes(row.status)
    if (filters.status === 'done') return ['succeeded', 'completed'].includes(row.status)
    if (filters.status === 'paused') return row.status === 'paused'
    if (filters.status === 'archived') return ['cancelled'].includes(row.status)
    return true
  })
  return [...result].sort((a, b) => {
    if (filters.sort === 'status') return ((statusRank[a.status] ?? 99) - (statusRank[b.status] ?? 99)) * direction
    if (filters.sort === 'kind') {
      const diff = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9)
      if (diff) return diff * direction
      return (new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0)) * direction
    }
    return (new Date(a.updatedAt || 0) - new Date(b.updatedAt || 0)) * direction
  })
})

/* 筛选结果变少时把页码收回有效范围内（必须放在 filtered 声明之后，否则会被暂时性死区拦住） */
watch(() => filtered.value.length, () => { const max = Math.max(1, Math.ceil(filtered.value.length / pageSize)); if (page.value > max) page.value = max })

const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))

function resetFilters() { Object.assign(filters, { time: 'all', kind: 'all', status: 'all', keyword: '', sort: 'updated', direction: 'desc' }) }
function openRow(row) { if (row.to) router.push(row.to) }

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [taskResult, batchResult] = await Promise.all([orchestrationAPI.sessions({ limit: 100 }), mediaBatchAPI.list({ limit: 100 })])
    sessions.value = taskResult?.items || []
    batches.value = batchResult?.items || []
  } catch (e) {
    error.value = e?.message || '暂时无法读取历史记录'
  } finally {
    loading.value = false
  }
}
onMounted(load)
useWorkbenchPage({ refresh: load, error: () => error.value, loading: () => loading.value })
</script>

<style scoped>
.history-page { display: grid; gap: 16px }
.history-hero { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; padding: 22px 24px; border: 1px solid var(--border-color); background: var(--bg-card) }
.kicker { display: block; color: var(--text-subtle); font-size: 12px }
.history-hero h2 { margin: 8px 0 8px; font-family: var(--font-display); font-size: 26px; font-weight: 600; color: var(--text-bright) }
.history-hero p { max-width: 780px; margin: 0; color: var(--text-muted); font-size: 13px; line-height: 1.75 }
.hero-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end }
.history-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--border-color); background: var(--bg-card) }
.history-stats article { display: grid; gap: 5px; padding: 14px 16px; border-right: 1px solid var(--border-color) }
.history-stats article:last-child { border-right: 0 }
.history-stats small { color: var(--text-subtle); font-size: 11px }
.history-stats strong { color: var(--text-primary); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 20px; font-weight: 500 }
.history-stats strong.attention { color: var(--ui-warning) }
.history-stats span { color: var(--text-faint); font-size: 11px }
.panel { padding: 18px 20px; border: 1px solid var(--border-color); background: var(--bg-card) }
.panel-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 14px }
.panel-heading h3 { margin: 5px 0 0; font-size: 16px; color: var(--text-primary) }
.filter-actions { display: flex; gap: 6px }
.count { color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 13px }
.filter-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px }
.field { display: grid; gap: 6px; min-width: 0 }
.field > span { color: var(--text-subtle); font-size: 11px }
.field-wide { grid-column: span 2 }
.field :deep(.el-select), .field :deep(.el-input) { width: 100% }
.error-panel { display: flex; align-items: center; justify-content: space-between; gap: 16px; border-color: var(--ui-danger) }
.error-panel strong { color: var(--ui-danger); font-size: 13px }
.error-panel p { margin: 6px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.7 }
.skeleton-list { display: grid; gap: 8px; padding: 8px 0 }
.skeleton-list span { height: 58px; background: var(--bg-inner) }
.row-head { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(150px, .9fr) 120px 150px 110px; gap: 14px; padding: 0 0 8px; color: var(--text-faint); font-size: 11px }
.record-list { display: grid }
.record-row { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(150px, .9fr) 120px 150px 110px; gap: 14px; align-items: center; padding: 13px 0; border-top: 1px solid var(--border-color) }
.record-main { display: flex; gap: 10px; min-width: 0 }
.record-main > div { min-width: 0 }
.record-main strong, .record-main p { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 0 }
.record-main strong { color: var(--text-primary); font-size: 13px; font-weight: 500 }
.record-main p { margin-top: 4px; color: var(--text-muted); font-size: 12px }
.record-kind { display: block; margin-top: 4px; color: var(--text-faint); font-size: 11px }
.record-progress { min-width: 0; display: grid; gap: 6px }
.record-progress small { color: var(--text-subtle); font-size: 11px }
.record-status { display: flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap }
.record-time { display: grid; gap: 3px; min-width: 0 }
.record-time time { color: var(--text-muted); font-family: var(--font-mono); font-variant-numeric: tabular-nums; font-size: 12px }
.record-time small { color: var(--text-faint); font-size: 11px }
.record-action { display: flex; justify-content: flex-end }
.record-pagination { justify-content: center; margin-top: 14px }
.dot { width: 7px; height: 7px; flex: none; margin-top: 5px; border-radius: 50%; background: var(--text-faint) }
.record-status .dot { margin-top: 0 }
.dot.success { background: var(--ui-success) }
.dot.danger { background: var(--ui-danger) }
.dot.warning { background: var(--ui-warning) }
.dot.active { background: var(--ui-warning) }
.dot.muted { background: var(--text-faint) }
.record-status.success { color: var(--ui-success) }
.record-status.danger { color: var(--ui-danger) }
.record-status.warning { color: var(--ui-warning) }
.record-status.active { color: var(--ui-warning) }
.record-status.muted { color: var(--text-subtle) }
.empty { display: grid; justify-items: center; gap: 8px; padding: 44px 20px; text-align: center }
.empty strong { color: var(--text-primary); font-size: 14px }
.empty p { max-width: 560px; margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.7 }
.empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px }
@media (max-width: 1080px) {
  .filter-grid { grid-template-columns: 1fr 1fr }
  .field-wide { grid-column: span 2 }
  .row-head { display: none }
  .record-row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: 'main action' 'progress status' 'time time'; gap: 8px 12px }
  .record-main { grid-area: main }
  .record-progress { grid-area: progress }
  .record-status { grid-area: status; justify-content: flex-end }
  .record-time { grid-area: time; grid-auto-flow: column; justify-content: start; gap: 10px }
  .record-action { grid-area: action }
}
@media (max-width: 780px) {
  .history-hero { flex-direction: column }
  .hero-actions { justify-content: flex-start }
  .history-stats { grid-template-columns: 1fr 1fr }
  .history-stats article:nth-child(2) { border-right: 0 }
  .history-stats article:nth-child(1), .history-stats article:nth-child(2) { border-bottom: 1px solid var(--border-color) }
  .filter-grid { grid-template-columns: 1fr }
  .field-wide { grid-column: auto }
}
</style>
