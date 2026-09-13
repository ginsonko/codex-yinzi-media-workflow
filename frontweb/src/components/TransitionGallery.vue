<template>
  <el-dialog :model-value="open" title="选择适合镜头的转场" width="min(1000px, calc(100vw - 24px))" class="transition-gallery" destroy-on-close @update:model-value="$emit('update:open', $event)">
    <p class="intro">先看效果，再告诉 Codex 用在哪里。以下短片由本地剪辑工具实际生成，A 与 B 代表前后两个镜头。</p>
    <div v-if="options.length" class="gallery-layout">
      <section class="preview-stage" aria-label="转场效果预览">
        <video v-if="selected" :key="selected.id" :src="`/transition-previews/${selected.id}.mp4`" controls muted playsinline preload="metadata" @error="mediaError = true" @loadeddata="mediaError = false" />
        <p v-if="mediaError" role="status">预览暂时无法载入；可以刷新页面后重试，或直接把下方要求交给 Codex。</p>
        <template v-if="selected"><h3>{{ selected.title }}</h3><p>{{ selected.use_case }}</p><p class="hint">转场会重叠前后片段。Codex 会结合节拍、镜头方向与目标总时长安排切点。</p><div class="instruction">{{ instruction }}</div><el-button @click="copyInstruction">复制这段要求</el-button><span class="copy-status" role="status">{{ copyStatus }}</span></template>
      </section>
      <section class="option-section"><el-input v-model="query" clearable aria-label="搜索转场" placeholder="搜索：推近、擦除、像素…" /><div class="option-grid"><button v-for="option in filtered" :key="option.id" type="button" :class="['option', {selected: selected?.id === option.id}]" :aria-pressed="selected?.id === option.id" @click="select(option)"><strong>{{ option.title }}</strong><small>{{ option.use_case }}</small></button></div><p v-if="!filtered.length" role="status">没有匹配的转场，换一个关键词试试。</p></section>
    </div>
    <el-empty v-else description="当前后台尚未提供转场目录，请更新工作流后刷新。" />
  </el-dialog>
</template>
<script setup>
import { computed, ref, watch } from 'vue'
const props=defineProps({open:Boolean,options:{type:Array,default:()=>[]}})
defineEmits(['update:open'])
const query=ref(''),selectedId=ref('fade'),copyStatus=ref(''),mediaError=ref(false)
const options=computed(()=>props.options.filter(o=>/^[a-z]+$/.test(o.id)))
const selected=computed(()=>options.value.find(o=>o.id===selectedId.value)||options.value[0])
const filtered=computed(()=>options.value.filter(o=>`${o.id} ${o.title} ${o.use_case}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const instruction=computed(()=>selected.value?`请在需要衔接的两个镜头之间使用“${selected.value.title}”（${selected.value.id}）本地转场。按素材、节拍和目标总时长安排合适的重叠时长，先给我看效果。`:'')
function select(option){selectedId.value=option.id;copyStatus.value='';mediaError.value=false}
async function copyInstruction(){try{await navigator.clipboard.writeText(instruction.value);copyStatus.value='已复制，粘贴给 Codex 即可'}catch{copyStatus.value='请选中上方文字复制'}}
watch(()=>props.open,()=>{copyStatus.value='';mediaError.value=false})
</script>
<style scoped>
.intro{margin:0 0 20px;line-height:1.7;color:var(--text-muted)}.gallery-layout{display:grid;grid-template-columns:minmax(280px,1fr) minmax(280px,1fr);gap:24px}.preview-stage{min-width:0}.preview-stage video{display:block;width:100%;aspect-ratio:16/9;background:#141d2c;border-radius:12px}.preview-stage h3{margin:18px 0 6px;font-size:21px}.preview-stage p{line-height:1.7;color:var(--text-muted)}.hint{font-size:12px}.instruction{margin:15px 0;padding:14px;border:1px solid var(--border-color);border-radius:8px;line-height:1.8;font-size:13px;overflow-wrap:anywhere}.copy-status{display:block;margin-top:8px;color:var(--text-muted);font-size:12px}.option-section{min-width:0}.option-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;max-height:490px;overflow:auto;padding:3px}.option{padding:12px;text-align:left;color:var(--text-primary);background:var(--bg-card);border:1px solid var(--border-color);border-radius:8px;cursor:pointer;min-width:0}.option strong,.option small{display:block}.option strong{font-size:13px}.option small{margin-top:5px;line-height:1.5;color:var(--text-muted);font-size:11px}.option.selected{border-color:var(--ui-accent);box-shadow:inset 0 0 0 1px var(--ui-accent)}.option:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}@media(max-width:650px){.gallery-layout{grid-template-columns:1fr;gap:18px}.option-section{grid-row:1}.option-grid{max-height:160px}.intro{font-size:13px}.preview-stage h3{font-size:18px}}
</style>
