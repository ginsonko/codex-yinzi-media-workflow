<template>
  <article class="creation-node" :class="{ selected }" :data-node-id="id">
    <Handle type="target" :position="Position.Left" />
    <header><span>{{ names[data.kind] }}</span><strong>{{ data.title }}</strong></header>
    <div class="node-preview">
      <img v-if="data.kind === 'image' && data.mediaUrl" :src="data.mediaUrl" alt="画布图片" draggable="false" />
      <video v-else-if="data.kind === 'video' && data.mediaUrl" :src="data.mediaUrl" controls preload="metadata" class="nodrag nowheel" />
      <audio v-else-if="data.kind === 'audio' && data.mediaUrl" :src="data.mediaUrl" controls class="nodrag nowheel" />
      <p v-else-if="data.text || data.prompt">{{ data.text || data.prompt }}</p>
      <p v-else class="placeholder">{{ data.kind === 'text' ? '双击编辑剧本与说明' : '上传素材或填写提示词生成' }}</p>
    </div>
    <footer><span>{{ data.statusLabel || '可编辑' }}</span><small>{{ data.attemptCount ? `${data.attemptCount} 个版本` : '拖动圆点连接参考' }}</small></footer>
    <Handle type="source" :position="Position.Right" />
  </article>
</template>
<script setup>
import { Handle, Position } from '@vue-flow/core'
defineProps({ id: String, data: Object, selected: Boolean })
const names = { text: '文', image: '图', video: '影', audio: '音' }
</script>
<style scoped>
.creation-node{width:264px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-card);color:var(--text-primary);box-shadow:0 4px 14px #0001;overflow:hidden}.creation-node.selected{outline:2px solid var(--ui-accent);outline-offset:2px}.creation-node header{display:flex;gap:8px;align-items:center;padding:11px;border-bottom:1px solid var(--border-color);font-size:13px}.creation-node header span{background:var(--ui-accent-soft);color:var(--ui-accent);padding:3px 6px;border-radius:4px}.creation-node header strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.node-preview{height:152px;background:var(--bg-inner);display:flex;align-items:center;justify-content:center;overflow:hidden}.node-preview img,.node-preview video{width:100%;height:100%;object-fit:contain}.node-preview audio{width:100%}.node-preview p{padding:12px;white-space:pre-wrap;line-height:1.6;font-size:12px;max-height:150px;overflow:hidden;margin:0;width:100%;overflow-wrap:anywhere}.placeholder{color:var(--text-muted)}footer{padding:9px;display:flex;justify-content:space-between;font-size:11px;gap:8px}footer small{color:var(--text-muted)}
</style>
