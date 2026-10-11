<template>
  <div class="workbench-view">
  <div class="media-library-page">
    <header class="page-header">
      <div class="header-left">
        <el-button :icon="ArrowLeft" circle title="返回" @click="router.back()" />
        <div>
          <h1 class="page-title">媒体素材库</h1>
          <p class="page-subtitle">集中查看已批准的制作产物和手工上传素材</p>
        </div>
      </div>
      <div class="header-actions">
        <el-button :icon="Refresh" :loading="loading" @click="loadMedia">刷新</el-button>
        <el-button type="primary" :icon="Upload" @click="triggerUpload">上传素材</el-button>
        <input
          ref="uploadInput"
          type="file"
          accept="image/*,video/*,audio/*"
          multiple
          hidden
          @change="onUpload"
        />
      </div>
    </header>

    <main class="library-main">
      <!-- 这一页在管什么：给用户看的说明，不是营销文案 -->
      <section class="scope-note" aria-label="这一页在管什么">
        <p>这一页只管「看和取」：把三个来源的素材按类型、来源、时间、分类、关键词筛出来，预览、下载、以及对手工素材改名或删除。筛选和排序只作用于当前这一个来源；批量删除只对「手动与上传」生效，其余来源在源头工作流里改。</p>
      </section>

      <div class="source-switch">
        <el-radio-group v-model="librarySource" @change="changeSource">
          <el-radio-button value="orchestration">Codex 任务成果</el-radio-button>
          <el-radio-button value="production">已批准生产资产</el-radio-button>
          <el-radio-button value="upload">手动与上传</el-radio-button>
        </el-radio-group>
        <span class="source-note">
          {{ librarySource === 'orchestration' ? '汇总各任务的成品、中间素材与工程文件，保留原始任务记录' : librarySource === 'production' ? '保留项目、阶段、版本与审批来源，只读展示' : '手动生成和上传的素材，可重命名、预览、下载和删除' }}
        </span>
      </div>

      <section class="filter-bar" aria-label="素材筛选">
        <el-radio-group v-model="mediaType" @change="resetAndLoad">
          <el-radio-button value="all">全部</el-radio-button>
          <el-radio-button value="image">图片</el-radio-button>
          <el-radio-button value="video">视频</el-radio-button>
          <el-radio-button value="audio">音频</el-radio-button>
        </el-radio-group>
        <el-select
          v-if="librarySource === 'production'"
          v-model="stage"
          class="stage-filter"
          aria-label="生产阶段"
          @change="resetAndLoad"
        >
          <el-option v-for="option in PRODUCTION_MEDIA_STAGES" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-select
          v-if="librarySource === 'production'"
          v-model="dramaId"
          class="project-filter"
          filterable
          aria-label="来源项目"
          @change="resetAndLoad"
        >
          <el-option label="全部项目" value="all" />
          <el-option v-for="drama in dramas" :key="drama.id" :label="drama.title || `项目 ${drama.id}`" :value="String(drama.id)" />
        </el-select>
        <el-select v-model="timeRange" class="time-filter" aria-label="时间范围" @change="applyTimeRange">
          <el-option v-for="option in TIME_RANGES" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-select
          v-if="categoryOptions.length > 1"
          v-model="category"
          class="category-filter"
          filterable
          aria-label="素材分类"
          @change="resetAndLoad"
        >
          <el-option label="全部分类" value="all" />
          <el-option v-for="name in categoryOptions" :key="name" :label="name" :value="name" />
        </el-select>
        <el-select v-model="sortBy" class="sort-filter" aria-label="排序方式">
          <el-option v-for="option in SORT_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
        <el-input
          v-model="keyword"
          class="search-input"
          clearable
          :placeholder="librarySource === 'upload' ? '搜索上传素材...' : '搜索名称或来源任务...'"
          @input="debouncedLoad"
        >
          <template #prefix><el-icon><Search /></el-icon></template>
        </el-input>
      </section>

      <div v-if="uploading" class="upload-progress">
        <el-icon class="is-loading"><Loading /></el-icon>
        <span>正在登记 {{ uploadProgress.current }}/{{ uploadProgress.total }}</span>
        <span v-if="uploadProgress.failed">{{ uploadProgress.failed }} 个失败</span>
      </div>

      <div class="result-summary">
        <div class="summary-left">
          <span>共 {{ total }} 项</span>
          <span v-if="pageTotal > pageSize" class="page-hint">当前第 {{ page }} 页，本页 {{ mediaItems.length }} 项</span>
          <span v-if="clientFiltered" class="page-hint">排序/时间/分类在本页内生效，需要更准的范围请缩小关键词</span>
        </div>
        <div class="summary-right">
          <span v-if="librarySource === 'production'">仅展示每个制作对象的最新批准版本</span>
          <el-radio-group v-model="viewMode" size="small" aria-label="显示方式" @change="savePrefs">
            <el-radio-button value="grid" title="网格视图">网格</el-radio-button>
            <el-radio-button value="list" title="列表视图">列表</el-radio-button>
          </el-radio-group>
        </div>
      </div>

      <div v-if="loadError" class="load-error" role="alert">
        <div>
          <strong>素材列表读取失败</strong>
          <span>{{ loadError }}；页面保留上次成功读取的结果。可先点「刷新」重试，仍失败说明本地后端没有响应。</span>
        </div>
        <el-button size="small" :loading="loading" @click="loadMedia">重试</el-button>
      </div>

      <OrchestrationArtifactGallery v-if="librarySource === 'orchestration'" :items="mediaItems" :loading="loading" :error="loadError" />
      <section v-else v-loading="loading" :class="['media-grid', { 'is-list': viewMode === 'list' }]" aria-live="polite">
        <article
          v-for="item in visibleItems"
          :key="item.id"
          :class="['media-card', { selected: isSelected(item), unavailable: item.available === false }]"
          @click="handleCardClick(item)"
        >
          <div class="media-thumb">
            <img v-if="item.type === 'image' && itemUrl(item)" :src="itemUrl(item)" class="thumb-media" :alt="item.name" loading="lazy" decoding="async" />
            <video
              v-else-if="item.type === 'video' && itemUrl(item)"
              :src="`${itemUrl(item)}#t=0.1`"
              class="thumb-media"
              muted
              playsinline
              preload="none"
            />
            <div v-else-if="item.type === 'audio'" class="media-placeholder audio-placeholder">
              <el-icon><Headset /></el-icon>
            </div>
            <div v-else class="media-placeholder">
              <el-icon><Files /></el-icon>
              <span>{{ availabilityLabel(item) }}</span>
            </div>

            <span v-if="item.library_source === 'production'" class="source-badge">
              <el-icon><Lock /></el-icon>{{ productionStageLabel(item.stage) }}
            </span>
            <span v-if="isSelected(item)" class="check-icon" aria-hidden="true"><el-icon><CircleCheck /></el-icon></span>
            <span v-if="selectable" class="select-hint" :title="isSelected(item) ? '取消选择' : '加入选择'">
              <el-icon><Files /></el-icon>
            </span>

            <div class="media-overlay" @click.stop>
              <el-button
                :icon="ZoomIn"
                size="small"
                title="预览并查看元数据"
                :disabled="!itemUrl(item)"
                @click="openPreview(item)"
              />
              <el-button
                :icon="Download"
                size="small"
                title="下载"
                :disabled="!itemUrl(item)"
                @click="downloadItem(item)"
              />
              <el-button
                v-if="item.library_source === 'production'"
                :icon="FolderOpened"
                size="small"
                title="打开来源制作任务"
                @click="openSource(item)"
              />
              <el-button
                v-else
                :icon="Delete"
                size="small"
                type="danger"
                plain
                title="删除"
                @click="deleteItem(item)"
              />
            </div>
          </div>

          <div class="media-info">
            <div class="media-name-row"><strong class="media-name" :title="item.name">{{ item.name || '未命名' }}</strong><el-button v-if="item.library_source === 'upload'" text :icon="Edit" aria-label="重命名素材" title="重命名" @click.stop="renameItem(item)" /></div>
            <div v-if="item.library_source === 'production'" class="media-provenance">
              <span>{{ item.drama_title || `项目 ${item.drama_id}` }}</span>
              <span v-if="item.scope_type === 'shot'">镜头 #{{ item.scope_id }}</span>
              <span>修订 {{ item.revision }}</span>
            </div>
            <div class="media-meta">
              <span>{{ mediaTypeLabel(item.type) }}</span><span v-if="item.file_size" class="num">{{ formatBytes(item.file_size) }}</span>
              <span v-if="formatDuration(item.duration_seconds || item.duration)" class="num">{{ formatDuration(item.duration_seconds || item.duration) }}</span>
              <span v-if="itemSize(item)" class="num">{{ itemSize(item) }}</span>
            </div>
            <div class="media-meta media-meta-time">
              <span class="num">{{ formatDate(item.approved_at || item.created_at) }}</span>
            </div>
            <div v-if="item.library_source === 'production'" :class="['availability', `is-${availabilityTone(item)}`]">
              {{ availabilityLabel(item) }}
            </div>
          </div>
        </article>

        <div v-if="!loading && mediaItems.length === 0" class="empty-media">
          <el-icon><Files /></el-icon>
          <strong>{{ emptyTitle }}</strong>
          <span>{{ emptyHint }}</span>
          <div class="empty-actions">
            <el-button v-if="librarySource === 'upload'" type="primary" @click="triggerUpload">选择文件上传</el-button>
            <el-button v-if="librarySource === 'production'" @click="router.push('/workflow')">去制作流程</el-button>
            <el-button @click="router.push('/asset-import')">从文件夹批量导入</el-button>
          </div>
        </div>
      </section>

      <div v-if="pageTotal > pageSize" class="pagination">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="pageTotal"
          :page-sizes="[20, 30, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="loadMedia"
          @size-change="resetAndLoad"
        />
      </div>
    </main>

    <div v-if="selectable && selectedIds.size" class="batch-bar">
      <span>已选 {{ selectedIds.size }} 项</span>
      <el-button size="small" :icon="Download" @click="batchDownload">批量下载</el-button>
      <el-button size="small" :icon="Files" @click="selectAllVisible">全选本页</el-button>
      <el-button size="small" @click="selectedIds.clear()">取消</el-button>
      <el-button size="small" type="danger" plain :icon="Delete" @click="batchDelete">批量删除</el-button>
    </div>

    <el-drawer
      v-model="showPreview"
      :with-header="false"
      size="min(560px, 96vw)"
      class="preview-drawer"
      destroy-on-close
      @closed="previewItem = null"
    >
      <div v-if="previewItem" class="drawer-body">
        <header class="drawer-head">
          <div class="drawer-title">
            <h2>{{ previewItem.name || '未命名' }}</h2>
            <p>{{ mediaTypeLabel(previewItem.type) }} · {{ sourceLabel }}</p>
          </div>
          <el-button :icon="Close" circle title="关闭" @click="showPreview = false" />
        </header>

        <div class="preview-content">
          <video v-if="previewItem.type === 'video'" :src="itemUrl(previewItem)" controls autoplay playsinline class="preview-video" />
          <audio v-else-if="previewItem.type === 'audio'" :src="itemUrl(previewItem)" controls autoplay class="preview-audio" />
          <img v-else :src="itemUrl(previewItem)" class="preview-image" :alt="previewItem.name" loading="lazy" />
        </div>

        <dl class="meta-table">
          <div v-for="row in previewMeta(previewItem)" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd :class="{ num: row.mono }">{{ row.value }}</dd>
          </div>
        </dl>

        <el-alert
          v-if="previewItem.available === false"
          type="warning"
          :closable="false"
          show-icon
          title="源文件当前不可用"
          description="这条记录仍在，但磁盘上的文件不在原位。请回到来源任务重新准备，或检查素材是否被移动。"
        />

        <footer class="drawer-foot">
          <el-button v-if="previewItem.library_source === 'production'" :icon="FolderOpened" @click="openSource(previewItem)">查看制作流程</el-button>
          <el-button v-if="previewItem.library_source === 'upload'" :icon="Edit" @click="renameItem(previewItem)">重命名</el-button>
          <el-button type="primary" :icon="Download" :disabled="!itemUrl(previewItem)" @click="downloadItem(previewItem)">下载</el-button>
        </footer>
      </div>
    </el-drawer>
  </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft, CircleCheck, Close, Delete, Download, Files, FolderOpened,
  Edit, Headset, Loading, Lock, Refresh, Search, Upload, ZoomIn,
} from '@element-plus/icons-vue'
import { uploadAPI } from '@/api/upload'
import { dramaAPI } from '@/api/drama'
import { productionAPI } from '@/api/production'
import request from '@/utils/request'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'
import OrchestrationArtifactGallery from '@/components/orchestration/OrchestrationArtifactGallery.vue'
import {
  normalizeProductionMedia,
  normalizeUploadedMedia,
  productionMediaUrl,
  productionStageLabel,
  PRODUCTION_MEDIA_STAGES,
} from '@/utils/productionMedia'

const router = useRouter()
const route = useRoute()
const loading = ref(false)
const loadError = ref('')
const uploading = ref(false)
const uploadProgress = ref({ current: 0, total: 0, failed: 0 })
const mediaItems = ref([])
const librarySource = ref(['upload','orchestration','production'].includes(route.query.source) ? route.query.source : 'upload')
const mediaType = ref('all')
const stage = ref('all')
const dramaId = ref('all')
const dramas = ref([])
const keyword = ref('')
const page = ref(1)
const pageSize = ref(30)
const total = ref(0)
const selectedIds = reactive(new Set())
const showPreview = ref(false)
const previewItem = ref(null)
const uploadInput = ref(null)
let keywordTimer = null
let loadSequence = 0

/* ── 手动可控的视图参数：全部记在 localStorage（yinzi- 前缀） ── */
const TIME_RANGES = [
  { value: 'all', label: '不限时间' },
  { value: '1', label: '最近 24 小时' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
]
const SORT_OPTIONS = [
  { value: 'newest', label: '最新优先' },
  { value: 'oldest', label: '最早优先' },
  { value: 'size-desc', label: '文件从大到小' },
  { value: 'size-asc', label: '文件从小到大' },
  { value: 'name', label: '按名称' },
]

function pref(key, fallback) {
  try { return localStorage.getItem(`yinzi-media-library-${key}`) ?? fallback } catch (_) { return fallback }
}
function savePrefs() {
  try {
    localStorage.setItem('yinzi-media-library-view', viewMode.value)
    localStorage.setItem('yinzi-media-library-sort', sortBy.value)
    localStorage.setItem('yinzi-media-library-range', timeRange.value)
    localStorage.setItem('yinzi-media-library-page-size', String(pageSize.value))
  } catch (_) { /* 隐私模式下写不进去，不影响使用 */ }
}

const viewMode = ref(pref('view', 'grid') === 'list' ? 'list' : 'grid')
const sortBy = ref(SORT_OPTIONS.some(o => o.value === pref('sort', 'newest')) ? pref('sort', 'newest') : 'newest')
const timeRange = ref(TIME_RANGES.some(o => o.value === pref('range', 'all')) ? pref('range', 'all') : 'all')
const category = ref('all')
pageSize.value = Number(pref('page-size', '30')) || 30

const selectable = computed(() => librarySource.value === 'upload')
const sourceLabel = computed(() => ({ orchestration: 'Codex 任务成果', production: '已批准生产资产', upload: '手动与上传' })[librarySource.value] || '')

/* 时间 / 分类是本地筛选；后端只接受 page、page_size、type、keyword，所以先取回本页再筛 */
const categoryOptions = computed(() => {
  const names = new Set()
  for (const item of mediaItems.value) if (item.category) names.add(String(item.category))
  return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'))
})
const pageTotal = computed(() => total.value)
const clientFiltered = computed(() => timeRange.value !== 'all' || category.value !== 'all' || sortBy.value !== 'newest')
const visibleItems = computed(() => {
  const now = Date.now()
  const windowMs = timeRange.value === 'all' ? 0 : Number(timeRange.value) * 24 * 60 * 60 * 1000
  let rows = mediaItems.value.filter((item) => {
    if (category.value !== 'all' && String(item.category || '') !== category.value) return false
    if (!windowMs) return true
    const stamp = Date.parse(item.approved_at || item.created_at || '')
    return Number.isFinite(stamp) ? now - stamp <= windowMs : true
  })
  const time = (item) => Date.parse(item.approved_at || item.created_at || '') || 0
  const size = (item) => Number(item.file_size) || 0
  const pick = {
    newest: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    'size-desc': (a, b) => size(b) - size(a),
    'size-asc': (a, b) => size(a) - size(b),
    name: (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'),
  }[sortBy.value]
  return pick && sortBy.value !== 'newest' ? [...rows].sort(pick) : rows
})

const emptyTitle = computed(() => {
  if (mediaItems.value.length === 0) {
    if (librarySource.value === 'production') return '没有符合筛选条件的生产资产'
    if (librarySource.value === 'orchestration') return '还没有 Codex 任务成果'
    return '还没有手工上传素材'
  }
  return '当前条件和排序下这一页没有素材'
})
const emptyHint = computed(() => {
  if (mediaItems.value.length === 0) {
    if (librarySource.value === 'production') return '在制作流程里完成并批准资产后会自动出现在这里'
    if (librarySource.value === 'orchestration') return '让 Codex 跑完一步后，成果会自动登记到目录里'
    return '上传后会保存在本地素材库中，可改名、下载和批量整理'
  }
  return '时间范围或分类过窄，放宽任意一项即可看到本页其余素材'
})

function triggerUpload() {
  uploadInput.value?.click()
}

async function onUpload(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (!files.length) return
  uploading.value = true
  uploadProgress.value = { current: 0, total: files.length, failed: 0 }
  for (const file of files) {
    try {
      const uploaded = await uploadAPI.uploadReferenceMedia(file)
      await request.post('/assets', {
        name: file.name,
        type: uploaded.media_type || String(file.type || '').split('/')[0] || 'image',
        url: uploaded.url || '',
        local_path: uploaded.local_path || null,
        file_size: uploaded.size || file.size,
        mime_type: uploaded.mime_type || file.type || null,
      })
    } catch (error) {
      uploadProgress.value.failed++
      ElMessage.warning(`${file.name}：${error.message || '上传失败'}`)
    } finally {
      uploadProgress.value.current++
    }
  }
  uploading.value = false
  const succeeded = files.length - uploadProgress.value.failed
  if (succeeded) ElMessage.success(`已登记 ${succeeded} 个素材`)
  librarySource.value = 'upload'
  page.value = 1
  await loadMedia()
}

function debouncedLoad() {
  clearTimeout(keywordTimer)
  keywordTimer = setTimeout(resetAndLoad, 300)
}

function changeSource() {
  selectedIds.clear()
  mediaType.value = 'all'
  category.value = 'all'
  page.value = 1
  loadMedia()
}

function resetAndLoad() {
  page.value = 1
  loadMedia()
}

/* 时间范围只筛本页，不用重新请求后端；清空选择避免指到看不见的项 */
function applyTimeRange() {
  savePrefs()
  pruneSelection()
}

function pruneSelection() {
  const visible = new Set(visibleItems.value.filter(item => item.library_source === 'upload').map(item => Number(item.id)))
  for (const id of [...selectedIds]) if (!visible.has(id)) selectedIds.delete(id)
}

async function loadMedia() {
  const sequence = ++loadSequence
  loading.value = true
  try {
    if (librarySource.value === 'orchestration') {
      const result = await request.get('/orchestration-artifacts', { params: { page: page.value, page_size: pageSize.value, type: mediaType.value, q: keyword.value.trim() } })
      if (sequence !== loadSequence) return
      mediaItems.value = result.items || []
      total.value = result.pagination?.total || 0
    } else if (librarySource.value === 'production') {
      const params = { page: page.value, page_size: pageSize.value }
      if (mediaType.value !== 'all') params.media_type = mediaType.value
      if (stage.value !== 'all') params.stage = stage.value
      if (dramaId.value !== 'all') params.drama_id = dramaId.value
      if (keyword.value.trim()) params.q = keyword.value.trim()
      const result = await productionAPI.productionMedia(params)
      if (sequence !== loadSequence) return
      mediaItems.value = (result?.items || []).map(normalizeProductionMedia)
      total.value = result?.pagination?.total || 0
    } else {
      const params = { page: page.value, page_size: pageSize.value }
      if (mediaType.value !== 'all') params.type = mediaType.value
      if (keyword.value.trim()) params.keyword = keyword.value.trim()
      const result = await request.get('/assets', { params })
      if (sequence !== loadSequence) return
      mediaItems.value = (result?.items || []).map(normalizeUploadedMedia)
      total.value = result?.pagination?.total || 0
    }
    loadError.value = ''
    pruneSelection()
  } catch (error) {
    if (sequence !== loadSequence) return
    loadError.value = error?.message || '素材暂时无法刷新'
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
}

async function loadProjects() {
  try {
    const result = await dramaAPI.list({ page: 1, page_size: 100, archive_state: 'all' })
    dramas.value = result?.items || []
  } catch (_) {
    dramas.value = []
  }
}

function itemUrl(item) {
  if (!item) return ''
  if (item.library_source === 'production') return productionMediaUrl(item)
  const localPath = item.local_path || item.image_local_path || item.video_local_path
  if (localPath) return `/static/${String(localPath).replace(/\\/g, '/').replace(/^\/+/, '')}`
  return item.url || item.image_url || item.video_url || ''
}

function mediaTypeLabel(type) {
  return ({ image: '图片', video: '视频', audio: '音频' })[type] || '媒体'
}

function availabilityTone(item) {
  if (item.ready) return 'ready'
  return item.available === false ? 'missing' : 'prepare'
}

function availabilityLabel(item) {
  if (item.library_source !== 'production') return ''
  if (item.ready) return '可预览和复用'
  if (item.available === false) return '源文件当前不可用'
  return '在工作流中选择后自动准备'
}

function formatDuration(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const minutes = Math.floor(seconds / 60)
  const remainder = Math.round(seconds % 60)
  return minutes ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${remainder} 秒`
}

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatFullDate(value) {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未记录'
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/* 预览抽屉里的元数据：只列真实存在的字段，缺的写「未记录」，不猜 */
function previewMeta(item) {
  const rows = [
    { label: '类型', value: mediaTypeLabel(item.type) },
    { label: '来源', value: item.library_source === 'production' ? `${item.drama_title || `项目 ${item.drama_id}`} · ${productionStageLabel(item.stage)}` : sourceLabel.value },
  ]
  if (item.category) rows.push({ label: '分类', value: item.category })
  if (item.file_size) rows.push({ label: '文件大小', value: formatBytes(item.file_size), mono: true })
  if (item.width && item.height) rows.push({ label: '尺寸', value: `${item.width} × ${item.height}`, mono: true })
  const duration = formatDuration(item.duration_seconds || item.duration)
  if (duration) rows.push({ label: '时长', value: duration, mono: true })
  if (item.mime_type) rows.push({ label: '格式', value: item.mime_type, mono: true })
  if (item.revision != null) rows.push({ label: '修订', value: `v${item.revision}`, mono: true })
  if (item.scope_type === 'shot') rows.push({ label: '镜头', value: `#${item.scope_id}`, mono: true })
  if (item.run_id) rows.push({ label: '来源任务', value: item.run_id, mono: true })
  rows.push({ label: '记录时间', value: formatFullDate(item.approved_at || item.created_at), mono: true })
  if (item.local_path || item.media_path) rows.push({ label: '文件位置', value: item.local_path || item.media_path, mono: true })
  rows.push({ label: '可用性', value: item.available === false ? '源文件当前不可用' : '文件在位，可预览下载' })
  return rows
}

/* 列表视图里额外显示分辨率或时长 */
function itemSize(item) {
  if (item.width && item.height) return `${item.width}×${item.height}`
  return ''
}

function isSelected(item) {
  return item.library_source === 'upload' && selectedIds.has(Number(item.id))
}

function handleCardClick(item) {
  if (!selectable.value) {
    if (itemUrl(item)) openPreview(item)
    return
  }
  const id = Number(item.id)
  if (selectedIds.has(id)) selectedIds.delete(id)
  else selectedIds.add(id)
}

function selectAllVisible() {
  for (const item of visibleItems.value) {
    if (item.library_source === 'upload') selectedIds.add(Number(item.id))
  }
}

function openPreview(item) {
  if (!item) return
  previewItem.value = item
  showPreview.value = true
}

function openSource(item) {
  if (!item?.drama_id) return
  showPreview.value = false
  router.push({ path: `/workflow/${item.drama_id}`, query: { run: item.run_id } })
}

function downloadItem(item) {
  const url = item.download_url || itemUrl(item)
  if (!url || item.available === false) return ElMessage.warning('本地文件尚不可下载，请回原任务恢复下载')
  const suffix = String(item.media_path || item.local_path || item.url || '').match(/\.[a-z0-9]+(?:[?#].*)?$/i)?.[0]?.split(/[?#]/, 1)[0] || ''
  const name = String(item.name || '素材').replace(/[\\/:*?"<>|]/g, '_')
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name.toLowerCase().endsWith(suffix.toLowerCase()) ? name : `${name}${suffix}`
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}

/* 批量下载是浏览器逐个触发的，会有下载条；先说清楚数量 */
async function batchDownload() {
  const rows = visibleItems.value.filter(isSelected).filter(item => itemUrl(item) && item.available !== false)
  const skipped = selectedIds.size - rows.length
  if (!rows.length) return ElMessage.warning('选中的素材都没有可下载的本地文件')
  try {
    await ElMessageBox.confirm(
      `将依次下载 ${rows.length} 个文件${skipped ? `，另有 ${skipped} 个因源文件不可用被跳过` : ''}。浏览器会逐个保存，可能弹出多个下载提示。`,
      '批量下载',
    )
  } catch (_) { return }
  rows.forEach((item, index) => setTimeout(() => downloadItem(item), index * 350))
  ElMessage.success(`已开始下载 ${rows.length} 个素材`)
}

function formatBytes(value) { return Number(value) >= 1048576 ? `${(Number(value)/1048576).toFixed(1)} MB` : `${Math.ceil(Number(value)/1024)} KB` }
async function renameItem(item) {
  try {
    const { value } = await ElMessageBox.prompt('修改显示名称，原素材引用和文件路径会保留。', '重命名素材', { inputValue: item.name, inputValidator: value => Boolean(value?.trim()) && value.trim().length <= 240 || '请输入1到240个字符' })
    await request.put(`/assets/${item.id}`, { name: value.trim() })
    item.name = value.trim()
    if (previewItem.value?.id === item.id) previewItem.value = { ...item }
    ElMessage.success('名称已保存')
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(error.message || '重命名失败') }
}

async function deleteItem(item) {
  if (item.library_source !== 'upload') return
  try {
    await ElMessageBox.confirm(`确定删除手工素材「${item.name || '未命名'}」？删除后从素材库消失，磁盘上的文件不会自动清理。`, '删除确认', { type: 'warning' })
  } catch (_) {
    return
  }
  await request.delete(`/assets/${item.id}`)
  selectedIds.delete(Number(item.id))
  if (previewItem.value?.id === item.id) showPreview.value = false
  ElMessage.success('已删除')
  loadMedia()
}

async function batchDelete() {
  const ids = [...selectedIds]
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${ids.length} 个手工素材？只删素材库记录，源文件仍在本地目录里，需要自己清理。`, '批量删除', { type: 'warning' })
  } catch (_) {
    return
  }
  const results = await Promise.allSettled(ids.map((id) => request.delete(`/assets/${id}`)))
  const failed = results.filter((result) => result.status === 'rejected').length
  selectedIds.clear()
  if (failed) ElMessage.warning(`${ids.length - failed} 个删除成功，${failed} 个失败；失败的记录还在列表里，可重试`)
  else ElMessage.success(`${ids.length} 个素材已删除`)
  loadMedia()
}

onMounted(async () => {
  const requestedDramaId = typeof route.query.drama_id === 'string' ? route.query.drama_id : ''
  if (requestedDramaId) { dramaId.value = requestedDramaId; librarySource.value = 'production' }
  await loadProjects()
  await loadMedia()
})
onUnmounted(() => clearTimeout(keywordTimer))
useWorkbenchPage({ refresh: loadMedia, error: () => loadError.value, loading: () => loading.value })
</script>

<style scoped>
.media-library-page{min-height:0!important;background:transparent!important;color:var(--text-primary)!important}
.page-header{position:static!important;background:transparent!important;padding:0 0 18px!important}
.page-header .header-left{display:none}
.library-main{padding:12px 0!important}
.source-switch{flex-wrap:wrap}
.source-switch :deep(.el-radio-group){display:flex;flex-wrap:wrap}
.media-library-page {
  min-height: 100vh;
  color: var(--text-primary);
  background: var(--bg-card);
}
.page-header {
  position: sticky;
  top: 0;
  z-index: 10;
  min-height: 66px;
  padding: 10px max(18px, calc((100vw - 1440px) / 2));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
}
.header-left,
.header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.page-title {
  margin: 0;
  font-size: 19px;
  font-family: var(--font-display);
  letter-spacing: 0;
}
.page-subtitle {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}
/* 页面职责说明：一句中文，讲清改了会影响什么 */
.scope-note {
  margin: 0 0 14px;
  padding: 10px 13px;
  border: 1px solid var(--border-color);
  border-left: 2px solid var(--border-bright);
  border-radius: var(--radius-sm);
  background: var(--bg-inner);
}
.scope-note p {
  margin: 0;
  max-width: 96ch;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.75;
}
.library-main {
  max-width: 1440px;
  margin: 0 auto;
  padding: 22px 18px 54px;
}
.source-switch {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 14px;
}
.source-note,
.result-summary {
  color: var(--text-muted);
  font-size: 12px;
}
.filter-bar {
  min-height: 52px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}
.stage-filter {
  width: 150px;
}
.project-filter {
  width: 190px;
}
.time-filter {
  width: 140px;
}
.category-filter {
  width: 150px;
}
.sort-filter {
  width: 150px;
}
.search-input {
  width: min(280px, 100%);
  margin-left: auto;
}
.upload-progress,
.result-summary {
  display: flex;
  align-items: center;
  gap: 12px;
}
.upload-progress {
  margin-top: 12px;
  color: var(--ui-accent);
  font-size: 13px;
}
.result-summary {
  min-height: 38px;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.summary-left,
.summary-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.summary-right :deep(.el-radio-button__inner) {
  font-size: 12px;
}
/* 数字、字节、时间一律等宽 + 表格数字 */
.page-hint,
.num,
.media-meta,
.media-provenance,
.meta-table dd {
  font-variant-numeric: tabular-nums;
}
.media-meta .num,
.page-hint {
  font-family: var(--font-mono);
}
.page-hint {
  color: var(--text-subtle);
  font-size: 11px;
}
.load-error {
  margin: 10px 0;
  padding: 10px 13px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  color: var(--text-primary);
  background: var(--bg-inner);
  border: 1px solid var(--ui-danger);
  border-left-width: 2px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  line-height: 1.7;
}
.load-error strong {
  display: block;
  color: var(--ui-danger);
  font-size: 12px;
}
.load-error span {
  color: var(--text-muted);
}
/* 大列表：网格自带分页，卡片再加 content-visibility，滚出视口的行不参与布局 */
.media-grid {
  min-height: 280px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(230px, 100%), 1fr));
  gap: 12px;
  align-content: start;
}
.media-grid.is-list {
  grid-template-columns: minmax(0, 1fr);
  gap: 6px;
}
.media-card {
  min-width: 0;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  content-visibility: auto;
  contain-intrinsic-size: 240px 236px;
  transition: border-color .16s ease-out, background .16s ease-out;
}
/* 悬停只换颜色，不做位移和投影动画 */
.media-card:hover {
  border-color: var(--border-muted);
  background: var(--bg-hover);
}
.media-card:focus-visible {
  outline: 2px solid var(--ui-accent);
  outline-offset: 1px;
}
.media-card.selected {
  border-color: var(--border-bright);
  box-shadow: inset 0 0 0 1px var(--ui-accent-soft);
}
.media-card.unavailable {
  opacity: .72;
}
.media-thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--bg-deep);
}
.thumb-media {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
}
.media-placeholder {
  width: 100%;
  height: 100%;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: var(--text-subtle);
  background: var(--bg-inner);
  font-size: 12px;
  text-align: center;
}
.media-placeholder .el-icon {
  font-size: 34px;
}
.audio-placeholder {
  color: var(--ui-accent);
  background: var(--bg-inner);
}
.audio-placeholder .el-icon {
  font-size: 46px;
}
.source-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 54px);
  padding: 3px 7px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  color: var(--text-primary);
  background: rgba(14, 16, 19, .72);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-sm);
  font-size: 11px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.check-icon {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--ui-accent);
  background: var(--bg-deep);
  border: 1px solid var(--border-bright);
  border-radius: 50%;
  font-size: 14px;
}
/* 只在能多选的来源上给一个可选提示，避免用户以为点了会预览 */
.select-hint {
  position: absolute;
  top: 8px;
  right: 8px;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--text-subtle);
  background: rgba(14, 16, 19, .6);
  border: 1px solid var(--border-muted);
  border-radius: 50%;
  font-size: 12px;
  opacity: 0;
  transition: opacity .16s ease-out;
}
.media-card:hover .select-hint,
.media-card:focus-within .select-hint {
  opacity: 1;
}
.media-card.selected .select-hint {
  opacity: 0;
}
.media-overlay {
  position: absolute;
  inset: auto 0 0 0;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  opacity: 0;
  background: linear-gradient(to top, rgba(8, 9, 12, .92), rgba(8, 9, 12, .2) 70%, transparent);
  transition: opacity .16s ease-out;
}
.media-card:hover .media-overlay,
.media-card:focus-within .media-overlay {
  opacity: 1;
}
.media-info {
  padding: 10px 11px 11px;
  display: grid;
  gap: 6px;
}
.media-name {
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.35;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.media-provenance,
.media-meta {
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  color: var(--text-subtle);
  font-size: 12px;
  white-space: nowrap;
}
.media-provenance span,
.media-meta span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.media-provenance span + span::before,
.media-meta span + span::before {
  content: '·';
  margin-right: 5px;
}
/* 时间单独一行：四段元数据挤一行会互相截断 */
.media-meta-time {
  color: var(--text-faint);
}
.media-meta-time span::before {
  content: none;
  margin: 0;
}
.availability {
  font-size: 12px;
}
.availability.is-ready {
  color: var(--text-subtle);
}
.availability.is-prepare {
  color: var(--ui-warning);
}
.availability.is-missing {
  color: var(--ui-danger);
}
/* 列表视图：一行一条，缩略图固定宽度，信息在一行里摊开 */
.media-grid.is-list .media-card {
  display: grid;
  grid-template-columns: 116px minmax(0, 1fr);
  align-items: stretch;
  content-visibility: visible;
}
.media-grid.is-list .media-thumb {
  aspect-ratio: 16 / 10;
  height: 100%;
}
.media-grid.is-list .media-info {
  padding: 10px 12px;
  align-content: center;
}
.media-grid.is-list .media-name {
  font-size: 13.5px;
}
.empty-media {
  grid-column: 1 / -1;
  min-height: 300px;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 8px;
  color: var(--text-muted);
  text-align: center;
}
.empty-media .el-icon {
  font-size: 44px;
  color: var(--text-subtle);
}
.empty-media strong {
  color: var(--text-primary);
}
.empty-media span {
  font-size: 12px;
}
.empty-actions {
  margin-top: 10px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}
.pagination {
  margin-top: 20px;
  display: flex;
  justify-content: center;
}
.batch-bar {
  position: fixed;
  z-index: 20;
  left: 50%;
  bottom: 20px;
  padding: 9px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-muted);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
  font-size: 12px;
  transform: translateX(-50%);
}
.batch-bar .el-button + .el-button {
  margin-left: 0;
}
.drawer-body {
  display: grid;
  gap: 16px;
  color: var(--text-primary);
}
.drawer-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.drawer-title h2 {
  margin: 0;
  font-size: 17px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.drawer-title p {
  margin: 5px 0 0;
  color: var(--text-subtle);
  font-size: 12px;
}
.preview-content {
  min-height: 240px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--bg-deep);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}
.preview-image,
.preview-video {
  max-width: 100%;
  max-height: 52vh;
  object-fit: contain;
}
.preview-audio {
  width: min(620px, 90%);
}
.meta-table {
  margin: 0;
  display: grid;
  gap: 1px;
  background: var(--border-color);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.meta-table > div {
  padding: 8px 11px;
  display: grid;
  grid-template-columns: 84px minmax(0, 1fr);
  gap: 12px;
  background: var(--bg-card);
  font-size: 12px;
}
.meta-table dt {
  color: var(--text-subtle);
}
.meta-table dd {
  margin: 0;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}
.drawer-foot {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  padding-top: 4px;
}
@media (max-width: 760px) {
  .page-header {
    position: static;
    align-items: flex-start;
    flex-direction: column;
  }
  .header-actions {
    width: 100%;
  }
  .source-switch {
    align-items: flex-start;
    flex-direction: column;
  }
  .filter-bar {
    align-items: stretch;
    flex-direction: column;
  }
  .stage-filter,
  .project-filter,
  .time-filter,
  .category-filter,
  .sort-filter,
  .search-input {
    width: 100%;
    margin-left: 0;
  }
  .result-summary span:last-child {
    display: none;
  }
  .media-grid.is-list .media-card {
    grid-template-columns: 92px minmax(0, 1fr);
  }
  .preview-content {
    min-height: 200px;
  }
  .batch-bar {
    left: 12px;
    right: 12px;
    transform: none;
    justify-content: center;
  }
}
</style>

<style scoped>
.media-name-row { display:flex; align-items:center; gap:6px; }
.media-name-row .media-name { flex:1; min-width:0; }
</style>
