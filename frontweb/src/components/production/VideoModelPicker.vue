<template>
  <el-dialog
    :model-value="modelValue"
    class="video-model-dialog"
    width="min(880px, 96vw)"
    destroy-on-close
    :close-on-click-modal="!saving"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template #header>
      <div class="dialog-heading">
        <span><el-icon><VideoCamera /></el-icon></span>
        <div>
          <strong>镜头 #{{ routing?.shot?.id || '—' }} · 模型与 3D 导演台设置</strong>
          <small>{{ dialogSubtitle }}</small>
        </div>
      </div>
    </template>

    <div v-if="loading && !routing" class="picker-loading" v-loading="true">正在读取实时模型目录</div>
    <div v-else-if="error && !routing" class="picker-error">
      <el-alert type="error" :closable="false" show-icon :title="error" />
      <el-button :icon="Refresh" :loading="loading" @click="$emit('refresh')">重新读取模型目录</el-button>
    </div>
    <div v-else-if="routing" class="picker-body">
      <section class="current-route">
        <div>
          <small>当前有效模型</small>
          <strong>{{ configuredModelLabel }}</strong>
        </div>
        <div>
          <small>项目默认</small>
          <strong>{{ projectRuleLabel }}</strong>
        </div>
        <div>
          <small>目录时间</small>
          <strong>{{ formatCatalogTime(routing.catalog?.fetched_at) }}</strong>
        </div>
        <div class="route-tools">
          <el-button plain :icon="Refresh" :loading="loading" @click="$emit('refresh')">同步当前 Key</el-button>
          <el-button plain @click="$emit('manage-capabilities', model || selectedOption?.model || '')">管理能力提示</el-button>
        </div>
      </section>

      <el-alert
        v-if="catalogStatusMessage"
        :type="routing.catalog?.stale_snapshot ? 'warning' : 'info'"
        :closable="false"
        show-icon
        :title="catalogStatusMessage"
      />

      <el-alert
        v-if="routing.route_edit_deferred"
        type="info"
        :closable="false"
        show-icon
        title="当前分镜尚未确认：本次设置会立即保存，但只会在新分镜确认后重建参考包，不会生成素材或提交视频。"
      />

      <el-alert
        v-if="routing.effective_route_error"
        type="warning"
        :closable="false"
        show-icon
        :title="`当前路由不可用：${routing.effective_route_error.message}`"
      />

      <section class="routing-choice">
        <label>本镜头使用方式</label>
        <el-radio-group v-model="mode">
          <el-radio-button value="inherit">跟随项目规则</el-radio-button>
          <el-radio-button value="fixed">本镜头手动指定</el-radio-button>
        </el-radio-group>
        <p v-if="mode === 'inherit'">删除本镜头覆盖，之后跟随“{{ projectRuleLabel }}”。</p>
        <p v-else>只覆盖当前镜头，不影响已经完成或尚未生成的其他镜头。</p>
      </section>

      <section class="routing-choice previs-choice">
        <label>本镜头 3D 导演台与参考视频</label>
        <el-radio-group v-model="previsMode" :disabled="directorDisabled">
          <el-radio-button value="auto">自动判断</el-radio-button>
          <el-radio-button value="skip">跳过，不生成或携带</el-radio-button>
          <el-radio-button value="force">生成并审核</el-radio-button>
        </el-radio-group>
        <p v-if="directorDisabled">项目已关闭 3D 导演台，本镜头不会生成导演台 JSON、预演视频或参考视频。</p>
        <p v-else-if="previsMode === 'skip'">跳过后直接生成图片引导参考包；参考视频上限为 0，旧导演台文件只保留在历史记录。</p>
        <p v-else-if="previsMode === 'force'">会进入本地导演台审核；只有当前视频模型支持参考视频时，审核通过的预演才会随请求携带。</p>
        <p v-else>长镜头按连续动作自动判断是否需要导演台；不需要时可在这里直接跳过。</p>
      </section>

      <template v-if="mode === 'fixed'">
        <div class="model-toolbar">
          <el-input v-model="search" clearable placeholder="搜索模型、清晰度或能力" />
          <span>{{ visibleOptions.length }} / {{ options.length }} 个模型</span>
        </div>
        <div class="model-option-list" role="listbox" aria-label="视频模型">
          <div class="manual-model-entry">
            <el-input v-model="manualModel" clearable placeholder="也可以直接输入上游模型名，不要求目录已登记" @keyup.enter="useManualModel" />
            <el-button type="primary" plain :disabled="!manualModel.trim()" @click="useManualModel">使用此模型</el-button>
          </div>
          <button
            v-for="option in visibleOptions"
            :key="option.model"
            type="button"
            :class="['model-option', { selected: model === option.model, expensive: option.requires_explicit_confirmation }]"
            :aria-selected="model === option.model"
            @click="selectModel(option)"
          >
            <span class="model-option-main">
              <strong>{{ option.name || option.model }}</strong>
              <small>{{ option.model }}</small>
            </span>
            <span class="model-option-tags">
              <em>{{ modelQualityLabel(option) }}</em>
              <em>{{ option.resolution || '分辨率待定' }}</em>
              <em>{{ modelDurationLabel(option) }}</em>
            </span>
            <span class="model-option-meta">
              <small>{{ modelMediaLabel(option) }}</small>
              <small>{{ modelPriceLabel(option) }}</small>
            </span>
            <span :class="['model-option-status', { advisory: option.contract_status === 'missing' || option.group_available === false }]">
              <el-icon><component :is="option.contract_status !== 'missing' && option.group_available !== false ? CircleCheck : Warning" /></el-icon>
              {{ modelCompatibilityLabel(option) }}
            </span>
          </button>
          <el-empty v-if="!visibleOptions.length" description="没有匹配的模型" :image-size="64" />
        </div>
      </template>

      <section v-if="mode === 'fixed' && selectedOption" class="selection-receipt">
        <div>
          <strong>{{ selectedOption.model }}</strong>
          <span>{{ modelMediaLabel(selectedOption) }} · {{ modelDurationLabel(selectedOption) }} · {{ modelPriceLabel(selectedOption) }}</span>
        </div>
        <el-tag v-for="warning in modelWarnings(selectedOption)" :key="warning" :type="selectedOption.requires_explicit_confirmation ? 'danger' : 'warning'" effect="plain">{{ warning }}</el-tag>
        <el-checkbox v-if="selectedOption.requires_explicit_confirmation" v-model="confirmExpensive">
          我已确认这是高价模型，并接受目录显示的预计价格
        </el-checkbox>
      </section>

      <section v-if="routing.failed_action" class="retry-receipt">
        <div class="retry-heading">
          <el-icon><Warning /></el-icon>
          <span><strong>当前镜头有一次明确失败，将自动替换</strong><small>{{ routing.failed_action.model || '原模型' }} · {{ routing.failed_action.error_code || '上游失败' }}</small></span>
        </div>
        <span class="retry-note">保存不同模型后，系统会自动废止这条可安全替换的失败任务并重建参考包，不再要求额外授权或填写重试理由。旧错误仍保留在活动记录中。</span>
      </section>

      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="模型目录和本地能力提示只用于解释与自动选模；手动指定的模型和参考媒体清单会按你的选择提交，最终以上游响应为准。"
      />
    </div>

    <template #footer>
      <div class="dialog-footer">
        <span>{{ saveHint }}</span>
        <div>
          <el-button :disabled="saving" @click="$emit('update:modelValue', false)">取消</el-button>
          <el-button type="primary" :loading="saving" :disabled="!canSubmit" @click="submit">{{ saveLabel }}</el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { CircleCheck, Refresh, VideoCamera, Warning } from '@element-plus/icons-vue'
import {
  buildShotVideoRoutingPayload,
  catalogModelOption,
  modelCompatibilityLabel,
  modelDurationLabel,
  modelMediaLabel,
  modelPriceLabel,
  modelQualityLabel,
  modelWarnings,
  shotVideoPrevisMode,
} from '@/utils/videoModelRouting'

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  routing: { type: Object, default: null },
  error: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue', 'refresh', 'save', 'manage-capabilities'])
const mode = ref('inherit')
const model = ref('')
const manualModel = ref('')
const previsMode = ref('auto')
const search = ref('')
const confirmExpensive = ref(false)

const options = computed(() => Array.isArray(props.routing?.catalog?.options) ? props.routing.catalog.options : [])
const selectedOption = computed(() => options.value.find((option) => option.model === model.value)
  || catalogModelOption(options.value, model.value, props.routing?.project?.group || ''))
const visibleOptions = computed(() => {
  const query = search.value.trim().toLowerCase()
  const items = query
    ? options.value.filter((option) => JSON.stringify([
      option.model, option.name, option.resolution, option.quality_tier,
      modelDurationLabel(option), modelMediaLabel(option), modelCompatibilityLabel(option),
    ]).toLowerCase().includes(query))
    : options.value
  return [...items].sort((left, right) => {
    if (left.model === model.value) return -1
    if (right.model === model.value) return 1
    if (left.selectable !== right.selectable) return left.selectable ? -1 : 1
    return Number(left.estimated_price ?? Number.MAX_SAFE_INTEGER) - Number(right.estimated_price ?? Number.MAX_SAFE_INTEGER)
  })
})
const projectRuleLabel = computed(() => props.routing?.project?.mode === 'fixed'
  ? `固定 ${props.routing.project.model || '未选择模型'}`
  : '按镜头自动选择')
const configuredModelLabel = computed(() => props.routing?.effective_route?.model
  || props.routing?.shot?.model
  || (props.routing?.project?.mode === 'fixed' ? props.routing.project.model : '')
  || '提交前自动选择')
const directorDisabled = computed(() => props.routing?.project?.director_mode === 'off')
const catalogStatusMessage = computed(() => {
  const catalog = props.routing?.catalog || {}
  const warnings = Array.isArray(catalog.warnings) ? catalog.warnings.filter(Boolean) : []
  if (catalog.stale_snapshot) {
    return warnings[0] || '实时模型目录暂不可用，当前使用此视频配置上次成功保存的目录；可继续选模，也可稍后重新同步。'
  }
  return warnings[0] || ''
})
const routeEditDeferred = computed(() => props.routing?.route_edit_deferred === true)
const dialogSubtitle = computed(() => routeEditDeferred.value
  ? '可单独跳过导演台；设置立即保存并在新分镜确认后生效，不会产生费用'
  : '可单独跳过导演台并重建无参考视频的参考包；保存不会立即提交或产生费用')
const saveHint = computed(() => routeEditDeferred.value
  ? '保存只更新本镜头规则；新分镜确认后才会重建参考包，不会调用视频 API。'
  : '保存后最多生成一个新的参考包草稿；不会自动通过，也不会自动调用视频 API。')
const saveLabel = computed(() => routeEditDeferred.value ? '保存设置' : '保存并重建参考包')
const requiresExpensiveConfirmation = computed(() => mode.value === 'fixed'
  && selectedOption.value?.requires_explicit_confirmation === true)
const canSubmit = computed(() => {
  if (!props.routing?.shot?.id || props.saving) return false
  if (mode.value === 'fixed' && !model.value.trim()) return false
  if (requiresExpensiveConfirmation.value && !confirmExpensive.value) return false
  return true
})

watch(() => [props.modelValue, props.routing], () => {
  if (!props.modelValue || !props.routing) return
  mode.value = props.routing.shot?.mode === 'fixed' ? 'fixed' : 'inherit'
  model.value = props.routing.shot?.model || props.routing.effective_route?.model || ''
  manualModel.value = model.value
  previsMode.value = shotVideoPrevisMode(props.routing)
  search.value = ''
  confirmExpensive.value = false
}, { immediate: true, deep: true })

function selectModel(option) {
  model.value = option.model
  manualModel.value = option.model
  confirmExpensive.value = false
}

function useManualModel() {
  const value = manualModel.value.trim()
  if (!value) return
  model.value = value
  confirmExpensive.value = false
}

function submit() {
  if (!canSubmit.value) return
  emit('save', buildShotVideoRoutingPayload(props.routing, {
    mode: mode.value,
    model: model.value,
    previs_mode: previsMode.value,
    confirm_expensive: requiresExpensiveConfirmation.value && confirmExpensive.value,
  }))
}

function formatCatalogTime(value) {
  if (!value) return '尚未刷新'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}
</script>

<style scoped>
.model-option-status.advisory { color: #8a6b31; }
.manual-model-entry { display: flex; align-items: center; gap: 8px; }.manual-model-entry :deep(.el-input) { flex: 1; }.model-option-list > .manual-model-entry { grid-column: 1 / -1; }
.dialog-heading { display: flex; align-items: flex-start; gap: 10px; }.dialog-heading > span { width: 34px; height: 34px; flex: 0 0 auto; display: grid; place-items: center; color: #fff; background: #16766b; }.dialog-heading > div { display: grid; gap: 3px; }.dialog-heading strong { color: #263f43; font-size: 15px; }.dialog-heading small { color: #718286; font-size: 11px; }.picker-loading { min-height: 280px; display: grid; place-items: center; color: #708085; }.picker-error { min-height: 220px; display: grid; align-content: center; justify-items: center; gap: 14px; }.picker-error :deep(.el-alert) { width: min(620px, 100%); }.picker-body { display: grid; gap: 16px; }.current-route { display: grid; grid-template-columns: 1.2fr 1fr 1fr auto; align-items: center; gap: 12px; padding: 12px; border: 1px solid #d9e4e2; background: #f7fbfa; }.current-route > div { min-width: 0; display: grid; gap: 3px; }.current-route small { color: #7d8c8f; font-size: 10px; }.current-route strong { overflow-wrap: anywhere; color: #315b56; font-size: 11px; }.route-tools { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }.routing-choice { display: grid; gap: 8px; }.routing-choice > label { color: #34494d; font-size: 12px; font-weight: 700; }.routing-choice p { margin: 0; color: #708185; font-size: 11px; }.model-toolbar { display: flex; align-items: center; gap: 12px; }.model-toolbar > :deep(.el-input) { flex: 1; }.model-toolbar > span { color: #7a898d; font-size: 11px; white-space: nowrap; }.model-option-list { max-height: min(46vh, 430px); overflow: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 2px; }.model-option { min-width: 0; padding: 11px 12px; display: grid; gap: 8px; border: 1px solid #dbe3e4; background: #fff; color: #304247; text-align: left; cursor: pointer; font: inherit; }.model-option:hover { border-color: #77b5ac; }.model-option.selected { border-color: #16766b; box-shadow: 0 0 0 2px rgba(22, 118, 107, .1); background: #f5fbf9; }.model-option.expensive { border-color: #e1c0b4; }.model-option.disabled { cursor: not-allowed; opacity: .62; background: #f4f6f6; }.model-option-main { min-width: 0; display: grid; gap: 2px; }.model-option-main strong, .model-option-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.model-option-main strong { font-size: 12px; }.model-option-main small { color: #829095; font-size: 9px; }.model-option-tags { display: flex; flex-wrap: wrap; gap: 4px; }.model-option-tags em { padding: 2px 5px; border: 1px solid #d7e1df; color: #5e7470; font-size: 9px; font-style: normal; }.model-option-meta { display: flex; justify-content: space-between; gap: 8px; color: #627578; font-size: 10px; }.model-option-status { display: flex; align-items: flex-start; gap: 5px; color: #34745b; font-size: 10px; line-height: 1.4; }.model-option-status.failed { color: #9a5648; }.selection-receipt, .retry-receipt { padding: 12px; display: grid; gap: 9px; border: 1px solid #dce4e5; background: #fafcfc; }.selection-receipt > div { display: grid; gap: 3px; }.selection-receipt strong { font-size: 12px; }.selection-receipt span { color: #708085; font-size: 10px; }.retry-receipt { border-color: #e2c8bd; background: #fff9f6; }.retry-heading { display: flex; align-items: flex-start; gap: 7px; color: #875144; }.retry-heading span { display: grid; gap: 2px; }.retry-heading small { color: #97756c; font-size: 10px; }.retry-note { color: #87685f; font-size: 10px; line-height: 1.55; }.dialog-footer { display: flex; align-items: center; justify-content: space-between; gap: 16px; }.dialog-footer > span { max-width: 520px; color: #748286; font-size: 10px; line-height: 1.5; text-align: left; }.dialog-footer > div { display: flex; gap: 8px; flex: 0 0 auto; }
@media (max-width: 720px) { .current-route { grid-template-columns: 1fr 1fr; }.current-route :deep(.el-button) { width: 100%; }.model-option-list { grid-template-columns: 1fr; max-height: 42vh; }.dialog-footer { align-items: stretch; flex-direction: column; }.dialog-footer > div { display: grid; grid-template-columns: 1fr 1fr; }.routing-choice :deep(.el-radio-group) { display: grid; grid-template-columns: 1fr; }.routing-choice :deep(.el-radio-button__inner) { width: 100%; }.model-option-meta { align-items: flex-start; flex-direction: column; gap: 3px; } }
</style>
