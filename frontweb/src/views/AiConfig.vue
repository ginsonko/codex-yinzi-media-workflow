<template>
  <section class="model-workspace">
    <header class="cfg-intro">
      <div class="cfg-intro-main">
        <h1 class="silver-display">模型与 Key</h1>
        <p>
          这一页管两件事：把可用的模型服务存下来，以及在真正生成之前看清每条配置会怎么被选中。
          文本、图片、分镜图、视频各自只认一个「默认 + 启用」的配置，其余按优先级作为候选。
          Key 只写在本机后端，页面从不回显明文。
        </p>
      </div>
      <div class="cfg-intro-actions">
        <el-button :icon="Refresh" :loading="listLoading" @click="reloadAll">重新读取</el-button>
        <el-button :icon="QuestionFilled" @click="router.push('/help')">使用指南</el-button>
      </div>
    </header>

    <div class="cfg-readiness" role="list" aria-label="必备服务就绪情况">
      <div v-for="item in readiness.required" :key="item.type" role="listitem" :class="['readiness-item', { 'is-ready': item.ready }]">
        <span class="readiness-dot" aria-hidden="true"></span>
        <div>
          <strong>{{ item.label }}</strong>
          <small>{{ item.ready ? (item.config?.name || '已就绪') : item.reason }}</small>
        </div>
      </div>
      <div class="readiness-total">
        <strong class="silver-mono">{{ readiness.readyCount }} / {{ readiness.total }}</strong>
        <small>必备服务</small>
      </div>
    </div>

    <!-- ── 候选总览：每条可编辑项直接摊开 ───────────────────────── -->
    <section class="cfg-panel">
      <div class="panel-head">
        <div>
          <h2>候选总览 · 直接编辑</h2>
          <p>点一行展开，Base URL、模型名、优先级、用途和备注都能就地改。改完点「保存这条」，不花钱、不需要重新验证。Key 默认遮挡。</p>
        </div>
        <div class="panel-head-tools">
          <el-input v-model="search" clearable placeholder="搜索名称 / URL / 模型 / 备注" :prefix-icon="Search" class="cfg-search" />
          <el-select v-model="sortBy" class="cfg-sort">
            <el-option label="按优先级" value="priority" />
            <el-option label="按名称" value="name" />
            <el-option label="按最近修改" value="updated" />
          </el-select>
        </div>
      </div>

      <div class="group-tabs" role="tablist">
        <button
          v-for="group in groups"
          :key="group.key"
          type="button"
          role="tab"
          :aria-selected="activeGroup === group.key"
          :class="['group-tab', { active: activeGroup === group.key }]"
          @click="activeGroup = group.key"
        >
          <span>{{ group.label }}</span>
          <b class="silver-mono">{{ group.count }}</b>
        </button>
      </div>

      <div v-loading="listLoading" class="candidate-list">
        <article v-for="item in visibleCandidates" :key="item.id" :class="['candidate', { 'is-open': openId === item.id, 'is-dirty': openId === item.id && rowDirty }]">
          <button type="button" class="candidate-head" @click="toggle(item)">
            <span :class="['state-dot', item.is_active === false ? 'is-off' : 'is-on']" aria-hidden="true"></span>
            <span class="candidate-name">{{ item.name || '未命名配置' }}</span>
            <span class="candidate-type">{{ serviceLabel(item.service_type) }}</span>
            <span class="candidate-url silver-mono">{{ item.base_url || '缺少 Base URL' }}</span>
            <span class="candidate-model silver-mono">{{ item.default_model || (item.model || [])[0] || '—' }}</span>
            <span v-if="item.is_default" class="flag-default">默认</span>
            <span class="candidate-priority silver-mono">P{{ item.priority ?? 0 }}</span>
            <el-icon class="candidate-caret"><ArrowDown /></el-icon>
          </button>

          <div v-if="openId === item.id" class="candidate-editor">
            <div class="editor-grid">
              <label class="field">
                <span>显示名</span>
                <el-input v-model="draft.name" placeholder="例如：银子 API · 文本" />
              </label>
              <label class="field">
                <span>Base URL</span>
                <el-input v-model="draft.base_url" placeholder="https://api.yinziapi.top/v1" />
              </label>
              <label class="field">
                <span>默认模型</span>
                <el-input v-model="draft.default_model" placeholder="必须出现在下面的候选模型里" />
              </label>
              <label class="field">
                <span>优先级（数字越大越先被选）</span>
                <el-input-number v-model="draft.priority" :min="0" :max="999" controls-position="right" />
              </label>
              <label class="field field-wide">
                <span>候选模型（逗号或换行分隔）</span>
                <el-input v-model="draft.modelText" type="textarea" :rows="2" placeholder="每行一个模型名，第一个会被当作默认" />
              </label>
              <label class="field field-wide">
                <span>用途标签（逗号或换行分隔，只帮助选择，不发给上游）</span>
                <el-input v-model="draft.useCasesText" placeholder="剧本、研究、分镜、字幕" />
              </label>
              <label class="field field-wide">
                <span>备注</span>
                <el-input v-model="draft.note" type="textarea" :rows="2" maxlength="500" show-word-limit placeholder="写给自己看：这条适合做什么、有什么坑" />
              </label>
            </div>

            <div class="editor-switches">
              <label><span>启用</span><el-switch v-model="draft.is_active" /></label>
              <label><span>设为该类型的默认</span><el-switch v-model="draft.is_default" /></label>
              <span class="switch-hint">同一服务类型只能有一条默认配置，改动它在保存时生效。</span>
            </div>

            <div class="key-box">
              <div class="key-line">
                <span>API Key</span>
                <code class="silver-mono">{{ item.has_api_key ? (keyShown === item.id ? maskedHint : maskedKey) : '未填写' }}</code>
                <el-button v-if="item.has_api_key" link @click="toggleKey(item)">{{ keyShown === item.id ? '收起' : '显示' }}</el-button>
                <small>Key 不回显明文，显示按钮只展示掩码状态，避免截图和日志带出密钥。</small>
              </div>
              <div class="key-replace">
                <el-input v-model="draft.api_key" type="password" show-password autocomplete="new-password" :placeholder="item.has_api_key ? '留空 = 保持现有 Key 不变' : '粘贴新的 API Key'" />
                <el-button :disabled="!draft.api_key?.trim()" @click="testReplacementKey(item)">用这把新 Key 测试</el-button>
              </div>
            </div>

            <div class="editor-actions">
              <el-button :icon="Connection" :loading="testingId === item.id" @click="confirmTest(item)">测试连接</el-button>
              <el-button v-if="rowDirty" @click="discard(item)">放弃改动</el-button>
              <span class="spacer"></span>
              <span v-if="rowDirty" class="dirty-hint">有未保存的改动</span>
              <el-button type="primary" :loading="savingId === item.id" :disabled="!rowDirty" @click="saveRow(item)">保存这条</el-button>
            </div>
          </div>
        </article>

        <div v-if="!listLoading && !visibleCandidates.length" class="candidate-empty">
          <p v-if="!candidates.length">这里还没有任何模型配置。先配一条文本模型就能开始写剧本，其它类型可以之后再加。</p>
          <p v-else>当前分组和搜索词下没有配置。换个分组看看，或清空搜索。</p>
          <div class="empty-actions">
            <el-button type="primary" @click="openYinziSetup">一键配置银子 API</el-button>
            <el-button @click="openFullConfig('configs')">打开完整配置表</el-button>
            <el-button v-if="candidates.length" @click="search = ''; activeGroup = 'all'">清空筛选</el-button>
          </div>
        </div>
      </div>
    </section>

    <!-- ── 推荐接入路径 ──────────────────────────────────────── -->
    <section class="cfg-panel yinzi-panel">
      <div class="panel-head">
        <div>
          <h2>推荐的银子 API 配置路径</h2>
          <p>没有渠道时从银子 API 开始最省事：文本走 api.yinziapi.top，图片与视频走媒体站。三条各自独立保存 URL、Key 和模型，不要用智能路由 Key。</p>
        </div>
        <el-button type="primary" :icon="MagicStick" @click="openYinziSetup">一键配置银子 API</el-button>
      </div>
      <div class="endpoint-grid">
        <div>
          <span>文本 / 对话</span>
          <code class="silver-mono">https://api.yinziapi.top/v1</code>
        </div>
        <div>
          <span>图片 · 分镜图 · 视频</span>
          <code class="silver-mono">https://image.yinziapi.top/v1</code>
        </div>
        <div>
          <span>站点与教程</span>
          <span class="endpoint-links">
            <a href="https://yinziapi.top/" target="_blank" rel="noopener noreferrer">yinziapi.top</a>
            <a href="https://yinziapi.top/guide/" target="_blank" rel="noopener noreferrer">新手教程</a>
            <a href="https://yinziapi.top/guide/codex/" target="_blank" rel="noopener noreferrer">Codex 安装</a>
          </span>
        </div>
      </div>
    </section>

    <!-- ── 完整配置表：既有功能原样保留 ───────────────────────── -->
    <section class="cfg-panel full-panel">
      <div class="panel-head">
        <div>
          <h2>完整配置表</h2>
          <p>新增、删除、导入导出、模型能力与 SD2 资产都在这里。测试连接的按钮与用法保持原样。</p>
        </div>
        <button type="button" class="collapse-toggle" :aria-expanded="fullOpen" @click="fullOpen = !fullOpen">
          {{ fullOpen ? '收起' : '展开' }}
          <el-icon><ArrowDown /></el-icon>
        </button>
      </div>
      <div v-show="fullOpen" ref="fullWrap" class="full-wrap" @click="scheduleSync">
        <AIConfigContent :key="contentKey" :initial-action="contentAction" />
      </div>
    </section>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowDown, Connection, MagicStick, QuestionFilled, Refresh, Search } from '@element-plus/icons-vue'
import AIConfigContent from '@/components/AIConfigContent.vue'
import { aiAPI } from '@/api/ai'
import { getConfigReadiness } from '@/utils/configReadiness'
import { buildDraftConfigTestRequest, buildSavedConfigTestRequest } from '@/utils/aiConfigTest'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'

const route = useRoute()
const router = useRouter()

const MASKED_KEY = '••••••••••••'
const maskedHint = '（已保存，明文不回显）'
const maskedKey = computed(() => `${MASKED_KEY} · 已保存`)

const SERVICE_LABELS = {
  text: '文本',
  image: '图片',
  storyboard_image: '分镜图',
  video: '视频',
  tts: '语音',
  jimeng2_character_auth: '即梦认证',
  model_ark_asset: 'SD2 资产库',
}

const candidates = ref([])
const listLoading = ref(false)
const activeGroup = ref('all')
const search = ref('')
const sortBy = ref('priority')
const openId = ref(null)
const keyShown = ref(null)
const savingId = ref(null)
const testingId = ref(null)
const fullOpen = ref(true)
const fullWrap = ref(null)
const contentKey = ref(0)
const contentAction = ref(String(route.query.action || ''))

const draft = reactive({
  name: '', base_url: '', default_model: '', priority: 0,
  modelText: '', useCasesText: '', note: '', api_key: '',
  is_active: true, is_default: false,
})

const readiness = computed(() => getConfigReadiness(candidates.value))

const groups = computed(() => {
  const order = ['all', 'text', 'image', 'storyboard_image', 'video', 'tts', 'other']
  const labels = { all: '全部', text: '文本', image: '图片', storyboard_image: '分镜图', video: '视频', tts: '语音', other: '认证与资产' }
  const keys = new Set(candidates.value.map((item) => groupOf(item.service_type)))
  return order
    .filter((key) => key === 'all' || keys.has(key))
    .map((key) => ({
      key,
      label: labels[key],
      count: key === 'all' ? candidates.value.length : candidates.value.filter((item) => groupOf(item.service_type) === key).length,
    }))
})

const visibleCandidates = computed(() => {
  const q = search.value.trim().toLowerCase()
  const matchGroup = (item) => activeGroup.value === 'all' || groupOf(item.service_type) === activeGroup.value
  const matchText = (item) => !q || [
    item.name, item.base_url, item.default_model, item.provider, item.note,
    ...(Array.isArray(item.model) ? item.model : []),
    ...(Array.isArray(item.use_cases) ? item.use_cases : []),
  ].some((value) => String(value || '').toLowerCase().includes(q))
  const rows = candidates.value.filter((item) => matchGroup(item) && matchText(item))
  const sorted = [...rows]
  if (sortBy.value === 'name') sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'))
  else if (sortBy.value === 'updated') sorted.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
  else sorted.sort((a, b) => (Number(b.priority ?? 0) - Number(a.priority ?? 0)) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'))
  return sorted
})

function groupOf(type) {
  if (['text', 'image', 'storyboard_image', 'video', 'tts'].includes(type)) return type
  return 'other'
}

function serviceLabel(type) {
  return SERVICE_LABELS[type] || type || '未知类型'
}

function normalizeRow(row) {
  let metadata = row.metadata
  if ((!metadata || typeof metadata !== 'object') && row.metadata_json) {
    try { metadata = JSON.parse(row.metadata_json) } catch (_) { metadata = {} }
  }
  return {
    ...row,
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  }
}

async function loadCandidates() {
  listLoading.value = true
  try {
    const rows = await aiAPI.list()
    candidates.value = (Array.isArray(rows) ? rows : []).map(normalizeRow)
  } catch (_) {
    candidates.value = []
  } finally {
    listLoading.value = false
  }
}

/** 只重读列表，不重建下方完整配置表（避免把别人正在用的标签页顶掉）。 */
async function syncFromTable() {
  await loadCandidates()
  if (openId.value && !candidates.value.some((item) => item.id === openId.value)) openId.value = null
}

let syncTimer = null
function scheduleSync() {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => { syncTimer = null; syncFromTable() }, 1200)
}
onBeforeUnmount(() => { if (syncTimer) clearTimeout(syncTimer) })

async function reloadAll() {
  await loadCandidates()
  // 完整配置表有 dialog、tabs 与本地草稿，整表重建才能确保和上面读到的一致
  contentAction.value = ''
  contentKey.value += 1
  ElMessage.success('已重新读取配置')
}

function openFullConfig() {
  fullOpen.value = true
  nextTick(() => fullWrap.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

function openYinziSetup() {
  fullOpen.value = true
  contentAction.value = 'yinzi'
  contentKey.value += 1
  nextTick(() => fullWrap.value?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

function fillDraft(item) {
  const model = Array.isArray(item.model) ? item.model : (item.model ? [item.model] : [])
  Object.assign(draft, {
    name: item.name || '',
    base_url: item.base_url || '',
    default_model: item.default_model || model[0] || '',
    priority: Number(item.priority ?? 0),
    modelText: model.join('\n'),
    useCasesText: Array.isArray(item.use_cases) ? item.use_cases.join('、') : '',
    note: item.note || '',
    api_key: '',
    is_active: item.is_active !== false,
    is_default: Boolean(item.is_default),
  })
  draftSnapshot.value = JSON.stringify(draft)
}

function toggle(item) {
  if (openId.value === item.id) {
    openId.value = null
    return
  }
  openId.value = item.id
  keyShown.value = null
  fillDraft(item)
}

function toggleKey(item) {
  keyShown.value = keyShown.value === item.id ? null : item.id
  if (keyShown.value) ElMessage.info('明文 Key 从不回显；这里只确认这把 Key 已经保存在本机后端。')
}

function parseModels(text) {
  return String(text || '')
    .split(/[\n,，、]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function discard(item) {
  fillDraft(item)
}

function buildRowPayload(item) {
  const models = parseModels(draft.modelText)
  const payload = {}
  if (draft.name !== (item.name || '')) payload.name = draft.name
  if (draft.base_url !== (item.base_url || '')) payload.base_url = draft.base_url
  if (Number(draft.priority) !== Number(item.priority ?? 0)) payload.priority = Number(draft.priority)
  if (Boolean(draft.is_active) !== (item.is_active !== false)) payload.is_active = Boolean(draft.is_active)
  if (Boolean(draft.is_default) !== Boolean(item.is_default)) payload.is_default = Boolean(draft.is_default)

  const currentModels = Array.isArray(item.model) ? item.model : []
  const modelsChanged = models.join('\u0001') !== currentModels.join('\u0001')
  const currentDefault = String(item.default_model || '').trim()
  const wantedDefault = String(draft.default_model || '').trim() || models[0] || ''
  if (modelsChanged) payload.model = models
  if (wantedDefault !== currentDefault) payload.default_model = wantedDefault

  const note = String(draft.note || '').trim()
  const useCases = String(draft.useCasesText || '').split(/[\n,，、]/).map((value) => value.trim()).filter(Boolean)
  const currentNote = String(item.note || '').trim()
  const currentUseCases = Array.isArray(item.use_cases) ? item.use_cases : []
  if (note !== currentNote || useCases.join('\u0001') !== currentUseCases.join('\u0001')) {
    // 后端会整章替换 metadata，这里必须把已有键一起带上，否则能力提示会丢
    payload.metadata = { ...item.metadata, note, use_cases: useCases }
  }
  if (draft.api_key?.trim()) payload.api_key = draft.api_key.trim()
  return payload
}

async function saveRow(item) {
  const payload = buildRowPayload(item)
  if (!Object.keys(payload).length) {
    ElMessage.info('没有检测到改动')
    return
  }
  if ('model' in payload && !payload.model.length) {
    ElMessage.warning('候选模型不能为空，至少保留一个模型名')
    return
  }
  if ('default_model' in payload && payload.default_model && 'model' in payload && !payload.model.includes(payload.default_model)) {
    ElMessage.warning('默认模型必须出现在候选模型列表里')
    return
  }
  savingId.value = item.id
  try {
    await aiAPI.update(item.id, payload)
    await loadCandidates()
    ElMessage.success(`已保存「${payload.name || item.name || '这条配置'}」`)
  } catch (_) {
    // request 拦截器已统一报错
  } finally {
    savingId.value = null
  }
}

/** 测试连接会真的发一次请求：说清代价后再确认。 */
async function confirmTest(item, draftRequest = null) {
  const models = draftRequest ? parseModels(draft.modelText) : (Array.isArray(item.model) ? item.model : [])
  const target = draftRequest ? `${draft.name || item.name}（这份草稿）` : (item.name || serviceLabel(item.service_type))
  try {
    await ElMessageBox.confirm(
      `测试会带着这条配置的 URL、Key 和模型 ${models[0] || '（未填）'} 向 ${item.base_url || draft.base_url || '上游'} 发一次最小请求：
· 文本服务：只请求 1 个 token 的回复。
· 图片 / 分镜 / 视频服务：只校验 Key 与连通性，不会真的生成图片或视频。
· 少数按 token 计费的站点会因此产生极小费用（通常远小于 0.01 元）。

要继续吗？`,
      `测试连接：${target}`,
      { type: 'warning', confirmButtonText: '发一次请求', cancelButtonText: '取消' },
    )
  } catch (_) {
    return
  }
  testingId.value = item.id
  try {
    const request = draftRequest || buildSavedConfigTestRequest(item)
    const result = await aiAPI.testConnection(request, { suppressGlobalError: true })
    const note = result?.generated_media === false ? '（未生成任何媒体）' : ''
    ElMessage.success(`「${target}」连通 ${note}`)
  } catch (error) {
    ElMessage.error(`测试失败：${error?.message || '未知错误'}。先检查 Base URL 是否以 /v1 结尾、Key 是否有效、模型名是否在该站点目录内。`)
  } finally {
    testingId.value = null
  }
}

/** 用草稿里的新 Key 试一次，不落库，方便在替换 Key 之前确认。 */
async function testReplacementKey(item) {
  const request = buildDraftConfigTestRequest({
    base_url: draft.base_url,
    provider: item.provider,
    api_protocol: item.api_protocol,
    endpoint: item.endpoint,
    service_type: item.service_type,
    modelText: draft.modelText,
    default_model: draft.default_model,
  }, item.id)
  request.api_key = draft.api_key.trim()
  await confirmTest(item, request)
}

useWorkbenchPage({ refresh: async () => { await loadCandidates() }, loading: () => listLoading.value })

// 展开那一行时存一份快照，用来判断「有没有改过」——比逐个字段比对省事，也不会漏掉输入法中间态
const draftSnapshot = ref('')
const rowDirty = computed(() => Boolean(openId.value != null && draftSnapshot.value) && JSON.stringify(draft) !== draftSnapshot.value)

onMounted(loadCandidates)
</script>

<style scoped>
.model-workspace { padding: 0; }

.cfg-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; padding: 0 0 18px; border-bottom: 1px solid var(--border-color); }
.cfg-intro h1 { margin: 0; font-size: clamp(22px, 2.6vw, 30px); font-weight: 600; }
.cfg-intro p { max-width: 74ch; margin: 10px 0 0; color: var(--text-muted); font-size: 13px; line-height: 1.8; }
.cfg-intro-actions { flex-shrink: 0; display: flex; gap: 8px; }

.cfg-readiness { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)) 132px; gap: 1px; margin: 18px 0 22px; background: var(--border-color); border: 1px solid var(--border-color); }
.readiness-item { display: flex; align-items: center; gap: 9px; padding: 12px 14px; background: var(--bg-card); }
.readiness-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ui-warning); }
.readiness-item.is-ready .readiness-dot { background: var(--ui-success); }
.readiness-item strong { display: block; font-size: 12.5px; font-weight: 600; }
.readiness-item small { display: block; margin-top: 3px; overflow: hidden; color: var(--text-subtle); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
.readiness-total { display: grid; align-content: center; gap: 3px; padding: 12px 14px; background: var(--bg-inner); }
.readiness-total strong { font-size: 18px; color: var(--text-bright); }
.readiness-total small { color: var(--text-subtle); font-size: 11px; }

.cfg-panel { margin-bottom: 20px; border: 1px solid var(--border-color); background: var(--bg-card); }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 18px 20px; border-bottom: 1px solid var(--border-color); }
.panel-head h2 { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 600; }
.panel-head p { max-width: 78ch; margin: 7px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.panel-head-tools { flex-shrink: 0; display: flex; gap: 8px; }
.cfg-search { width: 220px; }
.cfg-sort { width: 132px; }

.group-tabs { display: flex; flex-wrap: wrap; gap: 0; padding: 0 20px; border-bottom: 1px solid var(--border-color); }
.group-tab { display: inline-flex; align-items: center; gap: 7px; padding: 11px 13px; border: 0; border-bottom: 1px solid transparent; margin-bottom: -1px; color: var(--text-subtle); background: none; font: inherit; font-size: 12.5px; cursor: pointer; }
.group-tab:hover { color: var(--text-bright); }
.group-tab.active { color: var(--text-bright); border-bottom-color: var(--ui-accent); }
.group-tab b { color: var(--text-subtle); font-size: 11px; font-weight: 500; }

.candidate-list { padding: 0; }
.candidate { border-bottom: 1px solid var(--border-muted); }
.candidate:last-child { border-bottom: 0; }
.candidate.is-open { background: var(--bg-inner); }
.candidate-head { width: 100%; display: grid; grid-template-columns: 10px minmax(120px, 1.1fr) 62px minmax(150px, 1.6fr) minmax(110px, 1fr) 46px 40px 18px; align-items: center; gap: 12px; padding: 13px 20px; border: 0; color: inherit; background: none; text-align: left; font: inherit; cursor: pointer; }
.candidate-head:hover { background: var(--bg-hover); }
.state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ui-success); }
.state-dot.is-off { background: var(--text-faint); }
.candidate-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.candidate-type { color: var(--text-subtle); font-size: 11px; }
.candidate-url, .candidate-model { overflow: hidden; color: var(--text-muted); font-size: 11.5px; text-overflow: ellipsis; white-space: nowrap; }
.candidate-priority { color: var(--text-subtle); font-size: 11px; text-align: right; }
.flag-default { color: var(--text-bright); font-size: 11px; }
.candidate-caret { color: var(--text-faint); font-size: 13px; transition: transform .18s cubic-bezier(.22, .61, .36, 1); }
.candidate.is-open .candidate-caret { transform: rotate(180deg); }
.candidate.is-dirty .candidate-name::after { content: ' · 未保存'; color: var(--ui-warning); font-weight: 400; font-size: 11px; }

.candidate-editor { display: grid; gap: 16px; padding: 4px 20px 20px; border-top: 1px solid var(--border-color); }
.editor-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; padding-top: 16px; }
.field { display: grid; gap: 6px; }
.field-wide { grid-column: 1 / -1; }
.field > span { color: var(--text-subtle); font-size: 11.5px; }
.field :deep(.el-input-number) { width: 100%; }
.editor-switches { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 26px; padding: 12px 14px; background: var(--bg-card); border: 1px solid var(--border-color); }
.editor-switches label { display: inline-flex; align-items: center; gap: 10px; font-size: 12px; }
.switch-hint { color: var(--text-subtle); font-size: 11px; }

.key-box { display: grid; gap: 10px; padding: 13px 14px; border: 1px solid var(--border-color); background: var(--bg-card); }
.key-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 10px; }
.key-line > span { color: var(--text-subtle); font-size: 11.5px; }
.key-line code { padding: 3px 7px; color: var(--text-primary); background: var(--bg-inner); font-size: 11.5px; letter-spacing: .04em; }
.key-line small { flex: 1 1 260px; color: var(--text-subtle); font-size: 11px; }
.key-replace { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }

.editor-actions { display: flex; align-items: center; gap: 8px; }
.editor-actions .spacer { flex: 1; }
.dirty-hint { color: var(--ui-warning); font-size: 11.5px; }

.candidate-empty { padding: 30px 20px; display: grid; gap: 12px; justify-items: start; }
.candidate-empty p { margin: 0; color: var(--text-muted); font-size: 12.5px; }
.empty-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.endpoint-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.endpoint-grid > div { display: grid; gap: 7px; padding: 16px 20px; border-right: 1px solid var(--border-muted); }
.endpoint-grid > div:last-child { border-right: 0; }
.endpoint-grid span { color: var(--text-subtle); font-size: 11.5px; }
.endpoint-grid code { color: var(--text-bright); font-size: 12px; overflow-wrap: anywhere; }
.endpoint-links { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.endpoint-links a { color: var(--text-primary); text-decoration: underline; text-underline-offset: 3px; font-size: 12px; }

.collapse-toggle { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border: 1px solid var(--border-color); color: var(--text-subtle); background: none; font: inherit; font-size: 12px; cursor: pointer; }
.collapse-toggle:hover { color: var(--text-bright); border-color: var(--border-bright); }
.full-wrap { padding: 4px 20px 20px; }

/* 完整配置表：只把语义不对的颜色收回来，结构与功能一律不动 */
.full-wrap :deep(.el-button--success),
.full-wrap :deep(.el-button--info) { --el-button-bg-color: transparent; --el-button-text-color: var(--text-primary); --el-button-border-color: var(--border-color); --el-button-hover-bg-color: var(--bg-hover); --el-button-hover-text-color: var(--text-bright); --el-button-hover-border-color: var(--border-bright); }
.full-wrap :deep(.el-button--warning) { --el-button-bg-color: transparent; --el-button-text-color: var(--ui-warning); --el-button-border-color: var(--border-color); }
.full-wrap :deep(.el-tab-pane .tab-content) { max-height: none; }
.full-wrap :deep(.el-alert) { border: 1px solid var(--border-color); background: var(--bg-inner); }
/* 外层已经是面板，内层不要再叠一层卡片 */
.full-wrap :deep(.ai-config-content) { padding: 0; border: 0; border-radius: 0; background: transparent; }

@media (max-width: 1100px) {
  .cfg-readiness { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .readiness-total { grid-column: 1 / -1; }
  .candidate-head { grid-template-columns: 10px minmax(0, 1.2fr) 56px minmax(0, 1.4fr) 40px 18px; }
  .candidate-model, .flag-default { display: none; }
  .endpoint-grid { grid-template-columns: 1fr; }
  .endpoint-grid > div { border-right: 0; border-bottom: 1px solid var(--border-muted); }
}

@media (max-width: 760px) {
  .cfg-intro, .panel-head { flex-direction: column; align-items: stretch; }
  .panel-head-tools { flex-direction: column; }
  .cfg-search, .cfg-sort { width: 100%; }
  .editor-grid { grid-template-columns: 1fr; }
  .candidate-head { grid-template-columns: 10px minmax(0, 1fr) 40px 18px; }
  .candidate-type, .candidate-url, .candidate-priority { display: none; }
  .key-replace { grid-template-columns: 1fr; }
}
</style>
