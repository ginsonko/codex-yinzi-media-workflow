<template>
  <section class="activity-panel">
    <div class="activity-header">
      <div><strong>活动记录</strong><span>每一步都留下可追溯记录</span></div>
      <el-select v-model="filter" size="small" aria-label="活动记录筛选">
        <el-option label="全部" value="all" /><el-option label="用户与审批" value="review" /><el-option label="生成与队列" value="generation" /><el-option label="异常" value="error" />
      </el-select>
    </div>
    <div v-if="filteredEvents.length" class="activity-list">
      <article v-for="event in filteredEvents" :key="event.id" :class="['activity-item', `tone-${eventTone(event)}`]">
        <span class="activity-dot" aria-hidden="true" />
        <div class="activity-copy"><strong>{{ eventLabel(event) }}</strong><span>{{ eventSummary(event) }}</span></div>
        <time>{{ formatTime(event.created_at) }}</time>
      </article>
    </div>
    <p v-else class="activity-empty">还没有符合筛选条件的记录。</p>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import { eventLabel, eventSummary, eventTone } from '@/utils/videoRouting'

const props = defineProps({ events: { type: Array, default: () => [] } })
const filter = ref('all')
const filteredEvents = computed(() => (props.events || []).filter((event) => {
  if (filter.value === 'all') return true
  const type = String(event.event_type || '')
  if (filter.value === 'error') return type.includes('failed') || type.includes('ambiguous') || eventTone(event) === 'danger'
  if (filter.value === 'review') return type.includes('review') || type.includes('transition')
  return type.includes('action') || type.includes('generation') || type.includes('provider')
}))

function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

</script>

<style scoped>
.activity-panel { padding: 15px 0 0; border-top: 1px solid #dfe6e7; }.activity-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.activity-header > div { display: grid; gap: 3px; }.activity-header strong { color: #30444b; font-size: 13px; }.activity-header span { color: #849197; font-size: 11px; }.activity-list { display: grid; gap: 0; margin-top: 10px; }.activity-item { min-height: 42px; display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; align-items: center; gap: 9px; border-bottom: 1px solid #edf0f1; }.activity-dot { width: 7px; height: 7px; border-radius: 50%; background: #8ba0a5; }.tone-progress .activity-dot { background: #238277; }.tone-review .activity-dot { background: #b18a46; }.tone-danger .activity-dot { background: #bc5a4d; }.activity-copy { display: grid; gap: 2px; min-width: 0; }.activity-copy strong { color: #44565d; font-size: 11px; }.activity-copy span, .activity-item time { color: #8a969b; font-size: 10px; overflow-wrap: anywhere; }.activity-item time { white-space: nowrap; }.activity-empty { color: #8b989d; font-size: 11px; }
@media (max-width: 560px) { .activity-header { align-items: flex-start; flex-direction: column; }.activity-item { grid-template-columns: 12px minmax(0, 1fr); padding: 7px 0; }.activity-item time { grid-column: 2; } }
</style>
