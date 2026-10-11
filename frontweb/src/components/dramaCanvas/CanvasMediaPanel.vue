<template>
  <div
    class="canvas-node-panel media-panel nodrag nopan nowheel"
    :class="'kind-' + kind"
    @pointerdown.stop
    @mousedown.stop
    @click.stop
    @mouseup.stop
    @wheel.stop
  >
    <div class="panel-head">
      <span>{{ kindTitle }}</span>
      <div class="head-right">
        <span v-if="busyLabel" class="busy-tag">{{ busyLabel }}</span>
        <el-button link size="small" @click.stop="closePanel">收起</el-button>
      </div>
    </div>

    <div class="panel-body">
      <template v-if="kind === 'text'">
        <p class="summary">{{ summary || '暂无脚本内容' }}</p>
        <el-button size="small" type="primary" plain @click.stop="focusStoryboard">编辑脚本</el-button>
      </template>

      <template v-else-if="kind === 'universal'">
        <p class="summary">{{ summary || '暂无全能分镜词' }}</p>
        <div class="panel-actions">
          <el-button size="small" plain @click.stop="focusStoryboard">编辑</el-button>
          <el-button size="small" type="primary" :loading="busy" @click.stop="runStep('video')">重新生视频</el-button>
        </div>
      </template>

      <template v-else-if="kind === 'image'">
        <div class="preview-wrap">
          <img v-if="url && !busy" :src="url" alt="" class="preview-img" />
          <div v-else-if="!busy" class="preview-empty">无分镜图</div>
          <div v-if="busy" class="preview-loading"><span class="spinner" />生图中…</div>
        </div>
        <el-button size="small" type="primary" :loading="busy" @click.stop="runStep('image')">重新生图</el-button>
      </template>

      <template v-else-if="kind === 'video'">
        <div class="preview-wrap">
          <video v-if="url && !busy" :src="url" class="preview-vid" controls playsinline />
          <div v-else-if="!busy" class="preview-empty">无视频</div>
          <div v-if="busy" class="preview-loading"><span class="spinner" />生视频中…</div>
        </div>
        <el-button size="small" type="primary" :loading="busy" @click.stop="runStep('video')">重新生视频</el-button>
      </template>

      <template v-else-if="kind === 'audio'">
        <div class="audio-label">{{ audioType === 'narration' ? '旁白音频' : '对白音频' }}</div>
        <audio v-if="url" :src="url" controls class="preview-aud" />
        <el-button size="small" type="warning" :loading="busy" @click.stop="runStep('audio')">重新配音</el-button>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useCanvasContext } from '@/composables/useCanvasContext'
import { CANVAS_NODE_STATUS_LABELS } from '@/composables/useCanvasNodeStatus'
import { runImageStep, runVideoStep, runAudioStep } from '@/composables/useCanvasWorkflowRunner'
import { findStoryboardInDrama, getDramaGenerationOptions } from '@/utils/canvasWorkflow'

const props = defineProps({
  nodeId: { type: String, default: '' },
  kind: { type: String, required: true },
  storyboard: { type: Object, default: null },
  summary: { type: String, default: '' },
  url: { type: String, default: '' },
  audioType: { type: String, default: 'dialogue' },
})

const ctx = useCanvasContext()
const busy = ref(false)

const sbNodeId = computed(() => (props.storyboard?.id ? `sb:${props.storyboard.id}` : ''))

const kindTitle = computed(() => {
  const map = { text: '脚本摘要', universal: '全能分镜词', image: '分镜图', video: '视频', audio: '音频' }
  return map[props.kind] || '媒体'
})

const busyLabel = computed(() => {
  const map = ctx?.nodeStatus?.map
  const id = props.nodeId || sbNodeId.value
  return id && map ? map[id]?.message : ''
})

function focusStoryboard() {
  if (sbNodeId.value) ctx?.setFocusedNode?.(sbNodeId.value)
}

function closePanel() {
  ctx?.clearFocusedNode?.()
}

async function runStep(step) {
  const drama = ctx?.drama?.value
  const sbId = props.storyboard?.id
  if (!drama || !sbId) return
  busy.value = true
  const statusMsg = CANVAS_NODE_STATUS_LABELS[step] || '处理中…'
  ctx?.nodeStatus?.set(props.nodeId, { step, message: statusMsg })
  ctx?.nodeStatus?.set(sbNodeId.value, { step, message: statusMsg })
  try {
    const found = findStoryboardInDrama(drama, sbId)
    const sb = found?.storyboard || props.storyboard
    const genOpts = ctx?.getGenerationOptions?.() || getDramaGenerationOptions(drama)
    if (step === 'image') await runImageStep(drama, sb, genOpts)
    else if (step === 'video') await runVideoStep(drama, sb, genOpts)
    else if (step === 'audio') {
      const res = await runAudioStep(sb)
      if (res?.skipped) {
        ElMessage.info(res.reason || '已跳过')
        return
      }
    }
    ElMessage.success('生成完成')
    await ctx?.refresh?.()
  } catch (e) {
    ElMessage.error(e?.message || '生成失败')
  } finally {
    busy.value = false
    ctx?.nodeStatus?.clear(props.nodeId)
    ctx?.nodeStatus?.clear(sbNodeId.value)
  }
}
</script>

<style scoped>
.media-panel {
  margin-top: 10px;
  width: min(360px, 92vw);
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
.panel-body {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
}
.summary {
  flex: 1;
  min-width: 180px;
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-primary);
  max-height: 72px;
  overflow-y: auto;
}
.preview-wrap {
  position: relative;
  width: 120px;
  height: 72px;
  flex-shrink: 0;
  border-radius: 4px;
  overflow: hidden;
  background: var(--bg-deep);
}
.preview-img,
.preview-vid {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.preview-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: var(--text-faint);
}
.preview-loading {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--bg-deep);
  opacity: .94;
  font-size: 10px;
  color: var(--text-primary);
}
.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-muted);
  border-top-color: var(--ui-warning);
  border-radius: 50%;
  animation: spin .75s linear infinite;
}
.preview-aud {
  flex: 1;
  min-width: 160px;
}
.audio-label {
  font-size: 11px;
  color: var(--text-subtle);
  width: 100%;
}
.panel-actions {
  display: flex;
  gap: 8px;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>
