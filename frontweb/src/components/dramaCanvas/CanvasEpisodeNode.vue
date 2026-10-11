<template>
  <div class="canvas-episode-node">
    <Handle type="target" :position="Position.Left" />
    <span class="badge">第 {{ data.episode?.episode_number ?? '?' }} 集</span>
    <span class="title">{{ data.episode?.title || '未命名集' }}</span>
    <span class="count">{{ (data.episode?.storyboards || []).length }} 镜</span>
  </div>
</template>

<script setup>
import { Handle, Position } from '@vue-flow/core'

defineProps({
  data: { type: Object, required: true },
})
</script>

<style scoped>
.canvas-episode-node {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 7px 14px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-bright);
  background: var(--bg-inner);
  color: var(--text-bright);
  font-size: 12.5px;
  white-space: nowrap;
}
.badge {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--text-muted);
}
.title {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--text-faint);
}
</style>
