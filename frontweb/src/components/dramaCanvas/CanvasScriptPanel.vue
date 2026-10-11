<template>
  <div
    class="canvas-node-panel script-panel nodrag nopan nowheel"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @mouseup.stop
    @wheel.stop
  >
    <div class="panel-head">
      <span>剧本 · 第 {{ episode?.episode_number ?? '?' }} 集</span>
      <div class="head-right">
        <span v-if="busyLabel" class="busy-tag">{{ busyLabel }}</span>
        <el-button link size="small" @click.stop="closePanel">收起</el-button>
      </div>
    </div>

    <p class="flow-hint">创作起点：编写剧本 → 提取角色/场景/道具 → AI 生成分镜 → 生图/生视频</p>

    <el-form label-position="left" label-width="44px" size="small" class="compact-form">
      <el-form-item label="集标题">
        <el-input v-model="form.title" placeholder="第 N 集" />
      </el-form-item>
      <el-form-item label="剧本">
        <el-input
          v-model="form.scriptContent"
          type="textarea"
          :rows="6"
          resize="vertical"
          placeholder="在此粘贴或编写本集剧本…"
          class="script-textarea"
        />
      </el-form-item>
    </el-form>

    <div class="stats-row">
      <span>素材：{{ charCount }} 角色 · {{ sceneCount }} 场景 · {{ propCount }} 道具</span>
      <span class="len">{{ scriptLen }} 字</span>
    </div>

    <div class="panel-actions">
      <el-button size="small" type="primary" :loading="saving" @click.stop="onSave">保存剧本</el-button>
      <el-button size="small" :loading="extracting" @click.stop="onExtractChars">提取角色</el-button>
      <el-button size="small" :loading="extracting" @click.stop="onExtractScenes">提取场景</el-button>
      <el-button size="small" :loading="extracting" @click.stop="onExtractProps">提取道具</el-button>
      <el-button size="small" type="warning" :loading="extracting" @click.stop="onExtractAll">一键提取</el-button>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'

const props = defineProps({
  episode: { type: Object, required: true },
  nodeId: { type: String, required: true },
})

const ctx = useCanvasContext()
const saving = ref(false)
const extracting = ref(false)
const form = reactive({
  title: '',
  scriptContent: '',
})

const charCount = computed(() => (ctx?.drama?.value?.characters || []).length)
const sceneCount = computed(() => (ctx?.drama?.value?.scenes || []).length)
const propCount = computed(() => (ctx?.drama?.value?.props || []).length)
const scriptLen = computed(() => (form.scriptContent || '').length)

const busyLabel = computed(() => {
  const map = ctx?.nodeStatus?.map
  return map?.[props.nodeId]?.message || ''
})

function syncForm(ep) {
  form.title = ep?.title || `第${ep?.episode_number ?? ''}集`
  form.scriptContent = ep?.script_content || ''
}

watch(() => props.episode, (ep) => syncForm(ep), { immediate: true, deep: true })

function closePanel() {
  ctx?.clearFocusedNode?.()
}

function getScriptApi() {
  return ctx?.scriptActions
}

async function onSave() {
  if (!form.scriptContent.trim()) {
    ElMessage.warning('请先填写剧本内容')
    return
  }
  saving.value = true
  try {
    await getScriptApi()?.saveScript?.(props.episode.id, {
      scriptContent: form.scriptContent,
      title: form.title,
    })
  } catch (e) {
    ElMessage.error(e?.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function runExtract(fn) {
  extracting.value = true
  try {
    await fn()
  } catch (e) {
    if (e?.message) ElMessage.error(e.message)
  } finally {
    extracting.value = false
  }
}

async function onExtractChars() {
  await runExtract(() =>
    getScriptApi()?.extractCharacters?.(props.episode.id, form.scriptContent)
  )
}

async function onExtractScenes() {
  await runExtract(() => getScriptApi()?.extractScenes?.(props.episode.id))
}

async function onExtractProps() {
  await runExtract(() => getScriptApi()?.extractProps?.(props.episode.id))
}

async function onExtractAll() {
  if (!form.scriptContent.trim()) {
    ElMessage.warning('请先填写剧本')
    return
  }
  await runExtract(() =>
    getScriptApi()?.extractAll?.(props.episode.id, form.scriptContent)
  )
}
</script>

<style scoped>
.script-panel {
  margin-top: 10px;
  width: min(520px, 92vw);
  padding: 10px 13px 12px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border-muted);
  background: var(--bg-card);
  box-shadow: var(--shadow-sm);
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 9px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--border-color);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--text-muted);
}
.head-right,
.head-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.busy-tag {
  font-size: 10px;
  color: var(--ui-warning);
}
.flow-hint {
  margin: 0 0 10px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-subtle);
}
.compact-form :deep(.el-form-item) {
  margin-bottom: 8px;
}
.compact-form :deep(.el-form-item__label) {
  color: var(--text-subtle);
  font-size: 11px;
}
.compact-form :deep(.el-textarea__inner) {
  resize: vertical;
  min-height: 120px;
  line-height: 1.55;
}
.stats-row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 10.5px;
  color: var(--text-subtle);
  margin-bottom: 8px;
  font-variant-numeric: tabular-nums;
}
.len {
  font-family: var(--font-mono);
  color: var(--text-faint);
}
.panel-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border-color);
}
.panel-actions :deep(.el-button) {
  margin: 0;
}
</style>
