<template>
  <section class="task-supervisor" aria-label="作品风格监督">
    <header><div><small>{{ selection?.active ? '当前监督' : selection?.mode === 'off' ? '风格监督已关闭' : '推荐监督' }}</small><h3>{{ selection?.mode === 'off' ? '由你决定作品方向' : selection?.profile?.name || recommendations?.main?.name || '选择作品监督' }} <span v-if="selection?.profile">v{{ selection.profile.revision }}</span></h3></div><router-link to="/supervisors">管理监督</router-link></header>
    <p v-if="selection?.profile && selection?.mode !== 'off'">{{ selection.profile.style }}<span class="tradeoff">{{ selection.profile.tradeoff }}</span></p>
    <div v-if="!selection?.active && selection?.mode !== 'off'" class="recommendations"><button v-for="item in recommendationItems" :key="item.supervisor_id" type="button" :disabled="disabled || saving" @click="choose(item.supervisor_id)"><strong>{{ item.name }}</strong><span>{{ item.reason }}</span></button></div>
    <div class="selection-controls"><el-select v-model="choice" aria-label="选择作品监督" filterable :disabled="disabled || saving"><el-option label="按当前目标自动选择" value="auto" /><el-option label="关闭风格监督" value="off" /><el-option v-for="item in profiles" :key="item.id" :label="`${item.name} · ${item.style}`" :value="item.id" /></el-select><el-input v-model="reason" aria-label="调整原因" placeholder="调整原因（可选）" :disabled="disabled || saving" maxlength="2000" /><el-button type="primary" :icon="Check" :loading="saving" :disabled="disabled" @click="choose(choice)">采用</el-button></div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <details v-if="selection?.profile && selection?.mode !== 'off'"><summary>本次审片重点</summary><ul><li v-for="rule in selection.profile.review_criteria" :key="rule">{{ rule }}</li></ul><p class="snapshot-note">任务快照 #{{ selection.revision }} · {{ selection.reason }}</p></details>
    <div v-if="selection?.reviews?.length" class="review-list"><article v-for="review in selection.reviews" :key="review.id"><strong>{{ stageLabels[review.stage] }} · {{ outcomeLabels[review.outcome] }}</strong><span>{{ review.reviewer }}</span><p>{{ review.summary }}</p><ul v-if="review.findings?.length"><li v-for="(finding, index) in review.findings" :key="index">{{ finding.timecode }} {{ finding.issue }}；{{ finding.change }}</li></ul><details><summary>证据引用</summary><ul><li v-for="ref in review.evidence_refs" :key="ref">{{ ref }}</li></ul></details></article></div>
    <details class="selection-history" @toggle="readHistory"><summary>选择与审片历史</summary><p v-if="!historyItems.length">暂无历史记录</p><ol><li v-for="item in historyItems" :key="item.revision">#{{ item.revision }} {{ item.profile?.name || '关闭' }} · {{ item.reason }} · {{ item.selected_at }}</li></ol><ul v-if="historicalReviews.length"><li v-for="review in historicalReviews" :key="review.id">快照 #{{ review.selection_revision }} · {{ stageLabels[review.stage] }} · {{ outcomeLabels[review.outcome] }} · {{ review.summary }}</li></ul></details>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { Check } from '@element-plus/icons-vue'
import api from '@/api/styleSupervisors'

const props = defineProps({ session: { type: Object, required: true }, disabled: Boolean })
const emit = defineEmits(['changed'])
const profiles = ref([]), selection = ref(null), recommendations = ref(null), choice = ref('auto'), reason = ref(''), saving = ref(false), error = ref(''), historyItems = ref([]), historicalReviews = ref([])
const stageLabels = { plan: '方案', rough_cut: '粗剪', final: '成片' }, outcomeLabels = { not_reviewed: '尚未审片', changes_requested: '需要修改', passed: '审片意见通过' }
const recommendationItems = computed(() => [recommendations.value?.main, ...(recommendations.value?.alternatives || [])].filter(Boolean))
let generation = 0
watch(() => [props.session.id, props.session.supervisor?.revision], async () => {
  const token = ++generation
  selection.value = props.session.supervisor || null
  recommendations.value = selection.value?.recommendation || null
  choice.value = selection.value?.mode === 'off' ? 'off' : selection.value?.active ? selection.value.profile?.id || 'auto' : 'auto'
  historyItems.value = []; historicalReviews.value = []; error.value = ''
  try { const result = await api.list({ enabled_only: true }); if (token !== generation) return; profiles.value = result.items; if (!recommendations.value) { const result = await api.recommend(props.session.user_goal); if (token === generation) recommendations.value = result } } catch (e) { if (token === generation) error.value = e.message || '监督读取失败' }
}, { immediate: true })
watch(() => props.session.supervisor?.reviews, reviews => {
  if (selection.value && selection.value.revision === props.session.supervisor?.revision) selection.value = { ...selection.value, reviews: reviews || [] }
})
async function choose(value) {
  if (props.disabled || saving.value) return
  saving.value = true; error.value = ''
  const sessionId = props.session.id
  try { const result = await api.choose(sessionId, { mode: ['auto', 'off'].includes(value) ? value : 'manual', ...(!['auto', 'off'].includes(value) ? { supervisor_id: value } : {}), expected_revision: selection.value?.revision || 0, reason: reason.value || '用户在工作台调整作品方向', actor: 'user' }); if (sessionId !== props.session.id) return; selection.value = result; recommendations.value = result.recommendation; reason.value = ''; emit('changed') } catch (e) { if (sessionId === props.session.id) error.value = e.message || '选择失败，请刷新' } finally { saving.value = false }
}
async function readHistory(event) { if (!event.target.open) return; const id = props.session.id; try { const result = await api.context(id); if (id === props.session.id) { historyItems.value = result.history; historicalReviews.value = result.reviews } } catch (e) { error.value = e.message } }
</script>

<style scoped>
.task-supervisor{padding:22px 0;border-top:1px solid var(--border-color);border-bottom:1px solid var(--border-color);margin:18px 0;color:var(--text-primary);letter-spacing:0}.task-supervisor header{display:flex;align-items:center;justify-content:space-between;gap:14px}.task-supervisor header small{color:var(--text-muted);font-size:12px}.task-supervisor h3{font-size:19px;margin:6px 0}.task-supervisor h3 span{font-size:12px;font-weight:400;color:var(--text-muted)}.task-supervisor a{color:var(--ui-accent);font-size:13px}.task-supervisor p{font-size:14px;line-height:1.7}.tradeoff{display:block;color:var(--text-muted);font-size:12px}.selection-controls{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}.selection-controls .el-select{width:300px;max-width:100%}.selection-controls .el-input{flex:1;min-width:150px}.selection-controls .el-button{margin:0}.task-supervisor details{font-size:13px;line-height:1.8;overflow-wrap:anywhere}.task-supervisor summary{cursor:pointer}.task-supervisor ul,.task-supervisor ol{padding-left:20px}.snapshot-note{color:var(--text-muted)}.recommendations{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:16px 0}.recommendations button{padding:12px;text-align:left;cursor:pointer;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-card);color:var(--text-primary)}.recommendations button:hover{border-color:var(--ui-accent)}.recommendations strong,.recommendations span{display:block}.recommendations span{font-size:12px;color:var(--text-muted);line-height:1.6;margin-top:6px}.review-list article{padding:14px 0;border-top:1px solid var(--border-color);font-size:13px}.review-list article>span{margin-left:12px;color:var(--text-muted)}.selection-history{margin-top:14px}@media(max-width:620px){.recommendations{grid-template-columns:1fr}.selection-controls .el-select,.selection-controls .el-input{width:100%;flex:auto}.selection-controls .el-button{width:100%}}
</style>
