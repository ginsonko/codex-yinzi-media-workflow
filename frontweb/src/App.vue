<template>
  <div class="app">
    <AppShell :title="route.meta.title || '工作台'" :description="route.meta.description || 'Codex 银子万能媒体工作流'"
      :runtime-error="connectionError" :runtime-ready="runtimeReady" :refreshing="pageLoading" @refresh="refresh" :quality-profile="qualityProfile" :quality-saving="qualitySaving" @quality-change="setQuality">
      <div class="workspace-frame"><router-view /></div>
    </AppShell>
  </div>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import orchestrationAPI from '@/api/orchestration'
import request from '@/utils/request'
import { ElMessage } from 'element-plus'
import { useRoute } from 'vue-router'
import AppShell from '@/components/AppShell.vue'
import { workbenchPage } from '@/composables/useWorkbenchPage'
import './styles/workspace.css'
const route = useRoute()
const qualityProfile=ref('quality'); const qualitySaving=ref(false)
async function loadQuality() { try { const data=await request.get('/creative-preferences',{suppressGlobalError:true,timeout:5000});qualityProfile.value=data.quality_profile } catch {} }
async function setQuality(value) {
  qualitySaving.value=true
  try { const data=await request.put('/creative-preferences',{quality_profile:value});qualityProfile.value=data.quality_profile;ElMessage.success('已保存，新任务将按此档位规划') }
  finally {qualitySaving.value=false}
}
onMounted(loadQuality)
const runtimeReady = ref(false)
const connectionError = ref('')
let heartbeat
let mounted = true
async function checkConnection() {
  try { const identity = await orchestrationAPI.runtimeIdentity(); runtimeReady.value = Boolean(identity?.orchestration_router); connectionError.value = runtimeReady.value ? '' : '运行时身份不匹配' }
  catch (error) { runtimeReady.value = false; connectionError.value = error?.message || '连接失败' }
  finally { if (mounted) heartbeat = setTimeout(checkConnection, document.hidden ? 30000 : 10000) }
}
onMounted(checkConnection)
onBeforeUnmount(() => { mounted = false; clearTimeout(heartbeat) })
const pageLoading = computed(() => Boolean(workbenchPage.value?.loading?.()))
function refresh() {
  clearTimeout(heartbeat)
  checkConnection()
  if (workbenchPage.value?.refresh) workbenchPage.value.refresh()
  else window.dispatchEvent(new Event('workbench:refresh'))
}
</script>

<style>
* {
  box-sizing: border-box;
}
html, body, #app, .app {
  margin: 0;
  padding: 0;
  min-height: 100vh;
  background: var(--bg-page);
  color: var(--text-primary);
  transition: background 0.25s, color 0.25s;
}

/* 无壳嵌入模式全局容器贴边适配：禁止外层文档出现第二条滚动条，画布与 3D 导演台自适应填满视口 */
html[data-omni-embed="1"],
html[data-omni-embed="1"] body,
html[data-omni-embed="1"] #app,
html[data-omni-embed="1"] .app {
  height: 100vh;
  overflow: hidden;
}
html[data-omni-embed="1"] .workspace-frame {
  width: 100%;
  min-height: 100%;
  margin: 0;
  padding: 0;
}
html[data-omni-embed="1"] .workspace-frame > .creation-workspace {
  height: 100vh;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
html[data-omni-embed="1"] .workspace-frame > .creation-workspace .canvas-layout {
  flex: 1;
  height: auto;
  min-height: 0;
}
html[data-omni-embed="1"] .workspace-frame > .director-studio {
  height: 100vh;
  min-height: 0;
  border-radius: 0;
}
</style>
