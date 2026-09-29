<template>
  <div class="manual-editor" aria-label="逐项手动生成编辑器">
    <p class="editor-note">直接写提示词、添加参考素材即可生成，不需要 Codex。每条任务独立设置，草稿自动保存在本浏览器。</p>
    <p v-if="storageError" class="editor-error" role="alert">{{ storageError }}</p>
    <article v-for="(item, index) in visibleItems" :key="item.id" class="manual-task" :data-task-id="item.id">
      <header><strong>任务 {{ (page - 1) * pageSize + index + 1 }}</strong><div><el-button text size="small" @click="copyItem(item)">复制</el-button><el-button text size="small" @click="removeItem(item)">删除</el-button></div></header>
      <el-input v-model="item.prompt" type="textarea" :rows="3" :aria-label="'任务 ' + ((page - 1) * pageSize + index + 1) + ' 提示词'" placeholder="描述这一条想生成的内容、动作和镜头…" />
      <label class="editor-label">本项模型</label>
      <el-select v-model="item.model" clearable filterable allow-create default-first-option placeholder="使用下方默认模型，也可输入模型名" class="editor-full" aria-label="本项模型">
        <el-option v-for="option in options" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
      <div v-if="kind === 'video'" class="capability-notes"><span v-for="note in notes(item)" :key="note">{{ note }}</span></div>
      <div class="reference-groups">
        <section v-for="type in typesFor(item)" :key="type" class="reference-group">
          <div class="reference-title"><strong>参考{{ labels[type] }}</strong><label class="upload-button">添加{{ labels[type] }}<input type="file" multiple :accept="accepts[type]" :aria-label="'任务 ' + ((page - 1) * pageSize + index + 1) + ' 添加' + labels[type]" @change="chooseFiles(item, type, $event)" /></label></div>
          <div v-if="!refsOf(item, type).length" class="reference-empty">可选 · 为本条任务单独添加{{ labels[type] }}文件</div>
          <div v-for="(ref, refIndex) in refsOf(item, type)" :key="ref.id" class="reference-row">
            <div class="reference-preview">
              <a v-if="type === 'image' && ref.status === 'ready'" :href="preview(ref)" target="_blank" rel="noreferrer"><img :src="preview(ref)" :alt="ref.filename" /></a>
              <video v-else-if="type === 'video' && ref.status === 'ready'" :src="preview(ref)" controls preload="metadata" />
              <audio v-else-if="type === 'audio' && ref.status === 'ready'" :src="preview(ref)" controls preload="metadata" />
              <span v-else>{{ labels[type] }}</span>
            </div>
            <div class="reference-detail"><strong>{{ labels[type] }} {{ refIndex + 1 }} · {{ ref.filename }}</strong><small v-if="ref.status === 'ready'">已上传 · {{ sizeLabel(ref.size) }}</small><small v-else-if="ref.status === 'uploading'">上传中 {{ ref.progress || 0 }}%</small><small v-else class="editor-error">{{ ref.error || '上传未完成' }}</small>
              <el-select v-if="kind === 'video' && type === 'image'" v-model="ref.role" size="small" aria-label="图片用途"><el-option label="普通参考" value="reference" /><el-option label="首帧" value="first_frame" /><el-option label="尾帧" value="last_frame" /></el-select>
            </div>
            <div class="reference-actions"><el-button text size="small" :disabled="refIndex === 0" @click="moveRef(item, ref, type)" aria-label="上移参考素材">上移</el-button><el-button v-if="ref.status !== 'ready' && ref.status !== 'uploading' && files.has(ref.id)" text size="small" @click="uploadRef(item, ref)">重试上传</el-button><el-button text size="small" @click="removeRef(item, ref)">移除</el-button></div>
          </div>
        </section>
      </div>
      <p v-if="kind === 'video' && protocol(item) && protocol(item) !== 'yinzi'" class="editor-note" role="status">当前连接使用 {{ protocol(item) }} 适配器；此手动入口尚未对接它的视频／音频参考，使用这两类素材请切换支持 Yinzi 视频协议的连接。切换前已添加的素材会保留，但继续使用当前适配器生成时不会生效。</p>
      <p v-if="kind === 'video'" class="editor-note">首尾帧和参考类型按模型能力使用。编号按当前各类素材顺序；需要 @图片1 / @视频1 / @音频1 的模型可在提示词中引用。能力信息仅作提示，不会擅自删除素材或换模型。</p>
      <details class="task-settings"><summary>本项画幅{{ kind === 'video' ? '、时长与分辨率' : '与尺寸' }}（可覆盖下方默认值）</summary><div class="settings-grid"><div><label class="editor-label">画幅</label><el-select v-model="item.aspect_ratio" clearable filterable allow-create placeholder="使用默认画幅"><el-option v-for="ratio in imageRatios" :key="ratio" :label="ratio" :value="ratio" /></el-select></div><template v-if="kind === 'video'"><div><label class="editor-label">时长（秒）</label><el-input-number v-model="item.duration" :min="1" controls-position="right" :placeholder="String(defaults.settings.duration)" /></div><div><label class="editor-label">分辨率</label><el-input v-model="item.resolution" placeholder="例如 720p；留空使用模型默认" /></div></template><template v-else-if="presetFor(item)"><div><label class="editor-label">清晰度档位</label><el-select v-model="item.image_tier" clearable :placeholder="`使用默认 ${defaults.settings.image_tier || '2K'}`"><el-option v-for="tier in imageTiers" :key="tier" :label="tier" :value="tier" /></el-select><small class="editor-note">实际尺寸 {{ sizeFor(item) }}</small></div></template><div v-else><label class="editor-label">自定义尺寸（可选）</label><el-input v-model="item.size" :placeholder="defaults.settings.size || '留空使用模型默认'" /></div></div></details>
      <p v-if="issue(item)" class="editor-note" role="status">{{ issue(item) }}</p>
    </article>
    <el-pagination v-if="items.length > pageSize" v-model:current-page="page" :total="items.length" :page-size="pageSize" layout="prev, pager, next" />
    <el-button class="add-task" plain @click="addItem">＋ 添加一条任务</el-button>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { uploadAPI } from '@/api/upload'
import { aiAPI } from '@/api/ai'
import { resolveMediaUrl } from '@/utils/mediaUrl'
import { newManualItem, cloneManualItem, manualItemRequest, manualItemIssue, persistedManualDraft, restoreManualDraft, manualCapability, manualProtocol, capabilityNotes } from '@/utils/manualBatch'
import { imageRatios, imageTiers, imageSizeFor, usesImageSizePresets } from '@/utils/imageSizes'
const props = defineProps({ kind: { type: String, required: true }, options: { type: Array, default: () => [] }, defaults: { type: Object, required: true } })
const emit = defineEmits(['change'])
const draftKey = kind => `yinzi-manual-batch-draft-v1:${kind}`
function readDraft(kind) { try { return restoreManualDraft(localStorage.getItem(draftKey(kind))) } catch { return [newManualItem()] } }
const items = ref(readDraft(props.kind))
const page = ref(1), pageSize = 5, storageError = ref(''), states = ref({}), catalog = ref([])
const files = new Map(), loadingConfigs = new Set()
let alive = true, persistTimer
const labels = { image: '图片', video: '视频', audio: '音频' }
const accepts = { image: 'image/*', video: 'video/*', audio: 'audio/*' }
const types = computed(() => props.kind === 'video' ? ['image','video','audio'] : ['image'])
const protocol = item => manualProtocol(item.model || props.defaults.model, props.options, states.value)
const typesFor = item => props.kind === 'video' && protocol(item) && protocol(item) !== 'yinzi'
  ? types.value.filter(type => type === 'image' || item.references.some(ref => ref.type === type)) : types.value
const visibleItems = computed(() => items.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const refsOf = (item, type) => item.references.filter(ref => ref.type === type)
const issue = item => manualItemIssue(item, props.kind)
const preview = ref => resolveMediaUrl(ref.local_path || ref.url)
const notes = item => capabilityNotes(manualCapability(item.model || props.defaults.model, props.options, states.value, catalog.value), item)
const imageModel = item => manualItemRequest(item, 'image', props.defaults, props.options).model
const presetFor = item => usesImageSizePresets(imageModel(item))
const sizeFor = item => imageSizeFor(imageModel(item), item.aspect_ratio || props.defaults.settings.aspect_ratio, item.image_tier || props.defaults.settings.image_tier || '2K', item.size || props.defaults.settings.size)
function sizeLabel(n) { return !n ? '本地素材' : n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB' }
function saveDraft() {
  clearTimeout(persistTimer)
  try { localStorage.setItem(draftKey(props.kind), JSON.stringify(persistedManualDraft(items.value))); storageError.value = '' }
  catch { storageError.value = '浏览器未能保存草稿；当前内容仍可生成，请勿刷新页面。' }
}
function publish() { emit('change', { count: items.value.length, valid: items.value.length > 0 && items.value.every(item => !issue(item)),
  items: items.value.map(item => manualItemRequest(item, props.kind, props.defaults, props.options)) }) }
watch(items, () => { publish(); clearTimeout(persistTimer); persistTimer = setTimeout(saveDraft, 250) }, { deep: true, immediate: true })
watch(() => [props.defaults, props.options], publish, { deep: true })
watch(() => props.kind, (kind, oldKind) => {
  clearTimeout(persistTimer)
  try { localStorage.setItem(draftKey(oldKind), JSON.stringify(persistedManualDraft(items.value))) } catch {}
  files.clear(); items.value = readDraft(kind); page.value = 1
}, { flush: 'sync' })
function addItem() { items.value.push(newManualItem()); page.value = Math.ceil(items.value.length / pageSize) }
function copyItem(item) { const copy = cloneManualItem(item); for (let i = 0; i < copy.references.length; i++) { const file = files.get(item.references[i].id); if (file) files.set(copy.references[i].id, file); if (copy.references[i].status === 'uploading') copy.references[i].status = 'interrupted' } items.value.push(copy); page.value = Math.ceil(items.value.length / pageSize) }
function removeItem(item) { item.references.forEach(ref => files.delete(ref.id)); items.value = items.value.filter(row => row.id !== item.id); if (!items.value.length) items.value.push(newManualItem()); page.value = Math.min(page.value, Math.ceil(items.value.length / pageSize)) }
function removeRef(item, ref) { item.references = item.references.filter(row => row.id !== ref.id); files.delete(ref.id) }
function moveRef(item, ref, type) { const previous = refsOf(item, type)[refsOf(item, type).findIndex(row => row.id === ref.id) - 1]; if (!previous) return; const a = item.references.indexOf(ref), b = item.references.indexOf(previous); [item.references[a], item.references[b]] = [item.references[b], item.references[a]] }
async function chooseFiles(item, type, event) {
  const selected = Array.from(event.target.files || []); event.target.value = ''
  // Register all attachments before awaiting any upload; a submit must never
  // silently omit files that are still waiting for their turn.
  const refs = selected.map(file => { const ref = { id: crypto.randomUUID(), type, role: 'reference', filename: file.name, size: file.size, status: 'uploading', progress: 0 }; files.set(ref.id, file); item.references.push(ref); return item.references.find(r => r.id === ref.id) })
  for (const ref of refs) if (attached(item, ref)) await uploadRef(item, ref)
}
function attached(item, ref) { return alive && items.value.some(row => row.id === item.id && row.references.some(r => r.id === ref.id)) }
async function uploadRef(item, ref) {
  const file = files.get(ref.id); if (!file || !attached(item, ref)) return
  ref.status = 'uploading'; ref.error = ''; ref.progress = 0
  try {
    const saved = await uploadAPI.uploadReferenceMedia(file, { onUploadProgress: event => { if (attached(item, ref)) ref.progress = Math.min(99, Math.round(event.loaded / (event.total || file.size || 1) * 100)) } })
    if (!attached(item, ref)) return
    if (!saved.local_path && !saved.url) throw new Error('上传未返回可用素材地址，请重试')
    if (saved.media_type && saved.media_type !== ref.type) throw new Error(`文件实际为${labels[saved.media_type] || saved.media_type}，请在对应参考栏重新添加`)
    Object.assign(ref, { local_path: saved.local_path, url: saved.url, mime_type: saved.mime_type, size: saved.size || file.size, status: 'ready', progress: 100 }); files.delete(ref.id); saveDraft()
  } catch (error) { if (attached(item, ref)) { ref.status = 'failed'; ref.error = error?.message || '上传失败，可重试' } }
}
async function loadContracts() {
  for (const id of new Set(props.options.map(option => option.config_id).filter(Boolean))) {
    if (states.value[id] || loadingConfigs.has(id)) continue
    loadingConfigs.add(id)
    try { const result = await aiAPI.getModelCapabilities(id); if (alive) states.value = { ...states.value, [id]: result?.models || [] } } catch {} finally { loadingConfigs.delete(id) }
  }
}
watch(() => props.options, loadContracts, { immediate: true })
onMounted(async () => { window.addEventListener('pagehide', saveDraft); try { const result = await aiAPI.getYinziCatalog(); if (alive) catalog.value = result?.video || [] } catch {} })
onBeforeUnmount(() => { saveDraft(); alive = false; window.removeEventListener('pagehide', saveDraft); files.clear() })
</script>

<style scoped>
.manual-editor{display:grid;gap:12px}.editor-note,.reference-empty{margin:5px 0;color:var(--text-muted);font-size:12px;line-height:1.6}.manual-task{min-width:0;padding:14px;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card)}.manual-task>header{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:14px}.editor-label{display:block;font-size:12px;margin:10px 0 6px}.editor-full{width:100%}.capability-notes{display:flex;gap:4px 10px;flex-wrap:wrap;margin-top:8px;font-size:11px;color:var(--text-muted)}.reference-group{padding:10px 0;border-bottom:1px solid var(--border-color)}.reference-title{display:flex;justify-content:space-between;align-items:center;font-size:12px}.upload-button{position:relative;display:inline-block;border:1px solid var(--border-color);border-radius:5px;padding:6px 10px;cursor:pointer;color:var(--ui-accent)}.upload-button:focus-within{outline:2px solid var(--ui-accent);outline-offset:2px}.upload-button input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.reference-row{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px;margin-top:10px;align-items:center}.reference-preview{min-width:0}.reference-preview img,.reference-preview video{width:96px;height:62px;object-fit:contain;background:var(--bg-inner)}.reference-preview audio{width:100%;height:32px}.reference-row:has(audio){grid-template-columns:minmax(0,1fr)}.reference-detail{min-width:0;display:grid;gap:4px;font-size:12px}.reference-detail strong{overflow-wrap:anywhere}.reference-detail small{color:var(--text-muted);font-size:11px}.reference-detail .el-select{max-width:160px}.reference-actions{grid-column:1 / -1;display:flex;justify-content:flex-end;flex-wrap:wrap}.editor-error,.reference-detail .editor-error{color:var(--ui-danger);font-size:12px;overflow-wrap:anywhere}.task-settings{margin-top:12px;font-size:12px}.task-settings summary{cursor:pointer;color:var(--text-muted);line-height:1.6}.settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.settings-grid .el-input-number{width:100%}.add-task{width:100%}.manual-editor :deep(.el-pagination){justify-content:center;max-width:100%;overflow:auto}@media(max-width:480px){.manual-task{padding:10px}.settings-grid{grid-template-columns:1fr}.reference-row{grid-template-columns:76px minmax(0,1fr)}.reference-preview img,.reference-preview video{width:76px}}
</style>
