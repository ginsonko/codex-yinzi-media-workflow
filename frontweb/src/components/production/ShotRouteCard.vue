<template>
  <section class="route-card" :class="{ compact }">
    <div class="route-main">
      <div class="route-icon"><el-icon><component :is="route.requiresDirectorPreview ? VideoCamera : Picture" /></el-icon></div>
      <div class="route-copy">
        <strong>{{ routeHeadline(route, artifact) }}</strong>
        <span>{{ routeDescription(route, artifact) }}</span>
      </div>
      <span class="route-cost">{{ routeCostLabel(route) }}</span>
    </div>
    <div class="route-meta">
      <span class="route-pill">{{ routeState(route, artifact) }}</span>
      <span>{{ mediaContract(route, artifact) }}</span>
      <span>{{ directorStateLabel(route, artifact) }}</span>
      <span>{{ boundaryStateLabel(route, artifact) }}</span>
    </div>
    <div v-if="editable" class="route-actions">
      <el-button type="primary" plain size="small" :icon="Setting" :loading="editing" @click="$emit('edit', artifact)">
        设置模型与 3D 导演台
      </el-button>
      <span>{{ routeEditDeferred
        ? '可切换模型，也可选择跳过导演台和参考视频；设置立即保存，新修订确认后才重建参考包。'
        : '可切换模型，也可选择跳过导演台和参考视频；保存只重建参考包草稿，不会直接产生费用。' }}</span>
    </div>
    <details v-if="!compact || route.model || reasonLabels(route).length" class="route-details">
      <summary>查看路由依据</summary>
      <div class="route-detail-grid">
        <span><small>模型</small><b>{{ route.model || '提交前选择' }}</b></span>
        <span><small>目录</small><b>{{ route.catalog_verified === false ? '待刷新' : '已核对' }}</b></span>
        <span><small>路由</small><b>{{ route.profileLabel }}</b></span>
        <span><small>提交时长</small><b>{{ route.durationAdjusted ? `${route.plannedDuration} 秒调整为 ${route.duration} 秒` : `${route.duration || '待定'} 秒` }}</b></span>
        <span><small>3D 策略</small><b>{{ directorStateLabel(route, artifact) }}</b></span>
        <span><small>镜头边界</small><b>{{ boundaryStateLabel(route, artifact) }}</b></span>
      </div>
      <ul v-if="reasonLabels(route).length">
        <li v-for="reason in reasonLabels(route)" :key="reason">{{ reason }}</li>
      </ul>
    </details>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import { Picture, Setting, VideoCamera } from '@element-plus/icons-vue'
import {
  boundaryStateLabel,
  directorStateLabel,
  mediaContract,
  normalizeRoute,
  reasonLabels,
  routeCostLabel,
  routeDescription,
  routeHeadline,
  routeState,
} from '@/utils/videoRouting'

const props = defineProps({
  artifact: { type: Object, default: () => ({}) },
  route: { type: Object, default: null },
  compact: { type: Boolean, default: false },
  editable: { type: Boolean, default: false },
  editing: { type: Boolean, default: false },
})

defineEmits(['edit'])

const route = computed(() => normalizeRoute(props.route || props.artifact?.content?.routing_receipt || {}, props.artifact))
const routeEditDeferred = computed(() => props.artifact?.stage === 'storyboard_plan' && props.artifact?.status !== 'approved')
</script>

<style scoped>
.route-card { max-width: 100%; min-width: 0; box-sizing: border-box; padding: 14px 15px; border: 1px solid #cfe0dc; background: #f7fbfa; color: #274b47; }
.route-main { display: grid; grid-template-columns: 32px minmax(0, 1fr) minmax(96px, max-content); gap: 10px; align-items: start; }
.route-icon { width: 30px; height: 30px; display: grid; place-items: center; color: #fff; background: #16766b; }
.route-copy { display: grid; gap: 3px; min-width: 0; }
.route-copy strong { font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
.route-copy span { color: #58716d; font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.route-cost { color: #6a5031; font-size: 11px; white-space: nowrap; text-align: right; }
.route-meta { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 10px 0 0 42px; color: #657d79; font-size: 10px; }
.route-meta > span { min-width: 0; overflow-wrap: anywhere; }
.route-pill { max-width: 100%; justify-self: start; padding: 3px 6px; color: #176c62; border: 1px solid #acd1c8; background: #edf8f5; }
.route-actions { margin: 10px 0 0 42px; display: flex; align-items: center; gap: 10px; }
.route-actions > span { color: #70827e; font-size: 10px; line-height: 1.45; }
.route-details { margin: 10px 0 0 42px; color: #5a716d; font-size: 11px; }
.route-details summary { cursor: pointer; color: #28746a; }
.route-detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 9px; }
.route-detail-grid span { display: grid; gap: 2px; min-width: 0; }
.route-detail-grid small { color: #8a9b98; font-size: 10px; }
.route-detail-grid b { overflow-wrap: anywhere; font-weight: 600; }
.route-details ul { margin: 8px 0 0; padding-left: 17px; line-height: 1.6; }
.compact { padding: 10px 12px; }.compact .route-copy span { display: none; }.compact .route-meta { margin-top: 7px; }.compact .route-actions, .compact .route-details { margin-top: 7px; }
@media (max-width: 560px) { .route-main { grid-template-columns: 30px minmax(0, 1fr); }.route-cost { grid-column: 2; max-width: 100%; text-align: left; }.route-meta { display: grid; grid-template-columns: minmax(0, 1fr); }.route-meta, .route-actions, .route-details { width: calc(100% - 40px); box-sizing: border-box; margin-left: 40px; }.route-actions { align-items: stretch; flex-direction: column; }.route-actions :deep(.el-button) { width: 100%; margin-left: 0; }.route-detail-grid { grid-template-columns: 1fr; } }
</style>
