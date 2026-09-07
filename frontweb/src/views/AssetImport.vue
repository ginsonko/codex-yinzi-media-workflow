<template>
  <div class="page">
    <header class="hero"><div><p class="eyebrow">V0.4 · 智能资产导入</p><h1>把现有素材无痛接入工作流</h1><p class="sub">选择文件夹或多个文件，先由 AI 整理成可审核计划；确认后才写入项目，随时可回滚。</p></div><el-button @click="$router.push('/')">返回项目</el-button></header>
    <el-card class="card" shadow="never"><div class="form-row"><el-input v-model="sourceLabel" placeholder="来源备注（例如：第一季素材）" /><el-input v-model="targetRunId" placeholder="目标制作任务 ID（可选）" /><el-select v-model="templateId" clearable filterable placeholder="通用导入（可选模板）"><el-option v-for="item in templates" :key="item.id" :label="item.name" :value="item.id" /></el-select><el-button type="primary" plain @click="create">先创建导入会话</el-button></div><p class="target-hint">{{ targetRunId ? '将导入到指定制作任务。' : targetDramaId ? '当前项目尚未有制作任务，确认导入时会自动创建草稿任务，不会立即生成或扣费。' : '未指定项目时，确认导入会自动创建一个草稿项目和制作任务。' }}</p><input ref="fileInput" type="file" multiple hidden @change="onFiles"><input ref="folderInput" type="file" webkitdirectory directory multiple hidden @change="onFiles"><div class="choose-row"><div class="choose-actions"><el-button class="choose" :disabled="scanning" @click="fileInput?.click()">选择文件（可多选）</el-button><el-button class="choose" :disabled="scanning" :title="folderPickerSupported ? '选择一个文件夹，包含其中的所有素材' : '当前浏览器不支持目录选择，请改用选择文件（可多选）'" @click="chooseFolder">{{ folderPickerSupported ? '选择文件夹' : '目录选择不可用' }}</el-button><el-button v-if="files.length" text type="danger" :disabled="scanning" @click="clearFiles">清空选择</el-button></div><el-switch v-model="useAiClassifier" active-text="使用 AI 理解图片/视频/文本" inactive-text="仅本地规则（不调用模型）" /></div><span class="hint">支持 txt、md、docx、pdf、json、csv、图片、视频、音频；文件和文件夹可以混合选择，确认前不会写入项目。</span><div v-if="files.length" class="selection-summary" aria-live="polite"><strong>已选择 {{ files.length }} 个文件</strong><span>总大小 {{ formatBytes(totalBytes) }}</span><span v-if="uploadedCount">已上传 {{ uploadedCount }} 个，可复用暂存</span><el-button link type="primary" @click="uploadAndAnalyze">{{ session ? '上传并分析' : '创建会话并分析' }}</el-button></div><div v-if="files.length" class="selected-files"><div v-for="item in files" :key="item.key" class="selected-file"><span class="file-kind">{{ fileKind(item.file) }}</span><span class="file-name" :title="item.relative_path">{{ item.relative_path }}</span><span class="file-size">{{ formatBytes(item.file.size) }}</span><el-tag v-if="item.source_token" size="small" type="success">已上传</el-tag><el-button text circle type="danger" aria-label="移除文件" @click="removeFile(item.key)">×</el-button></div></div><div v-if="uploadPhase !== 'idle'" class="upload-status" :class="`is-${uploadPhase}`" role="status" aria-live="polite"><div class="upload-status-head"><strong>{{ uploadPhaseLabel }}</strong><span v-if="uploadPhase === 'uploading' && uploadProgress != null">{{ uploadProgress }}%</span></div><el-progress v-if="uploadPhase === 'uploading'" :percentage="uploadProgress ?? 0" :indeterminate="uploadProgress == null" :duration="1.2" :show-text="false" /><p>{{ uploadPhaseDetail }}</p><div class="upload-status-actions"><el-button v-if="['uploading','analyzing'].includes(uploadPhase)" text type="danger" @click="cancelUpload">取消本次上传</el-button><el-button v-if="uploadPhase === 'error'" type="primary" plain @click="uploadAndAnalyze">重试</el-button></div></div><div v-if="recentSessions.length" class="recent-imports"><span class="recent-label">可继续的导入会话</span><el-button v-for="item in recentSessions" :key="item.id" link type="primary" @click="resume(item)">{{ item.source_label || item.id.slice(0, 8) }} · {{ statusText(item.status) }}</el-button></div></el-card>
    <el-card v-if="session" class="card" shadow="never">
      <div class="card-head"><div><h2>导入会话 {{ session.id.slice(0, 8) }}</h2><el-tag :type="statusType">{{ statusLabel }}</el-tag><small class="revision">计划版本 {{ session.version }}</small></div><div class="actions"><el-button :loading="scanning" :disabled="!files.length" @click="uploadAndAnalyze">重新上传并分析</el-button><el-button :loading="savingPlan" :disabled="session.status !== 'planned' || !items.length" @click="savePlanEdits">保存计划修改</el-button><el-button type="primary" :disabled="session.status !== 'planned'" @click="apply">确认导入</el-button><el-button type="danger" plain :disabled="session.status !== 'applied'" @click="rollback">回滚</el-button></div></div>
      <el-alert v-if="error" :title="error" type="error" show-icon />
      <div v-if="plan.summary" class="stats"><span>文件 {{ plan.summary.total }}</span><span>可导入 {{ plan.summary.ready }}</span><span>待处理 {{ plan.summary.partial + plan.summary.unknown }}</span><span>已排除 {{ plan.summary.excluded || 0 }}</span><span>冲突 {{ plan.conflicts?.length || 0 }}</span><span v-if="plan.template_candidates?.length">推荐模板 {{ plan.template_candidates[0].id }}</span></div>
      <div v-if="plan.conflicts?.length" class="reorganize-row"><el-input v-model="reorganizeReason" placeholder="告诉 AI 如何处理冲突，例如：保留最新版本，旧版本作为候选" /><el-button :loading="reorganizing" @click="reorganize">让 AI 重新整理</el-button></div>
      <el-table :data="items" stripe>
        <el-table-column prop="relative_path" label="文件" min-width="220" show-overflow-tooltip />
        <el-table-column label="识别类型" width="150"><template #default="{ row }"><el-select v-model="row.detected_type" size="small" filterable allow-create><el-option v-for="type in editableTypes" :key="type" :label="typeLabel(type)" :value="type" /></el-select></template></el-table-column>
        <el-table-column label="建议用途" width="170"><template #default="{ row }"><el-select v-model="row.metadata.usage_role" size="small"><el-option v-for="role in usageRoles" :key="role" :label="usageRoleLabel(role)" :value="role" /></el-select><small v-if="row.metadata.direct_clip_candidate" class="clip-hint">可作为直接片段</small></template></el-table-column>
        <el-table-column label="拟放入阶段" width="165"><template #default="{ row }"><el-select v-model="row.candidate_stage" size="small" clearable filterable placeholder="不导入"><el-option v-for="stage in editableStages" :key="stage" :label="stageLabel(stage)" :value="stage" /></el-select></template></el-table-column>
        <el-table-column label="作用域" width="185"><template #default="{ row }"><div class="scope-cell"><el-select v-model="row.candidate_scope_type" size="small"><el-option v-for="scope in editableScopes" :key="scope" :label="scopeLabel(scope)" :value="scope" /></el-select><el-input v-model="row.candidate_scope_id" size="small" placeholder="对象 ID" /></div></template></el-table-column>
        <el-table-column label="置信度" width="100"><template #default="{ row }">{{ row.confidence == null ? '—' : `${Math.round(row.confidence * 100)}%` }}</template></el-table-column>
        <el-table-column label="导入" width="72"><template #default="{ row }"><el-switch :model-value="row.status !== 'excluded'" @update:model-value="value => row.status = value ? (row.error_code ? 'partial' : 'ready') : 'excluded'" /></template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag size="small" :type="itemStatusType(row.status)">{{ itemStatusLabel(row) }}</el-tag></template></el-table-column>
        <el-table-column label="判断依据" min-width="210" show-overflow-tooltip><template #default="{ row }">{{ evidenceLabel(row) }}</template></el-table-column>
      </el-table>
      <el-alert v-if="plan.conflicts?.length" class="conflicts" title="存在需要你确认的冲突；系统不会静默覆盖" type="warning" show-icon :description="plan.conflicts.map(c => `${c.type}: ${c.paths?.join('、') || c.target}`).join('；')" />
    </el-card>
  </div>
</template>
<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { assetImportAPI } from '@/api/assetImport'
import { templatesAPI } from '@/api/templates'
const route = useRoute()
const fileInput = ref(); const folderInput = ref(); const sourceLabel = ref(''); const targetRunId = ref(''); const targetDramaId = ref(''); const targetEpisodeId = ref(''); const templateId = ref(''); const templates = ref([]); const files = ref([]); const session = ref(null); const plan = ref({}); const items = ref([]); const scanning = ref(false); const savingPlan = ref(false); const error = ref(''); const recentSessions = ref([]); const reorganizeReason = ref(''); const reorganizing = ref(false); const useAiClassifier = ref(false)
const uploadPhase = ref('idle'); const uploadProgress = ref(null); const uploadBytesTotal = ref(0); const uploadError = ref(''); const uploadAbortController = ref(null); const folderPickerSupported = ref(true)
const totalBytes = computed(() => files.value.reduce((sum, item) => sum + (Number(item.file?.size) || 0), 0))
const uploadedCount = computed(() => files.value.filter((item) => item.source_token && item.source_session_id === session.value?.id).length)
const uploadPhaseLabel = computed(() => ({ idle: '', uploading: '正在上传素材', analyzing: '正在分析素材', success: '素材分析完成', error: '上传或分析失败' }[uploadPhase.value] || ''))
const uploadPhaseDetail = computed(() => {
  if (uploadPhase.value === 'uploading') return uploadProgress.value == null ? '已连接，正在传输文件；网络较慢时百分比可能稍后出现。' : `已上传 ${formatBytes(Math.round(uploadBytesTotal.value * uploadProgress.value / 100))} / ${formatBytes(uploadBytesTotal.value)}`
  if (uploadPhase.value === 'analyzing') return useAiClassifier.value ? '文件已上传，AI 正在读取文本、图片和视频采样；请不要重复点击。' : '文件已上传，正在读取元数据并生成导入计划。'
  if (uploadPhase.value === 'success') return '计划已生成，请检查分类和冲突后确认导入。'
  if (uploadPhase.value === 'error') return uploadError.value || '文件仍保留在当前清单中，可以修复后重试。'
  return ''
})
function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`; return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` }
function fileKind(file) { const type = String(file?.type || ''); if (type.startsWith('image/')) return '图'; if (type.startsWith('video/')) return '视'; if (type.startsWith('audio/')) return '音'; return '文' }
const editableTypes = ['script', 'storyboard', 'character', 'scene', 'prop', 'asset_text', 'image', 'video', 'audio', 'director_preview', 'shot_video', 'final_edit', 'unknown']
const editableStages = ['script', 'asset_text', 'asset_images', 'storyboard_plan', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit']
const editableScopes = ['run', 'resource', 'shot']
const usageRoles = ['source_document', 'visual_reference', 'reference_or_direct_clip', 'source_audio', 'unclassified']
const usageRoleLabel = (value) => ({ source_document: '来源文档', visual_reference: '视觉参考', reference_or_direct_clip: '参考 / 直接片段', source_audio: '源音频', unclassified: '待确认' }[value] || value)
const typeLabel = (value) => ({ script: '剧本', storyboard: '分镜稿', character: '角色', scene: '场景', prop: '道具', asset_text: '资源文本', image: '图片', video: '视频', audio: '音频', director_preview: '导演台预演', shot_video: '分镜视频', final_edit: '成片/音频', unknown: '未识别' }[value] || value)
const stageLabel = (value) => ({ script: '剧本', asset_text: '资源设定', asset_images: '资源图', storyboard_plan: '分镜脚本', storyboard_images: '分镜图', director_preview: '3D 导演台', shot_video: '分镜视频', final_edit: '最终剪辑' }[value] || value)
const scopeLabel = (value) => ({ run: '项目', resource: '资源对象', shot: '镜头' }[value] || value)
const itemStatusLabel = (row) => row.status === 'excluded' ? '已排除' : row.status === 'partial' ? `部分可用${row.error_message ? `：${row.error_message}` : ''}` : row.status === 'failed' ? '解析失败' : row.candidate_stage ? '可导入' : '待指定阶段'
const itemStatusType = (value) => ({ ready: 'success', partial: 'warning', failed: 'danger', excluded: 'info' }[value] || 'info')
const evidenceLabel = (row) => { const source = row.evidence?.source === 'multimodal_ai' ? `AI（${row.evidence.model || 'gpt-5.6-sol'}）` : row.evidence?.source === 'local_rules' ? '本地规则' : row.evidence?.source === 'extension_and_metadata' ? '扩展名和元数据' : row.evidence?.source || '—'; const receipt = row.metadata?.analysis_receipt?.used ? ' · 已实际读取媒体' : ''; return row.error_message ? `${source}${receipt}；${row.error_message}` : `${source}${receipt}` }
const statusLabel = computed(() => ({ draft: '待扫描', planned: '待确认', applied: '已导入', rolled_back: '已回滚' }[session.value?.status] || session.value?.status || ''))
const statusType = computed(() => ({ planned: 'warning', applied: 'success', rolled_back: 'info' }[session.value?.status] || 'info'))
const statusText = (value) => ({ draft: '待扫描', planned: '待确认', applied: '已导入', rolled_back: '已回滚' }[value] || value)
function onFiles(event) {
  const incoming = [...(event.target.files || [])]
  if (event.target) event.target.value = ''
  if (!incoming.length) return
  const before = files.value.length
  const existing = new Map(files.value.map((item) => [item.key, item]))
  for (const file of incoming) {
    const relativePath = file.webkitRelativePath || file.name
    const key = `${relativePath}:${file.size}:${file.lastModified}`
    if (!existing.has(key)) existing.set(key, { key, file, relative_path: relativePath, name: file.name, source_token: null, source_session_id: null })
  }
  files.value = [...existing.values()]
  uploadPhase.value = 'idle'; uploadError.value = ''; error.value = ''
  ElMessage.success(`已添加 ${files.value.length - before} 个新文件，当前共 ${files.value.length} 个`)
}
function chooseFolder() { if (folderPickerSupported.value) folderInput.value?.click(); else { ElMessage.info('当前浏览器不支持目录选择，请在文件选择器中多选素材'); fileInput.value?.click() } }
function removeFile(key) { files.value = files.value.filter((item) => item.key !== key); if (!files.value.length) uploadPhase.value = 'idle' }
function clearFiles() { files.value = []; uploadPhase.value = 'idle'; uploadProgress.value = null; uploadError.value = '' }
async function create() { error.value = ''; try { const res = await assetImportAPI.create({ source_label: sourceLabel.value, target_run_id: targetRunId.value || null, options: { template_id: templateId.value || null, target_drama_id: targetDramaId.value || null, target_episode_id: targetEpisodeId.value || null, auto_create_target: true } }); session.value = res.data || res; ElMessage.success('导入会话已创建'); return session.value } catch (e) { error.value = e.message || '导入会话创建失败'; ElMessage.error(error.value); return null } }
async function loadSessions() { try { const res = await assetImportAPI.list({ page_size: 20 }); recentSessions.value = (res.items || []).filter(item => item.status !== 'rolled_back') } catch (_) { recentSessions.value = [] } }
async function resume(item) { try { const res = await assetImportAPI.get(item.id); const data = res.data || res; session.value = data.session; plan.value = session.value.plan || {}; items.value = data.items || []; sourceLabel.value = session.value.source_label || ''; targetRunId.value = session.value.target_run_id || ''; targetDramaId.value = session.value.options?.target_drama_id || ''; targetEpisodeId.value = session.value.options?.target_episode_id || ''; templateId.value = session.value.options?.template_id || templateId.value || ''; ElMessage.success('已恢复导入会话') } catch (e) { error.value = e.message } }
async function uploadAndAnalyze() {
  if (!files.value.length) return ElMessage.warning('请先选择文件或文件夹')
  if (scanning.value) return
  if (!session.value) {
    try { await create() } catch (_) { return }
    if (!session.value) return
  }
  await scan()
}
async function scan() {
  if (!session.value) return ElMessage.warning('请先创建导入会话')
  if (!files.value.length) return ElMessage.warning('请先选择文件或文件夹')
  scanning.value = true; error.value = ''; uploadError.value = ''; uploadAbortController.value = new AbortController()
  try {
    // Web File objects intentionally do not expose absolute paths. Upload to
    // a session-scoped staging area first, then scan opaque source tokens.
    const reusable = files.value.filter((item) => item.source_token && item.source_session_id === session.value.id)
    const pending = files.value.filter((item) => !(item.source_token && item.source_session_id === session.value.id))
    let uploadedFiles = []
    if (pending.length) {
      uploadPhase.value = 'uploading'; uploadProgress.value = null; uploadBytesTotal.value = pending.reduce((sum, item) => sum + (Number(item.file?.size) || 0), 0)
      const form = new FormData(); const relativePaths = []
      pending.forEach(item => { form.append('files', item.file, item.name); relativePaths.push(item.relative_path) })
      form.append('relative_paths', JSON.stringify(relativePaths))
      const uploaded = await assetImportAPI.upload(session.value.id, form, { timeout: 600000, signal: uploadAbortController.value.signal, onUploadProgress: (event) => { if (event.total) uploadProgress.value = Math.min(100, Math.round(event.loaded / event.total * 100)) } })
      uploadedFiles = uploaded.files || []
      uploadedFiles.forEach((descriptor, index) => { const item = pending[index]; if (item) { item.source_token = descriptor.source_token; item.source_session_id = session.value.id } })
    }
    const descriptors = [
      ...reusable.map((item) => ({ relative_path: item.relative_path, file_name: item.name, source_token: item.source_token, bytes: item.file.size, mime_type: item.file.type })),
      ...uploadedFiles.map(item => ({ ...item, source_token: item.source_token })),
    ]
    uploadPhase.value = 'analyzing'; uploadProgress.value = null
    const res = await assetImportAPI.scan(session.value.id, { files: descriptors, classifier_enabled: useAiClassifier.value, options: { classifier_enabled: useAiClassifier.value, classifier_model: 'gpt-5.6-sol', template_id: templateId.value || session.value.options?.template_id || null } }, { timeout: 600000, signal: uploadAbortController.value.signal })
    const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = data.items || []
    uploadPhase.value = 'success'; uploadProgress.value = 100; ElMessage.success(`已分析 ${descriptors.length} 个文件`)
  } catch (e) {
    if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.message === 'canceled') { uploadPhase.value = 'error'; uploadError.value = '本次上传已取消，已上传的文件仍保留，可点击重试。' }
    else { uploadPhase.value = 'error'; uploadError.value = e.message || '上传或分析失败'; error.value = uploadError.value }
  } finally { scanning.value = false; uploadAbortController.value = null }
}
function cancelUpload() { uploadAbortController.value?.abort() }
async function reorganize() { if (!session.value || !reorganizeReason.value.trim()) return ElMessage.warning('请先填写整理要求'); reorganizing.value = true; try { const res = await assetImportAPI.reorganize(session.value.id, { instruction: reorganizeReason.value.trim() }); const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = plan.value.items || items.value; ElMessage.success(data.deferred ? '已保存整理要求，等待 AI 配置后重试' : 'AI 已重新整理导入计划') } catch (e) { error.value = e.message } finally { reorganizing.value = false } }
async function savePlanEdits() { if (!session.value || !items.value.length) return; savingPlan.value = true; error.value = ''; try { const res = await assetImportAPI.updatePlan(session.value.id, { expected_version: session.value.version, reason: '用户在导入预览中逐项确认类型、阶段、用途和是否导入', items: items.value.map(row => ({ id: row.id, detected_type: row.detected_type, candidate_stage: row.candidate_stage || null, candidate_scope_type: row.candidate_scope_type || 'run', candidate_scope_id: row.candidate_scope_id || '', usage_role: row.metadata?.usage_role || 'unclassified', direct_clip_candidate: row.metadata?.direct_clip_candidate === true, include: row.status !== 'excluded' })) }); const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = data.items || items.value; ElMessage.success(`计划已保存（${data.changed_item_ids?.length || 0} 项更新）`) } catch (e) { error.value = e.message || '计划保存失败' } finally { savingPlan.value = false } }
async function apply() { try { const copy = targetRunId.value ? '确认后会把可导入项写入指定制作任务，仍可通过“回滚”撤销本次导入。' : '确认后会把可导入项写入制作任务；如果当前项目尚未有任务，系统会自动创建一个草稿任务，不会立即生成或扣费。'; await ElMessageBox.confirm(copy, '确认导入'); const res = await assetImportAPI.apply(session.value.id, { confirm: true, target_run_id: targetRunId.value || null }); const data = res.data || res; session.value = data.session; targetRunId.value = data.target_run_id || session.value.target_run_id || ''; targetDramaId.value = data.target_drama_id || session.value.options?.target_drama_id || targetDramaId.value; ElMessage.success(data.target_drama_created ? '导入完成，已自动创建草稿项目' : data.target_run_created ? '导入完成，已自动创建草稿制作任务' : '导入完成') } catch (e) { if (e !== 'cancel') error.value = e.message } }
async function rollback() { try { await ElMessageBox.confirm('回滚会软删除本次创建的资产并移除导入副本，是否继续？', '确认回滚', { type: 'warning' }); const res = await assetImportAPI.rollback(session.value.id); session.value = (res.data || res).session; ElMessage.success('已回滚') } catch (e) { if (e !== 'cancel') error.value = e.message } }
onMounted(async () => {
  folderPickerSupported.value = 'webkitdirectory' in document.createElement('input')
  targetRunId.value = typeof route.query.target_run_id === 'string' ? route.query.target_run_id : ''
  targetDramaId.value = typeof route.query.drama_id === 'string' ? route.query.drama_id : ''
  targetEpisodeId.value = typeof route.query.episode_id === 'string' ? route.query.episode_id : ''
  sourceLabel.value = typeof route.query.source_label === 'string' ? route.query.source_label : ''
  await loadSessions()
  try { const result = await templatesAPI.list(); templates.value = result?.items || []; if (templateId.value && !templates.value.some((item) => String(item.id) === String(templateId.value))) templateId.value = '' } catch (_) { templates.value = [] }
  if (route.query.picker === 'folder') await nextTick(() => chooseFolder())
  if (route.query.picker === 'files') await nextTick(() => fileInput.value?.click())
})
</script>
<style scoped>
.page{min-height:100vh;padding:42px clamp(20px,5vw,72px);background:linear-gradient(135deg,var(--bg-card),var(--bg-card));color:var(--text-primary)}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:24px}.eyebrow{color:var(--ui-info);font-weight:700;letter-spacing:.08em}.hero h1{margin:8px 0;font-size:34px}.sub{color:var(--text-muted)}.card{max-width:1180px;margin:16px auto;border:0;border-radius:18px}.form-row,.card-head,.actions,.stats{display:flex;gap:12px;align-items:center}.form-row>*{flex:1}.form-row .el-button{flex:0 0 auto}.choose-row{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-top:18px}.choose-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hint{display:block;margin-top:10px;color:var(--text-muted);font-size:13px}.selection-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;padding:11px 12px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-card);color:var(--ui-info);font-size:13px}.selection-summary strong{color:var(--ui-info)}.selection-summary .el-button{margin-left:auto}.selected-files{display:grid;gap:6px;max-height:220px;overflow:auto;margin-top:10px;padding:8px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-card)}.selected-file{display:grid;grid-template-columns:26px minmax(0,1fr) auto auto 28px;align-items:center;gap:8px;min-width:0;padding:7px 8px;border-radius:7px;background:var(--bg-card)}.selected-file:hover{background:var(--bg-hover)}.file-kind{display:grid;place-items:center;width:24px;height:24px;border-radius:6px;background:var(--bg-card);color:var(--ui-info);font-size:12px;font-weight:700}.file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-info);font-size:12px}.file-size{color:var(--text-muted);font-size:12px;white-space:nowrap}.upload-status{margin-top:14px;padding:12px 14px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-inner)}.upload-status.is-success{border-color:var(--border-color);background:var(--bg-inner)}.upload-status.is-error{border-color:var(--border-color);background:var(--bg-inner)}.upload-status-head{display:flex;justify-content:space-between;gap:12px;color:var(--ui-info);font-size:13px}.upload-status.is-success .upload-status-head{color:var(--ui-accent)}.upload-status.is-error .upload-status-head{color:var(--ui-danger)}.upload-status p{margin:8px 0 0;color:var(--text-muted);font-size:12px;line-height:1.5}.upload-status-actions{display:flex;justify-content:flex-end;margin-top:5px}.card-head{justify-content:space-between;margin-bottom:20px}.card-head small.revision{margin-left:10px;color:var(--text-muted)}.stats{padding:14px 0;color:var(--ui-info);flex-wrap:wrap}.stats span{padding:8px 14px;background:var(--bg-card);border-radius:10px}.conflicts{margin-top:16px}.reorganize-row{display:flex;gap:12px;margin:12px 0}.reorganize-row .el-input{flex:1}.scope-cell{display:flex;gap:4px;align-items:center}.scope-cell .el-input{width:82px}.recent-imports{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px}.recent-label{font-size:13px;color:var(--text-muted)}@media(max-width:720px){.page{padding:24px 14px}.hero{align-items:flex-start;flex-direction:column}.hero h1{font-size:28px}.form-row{align-items:stretch;flex-direction:column}.form-row .el-button{width:100%}.choose-row{align-items:stretch;flex-direction:column}.choose-actions{display:grid;grid-template-columns:1fr 1fr}.choose-actions .el-button{margin-left:0}.choose-actions .el-button:last-child{grid-column:1 / -1}.selection-summary .el-button{width:100%;margin-left:0}.selected-file{grid-template-columns:26px minmax(0,1fr) auto 28px}.selected-file .el-tag{display:none}.file-size{grid-column:2;grid-row:2}.card-head{align-items:flex-start;flex-direction:column}.actions{width:100%;flex-wrap:wrap}.actions .el-button{margin-left:0;flex:1 1 140px}.stats span{padding:7px 10px}.reorganize-row{align-items:stretch;flex-direction:column}}
.target-hint{margin:6px 0 0;color:var(--ui-info);font-size:12px;line-height:1.5}
</style>
