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
      <div class="source-switch">
        <el-radio-group v-model="librarySource" @change="changeSource">
          <el-radio-button value="orchestration">Codex 任务成果</el-radio-button>
          <el-radio-button value="production">已批准生产资产</el-radio-button>
          <el-radio-button value="upload">手工上传</el-radio-button>
        </el-radio-group>
        <span class="source-note">
          {{ librarySource === 'orchestration' ? '汇总各任务的成品、中间素材与工程文件，保留原始任务记录' : librarySource === 'production' ? '保留项目、阶段、版本与审批来源，只读展示' : '可上传、预览和删除的独立媒体文件' }}
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
        <span>共 {{ total }} 项</span>
        <span v-if="librarySource === 'production'">当前仅展示每个制作对象的最新批准版本</span>
      </div>

      <p v-if="loadError" role="alert">{{ loadError }}；保留上次成功读取的结果。</p>
      <OrchestrationArtifactGallery v-if="librarySource === 'orchestration'" :items="mediaItems" :loading="loading" :error="loadError" />
      <section v-else v-loading="loading" class="media-grid" aria-live="polite">
        <article
          v-for="item in mediaItems"
          :key="item.id"
          :class="['media-card', { selected: isSelected(item), unavailable: item.available === false }]"
          @click="handleCardClick(item)"
        >
          <div class="media-thumb">
            <img v-if="item.type === 'image' && itemUrl(item)" :src="itemUrl(item)" class="thumb-media" :alt="item.name" loading="lazy" />
            <video
              v-else-if="item.type === 'video' && itemUrl(item)"
              :src="`${itemUrl(item)}#t=0.1`"
              class="thumb-media"
              muted
              playsinline
              preload="metadata"
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
            <el-icon v-if="isSelected(item)" class="check-icon"><CircleCheck /></el-icon>

            <div class="media-overlay" @click.stop>
              <el-button
                :icon="ZoomIn"
                circle
                title="预览"
                :disabled="!itemUrl(item)"
                @click="openPreview(item)"
              />
              <el-button
                :icon="Download"
                circle
                title="下载"
                :disabled="!itemUrl(item)"
                @click="downloadItem(item)"
              />
              <el-button
                v-if="item.library_source === 'production'"
                :icon="FolderOpened"
                circle
                title="打开来源制作任务"
                @click="openSource(item)"
              />
              <el-button
                v-else
                :icon="Delete"
                circle
                type="danger"
                plain
                title="删除"
                @click="deleteItem(item)"
              />
            </div>
          </div>

          <div class="media-info">
            <strong class="media-name" :title="item.name">{{ item.name || '未命名' }}</strong>
            <div v-if="item.library_source === 'production'" class="media-provenance">
              <span>{{ item.drama_title || `项目 ${item.drama_id}` }}</span>
              <span v-if="item.scope_type === 'shot'">镜头 #{{ item.scope_id }}</span>
              <span>修订 {{ item.revision }}</span>
            </div>
            <div class="media-meta">
              <span>{{ mediaTypeLabel(item.type) }}</span>
              <span v-if="formatDuration(item.duration_seconds || item.duration)">{{ formatDuration(item.duration_seconds || item.duration) }}</span>
              <span>{{ formatDate(item.approved_at || item.created_at) }}</span>
            </div>
            <div v-if="item.library_source === 'production'" :class="['availability', `is-${availabilityTone(item)}`]">
              {{ availabilityLabel(item) }}
            </div>
          </div>
        </article>

        <div v-if="!loading && mediaItems.length === 0" class="empty-media">
          <el-icon><Files /></el-icon>
          <strong>{{ librarySource === 'production' ? '没有符合筛选条件的生产资产' : '还没有手工上传素材' }}</strong>
          <span>{{ librarySource === 'production' ? '完成并批准资源后会自动出现在这里' : '上传后会保存在本地素材库中' }}</span>
        </div>
      </section>

      <div v-if="total > pageSize" class="pagination">
        <el-pagination
          v-model:current-page="page"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[20, 30, 50, 100]"
          layout="total, sizes, prev, pager, next"
          @current-change="loadMedia"
          @size-change="resetAndLoad"
        />
      </div>
    </main>

    <div v-if="librarySource === 'upload' && selectedIds.size" class="batch-bar">
      <span>已选 {{ selectedIds.size }} 项</span>
      <el-button size="small" @click="selectedIds.clear()">取消</el-button>
      <el-button size="small" type="danger" plain :icon="Delete" @click="batchDelete">批量删除</el-button>
    </div>

    <el-dialog v-model="showPreview" :title="previewItem?.name || '素材预览'" width="min(900px, 94vw)" destroy-on-close @closed="previewItem = null">
      <div class="preview-content">
        <video v-if="previewItem?.type === 'video'" :src="itemUrl(previewItem)" controls autoplay playsinline class="preview-video" />
        <audio v-else-if="previewItem?.type === 'audio'" :src="itemUrl(previewItem)" controls autoplay class="preview-audio" />
        <img v-else-if="previewItem" :src="itemUrl(previewItem)" class="preview-image" :alt="previewItem.name" />
      </div>
      <div v-if="previewItem" class="preview-meta">
        <div><span>类型</span>{{ mediaTypeLabel(previewItem.type) }}</div>
        <div v-if="previewItem.library_source === 'production'"><span>来源</span>{{ previewItem.drama_title }} · {{ productionStageLabel(previewItem.stage) }}</div>
        <div><span>时间</span>{{ formatDate(previewItem.approved_at || previewItem.created_at) }}</div>
      </div>
      <template #footer>
        <el-button v-if="previewItem?.library_source === 'production'" :icon="FolderOpened" @click="openSource(previewItem)">查看制作流程</el-button>
        <el-button type="primary" :icon="Download" @click="downloadItem(previewItem)">下载</el-button>
      </template>
    </el-dialog>
  </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft, CircleCheck, Delete, Download, Files, FolderOpened,
  Headset, Loading, Lock, Refresh, Search, Upload, ZoomIn,
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
const librarySource = ref('orchestration')
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
  page.value = 1
  loadMedia()
}

function resetAndLoad() {
  page.value = 1
  loadMedia()
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

function isSelected(item) {
  return item.library_source === 'upload' && selectedIds.has(Number(item.id))
}

function handleCardClick(item) {
  if (item.library_source === 'production') {
    if (itemUrl(item)) openPreview(item)
    return
  }
  const id = Number(item.id)
  if (selectedIds.has(id)) selectedIds.delete(id)
  else selectedIds.add(id)
}

function openPreview(item) {
  if (!itemUrl(item)) return ElMessage.warning(availabilityLabel(item) || '文件当前不可预览')
  previewItem.value = item
  showPreview.value = true
}

function openSource(item) {
  if (!item?.drama_id) return
  showPreview.value = false
  router.push({ path: `/workflow/${item.drama_id}`, query: { run: item.run_id } })
}

function downloadItem(item) {
  const url = itemUrl(item)
  if (!url) return ElMessage.warning('文件当前不可下载')
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

async function deleteItem(item) {
  if (item.library_source !== 'upload') return
  try {
    await ElMessageBox.confirm(`确定删除手工素材“${item.name || '未命名'}”？`, '删除确认', { type: 'warning' })
  } catch (_) {
    return
  }
  await request.delete(`/assets/${item.id}`)
  selectedIds.delete(Number(item.id))
  ElMessage.success('已删除')
  loadMedia()
}

async function batchDelete() {
  const ids = [...selectedIds]
  try {
    await ElMessageBox.confirm(`确定删除选中的 ${ids.length} 个手工素材？`, '批量删除', { type: 'warning' })
  } catch (_) {
    return
  }
  const results = await Promise.allSettled(ids.map((id) => request.delete(`/assets/${id}`)))
  const failed = results.filter((result) => result.status === 'rejected').length
  selectedIds.clear()
  if (failed) ElMessage.warning(`${ids.length - failed} 个删除成功，${failed} 个失败`)
  else ElMessage.success(`${ids.length} 个素材已删除`)
  loadMedia()
}

onMounted(async () => {
  const requestedDramaId = typeof route.query.drama_id === 'string' ? route.query.drama_id : ''
  if (requestedDramaId) { dramaId.value = requestedDramaId; librarySource.value = 'production' }
  await loadProjects()
  await loadMedia()
})
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
  backdrop-filter: blur(10px);
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
  letter-spacing: 0;
}
.page-subtitle {
  margin: 3px 0 0;
  color: var(--text-muted);
  font-size: 12px;
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
  border-radius: 6px;
}
.stage-filter {
  width: 150px;
}
.project-filter {
  width: 190px;
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
}
.media-grid {
  min-height: 280px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(230px, 100%), 1fr));
  gap: 12px;
}
.media-card {
  min-width: 0;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  cursor: pointer;
  transition: border-color .18s, box-shadow .18s, transform .18s;
}
.media-card:hover {
  border-color: var(--border-color);
  box-shadow: 0 8px 20px rgba(35, 60, 56, .1);
  transform: translateY(-2px);
}
.media-card.selected {
  border-color: var(--border-color);
  box-shadow: 0 0 0 1px #0f766e;
}
.media-card.unavailable {
  background: var(--bg-card);
}
.media-thumb {
  position: relative;
  aspect-ratio: 16 / 10;
  overflow: hidden;
  background: var(--bg-card);
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
  color: var(--text-muted);
  background: var(--bg-card);
  font-size:12px;
  text-align: center;
}
.media-placeholder .el-icon {
  font-size: 34px;
}
.audio-placeholder {
  color: var(--ui-accent);
  background: var(--bg-card);
}
.audio-placeholder .el-icon {
  font-size: 46px;
}
.source-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  max-width: calc(100% - 54px);
  padding: 4px 7px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  color: var(--text-primary);
  background: rgba(15, 118, 110, .88);
  border-radius: 4px;
  font-size:12px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.check-icon {
  position: absolute;
  top: 8px;
  right: 8px;
  color: var(--ui-accent);
  background: var(--bg-card);
  border-radius: 50%;
  font-size: 21px;
}
.media-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  opacity: 0;
  background: rgba(9, 13, 15, .58);
  transition: opacity .18s;
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
  color: var(--text-muted);
  font-size:12px;
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
.availability {
  font-size:12px;
}
.availability.is-ready {
  color: var(--ui-accent);
}
.availability.is-prepare {
  color: var(--ui-warning);
}
.availability.is-missing {
  color: var(--ui-danger);
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
  color: var(--text-muted);
}
.empty-media strong {
  color: var(--text-muted);
}
.empty-media span {
  font-size: 12px;
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
  color: var(--text-primary);
  background: var(--bg-card);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, .24);
  font-size: 12px;
  transform: translateX(-50%);
}
.preview-content {
  min-height: 330px;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: #090b0d;
  border-radius: 6px;
}
.preview-image,
.preview-video {
  max-width: 100%;
  max-height: 66vh;
  object-fit: contain;
}
.preview-audio {
  width: min(620px, 90%);
}
.preview-meta {
  padding-top: 12px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  color: var(--text-muted);
  font-size: 12px;
}
.preview-meta div {
  display: flex;
  gap: 7px;
}
.preview-meta span {
  color: var(--text-muted);
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
  .search-input {
    width: 100%;
    margin-left: 0;
  }
  .result-summary span:last-child {
    display: none;
  }
  .preview-content {
    min-height: 220px;
  }
}
</style>
