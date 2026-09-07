<template>
  <div class="assist-field" :class="{ compact }">
    <div v-if="label" class="assist-label">
      <span>{{ label }}</span>
      <span v-if="required" class="required-mark">必填</span>
    </div>
    <el-input
      :model-value="modelValue"
      :type="multiline ? 'textarea' : 'text'"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      :maxlength="maxlength || undefined"
      @update:model-value="$emit('update:modelValue', $event)"
    />
    <div class="assist-row">
      <el-input
        v-model="instruction"
        size="small"
        :disabled="disabled || assisting"
        placeholder="告诉 AI 想怎么写"
        @keyup.enter="assist"
      />
      <el-button
        size="small"
        :icon="MagicStick"
        :loading="assisting"
        :disabled="disabled"
        @click="assist"
      >AI 帮写</el-button>
      <el-button
        v-if="previousValue !== null"
        size="small"
        :icon="RefreshLeft"
        circle
        title="撤销本次帮写"
        :disabled="disabled || assisting"
        @click="undo"
      />
    </div>
    <div v-if="assisting" class="assist-progress" role="status" aria-live="polite">
      <el-progress :percentage="100" :indeterminate="true" :show-text="false" :duration="1.2" />
      <span>AI 正在整理这段内容，完成前不会覆盖你的其它输入</span>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { MagicStick, RefreshLeft } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { productionAPI } from '@/api/production'

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  fieldKey: { type: String, required: true },
  label: { type: String, default: '' },
  runId: { type: String, default: '' },
  context: { type: Object, default: () => ({}) },
  constraints: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  multiline: { type: Boolean, default: true },
  compact: { type: Boolean, default: false },
  required: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  rows: { type: Number, default: 3 },
  maxlength: { type: Number, default: 0 },
})

const emit = defineEmits(['update:modelValue', 'assisted'])
const instruction = ref('')
const assisting = ref(false)
const previousValue = ref(null)

async function assist() {
  if (assisting.value || props.disabled) return
  assisting.value = true
  try {
    const result = await productionAPI.assist({
      run_id: props.runId || undefined,
      field_key: props.fieldKey,
      current_value: props.modelValue == null ? '' : String(props.modelValue),
      instruction: instruction.value.trim() || undefined,
      constraints: props.constraints || undefined,
      context: props.context,
    })
    previousValue.value = props.modelValue
    emit('update:modelValue', result.value)
    emit('assisted', result.value)
    ElMessage.success('已填入草稿，保存前仍可继续修改')
  } catch (error) {
    ElMessage.error(error.message || 'AI 帮写失败')
  } finally {
    assisting.value = false
  }
}

function undo() {
  emit('update:modelValue', previousValue.value)
  previousValue.value = null
}
</script>

<style scoped>
.assist-field { display: grid; gap: 7px; min-width: 0; }
.assist-label { min-height: 20px; display: flex; align-items: center; gap: 8px; color: #34434e; font-size: 13px; font-weight: 650; }
.required-mark { color: #a95143; font-size: 11px; font-weight: 500; }
.assist-row { min-height: 32px; display: grid; grid-template-columns: minmax(120px, 1fr) auto auto; gap: 7px; align-items: center; }
.assist-row :deep(.el-button) { margin-left: 0; min-height: 30px; }
.compact { gap: 5px; }
.assist-progress { display: grid; gap: 4px; color: #52736f; font-size: 11px; }
.assist-progress :deep(.el-progress-bar__outer) { background: #e6efed; }
.compact .assist-row { grid-template-columns: minmax(90px, 1fr) auto auto; }
@media (max-width: 640px) {
  .assist-row, .compact .assist-row { grid-template-columns: minmax(0, 1fr) auto auto; }
  .assist-row :deep(.el-button:not(.is-circle)) span { display: inline; }
}
</style>
