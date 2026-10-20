<template>
  <div class="workbench-view">
    <div class="batch-page">
      <section class="batch-hero">
        <div>
          <span class="kicker">批量生成</span>
          <h2>一次排 N 条，逐项或逐行都行</h2>
          <p>这一页在管两件事：把要生成的内容排成队列，以及看着队列一条条收口。数量、并发、模型、画幅、时长、预算提醒都在左边直接改，改完的数值会记住下次接着用。提交前先给你看一遍展开后的清单和本地价格表算出的预估，确认之后才会真的提交。</p>
        </div>
        <div class="batch-hero-stat">
          <strong v-if="activeBatch">{{ activeBatch.completed }} / {{ activeBatch.total }}</strong>
          <strong v-else>—</strong>
          <span>{{ activeBatch ? '当前批次已完成' : '还没有活动批次' }}</span>
        </div>
      </section>

      <section class="source-paths" aria-label="批量任务入口">
        <div><span class="path-icon"><el-icon><EditPen /></el-icon></span><span><strong>手动生成与逐项参考</strong><small>每项独立提示词与素材，无需 Codex，单条也能直接生成。</small></span></div>
        <router-link to="/asset-import"><span class="path-icon"><el-icon><FolderOpened /></el-icon></span><span><strong>有几百或几千个素材文件</strong><small>先让 Codex 识别文件、产品和用途，再生成逐项方案。</small></span><el-icon><ArrowRight /></el-icon></router-link>
        <router-link to="/codex-console"><span class="path-icon"><el-icon><MagicStick /></el-icon></span><span><strong>只有一句目标</strong><small>让 Codex 先研究、规划并选择图片、视频、剪辑或 Blender 工具。</small></span><el-icon><ArrowRight /></el-icon></router-link>
      </section>

      <div class="batch-grid">
        <section class="panel setup-panel">
          <header class="panel-heading"><div><span class="kicker">设置任务</span><h3>设置你要生成的内容</h3></div><span class="hint">无需 Codex，单条也能生成</span></header>
          <el-tabs v-model="form.kind" stretch><el-tab-pane label="图片" name="image" /><el-tab-pane label="视频" name="video" /></el-tabs>
          <el-radio-group v-model="editorMode" class="editor-modes" aria-label="任务编辑方式"><el-radio-button value="manual">逐项编辑 · 上传参考</el-radio-button><el-radio-button value="quick">快速逐行批量</el-radio-button></el-radio-group>
          <ManualBatchEditor v-show="editorMode === 'manual'" :kind="form.kind" :options="modelOptions" :defaults="form" @change="manualState = $event" />
          <div v-show="editorMode === 'quick'">
          <label class="field-label">共同提示词</label><el-input v-model="form.prompt" type="textarea" :rows="4" placeholder="例如：为这款白色咖啡杯制作一张干净的电商主图，柔和侧光，留出标题空间" />
          <div class="field-note">每一项都会继承这段描述；如果下面填写了逐项提示词，则逐项内容优先。</div>
          <label class="field-label">逐项提示词（可选）</label><el-input v-model="form.lines" type="textarea" :rows="6" placeholder="一行一个变体，例如：&#10;厨房台面场景&#10;办公桌场景&#10;户外野餐场景" />
          <div class="field-note">没有逐项提示词时，用“生成数量”自动复制共同提示词并编号。</div>
          </div>
          <div class="form-row"><div v-if="editorMode !== &quot;manual&quot;"><label class="field-label">生成数量</label><el-input-number v-model="form.count" :min="1" :max="10000" controls-position="right" /><div class="field-note">最多 10,000 项，队列按页显示</div></div><div><label class="field-label">并发数量</label><el-input-number v-model="form.concurrency" :min="1" :precision="0" controls-position="right" @change="saveConcurrency" /><div class="field-note">同时提交多少个请求。填正整数；按模型限流和机器能力决定上限，怕被限流就从 1 开始。</div></div></div>
          <div class="form-row"><div><label class="field-label">默认模型（本项未指定时使用）</label><el-select v-model="form.model" clearable filterable allow-create default-first-option placeholder="使用系统默认，或输入模型名" class="full"><el-option v-for="item in modelOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select><div class="field-note" v-if="!modelOptions.length">正在读取可用模型；读取不到也可以直接输入模型名。</div></div><div><label class="field-label">批次名称</label><el-input v-model="form.title" placeholder="例如：夏季产品图第一批" /></div></div>
          <div class="advanced-box"><div class="advanced-title">默认参数 <small>每项可单独覆盖</small></div><div class="form-row"><div><label class="field-label">画幅</label><el-select v-model="form.settings.aspect_ratio" class="full"><el-option v-for="ratio in imageRatios" :key="ratio" :label="ratio" :value="ratio" /></el-select></div><div v-if="form.kind === 'video'"><label class="field-label">时长（秒）</label><el-input-number v-model="form.settings.duration" :min="1" controls-position="right" /><div class="field-note">预估费用按这个时长计算；这是单次生成的时长，多数模型只支持 5 / 10 / 15 秒</div><div v-if="durationHint" :class="['field-note', 'duration-hint', { warning: durationHint.warning }]" role="status">{{ durationHint.text }}</div></div><div v-else-if="defaultImagePreset"><label class="field-label">清晰度档位</label><el-select v-model="form.settings.image_tier" class="full"><el-option v-for="tier in imageTiers" :key="tier" :label="tier" :value="tier" /></el-select><div class="field-note">实际尺寸 {{ defaultImageSize }}</div></div><div v-else-if="form.kind === 'image'"><label class="field-label">自定义尺寸（可选）</label><el-input v-model="form.settings.size" placeholder="例如 1024x1024；留空使用模型默认" /></div></div></div>
          <div class="advanced-box"><el-switch v-model="form.adaptive" active-text="逐渐探索合适并发" @change="saveExploration" /><p class="field-note">从 1 开始，整轮成功后递增；同类任务变慢或限流时停止增加。</p><div v-if="form.adaptive" class="form-row"><div><label class="field-label">长尾耗时倍率</label><el-input-number v-model="form.slowdown_ratio" :min="1.1" :step="0.5" /></div><div><label class="field-label">最短观察时间（秒）</label><el-input-number v-model="form.min_observation_seconds" :min="0" :step="10" /></div></div></div>

          <div class="advanced-box budget-box">
            <div class="advanced-title">预算提醒 <small>仅提醒，不阻止提交</small></div>
            <div class="form-row">
              <div>
                <label class="field-label">单次费用提醒值（USD，留空不提醒）</label>
                <el-input-number v-model="form.budget_usd" :min="0" :step="1" :precision="2" controls-position="right" />
              </div>
              <div>
                <label class="field-label">预估依据</label>
                <div class="field-note">{{ priceSourceNote }}</div>
              </div>
            </div>
            <p class="field-note">按本地价格表提供费用参考；超过提醒值或价格未知时仍可提交、重试或重新生成。实际费用以上游账单为准。</p>
          </div>

          <div class="estimate">
            <div><span>将创建 {{ plannedCount }} 个可恢复项目</span><small>最多同时提交 {{ form.concurrency }} 个</small></div>
            <div class="estimate-cost">
              <span class="estimate-value" :class="estimateClass">{{ estimateText }}</span>
              <small>{{ estimate.status === 'ok' ? '本地价格表估算，非实际账单' : '没有可用价格项时不显示估算' }}</small>
            </div>
          </div>
          <p v-if="budgetExceeded" class="cap-warning">预估 {{ formatUsd(estimate.total) }} 已超过你设置的提醒值 {{ formatUsd(form.budget_usd) }}。你可以调整数量、时长或模型，也可以按当前参数继续提交。</p>
          <el-button type="primary" size="large" :loading="submitting" :disabled="!canSubmit" @click="openPreview"><el-icon><VideoPlay /></el-icon>{{ plannedCount === 1 ? '生成这一条' : '生成这 ' + plannedCount + ' 条任务' }}</el-button><p class="field-note submit-note">点开后先看展开清单和预估，再决定提交。</p>
          <p v-if="submitError" class="inline-error">{{ submitError }}</p>
          <div v-if="pendingSubmission && !submitting" class="pending-submission-note" role="status">
            <p class="field-note">上次提交尚未收到回执。按原参数再次提交会恢复原请求；也可按当前参数直接新建一次。原任务和费用记录仍保留。</p>
            <el-button plain @click="recoverSubmission">恢复上次提交（保留原素材和参数）</el-button>
            <el-button plain :disabled="!canSubmit" @click="openPreview(true)">按当前参数新建一次</el-button>
          </div>
        </section>

        <section class="panel queue-panel">
          <header class="panel-heading"><div><span class="kicker">实时队列</span><h3>{{ activeBatch ? activeBatch.title : '等待第一批任务' }}</h3></div><div class="queue-actions"><el-button v-if="activeBatch && ['running','queued'].includes(activeBatch.status)" size="small" type="warning" plain @click="pause">暂停后续提交</el-button><el-button v-if="activeBatch && activeBatch.status === 'paused'" size="small" type="primary" plain @click="resume">继续提交</el-button><el-button size="small" plain :loading="loading" @click="refresh">刷新</el-button></div></header>
          <template v-if="activeBatch">
            <div class="field-note" role="status">模型 {{ activeBatch.model || '使用已保存默认模型' }} · 当前并发 {{ activeBatch.effective_concurrency || activeBatch.concurrency }} / 上限 {{ activeBatch.concurrency }} · {{ explorationLabel(activeBatch.exploration) }}</div>
            <div class="queue-summary"><div><strong>{{ batchPercent === null ? '阶段制' : batchPercent + '%' }}</strong><span>{{ batchStatusLabel(activeBatch.status) }}</span></div><el-progress :percentage="batchPercent || 0" :show-text="false" :status="activeBatch.failed && !activeBatch.completed ? 'exception' : undefined" /><div class="counts"><span>排队 {{ activeBatch.queued }}</span><span>运行 {{ activeBatch.running }}</span><span>完成 {{ activeBatch.completed }}</span><span>失败 {{ activeBatch.failed }}</span><span v-if="activeBatch.needs_review" class="review-count">待核对 {{ activeBatch.needs_review }}</span></div></div>
            <div v-if="activeBatch.needs_review" class="review-note"><el-icon><Warning /></el-icon><span><strong>有 {{ activeBatch.needs_review }} 项结果待核对</strong><small>可以查询原请求，也可以重新排队。原结果与费用记录会保留。</small></span></div>

            <div class="item-toolbar">
              <el-select v-model="itemFilter" size="small" aria-label="队列项筛选"><el-option label="全部状态" value="all" /><el-option label="未完成" value="open" /><el-option label="等待提交" value="queued" /><el-option label="上游处理中" value="processing" /><el-option label="已完成" value="completed" /><el-option label="失败" value="failed" /><el-option label="待核对" value="needs_review" /></el-select>
              <el-select v-model="itemSort" size="small" aria-label="队列项排序"><el-option label="按序号" value="ordinal" /><el-option label="按状态" value="status" /><el-option label="按尝试次数" value="attempt" /></el-select>
              <el-radio-group v-model="itemDirection" size="small" aria-label="排序方向"><el-radio-button value="asc">正序</el-radio-button><el-radio-button value="desc">倒序</el-radio-button></el-radio-group>
              <span class="toolbar-note">当前页 {{ visibleItems.length }} / {{ (activeBatch.items || []).length }} 项 · 本页第 {{ itemPage }} 页</span>
            </div>

            <div v-if="visibleItems.length" class="item-list"><article v-for="item in visibleItems" :key="item.id" :class="['queue-item', item.status]"><div class="item-index">{{ item.ordinal + 1 }}</div><div class="item-main"><strong>{{ item.request && item.request.prompt ? item.request.prompt : '项目 ' + (item.ordinal + 1) }}</strong><small v-if="item.request">{{ referenceSummary(item.request) }}</small><small v-if="item.kind === 'image' && item.request && imageSizeSubmissionNote(item.request.model, item.request.size, item.request.aspect_ratio)">{{ imageSizeSubmissionNote(item.request.model, item.request.size, item.request.aspect_ratio) }}</small><small v-if="item.download_status === 'waiting_provider'">服务端成片尚未就绪，正在恢复取回</small><small v-else-if="item.error_message" :class="['item-error', { review: batchItemNeedsReview(item) }]">{{ item.error_message }}</small><small v-else>{{ itemStatusLabel(item.status) }}<span v-if="item.attempt"> · 第 {{ item.attempt }} 次</span></small><small class="item-id">项目 {{ shortId(item.id) }}<template v-if="attemptHistory(item).length"> · 历史尝试 {{ attemptHistory(item).length }} 次</template></small></div><div class="item-preview"><video v-if="item.kind === 'video' && item.media_url" :src="artifactMediaUrlItem(item)" controls preload="metadata" /><img v-else-if="item.kind === 'image' && item.media_url && !broken.has(item.id)" :src="artifactMediaUrlItem(item)" alt="" @error="markBroken(item.id)" /><span v-else :class="{ broken: broken.has(item.id) }"><el-icon><component :is="item.kind === 'video' ? 'VideoCamera' : 'Picture'" /></el-icon></span></div><div class="item-actions"><el-button v-if="attemptHistory(item).length" link @click="openAttempts(item)">历史尝试</el-button><el-button v-if="batchItemCanRetry(item)" link type="primary" :loading="retrying.has(item.id)" :disabled="retrying.has(item.id)" @click="retry(item)">重新尝试</el-button><span v-else-if="batchItemNeedsReview(item)" class="reconcile-label">先核对</span><a v-if="item.media_url" :href="artifactMediaUrlItem(item)" target="_blank" rel="noreferrer">打开</a></div></article></div>
            <div v-else class="item-empty">本页没有符合「{{ filterLabel(itemFilter) }}」的项目。换成「全部状态」可以看到这一页的全部内容。</div>
            <p class="item-capability-note">服务端目前只支持整批暂停 / 继续和单项重试：单项的暂停、移除、改参数都没有对应的接口，所以这里不提供。要停掉后续提交就按上面的「暂停后续提交」，已经提交到上游的项目会自然收口。</p>
            <el-pagination v-if="activeBatch.items_total > itemPageSize" v-model:current-page="itemPage" :page-size="itemPageSize" :total="activeBatch.items_total" layout="prev, pager, next" class="item-pagination" @current-change="loadItemPage" />
          </template>
          <div v-else class="queue-empty"><el-icon><CopyDocument /></el-icon><strong>这里会显示每一项的真实状态</strong><p>提交后可以刷新页面，队列会从本地服务继续。</p><div class="queue-empty-actions"><el-button plain @click="refresh">刷新队列</el-button><el-button plain @click="editorMode = 'manual'">先去设置第一批内容</el-button></div></div>
        </section>
      </div>

      <section class="panel history-panel">
        <header class="panel-heading">
          <div><span class="kicker">批次记录</span><h3>最近批量任务</h3></div>
          <div class="history-actions">
            <el-select v-model="batchFilter" size="small" aria-label="批次筛选"><el-option label="全部状态" value="all" /><el-option label="执行中" value="active" /><el-option label="已完成" value="completed" /><el-option label="有失败" value="failed" /><el-option label="已暂停" value="paused" /></el-select>
            <el-select v-model="batchSort" size="small" aria-label="批次排序"><el-option label="按更新时间" value="updated" /><el-option label="按完成比例" value="percent" /><el-option label="按项目数" value="total" /></el-select>
            <router-link to="/history">查看全部历史 <el-icon><ArrowRight /></el-icon></router-link>
          </div>
        </header>
        <div v-if="visibleBatches.length" class="batch-history"><button v-for="batch in visibleBatches" :key="batch.id" type="button" :class="{ active: batch.id === activeBatch?.id }" @click="selectBatch(batch.id)"><span><strong>{{ batch.title }}</strong><small>{{ batch.total }} 项 · {{ batch.updated_at ? new Date(batch.updated_at).toLocaleString('zh-CN') : '刚刚' }}</small></span><em :class="batchTone(batch.status)">{{ batchStatusLabel(batch.status) }}</em></button></div>
        <div v-else-if="batches.length" class="empty-note">没有符合当前筛选的批次。<el-button text size="small" @click="batchFilter = 'all'">显示全部状态</el-button></div>
        <div v-else class="empty-note">还没有批次记录。左边设置好参数提交第一批，这里就会开始留下记录。</div>
      </section>
    </div>

    <el-dialog v-model="showPreview" title="确认这批要提交什么" width="min(820px, 94vw)" top="6vh">
      <p class="dialog-note"><strong>{{ submitPreview.rows.length }}</strong> 条项目将以并发 {{ form.concurrency }} 提交给{{ form.kind === 'video' ? '视频' : '图片' }}模型。下面每一条都是提交后队列里的真实内容；看完再点确认。</p>
      <div class="preview-summary">
        <span><small>类型</small><strong>{{ form.kind === 'video' ? '视频' : '图片' }}</strong></span>
        <span><small>数量</small><strong>{{ submitPreview.rows.length }}</strong></span>
        <span><small>并发</small><strong>{{ form.concurrency }}</strong></span>
        <span><small>画幅</small><strong>{{ form.settings.aspect_ratio }}</strong></span>
        <span><small>{{ form.kind === 'video' ? '时长' : '尺寸' }}</small><strong>{{ form.kind === 'video' ? form.settings.duration + ' 秒' : (defaultImageSize || form.settings.size || '模型默认') }}</strong></span>
        <span><small>预估费用</small><strong :class="estimateClass">{{ estimateText }}</strong></span>
        <span><small>任务名</small><strong>{{ form.title || '未命名批次' }}</strong></span>
      </div>
      <div class="preview-list">
        <article v-for="row in submitPreview.rows" :key="row.index">
          <span class="preview-index">{{ row.index }}</span>
          <div><strong>{{ row.prompt }}</strong><small>{{ row.meta }}</small></div>
        </article>
      </div>
      <p class="dialog-note">提交后：队列立刻开始按并发推进，成功和失败都会单独记账，失败项可以单独重试；已经提交到上游的请求不会被撤回，也不会因为关闭页面而丢失。</p>
      <p v-if="form.budget_usd" class="dialog-note" :class="{ 'cap-warning-inline': estimate.total > form.budget_usd }">预算提醒 {{ formatUsd(form.budget_usd) }}：{{ estimate.status === 'ok' ? (estimate.total > form.budget_usd ? '预估超过提醒值，仍可按当前参数提交。' : '预估未超过提醒值。') : '没有匹配的价格项，费用未知，仍可提交。' }}</p>
      <template #footer>
        <el-button @click="showPreview = false">回去改参数</el-button>
        <el-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="confirmSubmit">{{ submitPreview.fresh ? '直接新建一次' : '确认提交这 ' + submitPreview.rows.length + ' 条' }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="showAttempts" title="这一项的历史尝试" width="min(760px, 94vw)">
      <p class="dialog-note">每一次重新尝试都会单独留档：当时的提示词、模型、状态和错误都不会被下一次覆盖。当前是第 {{ attemptTarget?.attempt || 0 }} 次尝试。</p>
      <div class="preview-list attempt-list">
        <article v-for="record in attemptRecords" :key="record.key">
          <span class="preview-index">#{{ record.attempt }}</span>
          <div>
            <strong>{{ record.prompt }}</strong>
            <small>{{ record.meta }}</small>
          </div>
        </article>
      </div>
      <template #footer><el-button @click="showAttempts = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowRight, CopyDocument, EditPen, FolderOpened, MagicStick, VideoPlay, Warning } from '@element-plus/icons-vue'
import { useLiveRefresh } from '@/composables/useLiveRefresh'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'
import mediaBatchAPI from '@/api/mediaBatch'
import { artifactMediaUrl } from '@/utils/mediaUrl'
import { batchItemCanRetry, batchItemNeedsReview, batchSubmission } from '@/utils/batchRequestKey'
import { aiAPI } from '@/api/ai'
import { advancedSettingsAPI } from '@/api/advancedSettings'
import { batchModelOptions, batchModelSelection } from '@/utils/batchModels'
import { imageRatios, imageTiers, imageSizeFor, imageSizeSubmissionNote, usesImageSizePresets } from '@/utils/imageSizes'
import { findDurationInfo, videoDurationHint } from '@/utils/videoDurations'
import ManualBatchEditor from '@/components/ManualBatchEditor.vue'

const savedConcurrency = Number(localStorage.getItem('yinzi-batch-concurrency') || 8)
const route = useRoute()
const selectedBatchId = ref(String(route.query.batch || ''))
let selectionRead = 0
let modelRead = 0
const form = reactive({ kind: 'image', prompt: '', lines: '', count: 8, concurrency: Number.isSafeInteger(savedConcurrency) && savedConcurrency >= 1 ? savedConcurrency : 8, model: '', title: '', adaptive: localStorage.getItem('yinzi-batch-adaptive') === 'true', slowdown_ratio: 2.5, min_observation_seconds: 30, budget_usd: undefined, settings: { aspect_ratio: '16:9', image_tier: '2K', size: '', duration: 5 } })
const retrying = reactive(new Set());
const editorMode = ref('manual')
const manualState = ref({ items: [], count: 1, valid: false })
try {
  const saved = JSON.parse(localStorage.getItem('yinzi-batch-form-v1') || 'null')
  if (saved?.form) { Object.assign(form, saved.form); form.settings = { aspect_ratio: '16:9', image_tier: '2K', size: '', duration: 5, ...saved.form.settings } }
  if (saved?.mode === 'quick') editorMode.value = 'quick'
} catch {}
watch([form, editorMode], () => { try { localStorage.setItem('yinzi-batch-form-v1', JSON.stringify({ form, mode: editorMode.value })) } catch {} }, { deep: true })
const pendingSubmission = ref(null)
try { pendingSubmission.value = JSON.parse(sessionStorage.getItem('yinzi-pending-batch-submit') || 'null') } catch {}
const batches = ref([]); const activeBatch = ref(null); const loading = ref(false); const submitting = ref(false); const submitError = ref(''); const error = ref(''); const broken = ref(new Set()); const modelOptions = ref([]); const itemPage = ref(1); const itemPageSize = 50; const itemFilter = ref('all'); const itemSort = ref('ordinal'); const itemDirection = ref('asc'); const batchFilter = ref('all'); const batchSort = ref('updated'); const prices = ref([]); const priceState = ref('loading'); const showPreview = ref(false); const previewFresh = ref(false); const showAttempts = ref(false); const attemptTarget = ref(null); let timer = null
try {
  const savedQueue = JSON.parse(localStorage.getItem('yinzi-batch-queue-view-v1') || 'null')
  if (savedQueue) { if (typeof savedQueue.itemFilter === 'string') itemFilter.value = savedQueue.itemFilter; if (typeof savedQueue.itemSort === 'string') itemSort.value = savedQueue.itemSort; if (typeof savedQueue.itemDirection === 'string') itemDirection.value = savedQueue.itemDirection }
} catch {}
watch([itemFilter, itemSort, itemDirection], () => { try { localStorage.setItem('yinzi-batch-queue-view-v1', JSON.stringify({ itemFilter: itemFilter.value, itemSort: itemSort.value, itemDirection: itemDirection.value })) } catch {} })
const plannedCount = computed(() => { if (editorMode.value === 'manual') return manualState.value.count; const lines = form.lines.split(/\r?\n/).map(v => v.trim()).filter(Boolean); return lines.length || Number(form.count) || 1 })
const canSubmit = computed(() => (editorMode.value === 'manual' ? manualState.value.valid : Boolean(form.prompt.trim() || form.lines.trim())) && plannedCount.value > 0 && Number.isSafeInteger(form.concurrency) && form.concurrency >= 1)
const batchPercent = computed(() => { if (!activeBatch.value?.total) return null; return Math.round((activeBatch.value.completed + activeBatch.value.failed + activeBatch.value.needs_review) / activeBatch.value.total * 100) })
const modelService = computed(() => form.kind === 'video' ? 'video' : 'image')
const defaultImageModel = computed(() => batchModelSelection(form.model, modelOptions.value, 'image').model)
const defaultImagePreset = computed(() => usesImageSizePresets(defaultImageModel.value))
const defaultImageSize = computed(() => imageSizeFor(defaultImageModel.value, form.settings.aspect_ratio, form.settings.image_tier, form.settings.size))

/* ── 时长提示：只读模型能力，不阻止提交；读不到就不显示 ── */
const durationCapabilities = ref({})
const defaultVideoSelection = computed(() => form.kind === 'video' ? batchModelSelection(form.model, modelOptions.value, 'video') : {})
const durationHint = computed(() => {
  const selection = defaultVideoSelection.value
  if (form.kind !== 'video' || !selection.video_config_id) return null
  return videoDurationHint(findDurationInfo(durationCapabilities.value[selection.video_config_id], selection.model), form.settings.duration, selection.model)
})
async function loadDurationCapabilities(id) {
  if (!id || durationCapabilities.value[id]) return
  durationCapabilities.value = { ...durationCapabilities.value, [id]: [] }
  try {
    const result = await aiAPI.getModelCapabilities(id, { suppressGlobalError: true })
    durationCapabilities.value = { ...durationCapabilities.value, [id]: Array.isArray(result?.models) ? result.models : [] }
  } catch (_) {}
}
watch(() => defaultVideoSelection.value.video_config_id, id => loadDurationCapabilities(id), { immediate: true })

/* ── 队列项的筛选与排序：只作用于当前这一页（服务端按页返回） ── */
const itemStatusRank = { running: 0, processing: 1, submitting: 2, queued: 3, needs_review: 4, failed: 5, paused: 6, completed: 7 }
const visibleItems = computed(() => {
  const rows = Array.isArray(activeBatch.value?.items) ? [...activeBatch.value.items] : []
  const keep = (item) => {
    if (itemFilter.value === 'all') return true
    if (itemFilter.value === 'open') return !['completed'].includes(item.status)
    return item.status === itemFilter.value
  }
  const direction = itemDirection.value === 'asc' ? 1 : -1
  return rows.filter(keep).sort((a, b) => {
    if (itemSort.value === 'status') return ((itemStatusRank[a.status] ?? 9) - (itemStatusRank[b.status] ?? 9)) * direction
    if (itemSort.value === 'attempt') return ((Number(a.attempt) || 0) - (Number(b.attempt) || 0)) * direction
    return (a.ordinal - b.ordinal) * direction
  })
})
function filterLabel(value) { return ({ all: '全部状态', open: '未完成', queued: '等待提交', processing: '上游处理中', completed: '已完成', failed: '失败', needs_review: '待核对' })[value] || '全部状态' }
const visibleBatches = computed(() => {
  const keep = (batch) => {
    if (batchFilter.value === 'all') return true
    if (batchFilter.value === 'active') return ['running', 'queued'].includes(batch.status)
    if (batchFilter.value === 'completed') return batch.status === 'completed'
    if (batchFilter.value === 'failed') return batch.status === 'failed' || Number(batch.failed) > 0
    if (batchFilter.value === 'paused') return batch.status === 'paused'
    return true
  }
  return batches.value.filter(keep).slice().sort((a, b) => {
    if (batchSort.value === 'percent') return (batchPercent(b) || 0) - (batchPercent(a) || 0)
    if (batchSort.value === 'total') return (Number(b.total) || 0) - (Number(a.total) || 0)
    return new Date(b.updated_at || 0) - new Date(a.updated_at || 0)
  })
})

/* ── 费用预估：只用本机价格表里已经存在的价格项，读不到就明说读不到 ── */
function formatUsd(value) { return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : '—' }
const priceSourceNote = computed(() => {
  if (priceState.value === 'loading') return '正在读取本机模型价格表…'
  if (priceState.value === 'error') return '价格表读取失败，本次不做预估'
  if (!prices.value.length) return '本机价格表还是空的，本次不做预估'
  return `本机价格表 ${prices.value.length} 条可用价格项`
})
function selectionFor(kind, modelValue) { return batchModelSelection(modelValue, modelOptions.value, kind) }
function priceFor(kind, selection) {
  const serviceType = kind === 'video' ? 'video' : 'image'
  const model = String(selection.model || '').trim()
  if (!model) return null
  const provider = String(selection.provider || '').trim().toLowerCase()
  const candidates = prices.value.filter(row => row.enabled !== false && String(row.service_type) === serviceType && String(row.model).trim() === model)
  return candidates.find(row => provider && String(row.provider).toLowerCase() === provider)
    || candidates.find(row => /yinzi/i.test(String(row.provider))) || candidates[0] || null
}
function unitEstimate(price, usage = {}) {
  if (!price) return null
  const unit = String(price.billing_unit || '')
  const unitPrice = Number(price.unit_price_usd)
  if (unit === 'per_1k_tokens') return null
  if (!Number.isFinite(unitPrice)) return null
  if (unit === 'per_second') return unitPrice * Math.max(1, Number(usage.seconds) || 0)
  if (unit === 'per_character') return unitPrice * Math.max(1, Number(usage.characters) || 0)
  if (['per_request', 'per_image'].includes(unit)) return unitPrice
  return null
}
const submitPreviewRows = computed(() => {
  const kind = form.kind
  if (editorMode.value === 'manual') {
    return (manualState.value.items || []).map((item, index) => {
      const selection = selectionFor(kind, item.model)
      const price = priceFor(kind, selection)
      const unit = unitEstimate(price, { seconds: item.duration ?? form.settings.duration, characters: (item.prompt || '').length })
      return { index: index + 1, prompt: item.prompt || '（没有填写提示词，仅用参考素材生成）', unit, price, meta: [selection.model || '系统默认模型', item.aspect_ratio || form.settings.aspect_ratio, kind === 'video' ? `${item.duration ?? form.settings.duration} 秒` : (item.size || defaultImageSize.value || '模型默认尺寸'), price ? `${price.billing_unit} ${formatUsd(unit)}` : '价格表里没有这一项'].filter(Boolean).join(' · ') }
    })
  }
  const lines = form.lines.split(/\r?\n/).map(v => v.trim()).filter(Boolean)
  const count = lines.length || Number(form.count) || 1
  const selection = selectionFor(kind, form.model)
  const price = priceFor(kind, selection)
  const prompts = Array.from({ length: count }, (_, index) => lines[index] || `${form.prompt.trim()}（变体 ${index + 1}）`)
  const unit = unitEstimate(price, { seconds: form.settings.duration, characters: form.prompt.length })
  return prompts.map((prompt, index) => ({ index: index + 1, prompt, unit, price, meta: [selection.model || '系统默认模型', form.settings.aspect_ratio, kind === 'video' ? `${form.settings.duration} 秒` : (defaultImageSize.value || form.settings.size || '模型默认尺寸'), price ? `${price.billing_unit} ${formatUsd(unit)}` : '价格表里没有这一项'].filter(Boolean).join(' · ') }))
})
const estimate = computed(() => {
  const rows = submitPreviewRows.value
  let total = 0
  let priced = 0
  let missing = 0
  for (const row of rows) { if (Number.isFinite(row.unit)) { total += row.unit; priced += 1 } else missing += 1 }
  return { total, priced, missing, status: priced ? 'ok' : 'unknown' }
})
const estimateText = computed(() => estimate.value.status === 'ok'
  ? `约 ${formatUsd(estimate.value.total)}${estimate.value.missing ? ` · ${estimate.value.missing} 项无价格` : ''}`
  : '预估不可用')
const estimateClass = computed(() => estimate.value.status !== 'ok' ? 'unknown' : estimate.value.missing ? 'partial' : 'ok')
const budgetExceeded = computed(() => Boolean(form.budget_usd) && estimate.value.status === 'ok' && estimate.value.total > Number(form.budget_usd))
const submitPreview = computed(() => ({ rows: submitPreviewRows.value, fresh: previewFresh.value }))

/* ── 数据读写 ── */
function saveExploration(value) { localStorage.setItem('yinzi-batch-adaptive', String(value)) }
function explorationLabel(value = {}) { if (value.mode !== 'adaptive') return '固定并发'; return ({ latency_tail: '观察到长尾，保持当前并发', rate_limited: '观察到限流，停止扩容', result_requires_review: '有失败或待核对项，停止扩容', cohort_missing: '探索记录待核对，保持并发', configured_limit: '已达到设置上限' })[value.reason] || '整轮成功后逐步增加' }
function saveConcurrency(value) { const n = Number(value); if (Number.isSafeInteger(n) && n >= 1) localStorage.setItem('yinzi-batch-concurrency', String(n)) }
async function loadModels() {
  const read = ++modelRead
  modelOptions.value = []
  try {
    const result = await aiAPI.list(modelService.value)
    if (read === modelRead) modelOptions.value = batchModelOptions(Array.isArray(result?.items) ? result.items : Array.isArray(result) ? result : [])
  } catch (_) { if (read === modelRead) modelOptions.value = [] }
}
async function loadPrices() {
  priceState.value = 'loading'
  try {
    const result = await advancedSettingsAPI.listPrices({})
    prices.value = (Array.isArray(result?.items) ? result.items : []).filter(row => row?.enabled !== false)
    priceState.value = 'ok'
  } catch (_) { prices.value = []; priceState.value = 'error' }
}
async function refresh() { loading.value = true; error.value = ''; try { const result = await mediaBatchAPI.list({ limit: 30 }); batches.value = result?.items || []; const target = selectedBatchId.value || batches.value[0]?.id; if (target) await selectBatch(target, false, false) } catch (e) { error.value = e?.message || '暂时无法读取批量队列' } finally { loading.value = false } }
async function selectBatch(id, reload = true, resetPage = true) { selectedBatchId.value = String(id); const read = ++selectionRead; try { if (resetPage) itemPage.value = 1; const item = await mediaBatchAPI.get(id, { item_page: itemPage.value, item_page_size: itemPageSize }); if (read !== selectionRead || selectedBatchId.value !== String(id)) return; if (item) activeBatch.value = item; if (reload) { const result = await mediaBatchAPI.list({ limit: 30 }); batches.value = result?.items || [] } } catch (e) { if (read === selectionRead) error.value = e?.message || '暂时无法读取所选批次' } }
async function loadItemPage() { if (activeBatch.value?.id) await selectBatch(activeBatch.value.id, false, false) }

function openPreview(fresh = false) { previewFresh.value = fresh === true; showPreview.value = true }
function confirmSubmit() { return createBatch(previewFresh.value) }

async function createBatch(fresh = false) { if (submitting.value || !canSubmit.value) return; submitting.value = true; submitError.value = ''; try { const lines = form.lines.split(/\r?\n/).map(v => v.trim()).filter(Boolean); const count = lines.length || Number(form.count); const selection = batchModelSelection(form.model, modelOptions.value, form.kind); const imageSize = form.kind === 'image' ? imageSizeFor(selection.model, form.settings.aspect_ratio, form.settings.image_tier, form.settings.size) : ''; const items = editorMode.value === 'manual' ? manualState.value.items : Array.from({ length: count }, (_, index) => ({ prompt: lines[index] || (form.prompt.trim() + '（变体 ' + (index + 1) + '）'), ...selection, aspect_ratio: form.settings.aspect_ratio, ...(imageSize ? { size: imageSize } : {}), ...(form.kind === 'video' ? { duration: form.settings.duration } : {}) })); const sharedSettings = editorMode.value === 'manual' ? {} : { ...selection, aspect_ratio: form.settings.aspect_ratio, ...(imageSize ? { size: imageSize } : {}), ...(form.kind === 'video' ? { duration: form.settings.duration } : {}) }; const payload = { kind: form.kind, title: form.title || undefined, prompt: editorMode.value === 'manual' ? '' : form.prompt.trim(), model: selection.model, concurrency: Number(form.concurrency), exploration: { mode: form.adaptive ? 'adaptive' : 'fixed', slowdown_ratio: form.slowdown_ratio, min_observation_ms: form.min_observation_seconds * 1000 }, settings: sharedSettings, items }; pendingSubmission.value = batchSubmission(payload, fresh === true ? null : pendingSubmission.value); try { sessionStorage.setItem('yinzi-pending-batch-submit', JSON.stringify(pendingSubmission.value)) } catch {} const result = await mediaBatchAPI.create({ ...payload, idempotency_key: pendingSubmission.value.key }); pendingSubmission.value = null; try { sessionStorage.removeItem('yinzi-pending-batch-submit') } catch {} ++selectionRead; activeBatch.value = result; selectedBatchId.value = String(result.id); itemPage.value = 1; showPreview.value = false; await refresh(); ElMessage.success(result?.reused ? '已恢复同一批次，没有重复提交' : '批量任务已创建，队列开始推进') } catch (e) { submitError.value = e?.message || '创建批量任务失败' } finally { submitting.value = false } }
async function recoverSubmission() {
  if (submitting.value || !pendingSubmission.value) return
  submitting.value = true; submitError.value = ''
  try {
    const pending = pendingSubmission.value
    const payload = JSON.parse(pending.signature)
    const result = await mediaBatchAPI.create({ ...payload, idempotency_key: pending.key })
    pendingSubmission.value = null
    try { sessionStorage.removeItem('yinzi-pending-batch-submit') } catch {}
    ++selectionRead; activeBatch.value = result; selectedBatchId.value = String(result.id); itemPage.value = 1
    await refresh(); ElMessage.success('已恢复上次提交，原素材和参数保持不变')
  } catch (e) { submitError.value = e?.message || '暂未收到原请求回执，可继续恢复' }
  finally { submitting.value = false }
}
async function updateBatch(action, message) {
  const id = activeBatch.value?.id
  if (!id) return
  const read = ++selectionRead
  try {
    const result = await action(id)
    if (read === selectionRead && selectedBatchId.value === String(id)) activeBatch.value = result
    ElMessage.success(message)
  } catch (e) { ElMessage.error(e?.message || '批次操作暂未完成，请刷新查看') }
}
function pause() { return updateBatch(id => mediaBatchAPI.pause(id), '已暂停后续提交，正在运行的项目会自然收口') }
async function resume() {
  const remaining = Number(activeBatch.value?.queued || 0)
  try {
    await ElMessageBox.confirm(
      `继续后会按并发 ${activeBatch.value?.effective_concurrency || activeBatch.value?.concurrency || 1} 接着提交队列里剩下的 ${remaining} 项，这些项目会真实调用上游模型并产生费用。已经完成的 ${activeBatch.value?.completed || 0} 项不会重做。`,
      '继续提交会继续花钱', { confirmButtonText: '继续提交', cancelButtonText: '先不继续', type: 'warning' },
    )
  } catch { return }
  return updateBatch(id => mediaBatchAPI.resume(id), '已继续提交')
}
async function retry(item) {
  if (retrying.has(item.id)) return
  const price = priceFor(activeBatch.value?.kind || form.kind, { model: item.request?.model || activeBatch.value?.model, provider: item.request?.provider })
  const unit = unitEstimate(price, { seconds: item.request?.duration, characters: (item.request?.prompt || '').length })
  try {
    await ElMessageBox.confirm(
      `第 ${item.ordinal + 1} 项（${item.request?.prompt || '未记录提示词'}）会重新提交上游模型并重新计费${Number.isFinite(unit) ? `，按价格表约 ${formatUsd(unit)}` : '（价格表里没有这一项，金额未知）'}。原来的结果和费用记录都会保留，这一次算新的一次尝试${item.attempt ? `（当前是第 ${item.attempt} 次）` : ''}。`,
      '重新尝试这一项', { confirmButtonText: '重新提交', cancelButtonText: '取消', type: 'warning' },
    )
  } catch { return }
  retrying.add(item.id)
  try { await updateBatch(id => mediaBatchAPI.retry(id, item.id, {expected_attempt:item.attempt,request_key:`retry:${id}:${item.id}:${item.attempt}`}), '已处理重试请求') }
  finally { retrying.delete(item.id) }
}
function referenceSummary(r) { const n = (r.reference_image_urls || []).length + Number(Boolean(r.first_frame_url)) + Number(Boolean(r.last_frame_url)); return [r.model, n ? n + ' 图' : '', r.reference_video_urls?.length ? r.reference_video_urls.length + ' 视频' : '', r.reference_audio_urls?.length ? r.reference_audio_urls.length + ' 音频' : ''].filter(Boolean).join(' · ') }
function shortId(value) { return String(value || '').slice(0, 8) }
function attemptHistory(item) { return Array.isArray(item?.previous_attempts) ? item.previous_attempts : [] }
const attemptRecords = computed(() => {
  const item = attemptTarget.value
  if (!item) return []
  const rows = attemptHistory(item).map((record, index) => ({ key: `past-${index}`, attempt: record.attempt ?? index + 1, prompt: record.request?.prompt || '（没有记录当时的提示词）', meta: [itemStatusLabel(record.status), record.error_message || '', record.updated_at ? new Date(record.updated_at).toLocaleString('zh-CN', { hour12: false }) : '时间未知'].filter(Boolean).join(' · ') }))
  rows.push({ key: 'current', attempt: item.attempt || rows.length + 1, prompt: item.request?.prompt || '（没有记录提示词）', meta: [`当前 · ${itemStatusLabel(item.status)}`, item.error_message || '', item.updated_at ? new Date(item.updated_at).toLocaleString('zh-CN', { hour12: false }) : '时间未知'].filter(Boolean).join(' · ') })
  return rows
})
function openAttempts(item) { attemptTarget.value = item; showAttempts.value = true }
function markBroken(id) { broken.value = new Set([...broken.value, id]) }
function artifactMediaUrlItem(item) { return artifactMediaUrl({ media_url: item.media_url }) }
function itemStatusLabel(status) { return ({ queued: '等待提交', submitting: '正在提交', processing: '上游处理中', completed: '已完成', failed: '确定失败', needs_review: '等待核对', paused: '已暂停' })[status] || '处理中' }
function batchStatusLabel(status) { return ({ queued: '准备中', running: '执行中', paused: '已暂停', completed: '已完成', partial: '部分完成', failed: '全部失败', needs_review: '有结果待核对' })[status] || '处理中' }
function batchTone(status) { return status === 'completed' ? 'success' : status === 'failed' ? 'danger' : ['paused','partial','needs_review'].includes(status) ? 'warning' : 'active' }
onMounted(() => { loadModels(); loadPrices() })
watch(() => route.query.batch, value => { if (value) selectBatch(String(value), false) })
useLiveRefresh(refresh, { active: () => Boolean(activeBatch.value && ['running','queued'].includes(activeBatch.value.status)), failed: () => Boolean(error.value) })
watch(() => form.kind, () => { form.model = ''; loadModels() })
onBeforeUnmount(() => { ++modelRead; ++selectionRead; if (timer) window.clearInterval(timer) })
useWorkbenchPage({ refresh: refresh, error: () => error.value, loading: () => loading.value })
</script>

<style scoped>
.editor-modes{display:flex;margin:0 0 14px;flex-wrap:wrap}
.batch-page{display:grid;gap:16px}
.batch-hero{display:flex;justify-content:space-between;gap:22px;align-items:flex-start;padding:22px 24px;border:1px solid var(--border-color);background:var(--bg-card)}
.kicker{display:block;color:var(--text-subtle);font-size:12px}
.batch-hero h2{margin:8px 0;font-family:var(--font-display);font-size:26px;font-weight:600;color:var(--text-bright)}
.batch-hero p{max-width:800px;margin:0;color:var(--text-muted);font-size:13px;line-height:1.75}
.batch-hero-stat{min-width:150px;padding:10px 0 10px 16px;border-left:1px solid var(--border-color);text-align:right}
.batch-hero-stat strong,.batch-hero-stat span{display:block}
.batch-hero-stat strong{color:var(--text-primary);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:26px;font-weight:500}
.batch-hero-stat span{margin-top:4px;color:var(--text-subtle);font-size:12px}
.source-paths{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border:1px solid var(--border-color);background:var(--bg-card)}
.source-paths>div,.source-paths>a{min-width:0;display:flex;align-items:center;gap:11px;padding:13px 15px;background:var(--bg-card);color:inherit;text-decoration:none}
.source-paths>a{border-left:1px solid var(--border-color)}
.source-paths>a:hover{background:var(--bg-hover)}
.source-paths>*>span:nth-child(2){min-width:0;flex:1}
.source-paths strong,.source-paths small{display:block}
.source-paths strong{color:var(--text-primary);font-size:12px}
.source-paths small{margin-top:4px;color:var(--text-muted);font-size:11px;line-height:1.45}
.path-icon{width:30px;height:30px;flex:0 0 30px;display:grid;place-items:center;color:var(--ui-accent);background:var(--bg-inner);border:1px solid var(--border-color)}
.batch-grid{display:grid;grid-template-columns:minmax(360px,.85fr) minmax(0,1.15fr);gap:16px;align-items:start}
.panel{min-width:0;border:1px solid var(--border-color);background:var(--bg-card)}
.setup-panel,.queue-panel,.history-panel{padding:18px 20px}
.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:16px}
.panel-heading h3{margin:5px 0 0;font-size:16px;color:var(--text-primary)}
.hint,.field-note{color:var(--text-muted);font-size:12px;line-height:1.55}
.field-label{display:block;margin:15px 0 7px;color:var(--text-primary);font-size:12px}
.full{width:100%}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:11px}
.advanced-box{margin-top:15px;padding:12px;border:1px solid var(--border-color);background:var(--bg-inner)}
.advanced-title{color:var(--text-primary);font-size:12px}
.advanced-title small{margin-left:6px;color:var(--text-subtle);font-size:11px}
.budget-box .field-note{margin:10px 0 0}
.estimate{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin:16px 0;padding-top:12px;border-top:1px solid var(--border-color)}
.estimate>div{display:grid;gap:3px;color:var(--text-muted);font-size:12px}
.estimate>div:last-child{text-align:right;justify-items:end}
.estimate-value{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:15px}
.estimate-value.ok{color:var(--text-primary)}
.estimate-value.partial{color:var(--ui-warning)}
.estimate-value.unknown{color:var(--text-subtle)}
.cap-warning{margin:0 0 12px;padding:9px 11px;border:1px solid var(--ui-warning);color:var(--ui-warning);font-size:12px;line-height:1.55}
.cap-warning-inline{color:var(--ui-warning)}
.duration-hint{margin-top:4px}
.duration-hint.warning{color:var(--ui-warning)}
.setup-panel>.el-button{width:100%;height:44px}
.submit-note{margin:8px 0 0;text-align:center}
.inline-error{color:var(--ui-danger);font-size:12px}
.pending-submission-note{margin-top:12px;padding:11px;border:1px solid var(--border-color);background:var(--bg-inner)}
.queue-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
.queue-summary{display:grid;gap:10px;padding:14px 0;border-top:1px solid var(--border-color);border-bottom:1px solid var(--border-color)}
.queue-summary>div:first-child{display:flex;align-items:baseline;justify-content:space-between}
.queue-summary strong{color:var(--text-primary);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:20px;font-weight:500}
.queue-summary span{margin-left:8px;color:var(--text-muted);font-size:12px}
.counts{display:flex;gap:12px;flex-wrap:wrap;color:var(--text-muted);font-size:12px}
.counts .review-count{color:var(--ui-warning)}
.review-note{display:flex;gap:10px;align-items:flex-start;margin-top:11px;padding:10px 12px;border:1px solid var(--border-color);background:var(--bg-inner);color:var(--ui-warning)}
.review-note>span{display:block}
.review-note strong,.review-note small{display:block}
.review-note strong{font-size:12px}
.review-note small{margin-top:4px;color:var(--ui-warning);font-size:11px;line-height:1.45}
.item-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 4px}
.item-toolbar .el-select{width:auto;min-width:112px}
.toolbar-note{color:var(--text-subtle);font-size:11px;margin-left:auto}
.item-list{display:grid;max-height:520px;overflow:auto}
.queue-item{display:grid;grid-template-columns:28px minmax(0,1fr) 82px auto;gap:9px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border-color)}
.item-index{width:24px;height:24px;display:grid;place-items:center;border:1px solid var(--border-color);color:var(--text-subtle);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:11px}
.item-main{min-width:0}
.item-main strong,.item-main small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item-main strong{color:var(--text-primary);font-size:12px}
.item-main small{margin-top:4px;color:var(--text-muted);font-size:11px}
.item-main .item-id{color:var(--text-faint);font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.item-main .item-error{color:var(--ui-danger)}
.item-main .item-error.review{color:var(--ui-warning)}
.item-preview{width:82px;height:52px;display:grid;place-items:center;overflow:hidden;border:1px solid var(--border-color);background:var(--bg-inner)}
.item-preview img,.item-preview video{width:100%;height:100%;object-fit:cover}
.item-preview span{color:var(--text-subtle)}
.item-actions{display:flex;align-items:center;gap:5px;font-size:12px}
.item-actions a{color:var(--ui-accent);text-decoration:none}
.reconcile-label{color:var(--ui-warning);white-space:nowrap}
.item-empty{padding:22px 4px;color:var(--text-muted);font-size:12px;text-align:center}
.item-capability-note{margin:10px 0 0;padding-top:9px;border-top:1px solid var(--border-color);color:var(--text-faint);font-size:11px;line-height:1.6}
.item-pagination{justify-content:center;margin-top:14px}
.queue-empty{display:grid;justify-items:center;gap:8px;padding:64px 20px;color:var(--text-muted);text-align:center}
.queue-empty .el-icon{font-size:32px;color:var(--text-subtle)}
.queue-empty strong{color:var(--text-primary);font-size:13px}
.queue-empty p{margin:0;font-size:12px}
.queue-empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:6px}
.history-panel{padding-bottom:16px}
.history-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.history-actions .el-select{width:auto;min-width:104px}
.history-actions a{display:inline-flex;align-items:center;gap:3px;color:var(--ui-accent);font-size:12px;text-decoration:none}
.batch-history{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.batch-history button{display:flex;justify-content:space-between;align-items:center;gap:10px;min-width:0;padding:12px;border:1px solid var(--border-color);background:var(--bg-inner);color:inherit;text-align:left;cursor:pointer}
.batch-history button:hover{background:var(--bg-hover)}
.batch-history button.active{border-color:var(--border-bright);background:var(--bg-hover)}
.batch-history button>span{min-width:0}
.batch-history strong,.batch-history small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.batch-history strong{color:var(--text-primary);font-size:12px}
.batch-history small{margin-top:5px;color:var(--text-muted);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:11px}
.batch-history em{font-style:normal;font-size:11px;white-space:nowrap}
.success{color:var(--ui-success)}
.danger{color:var(--ui-danger)}
.warning{color:var(--ui-warning)}
.active{color:var(--ui-warning)}
.empty-note{padding:18px 0;color:var(--text-muted);font-size:12px}
.dialog-note{color:var(--text-muted);font-size:12px;line-height:1.7}
.preview-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--border-color);background:var(--bg-inner);margin:12px 0}
.preview-summary>span{display:grid;gap:4px;padding:10px 12px;border-right:1px solid var(--border-color);border-bottom:1px solid var(--border-color);min-width:0}
.preview-summary small{color:var(--text-subtle);font-size:11px}
.preview-summary strong{color:var(--text-primary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview-list{display:grid;max-height:38vh;overflow:auto;border:1px solid var(--border-color)}
.preview-list article{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;padding:9px 11px;border-bottom:1px solid var(--border-color);align-items:baseline}
.preview-list article:last-child{border-bottom:0}
.preview-index{color:var(--text-faint);font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:11px}
.preview-list strong{display:block;color:var(--text-primary);font-size:12px;font-weight:500;overflow-wrap:anywhere}
.preview-list small{display:block;margin-top:4px;color:var(--text-subtle);font-size:11px}
.attempt-list{max-height:52vh}
.attempt-list article:last-child strong{color:var(--text-bright)}
@media(max-width:1050px){.batch-grid{grid-template-columns:1fr}.batch-history{grid-template-columns:1fr 1fr}.source-paths{grid-template-columns:1fr}.source-paths>a{border-left:0;border-top:1px solid var(--border-color)}.preview-summary{grid-template-columns:1fr 1fr}}
@media(max-width:640px){.batch-hero{flex-direction:column;padding:18px}.batch-hero-stat{width:100%;border-left:0;border-top:1px solid var(--border-color);padding:10px 0 0;text-align:left}.form-row{grid-template-columns:1fr}.queue-item{grid-template-columns:25px minmax(0,1fr) 64px}.item-preview{width:64px;height:44px}.item-actions{grid-column:2 / -1;justify-content:flex-end}.batch-history{grid-template-columns:1fr}.preview-summary{grid-template-columns:1fr}}
</style>
