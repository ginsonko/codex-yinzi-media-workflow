<template>
  <section class="provider-status" :class="`is-${tone}`" aria-live="polite">
    <div class="provider-heading">
      <div class="provider-title"><el-icon><component :is="statusIcon" /></el-icon><strong>{{ label }}</strong></div>
      <span class="provider-kind">{{ action?.kind === 'video_generate' ? '视频生成' : '当前任务' }}</span>
    </div>
    <div v-if="isFixture" class="provider-fixture-note" role="status">
      本地验收模拟：不会上传媒体、创建视频任务或产生费用。
    </div>
    <div v-if="action?.kind === 'video_generate'" class="dispatch-receipt">
      <span><small>当前配置</small><strong>{{ configuredModel || '自动路由' }}</strong></span>
      <span><small>参考包</small><strong>{{ resolvedBundleModel || '待核对' }}</strong></span>
      <span><small>实际派发</small><strong>{{ dispatchedModel || '尚未派发' }}</strong></span>
      <span><small>本镜尝试</small><strong>#{{ action.attempt || '—' }}</strong></span>
    </div>
    <div v-if="modelMismatch" class="provider-model-warning" role="alert">
      <el-icon><Warning /></el-icon>
      <span>当前配置与这条任务的实际派发模型不同。这条任务保留原模型回执；新模型只会用于重新核对参考包后的下一次提交。</span>
    </div>
    <div class="provider-body">
      <el-progress
        v-if="showProgress"
        :percentage="progress"
        :indeterminate="progress == null"
        :duration="2.8"
        :show-text="progress != null"
        :status="tone === 'danger' ? 'exception' : undefined"
      />
      <span class="provider-elapsed">{{ elapsed }}</span>
      <span class="provider-note">只显示服务商返回的状态；没有预计完成时间时不会伪造 ETA。</span>
    </div>
    <details v-if="action?.task_id || action?.generation_id || action?.request?.bundle_artifact_id" class="provider-identifiers">
      <summary>查看技术回执</summary>
      <code v-if="action.request?.bundle_artifact_id">bundle {{ action.request.bundle_artifact_id }}</code>
      <code v-if="dispatchedModel">model {{ dispatchedModel }}</code>
      <code v-if="action.task_id">task {{ action.task_id }}</code>
      <code v-if="action.generation_id">generation {{ action.generation_id }}</code>
    </details>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { CircleCheck, Clock, Loading, Warning } from '@element-plus/icons-vue'
import { formatActionElapsed, isFixtureAction, providerStatusLabel } from '@/utils/videoRouting'

const props = defineProps({
  action: { type: Object, default: null },
  run: { type: Object, default: () => ({}) },
  configuredModel: { type: String, default: '' },
  bundleModel: { type: String, default: '' },
})

const label = computed(() => providerStatusLabel(props.action, props.run))
const isFixture = computed(() => isFixtureAction(props.action))
const dispatchReceipt = computed(() => props.action?.result?.dispatch_receipt || {})
const configuredModel = computed(() => String(props.configuredModel || dispatchReceipt.value.configured_model || '').trim())
const resolvedBundleModel = computed(() => String(props.bundleModel || dispatchReceipt.value.bundle_model || '').trim())
const dispatchedModel = computed(() => String(
  dispatchReceipt.value.persisted_generation_model
    || dispatchReceipt.value.dispatched_model
    || props.action?.request?.model
    || props.action?.request?.routing_receipt?.model
    || ''
).trim())
const modelMismatch = computed(() => Boolean(
  (configuredModel.value && dispatchedModel.value && configuredModel.value !== dispatchedModel.value)
    || (resolvedBundleModel.value && dispatchedModel.value && resolvedBundleModel.value !== dispatchedModel.value)
))
const progress = computed(() => {
  const value = Number(props.action?.result?.provider_progress ?? props.action?.provider_progress)
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null
})
const showProgress = computed(() => ['reserved', 'submitted', 'waiting'].includes(props.action?.status))
const tone = computed(() => {
  if (!props.action) return 'neutral'
  if (props.action?.status === 'failed' || props.action?.status === 'ambiguous') return 'danger'
  if (props.action?.status === 'completed') return 'success'
  return 'progress'
})
const elapsed = computed(() => formatActionElapsed(props.action, Date.now()))
const statusIcon = computed(() => tone.value === 'danger' ? Warning : tone.value === 'success' ? CircleCheck : tone.value === 'neutral' ? Clock : Loading)
</script>

<style scoped>
.provider-status { max-width: 100%; min-width: 0; box-sizing: border-box; padding: 14px 15px; border: 1px solid #dce5e7; background: #fff; }.provider-status.is-progress { border-color: #c8ded9; background: #f7fbfa; }.provider-status.is-success { border-color: #c6decf; background: #f7fbf8; }.provider-status.is-danger { border-color: #e2c4bd; background: #fff8f6; }
.provider-fixture-note { margin-top: 10px; padding: 8px 10px; border: 1px solid #d9c89b; background: #fffaf0; color: #7a622c; font-size: 11px; line-height: 1.5; }
.dispatch-receipt { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 11px; padding-top: 10px; border-top: 1px solid #dfe7e8; }.dispatch-receipt span { min-width: 0; display: grid; gap: 3px; }.dispatch-receipt small { color: #849297; font-size: 9px; }.dispatch-receipt strong { overflow-wrap: anywhere; color: #355a55; font-size: 10px; font-weight: 650; }.provider-model-warning { display: flex; align-items: flex-start; gap: 7px; margin-top: 10px; color: #8d5145; font-size: 10px; line-height: 1.5; }.provider-model-warning .el-icon { flex: 0 0 auto; margin-top: 2px; }
.provider-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }.provider-title { display: flex; align-items: center; gap: 7px; color: #2b4f4a; font-size: 13px; }.is-danger .provider-title { color: #9c5042; }.is-success .provider-title { color: #347556; }.provider-kind { color: #849298; font-size: 10px; }
.provider-body { display: grid; grid-template-columns: minmax(120px, 1fr) auto; align-items: center; gap: 10px; margin-top: 11px; }.provider-body :deep(.el-progress) { min-width: 0; }.provider-elapsed { color: #65777c; font-size: 11px; white-space: nowrap; }.provider-note { grid-column: 1 / -1; color: #819096; font-size: 11px; line-height: 1.5; }.provider-identifiers { margin-top: 9px; color: #7b898e; font-size: 10px; }.provider-identifiers summary { cursor: pointer; }.provider-identifiers code { display: block; margin-top: 5px; overflow-wrap: anywhere; }
@media (max-width: 560px) { .dispatch-receipt { grid-template-columns: 1fr 1fr; }.provider-body { grid-template-columns: minmax(0, 1fr); }.provider-note { grid-column: 1; }.provider-elapsed { justify-self: start; } }
</style>
