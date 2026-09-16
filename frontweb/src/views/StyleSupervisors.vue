<template>
  <div class="workbench-view supervisor-page">
    <header class="supervisor-heading"><div><h2>作品监督</h2><p>{{ availableCount }} 位可用 · {{ items.filter(item => item.builtin).length }} 位内置</p></div><div class="actions">
      <el-button :icon="Plus" type="primary" @click="edit()">新增监督</el-button>
      <el-button :icon="Upload" :disabled="loading || !exchangeLimits" @click="fileInput?.click()">导入</el-button><el-button :icon="Download" :disabled="loading" @click="openExport">导出</el-button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="importProfiles" />
    </div></header>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <div class="supervisor-filters"><el-input v-model="query" placeholder="搜索名称、风格或适合的作品" clearable maxlength="240" :prefix-icon="Search" /><el-switch v-model="showDeleted" active-text="显示已删除" /></div>
    <div v-if="loading" class="empty-state" aria-live="polite">正在读取监督目录…</div>
    <div v-else-if="!filtered.length" class="empty-state">没有匹配的监督</div>
    <section class="supervisor-grid" aria-label="监督目录">
      <article v-for="item in filtered" :key="item.id" :class="['supervisor-item', { inactive: !item.enabled || item.deleted }]">
        <header><div><h3>{{ item.name }}</h3><span>{{ item.builtin ? '内置' : '自定义' }} · v{{ item.revision }}{{ item.deleted ? ' · 已删除' : '' }}</span></div><el-switch v-if="!item.deleted" :model-value="item.enabled" :aria-label="`启用${item.name}`" :disabled="busy === item.id" @change="toggle(item, $event)" /></header>
        <p class="style">{{ item.style }}</p><dl><dt>适合</dt><dd>{{ item.suitable_for || '按实际任务选择' }}</dd><dt>观众感受</dt><dd>{{ item.audience_feeling || '未指定' }}</dd><dt>需要留意</dt><dd>{{ item.tradeoff || '未指定' }}</dd></dl>
        <details><summary>视觉、声音与审片重点</summary><h4>视觉</h4><ul><li v-for="rule in item.visual_rules" :key="rule">{{ rule }}</li></ul><h4>声音</h4><ul><li v-for="rule in item.audio_rules" :key="rule">{{ rule }}</li></ul><h4>审片</h4><ul><li v-for="rule in item.review_criteria" :key="rule">{{ rule }}</li></ul></details>
        <footer><el-tooltip content="编辑监督" placement="top"><el-button v-if="!item.deleted" :icon="Edit" circle aria-label="编辑监督" @click="edit(item)" /></el-tooltip><el-tooltip content="复制为新监督" placement="top"><el-button :icon="CopyDocument" circle aria-label="复制监督" @click="edit(item, true)" /></el-tooltip><el-tooltip v-if="item.builtin" content="恢复内置版本" placement="top"><el-button :icon="RefreshLeft" circle aria-label="恢复内置版本" :loading="busy === item.id" @click="restore(item)" /></el-tooltip><el-tooltip v-if="!item.deleted" content="删除监督" placement="top"><el-button :icon="Delete" circle aria-label="删除监督" :disabled="busy === item.id" @click="remove(item)" /></el-tooltip></footer>
      </article>
    </section>
    <el-dialog v-model="exportOpen" title="导出监督" width="min(480px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="范围"><el-radio-group v-model="exportScope"><el-radio-button value="all">全部</el-radio-button><el-radio-button value="search" :disabled="!query">当前搜索</el-radio-button></el-radio-group></el-form-item>
        <el-form-item label="分批导出"><el-switch v-model="exportPartial" /></el-form-item>
        <div v-if="exportPartial" class="editor-pair"><el-form-item label="起始序号"><el-input-number v-model="exportStart" :min="1" :step="1" :precision="0" /></el-form-item><el-form-item label="数量"><el-input-number v-model="exportCount" :min="1" :step="1" :precision="0" /></el-form-item></div>
        <p>当前范围 {{ exportAvailable }} 位，本次导出 {{ exportSelected }} 位</p>
        <el-alert v-if="exportError" :title="exportError" type="error" :closable="false" />
      </el-form>
      <template #footer><el-button @click="exportOpen = false">取消</el-button><el-button type="primary" :icon="Download" :loading="exporting" :disabled="!exportSelected" @click="exportProfiles">导出文件</el-button></template>
    </el-dialog>
    <el-dialog v-model="editorOpen" :title="editing ? '编辑监督' : '新增监督'" width="min(720px, 94vw)" :close-on-click-modal="false">
      <el-form label-position="top" @submit.prevent="save">
        <div class="editor-pair"><el-form-item label="名称"><el-input v-model="form.name" maxlength="60" /></el-form-item><el-form-item label="风格倾向"><el-input v-model="form.style" maxlength="1800" /></el-form-item></div>
        <el-form-item label="适合的作品"><el-input v-model="form.suitable_for" maxlength="1800" /></el-form-item>
        <div class="editor-pair"><el-form-item label="想带给观众的感觉"><el-input v-model="form.audience_feeling" type="textarea" :rows="2" maxlength="1800" /></el-form-item><el-form-item label="取舍与容易失控的地方"><el-input v-model="form.tradeoff" type="textarea" :rows="2" maxlength="1800" /></el-form-item></div>
        <el-form-item label="推荐关键词（逗号分隔）"><el-input v-model="form.tags" maxlength="3000" /></el-form-item>
        <el-form-item v-for="field in ruleFields" :key="field.key" :label="`${field.label}（每行一条）`"><el-input v-model="form[field.key]" type="textarea" :rows="3" maxlength="15000" /></el-form-item>
        <el-form-item label="可用于新任务"><el-switch v-model="form.enabled" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="editorOpen = false">取消</el-button><el-button :icon="Check" type="primary" :loading="saving" @click="save">保存</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Plus, Upload, Download, Search, Edit, CopyDocument, RefreshLeft, Delete, Check } from '@element-plus/icons-vue'
import api from '@/api/styleSupervisors'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'

const items = ref([]), query = ref(''), showDeleted = ref(false), loading = ref(false), error = ref(''), busy = ref('')
const editorOpen = ref(false), editing = ref(null), saving = ref(false), fileInput = ref(null)
const exchangeLimits = ref(null), exportOpen = ref(false), exportScope = ref('all'), exportPartial = ref(false), exportStart = ref(1), exportCount = ref(100), exporting = ref(false), exportError = ref('')
const form = reactive({})
let editorInstance = 0
const ruleFields = [{ key: 'visual_rules', label: '视觉规则' }, { key: 'audio_rules', label: '声音规则' }, { key: 'review_criteria', label: '审片重点' }]
const availableCount = computed(() => items.value.filter(item => item.enabled && !item.deleted).length)
const filtered = computed(() => items.value.filter(item => (showDeleted.value || !item.deleted) && (!query.value || `${item.name} ${item.style} ${item.suitable_for} ${item.tags.join(' ')}`.toLowerCase().includes(query.value.toLowerCase()))))
const exportAvailable = computed(() => (exportScope.value === 'search' ? filtered.value : items.value).filter(item => !item.deleted).length)
const exportSelected = computed(() => exportPartial.value ? Math.max(0, Math.min(exportCount.value || 0, exportAvailable.value - (exportStart.value || 1) + 1)) : exportAvailable.value)
async function load() { loading.value = true; error.value = ''; try { const result = await api.list({ include_deleted: true }); items.value = result.items; exchangeLimits.value = result.exchange_limits } catch (e) { error.value = e.message || '目录读取失败' } finally { loading.value = false } }
function edit(item = null, copy = false) {
  editorInstance += 1
  editing.value = copy ? null : item
  Object.assign(form, { name: item ? `${item.name}${copy ? ' 副本' : ''}` : '', style: item?.style || '', suitable_for: item?.suitable_for || '', audience_feeling: item?.audience_feeling || '', tradeoff: item?.tradeoff || '', tags: (item?.tags || []).join('，'), enabled: item?.enabled !== false })
  for (const field of ruleFields) form[field.key] = (item?.[field.key] || []).join('\n')
  editorOpen.value = true
}
async function save() {
  if (saving.value) return
  const instance = editorInstance, target = editing.value
  const body = { ...form, tags: form.tags.split(/[,，\n]/).map(v => v.trim()).filter(Boolean) }
  for (const field of ruleFields) body[field.key] = form[field.key].split('\n').map(v => v.trim()).filter(Boolean)
  if (!body.name.trim() || !body.style.trim() || ruleFields.some(field => !body[field.key].length)) return ElMessage.warning('请填写名称、风格和三类规则')
  saving.value = true
  try { if (target) await api.update(target.id, { ...body, expected_revision: target.revision }); else await api.create(body); if (editorInstance === instance) editorOpen.value = false; await load(); ElMessage.success('监督已保存，已有任务保留原版本') } catch (e) { ElMessage.error(e.message || '保存失败') } finally { saving.value = false }
}
async function toggle(item, enabled) { busy.value = item.id; try { await api.update(item.id, { enabled, expected_revision: item.revision }); await load() } catch (e) { ElMessage.error(e.message) } finally { busy.value = '' } }
async function remove(item) {
  try { await ElMessageBox.confirm(`删除「${item.name}」？已有任务中的版本会保留。`, '删除监督', { type: 'warning' }) } catch { return }
  busy.value = item.id; try { await api.remove(item.id, item.revision); await load() } catch (e) { ElMessage.error(e.message) } finally { busy.value = '' }
}
async function restore(item) {
  try { await ElMessageBox.confirm(`将「${item.name}」恢复到随软件发布的版本？已有任务不受影响。`, '恢复内置监督') } catch { return }
  busy.value = item.id; try { await api.restore(item.id, item.revision); await load() } catch (e) { ElMessage.error(e.message) } finally { busy.value = '' }
}
async function importProfiles(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return
  if (file.size > exchangeLimits.value.max_bundle_bytes) return ElMessage.error('单包不能超过 4 MiB，请从来源目录按搜索范围或分批导出后再导入')
  try { const result = await api.import(JSON.parse(await file.text())); await load(); ElMessage.success(`已导入 ${result.imported} 位监督，作为新副本保存`) } catch (e) { ElMessage.error(e.message || '监督包格式无效') }
}
function openExport() { exportScope.value = query.value ? 'search' : 'all'; exportPartial.value = false; exportStart.value = 1; exportCount.value = 100; exportError.value = ''; exportOpen.value = true }
async function exportProfiles() {
  exporting.value = true; exportError.value = ''
  try { const params = { ...(exportScope.value === 'search' ? { q: query.value } : {}), ...(exportPartial.value ? { offset: exportStart.value - 1, limit: exportCount.value } : {}) }; const content = await api.export(params); const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2) + '\n'], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `yinzi-supervisors-${new Date().toISOString().slice(0, 10)}${exportPartial.value ? `-${exportStart.value}-${exportStart.value + content.profiles.length - 1}` : ''}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); exportOpen.value = false } catch (e) { exportError.value = e.message || '导出失败' } finally { exporting.value = false }
}
onMounted(load)
useWorkbenchPage({ refresh: load, error: () => error.value, loading: () => loading.value })
</script>

<style scoped>
.supervisor-page{color:var(--text-primary);letter-spacing:0}.supervisor-heading{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:24px}.supervisor-heading h2{margin:0;font-size:24px}.supervisor-heading p{margin:8px 0 0;color:var(--text-muted);font-size:13px}.actions{display:flex;gap:8px;flex-wrap:wrap}.actions .el-button+.el-button{margin-left:0}.supervisor-filters{display:flex;gap:20px;align-items:center;padding:16px 0 24px}.supervisor-filters .el-input{max-width:440px}.supervisor-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,310px),1fr));gap:18px}.supervisor-item{border:1px solid var(--border-color);border-radius:6px;padding:20px;background:var(--bg-card);min-width:0;display:flex;flex-direction:column;overflow-wrap:anywhere}.supervisor-item.inactive{opacity:.66}.supervisor-item header{display:flex;justify-content:space-between;gap:12px;align-items:center}.supervisor-item header>div{min-width:0}.supervisor-item header .el-switch{flex-shrink:0}.supervisor-item h3{margin:0 0 4px;font-size:19px}.supervisor-item header span{font-size:11px;color:var(--text-muted)}.style{font-size:14px;font-weight:600;line-height:1.7;min-height:48px}.supervisor-item dl{font-size:13px;line-height:1.65;margin:0 0 16px;display:grid;grid-template-columns:64px minmax(0,1fr);gap:9px 8px}.supervisor-item dt{color:var(--text-muted)}.supervisor-item dd{margin:0;overflow-wrap:anywhere}.supervisor-item details{border-top:1px solid var(--border-color);padding:13px 0;font-size:13px;line-height:1.7}.supervisor-item summary{cursor:pointer;color:var(--ui-accent)}.supervisor-item h4{margin:12px 0 4px}.supervisor-item ul{margin:0;padding-left:18px}.supervisor-item footer{margin-top:auto;padding-top:12px;display:flex;gap:8px}.supervisor-item footer .el-button{margin:0}.editor-pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.empty-state{padding:50px 0;color:var(--text-muted);text-align:center}@media(max-width:640px){.supervisor-heading{align-items:flex-start;flex-direction:column}.supervisor-filters{align-items:stretch;flex-direction:column;gap:8px}.editor-pair{grid-template-columns:1fr;gap:0}}
</style>
