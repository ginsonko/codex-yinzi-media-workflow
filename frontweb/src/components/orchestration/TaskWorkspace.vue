<template>
  <section class="task-workspace" aria-label="项目文件目录">
    <FolderOpened aria-hidden="true" />
    <div class="workspace-path"><strong>项目文件</strong><code v-if="workspace?.path">{{ workspace.path }}</code><span v-else>工作目录尚未登记</span><small v-if="workspace?.path && !workspace.exists">目录当前不可访问，路径仍保留</small></div>
    <el-tooltip content="复制目录路径"><el-button v-if="workspace?.path" :icon="CopyDocument" aria-label="复制目录路径" @click="copyPath" /></el-tooltip>
    <el-tooltip content="在运行工作流的电脑上打开目录"><el-button v-if="localHost && workspace?.exists" :icon="FolderOpened" aria-label="打开项目目录" :loading="opening" :disabled="disabled" @click="openDirectory" /></el-tooltip>
    <span v-if="message" class="workspace-message" role="status">{{ message }}</span>
    <input v-if="copyFallback" class="path-fallback" readonly :value="workspace.path" aria-label="可复制目录路径" @focus="$event.target.select()" />
  </section>
</template>
<script setup>
import { ref, watch } from 'vue'
import { CopyDocument, FolderOpened } from '@element-plus/icons-vue'
import orchestrationAPI from '@/api/orchestration'
const props = defineProps({ workspace: Object, sessionId: String, disabled: Boolean })
const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
const message = ref(''), copyFallback = ref(false), opening = ref(false)
watch(() => props.sessionId, () => { message.value = ''; copyFallback.value = false })
async function copyPath() {
  try { await navigator.clipboard.writeText(props.workspace.path); message.value = '路径已复制' }
  catch { copyFallback.value = true; message.value = '可选中下方路径复制' }
}
async function openDirectory() {
  const id = props.sessionId
  opening.value = true
  try { await orchestrationAPI.openDirectory(id); if (id === props.sessionId) message.value = '已请求本机打开目录' }
  catch (error) { if (id === props.sessionId) message.value = `${error.message || '无法打开目录'}，可复制路径查看` }
  finally { opening.value = false }
}
</script>
<style scoped>
.task-workspace { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:12px 0; border-bottom:1px solid var(--border-color); min-width:0; }
.task-workspace>svg { width:20px; height:20px; flex:none; color:var(--ui-accent); }
.workspace-path { display:grid; gap:4px; flex:1; min-width:140px; overflow-wrap:anywhere; }
.workspace-path strong { font-size:13px; }.workspace-path code { font-size:12px; white-space:normal; }
.workspace-path span,.workspace-path small,.workspace-message { font-size:12px; color:var(--text-muted); }
.workspace-message { flex-basis:100%; }.path-fallback { width:100%; min-width:0; }
.task-workspace :deep(.el-button) { margin-left:0; }
</style>
