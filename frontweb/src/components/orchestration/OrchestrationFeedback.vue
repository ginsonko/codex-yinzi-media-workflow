<template>
  <section class="experience-panel feedback-panel" aria-labelledby="feedback-title">
    <header class="experience-heading"><div><small>发现偏差时</small><h3 id="feedback-title">告诉 Codex 怎么改</h3></div></header>
    <p class="feedback-copy">写一句自然的话就可以。提交后会记录在当前任务，并暂停后续步骤，已经受理的生成不会被重复提交。</p>
    <el-input v-model="message" type="textarea" :rows="3" maxlength="1000" show-word-limit :disabled="disabled" placeholder="例如：第二个镜头慢一点，产品保持在画面中央，先不要重新生成第一张图" />
    <div class="feedback-actions"><el-select v-model="scope" size="small" :disabled="disabled" aria-label="修改范围"><el-option value="session" label="整个任务" /><el-option value="shot" label="某个镜头" /><el-option value="artifact" label="某个成果" /></el-select><el-checkbox v-model="pause" :disabled="disabled">提交后暂停</el-checkbox><el-button type="primary" size="small" :loading="submitting" :disabled="disabled || !message.trim()" @click="submit">记录修改意见</el-button></div>
    <p v-if="submitted" class="feedback-success" aria-live="polite">已记录。Codex 下次读取任务时会看到这条修改意见。</p>
  </section>
</template>

<script setup>
import { ref } from 'vue'
const props = defineProps({ disabled: Boolean, submitting: Boolean, submitted: Boolean })
const emit = defineEmits(['submit'])
const message = ref(''); const scope = ref('session'); const pause = ref(true)
function submit() { const value = message.value.trim(); if (!value) return; emit('submit', { message: value, scope: scope.value, pause: pause.value }) }
</script>

<style scoped>
.experience-panel{border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);padding:18px 20px}.experience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.experience-heading small{display:block;margin-bottom:4px;color:var(--ui-accent);font-size:11px;font-weight:800;letter-spacing:.12em}.experience-heading h3{margin:0;color:var(--text-primary);font-size:15px}.feedback-copy{margin:10px 0 12px;color:var(--text-muted);font-size:12px;line-height:1.6}.feedback-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:10px;margin-top:10px}.feedback-actions :deep(.el-checkbox__label){color:var(--text-muted);font-size:12px}.feedback-success{margin:10px 0 0;color:var(--ui-accent);font-size:12px}
</style>
