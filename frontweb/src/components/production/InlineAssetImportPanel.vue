<template>
  <section class="inline-import" :class="{ 'is-open': open }" aria-labelledby="inline-import-title">
    <div class="inline-import-head">
      <div>
        <span class="section-kicker">可选素材</span>
        <h3 id="inline-import-title">把已有图片、视频或文档交给 AI 整理</h3>
        <p>{{ targetRunMode ? '素材先进入暂存区；确认“应用到当前任务”后才会加入本次制作，不会撤回已确认内容。' : '素材只会先放在暂存区。你可以继续写故事，确认生成剧本时才会正式放入任务。' }}</p>
      </div>
      <el-button text :icon="open ? ArrowUp : ArrowDown" @click="open = !open">
        {{ open ? '收起素材区' : files.length || session ? '展开素材区' : '添加素材' }}
      </el-button>
    </div>

    <template v-if="open">
      <div class="picker-row" :class="{ 'is-dragging': dragActive }" @dragover.prevent="onDragOver" @dragleave.prevent="onDragLeave" @drop.prevent="onDrop">
        <el-button :icon="Upload" :disabled="busy" @click="fileInput?.click()">选择文件（可多选）</el-button>
        <el-button :icon="FolderOpened" :disabled="busy" @click="folderInput?.click()">选择文件夹</el-button>
        <el-button v-if="files.length" text type="danger" :disabled="busy" @click="clearFiles">清空选择</el-button>
        <span class="drop-hint">也可以把文件拖到这里</span>
        <input ref="fileInput" type="file" multiple hidden @change="onFiles" />
        <input ref="folderInput" type="file" webkitdirectory directory multiple hidden @change="onFiles" />
      </div>
      <p class="hint">支持 txt、md、docx、pdf、json、csv、图片、视频和音频；可以混合选择，确认前不会写入项目。</p>

        <div v-if="files.length" class="selection-summary" aria-live="polite">
        <strong>已选择 {{ files.length }} 个文件</strong>
        <span>总大小 {{ formatBytes(totalBytes) }}</span>
        <el-switch v-model="useAi" :disabled="busy" active-text="AI 理解素材" inactive-text="仅本地规则" />
          <el-button type="primary" plain :loading="busy" @click="analyze">{{ session ? '重新分析' : '上传并分析' }}</el-button>
          <el-button v-if="targetRunMode && session?.status === 'planned'" type="primary" :loading="applying" @click="applyCurrentRun">应用到当前任务</el-button>
      </div>

      <div v-if="files.length" class="selected-files">
        <div v-for="item in files" :key="item.key" class="selected-file">
          <span class="file-kind">{{ fileKind(item.file) }}</span>
          <span class="file-name" :title="item.relative_path">{{ item.relative_path }}</span>
          <span class="file-size">{{ formatBytes(item.file.size) }}</span>
          <el-tag v-if="item.source_token" size="small" type="success">已上传</el-tag>
          <el-button text circle type="danger" :disabled="busy" aria-label="移除文件" @click="removeFile(item.key)">×</el-button>
        </div>
      </div>

      <div v-if="phase !== 'idle'" class="progress-panel" :class="`is-${phase}`" role="status" aria-live="polite">
        <div class="progress-head"><strong>{{ phaseLabel }}</strong><span v-if="phase === 'uploading' && progress != null">{{ progress }}%</span></div>
        <el-progress v-if="phase === 'uploading'" :percentage="progress ?? 0" :indeterminate="progress == null" :show-text="false" :duration="1.2" />
        <el-progress v-else-if="phase === 'analyzing'" :percentage="100" :indeterminate="true" :show-text="false" :duration="1.4" />
        <p>{{ phaseDetail }}</p>
        <div v-if="error" class="progress-error">{{ error }}</div>
        <div class="progress-actions">
          <el-button v-if="['uploading', 'analyzing'].includes(phase)" text type="danger" @click="cancel">取消本次访问</el-button>
          <el-button v-if="phase === 'error'" type="primary" plain @click="analyze">重试</el-button>
        </div>
      </div>

      <div v-if="plan" class="plan-summary" aria-live="polite">
        <div><strong>素材分析完成</strong><span>{{ plan.summary?.ready || 0 }} 项可用</span><span v-if="plan.summary?.partial">{{ plan.summary.partial }} 项待处理</span><span v-if="plan.summary?.failed">{{ plan.summary.failed }} 项失败</span></div>
        <small v-if="plan.ai?.used">已使用 {{ plan.ai.model || '文本模型' }} 逐项分析（{{ plan.ai.used_count || plan.summary?.total || 0 }} 项完成{{ plan.ai.failure_count ? `，${plan.ai.failure_count} 项失败` : '' }}）。{{ targetRunMode ? '确认应用后纳入当前任务。' : '点击“生成剧本”时再正式纳入任务。' }}</small>
        <small v-else-if="plan.ai?.requested">AI 分析未完成或部分失败：{{ plan.ai.failure_count || 0 }} 项失败。当前结果仅是本地规则/可用部分，请查看每个素材的来源并重试或手动调整。</small>
        <small v-else>使用本地规则整理（没有调用 AI），可在下方计划中修改。需要真正读取图片/视频内容时，请开启“AI 理解素材”。</small>
        <small v-if="targetShotRecommendation" class="setting-recommendation">
          镜头数：{{ targetShotRecommendation.value }} 个 · {{ targetShotRecommendation.reason }}
          <template v-if="targetShotRecommendation.source === 'user_setting'">（你的设置优先，AI 不会覆盖）</template>
          <template v-else-if="targetShotRecommendation.applied">（已自动填写到本页）</template>
        </small>
      </div>

      <div v-if="plan && contextStale" class="plan-stale" role="alert" aria-live="polite">
        <div>
          <strong>故事或制作设置已经变化，需要重新整理素材</strong>
          <span>{{ contextMismatchReasons.join('；') }}。文件已经上传，不会重复上传；重新整理后才会把计划纳入任务。</span>
        </div>
        <el-button type="warning" plain :loading="busy" @click="analyze">按当前内容重新整理</el-button>
      </div>

      <div v-if="executionPlan" class="execution-plan" aria-label="AI 执行计划预览">
        <div class="execution-plan-head">
          <div>
            <strong>AI 执行计划</strong>
            <span>{{ templateLabel }} · 目标 {{ executionPlan.shots?.length || targetShots }} 个镜头</span>
          </div>
          <el-tag :type="planNeedsConfirmation ? 'warning' : 'success'" size="small">
            {{ planNeedsConfirmation ? '有项目需要确认' : '可以按计划继续' }}
          </el-tag>
        </div>
        <div class="plan-stat-grid">
          <span><strong>{{ executionPlan.summary?.imported_clip_count || 0 }}</strong><small>已复用视频</small></span>
          <span><strong>{{ executionPlan.summary?.generated_shot_count || 0 }}</strong><small>待生成镜头</small></span>
          <span><strong>{{ executionPlan.summary?.unresolved_count || 0 }}</strong><small>需要确认</small></span>
          <span><strong>{{ executionPlan.summary?.scene_required ? (executionPlan.summary?.scene_available ? '已提供' : '待补齐') : '可选' }}</strong><small>场景素材</small></span>
        </div>

        <div v-if="planSubjects.length" class="plan-block">
          <h4>主体权威来源</h4>
          <div v-for="subject in planSubjects" :key="subject.id" class="plan-row subject-row">
            <span class="plan-badge">主体</span>
            <div><strong>{{ subject.name }}</strong><small>{{ subject.source_ref?.relative_path || '已上传素材' }}</small></div>
            <el-tag type="success" size="small">固定使用原图</el-tag>
          </div>
        </div>

        <div v-if="planAssets.length" class="plan-block">
          <h4>素材用途</h4>
          <div v-for="asset in planAssets" :key="asset.id" class="plan-row">
            <span class="plan-badge" :class="`is-${assetRoleTone(asset.role)}`">{{ assetRoleLabel(asset.role) }}</span>
            <div class="plan-row-main"><strong :title="asset.source_ref?.relative_path">{{ asset.file_name }}</strong><small>{{ assetStageLabel(asset.candidate_stage) }} · {{ asset.authority === 'uploaded_asset' ? '用户素材为权威来源' : '可作为参考或补充' }}</small></div>
            <el-tag v-if="asset.direct_clip_candidate && asset.shot_number" type="success" size="small">直接进入镜头 {{ asset.shot_number }}</el-tag>
            <el-tag v-else-if="asset.direct_clip_candidate" type="warning" size="small">等待指定镜头</el-tag>
          </div>
        </div>

        <div v-if="editablePlanItems.length" class="plan-block plan-corrections">
          <h4>发现 AI 判断不对？在这里直接改</h4>
          <p class="plan-corrections-help">修改后系统会重新安排主体、参考包和镜头；不会改动或覆盖原文件。</p>
          <details v-for="item in editablePlanItems" :key="`edit:${item.id || item.relative_path}`" class="plan-correction-item">
            <summary>
              <span><strong>{{ item.file_name }}</strong><small>{{ currentRoleLabel(item) }} · {{ item.status === 'excluded' ? '当前不使用' : '当前纳入计划' }}</small></span>
              <em>调整用途</em>
            </summary>
            <div class="plan-correction-grid">
              <label>
                <span>这份素材实际用来做什么</span>
                <el-select v-model="editDraft(item).usage_role" placeholder="请选择用途">
                  <el-option v-for="option in roleOptionsFor(item)" :key="option.value" :label="option.label" :value="option.value" />
                </el-select>
              </label>
              <label v-if="editDraft(item).usage_role === 'direct_clip'">
                <span>直接放到第几个镜头</span>
                <el-input-number v-model="editDraft(item).shot_number" :min="1" :max="Math.max(999, Number(targetShots) || 1)" :step="1" controls-position="right" />
              </label>
              <label class="plan-include-toggle">
                <span>是否纳入本次制作</span>
                <el-switch v-model="editDraft(item).include" active-text="使用" inactive-text="暂不使用" />
              </label>
            </div>
            <div class="plan-correction-actions">
              <span v-if="editDraft(item).usage_role === 'direct_clip'">只有明确指定镜头后，视频才会替代该镜头；参考视频不会自动进入成片。</span>
              <el-button type="primary" plain :loading="savingItemId === String(item.id)" @click="saveItemCorrection(item)">保存并重算计划</el-button>
            </div>
          </details>
        </div>

        <div v-if="planShots.length" class="plan-block">
          <h4>镜头安排</h4>
          <div v-for="shot in planShots" :key="shot.id" class="plan-row shot-row">
            <span class="shot-number">{{ shot.number }}</span>
            <div class="plan-row-main"><strong>镜头 {{ shot.number }}</strong><small>{{ shotSourceLabel(shot.source) }}<template v-if="shot.source_ref?.relative_path"> · {{ shot.source_ref.relative_path }}</template></small></div>
            <el-tag :type="shot.source === 'generate' ? 'info' : 'success'" size="small">{{ shotSourceLabel(shot.source) }}</el-tag>
          </div>
        </div>

        <div v-if="planUnresolved.length" class="plan-unresolved">
          <strong>需要你确认的项目</strong>
          <p v-for="item in planUnresolved" :key="`${item.type}:${item.asset_id}`">{{ item.file_name }}：{{ item.reason }}</p>
        </div>
        <small v-if="executionPlan.workflow?.prompt_context?.instruction" class="plan-principle">本模板原则：{{ executionPlan.workflow.prompt_context.instruction }}</small>
      </div>
    </template>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, FolderOpened, Upload } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { assetImportAPI } from '@/api/assetImport'
import { freshScanDescriptors, pendingUploadItems, restoredRelativePaths } from '@/utils/inlineAssetImport'

const props = defineProps({
  dramaId: { type: [String, Number], required: true },
  templateId: { type: String, default: '' },
  templateName: { type: String, default: '' },
  episodeId: { type: [String, Number], default: null },
  targetRunId: { type: [String, Number], default: null },
  initialSessionId: { type: [String, Number], default: null },
  userIntent: { type: String, default: '' },
  targetShots: { type: [String, Number], default: 1 },
  targetShotsUserEdited: { type: Boolean, default: false },
})
const emit = defineEmits(['planned', 'applied', 'update:session', 'context-stale'])
const open = ref(true)
const fileInput = ref(null)
const folderInput = ref(null)
const files = ref([])
const session = ref(null)
const plan = ref(null)
const analyzedItems = ref([])
const itemEdits = reactive({})
const savingItemId = ref('')
const useAi = ref(true)
const phase = ref('idle')
const progress = ref(null)
const error = ref('')
const controller = ref(null)
const dragActive = ref(false)
const busy = computed(() => ['uploading', 'analyzing'].includes(phase.value))
const totalBytes = computed(() => files.value.reduce((sum, item) => sum + (Number(item.file?.size) || 0), 0))
const executionPlan = computed(() => plan.value?.execution_plan || null)
const planSubjects = computed(() => executionPlan.value?.subjects || [])
const planAssets = computed(() => executionPlan.value?.assets || [])
const planShots = computed(() => executionPlan.value?.shots || [])
const planUnresolved = computed(() => executionPlan.value?.unresolved_items || [])
const targetShotRecommendation = computed(() => plan.value?.recommended_settings?.target_shots || null)
const planNeedsConfirmation = computed(() => planUnresolved.value.length > 0 || Boolean(executionPlan.value?.summary?.requires_confirmation))
const editablePlanItems = computed(() => analyzedItems.value.length ? analyzedItems.value : (plan.value?.items || []))
const normalizedCurrentContext = computed(() => ({
  template_id: String(props.templateId || 'free').trim() || 'free',
  user_intent: String(props.userIntent || '').trim(),
  target_shots: Math.max(1, Number(props.targetShots) || 1),
}))
const analyzedContext = computed(() => ({
  template_id: String(session.value?.options?.template_id || 'free').trim() || 'free',
  user_intent: String(session.value?.options?.user_intent || session.value?.options?.story || '').trim(),
  target_shots: Math.max(1, Number(session.value?.options?.target_shots) || 1),
}))
const contextMismatchReasons = computed(() => {
  if (!plan.value || !session.value) return []
  const reasons = []
  if (normalizedCurrentContext.value.template_id !== analyzedContext.value.template_id) reasons.push('制作模板已更换')
  if (normalizedCurrentContext.value.user_intent !== analyzedContext.value.user_intent) reasons.push('故事要求已修改')
  if (normalizedCurrentContext.value.target_shots !== analyzedContext.value.target_shots) reasons.push('目标镜头数已修改')
  return reasons
})
const contextStale = computed(() => contextMismatchReasons.value.length > 0)
const templateLabel = computed(() => props.templateName || (executionPlan.value?.template_id && executionPlan.value.template_id !== 'free' ? executionPlan.value.template_id : '自由创作'))
const targetRunMode = computed(() => Boolean(props.targetRunId))
const applying = ref(false)
const phaseLabel = computed(() => ({ uploading: '正在上传素材', analyzing: 'AI 正在逐项读取和整理', success: '素材分析完成', error: '素材处理失败', cancelled: '本次访问已取消' }[phase.value] || '准备素材'))
const phaseDetail = computed(() => {
  if (phase.value === 'uploading') return '文件会先进入当前会话的安全暂存区，上传完成后才开始分析。'
  if (phase.value === 'analyzing') return `正在分析 ${files.value.length} 个文件。此过程可能需要一点时间，页面不会跳走，你仍可继续编辑故事。`
  if (phase.value === 'success') return '计划已保存。你可以继续写故事，生成剧本时系统会把可用项一次性纳入。'
  if (phase.value === 'cancelled') return '已停止本地等待，已经上传的文件仍保留，可以点击重试。'
  return ''
})

function restoredFile(item) {
  const fileName = item?.file_name || item?.relative_path || '已上传文件'
  return {
    key: `restored:${item?.id || item?.source_token || item?.relative_path || fileName}`,
    file: { name: fileName, size: Number(item?.bytes) || 0, type: item?.mime_type || '', lastModified: item?.mtime || 0 },
    relative_path: item?.relative_path || fileName,
    source_token: item?.source_token || null,
    restored: true,
  }
}

async function restoreSession(sessionId = props.initialSessionId) {
  if (!sessionId || session.value || files.value.length) return
  try {
    const result = await assetImportAPI.get(sessionId)
    const data = result.data || result
    const restoredSession = data.session || null
    const restoredItems = Array.isArray(data.items) ? data.items : []
    if (!restoredSession) return
    // A completed session is kept as historical evidence. It is not reused for
    // new uploads because the API intentionally treats applied sessions as
    // immutable; a new session will be created when the user adds files.
    if (['applied', 'rolled_back'].includes(restoredSession.status)) {
      plan.value = restoredSession.plan || null
      // Applied sessions are immutable. Keep their plan as historical context,
      // but start a fresh draft session when the user adds new files.
      files.value = []
      session.value = null
      phase.value = plan.value ? 'success' : 'idle'
      open.value = Boolean(plan.value)
      if (plan.value) emit('planned', { session: restoredSession, plan: plan.value, restored: true, terminal: true })
      return
    }
    session.value = restoredSession
    plan.value = restoredSession.plan || data.plan || null
    analyzedItems.value = restoredItems
    files.value = restoredItems.map(restoredFile)
    phase.value = plan.value ? 'success' : 'idle'
    open.value = Boolean(files.value.length || plan.value)
    emit('update:session', session.value)
    if (plan.value) emit('planned', { session: session.value, plan: plan.value, restored: true })
  } catch (e) {
    // A missing historical session must not block ordinary story input or
    // let a stale recovery pointer surface as a fatal workflow error.
    error.value = `历史素材会话暂时无法恢复：${e.message || '请重新选择文件'}`
    phase.value = 'error'
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}
function fileKind(file) {
  const type = String(file?.type || '').toLowerCase()
  if (type.startsWith('image/')) return '图'
  if (type.startsWith('video/')) return '视'
  if (type.startsWith('audio/')) return '音'
  return '文'
}
function assetRoleLabel(role) {
  return ({ primary_subject_reference: '主体', character_reference: '角色', product_reference: '商品', scene_reference: '场景', outfit_reference: '服装', action_reference: '动作参考', reference_video: '视频参考', direct_clip: '成片视频', source_audio: '音频', source_document: '文档', style_reference: '风格', screen_reference: '界面', chart_reference: '图表', prop_reference: '道具', visual_reference: '视觉参考' }[role] || '待确认')
}
function assetRoleTone(role) {
  if (['primary_subject_reference', 'character_reference', 'product_reference'].includes(role)) return 'authority'
  if (['direct_clip', 'source_audio'].includes(role)) return 'timeline'
  if (['action_reference', 'reference_video'].includes(role)) return 'motion'
  return 'reference'
}
function assetStageLabel(stage) {
  return ({ script: '进入剧本', asset_text: '进入文本资产', asset_images: '进入资源图', storyboard_plan: '进入分镜脚本', storyboard_images: '进入分镜图', director_preview: '进入导演台预演', shot_video: '进入视频阶段', final_edit: '进入最终剪辑' }[stage] || '待安排')
}
function shotSourceLabel(source) {
  return ({ imported_clip: '已复用上传视频', reuse_asset: '复用已有资产', generate: '待生成', skip: '已跳过', unresolved: '需要确认' }[source] || '待安排')
}
const ROLE_OPTIONS = Object.freeze([
  { value: 'primary_subject_reference', label: '主体原图（身份权威）', media: 'image', stage: 'asset_images' },
  { value: 'character_reference', label: '角色参考图', media: 'image', stage: 'asset_images' },
  { value: 'product_reference', label: '商品参考图', media: 'image', stage: 'asset_images' },
  { value: 'scene_reference', label: '场景参考图', media: 'image', stage: 'asset_images' },
  { value: 'outfit_reference', label: '服装参考图', media: 'image', stage: 'asset_images' },
  { value: 'prop_reference', label: '道具参考图', media: 'image', stage: 'asset_images' },
  { value: 'style_reference', label: '画风参考图', media: 'image', stage: 'asset_images' },
  { value: 'screen_reference', label: '界面 / 录屏参考', media: 'image', stage: 'asset_images' },
  { value: 'chart_reference', label: '图表 / 事实画面', media: 'image', stage: 'asset_images' },
  { value: 'visual_reference', label: '其他视觉参考', media: 'image', stage: 'asset_images' },
  { value: 'action_reference', label: '动作参考视频（不进成片）', media: 'video', stage: 'director_preview' },
  { value: 'reference_video', label: '画面参考视频（不进成片）', media: 'video', stage: 'director_preview' },
  { value: 'direct_clip', label: '已有成片（直接放进某个镜头）', media: 'video', stage: 'shot_video' },
  { value: 'source_audio', label: '配音 / 音乐 / 播客音频', media: 'audio', stage: 'final_edit' },
  { value: 'source_document', label: '故事 / 资料 / 脚本文档', media: 'document', stage: 'script' },
  { value: 'unclassified', label: '暂时无法判断', media: 'any', stage: null },
])
function itemMediaKind(item) {
  const mime = String(item?.mime_type || '').toLowerCase()
  const type = String(item?.detected_type || '').toLowerCase()
  if (mime.startsWith('video/') || ['video', 'shot_video', 'director_preview', 'final_edit'].includes(type)) return 'video'
  if (mime.startsWith('audio/') || type === 'audio') return 'audio'
  if (mime.startsWith('image/') || ['image', 'character', 'scene', 'prop'].includes(type)) return 'image'
  return 'document'
}
function roleOptionsFor(item) { const kind = itemMediaKind(item); return ROLE_OPTIONS.filter((option) => option.media === kind || option.media === 'any') }
function sourceUsageRole(item) { return item?.metadata?.usage_role || item?.usage_role || 'unclassified' }
function currentRoleLabel(item) { return ROLE_OPTIONS.find((option) => option.value === sourceUsageRole(item))?.label || assetRoleLabel(sourceUsageRole(item)) }
function editDraft(item) {
  const key = String(item.id || item.relative_path)
  if (!itemEdits[key]) {
    const role = sourceUsageRole(item)
    const shotMatch = String(item.candidate_scope_id || '').match(/(\d{1,3})/)
    itemEdits[key] = { usage_role: role, shot_number: Number(item.metadata?.shot_number || shotMatch?.[1] || 1), include: item.status !== 'excluded' }
  }
  return itemEdits[key]
}
function rolePatch(item, draft) {
  const option = ROLE_OPTIONS.find((candidate) => candidate.value === draft.usage_role) || ROLE_OPTIONS.at(-1)
  const direct = draft.usage_role === 'direct_clip'
  return {
    id: item.id,
    usage_role: draft.usage_role,
    candidate_stage: option.stage,
    candidate_scope_type: direct ? 'shot' : (option.media === 'document' || option.media === 'audio' ? 'run' : 'resource'),
    candidate_scope_id: direct ? `shot-${Math.max(1, Number(draft.shot_number) || 1)}` : (item.candidate_scope_id || item.file_name || ''),
    direct_clip_candidate: direct,
    include: draft.include === true,
  }
}
async function saveItemCorrection(item) {
  if (!session.value?.id || savingItemId.value) return
  const draft = editDraft(item)
  if (draft.usage_role === 'direct_clip' && (!Number.isSafeInteger(Number(draft.shot_number)) || Number(draft.shot_number) < 1)) return ElMessage.warning('请先填写成片对应的镜头号')
  savingItemId.value = String(item.id)
  try {
    const result = await assetImportAPI.updatePlan(session.value.id, {
      expected_version: session.value.version,
      reason: '用户在同页计划中纠正素材用途',
      items: [rolePatch(item, draft)],
    })
    const data = result.data || result
    session.value = data.session || session.value
    plan.value = data.plan || plan.value
    analyzedItems.value = data.items || analyzedItems.value
    Object.keys(itemEdits).forEach((key) => delete itemEdits[key])
    emit('update:session', session.value)
    emit('planned', { session: session.value, plan: plan.value, corrected: true })
    ElMessage.success('用途已保存，主体和镜头计划已重新计算')
  } catch (e) {
    error.value = e.message || '保存素材用途失败'
    ElMessage.error(error.value)
  } finally { savingItemId.value = '' }
}
function addFiles(incoming) {
  if (!incoming.length) return
  // Browsers can surface a stale/invalid picker entry as a zero-byte File
  // (for example when the source was deleted while the chooser was open).
  // Sending that placeholder to multipart upload produces an opaque
  // "Network Error" and leaves the user with no useful recovery path. Reject
  // it at the boundary and keep the valid selections usable.
  const unreadable = incoming.filter((file) => !file || Number(file.size) <= 0)
  const readable = incoming.filter((file) => file && Number(file.size) > 0)
  if (unreadable.length) {
    const names = unreadable.map((file) => file?.name || '未命名文件').join('、')
    ElMessage.warning(`无法读取 ${names}（文件为空或已失效），请重新选择原文件`)
    error.value = `有 ${unreadable.length} 个文件为空或已失效，未加入上传列表。请重新选择后再分析。`
    phase.value = 'error'
  }
  if (!readable.length) return
  // A restored session already has display-only rows. Selecting the same file
  // again must be idempotent instead of appending a second visual row. Include
  // size so a genuinely changed file with the same name remains selectable.
  const existing = new Map(files.value.map((item) => [`${item.relative_path || item.file?.name || ''}:${Number(item.file?.size || 0)}`, item]))
  for (const file of readable) {
    const relativePath = file.webkitRelativePath || file.name
    const key = `${relativePath}:${file.size}:${file.lastModified}`
    const identity = `${relativePath}:${Number(file.size) || 0}`
    if (!existing.has(identity)) existing.set(identity, { key, file, relative_path: relativePath, source_token: null })
  }
  files.value = [...existing.values()]
  if (readable.length) { error.value = ''; phase.value = 'idle'; ElMessage.success(`已添加 ${readable.length} 个文件，可继续补充`) }
}
function onFiles(event) {
  const incoming = Array.from(event.target.files || [])
  event.target.value = ''
  addFiles(incoming)
}
function onDragOver() { if (!busy.value) dragActive.value = true }
function onDragLeave() { dragActive.value = false }
function onDrop(event) {
  dragActive.value = false
  if (busy.value) return
  addFiles(Array.from(event.dataTransfer?.files || []))
}
function removeFile(key) { files.value = files.value.filter((item) => item.key !== key); if (!files.value.length) { plan.value = null; analyzedItems.value = []; phase.value = 'idle' } }
function clearFiles() { files.value = []; plan.value = null; analyzedItems.value = []; session.value = null; phase.value = 'idle'; progress.value = null; error.value = '' }
function openFiles() { open.value = true; fileInput.value?.click() }
function openFolder() { open.value = true; folderInput.value?.click() }

async function ensureSession() {
  if (session.value) return session.value
  const result = await assetImportAPI.create({
    source_label: props.targetRunId ? '制作任务补充素材' : '制作首页素材',
    target_run_id: props.targetRunId || null,
    options: {
      target_drama_id: String(props.dramaId), target_episode_id: props.episodeId || null,
      target_run_id: props.targetRunId || null,
      template_id: props.templateId || null, target_shots: Number(props.targetShots) || 1, target_shots_user_edited: props.targetShotsUserEdited,
      user_intent: props.userIntent || '', auto_create_target: !props.targetRunId, classifier_enabled: useAi.value,
    },
  })
  session.value = result.data || result
  emit('update:session', session.value)
  return session.value
}

async function analyze() {
  if (!files.value.length) return ElMessage.warning('请先选择文件或文件夹')
  if (busy.value) return
  error.value = ''; controller.value = new AbortController(); progress.value = null
  try {
    const current = await ensureSession()
    const pending = pendingUploadItems(files.value)
    const unreadablePending = pending.filter((item) => !item?.file || Number(item.file.size) <= 0)
    if (unreadablePending.length) {
      throw new Error(`有 ${unreadablePending.length} 个文件为空或已失效，请移除后重新选择原文件`)
    }
    const invalidPending = files.value.filter((item) => item?.restored !== true && !item?.source_token && !pending.includes(item))
    if (invalidPending.length) throw new Error('有新增文件已无法读取，请移除后重新选择；已上传素材和旧计划仍会保留')
    let uploaded = []
    if (pending.length) {
      phase.value = 'uploading'
      const form = new FormData(); const relativePaths = []
      pending.forEach((item) => { form.append('files', item.file, item.file.name); relativePaths.push(item.relative_path) })
      form.append('relative_paths', JSON.stringify(relativePaths))
      const result = await assetImportAPI.upload(current.id, form, { timeout: 600000, signal: controller.value.signal, onUploadProgress: (event) => { if (event.total) progress.value = Math.min(100, Math.round(event.loaded / event.total * 100)) } })
      uploaded = result.files || result.data?.files || []
      uploaded.forEach((descriptor, index) => { const item = pending[index]; if (item) item.source_token = descriptor.source_token })
    }
    phase.value = 'analyzing'; progress.value = null
    const descriptors = freshScanDescriptors(files.value)
    const result = await assetImportAPI.scan(current.id, {
      files: descriptors,
      reuse_staged_files: true,
      reuse_relative_paths: restoredRelativePaths(files.value),
      classifier_enabled: useAi.value,
      options: { classifier_enabled: useAi.value, classifier_model: 'gpt-5.6-sol', template_id: props.templateId || null, target_shots: Number(props.targetShots) || 1, target_shots_user_edited: props.targetShotsUserEdited, user_intent: props.userIntent || '' },
    }, { timeout: 600000, signal: controller.value.signal })
    const data = result.data || result
    session.value = data.session; plan.value = data.plan || null; analyzedItems.value = data.items || []; phase.value = 'success'; progress.value = 100
    Object.keys(itemEdits).forEach((key) => delete itemEdits[key])
    emit('update:session', session.value); emit('planned', { session: session.value, plan: plan.value })
    ElMessage.success(`已完成 ${files.value.length} 个文件的整理${restoredRelativePaths(files.value).length ? '，已复用上传内容' : ''}`)
  } catch (e) {
    if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.message === 'canceled') phase.value = 'cancelled'
    else { phase.value = 'error'; error.value = e.message || '上传或分析失败' }
  } finally { controller.value = null }
}
function cancel() { controller.value?.abort() }

async function applyToRun(runId) {
  if (!session.value || session.value.status !== 'planned' || !runId) return null
  if (contextStale.value) throw new Error(`素材计划需要重新整理：${contextMismatchReasons.value.join('；')}`)
  const result = await assetImportAPI.apply(session.value.id, { confirm: true, target_run_id: runId, user_intent: props.userIntent || '' })
  const data = result.data || result
  session.value = data.session; emit('update:session', session.value); emit('applied', data)
  return data
}

async function applyCurrentRun() {
  if (!props.targetRunId || applying.value) return
  applying.value = true
  try {
    await applyToRun(props.targetRunId)
    ElMessage.success('补充素材已应用到当前任务，后台生成不会被打断')
  } catch (e) {
    ElMessage.error(e.message || '应用素材计划失败')
  } finally {
    applying.value = false
  }
}

onMounted(() => restoreSession())
watch(() => props.initialSessionId, (value) => restoreSession(value))
watch(contextStale, (value) => emit('context-stale', value), { immediate: true })

defineExpose({
  openFiles, openFolder, analyze, applyToRun, restoreSession,
  hasPlannedSession: () => Boolean(session.value?.status === 'planned'),
  isContextStale: () => contextStale.value,
  revealPlan: () => { open.value = true },
})
</script>

<style scoped>
.inline-import{border:1px solid #d9e5e2;background:#f8fbfa;padding:18px 20px;margin-top:18px}.inline-import-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.inline-import h3{margin:4px 0 5px;color:#183d3d;font-size:19px}.inline-import p{margin:0;color:#667779;font-size:13px;line-height:1.6}.picker-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding:10px;border:1px dashed #c7dcd8;background:#fbfefd;transition:background-color .2s,border-color .2s}.picker-row.is-dragging{border-color:#3d8a80;background:#effaf7}.drop-hint{color:#7a8b8b;font-size:12px}.hint{margin-top:9px!important;font-size:12px!important}.selection-summary{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px;padding:10px 12px;border:1px solid #d4e2df;background:#fff}.selection-summary strong{color:#24504d}.selection-summary .el-button{margin-left:auto}.selected-files{display:grid;gap:6px;max-height:210px;overflow:auto;margin-top:10px;padding:8px;border:1px solid #dfe9e7;background:#fff}.selected-file{display:grid;grid-template-columns:26px minmax(0,1fr) auto auto 28px;align-items:center;gap:8px;padding:6px 8px}.file-kind{display:grid;place-items:center;width:23px;height:23px;background:#e6f0ef;color:#2e6b65;font-size:11px;font-weight:700}.file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3c5154;font-size:12px}.file-size{color:#839092;font-size:11px}.progress-panel{margin-top:14px;padding:12px 14px;border:1px solid #cfdfdc;background:#fff}.progress-panel.is-error{border-color:#ebc4c4;background:#fff9f9}.progress-panel.is-cancelled{border-color:#ead9b0;background:#fffdf5}.progress-head{display:flex;justify-content:space-between;color:#2c5550;font-size:13px}.progress-panel p{margin-top:8px}.progress-error{margin-top:8px;color:#a44b4b;font-size:12px}.progress-actions{display:flex;justify-content:flex-end;margin-top:6px}.plan-summary{margin-top:14px;padding:12px 14px;border:1px solid #b9dfc8;background:#f4fbf6}.plan-summary div{display:flex;gap:12px;align-items:center;color:#24714a;font-size:13px;flex-wrap:wrap}.plan-summary small{display:block;margin-top:6px;color:#58715f}.plan-stale{margin-top:12px;padding:12px 14px;display:flex;align-items:center;justify-content:space-between;gap:14px;border:1px solid #e4c77f;background:#fffaf0;color:#765a1e}.plan-stale>div{display:grid;gap:4px}.plan-stale span{font-size:12px;line-height:1.5}.execution-plan{margin-top:12px;padding:14px;border:1px solid #b8d8d2;background:#fff}.execution-plan-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.execution-plan-head div{display:grid;gap:3px}.execution-plan-head strong{color:#183d3d;font-size:15px}.execution-plan-head span,.plan-principle{color:#6b7b7d;font-size:12px;line-height:1.5}.plan-stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}.plan-stat-grid span{display:grid;gap:3px;padding:9px;border:1px solid #e0ebe8;background:#f8fbfa}.plan-stat-grid strong{color:#245f58;font-size:16px}.plan-stat-grid small{color:#718385;font-size:11px}.plan-block{margin-top:14px}.plan-block h4{margin:0 0 7px;color:#355655;font-size:12px}.plan-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:9px;align-items:center;padding:8px 9px;border-top:1px solid #edf2f1}.plan-row-main,.plan-row>div:not(.plan-row-main){min-width:0;display:grid;gap:3px}.plan-row strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#3e5556;font-size:12px}.plan-row small{color:#819092;font-size:11px;line-height:1.45}.plan-badge,.shot-number{display:grid;place-items:center;min-width:42px;height:22px;padding:0 7px;background:#eef4f2;color:#547572;font-size:11px;font-weight:700}.plan-badge.is-authority{background:#e3f4e8;color:#28704a}.plan-badge.is-timeline{background:#e8f0ff;color:#42649a}.plan-badge.is-motion{background:#fff1dc;color:#95652b}.shot-number{border-radius:50%;min-width:24px;width:24px;padding:0;background:#245f58;color:#fff}.plan-corrections{padding-top:4px;border-top:1px solid #e4ebe9}.plan-corrections-help{margin:0 0 8px!important;color:#72817e!important;font-size:11px!important}.plan-correction-item{border-top:1px solid #e5ecea}.plan-correction-item summary{padding:9px 3px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.plan-correction-item summary::-webkit-details-marker{display:none}.plan-correction-item summary>span{min-width:0;display:grid;gap:2px}.plan-correction-item summary small{color:#7d8a88;font-size:10px}.plan-correction-item summary em{color:#287568;font-size:11px;font-style:normal}.plan-correction-grid{display:grid;grid-template-columns:minmax(220px,1.5fr) minmax(160px,.8fr) minmax(150px,.7fr);gap:10px;padding:8px 0}.plan-correction-grid label{display:grid;gap:5px}.plan-correction-grid label>span{color:#516563;font-size:11px}.plan-correction-grid :deep(.el-input-number){width:100%}.plan-include-toggle{align-content:start}.plan-correction-actions{padding:2px 0 10px;display:flex;align-items:center;justify-content:space-between;gap:10px}.plan-correction-actions span{color:#7a8785;font-size:10px;line-height:1.45}.plan-unresolved{margin-top:14px;padding:10px 11px;border:1px solid #ead7a7;background:#fffaf0;color:#7b612d;font-size:12px}.plan-unresolved p{margin:5px 0 0;color:#7e6d4b;font-size:11px}.plan-principle{display:block;margin-top:12px}@media(max-width:700px){.inline-import{padding:14px}.inline-import-head{align-items:stretch;flex-direction:column}.selection-summary .el-button{width:100%;margin-left:0}.selected-file{grid-template-columns:26px minmax(0,1fr) auto 28px}.selected-file .el-tag{display:none}.file-size{grid-column:2;grid-row:2}.plan-stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.execution-plan-head,.plan-stale{align-items:stretch;flex-direction:column}.plan-row{grid-template-columns:auto minmax(0,1fr)}.plan-row>.el-tag{grid-column:2;justify-self:start}.plan-correction-grid{grid-template-columns:1fr}.plan-correction-actions{align-items:stretch;flex-direction:column}.plan-correction-actions :deep(.el-button){width:100%;margin-left:0}}
.setting-recommendation{padding-top:6px;border-top:1px solid #d7eadc;color:#356653!important}
</style>
