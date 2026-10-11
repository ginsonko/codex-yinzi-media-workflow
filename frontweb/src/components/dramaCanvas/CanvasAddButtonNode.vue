<template>
  <div
    class="canvas-add-node"
    :class="'kind-' + data.assetType"
    @click.stop="onClick"
  >
    <span class="add-icon">+</span>
    <span class="add-label">{{ data.label || defaultLabel }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()

const defaultLabel = computed(() => {
  const map = { character: '新建角色', scene: '新建场景', prop: '新建道具', storyboard: '新建分镜' }
  return map[props.data.assetType] || '新建'
})

function onClick() {
  ctx?.openCreateDialog?.(props.data.assetType)
}
</script>

<style scoped>
/* 虚线 = 这里还能加东西，和实色节点区分开 */
.canvas-add-node {
  width: 176px;
  padding: 13px 12px;
  border-radius: var(--radius-sm);
  border: 1px dashed var(--border-muted);
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: border-color .15s, background .15s;
}
.canvas-add-node:hover {
  border-color: var(--border-bright);
  background: var(--bg-hover);
}
.add-icon {
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: 1px solid var(--border-muted);
  color: var(--text-subtle);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}
.add-label {
  font-size: 11.5px;
  color: var(--text-subtle);
}
.kind-storyboard { width: 200px; }
</style>
