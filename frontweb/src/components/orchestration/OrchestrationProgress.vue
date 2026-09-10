<template>
  <section class="experience-panel progress-panel" aria-labelledby="progress-title">
    <header class="experience-heading">
      <div><small>现在进行到哪里</small><h3 id="progress-title">制作进度</h3></div>
      <span v-if="progress.percent !== null" class="progress-number">{{ progress.percent }}%</span>
      <span v-else class="progress-number">阶段制</span>
    </header>
    <el-progress v-if="progress.percent !== null" :percentage="progress.percent" :stroke-width="10" :show-text="false" status="success" />
    <div class="progress-copy" aria-live="polite">
      <strong>{{ currentText }}</strong>
      <span>{{ detailText }}</span>
    </div>
    <div class="progress-stages">
      <span v-for="stage in stages" :key="stage.key" :class="stage.tone"><i></i>{{ stage.label }}</span>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { sessionProgress } from '@/utils/orchestrationExperience'

const props = defineProps({ session: { type: Object, default: () => ({}) }, nodes: { type: Array, default: () => [] }, delivery: { type: Object, default: () => ({}) } })
const progress = computed(() => sessionProgress(props.session, props.nodes))
const delivered = computed(() => ['delivered','validated','completed','succeeded'].includes(String(props.delivery.status || '').toLowerCase()))
const detailText = computed(() => {
  const status = String(props.session.status || '').toLowerCase()
  if (progress.value.total) return `已结束 ${progress.value.done} / ${progress.value.total} 个步骤`
  if (['succeeded', 'partial', 'failed', 'cancelled'].includes(status)) return '执行记录已保存，成果内容核对状态可在下方查看'
  return '等待执行步骤或本地工具作业的进展'
})
const currentText = computed(() => {
  const status = String(props.session.status || '').toLowerCase()
  if (status === 'succeeded') return delivered.value ? '制作已完成，成果已整理到交付区' : '制作已完成，可在成果预览中查看结果'
  if (status === 'partial') return '任务已结束，部分处理未能完成'
  if (status === 'failed') return '制作未完成，可查看失败步骤并恢复'
  if (status === 'cancelled') return '制作已取消，已有成果和记录仍保留'
  if (status === 'paused') return '制作已暂停，可以从恢复点继续'
  if (progress.value.current?.progress?.message) return progress.value.current.progress.message
  if (progress.value.current?.status === 'failed') return '有一个步骤需要处理'
  if (progress.value.current?.status === 'partial') return '有一个步骤只完成了一部分'
  if (progress.value.current?.status === 'running') return '正在执行当前步骤'
  if (props.session.status === 'waiting_confirmation') return '计划已准备好，等待你确认'
  return 'Codex 正在准备下一步'
})
const stages = computed(() => {
  const names = [['prepare', '准备'], ['create', '创作'], ['review', '检查'], ['deliver', '交付']]
  const status = String(props.session.status || '')
  const current = status === 'succeeded' ? (delivered.value ? 4 : 3) : status === 'running' ? 2 : status === 'partial' ? 3 : status === 'waiting_confirmation' ? 1 : 0
  return names.map(([key, label], index) => ({ key, label, tone: index < current ? 'done' : index === current ? 'current' : '' }))
})
</script>

<style scoped>
.experience-panel{border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);padding:18px 20px}.experience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.experience-heading small{display:block;margin-bottom:4px;color:var(--ui-accent);font-size:11px;font-weight:800;letter-spacing:.12em}.experience-heading h3{margin:0;color:var(--text-primary);font-size:15px}.progress-number{color:var(--ui-accent);font-size:15px;font-weight:700}.progress-copy{display:grid;gap:4px;margin-top:12px}.progress-copy strong{color:var(--text-primary);font-size:12px}.progress-copy span{color:var(--text-muted);font-size:12px}.progress-stages{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-top:14px;color:var(--text-muted);font-size:11px}.progress-stages span{display:flex;align-items:center;gap:5px}.progress-stages i{width:7px;height:7px;border-radius:50%;background:var(--bg-card)}.progress-stages .done{color:var(--ui-accent)}.progress-stages .done i{background:var(--ui-accent)}.progress-stages .current{color:var(--ui-accent)}.progress-stages .current i{background:var(--ui-accent);box-shadow:0 0 0 3px rgba(45,212,191,.12)}
</style>
