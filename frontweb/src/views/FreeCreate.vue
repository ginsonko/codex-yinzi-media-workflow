<template>
  <div class="free-create-page">
    <header class="page-header">
      <el-button text aria-label="返回" @click="$router.back()">
        <el-icon><ArrowLeft /></el-icon>
      </el-button>
      <div>
        <span class="page-kicker">手动创作</span>
        <h1>自由创作</h1>
        <p>这一页在管单条生成：一条提示词、一组参考素材、一个模型和一组参数。提示词、模型、画幅、时长、风格都在左边直接改，改过的值会记住下次接着用。点「生成」不会立刻提交，先摊开一次预览给你改和确认，确认了才真的调用上游模型。</p>
      </div>
      <div class="header-links">
        <router-link to="/batch">批量生成</router-link>
        <router-link to="/history">历史记录</router-link>
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
            <el-select v-model="selectedVideoModel" filterable allow-create default-first-option class="full-width" placeholder="使用默认视频模型，或输入模型名">
              <el-option v-for="item in videoModels" :key="item.model" :label="item.model" :value="item.model" />
            </el-select>
            <div v-if="videoCapability" class="capability-line">
              <span>{{ videoCapability.max_images }} 图</span>
              <span>{{ videoCapability.max_videos }} 视频</span>
              <span>{{ videoCapability.max_audios }} 音频</span>
              <span>{{ videoCapability.duration_min }}-{{ videoCapability.duration_max }} 秒</span>
              <span>{{ videoCapability.resolution }}</span>
            </div>
            <div v-else class="field-note">没有读到这个模型的目录能力，参数会按你填写的值原样提交。</div>
          </div>
        </template>
        <template v-else>
          <div class="form-section">
            <label class="form-label">图片模型</label>
            <el-select v-model="selectedImageModel" clearable filterable allow-create default-first-option class="full-width" placeholder="使用系统默认图片模型，或输入模型名">
              <el-option v-for="item in imageModelOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
            <div class="field-note">留空时按已保存的默认图片配置提交；服务器配置里没有的模型名也可以直接输入。</div>
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
                <span><el-icon><Picture /></el-icon> 图片 {{ imageReferences.length }}<small v-if="limits.images != null"> · 目录参考 {{ limits.images }}</small></span>
                <el-tooltip content="添加参考图" placement="top">
                  <el-button circle size="small" :disabled="isUploading" @click="imageInput?.click()">
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
                <span><el-icon><VideoPlay /></el-icon> 视频 {{ videoReferences.length }}<small v-if="limits.videos != null"> · 目录参考 {{ limits.videos }}</small></span>
                <el-tooltip content="添加参考视频" placement="top">
                  <el-button circle size="small" :disabled="isUploading" @click="videoInput?.click()">
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
                <span><el-icon><Headset /></el-icon> 音频 {{ audioReferences.length }}<small v-if="limits.audios != null"> · 目录参考 {{ limits.audios }}</small></span>
                <el-tooltip content="添加参考音频" placement="top">
                  <el-button circle size="small" :disabled="isUploading" @click="audioInput?.click()">
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
            <el-input-number v-model="duration" :min="1" :step="1" controls-position="right" />
          </div>
        </div>

        <el-button
          type="primary"
          size="large"
          :loading="generating"
          :disabled="!prompt.trim() || isUploading"
          class="generate-btn"
          @click="openPreview"
        >
          {{ generating ? '生成中' : (mode === 'image' ? '生成图片' : '生成视频') }}
        </el-button>
        <p class="field-note submit-note">点开后先看这次的提示词、参数和参考素材清单，确认了才提交。</p>
        <div v-if="submission && !generating" class="pending-submission-note" role="status">
          <p class="field-note">上次提交尚未收到回执。按原参数再次提交会恢复原请求；也可按当前参数直接新建一次。原任务和费用记录仍保留。</p>
          <el-button plain :disabled="!prompt.trim() || isUploading" @click="openPreview(true)">直接新建一次</el-button>
        </div>
      </section>

      <section class="result-panel">
        <div class="result-header">
          <h2>我的手动任务</h2>
          <div class="result-actions">
            <el-button v-if="results.some((item) => item.assetRegistered)" size="small" plain @click="$router.push('/media-library?source=upload')">查看素材库</el-button>
            <el-button size="small" plain :loading="historyLoading" @click="loadHistory">刷新进度</el-button>
          </div>
        </div>
        <el-alert v-if="historyError" :title="historyError" type="warning" :closable="false" />
        <p class="field-note">任务与结果保存在后台，切换页面或重开浏览器都可以继续查看。</p>
        <div v-if="results.length" class="result-toolbar">
          <el-select v-model="resultFilter" size="small" aria-label="结果筛选"><el-option label="全部状态" value="all" /><el-option label="还在跑" value="running" /><el-option label="已完成" value="completed" /><el-option label="失败或待处理" value="failed" /></el-select>
          <el-select v-model="resultSort" size="small" aria-label="结果排序"><el-option label="按提交时间" value="time" /><el-option label="按状态" value="status" /></el-select>
          <el-radio-group v-model="resultDirection" size="small" aria-label="排序方向"><el-radio-button value="desc">新的在前</el-radio-button><el-radio-button value="asc">旧的在前</el-radio-button></el-radio-group>
          <span class="toolbar-note">当前显示 {{ visibleResults.length }} / {{ results.length }} 条</span>
        </div>
        <div v-if="!results.length && !generating" class="empty-result">
          <el-icon><MagicStick /></el-icon>
          <strong>还没有手动任务</strong>
          <p>在左边写下提示词就能生成第一条；也可以让 Codex 接更复杂的需求。</p>
          <div class="empty-actions">
            <el-button type="primary" @click="focusPrompt">先写一条提示词</el-button>
            <el-button plain @click="$router.push('/batch')">要做很多条就走批量</el-button>
            <el-button plain @click="$router.push('/codex-console')">复杂需求交给 Codex</el-button>
          </div>
        </div>
        <div v-else-if="!visibleResults.length" class="empty-result">
          <strong>没有符合当前筛选的任务</strong>
          <p>换成「全部状态」可以看到这一页的全部结果。</p>
          <div class="empty-actions"><el-button type="primary" @click="resultFilter = 'all'">显示全部状态</el-button></div>
        </div>
        <div v-else class="result-grid">
          <article v-for="item in visibleResults" :key="item.key" class="result-item">
            <div class="result-media">
              <video v-if="item.type === 'video' && item.url" :src="item.url" controls loop />
              <img v-else-if="item.type === 'image' && item.url" :src="item.url" :alt="item.prompt" @click="previewUrl = item.url" />
              <div v-else-if="['queued','submitting','processing'].includes(item.status)" class="media-status"><el-icon class="is-loading"><Loading /></el-icon><span>{{ taskState(item) }}</span></div>
              <div v-else class="media-status error"><el-icon><CircleClose /></el-icon><span>{{ item.error || (item.status === 'completed' ? '本地文件尚不可预览，可让 Codex 检查原记录' : '请查看任务状态') }}</span></div>
            </div>
            <div class="result-meta">
              <div class="result-text">
                <p>{{ item.prompt }}</p>
                <small class="result-progress"><span :class="['dot', resultTone(item)]"></span>{{ taskState(item) }}</small>
                <small v-if="item.provider_updated_at" class="field-note">任务最后更新：{{ new Date(item.provider_updated_at).toLocaleString('zh-CN', { hour12: false }) }}</small>
                <small v-if="item.fileSize" class="result-size">文件大小：{{ formatBytes(item.fileSize) }}</small>
                <small v-if="item.assetError" class="asset-register-error">素材库登记失败：{{ item.assetError }}。可以点「保存到素材库」再试一次，文件本身还在。</small>
                <small v-else-if="item.assetRegistered" class="asset-register-ok">已保存到素材库</small>
              </div>
              <div class="result-buttons">
                <el-button size="small" type="primary" :loading="retrying.has(item.id)" @click="retryGeneration(item)">重新生成一次</el-button>
                <el-button v-if="item.download_url" size="small" type="primary" plain @click="downloadItem(item)">下载原文件</el-button><el-button v-else-if="item.local_path" size="small" plain @click="saveAsset(item)">保存到素材库</el-button><el-button v-if="item.can_retry_download" size="small" plain @click="retryDownload(item)">重试下载（不重新生成）</el-button>
              </div>
            </div>
          </article>
        </div>
        <el-pagination v-if="historyTotal > 12" v-model:current-page="historyPage" :page-size="12" :total="historyTotal" layout="prev, pager, next" @current-change="loadHistory" />
      </section>
    </main>

    <el-dialog v-model="previewVisible" title="确认这次要生成什么" width="min(720px, 94vw)">
      <p class="dialog-note">提交前先看一遍。提示词和参数都可以直接在这里改，改完仍然按新值提交。</p>
      <label class="form-label" for="preview-prompt">提示词</label>
      <el-input id="preview-prompt" v-model="prompt" type="textarea" :rows="4" />
      <div class="preview-grid">
        <span><small>类型</small><strong>{{ mode === 'image' ? '图片' : '视频' }}</strong></span>
        <span><small>模型</small><strong>{{ previewModelName }}</strong></span>
        <span><small>画幅</small><strong>{{ aspectRatio }}</strong></span>
        <span><small>{{ mode === 'video' ? '时长' : '风格' }}</small><strong>{{ mode === 'video' ? duration + ' 秒' : (style || '未设置') }}</strong></span>
        <span><small>参考素材</small><strong>{{ referenceCounts }}</strong></span>
        <span><small>预估费用</small><strong :class="estimate.tone">{{ estimate.text }}</strong></span>
      </div>
      <p class="dialog-note">提交后：这一条会立刻交给后台生成，成功或失败都会单独记账；失败可以只重试这一条，也可以稍后单独重试下载而不重新生成。提示词和参考素材按原样提交，不会额外扩写。</p>
      <template #footer>
        <el-button @click="previewVisible = false">回去改</el-button>
        <el-button type="primary" :loading="generating" @click="confirmGenerate">{{ previewFresh ? '直接新建一次' : (mode === 'image' ? '确认生成图片' : '确认生成视频') }}</el-button>
      </template>
    </el-dialog>

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
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, CircleClose, Delete, FolderOpened, Headset, Loading, MagicStick, Picture, Plus, VideoPlay } from '@element-plus/icons-vue'
import { mediaBatchAPI } from '@/api/mediaBatch'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { resolveMediaUrl } from '@/utils/mediaUrl'
import { uploadAPI } from '@/api/upload'
import { aiAPI } from '@/api/ai'
import { advancedSettingsAPI } from '@/api/advancedSettings'
import { batchModelOptions, batchModelSelection } from '@/utils/batchModels'
import request from '@/utils/request'

const mode = ref('image')
const route = useRoute()
const prompt = ref(typeof route.query.prompt === 'string' ? route.query.prompt : '')
const style = ref('')
const aspectRatio = ref('16:9')
const duration = ref(5)
const generating = ref(false)
const retrying = reactive(new Set())
const uploadingType = ref('')
const results = ref([])
const previewUrl = ref(null)
const videoModels = ref([])
const selectedVideoModel = ref('')
const selectedImageModel = ref('')
const imageModelOptions = ref([])
const previewVisible = ref(false)
const previewFresh = ref(false)
const prices = ref([])
const resultFilter = ref('all')
const resultSort = ref('time')
const resultDirection = ref('desc')
const prefsKey = 'yinzi-free-create-prefs-v1'
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
const historyLoading = ref(false)
const libraryPage = ref(1)
const libraryTotal = ref(0)
const libraryType = ref('image')
const librarySource = ref('upload')
const submission = ref(null)
try { submission.value = JSON.parse(sessionStorage.getItem('yinzi-pending-manual-submit') || 'null') } catch {}

/* 记住上次用的值：模型、画幅、时长、风格。恢复的值优先于目录默认值。 */
try {
  const saved = JSON.parse(localStorage.getItem(prefsKey) || 'null')
  if (saved && typeof saved === 'object') {
    if (saved.mode === 'image' || saved.mode === 'video') mode.value = saved.mode
    if (typeof saved.style === 'string') style.value = saved.style
    if (typeof saved.aspectRatio === 'string' && saved.aspectRatio) aspectRatio.value = saved.aspectRatio
    if (Number.isFinite(Number(saved.duration)) && Number(saved.duration) > 0) duration.value = Number(saved.duration)
    if (typeof saved.videoModel === 'string') selectedVideoModel.value = saved.videoModel
    if (typeof saved.imageModel === 'string') selectedImageModel.value = saved.imageModel
    if (typeof saved.resultFilter === 'string') resultFilter.value = saved.resultFilter
    if (typeof saved.resultSort === 'string') resultSort.value = saved.resultSort
    if (typeof saved.resultDirection === 'string') resultDirection.value = saved.resultDirection
  }
} catch {}
watch([mode, style, aspectRatio, duration, selectedVideoModel, selectedImageModel, resultFilter, resultSort, resultDirection], () => {
  try {
    localStorage.setItem(prefsKey, JSON.stringify({ mode: mode.value, style: style.value, aspectRatio: aspectRatio.value, duration: duration.value, videoModel: selectedVideoModel.value, imageModel: selectedImageModel.value, resultFilter: resultFilter.value, resultSort: resultSort.value, resultDirection: resultDirection.value }))
  } catch {}
})

/* 结果列表的筛选与排序：只作用于服务端返回的当前这一页 */
const resultStatusRank = { queued: 0, submitting: 1, processing: 2, needs_review: 3, failed: 4, completed: 5 }
function resultTone(item) {
  if (item.status === 'completed') return 'success'
  if (item.status === 'failed') return 'danger'
  if (item.status === 'needs_review') return 'warning'
  return 'active'
}
const visibleResults = computed(() => {
  const rows = results.value.filter((item) => {
    if (resultFilter.value === 'all') return true
    if (resultFilter.value === 'running') return ['queued', 'submitting', 'processing'].includes(item.status)
    if (resultFilter.value === 'completed') return item.status === 'completed'
    if (resultFilter.value === 'failed') return ['failed', 'needs_review'].includes(item.status)
    return true
  })
  const direction = resultDirection.value === 'asc' ? 1 : -1
  return rows.slice().sort((a, b) => {
    if (resultSort.value === 'status') return ((resultStatusRank[a.status] ?? 9) - (resultStatusRank[b.status] ?? 9)) * direction
    return ((new Date(a.updated_at || a.submitted_at || 0)) - (new Date(b.updated_at || b.submitted_at || 0))) * direction
  })
})

/* 费用预估：只读本机价格表里已有的价格项，读不到就明说读不到 */
function formatUsd(value) { return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : '—' }
const previewModelName = computed(() => mode.value === 'video' ? (selectedVideoModel.value || '默认视频模型') : (batchModelSelection(selectedImageModel.value, imageModelOptions.value, 'image').model || '默认图片模型'))
const referenceCounts = computed(() => {
  const parts = [`图片 ${imageReferences.value.length}`]
  if (mode.value === 'video') { parts.push(`视频 ${videoReferences.value.length}`, `音频 ${audioReferences.value.length}`) }
  return parts.join(' · ')
})
const estimate = computed(() => {
  const kind = mode.value
  const model = kind === 'video' ? selectedVideoModel.value : batchModelSelection(selectedImageModel.value, imageModelOptions.value, 'image').model
  if (!model) return { text: '预估不可用（未选定模型）', tone: 'unknown' }
  const serviceType = kind === 'video' ? 'video' : 'image'
  const candidates = prices.value.filter(row => row.enabled !== false && String(row.service_type) === serviceType && String(row.model).trim() === String(model).trim())
  const price = candidates[0]
  if (!price) return { text: '价格表里没有这个模型', tone: 'unknown' }
  const unitPrice = Number(price.unit_price_usd)
  const unit = String(price.billing_unit || '')
  let total = null
  if (unit === 'per_second') total = unitPrice * Math.max(1, Number(duration.value) || 1)
  else if (['per_request', 'per_image'].includes(unit)) total = unitPrice
  else if (unit === 'per_character') total = unitPrice * Math.max(1, prompt.value.length)
  if (!Number.isFinite(total)) return { text: `${unit || '未知计价'}，无法估算`, tone: 'unknown' }
  return { text: `约 ${formatUsd(total)}（本地价格表，非账单）`, tone: 'ok' }
})

const videoCapability = computed(() => videoModels.value.find((item) => item.model === selectedVideoModel.value)?.capabilities || null)
const limits = computed(() => ({
  images: videoCapability.value?.max_images ?? null,
  videos: videoCapability.value?.max_videos ?? null,
  audios: videoCapability.value?.max_audios ?? null,
}))
const isUploading = computed(() => Boolean(uploadingType.value))

onMounted(async () => {
  const [catalogResult, configsResult, imageConfigsResult, pricesResult] = await Promise.allSettled([
    aiAPI.getYinziCatalog(),
    aiAPI.list('video'),
    aiAPI.list('image'),
    advancedSettingsAPI.listPrices({}),
  ])
  if (catalogResult.status === 'fulfilled') videoModels.value = catalogResult.value?.video || []
  if (imageConfigsResult.status === 'fulfilled') {
    const configs = Array.isArray(imageConfigsResult.value) ? imageConfigsResult.value : (imageConfigsResult.value?.items || [])
    imageModelOptions.value = batchModelOptions(Array.isArray(configs) ? configs : [])
  }
  if (pricesResult.status === 'fulfilled') prices.value = (Array.isArray(pricesResult.value?.items) ? pricesResult.value.items : []).filter(row => row?.enabled !== false)
  if (configsResult.status === 'fulfilled' && !selectedVideoModel.value) {
    const configs = Array.isArray(configsResult.value) ? configsResult.value : []
    const active = configs.find((item) => item.is_default) || configs[0]
    const configuredModel = active?.default_model || (Array.isArray(active?.model) ? active.model[0] : active?.model)
    if (configuredModel) selectedVideoModel.value = configuredModel
  }
  if (!selectedVideoModel.value && videoModels.value.length) selectedVideoModel.value = videoModels.value[0].model
})

function openPreview(fresh = false) {
  if (!prompt.value.trim() || generating.value) return
  previewFresh.value = fresh === true
  previewVisible.value = true
}
function confirmGenerate() {
  previewVisible.value = false
  return generate(previewFresh.value)
}
function focusPrompt() {
  previewVisible.value = false
  const el = document.getElementById('creation-prompt')
  el?.focus()
}

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
async function retryGeneration(item) {
  if (!item?.batch_id || !item?.id || retrying.has(item.id)) return
  retrying.add(item.id)
  try {
    await mediaBatchAPI.retry(item.batch_id, item.id, {
      expected_attempt: item.attempt,
      request_key: `manual-retry:${item.batch_id}:${item.id}:${item.attempt}`,
    })
    await loadHistory()
    ElMessage.success('已开始新尝试，原任务和费用记录仍保留')
  } catch (error) { ElMessage.error(error.message || '暂未收到重试回执，可继续核对同一请求') }
  finally { retrying.delete(item.id) }
}
let historyRead = 0
async function loadHistory() {
  const read = ++historyRead
  historyLoading.value = true
  try {
    const list = await mediaBatchAPI.list({ origin: 'manual', limit: 12, offset: (historyPage.value - 1) * 12 })
    const batches = await Promise.all((list.items || []).map(batch => mediaBatchAPI.get(batch.id)))
    if (read !== historyRead) return
    results.value = batches.flatMap(batch => (batch.items || []).map(item => ({ ...item, key: `${batch.id}:${item.id}`, type: item.kind, prompt: item.request?.prompt || batch.prompt, url: item.local_path ? resolveMediaUrl(item.local_path) : null, error: item.download_error || item.error_message, assetRegistered: Boolean(item.asset_id), fileSize: item.file_size })))
    historyTotal.value = list.total || 0
    historyError.value = ''
  } catch (error) { if (read === historyRead) historyError.value = `${error.message || '暂时无法读取进度'}。后台任务仍保留；可以点「刷新进度」重试，或者去历史记录页查看同一批任务。` }
  finally { if (read === historyRead) historyLoading.value = false }
}
function taskState(item) {
  if (item.download_status === 'waiting_provider') return '服务端成片尚未就绪，正在恢复取回'
  if (item.status === 'completed') return item.download_url ? '已完成，原文件可下载' : '生成记录已完成，本地文件待恢复'
  if (item.can_retry_download) return '生成完成，等待恢复下载'
  if (item.generation_status === 'completed') return '生成完成，正在保存原文件'
  return ({ queued: '已排队', submitting: '正在提交', processing: '后台生成中', needs_review: '需要处理', failed: '生成失败' })[item.status] || '等待进展'
}
async function generate(fresh = false) {
  if (!prompt.value.trim() || generating.value) return
  const settings = { _origin: 'manual', style: style.value || undefined, aspect_ratio: aspectRatio.value,
    reference_image_urls: imageReferences.value.map(item => item.local_path || item.url),
    ...(mode.value === 'video' ? { duration: duration.value, resolution: videoCapability.value?.resolution || undefined,
      reference_video_urls: videoReferences.value.map(item => item.local_path || item.url), reference_audio_urls: audioReferences.value.map(item => item.local_path || item.url) } : {}) }
  const body = { kind: mode.value, title: `手动${mode.value === 'video' ? '视频' : '图片'} · ${prompt.value.slice(0,40)}`, prompt: prompt.value, model: mode.value === 'video' ? (selectedVideoModel.value || undefined) : undefined, concurrency: 1, settings, items: [{}] }
  const signature = JSON.stringify(body)
  // Transport recovery keeps its key; an explicit fresh click starts a new attempt.
  if (fresh === true || !submission.value || submission.value.signature !== signature) submission.value = { signature, key: `manual:${crypto.randomUUID()}` }
  try { sessionStorage.setItem('yinzi-pending-manual-submit', JSON.stringify(submission.value)) } catch {}
  generating.value = true
  try {
    await mediaBatchAPI.create({ ...body, idempotency_key: submission.value.key })
    submission.value = null; try { sessionStorage.removeItem('yinzi-pending-manual-submit') } catch {}
    historyPage.value = 1
    await loadHistory(); ElMessage.success('任务已交给后台，可以切换页面，稍后回来查看')
  } catch (error) { ElMessage.error(error.message || '暂未收到提交回执，再次点击会核对同一任务') }
  finally { generating.value = false }
}
useLiveRefresh(loadHistory, { active: () => results.value.some(item => ['queued','submitting','processing'].includes(item.status)), failed: () => Boolean(historyError.value) })
</script>

<style scoped>
.free-create-page { min-height: 100%; background: var(--bg-page); padding: 20px 0; color: var(--text-primary); }
.page-header { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 18px; }
.page-header h1 { margin: 4px 0 0; font-family: var(--font-display); font-size: 24px; font-weight: 600; color: var(--text-bright); letter-spacing: 0; }
.page-header p { max-width: 820px; margin: 6px 0 0; color: var(--text-muted); font-size: 13px; line-height: 1.75; }
.page-kicker { display: block; color: var(--text-subtle); font-size: 12px; }
.header-links { display: flex; gap: 12px; margin-left: auto; padding-top: 4px; }
.header-links a { color: var(--ui-accent); font-size: 12px; text-decoration: none; }
.header-links a:hover { color: var(--text-bright); }
.create-layout { display: grid; grid-template-columns: minmax(360px, 440px) minmax(0, 1fr); gap: 16px; align-items: start; }
.input-panel, .result-panel { background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 18px; }
.mode-tabs { margin-bottom: 14px; }
.form-section { margin-bottom: 16px; }
.form-label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; }
.field-note { color: var(--text-muted); font-size: 12px; }
.required { color: var(--text-subtle); font-size: 11px; font-weight: 400; }
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
.empty-result { min-height: 300px; display: grid; place-content: center; justify-items: center; gap: 8px; color: var(--text-muted); text-align: center; }
.empty-result .el-icon { font-size: 36px; color: var(--text-subtle); }
.empty-result strong { color: var(--text-primary); font-size: 14px; }
.empty-result p { max-width: 460px; margin: 0; font-size: 12px; line-height: 1.7; }
.empty-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; margin-top: 6px; }
.result-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0 14px; padding-bottom: 12px; border-bottom: 1px solid var(--border-color); }
.result-toolbar .el-select { width: auto; min-width: 118px; }
.toolbar-note { margin-left: auto; color: var(--text-subtle); font-size: 11px; }
.result-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.result-item { display: grid; grid-template-rows: auto 1fr; border: 1px solid var(--border-color); border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-inner); }
.result-media { aspect-ratio: 16 / 9; background: var(--bg-deep); display: grid; place-items: center; overflow: hidden; }
.result-media video, .result-media img { width: 100%; height: 100%; object-fit: contain; }
.media-status { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0 12px; color: var(--text-muted); font-size: 12px; text-align: center; }
.media-status.error { color: var(--ui-danger); }
.result-meta { display: flex; flex-direction: column; gap: 8px; padding: 11px; }
.result-text { display: grid; gap: 5px; }
.result-text p { margin: 0; font-size: 12px; color: var(--text-primary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.result-progress { display: flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 11px; }
.dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--text-faint); }
.dot.success { background: var(--ui-success); }
.dot.danger { background: var(--ui-danger); }
.dot.warning { background: var(--ui-warning); }
.dot.active { background: var(--ui-warning); }
.result-buttons { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.result-buttons .el-button + .el-button { margin-left: 0; }
.asset-register-ok,.asset-register-error { display:block; font-size:11px; line-height:1.5; }
.asset-register-ok { color: var(--ui-success); }
.asset-register-error { color: var(--ui-warning); }
.preview-grid { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid var(--border-color); background: var(--bg-inner); margin: 14px 0; }
.preview-grid > span { display: grid; gap: 4px; min-width: 0; padding: 10px 12px; border-right: 1px solid var(--border-color); border-bottom: 1px solid var(--border-color); }
.preview-grid small { color: var(--text-subtle); font-size: 11px; }
.preview-grid strong { color: var(--text-primary); font-size: 12px; overflow-wrap: anywhere; }
.preview-grid strong.ok { font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.preview-grid strong.unknown { color: var(--text-subtle); font-weight: 400; }
.dialog-note { color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.submit-note { margin: 8px 0 0; text-align: center; }
.preview-overlay { position: fixed; inset: 0; z-index: 9999; display: grid; place-items: center; background: rgba(8, 10, 13, .92); }
.preview-overlay img { max-width: 92vw; max-height: 92vh; object-fit: contain; }
@media (max-width: 820px) {
  .free-create-page { padding: 12px 0; }
  .create-layout { grid-template-columns: minmax(0, 1fr); }
  .input-panel, .result-panel { padding: 14px; }
  .header-links { display: none; }
}
@media (max-width: 460px) {
  .options-grid { grid-template-columns: minmax(0, 1fr); }
  .capability-line { gap: 5px 10px; }
  .preview-grid { grid-template-columns: 1fr; }
}
</style>


<style scoped>
.library-picker-toolbar { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:16px; }
.library-picker-toolbar .el-select { width:145px; }
.library-picker-toolbar .el-input { flex:1; min-width:140px; }
.library-picker-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:12px; max-height:55vh; overflow:auto; padding:4px; }
.library-picker-item { display:flex; flex-direction:column; gap:8px; text-align:left; padding:10px; border:1px solid var(--border-color); border-radius:var(--radius-sm); background:var(--bg-inner); color:var(--text-primary); cursor:pointer; }
.library-picker-item:hover,.library-picker-item:focus-visible { border-color:var(--border-bright); outline:2px solid var(--ui-accent); }
.library-picker-item img,.library-picker-icon { height:110px; width:100%; object-fit:contain; background:var(--bg-deep); }
.library-picker-icon { display:grid; place-items:center; font-size:32px; color: var(--text-subtle); }
.library-picker-item strong { overflow-wrap:anywhere; font-size: 12px; }
.library-picker-item small { color:var(--text-muted); font-size: 11px; }
</style>
