<template>
  <div class="workbench-view supervisor-page">
    <header class="supervisor-heading"><div><h2>作品监督</h2><p>{{ availableCount }} 位可用 · {{ items.filter(item => item.builtin).length }} 位内置</p></div><div class="actions">
      <el-button :icon="Plus" type="primary" @click="edit()">新增监督</el-button>
      <el-button :icon="Upload" :disabled="loading || !exchangeLimits" @click="fileInput?.click()">导入</el-button><el-button :icon="Download" :disabled="loading" @click="openExport">导出</el-button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="importProfiles" />
    </div></header>
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false">
      <div class="error-detail">目录来自本地后端 <span class="num">/api/v1/media-supervisors</span>。先确认后端在运行，再点这里的重试。</div>
      <el-button size="small" @click="load">重试</el-button>
    </el-alert>
    <!-- 这一页在管什么 -->
    <section class="scope-note" aria-label="这一页在管什么">
      <p>
        这一页决定「谁来验收」：监督者是一套写下来的审片标准（风格、视觉、声音、审片重点）。改的是标准本身，不是某一部成片。
        规则只对<strong>之后新建</strong>的任务生效，已经开跑的任务继续用它当时保存的那一版快照，不会因为你今天改了字而变。
      </p>
    </section>

    <section class="recommend-box" aria-label="推荐预览">
      <header>
        <div>
          <h3>推荐预览：这段文字会挑中哪个监督者</h3>
          <p>把任务目标粘进来，先看它会推荐谁、命中了哪些关键词，再决定要不要换。命中越长的关键词得分越高。</p>
        </div>
        <el-button size="small" :loading="recommending" :disabled="!recommendGoal.trim()" @click="runRecommend">试算推荐</el-button>
      </header>
      <el-input v-model="recommendGoal" type="textarea" :rows="2" maxlength="12000" placeholder="例如：给白瓷香薰瓶做 15 秒竖版商品短片，节奏要卡点，瓶身材质看得清" />
      <p v-if="recommendError" class="recommend-error" role="alert">试算失败：{{ recommendError }}。目录能正常读取时，通常是目标文字过长或后端未启动，缩短后重试。</p>
      <div v-if="recommendation" class="recommend-result">
        <div class="recommend-main">
          <span class="rank">首选</span>
          <strong>{{ recommendation.main?.name || '没有合适的内置监督' }}</strong>
          <span v-if="recommendation.main" class="num">得分 {{ recommendation.main.score }} · v{{ recommendation.main.revision }}</span>
        </div>
        <p v-if="recommendation.main">{{ recommendation.main.reason }}</p>
        <p v-else>这段目标没有命中任何关键词。可以把目标写得更具体，或按下面的备选手动指定。</p>
        <div v-if="recommendation.alternatives?.length" class="recommend-alts">
          <span>备选</span>
          <button v-for="alt in recommendation.alternatives" :key="alt.supervisor_id" type="button" @click="editById(alt.supervisor_id)">
            {{ alt.name }}<em class="num">得分 {{ alt.score }} · v{{ alt.revision }}</em>
          </button>
        </div>
        <small>依据：{{ recommendation.basis === 'editable_keyword_match' ? '标签关键词匹配（改标签会改变推荐结果）' : recommendation.basis }}</small>
      </div>
    </section>

    <div class="supervisor-filters">
      <el-input v-model="query" placeholder="搜索名称、风格或适合的作品" clearable maxlength="240" :prefix-icon="Search" />
      <el-select v-model="statusFilter" class="filter-select" aria-label="启用状态筛选">
        <el-option label="全部状态" value="all" />
        <el-option label="仅启用" value="enabled" />
        <el-option label="仅停用" value="disabled" />
      </el-select>
      <el-select v-model="sortBy" class="filter-select" aria-label="排序方式">
        <el-option label="目录顺序" value="default" />
        <el-option label="按名称" value="name" />
        <el-option label="按规则条数" value="rules" />
      </el-select>
      <el-switch v-model="showDeleted" active-text="显示已删除" />
      <span class="num filter-count">显示 {{ filtered.length }} / {{ items.length }} 位</span>
    </div>
    <div v-if="loading" class="empty-state" aria-live="polite">正在读取监督目录…</div>
    <div v-else-if="!filtered.length" class="empty-state">
      <template v-if="items.length">
        <strong>当前筛选没有匹配的监督</strong>
        <p>把状态筛选改回「全部」、清空搜索词，或打开「显示已删除」。</p>
        <el-button size="small" @click="clearFilters">清除筛选</el-button>
      </template>
      <template v-else>
        <strong>还没有任何监督</strong>
        <p>监督者是审片标准的文字描述。可以先复制一位内置版本改字，或直接新增。</p>
        <el-button size="small" type="primary" :icon="Plus" @click="edit()">新增监督</el-button>
      </template>
    </div>
    <section v-else class="supervisor-grid" aria-label="监督目录">
      <article v-for="item in filtered" :key="item.id" :class="['supervisor-item', { inactive: !item.enabled || item.deleted }]">
        <header><div><h3>{{ item.name }}</h3><span class="meta-line">{{ item.builtin ? '内置' : '自定义' }} · v{{ item.revision }}{{ item.deleted ? ' · 已删除' : '' }} · 规则 <em class="num">{{ ruleCount(item) }}</em> 条</span></div><el-switch v-if="!item.deleted" :model-value="item.enabled" :aria-label="`启用${item.name}`" :disabled="busy === item.id" @change="toggle(item, $event)" /></header>
        <p class="style">{{ item.style }}</p><dl><dt>适合</dt><dd>{{ item.suitable_for || '按实际任务选择' }}</dd><dt>观众感受</dt><dd>{{ item.audience_feeling || '未指定' }}</dd><dt>需要留意</dt><dd>{{ item.tradeoff || '未指定' }}</dd></dl>
        <details><summary>视觉、声音与审片重点</summary><h4>视觉</h4><ul><li v-for="rule in item.visual_rules" :key="rule">{{ rule }}</li></ul><h4>声音</h4><ul><li v-for="rule in item.audio_rules" :key="rule">{{ rule }}</li></ul><h4>审片</h4><ul><li v-for="rule in item.review_criteria" :key="rule">{{ rule }}</li></ul></details>
        <!-- 快速改规则：只改你写的那几行，保存即升版本 -->
        <details v-if="!item.deleted" class="rules-quick">
          <summary>在这里直接改规则</summary>
          <div class="quick-grid">
            <label v-for="field in ruleFields" :key="`quick-${field.key}`">
              <span>{{ field.label }}<em>每行一条；留空会被后端拒绝</em></span>
              <textarea v-model="quickValues(item)[field.key]" rows="3" />
            </label>
          </div>
          <small class="quick-note">保存后版本号加一，之后新建的任务用新版本；已有任务仍用各自的快照版本。改「推荐关键词」会影响上面的推荐结果。</small>
          <div class="quick-actions">
            <span v-if="quickDirty(item)" class="quick-dirty">有未保存的改动</span>
            <el-button size="small" :loading="busy === item.id" :disabled="!quickDirty(item)" @click="saveQuick(item)">保存规则</el-button>
            <el-button size="small" text :disabled="!quickDirty(item)" @click="resetQuick(item)">还原</el-button>
          </div>
        </details>
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
function ruleCount(item) {
  return (item.visual_rules?.length || 0) + (item.audio_rules?.length || 0) + (item.review_criteria?.length || 0)
}
const filtered = computed(() => {
  const matched = items.value.filter(item => {
    if (!showDeleted.value && item.deleted) return false
    if (statusFilter.value === 'enabled' && (!item.enabled || item.deleted)) return false
    if (statusFilter.value === 'disabled' && item.enabled && !item.deleted) return false
    if (query.value && !`${item.name} ${item.style} ${item.suitable_for} ${item.tags.join(' ')}`.toLowerCase().includes(query.value.toLowerCase())) return false
    return true
  })
  if (sortBy.value === 'name') return [...matched].sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'))
  if (sortBy.value === 'rules') return [...matched].sort((a, b) => ruleCount(b) - ruleCount(a))
  return matched
})
const exportAvailable = computed(() => (exportScope.value === 'search' ? filtered.value : items.value).filter(item => !item.deleted).length)
const exportSelected = computed(() => exportPartial.value ? Math.max(0, Math.min(exportCount.value || 0, exportAvailable.value - (exportStart.value || 1) + 1)) : exportAvailable.value)
const quickEdit = reactive({})
const statusFilter = ref('all'), sortBy = ref('default')
const recommendGoal = ref(''), recommendation = ref(null), recommending = ref(false), recommendError = ref('')

function clearFilters() { query.value = ''; statusFilter.value = 'all'; sortBy.value = 'default' }
/* 快速编辑：每张卡片自己一份草稿，避免和弹窗表单互相污染 */
function quickValues(item) {
  if (!quickEdit[item.id]) {
    const draft = {}
    for (const field of ruleFields) draft[field.key] = (item[field.key] || []).join('\n')
    quickEdit[item.id] = draft
  }
  return quickEdit[item.id]
}
function resetQuick(item) {
  const draft = {}
  for (const field of ruleFields) draft[field.key] = (item[field.key] || []).join('\n')
  quickEdit[item.id] = draft
}
function quickDirty(item) {
  const values = quickValues(item)
  return ruleFields.some(field => values[field.key] !== (item[field.key] || []).join('\n'))
}
async function saveQuick(item) {
  const values = quickValues(item)
  const body = {}
  for (const field of ruleFields) body[field.key] = values[field.key].split('\n').map(v => v.trim()).filter(Boolean)
  if (ruleFields.some(field => !body[field.key].length)) return ElMessage.warning('三类规则都至少要留一条，否则审片时无依据')
  busy.value = item.id
  try {
    // 只改规则字段，其余字段原样带回，避免整章替换时静默丢掉已有内容
    await api.update(item.id, {
      name: item.name, style: item.style, suitable_for: item.suitable_for,
      audience_feeling: item.audience_feeling, tradeoff: item.tradeoff,
      tags: item.tags, enabled: item.enabled,
      ...body,
      expected_revision: item.revision,
    })
    await load()
    ElMessage.success(`「${item.name}」规则已保存，之后新建的任务用新版本`)
  } catch (e) { ElMessage.error(e.message || '保存失败；版本可能已被另外一次修改占用，重新读取后再改') } finally { busy.value = '' }
}
function editById(id) {
  const item = items.value.find(entry => entry.id === id)
  if (item) edit(item)
}
async function runRecommend() {
  recommendError.value = ''
  recommending.value = true
  try {
    const result = await api.recommend(recommendGoal.value.trim())
    recommendation.value = result
    if (!result?.main) ElMessage.info('这段目标没有命中的关键词，可以自己指定监督者')
  } catch (e) { recommendError.value = e.message || '试算推荐失败' } finally { recommending.value = false }
}

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

/* 这一页在管什么 + 推荐预览：实色块 + 一根线，不用玻璃卡片堆 */
.scope-note{margin:0 0 18px;padding:11px 14px;border:1px solid var(--border-color);border-left:2px solid var(--border-bright);border-radius:var(--radius-sm);background:var(--bg-inner);}
.scope-note p{margin:0;max-width:104ch;color:var(--text-muted);font-size:12px;line-height:1.8;}
.scope-note strong{color:var(--text-primary);}
.recommend-box{margin:0 0 18px;padding:15px 16px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-card);display:grid;gap:11px;}
.recommend-box header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;}
.recommend-box h3{margin:0;font-size:15px;font-family:var(--font-display);}
.recommend-box header p{margin:6px 0 0;color:var(--text-muted);font-size:12px;line-height:1.7;max-width:76ch;}
.recommend-error{margin:0;padding:8px 11px;border:1px solid var(--ui-danger);border-radius:var(--radius-sm);color:var(--ui-danger);font-size:12px;line-height:1.7;}
.recommend-result{display:grid;gap:8px;padding:11px 12px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-inner);font-size:12px;}
.recommend-main{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.recommend-main .rank{padding:2px 7px;border:1px solid var(--border-muted);border-radius:var(--radius-sm);color:var(--text-subtle);font-size:11px;}
.recommend-main strong{color:var(--text-primary);font-size:14px;}
.recommend-main .num{color:var(--text-subtle);}
.recommend-result p{margin:0;color:var(--text-muted);line-height:1.7;}
.recommend-result small{color:var(--text-faint);line-height:1.6;}
.recommend-alts{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.recommend-alts>span{color:var(--text-faint);font-size:11px;}
.recommend-alts button{display:inline-flex;align-items:center;gap:7px;padding:5px 10px;border:1px solid var(--border-color);background:transparent;color:var(--text-muted);border-radius:var(--radius-sm);font:inherit;font-size:12px;cursor:pointer;transition:border-color .14s ease-out,color .14s ease-out;}
.recommend-alts button:hover{border-color:var(--border-bright);color:var(--text-primary);}
.recommend-alts em{font-style:normal;color:var(--text-faint);font-size:11px;}
.filter-select{width:150px;}
.filter-count{margin-left:auto;color:var(--text-subtle);font-size:12px;}
.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums;}
.error-detail{margin:6px 0 8px;color:var(--text-muted);font-size:12px;line-height:1.7;}
.meta-line{font-family:var(--font-ui);}
.meta-line em{font-style:normal;}
.rules-quick{border-top:1px solid var(--border-color);padding:12px 0;font-size:12px;}
.rules-quick summary{cursor:pointer;color:var(--ui-accent);}
.quick-grid{display:grid;gap:10px;margin-top:11px;}
.quick-grid label{display:grid;gap:6px;}
.quick-grid span{display:grid;gap:3px;color:var(--text-muted);font-size:11px;}
.quick-grid em{font-style:normal;color:var(--text-faint);font-size:11px;}
.quick-grid textarea{box-sizing:border-box;width:100%;min-height:70px;padding:8px 10px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-inner);color:var(--text-primary);font:inherit;font-size:12px;line-height:1.65;resize:vertical;}
.quick-note{display:block;margin-top:9px;color:var(--text-faint);font-size:11px;line-height:1.65;}
.quick-actions{display:flex;align-items:center;gap:10px;margin-top:10px;}
.quick-actions .el-button+.el-button{margin-left:0;}
.quick-dirty{color:var(--ui-warning);font-size:11px;}
@media(max-width:640px){.filter-select{width:100%;}.filter-count{margin-left:0;}.recommend-box header{flex-direction:column;}}
</style>
