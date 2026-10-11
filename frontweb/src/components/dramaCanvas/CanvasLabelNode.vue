<template>
  <div class="canvas-label-node">{{ data.label }}</div>
</template>

<script setup>
defineProps({
  data: { type: Object, required: true },
})
</script>

<style scoped>
.canvas-label-node {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .06em;
  color: var(--text-subtle);
  user-select: none;
  pointer-events: none;
}
</style>
