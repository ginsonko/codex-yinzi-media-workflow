<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="min(820px, 94vw)"
    destroy-on-close
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    @update:model-value="closeDialog"
  >
    <div class="workflow-upload-dialog" @paste="handlePaste">
      <div
        class="upload-drop-zone"
        :class="{ 'is-dragging': dragging, 'is-disabled': busy }"
        tabindex="0"
        @dragenter.prevent="dragging = true"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="handleDrop"
      >
        <el-icon><UploadFilled /></el-icon>
        <strong>拖入文件或选择文件</strong>
        <span v-if="expectedMediaType === 'image'">也可以直接粘贴剪贴板图片</span>
        <el-button type="primary" :disabled="busy" @click="openFilePicker">选择文件</el-button>
        <input ref="fileInput" class="hidden-file-input" type="file" :accept="accept" multiple @change="handleFileInput" />
      </div>

      <el-alert v-if="description" type="info" :closable="false" :title="description" show-icon />
      <el-alert v-if="targetConflict" type="error" :closable="false" title="每个文件必须分配到不同目标，请调整后再上传。" show-icon />

      <div v-if="queue.length" class="upload-queue">
        <article v-for="item in queue" :key="item.id" class="upload-item" :class="`is-${item.status}`">
          <div class="upload-item-main">
            <div class="upload-file-icon">
              <el-icon v-if="item.status === 'uploaded'"><CircleCheck /></el-icon>
              <el-icon v-else-if="item.status === 'failed' || item.status === 'rejected'"><Warning /></el-icon>
              <el-icon v-else><UploadFilled /></el-icon>
            </div>
            <div class="upload-file-copy">
              <strong :title="item.file.name">{{ item.file.name }}</strong>
              <small>{{ fileMeta(item) }} · {{ statusLabel(item.status) }}</small>
            </div>
            <el-select
              v-if="targets.length"
              v-model="item.targetKey"
              class="upload-target-select"
              size="small"
              placeholder="选择目标"
              :disabled="busy || item.status === 'uploaded'"
            >
              <el-option
                v-for="target in targets"
                :key="target.key"
                :label="target.label"
                :value="target.key"
                :disabled="targetUsedByOther(target.key, item.id)"
              />
            </el-select>
            <div class="upload-item-actions">
              <el-button
                v-if="item.status === 'failed'"
                :icon="RefreshRight"
                circle
                title="重试"
                :disabled="busy"
                @click="retryItem(item)"
              />
              <el-button
                v-if="!['uploading', 'uploaded'].includes(item.status)"
                :icon="Delete"
                circle
                title="移除"
                :disabled="busy"
                @click="removeItem(item.id)"
              />
            </div>
          </div>
          <el-progress v-if="item.status === 'uploading'" :percentage="item.progress" :stroke-width="6" />
          <div v-if="item.errors.length || item.warnings.length" class="upload-messages">
            <span v-for="message in item.errors" :key="`error-${message}`" class="is-error">{{ message }}</span>
            <span v-for="message in item.warnings" :key="`warning-${message}`" class="is-warning">{{ message }}</span>
          </div>
        </article>
      </div>

      <div v-else class="upload-empty">尚未选择文件</div>
    </div>

    <template #footer>
      <div class="upload-footer">
        <span>{{ uploadedCount }} 已完成 · {{ failedCount }} 需处理</span>
        <div>
          <el-button :disabled="busy" @click="closeDialog(false)">关闭</el-button>
          <el-button type="primary" :loading="busy" :disabled="!canStart" @click="startUpload()">
            上传 {{ readyCount }} 个文件
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { CircleCheck, Delete, RefreshRight, UploadFilled, Warning } from '@element-plus/icons-vue'
import { uploadAPI } from '@/api/upload'
import { describeWorkflowFile, preflightWorkflowFiles } from '@/utils/workflowUploads'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  title: { type: String, default: '上传媒体' },
  description: { type: String, default: '' },
  accept: { type: String, default: '*/*' },
  expectedMediaType: { type: String, required: true },
  endpoint: { type: String, default: 'reference' },
  dramaId: { type: [Number, String], default: null },
  capability: { type: Object, default: () => ({}) },
  currentItems: { type: Array, default: () => [] },
  targets: { type: Array, default: () => [] },
  initialTargetKey: { type: String, default: '' },
  maxFiles: { type: Number, default: null },
  enforceContractLimits: { type: Boolean, default: true },
  concurrency: { type: Number, default: 3 },
  commitUpload: { type: Function, required: true },
})

const emit = defineEmits(['update:modelValue', 'finished'])
const fileInput = ref(null)
const queue = ref([])
const busy = ref(false)
const dragging = ref(false)
let itemSequence = 0

const readyItems = computed(() => queue.value.filter((item) => item.status === 'ready'))
const readyCount = computed(() => readyItems.value.length)
const uploadedCount = computed(() => queue.value.filter((item) => item.status === 'uploaded').length)
const failedCount = computed(() => queue.value.filter((item) => ['failed', 'rejected'].includes(item.status)).length)
const targetConflict = computed(() => {
  if (!props.targets.length) return false
  const keys = readyItems.value.map((item) => item.targetKey).filter(Boolean)
  return keys.length !== readyItems.value.length || new Set(keys).size !== keys.length
})
const canStart = computed(() => !busy.value && readyCount.value > 0 && !targetConflict.value)

watch(() => props.modelValue, (visible) => {
  if (!visible) return
  queue.value = []
  busy.value = false
  dragging.value = false
  nextTick(() => fileInput.value && (fileInput.value.value = ''))
})

function closeDialog(value) {
  if (busy.value) return
  emit('update:modelValue', Boolean(value))
}

function openFilePicker() {
  if (!busy.value) fileInput.value?.click()
}

function handleFileInput(event) {
  addFiles(event.target?.files)
  if (event.target) event.target.value = ''
}

function handleDrop(event) {
  dragging.value = false
  if (!busy.value) addFiles(event.dataTransfer?.files)
}

function handlePaste(event) {
  if (busy.value || props.expectedMediaType !== 'image') return
  const files = [...(event.clipboardData?.files || [])].filter((file) => String(file.type || '').startsWith('image/'))
  if (files.length) {
    event.preventDefault()
    addFiles(files)
  }
}

async function addFiles(fileList) {
  const files = [...(fileList || [])]
  if (!files.length) return
  const additions = files.map((file) => ({
    id: `upload-${Date.now()}-${itemSequence += 1}`,
    file,
    descriptor: null,
    targetKey: '',
    status: 'inspecting',
    progress: 0,
    errors: [],
    warnings: [],
  }))
  queue.value.push(...additions)
  await Promise.all(additions.map(async (item) => {
    item.descriptor = await describeWorkflowFile(item.file)
  }))
  applyPreflight()
  assignTargets()
}

function applyPreflight() {
  const candidates = queue.value.filter((item) => !['uploading', 'uploaded'].includes(item.status) && item.descriptor)
  const result = preflightWorkflowFiles(candidates.map((item) => item.descriptor), {
    expectedMediaType: props.expectedMediaType,
    capability: props.capability,
    currentItems: props.currentItems,
    maxFiles: props.maxFiles,
    enforceContractLimits: props.enforceContractLimits,
    allowRepeatedContent: props.targets.length > 0,
    defaults: props.endpoint === 'image'
      ? { max_image_bytes: 16 * 1024 * 1024 }
      : { max_image_bytes: 30 * 1024 * 1024, max_video_bytes: 50 * 1024 * 1024, max_audio_bytes: 15 * 1024 * 1024 },
  })
  result.results.forEach((checked, index) => {
    const item = candidates[index]
    item.errors = checked.errors
    item.warnings = [...new Set(checked.warnings)]
    item.status = checked.accepted ? 'ready' : 'rejected'
  })
}

function assignTargets() {
  if (!props.targets.length) return
  const orderedTargets = [
    ...props.targets.filter((target) => target.key === props.initialTargetKey),
    ...props.targets.filter((target) => target.key !== props.initialTargetKey),
  ]
  const used = new Set(queue.value.map((item) => item.targetKey).filter(Boolean))
  for (const item of queue.value.filter((candidate) => candidate.status === 'ready' && !candidate.targetKey)) {
    const target = orderedTargets.find((candidate) => !used.has(candidate.key))
    if (!target) break
    item.targetKey = target.key
    used.add(target.key)
  }
}

function targetUsedByOther(targetKey, itemId) {
  return queue.value.some((item) => item.id !== itemId && item.targetKey === targetKey && item.status !== 'rejected')
}

function removeItem(itemId) {
  queue.value = queue.value.filter((item) => item.id !== itemId)
  applyPreflight()
  assignTargets()
}

async function retryItem(item) {
  item.status = 'ready'
  item.errors = []
  item.progress = 0
  await startUpload([item])
}

async function startUpload(explicitItems = null) {
  const items = explicitItems || readyItems.value
  if (!items.length || busy.value || (props.targets.length && targetConflict.value)) return
  busy.value = true
  const transportByHash = new Map()
  let cursor = 0
  const uploadOne = async (item) => {
    item.status = 'uploading'
    item.progress = 0
    try {
      const hash = item.descriptor?.sha256 || item.id
      let transport = transportByHash.get(hash)
      if (!transport) {
        const onUploadProgress = (event) => {
          if (event?.total) item.progress = Math.min(99, Math.round((event.loaded / event.total) * 100))
        }
        transport = props.endpoint === 'image'
          ? uploadAPI.uploadImage(item.file, { dramaId: props.dramaId, onUploadProgress })
          : uploadAPI.uploadReferenceMedia(item.file, { onUploadProgress })
        transportByHash.set(hash, transport)
      }
      const uploaded = await transport
      item.progress = 100
      await props.commitUpload({
        file: item.file,
        descriptor: item.descriptor,
        targetKey: item.targetKey,
        uploaded,
      })
      item.status = 'uploaded'
      item.errors = []
    } catch (error) {
      item.status = error?.code === 'DUPLICATE_REFERENCE' ? 'rejected' : 'failed'
      item.errors = [error?.message || '上传失败']
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, Number(props.concurrency) || 3), items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await uploadOne(item)
    }
  })
  await Promise.all(workers)
  busy.value = false
  emit('finished', {
    uploaded: items.filter((item) => item.status === 'uploaded').length,
    failed: items.filter((item) => item.status !== 'uploaded').length,
  })
}

function fileMeta(item) {
  const bytes = Number(item.file?.size || 0)
  const size = bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
  const duration = item.descriptor?.durationSeconds != null ? ` · ${item.descriptor.durationSeconds.toFixed(1)} 秒` : ''
  return `${size}${duration}`
}

function statusLabel(status) {
  return ({
    inspecting: '正在检查', ready: '等待上传', uploading: '上传中', uploaded: '已完成', failed: '上传失败', rejected: '需要调整',
  })[status] || status
}
</script>

<style scoped>
.workflow-upload-dialog { display: grid; gap: 14px; }
.upload-drop-zone { min-height: 150px; border: 1px dashed #9ca3af; background: #f8fafc; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; color: #475569; transition: border-color .16s ease, background .16s ease; }
.upload-drop-zone > .el-icon { font-size: 30px; color: #2563eb; }
.upload-drop-zone strong { color: #111827; }
.upload-drop-zone span { font-size: 12px; }
.upload-drop-zone.is-dragging { border-color: #2563eb; background: #eff6ff; }
.upload-drop-zone.is-disabled { opacity: .7; }
.hidden-file-input { display: none; }
.upload-queue { display: grid; gap: 8px; max-height: min(46vh, 440px); overflow: auto; padding-right: 4px; }
.upload-item { border: 1px solid #e5e7eb; background: #fff; padding: 10px; display: grid; gap: 8px; }
.upload-item.is-uploaded { border-color: #86efac; background: #f0fdf4; }
.upload-item.is-failed,.upload-item.is-rejected { border-color: #fca5a5; background: #fff7f7; }
.upload-item-main { display: grid; grid-template-columns: 34px minmax(0, 1fr) minmax(180px, 260px) auto; gap: 10px; align-items: center; }
.upload-file-icon { width: 34px; height: 34px; display: grid; place-items: center; background: #eef2ff; color: #1d4ed8; }
.upload-file-copy { min-width: 0; display: grid; gap: 3px; }
.upload-file-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.upload-file-copy small { color: #64748b; }
.upload-target-select { width: 100%; }
.upload-item-actions { display: flex; gap: 6px; }
.upload-messages { display: grid; gap: 3px; padding-left: 44px; font-size: 12px; }
.upload-messages .is-error { color: #b91c1c; }
.upload-messages .is-warning { color: #a16207; }
.upload-empty { min-height: 54px; display: grid; place-items: center; color: #94a3b8; border: 1px solid #e5e7eb; }
.upload-footer { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.upload-footer > span { color: #64748b; font-size: 12px; }
.upload-footer > div { display: flex; gap: 8px; }
@media (max-width: 680px) {
  .upload-item-main { grid-template-columns: 34px minmax(0, 1fr) auto; }
  .upload-target-select { grid-column: 2 / -1; }
  .upload-footer { align-items: stretch; flex-direction: column; }
  .upload-footer > div { display: grid; grid-template-columns: 1fr 1fr; }
  .upload-footer :deep(.el-button) { margin-left: 0; }
}
</style>
