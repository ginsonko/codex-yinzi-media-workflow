<template>
  <div v-if="status" class="node-status-overlay" :class="'step-' + status.step">
    <span class="spinner" />
    <span class="msg">{{ status.message }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  nodeId: { type: String, required: true },
})

const ctx = useCanvasContext()

const status = computed(() => {
  const map = ctx?.nodeStatus?.map
  if (!map || !props.nodeId) return null
  return map[props.nodeId] || null
})
</script>

<style scoped>
.node-status-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  background: var(--bg-deep);
  opacity: .92;
  border-radius: inherit;
  pointer-events: none;
}
/* 转圈 = 正在跑，统一琥珀；转圈本身是加载指示，不是装饰 */
.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-muted);
  border-top-color: var(--ui-warning);
  border-radius: 50%;
  animation: spin .75s linear infinite;
}
.msg {
  font-size: 10px;
  color: var(--text-primary);
  text-align: center;
  padding: 0 8px;
  line-height: 1.35;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
