<template>
  <section v-if="jobs.length || error" class="local-media-progress" aria-label="本地处理与组件准备">
    <h4>本地处理进度</h4>
    <p v-if="error" role="status">{{ error }}，保留上次成功读取的进度。</p>
    <article v-for="job in jobs" :key="job.id" :aria-label="job.request.module_id">
      <h5>{{ job.operation_title || job.result?.artifact?.title || job.request.module_id }}</h5>
      <div class="heading"><strong>{{ stageLabel(job) }}</strong><span>{{ job.status === 'succeeded' ? '成果已就绪' : job.status === 'failed' ? '需要恢复' : '无需你安装或配置' }}</span></div>
      <p>{{ job.error?.message || job.progress?.message || '正在准备，组件安装后自动继续原任务' }}</p>
      <template v-if="job.progress?.total_bytes && job.status === 'running'">
        <progress :value="job.progress.bytes || 0" :max="job.progress.total_bytes" aria-label="组件下载进度" />
        <small>{{ megabytes(job.progress.bytes) }} / {{ megabytes(job.progress.total_bytes) }} MB</small>
      </template>
      <div v-if="job.result" class="result">
        <a :href="job.result.url" target="_blank" rel="noreferrer">{{ job.result.details?.after?.format === 'pdf' ? '打开可搜索PDF' : job.result.details?.after?.format === 'txt' ? '打开识别文字' : job.result.details?.quality_status === 'review_required' ? '查看处理结果' : '打开已验证成果' }}</a>
        <span><template v-if="job.result.details?.after?.page_count">{{ job.result.details.after.page_count }} 页 · </template><template v-if="job.result.details?.after?.width && job.result.details?.after?.height">{{ job.result.details.after.width }} x {{ job.result.details.after.height }} px · </template><template v-if="job.result.details?.after?.line_count">{{ job.result.details.after.line_count }} 行文字 · </template>{{ fileSize(job.result.bytes) }} · 原素材已保留</span>
      </div>
      <template v-if="job.result?.details?.text_preview">
        <pre class="text-preview">{{ job.result.details.text_preview }}</pre>
      </template>
      <div v-if="job.result?.attachments?.length" class="attachment-list">
        <a v-for="item in job.result.attachments.filter(item => item.role !== 'source_frame')" :key="item.file" :href="item.url" target="_blank" rel="noreferrer">
          <img v-if="item.type === 'image'" :src="item.url" :alt="item.title" loading="lazy" />
          <span>{{ item.title }} · {{ fileSize(item.bytes) }}</span>
        </a>
        <details v-if="job.result.attachments.some(item => item.role === 'source_frame')"><summary>查看全部原尺寸关键帧</summary><a v-for="item in job.result.attachments.filter(item => item.role === 'source_frame')" :key="item.file" :href="item.url" target="_blank" rel="noreferrer">{{ item.title }}</a></details>
      </div>
      <p v-if="job.result?.details?.quality_note">{{ job.result.details.quality_note }}</p>
      <el-button v-if="job.status === 'failed'" size="small" :loading="resuming === job.id" @click="resume(job)">恢复此任务</el-button>
      <details><summary>查看处理记录</summary><ol><li v-for="(event,index) in job.events" :key="index">{{ new Date(event.at).toLocaleTimeString() }} · {{ labels[event.stage] || event.stage }}<span v-if="event.message">：{{ event.message }}</span></li></ol></details>
    </article>
  </section>
</template>
<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
import api from '@/api/orchestration'
const props = defineProps({ sessionId: { type: String, required: true } })
const jobs = ref([]), error = ref(''), resuming = ref('')
let timer, disposed = false, generation = 0
const labels = { frame_index:'读取视频时间线',extract_frames:'提取原尺寸关键帧',storyboards:'合成时间线故事板',queued:'等待本地处理',preflight:'检查输入素材',preparing:'自动准备组件',retry_wait:'等待自动重试',download:'正在下载组件',cache_reused:'复用已有下载',verify:'校验组件完整性',install:'自动安装组件',healthcheck:'检查组件能否运行',ready:'组件已就绪',reused:'复用已安装组件',repair:'自动修复组件',executing:'正在处理素材',validating:'正在检查成果',validated:'正在保存成果',succeeded:'本地处理完成',failed:'本地处理暂停' }
const stageLabel = job => labels[job.status === 'succeeded' ? 'succeeded' : job.status === 'failed' ? 'failed' : job.progress?.stage] || '正在处理'
const megabytes = value => ((Number(value) || 0) / 1024 ** 2).toFixed(1)
const fileSize = value => Number(value) < 1024 ** 2 ? ((Number(value) || 0) / 1024).toFixed(1) + ' KB' : megabytes(value) + ' MB'
async function load() {
  clearTimeout(timer); const current = ++generation
  try { const data = await api.localMediaJobs(props.sessionId); if (current === generation && !disposed) { jobs.value = data?.items || []; error.value = '' } }
  catch (e) { if (!disposed && current === generation) error.value = e?.message || '暂时无法刷新进度' }
  finally { if (!disposed && current === generation) timer = setTimeout(load, document.hidden ? 15000 : jobs.value.some(j => ['queued','running'].includes(j.status)) ? 1200 : 5000) }
}
async function resume(job) { resuming.value = job.id; try { await api.resumeLocalMedia(job.id); await load() } catch(e) { error.value = e?.message || '恢复未完成' } finally { resuming.value = '' } }
watch(() => props.sessionId, () => { jobs.value = []; load() }, { immediate: true })
onBeforeUnmount(() => { disposed = true; generation++; clearTimeout(timer) })
</script>
<style scoped>
.local-media-progress{display:grid;gap:12px;margin-top:20px}h4{margin:0}article{padding:15px;border:1px solid var(--border-color);border-radius:10px;background:var(--bg-card)}.heading,.result{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.heading span,.result span,small{color:var(--text-muted);font-size:12px}p{font-size:13px;line-height:1.7;overflow-wrap:anywhere}progress{width:100%;accent-color:var(--ui-accent)}a{color:var(--ui-accent)}details{margin-top:12px;font-size:12px;color:var(--text-muted)}summary{cursor:pointer}ol{max-height:180px;overflow:auto;line-height:1.7;padding-left:22px}.text-preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font-family:inherit;font-size:13px;line-height:1.7}
</style>
<style scoped>
.attachment-list{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}.attachment-list>a{display:grid;gap:5px;max-width:230px;font-size:12px}.attachment-list img{max-width:230px;max-height:240px;object-fit:contain}.attachment-list details{width:100%}.attachment-list details a{display:inline-block;margin:8px}
</style>
