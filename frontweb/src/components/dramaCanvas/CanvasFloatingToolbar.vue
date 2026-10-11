<template>
  <div class="canvas-floating-toolbar nodrag nopan">
    <span class="toolbar-label">快速新建</span>
    <el-button size="small" @click="create('storyboard')">分镜</el-button>
    <el-button size="small" @click="create('character')">角色</el-button>
    <el-button size="small" @click="create('scene')">场景</el-button>
    <el-button size="small" @click="create('prop')">道具</el-button>
    <el-button size="small" @click="create('episode')">集</el-button>
  </div>
</template>

<script setup>
import { useCanvasContext } from '@/composables/useCanvasContext'

const ctx = useCanvasContext()

function create(type) {
  ctx?.openCreateDialog?.(type)
}
</script>

<style scoped>
/* 一直悬在画布左下角，所以不加毛玻璃、不加阴影 */
.canvas-floating-toolbar {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 10;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-muted);
  background: var(--bg-card);
  flex-wrap: wrap;
  max-width: calc(100% - 24px);
}
.toolbar-label {
  font-size: 10.5px;
  letter-spacing: .04em;
  color: var(--text-faint);
  margin-right: 2px;
  white-space: nowrap;
}
</style>
