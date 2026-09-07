<template>
  <section :class="['continuity-panel', { 'has-advisory': view.advisory, 'has-mismatch': view.mismatch }]">
    <header class="continuity-heading">
      <div>
        <el-icon><Connection /></el-icon>
        <span><strong>镜头边界与首帧</strong><small>{{ view.modeMeta.label }}</small></span>
      </div>
      <el-tag v-if="view.mode === 'strict_continuation'" :type="compatibilityTone" size="small">{{ compatibilityLabel }}</el-tag>
      <el-tag v-else size="small" effect="plain">{{ view.modeMeta.shortLabel }}</el-tag>
    </header>

    <div v-if="view.mode !== 'opening' && editable" class="continuity-mode-control">
      <el-radio-group v-model="modeValue" size="small" aria-label="选择镜头衔接方式">
        <el-radio-button v-for="item in modes" :key="item.value" :value="item.value">{{ item.label }}</el-radio-button>
      </el-radio-group>
    </div>
    <div v-else-if="view.mode === 'opening'" class="continuity-opening">
      <el-icon><CircleCheck /></el-icon><span>第一镜固定为成片开场，不读取任何历史尾帧。</span>
    </div>
    <p class="continuity-description">{{ view.modeMeta.description }}</p>

    <div v-if="view.requiresPreviousFrame" class="continuity-media-grid">
      <article class="continuity-media-card">
        <div class="continuity-media-title">
          <span><el-icon><VideoCamera /></el-icon><strong>上一镜正式视频</strong></span>
          <small v-if="view.previousShot">镜头 #{{ view.previousShot.scope_id }}</small>
        </div>
        <video v-if="view.previousVideo?.media_path" controls preload="metadata" :src="mediaUrl(view.previousVideo.media_path)" />
        <div v-else class="continuity-media-empty"><VideoCamera /><span>等待上一镜视频确认</span></div>
        <a v-if="view.previousVideo?.media_path" :href="mediaUrl(view.previousVideo.media_path)" download><el-icon><Download /></el-icon>下载来源视频</a>
      </article>

      <article class="continuity-media-card">
        <div class="continuity-media-title">
          <span><el-icon><Picture /></el-icon><strong>派生末帧</strong></span>
          <small>{{ frameReceipt }}</small>
        </div>
        <img v-if="view.continuityFrame?.media_path" :src="mediaUrl(view.continuityFrame.media_path)" alt="上一镜正式视频最后一帧" />
        <div v-else class="continuity-media-empty"><Picture /><span>建包时自动提取最后解码帧</span></div>
        <a v-if="view.continuityFrame?.media_path" :href="mediaUrl(view.continuityFrame.media_path)" download><el-icon><Download /></el-icon>下载末帧 PNG</a>
      </article>
    </div>

    <div class="continuity-transport-grid">
      <article>
        <small>计划方式</small>
        <strong>{{ view.plannedTransport.label }}</strong>
        <span>{{ view.plannedTransport.description }}</span>
      </article>
      <article :class="`is-${view.actualTransport.tone}`">
        <small>后端实际运输</small>
        <strong>{{ view.actualTransport.label }}</strong>
        <span>{{ actualTransportDescription }}</span>
      </article>
    </div>

    <div v-if="dispatchSummary" class="continuity-dispatch-receipt">
      <el-icon><CircleCheck /></el-icon>
      <span><strong>正式请求回执</strong>{{ dispatchSummary }}</span>
    </div>
    <div v-if="boundaryReceipt" class="continuity-boundary-receipt">
      <strong>边界校验</strong><span>{{ boundaryReceipt }}</span>
    </div>
    <div v-if="view.mismatch" class="continuity-blocker" role="alert">
      <el-icon><Warning /></el-icon><span><strong>计划与运输不一致</strong>请重新建立并审批参考包，旧结果不能作为本次镜头产物。</span>
    </div>
    <div v-else-if="view.advisory" class="continuity-advisory" role="status">
      <el-icon><Warning /></el-icon><span><strong>当前选择仍可继续</strong>{{ view.advisory }}</span>
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { CircleCheck, Connection, Download, Picture, VideoCamera, Warning } from '@element-plus/icons-vue'
import { buildShotContinuityView, CONTINUITY_MODES } from '@/utils/shotContinuity'

const props = defineProps({
  artifact: { type: Object, default: () => ({}) },
  draft: { type: Object, default: null },
  artifacts: { type: Array, default: () => [] },
  route: { type: Object, default: () => ({}) },
  editable: { type: Boolean, default: false },
  mediaUrl: { type: Function, required: true },
})

const emit = defineEmits(['update:mode'])
const modes = CONTINUITY_MODES
const view = computed(() => buildShotContinuityView({
  artifact: props.artifact,
  draft: props.draft,
  artifacts: props.artifacts,
  route: props.route,
}))
const modeValue = computed({
  get: () => view.value.mode,
  set: (value) => emit('update:mode', value),
})
const compatibilityLabel = computed(() => {
  if (!view.value.route.model) return '能力待上游确认'
  if (view.value.firstFrameSupport === true) return '模型支持 first_frame'
  if (view.value.firstFrameSupport === false) return '本地提示：可能不支持 first_frame'
  return '能力待上游确认'
})
const compatibilityTone = computed(() => {
  if (view.value.firstFrameSupport === true) return 'success'
  return 'warning'
})
const frameReceipt = computed(() => {
  const validation = view.value.frameValidation || {}
  if (validation.width && validation.height) return `${validation.width} × ${validation.height} 已校验`
  return view.value.continuityFrame?.media_path ? '文件已校验' : '尚未提取'
})
const actualTransportDescription = computed(() => {
  if (view.value.actualTransport.code === 'pending') return view.value.actualTransport.description
  if (view.value.video) return '来自已经持久化的正式视频请求参数，不是前端推测。'
  if (view.value.bundle) return '来自当前参考包回执；正式提交时仍会再次校验模型与文件。'
  return view.value.actualTransport.description
})
const dispatchSummary = computed(() => {
  if (!view.value.video?.content?.dispatch_transport) return ''
  const receipt = view.value.dispatch || {}
  const counts = [
    `${(receipt.reference_images || []).length} 张参考图`,
    `${(receipt.reference_videos || []).length} 个参考视频`,
    `${(receipt.reference_audios || []).length} 个参考音频`,
  ]
  return `${receipt.first_frame ? '已携带严格首帧；' : '未携带严格首帧；'}${counts.join('，')}。`
})
const boundaryReceipt = computed(() => {
  const receipt = view.value.boundaryValidation
  if (!receipt || receipt.evaluated === false) return ''
  if (receipt.mode === 'strict_continuation') {
    if (receipt.passed) return `严格首帧通过，相似度 ${Number(receipt.similarity || 0).toFixed(4)}，阈值 ${Number(receipt.threshold || 0.9).toFixed(4)}。`
    return receipt.error || '严格首帧没有通过校验。'
  }
  if (receipt.mode === 'reference_continuation' && Number.isFinite(Number(receipt.similarity))) {
    return `普通参考模式仅记录相似度 ${Number(receipt.similarity).toFixed(4)}，不把它作为强制通过条件。`
  }
  return receipt.probe_error ? `校验探针未完成：${receipt.probe_error}` : ''
})
</script>

<style scoped>
.continuity-panel { display: grid; gap: 11px; margin: 0 0 14px; padding: 14px; border: 1px solid #d6e1df; background: #fbfdfc; color: #304a47; }
.continuity-panel.has-advisory { border-color: #dec78d; background: #fffdf7; }
.continuity-panel.has-mismatch { border-color: #e0c2b9; background: #fffaf8; }
.continuity-heading, .continuity-heading > div, .continuity-heading > div > span, .continuity-media-title, .continuity-media-title > span { display: flex; align-items: center; gap: 7px; }
.continuity-heading { justify-content: space-between; }
.continuity-heading > div > .el-icon { color: #16766b; font-size: 18px; }
.continuity-heading > div > span { align-items: baseline; }
.continuity-heading strong { font-size: 13px; }
.continuity-heading small { color: #71837f; font-size: 10px; }
.continuity-mode-control :deep(.el-radio-group) { width: 100%; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.continuity-mode-control :deep(.el-radio-button__inner) { width: 100%; min-height: 34px; padding-inline: 8px; }
.continuity-opening { display: flex; align-items: center; gap: 7px; padding: 8px 10px; color: #34715d; background: #f0f8f4; font-size: 11px; }
.continuity-description { margin: 0; color: #647773; font-size: 11px; line-height: 1.6; }
.continuity-media-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.continuity-media-card { min-width: 0; display: grid; align-content: start; gap: 7px; padding: 9px; border: 1px solid #dfe6e5; background: #fff; }
.continuity-media-title { min-width: 0; justify-content: space-between; }
.continuity-media-title > span { min-width: 0; }
.continuity-media-title strong { font-size: 11px; }
.continuity-media-title small { color: #879592; font-size: 9px; white-space: nowrap; }
.continuity-media-card video, .continuity-media-card img { width: 100%; aspect-ratio: 16 / 9; max-height: 230px; object-fit: contain; background: #111; }
.continuity-media-card img { background: #eef2f1; }
.continuity-media-card a { display: inline-flex; align-items: center; gap: 5px; color: #16766b; font-size: 10px; text-decoration: none; }
.continuity-media-empty { min-height: 118px; display: grid; place-items: center; align-content: center; gap: 7px; color: #899693; background: #f1f4f3; font-size: 10px; }
.continuity-media-empty > svg { width: 26px; height: 26px; }
.continuity-transport-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; }
.continuity-transport-grid article { min-width: 0; display: grid; gap: 4px; padding: 10px 11px; border-left: 3px solid #7d918d; background: #f2f5f4; }
.continuity-transport-grid article.is-strict { border-color: #3579a1; background: #f1f7fa; }
.continuity-transport-grid article.is-reference { border-color: #4d8d72; background: #f1f8f4; }
.continuity-transport-grid article.is-pending { border-color: #b48a45; background: #fff9ef; }
.continuity-transport-grid small { color: #7f8d8a; font-size: 9px; }
.continuity-transport-grid strong { font-size: 12px; }
.continuity-transport-grid span { color: #687975; font-size: 10px; line-height: 1.5; }
.continuity-dispatch-receipt, .continuity-boundary-receipt, .continuity-blocker, .continuity-advisory { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: start; gap: 6px; padding: 8px 9px; font-size: 10px; line-height: 1.5; }
.continuity-dispatch-receipt { color: #36705f; background: #eef7f3; }
.continuity-dispatch-receipt span, .continuity-blocker span, .continuity-advisory span { display: grid; gap: 2px; }
.continuity-boundary-receipt { grid-template-columns: auto minmax(0, 1fr); color: #536c67; background: #f3f6f5; }
.continuity-blocker { color: #984f40; background: #fff0ec; }
.continuity-advisory { color: #80601e; background: #fff6da; }
@media (max-width: 560px) {
  .continuity-heading { align-items: flex-start; flex-direction: column; }
  .continuity-mode-control :deep(.el-radio-group), .continuity-media-grid, .continuity-transport-grid { grid-template-columns: 1fr; }
  .continuity-mode-control :deep(.el-radio-button:first-child .el-radio-button__inner), .continuity-mode-control :deep(.el-radio-button:last-child .el-radio-button__inner) { border-radius: 0; }
}
</style>
