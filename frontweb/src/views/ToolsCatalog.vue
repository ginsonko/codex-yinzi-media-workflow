<template>
  <div class="workbench-view">
    <div class="catalog-page">
      <div class="tool-actions"><el-button @click="experiencesOpen = true">制作经验</el-button><el-button @click="toolOptionsOpen = true">探索制作方案</el-button></div>
      <section class="catalog-hero"><div><span class="kicker">CODEX 可以自己选工具</span><h2>从目标出发，不用记工具名字</h2><p>你只需要说想完成什么。Codex 会先看任务和素材，再从这张目录里组合合适的能力；需要人工处理的模块会明确标出来。</p></div><div class="catalog-count"><strong>{{ filtered.length }}</strong><span>个可见模块</span></div></section>
      <section v-if="runtimeProfile" class="runtime-banner">
        <div><strong>本机运行环境：{{ runtimeProfile.machine?.platform }} / {{ runtimeProfile.machine?.arch }}</strong><p>CPU {{ runtimeProfile.machine?.cpu_count || '?' }} 核 · 内存 {{ runtimeProfile.machine?.memory_gib || '?' }} GiB</p><small v-if="profileUpdatedAt">最近同步 {{ profileUpdatedAt }}</small></div>
        <div class="component-list" aria-live="polite">
          <div v-for="component in runtimeComponents" :key="component.component_id" :class="['component-state', component.display.status]">
            <div class="component-heading"><strong>{{ componentLabel(component.component_id) }}</strong><span>{{ component.display.label }}</span></div>
            <el-progress v-if="component.display.percent != null" :percentage="component.display.percent" :stroke-width="5" />
            <p v-if="component.display.detail">{{ component.display.detail }}</p>
            <small v-if="component.installed && component.display.status !== 'ready'">已保留版本 {{ component.installed_version }}</small>
          </div>
        </div>
      </section>
      <el-alert v-if="profileError" :title="profileError" type="warning" show-icon :closable="false" />
      <section class="panel filters"><el-input v-model="query" clearable placeholder="搜索：图片、视频、剪辑、Blender、字幕…" class="search" /><el-radio-group v-model="track"><el-radio-button label="">全部版本</el-radio-button><el-radio-button label="V1">基础</el-radio-button><el-radio-button label="V2">研究</el-radio-button><el-radio-button label="V3">媒体</el-radio-button><el-radio-button label="V4">扩展</el-radio-button><el-radio-button label="V5">本地处理</el-radio-button></el-radio-group><div class="tool-actions"><input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onImportFile" /><el-button size="small" plain @click="openEditor()">新增工具</el-button><el-button size="small" plain @click="fileInput?.click()">导入工具包</el-button><el-button size="small" plain @click="exportTools">导出我的工具</el-button><el-button size="small" text @click="load">刷新</el-button></div></section>
      <el-alert v-if="error" class="catalog-error" :title="error" type="error" show-icon :closable="false" />
      <section class="catalog-grid"><article v-for="item in filtered" :key="item.module_id" class="module-card"><header><span :class="['phase', phaseTone(item.phase)]">{{ phaseLabel(item.phase) }}</span><span :class="['availability', availabilityTone(item.availability)]">{{ availabilityLabel(item.availability) }}</span></header><h3>{{ item.title || item.module_id }}</h3><p>{{ item.description_zh || item.description }}</p><p v-if="item.example" class="example">例如：{{ item.example }}</p><details><summary>技术合同</summary><code>{{ item.module_id }}</code><div class="io"><div><small>需要</small><span v-for="input in item.inputs || []" :key="input">{{ input }}</span></div><div><small>产出</small><span v-for="output in item.outputs || []" :key="output">{{ output }}</span></div></div></details><footer><span v-if="item.executor">执行者：{{ executorLabel(item.executor) }}</span><span v-if="item.component_id" class="component-dependency">组件：{{ componentLabel(item.component_id) }}</span><span v-if="item.validation_status === 'verified_windows_fixture'" class="verified">Windows 样本实测</span><span v-if="item.auto_install" class="auto-install">缺少时自动准备</span><span v-if="item.side_effects?.paid" class="paid">可能产生费用</span><span v-else>本地或无费用</span><span v-if="item.registered" class="custom-tool">社区工具</span><el-button v-if="item.registered" size="small" text @click="openEditor(item)">编辑</el-button><el-button v-if="item.registered" size="small" text @click="toggleTool(item)">{{ item.enabled === false ? '启用' : '停用' }}</el-button><el-button v-if="item.registered" size="small" text type="danger" @click="removeTool(item)">删除</el-button></footer></article></section>
      <div v-if="!loading && !filtered.length" class="empty">没有匹配的模块。你仍然可以直接向 Codex 描述目标，它会把未知需求保留在计划中并说明下一步。</div>
    </div>
    <MediaExperiencePanel v-model:open="experiencesOpen" />
    <MediaToolOptionsPanel v-model:open="toolOptionsOpen" />
    <el-dialog v-model="editorVisible" :title="editingId ? '编辑工具' : '新增工具'" width="min(640px, calc(100vw - 28px))" destroy-on-close>
      <el-form label-position="top" @submit.prevent="saveTool">
        <div class="tool-form-grid"><el-form-item label="工具编号"><el-input v-model="form.module_id" :disabled="Boolean(editingId)" placeholder="例如 community.storyboard" /></el-form-item><el-form-item label="名称"><el-input v-model="form.title" placeholder="给用户看的名称" /></el-form-item><el-form-item label="版本轨道"><el-input v-model="form.version_track" placeholder="custom" /></el-form-item><el-form-item label="阶段"><el-select v-model="form.phase"><el-option v-for="value in ['intake','research','plan','create','edit','qa','deliver']" :key="value" :label="value" :value="value" /></el-select></el-form-item><el-form-item label="执行者"><el-select v-model="form.executor"><el-option v-for="value in ['codex','local','provider','manual']" :key="value" :label="value" :value="value" /></el-select></el-form-item><el-form-item label="可用性"><el-select v-model="form.availability"><el-option v-for="value in ['integrated','bridge','advisory']" :key="value" :label="value" :value="value" /></el-select></el-form-item></div>
        <el-form-item label="说明"><el-input v-model="form.description_zh" type="textarea" :rows="3" /></el-form-item><el-form-item label="输入 / 输出"><el-input v-model="form.inputs" placeholder="输入字段，用逗号分隔" /><el-input v-model="form.outputs" class="form-output" placeholder="输出字段，用逗号分隔" /></el-form-item><el-form-item label="示例"><el-input v-model="form.example" /></el-form-item><el-checkbox v-model="form.enabled">允许 Codex 选择此工具</el-checkbox>
      </el-form>
      <template #footer><el-button @click="editorVisible = false">取消</el-button><el-button type="primary" @click="saveTool">保存</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { componentStatus } from '@/utils/componentStatus'
import orchestrationAPI from '@/api/orchestration'
import MediaExperiencePanel from '@/components/MediaExperiencePanel.vue'
import MediaToolOptionsPanel from '@/components/MediaToolOptionsPanel.vue'
const toolOptionsOpen = ref(false)
const experiencesOpen = ref(false)
const items = ref([]); const query = ref(''); const track = ref(''); const loading = ref(false); const error = ref(''); const fileInput = ref(null); const runtimeProfile = ref(null)
const editorVisible = ref(false); const editingId = ref('')
const profileError = ref(''); const profileUpdatedAt = ref('')
const runtimeComponents = computed(() => (runtimeProfile.value?.components || []).map(item => ({ ...item, display: componentStatus(item) })))
const form = reactive({ module_id:'', title:'', description_zh:'', version_track:'custom', phase:'create', executor:'codex', availability:'bridge', inputs:'', outputs:'', example:'', enabled:true })
const filtered = computed(() => items.value.filter(item => (!track.value || item.version_track === track.value) && (!query.value || (item.module_id + ' ' + item.title + ' ' + item.description_zh + ' ' + item.description + ' ' + item.phase).toLowerCase().includes(query.value.toLowerCase()))))

function phaseLabel(value) { return ({ intake: '准备', analyze: '分析', research: '研究', plan: '计划', create: '创作', edit: '剪辑', qa: '检查', deliver: '交付' })[value] || value || '其他' }
function phaseTone(value) { return value === 'qa' ? 'amber' : value === 'deliver' ? 'blue' : value === 'create' || value === 'edit' ? 'mint' : 'muted' }
function availabilityLabel(value) { return ({ integrated: '已接入', bridge: 'Codex 调用', advisory: '规划参考' })[value] || value || '未知' }
function availabilityTone(value) { return value === 'integrated' ? 'ready' : value === 'advisory' ? 'advisory' : 'bridge' }
function executorLabel(value) { return ({ local: '本机', provider: '模型服务', codex: 'Codex', manual: '你或 Codex' })[value] || value }
function componentLabel(value) { return ({ 'media.ffmpeg':'FFmpeg 媒体处理', 'media.sharp':'Sharp 图像处理', 'vision.realesrgan':'Real-ESRGAN 图片超分', 'vision.ocr':'图片文字识别', 'document.pdf':'PDF 文档处理' })[value] || value }
async function refreshProfile() {
  try {
    const profile = await orchestrationAPI.componentProfile()
    if (!Array.isArray(profile?.components) || !profile.machine) throw Error('运行环境响应不完整')
    runtimeProfile.value = profile; profileError.value = ''; profileUpdatedAt.value = new Date().toLocaleTimeString()
  } catch (_) { profileError.value = runtimeProfile.value ? '组件状态暂时无法更新，当前显示上次同步结果' : '暂时无法读取本机组件状态，正在重试' }
}
const profileRefresh = useLiveRefresh(refreshProfile, { active: () => runtimeComponents.value.some(item => item.display.active), failed: () => Boolean(profileError.value), interval: 1500, idle: 8000 })
async function loadModules() { loading.value = true; error.value = ''; try { const data = await orchestrationAPI.modules({ include_disabled: true }); items.value = data?.items || [] } catch (e) { error.value = e?.message || '暂时无法读取工具目录' } finally { loading.value = false } }
async function load() { await Promise.all([loadModules(), profileRefresh.refresh()]) }
function resetForm(item = null) { editingId.value = item?.module_id || ''; Object.assign(form, { module_id:item?.module_id || '', title:item?.title || '', description_zh:item?.description_zh || item?.description || '', version_track:item?.version_track || 'custom', phase:item?.phase || 'create', executor:item?.executor || 'codex', availability:item?.availability || 'bridge', inputs:(item?.inputs || []).join(', '), outputs:(item?.outputs || []).join(', '), example:item?.example || '', enabled:item?.enabled !== false }) }
function openEditor(item = null) { resetForm(item); editorVisible.value = true }
function splitList(value) { return String(value || '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean).slice(0, 60) }
async function saveTool() { const payload = { ...form, module_id:form.module_id.trim(), inputs:splitList(form.inputs), outputs:splitList(form.outputs), enabled:form.enabled }; if (!payload.module_id || !payload.title || !payload.description_zh) { ElMessage.warning('请填写工具编号、名称和说明'); return } try { if (editingId.value) await orchestrationAPI.updateModule(editingId.value, payload); else await orchestrationAPI.registerModule(payload); editorVisible.value = false; await load(); ElMessage.success(editingId.value ? '工具已更新' : '工具已添加') } catch (error) { ElMessage.error(error?.message || '保存工具失败') } }
async function onImportFile(event) {
  const file = event.target.files?.[0]; event.target.value = ''
  if (!file) return
  try {
    const payload = JSON.parse(await file.text())
    const result = await orchestrationAPI.importModules(payload)
    ElMessage.success(`导入完成：新增 ${result.added?.length || 0}，更新 ${result.updated?.length || 0}，跳过 ${result.skipped?.length || 0}`)
    if (result.errors?.length) ElMessage.warning(`有 ${result.errors.length} 条合同未导入，请检查格式`)
    await load()
  } catch (error) { ElMessage.error(error?.message || '工具包不是有效的 JSON 合同') }
}
async function exportTools() {
  try {
    const payload = await orchestrationAPI.exportModules({ include_disabled: true })
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `yinzi-tools-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(url)
  } catch (error) { ElMessage.error(error?.message || '导出工具失败') }
}
async function toggleTool(item) { try { await orchestrationAPI.updateModule(item.module_id, { enabled: item.enabled === false }); await load(); ElMessage.success(item.enabled === false ? '工具已启用' : '工具已停用') } catch (error) { ElMessage.error(error?.message || '更新工具状态失败') } }
async function removeTool(item) { try { await ElMessageBox.confirm(`删除“${item.title || item.module_id}”？导出的工具包仍可恢复。`, '删除工具', { type: 'warning' }); await orchestrationAPI.deleteModule(item.module_id); await load(); ElMessage.success('工具已删除') } catch (_) {} }
onMounted(loadModules)
useWorkbenchPage({ refresh: load, error: () => error.value, loading: () => loading.value })
</script>
<style scoped>
.catalog-page{display:grid;gap:18px}.catalog-hero{display:flex;justify-content:space-between;gap:24px;align-items:center;padding:25px 29px;border:1px solid var(--border-color);background:linear-gradient(110deg,var(--bg-card),var(--bg-card))}.kicker{color:var(--ui-accent);font-size:12px;letter-spacing:.12em}.catalog-hero h2{margin:9px 0 7px;font-size:28px}.catalog-hero p{max-width:760px;margin:0;color:var(--text-muted);font-size:13px;line-height:1.7}.catalog-count{min-width:130px;padding-left:17px;border-left:1px solid var(--border-color)}.catalog-count strong,.catalog-count span{display:block}.catalog-count strong{color:var(--ui-accent);font-size:32px}.catalog-count span{color:var(--text-muted);font-size:12px}.panel{padding:14px 16px;border:1px solid var(--border-color);background:var(--bg-card)}.runtime-banner{display:flex;justify-content:space-between;gap:18px;align-items:center}.runtime-banner p{margin:6px 0 0;color:var(--text-muted);font-size:12px}.runtime-stats{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;color:var(--text-muted);font-size:11px}.runtime-stats span{padding:5px 8px;border:1px solid var(--border-color)}.component-state.ready,.verified{color:var(--ui-accent)}.auto-install{color:var(--ui-info)}.filters{display:flex;align-items:center;gap:14px;flex-wrap:wrap}.search{max-width:370px}.catalog-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.module-card{min-width:0;padding:16px;border:1px solid var(--border-color);background:var(--bg-card)}.module-card header,.module-card footer{display:flex;align-items:center;justify-content:space-between;gap:8px}.phase,.availability{padding:3px 7px;border-radius:99px;font-size:11px}.phase{color:var(--text-muted);background:var(--bg-card)}.phase.mint{color:var(--ui-accent);background:var(--bg-card)}.phase.amber{color:var(--ui-warning);background:var(--bg-card)}.phase.blue{color:var(--ui-info);background:var(--bg-card)}.availability.ready{color:var(--ui-accent)}.availability.bridge{color:var(--ui-info)}.availability.advisory{color:var(--ui-warning)}.module-card h3{margin:15px 0 3px;color:var(--text-primary);font-size:15px}.module-card code{color:var(--text-muted);font-size:11px}.module-card p{min-height:52px;margin:13px 0;color:var(--text-muted);font-size:14px;line-height:1.7}.io{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:12px}.io>div{padding:8px;border:1px solid var(--border-color);background:var(--bg-card)}.io small{display:block;margin-bottom:6px;color:var(--text-muted);font-size:11px}.io span{display:inline-block;margin:2px 3px 2px 0;padding:2px 5px;color:var(--text-muted);background:var(--bg-card);font-size:11px}.module-card footer{justify-content:flex-start;flex-wrap:wrap;margin-top:13px;color:var(--text-muted);font-size:11px}.module-card footer .paid{color:var(--ui-warning)}.empty{padding:60px;text-align:center;color:var(--text-muted);font-size:12px}@media(max-width:1050px){.catalog-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.catalog-hero{flex-direction:column;align-items:flex-start;padding:20px}.catalog-count{width:100%;padding:10px 0 0;border-left:0;border-top:1px solid var(--border-color)}.catalog-grid{grid-template-columns:1fr}.filters{align-items:stretch}.search{max-width:none;width:100%}.runtime-banner{align-items:flex-start;flex-direction:column}.runtime-stats{justify-content:flex-start}}
.example{min-height:0!important;color:var(--text-primary)!important;font-size:12px!important}details summary{cursor:pointer;color:var(--text-muted);font-size:12px}details code{display:block;margin:10px 0;overflow-wrap:anywhere}
.tool-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 14px}.form-output{margin-top:8px}.catalog-error{margin-top:-6px}@media(max-width:650px){.tool-form-grid{grid-template-columns:1fr}}
.runtime-banner{padding:14px 0;border-block:1px solid var(--border-color)}
.runtime-banner small{color:var(--text-muted);font-size:11px}
.component-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;width:min(560px,100%)}
.component-state{min-width:0;font-size:12px;overflow-wrap:anywhere}
.component-heading{display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap}
.component-state p{margin:6px 0;line-height:1.6}
.component-state .el-progress{margin-top:8px}
.component-state.failed,.component-state.interrupted,.component-state.repair_required{color:var(--el-color-danger)}
.component-state.preparing{color:var(--ui-info)}
@media(max-width:650px){.component-list{grid-template-columns:1fr}}
</style>
