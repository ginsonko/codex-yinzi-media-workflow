<template>
  <article class="creation-node" :class="{ selected }" :data-node-id="id">
    <Handle type="target" :position="Position.Left" title="输入参考：把其他节点连到这里" />
    <header><span :class="`node-kind-${data.kind}`">{{ names[data.kind] }}</span><strong>{{ data.title }}</strong></header>
    <div class="node-preview">
      <img v-if="data.kind === 'image' && data.mediaUrl" :src="data.mediaUrl" alt="画布图片" draggable="false" />
      <video v-else-if="data.kind === 'video' && data.mediaUrl" :src="data.mediaUrl" controls preload="metadata" class="nodrag nowheel" />
      <audio v-else-if="data.kind === 'audio' && data.mediaUrl" :src="data.mediaUrl" controls class="nodrag nowheel" />
      <p v-else-if="data.text || data.prompt">{{ data.text || data.prompt }}</p>
      <p v-else class="placeholder">{{ data.kind === 'text' ? '双击编辑剧本与说明' : '上传素材或填写提示词生成' }}</p>
    </div>
    <footer><span>{{ data.statusLabel || '可编辑' }}</span><small>{{ data.attemptCount ? `${data.attemptCount} 个版本` : '拖动圆点连接参考' }}</small></footer>
    <Handle type="source" :position="Position.Right" title="输出参考：拖到另一个节点" />
  </article>
</template>
<script setup>
import { Handle, Position } from '@vue-flow/core'
defineProps({ id: String, data: Object, selected: Boolean })
const names = { text: '文', image: '图', video: '影', audio: '音' }
</script>
<style scoped>
.creation-node{
  width:290px;
  border:1px solid var(--border-color);
  border-radius:12px;
  background:var(--bg-card);
  color:var(--text-primary);
  box-shadow:var(--shadow-sm);
  overflow:visible;
  transition:border-color .15s,box-shadow .15s;
}
.creation-node:hover{border-color:var(--border-muted);box-shadow:var(--shadow-md)}
.creation-node.selected{
  border-color:var(--ui-accent);
  box-shadow:var(--shadow-md),var(--ui-accent-glow);
  outline:none;
}
.creation-node :deep(.vue-flow__handle){
  width:14px;height:14px;
  background:var(--ui-accent);
  border:2px solid var(--bg-page);
  box-shadow:0 0 0 1px var(--border-bright);
}
.creation-node :deep(.vue-flow__handle)::after{content:'';position:absolute;inset:-6px;border-radius:50%}
.creation-node header{
  display:flex;gap:8px;align-items:center;
  padding:10px 12px;
  border-bottom:1px solid var(--border-color);
  font-size:13px;
  min-height:40px;
}
.creation-node header span{
  flex-shrink:0;
  padding:2px 7px;
  border-radius:5px;
  font-size:11px;
  font-weight:700;
  letter-spacing:.03em;
}
.creation-node header strong{
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-size:13px;font-weight:500;
}
.node-preview{
  height:160px;background:var(--bg-inner);
  display:flex;align-items:center;justify-content:center;overflow:hidden;
}
.node-preview img,.node-preview video{width:100%;height:100%;object-fit:contain}
.node-preview audio{width:100%}
.node-preview p{
  padding:12px;white-space:pre-wrap;line-height:1.65;
  font-size:12px;max-height:158px;overflow:hidden;
  margin:0;width:100%;overflow-wrap:anywhere;color:var(--text-primary);
}
.placeholder{color:var(--text-muted)!important;font-style:italic}
footer{
  border-radius:0 0 12px 12px;
  padding:8px 12px;
  display:flex;justify-content:space-between;
  font-size:11px;gap:8px;
  border-top:1px solid var(--border-color);
  background:var(--bg-inner);
}
footer span{color:var(--text-primary)}
footer small{color:var(--text-muted)}
</style>
