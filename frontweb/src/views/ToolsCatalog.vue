<template>
  <div class="workbench-view">
    <div class="catalog-page">
      <!-- 这一页在管什么 -->
      <section class="scope-note" aria-label="这一页在管什么">
        <p>
          这一页是能力清单，不是执行入口：这里能查「本机到底装了哪些工具、各自要什么输入、会不会花钱」，
          以及注册、启停、导入导出社区工具。真正让工具跑起来要在任务里由 Codex 选择。
          停用某个工具只影响之后的新计划，正在跑的任务照旧。
        </p>
        <div class="tool-actions">
          <el-button size="small" @click="experiencesOpen = true">制作经验</el-button>
          <el-button size="small" @click="toolOptionsOpen = true">探索制作方案</el-button>
          <el-button size="small" @click="transitionsOpen = true">转场预览</el-button>
        </div>
      </section>

      <section class="catalog-hero">
        <div>
          <span class="kicker">你只需要说想完成什么</span>
          <h2>Codex 从这张目录里自己组合工具</h2>
          <p>每个工具在目录里写成一合同：需要什么输入、产出什么、在哪台机器上跑、会不会联网或花钱。需要人工处理的模块会明确标出来。</p>
        </div>
        <div class="catalog-count" aria-live="polite">
          <strong class="num">{{ inventory?.builtin_modules ?? items.length }}</strong>
          <span>个内置能力模块</span>
          <span v-if="hasFilter" class="filter-count num">当前筛选 {{ filtered.length }} 项</span>
        </div>
      </section>

      <details class="research-fold">
        <summary>商品视频研究（这一页也能开研究，展开使用）</summary>
        <ProductResearchPanel :modules="items" />
      </details>

      <dl v-if="inventory" class="inventory-strip" aria-label="完整能力目录统计">
        <div><dt>本地执行合同</dt><dd class="num">{{ inventory.local_operation_contracts }}</dd></div>
        <div><dt>其他内置模块</dt><dd class="num">{{ inventory.other_builtin_modules }}</dd></div>
        <div><dt>研究候选</dt><dd class="num">{{ inventory.research_candidates }}</dd></div>
        <div><dt>转场选项</dt><dd class="num">{{ inventory.transition_options }}</dd></div>
        <div><dt>组件包</dt><dd class="num">{{ inventory.component_packages }}</dd></div>
        <div><dt>当前源码 Windows 小样</dt><dd class="num">{{ inventory.windows_source_matching_fixtures }}</dd></div>
      </dl>

      <section v-if="runtimeProfile" class="runtime-banner">
        <div class="runtime-head">
          <strong>本机运行环境：{{ runtimeProfile.machine?.platform }} / {{ runtimeProfile.machine?.arch }}</strong>
          <p class="num">CPU {{ runtimeProfile.machine?.cpu_count || '?' }} 核 · 内存 {{ runtimeProfile.machine?.memory_gib || '?' }} GiB</p>
          <small v-if="profileUpdatedAt" class="num">最近同步 {{ profileUpdatedAt }}</small>
        </div>
        <div class="component-list" aria-live="polite">
          <div v-for="component in runtimeComponents" :key="component.component_id" :class="['component-state', component.display.status]">
            <div class="component-heading">
              <strong>{{ componentLabel(component.component_id) }}</strong>
              <span class="component-status"><i class="dot" aria-hidden="true"></i>{{ component.display.label }}</span>
            </div>
            <el-progress v-if="component.display.percent != null" :percentage="component.display.percent" :stroke-width="5" />
            <p v-if="component.display.detail">{{ component.display.detail }}</p>
            <small v-if="component.installed && component.display.status !== 'ready'" class="num">已保留版本 {{ component.installed_version }}</small>
          </div>
        </div>
      </section>
      <el-alert v-if="profileError" :title="profileError" type="warning" show-icon :closable="false" />

      <section class="panel filters">
        <el-input v-model="query" clearable placeholder="搜索：图片、视频、剪辑、Blender、字幕…" class="search" />
        <el-select v-model="track" class="filter-select" aria-label="版本轨道">
          <el-option v-for="option in trackOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-select v-model="costFilter" class="filter-select" aria-label="费用筛选">
          <el-option label="全部费用类型" value="all" />
          <el-option label="可能产生费用" value="paid" />
          <el-option label="本地或不花钱" value="free" />
        </el-select>
        <el-select v-model="stateFilter" class="filter-select" aria-label="可用性筛选">
          <el-option label="全部可用性" value="all" />
          <el-option v-for="option in availabilityOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-select v-model="sortBy" class="filter-select" aria-label="排序方式">
          <el-option label="目录顺序" value="default" />
          <el-option label="按名称" value="title" />
          <el-option label="按阶段" value="phase" />
        </el-select>
        <el-select v-model="pageSize" class="filter-select" aria-label="每页数量">
          <el-option v-for="size in PAGE_SIZES" :key="size" :label="`每页 ${size} 项`" :value="size" />
        </el-select>
        <div class="tool-actions">
          <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onImportFile" />
          <el-button size="small" plain @click="openEditor()">新增工具</el-button>
          <el-button size="small" plain @click="fileInput?.click()">导入工具包</el-button>
          <el-button size="small" plain @click="exportTools">导出我的工具</el-button>
          <el-button size="small" text :loading="loading" @click="load">刷新</el-button>
        </div>
      </section>

      <section class="catalog-bar" aria-label="阶段分类">
        <button
          v-for="option in phaseFilters"
          :key="option.value"
          type="button"
          :class="['phase-chip', { active: phase === option.value }]"
          @click="phase = option.value"
        >
          {{ option.label }}<span class="num">{{ option.count }}</span>
        </button>
      </section>

      <div class="result-line">
        <span class="num">共 {{ filtered.length }} 项{{ paged.length !== filtered.length ? `，本页显示 ${paged.length}` : '' }}</span>
        <span v-if="track || costFilter !== 'all' || stateFilter !== 'all' || phase || query">筛选：{{ activeFilters }}</span>
        <span v-if="paidCount" class="paid-note">{{ paidCount }} 个工具可能产生费用</span>
      </div>

      <el-alert v-if="error" class="catalog-error" type="error" show-icon :closable="false">
        <template #title>工具目录读取失败：{{ error }}</template>
        <div class="error-detail">目录来自本地后端 <span class="num">/api/v1/orchestration-modules</span>。先确认后端在运行，再点右上「刷新」。已导入的社区工具如果被删过，可以用之前导出的工具包恢复。</div>
        <el-button size="small" @click="load">重试</el-button>
      </el-alert>

      <section class="catalog-grid">
        <article v-for="item in paged" :key="item.module_id" class="module-card">
          <header>
            <span class="phase-tag">{{ phaseLabel(item.phase) }}</span>
            <span :class="['state-tag', `is-${availabilityTone(item.availability)}`]"><i class="dot" aria-hidden="true"></i>{{ availabilityLabel(item.availability) }}</span>
          </header>
          <h3>{{ item.title || item.module_id }}</h3>
          <code>{{ item.module_id }}</code>
          <p class="desc">{{ item.description_zh || item.description }}</p>
          <p v-if="item.example" class="example">例如：{{ item.example }}</p>

          <dl class="spec">
            <dt>需要</dt>
            <dd><span v-for="input in item.inputs || []" :key="input">{{ input }}</span><em v-if="!(item.inputs || []).length">未声明</em></dd>
            <dt>产出</dt>
            <dd><span v-for="output in item.outputs || []" :key="output">{{ output }}</span><em v-if="!(item.outputs || []).length">未声明</em></dd>
            <dt>执行者</dt>
            <dd>{{ item.executor ? executorLabel(item.executor) : '未声明' }}</dd>
            <dt>费用</dt>
            <dd :class="item.side_effects?.paid ? 'is-paid' : 'is-free'">{{ costLabel(item) }}</dd>
          </dl>

          <details class="more">
            <summary>技术合同与副作用</summary>
            <dl class="spec spec-tight">
              <dt>写入</dt>
              <dd>{{ sideEffectLabel(item) }}</dd>
              <dt>幂等键</dt>
              <dd class="quote">{{ item.idempotency || '未声明' }}</dd>
              <dt>未知输入</dt>
              <dd>{{ item.unknown_input_policy || '未声明' }}</dd>
              <dt>恢复方式</dt>
              <dd class="quote">{{ item.recovery || '未声明' }}</dd>
            </dl>
            <details v-if="parameterList(item).length" class="params">
              <summary>可配置参数（{{ parameterList(item).length }}）</summary>
              <dl class="spec spec-tight">
                <dt v-for="param in parameterList(item)" :key="param.name">{{ param.name }}</dt>
                <dd v-for="param in parameterList(item)" :key="`${param.name}-v`">{{ param.text }}</dd>
              </dl>
            </details>
            <p v-else class="no-params">这份合同没有声明可调参数；运行参数由 Codex 在任务里组合。</p>
          </details>

          <footer>
            <span v-if="item.component_id">组件：{{ componentLabel(item.component_id) }}</span>
            <span v-if="item.validation_status === 'verified_windows_fixture'">Windows 样本实测</span>
            <span v-if="item.auto_install">缺少时自动准备</span>
            <span v-if="item.registered" class="custom-tool">社区工具</span>
            <span v-if="item.enabled === false" class="disabled-tool">已停用，Codex 不会选它</span>
            <div class="card-actions">
              <el-button v-if="item.registered" size="small" text @click="openEditor(item)">编辑</el-button>
              <el-button v-if="item.registered" size="small" text @click="toggleTool(item)">{{ item.enabled === false ? '启用' : '停用' }}</el-button>
              <el-button v-if="item.registered" size="small" text type="danger" @click="removeTool(item)">删除</el-button>
            </div>
          </footer>
        </article>
      </section>

      <div v-if="filtered.length > pageSize" class="catalog-pager">
        <el-pagination v-model:current-page="page" :page-size="pageSize" :total="filtered.length" layout="total, prev, pager, next" />
      </div>

      <div v-if="!loading && !filtered.length" class="empty">
        <template v-if="items.length">
          <strong>当前筛选下没有模块</strong>
          <p>把阶段、版本轨道或费用筛选改回「全部」，或清空搜索词。</p>
          <el-button size="small" @click="clearFilters">清除全部筛选</el-button>
        </template>
        <template v-else>
          <strong>还没有读到任何工具模块</strong>
          <p>你仍然可以直接向 Codex 描述目标，它会把未知需求保留在计划中并说明下一步。也可以先点「刷新」重试读取。</p>
          <el-button size="small" :loading="loading" @click="load">刷新目录</el-button>
        </template>
      </div>
    </div>

    <MediaExperiencePanel v-model:open="experiencesOpen" />
    <MediaToolOptionsPanel v-model:open="toolOptionsOpen" />
    <TransitionGallery v-model:open="transitionsOpen" :options="transitionOptions" />

    <el-dialog v-model="editorVisible" :title="editingId ? '编辑工具' : '新增工具'" width="min(640px, calc(100vw - 28px))" destroy-on-close>
      <el-form label-position="top" @submit.prevent="saveTool">
        <div class="tool-form-grid">
          <el-form-item label="工具编号"><el-input v-model="form.module_id" :disabled="Boolean(editingId)" placeholder="例如 community.storyboard" /></el-form-item>
          <el-form-item label="名称"><el-input v-model="form.title" placeholder="给用户看的名称" /></el-form-item>
          <el-form-item label="版本轨道"><el-input v-model="form.version_track" placeholder="custom" /></el-form-item>
          <el-form-item label="阶段">
            <el-select v-model="form.phase"><el-option v-for="value in PHASES" :key="value" :label="phaseLabel(value)" :value="value" /></el-select>
          </el-form-item>
          <el-form-item label="执行者">
            <el-select v-model="form.executor"><el-option v-for="value in ['codex','local','provider','manual']" :key="value" :label="executorLabel(value)" :value="value" /></el-select>
          </el-form-item>
          <el-form-item label="可用性">
            <el-select v-model="form.availability"><el-option v-for="value in ['integrated','bridge','advisory']" :key="value" :label="availabilityLabel(value)" :value="value" /></el-select>
          </el-form-item>
        </div>
        <el-form-item label="说明"><el-input v-model="form.description_zh" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="输入 / 输出"><el-input v-model="form.inputs" placeholder="输入字段，用逗号分隔" /><el-input v-model="form.outputs" class="form-output" placeholder="输出字段，用逗号分隔" /></el-form-item>
        <el-form-item label="示例"><el-input v-model="form.example" /></el-form-item>
        <el-checkbox v-model="form.enabled">允许 Codex 选择此工具</el-checkbox>
        <p class="form-note">保存后立刻出现在目录里。停用不会删除合同，重新启用即可恢复。</p>
      </el-form>
      <template #footer><el-button @click="editorVisible = false">取消</el-button><el-button type="primary" @click="saveTool">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { componentStatus } from '@/utils/componentStatus'
import orchestrationAPI from '@/api/orchestration'
import MediaExperiencePanel from '@/components/MediaExperiencePanel.vue'
import MediaToolOptionsPanel from '@/components/MediaToolOptionsPanel.vue'
import TransitionGallery from '@/components/TransitionGallery.vue'
import ProductResearchPanel from '@/components/ProductResearchPanel.vue'

const PHASES = ['intake', 'analyze', 'research', 'plan', 'create', 'edit', 'qa', 'deliver']
const PAGE_SIZES = [12, 24, 48, 96, 200]
const FILTER_KEY = 'yinzi-tools-catalog-filters'
const transitionsOpen = ref(false)
const toolOptionsOpen = ref(false)
const experiencesOpen = ref(false)
const items = ref([]); const query = ref(''); const track = ref(''); const loading = ref(false); const error = ref(''); const fileInput = ref(null); const runtimeProfile = ref(null)
const inventory = ref(null)
const editorVisible = ref(false); const editingId = ref('')
const profileError = ref(''); const profileUpdatedAt = ref('')

/* 手动可控的筛选：可记住、可一键清空 */
function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null')
    if (!saved) return
    track.value = typeof saved.track === 'string' ? saved.track : ''
    phase.value = PHASES.includes(saved.phase) ? saved.phase : ''
    costFilter.value = ['all', 'paid', 'free'].includes(saved.cost) ? saved.cost : 'all'
    stateFilter.value = ['all', 'integrated', 'bridge', 'advisory'].includes(saved.state) ? saved.state : 'all'
    sortBy.value = ['default', 'title', 'phase'].includes(saved.sort) ? saved.sort : 'default'
    pageSize.value = PAGE_SIZES.includes(Number(saved.pageSize)) ? Number(saved.pageSize) : 12
  } catch (_) { /* 存坏了就按默认 */ }
}
const phase = ref('')
const costFilter = ref('all')
const stateFilter = ref('all')
const sortBy = ref('default')
const pageSize = ref(12)
const page = ref(1)
loadFilters()
function saveFilters() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify({ track: track.value, phase: phase.value, cost: costFilter.value, state: stateFilter.value, sort: sortBy.value, pageSize: pageSize.value })) } catch (_) { /* 隐私模式忽略 */ }
}
watch([query, track, phase, costFilter, stateFilter, sortBy, pageSize], () => { page.value = 1; saveFilters() })

const transitionOptions = computed(() => items.value.find(item => item.module_id === 'local.video.compose-clips')?.transition_options || [])
const runtimeComponents = computed(() => (runtimeProfile.value?.components || []).map(item => ({ ...item, display: componentStatus(item) })))
const form = reactive({ module_id:'', title:'', description_zh:'', version_track:'custom', phase:'create', executor:'codex', availability:'bridge', inputs:'', outputs:'', example:'', enabled:true })

const trackOptions = computed(() => {
  const tracks = [...new Set(items.value.map(item => item.version_track).filter(Boolean))].sort()
  return [{ value: '', label: '全部版本轨道' }, ...tracks.map(value => ({ value, label: trackLabel(value) }))]
})
const availabilityOptions = [
  { value: 'integrated', label: '已接入（本机直接跑）' },
  { value: 'bridge', label: 'Codex 调用' },
  { value: 'advisory', label: '规划参考' },
]
const hasFilter = computed(() => Boolean(query.value || track.value || phase.value || costFilter.value !== 'all' || stateFilter.value !== 'all'))
const activeFilters = computed(() => [
  query.value ? `关键词「${query.value}」` : '',
  track.value ? trackLabel(track.value) : '',
  phase.value ? phaseLabel(phase.value) : '',
  costFilter.value === 'paid' ? '可能产生费用' : costFilter.value === 'free' ? '本地或不花钱' : '',
  stateFilter.value !== 'all' ? availabilityLabel(stateFilter.value) : '',
].filter(Boolean).join(' · '))

const matched = computed(() => items.value.filter((item) => {
  if (track.value && item.version_track !== track.value) return false
  if (phase.value && item.phase !== phase.value) return false
  if (costFilter.value === 'paid' && item.side_effects?.paid !== true) return false
  if (costFilter.value === 'free' && item.side_effects?.paid === true) return false
  if (stateFilter.value !== 'all' && item.availability !== stateFilter.value) return false
  if (query.value) {
    const haystack = `${item.module_id} ${item.title} ${item.description_zh} ${item.description} ${item.phase} ${(item.inputs || []).join(' ')} ${(item.outputs || []).join(' ')}`
    if (!haystack.toLowerCase().includes(query.value.toLowerCase())) return false
  }
  return true
}))
const filtered = computed(() => {
  if (sortBy.value === 'default') return matched.value
  const pick = sortBy.value === 'title'
    ? (a, b) => String(a.title || a.module_id).localeCompare(String(b.title || b.module_id), 'zh-CN')
    : (a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || String(a.title || '').localeCompare(String(b.title || ''), 'zh-CN')
  return [...matched.value].sort(pick)
})
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
const paidCount = computed(() => filtered.value.filter(item => item.side_effects?.paid).length)
const phaseFilters = computed(() => {
  const counts = new Map()
  for (const item of items.value) counts.set(item.phase, (counts.get(item.phase) || 0) + 1)
  return [
    { value: '', label: '全部阶段', count: items.value.length },
    ...PHASES.filter(value => counts.has(value)).map(value => ({ value, label: phaseLabel(value), count: counts.get(value) })),
  ]
})
function clearFilters() { query.value = ''; track.value = ''; phase.value = ''; costFilter.value = 'all'; stateFilter.value = 'all'; sortBy.value = 'default' }

function phaseLabel(value) { return ({ intake: '准备', analyze: '分析', research: '研究', plan: '计划', create: '创作', edit: '剪辑', qa: '检查', deliver: '交付' })[value] || value || '其他' }
function trackLabel(value) { return ({ V1: 'V1 基础', V2: 'V2 研究', V3: 'V3 媒体', V4: 'V4 扩展', V5: 'V5 本地处理', custom: '自定义' })[value] || value }
function availabilityLabel(value) { return ({ integrated: '已接入', bridge: 'Codex 调用', advisory: '规划参考' })[value] || value || '未知' }
function availabilityTone(value) { return value === 'integrated' ? 'ready' : value === 'advisory' ? 'advisory' : 'bridge' }
function executorLabel(value) { return ({ local: '本机', provider: '模型服务', codex: 'Codex', manual: '你或 Codex' })[value] || value }
/* 费用只说合同里写的事实 */
function costLabel(item) {
  const effects = item.side_effects || {}
  if (effects.paid) return `可能产生费用（${executorLabel(item.executor || '')}）`
  if (effects.network) return '不直接计费，但会联网'
  return '本地执行，不产生费用'
}
/* 副作用写成中文，让用户知道点下去会动什么 */
function sideEffectLabel(item) {
  const effects = item.side_effects || {}
  const parts = []
  if (effects.filesystem_write) parts.push('写本地文件')
  if (effects.database_write) parts.push('写数据库')
  if (effects.network) parts.push('联网')
  if (effects.external_write) parts.push('写外部平台')
  if (!parts.length) return '不写文件、不联网'
  return parts.join('、')
}
/* 参数：合同里的 parameter_schema 优先，退回 parameters */
function parameterList(item) {
  const schema = item.parameter_schema
  if (schema && typeof schema === 'object') {
    const properties = schema.properties || {}
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const rows = Object.entries(properties).map(([name, spec]) => ({
      name: `${name}${required.has(name) ? '（必填）' : ''}`,
      text: [spec?.type, spec?.description || spec?.title].filter(Boolean).join(' · ') || '未写说明',
    }))
    if (rows.length) return rows
  }
  const params = item.parameters
  if (!params || typeof params !== 'object') return []
  return Object.entries(params).map(([name, value]) => ({
    name,
    text: typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value),
  }))
}
function componentLabel(value) { return ({ 'media.ffmpeg':'FFmpeg 媒体处理', 'media.sharp':'Sharp 图像处理', 'vision.realesrgan':'Real-ESRGAN 图片超分', 'vision.ocr':'图片文字识别', 'document.pdf':'PDF 文档处理', 'vision.sky-seg':'天空识别与换天', 'vision.face-detector':'人脸检测与局部处理', 'media.whisper':'离线语音识别与字幕', 'vision.foreground-seg':'主体识别与透明抠图', 'tool.yt-dlp':'素材下载与恢复' })[value] || value }

async function refreshProfile() {
  try {
    const profile = await orchestrationAPI.componentProfile()
    if (!Array.isArray(profile?.components) || !profile.machine) throw Error('运行环境响应不完整')
    runtimeProfile.value = profile; profileError.value = ''; profileUpdatedAt.value = new Date().toLocaleTimeString()
  } catch (_) { profileError.value = runtimeProfile.value ? '组件状态暂时无法更新，当前显示上次同步结果' : '暂时无法读取本机组件状态，正在重试' }
}
const profileRefresh = useLiveRefresh(refreshProfile, { active: () => runtimeComponents.value.some(item => item.display.active), failed: () => Boolean(profileError.value), interval: 1500, idle: 8000 })
async function loadModules() { loading.value = true; error.value = ''; try { const data = await orchestrationAPI.modules({ include_disabled: true }); items.value = data?.items || []; inventory.value = data?.inventory || null } catch (e) { error.value = e?.message || '暂时无法读取工具目录' } finally { loading.value = false } }
async function load() { await Promise.all([loadModules(), profileRefresh.refresh()]) }
function resetForm(item = null) { editingId.value = item?.module_id || ''; Object.assign(form, { module_id:item?.module_id || '', title:item?.title || '', description_zh:item?.description_zh || item?.description || '', version_track:item?.version_track || 'custom', phase:item?.phase || 'create', executor:item?.executor || 'codex', availability:item?.availability || 'bridge', inputs:(item?.inputs || []).join(', '), outputs:(item?.outputs || []).join(', '), example:item?.example || '', enabled:item?.enabled !== false }) }
function openEditor(item = null) { resetForm(item); editorVisible.value = true }
function splitList(value) { return String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean).slice(0, 60) }
async function saveTool() { const payload = { ...form, module_id:form.module_id.trim(), inputs:splitList(form.inputs), outputs:splitList(form.outputs), enabled:form.enabled }; if (!payload.module_id || !payload.title || !payload.description_zh) { ElMessage.warning('请填写工具编号、名称和说明'); return } try { if (editingId.value) await orchestrationAPI.updateModule(editingId.value, payload); else await orchestrationAPI.registerModule(payload); editorVisible.value = false; await load(); ElMessage.success(editingId.value ? '工具已更新' : '工具已添加') } catch (error) { ElMessage.error(error?.message || '保存工具失败；编号可能已被占用') } }
async function onImportFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  try {
    const payload = JSON.parse(await file.text())
    const result = await orchestrationAPI.importModules(payload)
    ElMessage.success(`导入完成：新增 ${result.added?.length || 0}，更新 ${result.updated?.length || 0}，跳过 ${result.skipped?.length || 0}`)
    if (result.errors?.length) ElMessage.warning(`有 ${result.errors.length} 条合同未导入，请检查格式`)
    await load()
  } catch (error) { ElMessage.error(error?.message || '工具包不是有效的 JSON 合同') }
}
async function exportTools() {
  try {
    const payload = await orchestrationAPI.exportModules({ include_disabled: true })
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `yinzi-tools-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url)
  } catch (error) { ElMessage.error(error?.message || '导出工具失败') }
}
async function toggleTool(item) { try { await orchestrationAPI.updateModule(item.module_id, { enabled: item.enabled === false }); await load(); ElMessage.success(item.enabled === false ? '工具已启用，之后的新计划可以选它' : '工具已停用，之后的新计划不会再选它') } catch (error) { ElMessage.error(error?.message || '更新工具状态失败') } }
async function removeTool(item) { try { await ElMessageBox.confirm(`删除「${item.title || item.module_id}」？已导出的工具包仍可恢复，但本机不会再出现这条合同。`, '删除工具', { type: 'warning' }); await orchestrationAPI.deleteModule(item.module_id); await load(); ElMessage.success('工具已删除') } catch (_) {} }
onMounted(loadModules)
useWorkbenchPage({ refresh: load, error: () => error.value, loading: () => loading.value })
</script>
<style scoped>
.inventory-strip{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px;margin:0;padding:16px 0;border-block:1px solid var(--border-color)}.inventory-strip div{min-width:0}.inventory-strip dt{font-size:12px;line-height:1.5;color:var(--text-muted)}.inventory-strip dd{margin:6px 0 0;font-size:24px;color:var(--text-primary)}
.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.catalog-page{display:grid;gap:16px}
/* 研究面板属于辅助内容，折叠起来，目录本身保持可见 */
.research-fold{border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-card)}
.research-fold>summary{cursor:pointer;padding:11px 14px;color:var(--text-muted);font-size:12px}
.research-fold[open]>summary{border-bottom:1px solid var(--border-color);color:var(--text-primary)}
.research-fold :deep(.product-research){border:0;background:transparent}
.scope-note{display:flex;justify-content:space-between;align-items:flex-start;gap:18px;padding:11px 14px;border:1px solid var(--border-color);border-left:2px solid var(--border-bright);border-radius:var(--radius-sm);background:var(--bg-inner)}
.scope-note p{margin:0;max-width:104ch;color:var(--text-muted);font-size:12px;line-height:1.75}
.catalog-hero{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:24px 28px;border:1px solid var(--border-color);background:var(--bg-card);border-radius:var(--radius-md)}
.kicker{color:var(--text-subtle);font-size:12px}
.catalog-hero h2{margin:9px 0 7px;font-size:26px;font-family:var(--font-display);line-height:1.3}
.catalog-hero p{max-width:760px;margin:0;color:var(--text-muted);font-size:13px;line-height:1.7}
.catalog-count{min-width:130px;padding-left:17px;border-left:1px solid var(--border-color)}
.catalog-count strong,.catalog-count span{display:block}
.catalog-count strong{color:var(--text-bright);font-size:32px}
.catalog-count span{color:var(--text-subtle);font-size:12px}
.panel{padding:13px 15px;border:1px solid var(--border-color);background:var(--bg-card);border-radius:var(--radius-sm)}
.runtime-banner{display:flex;justify-content:space-between;gap:18px;align-items:center;padding:14px 0;border-block:1px solid var(--border-color)}
.runtime-head strong{font-size:13px}
.runtime-banner p{margin:6px 0 0;color:var(--text-muted);font-size:12px}
.component-state.ready{color:var(--text-primary)}
.filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.search{max-width:320px}
.filter-select{width:170px}
.tool-actions{display:flex;gap:8px;flex-wrap:wrap}
.tool-actions .el-button+.el-button{margin-left:0}
/* 阶段分类 chip：一根线的幽灵按钮，选中才用铬 */
.catalog-bar{display:flex;gap:8px;flex-wrap:wrap}
.phase-chip{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border:1px solid var(--border-color);background:transparent;color:var(--text-muted);border-radius:var(--radius-sm);font:inherit;font-size:12px;cursor:pointer;transition:border-color .14s ease-out,color .14s ease-out,background .14s ease-out}
.phase-chip:hover{border-color:var(--border-muted);color:var(--text-primary);background:var(--bg-hover)}
.phase-chip.active{border-color:var(--border-bright);color:var(--text-bright);background:var(--ui-accent-soft)}
.phase-chip .num{color:var(--text-subtle);font-size:11px}
.result-line{display:flex;gap:14px;flex-wrap:wrap;color:var(--text-subtle);font-size:12px}
.paid-note{color:var(--ui-warning)}
.catalog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(330px,100%),1fr));gap:12px}
.module-card{min-width:0;padding:15px 16px;border:1px solid var(--border-color);background:var(--bg-card);border-radius:var(--radius-sm);display:flex;flex-direction:column}
.module-card header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.phase-tag{padding:2px 7px;border:1px solid var(--border-color);border-radius:var(--radius-sm);color:var(--text-subtle);font-size:11px}
.state-tag{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted);font-size:11px}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.state-tag.is-ready{color:var(--text-primary)}
.state-tag.is-bridge{color:var(--text-subtle)}
.state-tag.is-advisory{color:var(--text-subtle)}
.module-card h3{margin:12px 0 4px;color:var(--text-primary);font-size:15px;line-height:1.45}
.module-card code{color:var(--text-faint);font-family:var(--font-mono);font-size:11px;overflow-wrap:anywhere}
.module-card .desc{margin:11px 0 0;color:var(--text-muted);font-size:13px;line-height:1.7}
.example{margin:8px 0 0;color:var(--text-subtle);font-size:12px;line-height:1.6}
/* 规格表：标签列窄、值列宽，靠一根线分隔 */
.spec{margin:14px 0 0;display:grid;grid-template-columns:52px minmax(0,1fr);gap:7px 10px;font-size:12px;line-height:1.6}
.spec dt{color:var(--text-faint)}
.spec dd{margin:0;min-width:0;overflow-wrap:anywhere;color:var(--text-muted)}
.spec dd span{display:inline-block;margin:0 4px 3px 0;padding:1px 6px;border:1px solid var(--border-color);border-radius:var(--radius-sm);color:var(--text-muted);font-size:11px}
.spec dd em{color:var(--text-faint);font-style:normal}
.spec dd.is-paid{color:var(--ui-warning)}
.spec dd.is-free{color:var(--text-subtle)}
.spec-tight{margin-top:9px}
.spec dd.quote{color:var(--text-subtle);font-size:11px;line-height:1.65}
.more{margin-top:12px;border-top:1px solid var(--border-color);padding-top:10px}
.more summary{cursor:pointer;color:var(--text-subtle);font-size:12px}
.params{margin-top:9px}
.params summary{cursor:pointer;color:var(--text-subtle);font-size:11px}
.no-params{margin:9px 0 0;color:var(--text-faint);font-size:11px;line-height:1.6}
.module-card footer{justify-content:flex-start;flex-wrap:wrap;gap:10px;margin-top:13px;padding-top:11px;border-top:1px solid var(--border-color);color:var(--text-faint);font-size:11px}
.disabled-tool{color:var(--text-subtle)}
.custom-tool{color:var(--text-muted)}
.card-actions{margin-left:auto;display:flex;gap:6px}
.card-actions .el-button+.el-button{margin-left:0}
.catalog-pager{display:flex;justify-content:center}
.empty{padding:48px 24px;text-align:center;color:var(--text-muted);font-size:12px;line-height:1.8}
.empty strong{display:block;color:var(--text-primary);font-size:14px;margin-bottom:6px}
.empty p{margin:0 0 12px}
.catalog-error .error-detail{margin:6px 0 8px;line-height:1.7;color:var(--text-muted);font-size:12px}
.component-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;width:min(560px,100%)}
.component-state{min-width:0;font-size:12px;overflow-wrap:anywhere}
.component-heading{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;align-items:center}
.component-status{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted)}
.component-state p{margin:6px 0;line-height:1.6}
.component-state .el-progress{margin-top:8px}
.component-state.failed,.component-state.interrupted,.component-state.repair_required{color:var(--ui-danger)}
.component-state.preparing{color:var(--ui-warning)}
.component-state.ready .component-status{color:var(--text-primary)}
.component-state small{color:var(--text-subtle)}
.form-note{margin:8px 0 0;color:var(--text-subtle);font-size:12px;line-height:1.7}
@media(max-width:1050px){.inventory-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.runtime-banner{align-items:flex-start;flex-direction:column}}
@media(max-width:650px){.inventory-strip{grid-template-columns:repeat(2,minmax(0,1fr))}.catalog-hero{flex-direction:column;align-items:flex-start;padding:18px}.catalog-count{width:100%;padding:10px 0 0;border-left:0;border-top:1px solid var(--border-color)}.catalog-grid{grid-template-columns:1fr}.filters{align-items:stretch}.search{max-width:none;width:100%}.filter-select{width:100%}.scope-note{flex-direction:column}.component-list{grid-template-columns:1fr}}
.tool-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.form-output{margin-top:8px}.catalog-error{margin-top:-6px}@media(max-width:650px){.tool-form-grid{grid-template-columns:1fr}}
.filter-count{margin-top:6px;white-space:nowrap}
</style>
