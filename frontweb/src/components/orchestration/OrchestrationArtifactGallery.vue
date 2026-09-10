<template>
  <section class="experience-panel artifact-panel" aria-labelledby="artifact-title">
    <header class="experience-heading"><div><small>已经做出了什么</small><h3 id="artifact-title">成果预览</h3></div><span class="artifact-count">{{ items.length }} 项</span></header>
    <p v-if="error" class="artifact-note error">暂时无法刷新成果，仍保留上一次成功显示。</p>
    <p v-else-if="!items.length && !loading" class="artifact-note">成果会在每一步完成后第一时间出现在这里。</p>
    <div v-if="loading" class="artifact-loading">正在读取最新成果…</div>
    <div v-else class="artifact-grid">
      <article v-for="item in items" :key="item.id" class="artifact-card">
        <div class="artifact-media">
          <img v-if="item.type === 'image' && item.url && !brokenIds.has(item.id)" :src="item.url" :alt="item.title" loading="lazy" @error="markBroken(item.id)" />
          <video v-else-if="item.type === 'video' && item.url && !brokenIds.has(item.id)" :src="item.url" controls preload="metadata" :aria-label="item.title" @error="markBroken(item.id)" />
          <audio v-else-if="item.type === 'audio' && item.url && !brokenIds.has(item.id)" :src="item.url" controls preload="metadata" @error="markBroken(item.id)" />
          <GlbPreview v-else-if="['model','glb','scene'].includes(item.type)" :src="item.url || ''" />
          <div v-else class="artifact-placeholder"><strong>{{ brokenIds.has(item.id) ? '预览暂时不可用' : item.url ? item.title : item.status === 'failed' ? '生成失败' : '等待文件' }}</strong><span>{{ brokenIds.has(item.id) ? '请尝试打开文件，或检查本地素材是否仍存在' : item.url ? '文件已就绪' : item.error_message || '尚未提供文件' }}</span></div>
        </div>
        <footer><div><strong :title="item.title">{{ item.title }}</strong><span>{{ mediaTypeLabel(item.type) }} · {{ artifactReviewLabel(item) }}</span></div><a v-if="item.download_url || item.url" :href="item.download_url || item.url" target="_blank" rel="noreferrer">打开</a></footer>
        <div v-if="item.artifact_id && item.url" class="artifact-review">
          <el-tooltip content="通过内容核对"><el-button :icon="CircleCheck" circle size="small" :disabled="disabled || submitting" aria-label="通过内容核对" @click="submitReview(item, 'accepted')" /></el-tooltip>
          <el-tooltip content="需要修改"><el-button :icon="EditPen" circle size="small" :disabled="disabled || submitting" aria-label="需要修改" @click="reviewItem = item; reviewNote = ''" /></el-tooltip>
          <span v-if="item.validation?.content_review?.message" :title="item.validation.content_review.message">{{ item.validation.content_review.message }}</span>
        </div>
      </article>
    </div>
    <el-dialog :model-value="Boolean(reviewItem)" title="修改意见" width="min(440px, calc(100vw - 32px))" @close="reviewItem = null">
      <el-input v-model="reviewNote" type="textarea" :rows="3" maxlength="1600" aria-label="修改意见" placeholder="需要调整的地方（可选）" />
      <template #footer><el-button :loading="submitting" :disabled="disabled" :icon="EditPen" @click="submitReview(reviewItem, 'needs_changes')">记录修改</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'
import GlbPreview from './GlbPreview.vue'
import { CircleCheck, EditPen } from '@element-plus/icons-vue'
import { artifactReviewLabel, mediaTypeLabel, normalizeArtifacts } from '@/utils/orchestrationExperience'
const props = defineProps({ items: { type: Array, default: () => [] }, loading: Boolean, error: { type: String, default: '' }, disabled: Boolean, submitting: Boolean })
const emit = defineEmits(['review'])
const reviewItem = ref(null)
const reviewNote = ref('')
function submitReview(item, verdict) {
  if (!item?.artifact_id || props.disabled || props.submitting) return
  emit('review', { message: verdict === 'accepted' ? '已核对内容，符合要求' : reviewNote.value.trim() || '此成果需要修改', scope: { type: 'artifact', artifact_id: item.artifact_id, verdict } }, saved => { if (saved) reviewItem.value = null })
}
const items = computed(() => normalizeArtifacts(props.items))
const brokenIds = ref(new Set())
function markBroken(id) {
  const next = new Set(brokenIds.value)
  next.add(id)
  brokenIds.value = next
}
</script>

<style scoped>
.experience-panel{border:1px solid var(--border-color);border-radius:12px;background:var(--bg-card);padding:18px 20px}.experience-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.experience-heading small{display:block;margin-bottom:4px;color:var(--ui-accent);font-size:11px;font-weight:800;letter-spacing:.12em}.experience-heading h3{margin:0;color:var(--text-primary);font-size:15px}.artifact-count{color:var(--text-muted);font-size:12px}.artifact-note{margin:12px 0 0;color:var(--text-muted);font-size:12px;line-height:1.6}.artifact-note.error{color:var(--text-muted)}.artifact-loading{padding:28px 0;color:var(--text-muted);font-size:12px}.artifact-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-top:14px}.artifact-card{min-width:0;overflow:hidden;border:1px solid var(--border-color);border-radius:8px;background:var(--bg-card)}.artifact-media{aspect-ratio:16/10;min-height:150px;background:var(--bg-card)}.artifact-media img,.artifact-media video{display:block;width:100%;height:100%;object-fit:cover}.artifact-media audio{width:calc(100% - 18px);margin:64px 9px}.artifact-placeholder{height:100%;display:grid;place-content:center;gap:5px;padding:18px;color:var(--text-muted);text-align:center;font-size:11px}.artifact-placeholder strong{color:var(--text-primary);font-size:12px}.artifact-card footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 11px}.artifact-card footer div{min-width:0;display:grid;gap:3px}.artifact-card footer strong{overflow:hidden;color:var(--text-primary);font-size:12px;text-overflow:ellipsis;white-space:nowrap}.artifact-card footer span{color:var(--text-muted);font-size:11px}.artifact-card footer a{flex:none;color:var(--ui-accent);font-size:11px;text-decoration:none}.artifact-card footer a:hover{text-decoration:underline}
@media(max-width:600px){.artifact-grid{grid-template-columns:1fr 1fr}.artifact-media{min-height:120px}}
.experience-panel{border:0;border-bottom:1px solid var(--border-color);border-radius:0;background:transparent}
.artifact-media img,.artifact-media video{object-fit:contain}
.experience-heading small{letter-spacing:0}
.artifact-review{display:flex;align-items:center;gap:6px;padding:0 11px 10px;min-height:32px}.artifact-review .el-button+.el-button{margin-left:0}.artifact-review span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--text-muted)}
@media(max-width:450px){.artifact-grid{grid-template-columns:1fr}}
</style>
