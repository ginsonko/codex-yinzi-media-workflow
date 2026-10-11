<template>
  <div class="canvas-node-stack">
    <div
      class="canvas-asset-node"
      :class="[
        'kind-' + data.kind,
        {
          highlighted: data.highlighted,
          dimmed: data.dimmed,
          focused: showPanel,
          processing: isNodeBusy || entityStatus === 'processing',
        },
      ]"
    >
      <Handle type="source" :position="Position.Right" />
      <div class="cover">
        <img v-if="thumbUrl && !isNodeBusy" :src="thumbUrl" alt="" />
        <div v-else-if="!isNodeBusy" class="cover-placeholder">{{ kindIcon }}</div>
        <CanvasNodeStatusOverlay :node-id="id" />
      </div>
      <div class="info">
        <div class="name-row">
          <span class="name">{{ displayName }}</span>
          <span v-if="statusChip" class="status-chip" :class="'st-' + statusChip.key">{{ statusChip.label }}</span>
        </div>
        <div class="kind">{{ kindLabel }}</div>
      </div>
    </div>
    <CanvasAssetPanel
      v-if="showPanel"
      :kind="data.kind"
      :entity="data.entity"
      :node-id="id"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { assetImageUrl } from '@/utils/mediaUrl'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasAssetPanel from './CanvasAssetPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)

const kindLabel = computed(() => {
  const map = { character: '角色', scene: '场景', prop: '道具' }
  return map[props.data.kind] || '素材'
})

// 占位用中文小字，不用 emoji
const kindIcon = computed(() => {
  const map = { character: '角色', scene: '场景', prop: '道具' }
  return map[props.data.kind] || '素材'
})

const displayName = computed(() => {
  const e = props.data.entity || {}
  return e.name || e.location || '未命名'
})

const thumbUrl = computed(() => assetImageUrl(props.data.entity))
const entityStatus = computed(() => props.data.entity?.status || '')

const isNodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map ? !!map[props.id] : false
})

const statusChip = computed(() => {
  const map = ctx?.nodeStatus?.map
  const busy = map?.[props.id]
  if (busy) return { key: 'busy', label: busy.message?.slice(0, 8) || '处理中' }
  const s = entityStatus.value
  if (s === 'processing') return { key: 'processing', label: '生成中' }
  if (s === 'failed') return { key: 'failed', label: '失败' }
  if (thumbUrl.value) return { key: 'ready', label: '有图' }
  return null
})
</script>

<style scoped>
.canvas-node-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.canvas-asset-node {
  position: relative;
  width: 176px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border-muted);
  background: var(--bg-card);
  box-shadow: var(--shadow-xs);
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}
.canvas-asset-node.focused,
.canvas-asset-node.highlighted {
  border-color: var(--border-bright);
  box-shadow: var(--shadow-glow);
}
.canvas-asset-node.processing {
  border-color: var(--ui-warning);
  animation: asset-pulse 1.6s ease-in-out infinite;
}
.cover {
  position: relative;
  height: 108px;
  background: var(--bg-deep);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-placeholder {
  font-size: 12px;
  letter-spacing: .06em;
  color: var(--text-faint);
}
.info {
  padding: 7px 10px 9px;
  border-top: 1px solid var(--border-color);
}
.name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.name {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-bright);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.status-chip {
  flex-shrink: 0;
  font-size: 9.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-inner);
  color: var(--text-subtle);
}
.status-chip.st-busy,
.status-chip.st-processing { color: var(--ui-warning); background: var(--ui-warning-soft); }
.status-chip.st-ready { color: var(--ui-success); background: var(--ui-success-soft); }
.status-chip.st-failed { color: var(--ui-danger); background: var(--ui-danger-soft); }
.kind {
  font-size: 10.5px;
  color: var(--text-subtle);
  margin-top: 2px;
}
/* 三类素材不再各给一个彩色边，靠名字和类型文字区分 */
.dimmed {
  opacity: .3;
}
@keyframes asset-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--ui-warning-soft); }
  50% { box-shadow: 0 0 0 5px transparent; }
}
</style>
