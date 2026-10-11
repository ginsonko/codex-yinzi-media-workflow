<template>
  <div class="canvas-node-stack">
    <div class="canvas-media-node" :class="['kind-' + data.kind, { highlighted: data.highlighted, dimmed: data.dimmed, focused: showPanel, processing: isNodeBusy }]">
      <Handle type="target" :position="Position.Left" />
      <Handle v-if="data.kind !== 'video' && data.kind !== 'audio'" type="source" :position="Position.Right" />
      <CanvasNodeStatusOverlay :node-id="id" />
      <div class="tag">{{ kindLabel }}</div>
      <template v-if="data.kind === 'text'">
        <p class="text-body">{{ data.summary || '暂无脚本' }}</p>
      </template>
      <template v-else-if="data.kind === 'universal'">
        <p class="text-body universal-body">{{ data.summary || '暂无全能分镜词' }}</p>
      </template>
      <template v-else-if="data.kind === 'image'">
        <img v-if="data.url" :src="data.url" alt="" class="media-img" />
        <div v-else class="empty">无分镜图</div>
      </template>
      <template v-else-if="data.kind === 'video'">
        <video v-if="data.url" :src="data.url" class="media-vid" muted playsinline />
        <div v-else class="empty">无视频</div>
      </template>
      <template v-else-if="data.kind === 'audio'">
        <div class="audio-wrap">
          <span class="aud-mark">音频</span>
          <span>{{ data.audioType === 'narration' ? '旁白' : '对白' }}</span>
        </div>
      </template>
    </div>
    <CanvasMediaPanel
      v-if="showPanel"
      :node-id="id"
      :kind="data.kind"
      :storyboard="data.storyboard"
      :summary="data.summary"
      :url="data.url"
      :audio-type="data.audioType"
    />
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Handle, Position } from '@vue-flow/core'
import { useCanvasContext } from '@/composables/useCanvasContext'
import CanvasMediaPanel from './CanvasMediaPanel.vue'
import CanvasNodeStatusOverlay from './CanvasNodeStatusOverlay.vue'

const props = defineProps({
  id: { type: String, required: true },
  data: { type: Object, required: true },
})

const ctx = useCanvasContext()
const showPanel = computed(() => ctx?.focusedNodeId?.value === props.id)

const isNodeBusy = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map ? !!map[props.id] : false
})

const kindLabel = computed(() => {
  if (props.data.frameLabel) return props.data.frameLabel
  const map = { text: '脚本摘要', universal: '全能分镜词', image: '分镜图', video: '视频', audio: '音频' }
  return map[props.data.kind] || props.data.kind
})
</script>

<style scoped>
.canvas-node-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.canvas-media-node {
  position: relative;
  width: 168px;
  min-height: 100px;
  padding: 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
  background: var(--bg-card);
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s;
}
.canvas-media-node.focused,
.canvas-media-node.highlighted {
  border-color: var(--border-bright);
  box-shadow: var(--shadow-glow);
}
.tag {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .03em;
  color: var(--text-subtle);
  margin-bottom: 6px;
}
.text-body {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 5;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.media-img,
.media-vid {
  width: 100%;
  height: 92px;
  object-fit: cover;
  border-radius: 4px;
  background: var(--bg-deep);
}
.audio-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 8px;
  font-size: 11.5px;
  color: var(--text-primary);
}
.aud-mark {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-inner);
  color: var(--text-subtle);
}
.empty {
  font-size: 11px;
  color: var(--text-faint);
  padding: 20px 0;
  text-align: center;
}
.universal-body {
  -webkit-line-clamp: 8;
}
/* 生成中是状态，用琥珀；其余类型不再各配一个彩色边 */
.canvas-media-node.processing { border-color: var(--ui-warning); }
.dimmed { opacity: .3; }
</style>
