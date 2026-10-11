<template>
  <div class="canvas-drama-header">
    <div class="title">{{ data.drama?.title || '未命名项目' }}</div>
    <div class="meta">
      <span v-if="data.drama?.style">风格 {{ data.drama.style }}</span>
      <span>{{ (data.drama?.episodes || []).length }} 集</span>
      <span>{{ assetCount }} 素材</span>
      <span>{{ storyboardCount }} 分镜</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  data: { type: Object, required: true },
})

const assetCount = computed(() => {
  const d = props.data.drama || {}
  return (d.characters?.length || 0) + (d.scenes?.length || 0) + (d.props?.length || 0)
})

const storyboardCount = computed(() =>
  (props.data.drama?.episodes || []).reduce((n, ep) => n + (ep.storyboards?.length || 0), 0)
)
</script>

<style scoped>
/* 实色面板 + 一根线，不用渐变玻璃卡 */
.canvas-drama-header {
  min-width: 280px;
  padding: 13px 16px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-muted);
  background: var(--bg-card);
}
.title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -.01em;
  color: var(--text-bright);
  margin-bottom: 6px;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 11.5px;
  color: var(--text-subtle);
}
.meta span {
  font-variant-numeric: tabular-nums;
}
</style>
