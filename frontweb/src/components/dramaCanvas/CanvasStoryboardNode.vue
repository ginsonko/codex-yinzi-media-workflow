<template>
  <div class="canvas-node-stack">
    <div class="canvas-sb-node" :class="{ selected: selected, highlighted: data.highlighted, dimmed: data.dimmed, processing: isProcessing || isNodeBusy, focused: showPanel }">
    <Handle id="chain-in" type="target" :position="Position.Top" />
    <Handle type="target" :position="Position.Left" />
    <Handle type="source" :position="Position.Right" />
    <Handle id="chain-out" type="source" :position="Position.Bottom" />
      <CanvasNodeStatusOverlay :node-id="id" />
      <div class="head">
        <span class="num">#{{ data.storyboard?.storyboard_number ?? data.index }}</span>
        <span v-if="data.workflowGroup?.title" class="wf-badge">{{ data.workflowGroup.title }}</span>
        <span v-if="data.storyboard?.segment_title" class="seg">{{ data.storyboard.segment_title }}</span>
      <span v-if="data.storyboard?.creation_mode === 'universal'" class="mode-badge">全能</span>
      </div>
      <div class="title">{{ data.storyboard?.title || '分镜' }}</div>
      <div class="chips">
        <span v-if="data.storyboard?.shot_type">{{ data.storyboard.shot_type }}</span>
        <span v-if="data.storyboard?.duration">{{ data.storyboard.duration }}s</span>
        <span :class="'st-' + (data.storyboard?.status || 'pending')">{{ statusLabel }}</span>
      </div>
      <div class="hint">{{ showPanel ? '下方可编辑与生成' : '单击展开操作 · 双击进列表' }}</div>
    </div>
    <CanvasStoryboardPanel
      v-if="showPanel"
      :storyboard="data.storyboard"
      :episode-id="data.episodeId"
      :node-id="id"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasStoryboardPanel from './CanvasStoryboardPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
  selected: { type: Boolean, default: false },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)

const statusLabel = computed(() => {
  const s = props.data.storyboard?.status || 'pending'
  const map = { pending: '待处理', processing: '生成中', completed: '已完成', failed: '失败' }
  return map[s] || s
})

const isProcessing = computed(() => props.data.storyboard?.status === 'processing')

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
.canvas-sb-node {
  position: relative;
  width: 200px;
  padding: 11px 13px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
  background: var(--bg-card);
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}
/* 悬停 / 选中 / 展开编辑：铬色亮线，不用紫色 */
.canvas-sb-node:hover,
.canvas-sb-node.selected,
.canvas-sb-node.focused {
  border-color: var(--border-bright);
  box-shadow: var(--shadow-glow);
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
}
.num {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
}
.wf-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-muted);
  background: var(--bg-inner);
  color: var(--text-subtle);
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.seg {
  font-size: 10px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mode-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-muted);
  background: var(--bg-inner);
  color: var(--text-subtle);
}
.title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-bright);
  margin-bottom: 6px;
  line-height: 1.35;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.chips span {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-inner);
  color: var(--text-subtle);
}
/* 状态只管状态：琥珀=在跑，绿=成了，红=砸了 */
.chips .st-completed { color: var(--ui-success); background: var(--ui-success-soft); }
.chips .st-processing { color: var(--ui-warning); background: var(--ui-warning-soft); }
.chips .st-failed { color: var(--ui-danger); background: var(--ui-danger-soft); }
/* 正在生成的分镜给一圈琥珀呼吸，这是「活着」的信号；
   低档位 theme.css 会整体停掉动画，这里不用再写开关 */
.processing {
  border-color: var(--ui-warning);
}
.processing::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  border: 1px solid var(--ui-warning);
  animation: sb-pulse 1.6s ease-in-out infinite;
  pointer-events: none;
}
.highlighted {
  border-color: var(--border-bright);
  box-shadow: var(--shadow-glow);
}
.dimmed {
  opacity: .3;
}
@keyframes sb-pulse {
  0%, 100% { opacity: .55; }
  50% { opacity: 0; }
}
.hint {
  font-size: 10px;
  color: var(--text-faint);
}
</style>
