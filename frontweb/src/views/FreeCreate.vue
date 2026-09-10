<template>
  <div class="free-create-page">
    <header class="page-header">
      <el-button text aria-label="返回" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon>
      </el-button>
      <div>
        <h1>手动创作</h1>
        <p>简单任务可以在这里直接生成；更复杂的需求，推荐直接告诉 Codex。</p>
      </div>
    </header>

    <main class="create-layout">
      <section class="input-panel">
        <el-tabs v-model="mode" class="mode-tabs">
          <el-tab-pane label="生成图片" name="image" />
          <el-tab-pane label="生成视频" name="video" />
        </el-tabs>

        <div class="form-section">
          <label class="form-label" for="creation-prompt">提示词 <span class="required">*</span></label>
          <el-input
            id="creation-prompt"
            v-model="prompt"
            type="textarea"
            :rows="5"
            placeholder="描述画面、动作、镜头与氛围"
          />
        </div>

        <template v-if="mode === 'video'">
          <div class="form-section">
            <label class="form-label">视频模型</label>
            <el-select v-model="selectedVideoModel" filterable class="full-width" placeholder="使用默认视频模型">
              <el-option v-for="item in videoModels" :key="item.model" :label="item.model" :value="item.model" />
            </el-select>
            <div v-if="videoCapability" class="capability-line">
              <span>{{ videoCapability.max_images }} 图</span>
              <span>{{ videoCapability.max_videos }} 视频</span>
              <span>{{ videoCapability.max_audios }} 音频</span>
              <span>{{ videoCapability.duration_min }}-{{ videoCapability.duration_max }} 秒</span>
              <span>{{ videoCapability.resolution }}</span>
            </div>
          </div>

        </template>
          <div class="form-section reference-editor">
            <div class="reference-heading">
              <div>
                <div class="form-label">参考媒体</div>
                <div class="field-note">图片、视频和音频均按 reference 角色提交</div>
              </div>
              <el-button size="small" plain :icon="FolderOpened" @click="openLibraryPicker">从素材库选择</el-button>
            </div>

            <div class="reference-group">
              <div class="reference-group-title">
                <span><el-icon><Picture /></el-icon> 图片 {{ imageReferences.length }}/{{ limits.images }}</span>
                <el-tooltip content="添加参考图" placement="top">
                  <el-button circle size="small" :disabled="isUploading || imageReferences.length >= limits.images" @click="imageInput?.click()">
                    <el-icon><Plus /></el-icon>
                  </el-button>
                </el-tooltip>
              </div>
              <div v-if="imageReferences.length" class="media-list image-list">
                <div v-for="(item, index) in imageReferences" :key="item.local_path" class="media-row">
                  <img :src="item.url" :alt="item.filename" />
                  <span class="media-name">{{ item.filename }}</span>
                  <el-tooltip content="移除" placement="top">
                    <el-button text circle aria-label="移除参考图" @click="removeReference('image', index)"><el-icon><Delete /></el-icon></el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>

            <div v-if="mode === 'video'" class="reference-group">
              <div class="reference-group-title">
                <span><el-icon><VideoPlay /></el-icon> 视频 {{ videoReferences.length }}/{{ limits.videos }}</span>
                <el-tooltip content="添加参考视频" placement="top">
                  <el-button circle size="small" :disabled="isUploading || videoReferences.length >= limits.videos" @click="videoInput?.click()">
                    <el-icon><Plus /></el-icon>
                  </el-button>
                </el-tooltip>
              </div>
              <div v-if="videoReferences.length" class="media-list">
                <div v-for="(item, index) in videoReferences" :key="item.local_path" class="media-row">
                  <el-icon class="media-type-icon"><VideoPlay /></el-icon>
                  <span class="media-name">{{ item.filename }}</span>
                  <el-tooltip content="移除" placement="top">
                    <el-button text circle aria-label="移除参考视频" @click="removeReference('video', index)"><el-icon><Delete /></el-icon></el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>

            <div v-if="mode === 'video'" class="reference-group">
              <div class="reference-group-title">
                <span><el-icon><Headset /></el-icon> 音频 {{ audioReferences.length }}/{{ limits.audios }}</span>
                <el-tooltip content="添加参考音频" placement="top">
                  <el-button circle size="small" :disabled="isUploading || audioReferences.length >= limits.audios" @click="audioInput?.click()">
                    <el-icon><Plus /></el-icon>
                  </el-button>
                </el-tooltip>
              </div>
              <div v-if="audioReferences.length" class="media-list">
                <div v-for="(item, index) in audioReferences" :key="item.local_path" class="media-row">
                  <el-icon class="media-type-icon"><Headset /></el-icon>
                  <span class="media-name">{{ item.filename }}</span>
                  <el-tooltip content="移除" placement="top">
                    <el-button text circle aria-label="移除参考音频" @click="removeReference('audio', index)"><el-icon><Delete /></el-icon></el-button>
                  </el-tooltip>
                </div>
              </div>
            </div>

            <div v-if="isUploading" class="upload-state"><el-icon class="is-loading"><Loading /></el-icon> 正在保存参考媒体</div>
            <input ref="imageInput" hidden type="file" accept="image/*" multiple @change="onReferenceFiles('image', $event)" />
            <input ref="videoInput" hidden type="file" accept="video/*" multiple @change="onReferenceFiles('video', $event)" />
            <input ref="audioInput" hidden type="file" accept="audio/*" @change="onReferenceFiles('audio', $event)" />
          </div>

        <div class="form-section options-grid">
          <div>
            <label class="form-label">风格</label>
            <el-input v-model="style" placeholder="cinematic, anime..." />
          </div>
          <div>
            <label class="form-label">画幅</label>
            <el-select v-model="aspectRatio" class="full-width">
              <el-option label="16:9" value="16:9" />
              <el-option label="9:16" value="9:16" />
              <el-option label="1:1" value="1:1" />
              <el-option label="4:3" value="4:3" />
              <el-option label="3:4" value="3:4" />
            </el-select>
          </div>
          <div v-if="mode === 'video'">
            <label class="form-label">时长（秒）</label>
            <el-input-number v-model="duration" :min="durationBounds.min" :max="durationBounds.max" :step="1" controls-position="right" />
          </div>
        </div>

        <el-button
          type="primary"
          size="large"
          :loading="generating"
          :disabled="!prompt.trim() || isUploading"
          class="generate-btn"
          @click="generate"
        >
          {{ generating ? '生成中' : (mode === 'image' ? '生成图片' : '生成视频') }}
        </el-button>
      </section>

      <section class="result-panel">
        <div class="result-header">
          <h2>我的手动任务</h2>
          <div class="result-actions">
            <el-button v-if="results.some((item) => item.assetRegistered)" size="small" plain @click="$router.push('/media-library?source=upload')">查看素材库</el-button>
            <el-button size="small" plain @click="loadHistory">刷新进度</el-button>
          </div>
        </div>
        <el-alert v-if="historyError" :title="historyError" type="warning" :closable="false" />
        <p class="field-note">任务与结果保存在后台，切换页面或重开浏览器都可以继续查看。</p>
        <div v-if="!results.length && !generating" class="empty-result">
          <el-icon><MagicStick /></el-icon>
          <p>生成内容会显示在这里</p>
        </div>
        <div class="result-grid">
          <article v-for="(item, index) in results" :key="index" class="result-item">
            <div class="result-media">
              <video v-if="item.type === 'video' && item.url" :src="item.url" controls loop />
              <img v-else-if="item.type === 'image' && item.url" :src="item.url" :alt="item.prompt" @click="previewUrl = item.url" />
              <div v-else-if="['queued','submitting','processing'].includes(item.status)" class="media-status"><el-icon class="is-loading"><Loading /></el-icon><span>{{ taskState(item) }}</span></div>
              <div v-else class="media-status error"><el-icon><CircleClose /></el-icon><span>{{ item.error || (item.status === 'completed' ? '本地文件尚不可预览，可让 Codex 检查原记录' : '请查看任务状态') }}</span></div>
            </div>
            <div class="result-meta">
              <p>{{ item.prompt }}</p>
              <small class="result-progress">{{ taskState(item) }}</small><small v-if="item.provider_updated_at" class="field-note">任务最后更新：{{ new Date(item.provider_updated_at).toLocaleString() }}</small>
              <small v-if="item.fileSize" class="result-size">文件大小：{{ formatBytes(item.fileSize) }}</small>
              <small v-if="item.assetError" class="asset-register-error">素材库登记失败：{{ item.assetError }}</small>
              <small v-else-if="item.assetRegistered" class="asset-register-ok">已保存到素材库</small>
              <el-button v-if="item.download_url" size="small" type="primary" plain @click="downloadItem(item)">下载原文件</el-button><el-button v-else-if="item.local_path" size="small" plain @click="saveAsset(item)">保存到素材库</el-button><el-button v-if="item.can_retry_download" size="small" plain @click="retryDownload(item)">重试下载（不重新生成）</el-button>
            </div>
          </article>
        </div>
        <el-pagination v-if="historyTotal > 12" v-model:current-page="historyPage" :page-size="12" :total="historyTotal" layout="prev, pager, next" @current-change="loadHistory" />
      </section>
    </main>

    <el-dialog v-model="libraryVisible" title="从素材库选择参考素材" width="min(760px, 94vw)">
      <div class="library-picker-toolbar"><el-select v-model="librarySource" aria-label="素材来源"><el-option label="手动与上传" value="upload" /><el-option label="Codex 成果" value="orchestration" /><el-option label="项目制作" value="production" /></el-select><el-select v-model="libraryType" aria-label="素材类型"><el-option label="图片" value="image" /><el-option label="视频" value="video" /><el-option label="音频" value="audio" /></el-select><el-input v-model="libraryKeyword" clearable placeholder="搜索素材名称" @keyup.enter="loadLibraryAssets" /><el-button :loading="libraryLoading" @click="loadLibraryAssets">刷新</el-button></div>
      <div v-if="libraryAssets.length" class="library-picker-grid">
        <button v-for="asset in libraryAssets" :key="asset.id" type="button" class="library-picker-item" @click="selectLibraryAsset(asset)">
          <img v-if="asset.type === 'image' && asset.url" :src="asset.url" :alt="asset.name" />
          <div v-else class="library-picker-icon"><el-icon><VideoPlay v-if="asset.type === 'video'" /><Headset v-else /></el-icon></div>
          <strong>{{ asset.name }}</strong><small>{{ mediaTypeLabel(asset.type) }} · {{ formatBytes(asset.file_size) }}</small>
        </button>
      </div>
      <el-empty v-else description="素材库暂无可选素材" /><el-pagination v-if="libraryTotal > 24" v-model:current-page="libraryPage" :page-size="24" :total="libraryTotal" layout="prev, pager, next" @current-change="loadLibraryAssets" />
    </el-dialog>

    <div v-if="previewUrl" class="preview-overlay" @click="previewUrl = null">
      <img :src="previewUrl" alt="图片预览" @click.stop />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, CircleClose, Delete, FolderOpened, Headset, Loading, MagicStick, Picture, Plus, VideoPlay } from '@element-plus/icons-vue'
import { mediaBatchAPI } from '@/api/mediaBatch'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { resolveMediaUrl } from '@/utils/mediaUrl'
import { uploadAPI } from '@/api/upload'
import { aiAPI } from '@/api/ai'
import request from '@/utils/request'

const mode = ref('image')
const route = useRoute()
const prompt = ref(typeof route.query.prompt === 'string' ? route.query.prompt : '')
const style = ref('')
const aspectRatio = ref('16:9')
const duration = ref(5)
const generating = ref(false)
const uploadingType = ref('')
const results = ref([])
const previewUrl = ref(null)
const videoModels = ref([])
const selectedVideoModel = ref('')
const imageReferences = ref([])
const videoReferences = ref([])
const audioReferences = ref([])
const imageInput = ref(null)
const videoInput = ref(null)
const audioInput = ref(null)
const libraryVisible = ref(false)
const libraryLoading = ref(false)
const libraryKeyword = ref('')
const libraryAssets = ref([])
const historyPage = ref(1)
const historyTotal = ref(0)
const historyError = ref('')
const libraryPage = ref(1)
const libraryTotal = ref(0)
const libraryType = ref('image')
const librarySource = ref('upload')
let submission = null
try { submission = JSON.parse(sessionStorage.getItem('yinzi-pending-manual-submit') || 'null') } catch {}

const videoCapability = computed(() => videoModels.value.find((item) => item.model === selectedVideoModel.value)?.capabilities || null)
const limits = computed(() => ({
  images: videoCapability.value?.max_images ?? 4,
  videos: videoCapability.value?.max_videos ?? 3,
  audios: videoCapability.value?.max_audios ?? 1,
}))
const durationBounds = computed(() => ({
  // Keep the direct-create form aligned with the provider's automatic
  // submission boundary. Raw manual-contract fields may be wider than the
  // 5-15s workflow range and must not expose a known-invalid 4s choice.
  min: videoCapability.value?.auto_duration_min ?? videoCapability.value?.duration_min ?? 1,
  max: videoCapability.value?.auto_duration_max ?? videoCapability.value?.duration_max ?? 15,
}))
const isUploading = computed(() => Boolean(uploadingType.value))

watch(durationBounds, (bounds) => {
  duration.value = Math.min(bounds.max, Math.max(bounds.min, duration.value))
}, { immediate: true })

onMounted(async () => {
  const [catalogResult, configsResult] = await Promise.allSettled([
    aiAPI.getYinziCatalog(),
    aiAPI.list('video'),
  ])
  if (catalogResult.status === 'fulfilled') videoModels.value = catalogResult.value?.video || []
  if (configsResult.status === 'fulfilled') {
    const configs = Array.isArray(configsResult.value) ? configsResult.value : []
    const active = configs.find((item) => item.is_default) || configs[0]
    const configuredModel = active?.default_model || (Array.isArray(active?.model) ? active.model[0] : active?.model)
    if (configuredModel) selectedVideoModel.value = configuredModel
  }
  if (!selectedVideoModel.value && videoModels.value.length) selectedVideoModel.value = videoModels.value[0].model
})

function mediaTypeLabel(type) { return ({ image: '图片', video: '视频', audio: '音频' })[type] || '媒体' }
function formatBytes(value) { const n = Number(value); if (!Number.isFinite(n) || n <= 0) return '大小未知'; if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`; return `${(n / 1024 / 1024).toFixed(1)} MB` }
function assetUrl(asset) { const local = asset.local_path || ''; return local ? `/static/${String(local).replace(/\\/g, '/').replace(/^\/+/, '')}` : (asset.url || '') }
async function openLibraryPicker() { libraryVisible.value = true; await loadLibraryAssets() }
async function loadLibraryAssets() {
  libraryLoading.value = true
  try {
    const params = { page: libraryPage.value, page_size: 24, type: libraryType.value, keyword: libraryKeyword.value.trim(), q: libraryKeyword.value.trim() }
    const endpoint = librarySource.value === 'orchestration' ? '/orchestration-artifacts' : librarySource.value === 'production' ? '/production-media' : '/assets'
    if (librarySource.value === 'production') { params.media_type = libraryType.value; delete params.type }
    const result = await request.get(endpoint, { params })
    libraryAssets.value = (result?.items || []).map(item => ({ ...item, id: `${librarySource.value}:${item.id || item.artifact_id}`, name: item.name || item.title || '素材', type: item.type || item.media_type, local_path: item.local_path || item.media_path, url: resolveMediaUrl(item.local_path || item.media_path || item.url || item.media_url) })).filter(item => ['image','video','audio'].includes(item.type))
    libraryTotal.value = result?.pagination?.total || result?.total || 0
  } catch (error) { ElMessage.error(error?.message || '素材库暂时无法读取') }
  finally { libraryLoading.value = false }
}
function selectLibraryAsset(asset) {
  const type = asset.type
  if (mode.value === 'image' && type !== 'image') return ElMessage.info('图片生成请选择图片参考')
  const collection = collectionFor(type)
  if (!asset.url || asset.available === false) return ElMessage.warning('该文件尚未准备好，请先完成下载')
  if (collection.value.length >= limits.value[`${type}s`]) return ElMessage.warning(`参考${mediaTypeLabel(type)}已达到上限`)
  const reference = asset.local_path || asset.url
  if (collection.value.some(item => (item.local_path || item.url) === reference)) return ElMessage.info('该素材已经添加')
  collection.value.push({ asset_id: asset.id, filename: asset.name, local_path: asset.local_path, url: asset.url, mime_type: asset.mime_type })
  libraryVisible.value = false
}
watch([libraryType,librarySource], () => { libraryPage.value = 1; if (libraryVisible.value) loadLibraryAssets() })

function collectionFor(type) {
  return type === 'image' ? imageReferences : type === 'video' ? videoReferences : audioReferences
}

async function onReferenceFiles(type, event) {
  const input = event.target
  const files = Array.from(input.files || [])
  input.value = ''
  if (!files.length) return
  const collection = collectionFor(type)
  const maximum = limits.value[`${type}s`]
  if (collection.value.length + files.length > maximum) {
    ElMessage.error(`最多可添加 ${maximum} 个参考${type === 'image' ? '图' : type === 'video' ? '视频' : '音频'}`)
    return
  }
  uploadingType.value = type
  try {
    for (const file of files) {
      const saved = await uploadAPI.uploadReferenceMedia(file)
      collection.value.push({
        filename: saved.filename || file.name,
        local_path: saved.local_path,
        url: saved.url || `/static/${saved.local_path}`,
        mime_type: saved.mime_type || file.type,
      })
    }
  } finally {
    uploadingType.value = ''
  }
}

function removeReference(type, index) { collectionFor(type).value.splice(index, 1) }
function downloadItem(item) {
  if (!item.download_url) return ElMessage.info('请等待原文件下载并保存到素材库')
  const link = document.createElement('a'); link.href = item.download_url; link.click()
}
async function saveAsset(item) {
  try { await request.post(`/assets/import/${item.type}/${item.video_id || item.image_id}`); await loadHistory() }
  catch (error) { ElMessage.error(error.message || '登记失败') }
}
async function retryDownload(item) {
  try { await request.post(`/media-batches/${item.batch_id}/items/${item.id}/retry-download`); await loadHistory() }
  catch (error) { ElMessage.error(error.message || '重试下载失败') }
}
async function loadHistory() {
  try {
    const list = await mediaBatchAPI.list({ origin: 'manual', limit: 12, offset: (historyPage.value - 1) * 12 })
    const batches = await Promise.all((list.items || []).map(batch => mediaBatchAPI.get(batch.id)))
    results.value = batches.flatMap(batch => (batch.items || []).map(item => ({ ...item, type: item.kind, prompt: item.request?.prompt || batch.prompt, url: item.local_path ? resolveMediaUrl(item.local_path) : null, error: item.download_error || item.error_message, assetRegistered: Boolean(item.asset_id), fileSize: item.file_size })))
    historyTotal.value = list.total || 0
    historyError.value = ''
  } catch (error) { historyError.value = error.message || '暂时无法读取进度，后台任务仍保留' }
}
function taskState(item) {
  if (item.download_status === 'waiting_provider') return '服务端成片尚未就绪，正在恢复取回'
  if (item.status === 'completed') return item.download_url ? '已完成，原文件可下载' : '生成记录已完成，本地文件待恢复'
  if (item.can_retry_download) return '生成完成，等待恢复下载'
  if (item.generation_status === 'completed') return '生成完成，正在保存原文件'
  return ({ queued: '已排队', submitting: '正在提交', processing: '后台生成中', needs_review: '需要处理', failed: '生成失败' })[item.status] || '等待进展'
}
async function generate() {
  if (!prompt.value.trim() || generating.value) return
  const settings = { _origin: 'manual', style: style.value || undefined, aspect_ratio: aspectRatio.value,
    reference_image_urls: imageReferences.value.map(item => item.local_path || item.url),
    ...(mode.value === 'video' ? { duration: duration.value, resolution: videoCapability.value?.resolution || undefined,
      reference_video_urls: videoReferences.value.map(item => item.local_path || item.url), reference_audio_urls: audioReferences.value.map(item => item.local_path || item.url) } : {}) }
  const body = { kind: mode.value, title: `手动${mode.value === 'video' ? '视频' : '图片'} · ${prompt.value.slice(0,40)}`, prompt: prompt.value, model: mode.value === 'video' ? selectedVideoModel.value || undefined : undefined, concurrency: 1, settings, items: [{}] }
  const signature = JSON.stringify(body)
  // Reuse the request key after a lost response. Changing the request explicitly starts a different job.
  if (!submission || submission.signature !== signature) submission = { signature, key: `manual:${crypto.randomUUID()}` }
  try { sessionStorage.setItem('yinzi-pending-manual-submit', JSON.stringify(submission)) } catch {}
  generating.value = true
  try {
    await mediaBatchAPI.create({ ...body, idempotency_key: submission.key })
    submission = null; try { sessionStorage.removeItem('yinzi-pending-manual-submit') } catch {}
    historyPage.value = 1
    await loadHistory(); ElMessage.success('任务已交给后台，可以切换页面，稍后回来查看')
  } catch (error) { ElMessage.error(error.message || '暂未收到提交回执，再次点击会核对同一任务') }
  finally { generating.value = false }
}
useLiveRefresh(loadHistory, { active: () => results.value.some(item => ['queued','submitting','processing'].includes(item.status)), failed: () => Boolean(historyError.value) })
</script>

<style scoped>
.free-create-page { min-height: 100vh; background: var(--bg-page); padding: 20px; color: var(--text-primary); }
.page-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; }
.page-header h1 { margin: 0; font-size: 22px; letter-spacing: 0; }
.page-header p { margin: 4px 0 0; color: var(--text-muted); font-size: 13px; }
.create-layout { display: grid; grid-template-columns: minmax(360px, 440px) minmax(0, 1fr); gap: 18px; align-items: start; }
.input-panel, .result-panel { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 18px; }
.mode-tabs { margin-bottom: 14px; }
.form-section { margin-bottom: 16px; }
.form-label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
.field-note { color: var(--text-muted); font-size: 12px; }
.required { color: #d92d20; }
.full-width { width: 100%; }
.capability-line { display: flex; flex-wrap: wrap; gap: 6px 12px; margin-top: 8px; color: var(--text-muted); font-size: 12px; }
.reference-editor { border-top: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); padding: 14px 0 8px; }
.reference-heading { display: flex; justify-content: space-between; margin-bottom: 10px; }
.reference-group { padding: 8px 0; }
.reference-group + .reference-group { border-top: 1px solid var(--border-color); }
.reference-group-title { display: flex; align-items: center; justify-content: space-between; min-height: 32px; }
.reference-group-title > span { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 500; }
.media-list { display: grid; gap: 5px; margin-top: 5px; }
.media-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) 30px; align-items: center; gap: 8px; min-height: 34px; }
.media-row img { width: 28px; height: 28px; border-radius: 4px; object-fit: cover; }
.media-type-icon { width: 28px; font-size: 18px; color: var(--text-muted); }
.media-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-primary); }
.upload-state { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: var(--ui-info); font-size: 12px; }
.options-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.options-grid :deep(.el-input-number) { width: 100%; }
.generate-btn { width: 100%; }
.result-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.result-actions { display:flex; align-items:center; gap:8px; }
.result-header h2 { margin: 0; font-size: 16px; letter-spacing: 0; }
.empty-result { min-height: 320px; display: grid; place-content: center; justify-items: center; color: var(--text-muted); }
.empty-result .el-icon { font-size: 42px; }
.result-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.result-item { border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
.result-media { aspect-ratio: 16 / 9; background: var(--bg-inner); display: grid; place-items: center; overflow: hidden; }
.result-media video, .result-media img { width: 100%; height: 100%; object-fit: contain; }
.media-status { display: flex; flex-direction: column; align-items: center; gap: 6px; color: var(--text-primary); font-size: 12px; }
.media-status.error { color: var(--ui-danger); }
.result-meta { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; padding: 10px; }
.result-meta p { margin: 0; font-size: 12px; color: var(--text-muted); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.asset-register-ok,.asset-register-error { display:block; margin-top:5px; font-size:11px; line-height:1.4; }
.asset-register-ok { color:var(--ui-accent); }
.asset-register-error { color:var(--ui-warning); }
.preview-overlay { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; background: rgba(16, 24, 40, .9); }
.preview-overlay img { max-width: 92vw; max-height: 92vh; object-fit: contain; }
@media (max-width: 820px) {
  .free-create-page { padding: 12px; }
  .create-layout { grid-template-columns: minmax(0, 1fr); }
  .input-panel, .result-panel { padding: 14px; }
}
@media (max-width: 460px) {
  .options-grid { grid-template-columns: minmax(0, 1fr); }
  .capability-line { gap: 5px 10px; }
}
</style>


<style scoped>
.result-meta { flex-direction: column; align-items: stretch; }
.library-picker-toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
.library-picker-toolbar .el-select { width:145px; }
.library-picker-toolbar .el-input { flex:1; min-width:140px; }
.library-picker-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; max-height:55vh; overflow:auto; padding:4px; }
.library-picker-item { display:flex; flex-direction:column; gap:8px; text-align:left; padding:10px; border:1px solid var(--border-color); border-radius:10px; background:var(--bg-card); color:var(--text-primary); cursor:pointer; }
.library-picker-item:hover,.library-picker-item:focus-visible { border-color:var(--ui-accent); outline:2px solid var(--ui-accent); }
.library-picker-item img,.library-picker-icon { height:110px; width:100%; object-fit:contain; background:var(--bg-inner); }
.library-picker-icon { display:grid; place-items:center; font-size:32px; }
.library-picker-item strong { overflow-wrap:anywhere; }
.library-picker-item small { color:var(--text-muted); }
.result-progress { color:var(--text-primary); }
</style>
