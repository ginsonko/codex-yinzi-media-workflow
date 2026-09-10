<template>
  <section class="work-activity" aria-label="当前任务进展">
    <header><div><small>{{ finished ? '分析与记录' : '当前任务' }}</small><h3>{{ session.title }}</h3></div><span class="activity-label">{{ label }}</span></header>
    <div v-if="inputs.length" class="input-chips" aria-label="本次参考素材"><span v-for="(item,index) in inputs" :key="index">{{ typeof item === 'string' ? item : item.name || item.filename || item.type }}</span></div>
    <p class="work-message">{{ presentation.message }}</p>
    <p v-if="presentation.notice" class="pending-receipts" role="note">{{ presentation.notice }}</p>
    <p v-if="presentation.lastMessage" class="last-message">上次记录：{{ presentation.lastMessage }}</p>
    <div class="work-facts"><span>下一步：{{ presentation.next }}</span><span v-if="presentation.needsUser">需要补充信息，请查看 Codex 对话</span></div>
    <small class="work-time">{{ presentation.timestampLabel || '最近实际回报' }}：{{ timestamp ? new Date(timestamp).toLocaleString() : '尚未回报' }}<span v-if="stale"> · 等待新状态</span></small>
    <div v-if="continuationPrompt && !finished" class="continuation-actions">
      <a v-if="codexLink" :href="codexLink">打开原 Codex 任务</a>
      <el-button size="small" plain @click="copyContinuation">复制继续任务指令</el-button>
      <span role="status">{{ continuationHint }}</span>
    </div>
    <textarea v-if="showContinuationText" class="continuation-text" aria-label="原任务继续指令" readonly :value="continuationPrompt" @focus="$event.target.select()" />
    <p v-if="session.source_context?.intent === 'analyze'" class="intent-note">本次为分析任务；分析结论会保存在这里。</p>
    <details v-if="acceptance.length"><summary>本次验收目标</summary><ul><li v-for="(item,index) in acceptance" :key="index">{{ item }}</li></ul></details>
    <details v-if="report"><summary>查看分析结论与验收标准</summary><pre>{{ reportText }}</pre><el-button size="small" plain @click="downloadReport">下载分析报告</el-button></details>
    <slot />
  </section>
</template>
<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { describeWorkActivity } from '@/utils/workActivity'
import { codexTaskLink, taskContinuationPrompt } from '@/utils/taskContinuation'
const props = defineProps({ session: { type:Object, required:true }, nodes: { type:Array, default: () => [] } })
const codexLink = computed(() => codexTaskLink(props.session))
const continuationPrompt = computed(() => taskContinuationPrompt(props.session))
const continuationHint = ref('')
const showContinuationText = ref(false)
watch(() => props.session.id, () => { continuationHint.value = ''; showContinuationText.value = false })
async function copyContinuation() {
  const text = continuationPrompt.value
  const sessionId = props.session.id
  try {
    await navigator.clipboard.writeText(text)
    if (props.session.id !== sessionId) return
    continuationHint.value = '已复制，粘贴到 Codex 即可继续原任务。'
    showContinuationText.value = false
  } catch {
    if (props.session.id !== sessionId) return
    showContinuationText.value = true
    continuationHint.value = '请复制下方指令并粘贴到 Codex。'
  }
}
const clock = ref(Date.now()); let timer
onMounted(() => { timer = setInterval(() => { clock.value = Date.now() }, 5000) })
onBeforeUnmount(() => clearInterval(timer))
const presentation = computed(() => describeWorkActivity(props.session, props.nodes, clock.value))
const finished = computed(() => presentation.value.finished)
const timestamp = computed(() => presentation.value.timestamp)
const stale = computed(() => presentation.value.stale)
const label = computed(() => presentation.value.label)
const inputs = computed(() => Array.isArray(props.session.source_context?.inputs) ? props.session.source_context.inputs : [])
const acceptance = computed(() => Array.isArray(props.session.source_context?.acceptance) ? props.session.source_context.acceptance : [])
const report = computed(() => props.session.source_context?.analysis_report)
const reportText = computed(() => {
 if (typeof report.value === 'string') return report.value
 const labels={summary:'结论',findings:'分析发现',approach:'推荐方案',acceptance:'验收标准',next_steps:'下一步',risks:'待验证事项'}
 return Object.entries(report.value || {}).map(([key,value]) => `${labels[key] || key}\n${Array.isArray(value) ? value.map(item => typeof item === 'string' ? `• ${item}` : JSON.stringify(item)).join('\n') : typeof value === 'object' ? JSON.stringify(value,null,2) : value}`).join('\n\n')
})
function downloadReport() {
 const url=URL.createObjectURL(new Blob([reportText.value],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='分析报告.md';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
}
</script>
<style scoped>
.work-activity { padding:22px; border:1px solid var(--border-color); border-left:4px solid var(--ui-accent); border-radius:8px; background:var(--bg-card); color:var(--text-primary); min-width:0; overflow-wrap:anywhere; }
header { display:flex; justify-content:space-between; gap:16px; align-items:center; } h3 { margin:6px 0; font-size:20px; } header small,.work-time,.intent-note { color:var(--text-secondary,var(--text-muted)); }
.activity-label { border:1px solid var(--ui-accent); color:var(--text-primary); border-radius:20px; padding:5px 12px; white-space:nowrap; }
.input-chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; } .input-chips span { padding:5px 10px; border:1px solid var(--border-color); border-radius:6px; overflow-wrap:anywhere; }
.work-message { font-size:16px; line-height:1.7; } .work-facts { display:flex; flex-wrap:wrap; gap:12px 28px; margin:12px 0; } .work-time { display:block; margin-bottom:12px; }
summary { cursor:pointer; padding:12px 0; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; line-height:1.7; max-height:420px; overflow:auto; } .intent-note { font-size:12px; }
.last-message { color:var(--text-secondary,var(--text-muted)); font-size:13px; }
.pending-receipts { padding:10px 12px; border:1px solid var(--border-color); border-radius:6px; font-size:13px; line-height:1.6; }
.continuation-actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:12px 0; font-size:13px; }
.continuation-actions a { color:var(--ui-accent); }
.continuation-actions span { color:var(--text-secondary,var(--text-muted)); }
.continuation-text { box-sizing:border-box; width:100%; min-height:120px; padding:10px; color:var(--text-primary); background:var(--bg-card); border:1px solid var(--border-color); border-radius:6px; resize:vertical; }
@media(max-width:600px) { .work-activity { padding:15px; } header { align-items:flex-start; flex-wrap:wrap; } h3 { font-size:17px; } }
</style>
