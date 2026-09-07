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

          <div class="form-section reference-editor">
            <div class="reference-heading">
              <div>
                <div class="form-label">参考媒体</div>
                <div class="field-note">图片、视频和音频均按 reference 角色提交</div>
              </div>
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

            <div class="reference-group">
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

            <div class="reference-group">
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
        </template>

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
          <h2>生成结果</h2>
          <div class="result-actions">
            <el-button v-if="results.some((item) => item.assetRegistered)" size="small" plain @click="$router.push('/media-library')">查看素材库</el-button>
            <el-button v-if="results.length" size="small" plain @click="results = []">清空</el-button>
          </div>
        </div>
        <div v-if="!results.length && !generating" class="empty-result">
          <el-icon><MagicStick /></el-icon>
          <p>生成内容会显示在这里</p>
        </div>
        <div class="result-grid">
          <article v-for="(item, index) in results" :key="index" class="result-item">
            <div class="result-media">
              <video v-if="item.type === 'video' && item.url" :src="item.url" controls loop />
              <img v-else-if="item.type === 'image' && item.url" :src="item.url" :alt="item.prompt" @click="previewUrl = item.url" />
              <div v-else-if="item.status === 'processing'" class="media-status"><el-icon class="is-loading"><Loading /></el-icon><span>生成中</span></div>
              <div v-else class="media-status error"><el-icon><CircleClose /></el-icon><span>{{ item.error || '生成失败' }}</span></div>
            </div>
            <div class="result-meta">
              <p>{{ item.prompt }}</p>
              <small v-if="item.assetError" class="asset-register-error">素材库登记失败：{{ item.assetError }}</small>
              <small v-else-if="item.assetRegistered" class="asset-register-ok">已保存到素材库</small>
              <el-button v-if="item.url" size="small" plain @click="downloadItem(item)">下载</el-button>
            </div>
          </article>
        </div>
      </section>
    </main>

    <div v-if="previewUrl" class="preview-overlay" @click="previewUrl = null">
      <img :src="previewUrl" alt="图片预览" @click.stop />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import { ArrowLeft, CircleClose, Delete, Headset, Loading, MagicStick, Picture, Plus, VideoPlay } from '@element-plus/icons-vue'
import { imagesAPI } from '@/api/images'
import { videosAPI } from '@/api/videos'
import { uploadAPI } from '@/api/upload'
import { aiAPI } from '@/api/ai'
import { generationSettingsAPI } from '@/api/prompts'
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
const videoPollMaxMs = ref(30 * 60 * 1000)

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
  const [settingsResult, catalogResult, configsResult] = await Promise.allSettled([
    generationSettingsAPI.get(),
    aiAPI.getYinziCatalog(),
    aiAPI.list('video'),
  ])
  if (settingsResult.status === 'fulfilled') {
    const minutes = Math.max(1, Number(settingsResult.value?.video_generation_timeout_minutes) || 30)
    videoPollMaxMs.value = minutes * 60 * 1000
  }
  if (catalogResult.status === 'fulfilled') videoModels.value = catalogResult.value?.video || []
  if (configsResult.status === 'fulfilled') {
    const configs = Array.isArray(configsResult.value) ? configsResult.value : []
    const active = configs.find((item) => item.is_default) || configs[0]
    const configuredModel = active?.default_model || (Array.isArray(active?.model) ? active.model[0] : active?.model)
    if (configuredModel) selectedVideoModel.value = configuredModel
  }
  if (!selectedVideoModel.value && videoModels.value.length) selectedVideoModel.value = videoModels.value[0].model
})

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

function removeReference(type, index) {
  collectionFor(type).value.splice(index, 1)
}

function downloadItem(item) {
  if (!item.url) return
  const link = document.createElement('a')
  link.href = item.url
  link.download = `free_create_${Date.now()}.${item.type === 'video' ? 'mp4' : 'jpg'}`
  link.click()
}

async function registerAsset(item, generationId) {
  if (!generationId || item.assetRegistered) return
  try {
    const endpoint = item.type === 'video' ? `/assets/import/video/${generationId}` : `/assets/import/image/${generationId}`
    await request.post(endpoint)
    item.assetRegistered = true
  } catch (error) {
    item.assetError = error?.message || '素材库登记失败'
  }
}

async function generate() {
  if (!prompt.value.trim()) return
  const item = { type: mode.value, prompt: prompt.value, status: 'processing', url: null, error: null }
  results.value.unshift(item)
  generating.value = true
  try {
    if (mode.value === 'image') {
      const response = await imagesAPI.create({ prompt: prompt.value, style: style.value || undefined, aspect_ratio: aspectRatio.value })
      item.generationId = response?.id || response?.image_generation_id || null
      if (response?.task_id) await pollImageTask(response.task_id, item)
      else {
        item.url = response?.image_url || (response?.local_path ? `/static/${response.local_path}` : null)
        item.status = item.url ? 'completed' : 'failed'
      }
      if (item.status === 'completed') await registerAsset(item, item.generationId)
      return
    }
    const response = await videosAPI.create({
      prompt: prompt.value,
      style: style.value || undefined,
      model: selectedVideoModel.value || undefined,
      aspect_ratio: aspectRatio.value,
      duration: duration.value,
      resolution: videoCapability.value?.resolution || undefined,
      reference_image_urls: imageReferences.value.map((entry) => entry.local_path),
      reference_video_urls: videoReferences.value.map((entry) => entry.local_path),
      reference_audio_urls: audioReferences.value.map((entry) => entry.local_path),
    })
    item.generationId = response?.id || response?.video_generation_id || null
    if (response?.task_id) await pollVideoTask(response.task_id, item)
    else throw new Error('视频任务未返回任务 ID')
    if (item.status === 'completed') await registerAsset(item, item.generationId)
  } catch (error) {
    item.status = 'failed'
    item.error = error.message || '生成失败'
  } finally {
    generating.value = false
  }
}

async function pollImageTask(taskId, item, maxMs = 180000) {
  const { taskAPI } = await import('@/api/task')
  const started = Date.now()
  while (Date.now() - started < maxMs) {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const task = await taskAPI.get(taskId)
    if (task?.status === 'completed') {
      const result = typeof task.result === 'string' ? JSON.parse(task.result) : task.result
      item.url = result?.image_url || (result?.local_path ? `/static/${result.local_path}` : null)
      item.generationId = item.generationId || result?.image_generation_id || task?.image_generation_id || null
      item.status = item.url ? 'completed' : 'failed'
      if (item.status === 'completed') await registerAsset(item, item.generationId)
      return
    }
    if (task?.status === 'failed') throw new Error(task.error || '图片生成失败')
  }
  throw new Error('图片生成超时')
}

async function pollVideoTask(taskId, item) {
  const { taskAPI } = await import('@/api/task')
  const started = Date.now()
  while (Date.now() - started < videoPollMaxMs.value) {
    await new Promise((resolve) => setTimeout(resolve, 4000))
    const task = await taskAPI.get(taskId)
    if (task?.status === 'completed') {
      const result = typeof task.result === 'string' ? JSON.parse(task.result) : task.result
      const video = result?.video_generation_id ? await videosAPI.get(result.video_generation_id) : null
      item.url = video?.local_path ? `/static/${video.local_path}` : video?.video_url
      item.generationId = item.generationId || result?.video_generation_id || video?.id || null
      item.status = item.url ? 'completed' : 'failed'
      if (item.status === 'completed') await registerAsset(item, item.generationId)
      return
    }
    if (task?.status === 'failed') throw new Error(task.error || '视频生成失败')
  }
  throw new Error('视频生成超时')
}
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
