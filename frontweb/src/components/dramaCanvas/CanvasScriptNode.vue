<template>
  <div class="canvas-node-stack">
    <div
      class="canvas-script-node"
      :class="{
        focused: showPanel,
        empty: !hasScript,
        processing: isNodeBusy,
      }"
    >
      <Handle type="source" :position="Position.Right" />
      <CanvasNodeStatusOverlay :node-id="id" />
      <div class="head">
        <span class="badge">剧本</span>
        <span class="ep">第 {{ data.episode?.episode_number ?? '?' }} 集</span>
      </div>
      <div class="preview">{{ previewText }}</div>
      <div class="meta">
        <span>{{ charCount }} 角色</span>
        <span>{{ sceneCount }} 场景</span>
        <span>{{ propCount }} 道具</span>
      </div>
      <div class="hint">{{ showPanel ? '下方可编辑与提取' : '单击展开 · 创作起点' }}</div>
    </div>
    <CanvasScriptPanel
      v-if="showPanel"
      :episode="data.episode"
      :node-id="id"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasScriptPanel from './CanvasScriptPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)

const hasScript = computed(() => !!(props.data.episode?.script_content || '').trim())
const previewText = computed(() => {
  if (props.data.summary) return props.data.summary
  return hasScript.value ? '（剧本已填写）' : '暂无剧本，点击编辑'
})

const charCount = computed(() => (ctx?.drama?.value?.characters || []).length)
const sceneCount = computed(() => (ctx?.drama?.value?.scenes || []).length)
const propCount = computed(() => (ctx?.drama?.value?.props || []).length)

const isNodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map ? !!map[props.id] : false
})
</script>

<style scoped>
.canvas-node-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.canvas-script-node {
  position: relative;
  width: 220px;
  padding: 11px 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
  background: var(--bg-card);
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}
.canvas-script-node.focused {
  border-color: var(--border-bright);
  box-shadow: var(--shadow-glow);
}
.canvas-script-node.empty {
  border-style: dashed;
}
.canvas-script-node.processing {
  border-color: var(--ui-warning);
  animation: script-pulse 1.6s ease-in-out infinite;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--text-subtle);
}
.ep {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--text-faint);
}
.preview {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-primary);
  max-height: 56px;
  overflow: hidden;
  margin-bottom: 8px;
}
.meta {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.meta span {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-inner);
  color: var(--text-subtle);
}
.hint {
  font-size: 10px;
  color: var(--text-faint);
}
@keyframes script-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--ui-warning-soft); }
  50% { box-shadow: 0 0 0 5px transparent; }
}
</style>
