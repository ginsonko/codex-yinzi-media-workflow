<template>
  <div class="page">
    <header class="hero">
      <div class="hero-main">
        <p class="kicker">智能资产导入</p>
        <h1>把现有素材接入工作流</h1>
        <p class="sub">先选文件夹或文件，按你设的规则筛一遍，确认预览清单后再上传分析；分析结果逐条可改，确认导入前不会写入项目和扣费。</p>
      </div>
      <el-button @click="$router.push('/')">返回项目</el-button>
    </header>

    <!-- 这一页在管什么 -->
    <section class="scope-note" aria-label="这一页在管什么">
      <p>
        这一页管三件事：① 从磁盘挑哪些文件（下面「扫描规则」决定收哪些、丢哪些、每个文件怎么命名）；
        ② 让系统怎么认它们（AI 理解还是只用本地规则，用哪个模板和目标任务）；
        ③ 计划出来之后逐条改类型、用途、阶段，再决定导入。
        规则只影响本次会话的新扫描，已经导入过的记录和历史会话不受影响。
      </p>
    </section>

    <el-card class="card" shadow="never">
      <div class="form-row">
        <el-input v-model="sourceLabel" placeholder="来源备注（例如：第一季素材）" />
        <el-input v-model="targetRunId" placeholder="目标制作任务 ID（可选）" />
        <el-select v-model="templateId" clearable filterable placeholder="通用导入（可选模板）">
          <el-option v-for="item in templates" :key="item.id" :label="item.name" :value="item.id" />
        </el-select>
        <el-button type="primary" plain @click="create">先创建导入会话</el-button>
      </div>
      <p class="target-hint">{{ targetRunId ? '将导入到指定制作任务。' : targetDramaId ? '当前项目尚未有制作任务，确认导入时会自动创建草稿任务，不会立即生成或扣费。' : '未指定项目时，确认导入会自动创建一个草稿项目和制作任务。' }}</p>

      <section class="rules" aria-label="扫描规则">
        <header class="rules-head">
          <div>
            <h2>扫描规则</h2>
            <p>下面每一项都直接决定哪些文件进入清单，改完立刻按新规则重算，不会动已经上传的暂存文件。</p>
          </div>
          <div class="rules-buttons">
            <el-button size="small" :icon="RefreshLeft" @click="resetRules">恢复默认</el-button>
            <el-button size="small" :disabled="!hasRuleOverride" @click="saveRules">记住这套规则</el-button>
          </div>
        </header>

        <div class="rules-grid">
          <label class="rules-field">
            <span>包含规则<em>每行一条，匹配相对路径；留空表示收下全部文件</em></span>
            <el-input v-model="includeRules" type="textarea" :rows="3" placeholder="例如：&#10;*.jpg&#10;第*季/分镜*.png&#10;剧本" />
          </label>
          <label class="rules-field">
            <span>排除规则<em>每行一条，命中即跳过；优先级高于包含规则</em></span>
            <el-input v-model="excludeRules" type="textarea" :rows="3" placeholder="例如：&#10;*._tmp*&#10;*/.DS_Store&#10;*旧版*" />
          </label>
        </div>

        <div class="rules-grid rules-grid-3">
          <label class="rules-field">
            <span>只收文件类型</span>
            <el-select v-model="kindFilter" multiple collapse-tags placeholder="全部类型">
              <el-option v-for="option in KIND_OPTIONS" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </label>
          <label class="rules-field">
            <span>单个文件上限（MB）</span>
            <el-input-number v-model="maxFileMb" :min="1" :max="500" :step="10" controls-position="right" />
          </label>
          <label class="rules-field">
            <span>重名时如何处理</span>
            <el-select v-model="duplicatePolicy">
              <el-option label="全部保留，交给计划去识别" value="keep" />
              <el-option label="同名同大小只留一份" value="dedupe" />
            </el-select>
          </label>
        </div>

        <div class="rules-grid rules-grid-3">
          <label class="rules-field">
            <span>命名规则<em>可选：给入库清单加前缀，留空则保留原相对路径</em></span>
            <el-input v-model="renamePrefix" placeholder="例如：S1-" />
          </label>
          <label class="rules-field">
            <span>分类方式</span>
            <el-select v-model="classificationMode">
              <el-option label="本地规则 + AI 理解（调用模型）" value="ai" />
              <el-option label="仅本地规则（不调用模型，不花钱）" value="local" />
            </el-select>
          </label>
          <label class="rules-field">
            <span>默认归类阶段<em>扫描计划里所有条目的初始阶段，逐条仍可改；留空则由分析结果决定</em></span>
            <el-select v-model="defaultStage" clearable placeholder="由分析结果决定">
              <el-option v-for="stage in editableStages" :key="stage" :label="stageLabel(stage)" :value="stage" />
            </el-select>
          </label>
        </div>

        <p class="rules-summary" role="status">{{ rulesSummary }}</p>
        <p v-if="ruleError" class="rules-error" role="alert">{{ ruleError }}</p>
      </section>

      <input ref="fileInput" type="file" multiple hidden @change="onFiles" />
      <input ref="folderInput" type="file" webkitdirectory directory multiple hidden @change="onFiles" />
      <div class="choose-row">
        <div class="choose-actions">
          <el-button class="choose" :disabled="scanning" @click="fileInput?.click()">选择文件（可多选）</el-button>
          <el-button class="choose" :disabled="scanning" :title="folderPickerSupported ? '选择一个文件夹，包含其中的所有素材' : '当前浏览器不支持目录选择，请改用选择文件（可多选）'" @click="chooseFolder">{{ folderPickerSupported ? '选择文件夹' : '目录选择不可用' }}</el-button>
          <el-button v-if="files.length" text type="danger" :disabled="scanning" @click="clearFiles">清空选择</el-button>
        </div>
        <el-switch v-model="useAiClassifier" active-text="使用 AI 理解图片/视频/文本" inactive-text="仅本地规则（不调用模型）" @change="syncClassificationMode" />
      </div>
      <p class="hint">支持 txt、md、docx、pdf、json、csv、图片、视频、音频；文件和文件夹可以混合选择，确认前不会写入项目。后端单文件上限 500 MB、单会话最多 {{ MAX_FILES }} 个文件、总量 {{ MAX_TOTAL_GIB }} GiB。</p>

      <!-- 先预览再入库：规则的结果摊开给人看 -->
      <section v-if="allFiles.length" class="scan-preview" aria-label="扫描结果预览">
        <header class="preview-head">
          <div>
            <h2>扫描结果预览</h2>
            <p>按当前规则筛完的清单；点任意一行可以把它单独排除或加回，改动只影响本次扫描。</p>
          </div>
          <div class="preview-stats">
            <span><b>{{ allFiles.length }}</b> 选中的文件</span>
            <span><b>{{ acceptedFiles.length }}</b> 将上传</span>
            <span v-if="excludedFiles.length"><b class="warn">{{ excludedFiles.length }}</b> 被规则排除</span>
            <span><b>{{ formatBytes(totalBytes) }}</b> 预计上传体积</span>
          </div>
        </header>

        <el-alert
          v-if="!acceptedFiles.length"
          type="warning"
          :closable="false"
          show-icon
          title="当前规则把全部文件都排除了"
          description="放宽包含规则、清空排除规则，或去掉文件类型限制，再上传分析。"
        />
        <div v-if="excludedFiles.length" class="excluded-list">
          <span class="excluded-label">被规则排除</span>
          <el-tag v-for="item in excludedFiles.slice(0, 12)" :key="item.key" size="small" type="info">{{ item.relative_path }}</el-tag>
          <span v-if="excludedFiles.length > 12" class="excluded-more">等 {{ excludedFiles.length }} 个</span>
          <el-button size="small" text @click="includeAllExcluded">全部加回</el-button>
        </div>

        <div v-if="!previewOpen" class="preview-more">
          <el-button size="small" @click="previewOpen = true">逐条查看清单（{{ acceptedFiles.length }}）</el-button>
        </div>
        <div v-else class="selected-files">
          <div v-for="item in pagedFiles" :key="item.key" class="selected-file">
            <span class="file-kind">{{ fileKind(item.file) }}</span>
            <span class="file-name" :title="item.relative_path">{{ item.relative_path }}</span>
            <span class="file-size num">{{ formatBytes(item.file.size) }}</span>
            <el-tag v-if="item.source_token" size="small" type="success">已上传</el-tag>
            <el-button v-if="item.userExcluded" size="small" text @click="toggleExcluded(item)">加回</el-button>
            <el-button v-else size="small" text type="danger" @click="toggleExcluded(item)">排除</el-button>
          </div>
          <div v-if="previewPages > 1" class="preview-pager">
            <el-button size="small" :disabled="previewPage === 1" @click="previewPage--">上一页</el-button>
            <span class="num">{{ previewPage }} / {{ previewPages }}</span>
            <el-button size="small" :disabled="previewPage >= previewPages" @click="previewPage++">下一页</el-button>
          </div>
        </div>

        <div class="selection-summary" aria-live="polite">
          <strong>已选择 {{ allFiles.length }} 个文件</strong>
          <span class="num">总大小 {{ formatBytes(totalBytes) }}</span>
          <span v-if="uploadedCount" class="num">已上传 {{ uploadedCount }} 个，可复用暂存</span>
          <el-button link type="primary" :disabled="!acceptedFiles.length || scanning" @click="uploadAndAnalyze">{{ session ? '上传并分析' : '创建会话并分析' }}</el-button>
        </div>
      </section>

      <div v-if="uploadPhase !== 'idle'" class="upload-status" :class="`is-${uploadPhase}`" role="status" aria-live="polite">
        <div class="upload-status-head">
          <strong>{{ uploadPhaseLabel }}</strong>
          <span v-if="uploadPhase === 'uploading' && uploadProgress != null" class="num">{{ uploadProgress }}%</span>
        </div>
        <el-progress v-if="uploadPhase === 'uploading'" :percentage="uploadProgress ?? 0" :indeterminate="uploadProgress == null" :duration="1.2" :show-text="false" />
        <p>{{ uploadPhaseDetail }}</p>
        <div class="upload-status-actions">
          <el-button v-if="['uploading','analyzing'].includes(uploadPhase)" text type="danger" @click="cancelUpload">取消本次上传</el-button>
          <el-button v-if="uploadPhase === 'error'" type="primary" plain @click="uploadAndAnalyze">重试</el-button>
        </div>
      </div>

      <div v-if="recentSessions.length" class="recent-imports">
        <span class="recent-label">可继续的导入会话</span>
        <el-button v-for="item in recentSessions" :key="item.id" link type="primary" @click="resume(item)">{{ item.source_label || item.id.slice(0, 8) }} · {{ statusText(item.status) }}</el-button>
      </div>
    </el-card>

    <el-card v-if="session" class="card" shadow="never">
      <div class="card-head">
        <div>
          <h2>导入会话 {{ session.id.slice(0, 8) }}</h2>
          <el-tag :type="statusType">{{ statusLabel }}</el-tag>
          <small class="revision num">计划版本 {{ session.version }}</small>
        </div>
        <div class="actions">
          <el-button :loading="scanning" :disabled="!files.length" @click="uploadAndAnalyze">重新上传并分析</el-button>
          <el-button :loading="savingPlan" :disabled="session.status !== 'planned' || !items.length" @click="savePlanEdits">保存计划修改</el-button>
          <el-button type="primary" :disabled="session.status !== 'planned'" @click="apply">确认导入</el-button>
          <el-button type="danger" plain :disabled="session.status !== 'applied'" @click="rollback">回滚</el-button>
        </div>
      </div>
      <el-alert v-if="error" :title="error" type="error" show-icon />
      <div v-if="plan.summary" class="stats">
        <span>文件 <b class="num">{{ plan.summary.total }}</b></span>
        <span>可导入 <b class="num">{{ plan.summary.ready }}</b></span>
        <span>待处理 <b class="num">{{ plan.summary.partial + plan.summary.unknown }}</b></span>
        <span>已排除 <b class="num">{{ plan.summary.excluded || 0 }}</b></span>
        <span>冲突 <b class="num">{{ plan.conflicts?.length || 0 }}</b></span>
        <span v-if="plan.template_candidates?.length">推荐模板 {{ plan.template_candidates[0].id }}</span>
      </div>
      <div v-if="plan.conflicts?.length" class="reorganize-row">
        <el-input v-model="reorganizeReason" placeholder="告诉 AI 如何处理冲突，例如：保留最新版本，旧版本作为候选" />
        <el-button :loading="reorganizing" @click="reorganize">让 AI 重新整理</el-button>
      </div>

      <!-- 计划清单的筛选：一行里改完，不用来回找 -->
      <div class="plan-filters">
        <el-radio-group v-model="planFilter" size="small">
          <el-radio-button value="all">全部 {{ items.length }}</el-radio-button>
          <el-radio-button value="ready">可导入</el-radio-button>
          <el-radio-button value="pending">待处理</el-radio-button>
          <el-radio-button value="excluded">已排除</el-radio-button>
          <el-radio-button value="failed">解析失败</el-radio-button>
        </el-radio-group>
        <el-input v-model="planKeyword" class="plan-search" size="small" clearable placeholder="按文件名或判断依据筛选" />
        <el-button size="small" :disabled="!items.length" @click="setAllIncluded(true)">全部标为导入</el-button>
        <el-button size="small" :disabled="!items.length" @click="setAllIncluded(false)">全部排除</el-button>
      </div>

      <el-table :data="filteredPlanItems" stripe>
        <el-table-column prop="relative_path" label="文件" min-width="220" show-overflow-tooltip />
        <el-table-column label="识别类型" width="150"><template #default="{ row }"><el-select v-model="row.detected_type" size="small" filterable allow-create><el-option v-for="type in editableTypes" :key="type" :label="typeLabel(type)" :value="type" /></el-select></template></el-table-column>
        <el-table-column label="建议用途" width="170"><template #default="{ row }"><el-select v-model="row.metadata.usage_role" size="small"><el-option v-for="role in usageRoles" :key="role" :label="usageRoleLabel(role)" :value="role" /></el-select><small v-if="row.metadata.direct_clip_candidate" class="clip-hint">可作为直接片段</small></template></el-table-column>
        <el-table-column label="拟放入阶段" width="165"><template #default="{ row }"><el-select v-model="row.candidate_stage" size="small" clearable filterable placeholder="不导入"><el-option v-for="stage in editableStages" :key="stage" :label="stageLabel(stage)" :value="stage" /></el-select></template></el-table-column>
        <el-table-column label="作用域" width="185"><template #default="{ row }"><div class="scope-cell"><el-select v-model="row.candidate_scope_type" size="small"><el-option v-for="scope in editableScopes" :key="scope" :label="scopeLabel(scope)" :value="scope" /></el-select><el-input v-model="row.candidate_scope_id" size="small" placeholder="对象 ID" /></div></template></el-table-column>
        <el-table-column label="置信度" width="100"><template #default="{ row }"><span class="num">{{ row.confidence == null ? '—' : `${Math.round(row.confidence * 100)}%` }}</span></template></el-table-column>
        <el-table-column label="导入" width="72"><template #default="{ row }"><el-switch :model-value="row.status !== 'excluded'" @update:model-value="value => row.status = value ? (row.error_code ? 'partial' : 'ready') : 'excluded'" /></template></el-table-column>
        <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag size="small" :type="itemStatusType(row.status)">{{ itemStatusLabel(row) }}</el-tag></template></el-table-column>
        <el-table-column label="判断依据" min-width="210" show-overflow-tooltip><template #default="{ row }">{{ evidenceLabel(row) }}</template></el-table-column>
      </el-table>
      <p v-if="!filteredPlanItems.length && items.length" class="plan-empty">当前筛选没有条目；把筛选改回「全部」即可看到完整计划。</p>
      <p v-if="!items.length" class="plan-empty">这次扫描还没有生成条目。回到上面的扫描规则调整后重新上传并分析。</p>

      <el-alert v-if="plan.conflicts?.length" class="conflicts" title="存在需要你确认的冲突；系统不会静默覆盖" type="warning" show-icon :description="plan.conflicts.map(c => `${c.type}: ${c.paths?.join('、') || c.target}`).join('；')" />
    </el-card>
  </div>
</template>
<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { RefreshLeft } from '@element-plus/icons-vue'
import { assetImportAPI } from '@/api/assetImport'
import { templatesAPI } from '@/api/templates'

const route = useRoute()
const fileInput = ref(); const folderInput = ref(); const sourceLabel = ref(''); const targetRunId = ref(''); const targetDramaId = ref(''); const targetEpisodeId = ref(''); const templateId = ref(''); const templates = ref([]); const files = ref([]); const session = ref(null); const plan = ref({}); const items = ref([]); const scanning = ref(false); const savingPlan = ref(false); const error = ref(''); const recentSessions = ref([]); const reorganizeReason = ref(''); const reorganizing = ref(false); const useAiClassifier = ref(false)
const uploadPhase = ref('idle'); const uploadProgress = ref(null); const uploadBytesTotal = ref(0); const uploadError = ref(''); const uploadAbortController = ref(null); const folderPickerSupported = ref(true)

const MAX_FILES = 2000
const MAX_TOTAL_GIB = 5
const RULE_KEY = 'yinzi-asset-import-rules'
const KIND_OPTIONS = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'text', label: '文本 / 文档' },
]
const DEFAULT_RULES = Object.freeze({ include: '', exclude: '', kinds: [], maxFileMb: null, duplicates: 'keep', renamePrefix: '', classification: 'local', defaultStage: '' })

/* ── 显式规则状态：全部可见、可改、可记住 ── */
const includeRules = ref(DEFAULT_RULES.include)
const excludeRules = ref(DEFAULT_RULES.exclude)
const kindFilter = ref([])
const maxFileMb = ref(null)
const duplicatePolicy = ref(DEFAULT_RULES.duplicates)
const renamePrefix = ref(DEFAULT_RULES.renamePrefix)
const classificationMode = ref(DEFAULT_RULES.classification)
const defaultStage = ref(DEFAULT_RULES.defaultStage)
const previewOpen = ref(false); const previewPage = ref(1); const previewPageSize = 60
const ruleError = ref('')
const planFilter = ref('all'); const planKeyword = ref('')

const totalBytes = computed(() => files.value.reduce((sum, item) => sum + (Number(item.file?.size) || 0), 0))
const uploadedCount = computed(() => files.value.filter((item) => item.source_token && item.source_session_id === session.value?.id).length)
const uploadPhaseLabel = computed(() => ({ idle: '', uploading: '正在上传素材', analyzing: '正在分析素材', success: '素材分析完成', error: '上传或分析失败' }[uploadPhase.value] || ''))
const uploadPhaseDetail = computed(() => {
  if (uploadPhase.value === 'uploading') return uploadProgress.value == null ? '已连接，正在传输文件；网络较慢时百分比可能稍后出现。' : `已上传 ${formatBytes(Math.round(uploadBytesTotal.value * uploadProgress.value / 100))} / ${formatBytes(uploadBytesTotal.value)}`
  if (uploadPhase.value === 'analyzing') return useAiClassifier.value ? '文件已上传，AI 正在读取文本、图片和视频采样；请不要重复点击。' : '文件已上传，正在读取元数据并生成导入计划。'
  if (uploadPhase.value === 'success') return '计划已生成，请检查分类和冲突后确认导入。'
  if (uploadPhase.value === 'error') return uploadError.value || '文件仍保留在当前清单中，可以修复后重试。'
  return ''
})
function formatBytes(value) { const bytes = Number(value) || 0; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`; if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`; return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` }
function fileKind(file) { const type = String(file?.type || ''); if (type.startsWith('image/')) return '图'; if (type.startsWith('video/')) return '视'; if (type.startsWith('audio/')) return '音'; return '文' }
function mediaKind(file) {
  const name = String(file?.name || '')
  const type = String(file?.type || '')
  if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|tiff?|avif)$/i.test(name)) return 'image'
  if (type.startsWith('video/') || /\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name)) return 'video'
  if (type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(name)) return 'audio'
  return 'text'
}

/* ── 规则 → 匹配 ── */
function toMatcher(pattern) {
  const raw = String(pattern || '').trim()
  if (!raw) return null
  // 先把 / 当路径分隔符处理，再把 * 和 ? 转成正则；不引入额外依赖。
  const escaped = raw.replace(/\\/g, '/').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  try { return new RegExp(escaped, 'i') } catch (_) { return null }
}
const includeMatchers = computed(() => includeRules.value.split('\n').map(toMatcher).filter(Boolean))
const excludeMatchers = computed(() => excludeRules.value.split('\n').map(toMatcher).filter(Boolean))

function ruleExcludes(entry) {
  const path = String(entry.relative_path || entry.name || '')
  for (const tester of excludeMatchers.value) if (tester.test(path)) return '命中排除规则'
  if (kindFilter.value.length && !kindFilter.value.includes(mediaKind(entry.file))) return '类型不在允许范围内'
  if (maxFileMb.value && Number(entry.file?.size || 0) > Number(maxFileMb.value) * 1024 * 1024) return `超过 ${maxFileMb.value} MB 上限`
  if (includeMatchers.value.length && !includeMatchers.value.some((tester) => tester.test(path))) return '不匹配任何包含规则'
  return ''
}

const allFiles = computed(() => files.value)
const acceptedFiles = computed(() => files.value.filter((item) => !item.ruleReason && !item.userExcluded))
const excludedFiles = computed(() => files.value.filter((item) => item.ruleReason || item.userExcluded))
const previewPages = computed(() => Math.max(1, Math.ceil(acceptedFiles.value.length / previewPageSize)))
const pagedFiles = computed(() => {
  const start = (previewPage.value - 1) * previewPageSize
  return acceptedFiles.value.slice(start, start + previewPageSize)
})
const hasRuleOverride = computed(() => JSON.stringify(currentRules()) !== JSON.stringify(DEFAULT_RULES))
function currentRules() {
  return {
    include: includeRules.value,
    exclude: excludeRules.value,
    kinds: [...kindFilter.value],
    maxFileMb: maxFileMb.value,
    duplicates: duplicatePolicy.value,
    renamePrefix: renamePrefix.value,
    classification: classificationMode.value,
    defaultStage: defaultStage.value,
  }
}
const rulesSummary = computed(() => {
  const parts = []
  parts.push(includeMatchers.value.length ? `包含 ${includeMatchers.value.length} 条规则` : '包含规则为空，收下全部文件')
  if (excludeMatchers.value.length) parts.push(`排除 ${excludeMatchers.value.length} 条规则优先`)
  parts.push(kindFilter.value.length ? `类型限 ${kindFilter.value.map((kind) => KIND_OPTIONS.find((option) => option.value === kind)?.label || kind).join('、')}` : '类型不限')
  parts.push(maxFileMb.value ? `单个不超过 ${maxFileMb.value} MB` : '单文件大小不限（后端仍按 5 GiB 总量拒绝）')
  parts.push(duplicatePolicy.value === 'dedupe' ? '同名同大小只留一份' : '重名全部保留')
  parts.push(classificationMode.value === 'ai' ? '分类会调用 AI 模型（可能产生费用）' : '分类只用本地规则，不调用模型')
  if (defaultStage.value) parts.push(`没有识别出阶段的条目先放进「${stageLabel(defaultStage.value)}」`)
  return parts.join('；') + '。'
})
watch([includeRules, excludeRules], () => { previewPage.value = 1; reapplyRules() })
watch([kindFilter, maxFileMb, duplicatePolicy], () => { previewPage.value = 1; reapplyRules() })
watch(classificationMode, (value) => { useAiClassifier.value = value === 'ai' })
watch(useAiClassifier, (value) => { classificationMode.value = value ? 'ai' : 'local' })
function syncClassificationMode() { classificationMode.value = useAiClassifier.value ? 'ai' : 'local' }

function reapplyRules() {
  ruleError.value = ''
  if (!files.value.length) return
  let dedupeSkipped = 0
  const seen = new Set()
  for (const item of files.value) {
    const reason = ruleExcludes(item)
    item.ruleReason = reason
    if (!reason && duplicatePolicy.value === 'dedupe') {
      const fingerprint = `${item.name}:${item.file?.size}`
      if (seen.has(fingerprint)) { item.ruleReason = '与另一份同名同大小重复'; dedupeSkipped += 1 } else seen.add(fingerprint)
    }
  }
  if (dedupeSkipped) ElMessage.info(`去重规则跳过了 ${dedupeSkipped} 个重复文件，可在预览里逐条加回`)
}
function toggleExcluded(item) { item.userExcluded = !item.userExcluded }
function includeAllExcluded() { for (const item of files.value) item.userExcluded = false }
function resetRules() {
  Object.assign(currentRules(), {})
  includeRules.value = DEFAULT_RULES.include
  excludeRules.value = DEFAULT_RULES.exclude
  kindFilter.value = []
  maxFileMb.value = null
  duplicatePolicy.value = DEFAULT_RULES.duplicates
  renamePrefix.value = DEFAULT_RULES.renamePrefix
  classificationMode.value = DEFAULT_RULES.classification
  defaultStage.value = DEFAULT_RULES.defaultStage
  useAiClassifier.value = false
  ElMessage.success('已恢复默认扫描规则')
}
function saveRules() {
  try { localStorage.setItem(RULE_KEY, JSON.stringify(currentRules())); ElMessage.success('已记住这套规则，下次打开自动套用') } catch (_) { ElMessage.warning('浏览器不允许保存，本次仍然生效') }
}
function loadRules() {
  try {
    const saved = JSON.parse(localStorage.getItem(RULE_KEY) || 'null')
    if (!saved) return
    includeRules.value = typeof saved.include === 'string' ? saved.include : DEFAULT_RULES.include
    excludeRules.value = typeof saved.exclude === 'string' ? saved.exclude : DEFAULT_RULES.exclude
    kindFilter.value = Array.isArray(saved.kinds) ? saved.kinds.filter((kind) => KIND_OPTIONS.some((option) => option.value === kind)) : []
    maxFileMb.value = Number.isFinite(Number(saved.maxFileMb)) && Number(saved.maxFileMb) > 0 ? Number(saved.maxFileMb) : null
    duplicatePolicy.value = saved.duplicates === 'dedupe' ? 'dedupe' : 'keep'
    renamePrefix.value = typeof saved.renamePrefix === 'string' ? saved.renamePrefix : ''
    classificationMode.value = saved.classification === 'ai' ? 'ai' : 'local'
    useAiClassifier.value = classificationMode.value === 'ai'
    defaultStage.value = editableStages.includes(saved.defaultStage) ? saved.defaultStage : ''
  } catch (_) { /* 存的东西坏了就按默认走 */ }
}

const editableTypes = ['script', 'storyboard', 'character', 'scene', 'prop', 'asset_text', 'image', 'video', 'audio', 'director_preview', 'shot_video', 'final_edit', 'unknown']
const editableStages = ['script', 'asset_text', 'asset_images', 'storyboard_plan', 'storyboard_images', 'director_preview', 'shot_video', 'final_edit']
const editableScopes = ['run', 'resource', 'shot']
const usageRoles = ['source_document', 'visual_reference', 'reference_or_direct_clip', 'source_audio', 'unclassified']
const usageRoleLabel = (value) => ({ source_document: '来源文档', visual_reference: '视觉参考', reference_or_direct_clip: '参考 / 直接片段', source_audio: '源音频', unclassified: '待确认' }[value] || value)
const typeLabel = (value) => ({ script: '剧本', storyboard: '分镜稿', character: '角色', scene: '场景', prop: '道具', asset_text: '资源文本', image: '图片', video: '视频', audio: '音频', director_preview: '导演台预演', shot_video: '分镜视频', final_edit: '成片/音频', unknown: '未识别' }[value] || value)
const stageLabel = (value) => ({ script: '剧本', asset_text: '资源设定', asset_images: '资源图', storyboard_plan: '分镜脚本', storyboard_images: '分镜图', director_preview: '3D 导演台', shot_video: '分镜视频', final_edit: '最终剪辑' }[value] || value)
const scopeLabel = (value) => ({ run: '项目', resource: '资源对象', shot: '镜头' }[value] || value)
const itemStatusLabel = (row) => row.status === 'excluded' ? '已排除' : row.status === 'partial' ? `部分可用${row.error_message ? `：${row.error_message}` : ''}` : row.status === 'failed' ? '解析失败' : row.candidate_stage ? '可导入' : '待指定阶段'
const itemStatusType = (value) => ({ ready: 'success', partial: 'warning', failed: 'danger', excluded: 'info' }[value] || 'info')
const evidenceLabel = (row) => { const source = row.evidence?.source === 'multimodal_ai' ? `AI（${row.evidence.model || 'gpt-5.6-sol'}）` : row.evidence?.source === 'local_rules' ? '本地规则' : row.evidence?.source === 'extension_and_metadata' ? '扩展名和元数据' : row.evidence?.source || '—'; const receipt = row.metadata?.analysis_receipt?.used ? ' · 已实际读取媒体' : ''; return row.error_message ? `${source}${receipt}；${row.error_message}` : `${source}${receipt}` }
const statusLabel = computed(() => ({ draft: '待扫描', planned: '待确认', applied: '已导入', rolled_back: '已回滚' }[session.value?.status] || session.value?.status || ''))
const statusType = computed(() => ({ planned: 'warning', applied: 'success', rolled_back: 'info' }[session.value?.status] || 'info'))
const statusText = (value) => ({ draft: '待扫描', planned: '待确认', applied: '已导入', rolled_back: '已回滚' }[value] || value)

/* 计划表的筛选：状态 + 关键词，都在前端做，不发新请求 */
const filteredPlanItems = computed(() => {
  const keyword = planKeyword.value.trim().toLowerCase()
  return items.value.filter((row) => {
    if (planFilter.value === 'ready' && row.status !== 'ready') return false
    if (planFilter.value === 'excluded' && row.status !== 'excluded') return false
    if (planFilter.value === 'failed' && row.status !== 'failed') return false
    if (planFilter.value === 'pending' && !['partial', 'failed'].includes(row.status)) return false
    if (keyword && !`${row.relative_path} ${evidenceLabel(row)}`.toLowerCase().includes(keyword)) return false
    return true
  })
})
function setAllIncluded(included) {
  for (const row of items.value) row.status = included ? (row.error_code ? 'partial' : 'ready') : 'excluded'
  ElMessage.info(included ? '全部条目标为导入，记得点「保存计划修改」' : '全部条目标为排除，记得点「保存计划修改」')
}

function onFiles(event) {
  const incoming = [...(event.target.files || [])]
  if (event.target) event.target.value = ''
  if (!incoming.length) return
  const before = files.value.length
  const existing = new Map(files.value.map((item) => [item.key, item]))
  for (const file of incoming) {
    const relativePath = file.webkitRelativePath || file.name
    const key = `${relativePath}:${file.size}:${file.lastModified}`
    if (!existing.has(key)) existing.set(key, { key, file, relative_path: relativePath, name: file.name, source_token: null, source_session_id: null, ruleReason: '', userExcluded: false })
  }
  files.value = [...existing.values()]
  uploadPhase.value = 'idle'; uploadError.value = ''; error.value = ''
  reapplyRules()
  ElMessage.success(`已添加 ${files.value.length - before} 个新文件，当前共 ${files.value.length} 个`)
}
function chooseFolder() { if (folderPickerSupported.value) folderInput.value?.click(); else { ElMessage.info('当前浏览器不支持目录选择，请在文件选择器中多选素材'); fileInput.value?.click() } }
function removeFile(key) { files.value = files.value.filter((item) => item.key !== key); if (!files.value.length) uploadPhase.value = 'idle' }
function clearFiles() { files.value = []; uploadPhase.value = 'idle'; uploadProgress.value = null; uploadError.value = ''; previewOpen.value = false }
async function create() { error.value = ''; try { const res = await assetImportAPI.create({ source_label: sourceLabel.value, target_run_id: targetRunId.value || null, options: { template_id: templateId.value || null, target_drama_id: targetDramaId.value || null, target_episode_id: targetEpisodeId.value || null, auto_create_target: true } }); session.value = res.data || res; ElMessage.success('导入会话已创建'); return session.value } catch (e) { error.value = e.message || '导入会话创建失败；检查后端是否在运行，或先点「先创建导入会话」重试'; ElMessage.error(error.value); return null } }
async function loadSessions() { try { const res = await assetImportAPI.list({ page_size: 20 }); recentSessions.value = (res.items || []).filter(item => item.status !== 'rolled_back') } catch (_) { recentSessions.value = [] } }
async function resume(item) {
  try {
    const res = await assetImportAPI.get(item.id); const data = res.data || res
    session.value = data.session; plan.value = session.value.plan || {}; items.value = data.items || []
    sourceLabel.value = session.value.source_label || ''; targetRunId.value = session.value.target_run_id || ''
    targetDramaId.value = session.value.options?.target_drama_id || ''; targetEpisodeId.value = session.value.options?.target_episode_id || ''
    templateId.value = session.value.options?.template_id || templateId.value || ''
    const savedStage = session.value.options?.default_stage
    if (editableStages.includes(savedStage)) defaultStage.value = savedStage
    ElMessage.success('已恢复导入会话；如果源文件已经不在选择清单里，请重新选择后再扫描')
  } catch (e) { error.value = e.message }
}
async function uploadAndAnalyze() {
  if (!allFiles.value.length) return ElMessage.warning('请先选择文件或文件夹')
  if (!acceptedFiles.value.length) return ElMessage.warning('当前规则把所有文件都排除了，请先放宽规则')
  if (scanning.value) return
  if (!session.value) {
    await create()
    if (!session.value) return
  }
  await scan()
}
async function scan() {
  if (!session.value) return ElMessage.warning('请先创建导入会话')
  const targets = acceptedFiles.value
  if (!targets.length) return ElMessage.warning('请先选择文件或文件夹')
  if (targets.length > MAX_FILES) return ElMessage.error(`本次 ${targets.length} 个文件超过后端上限 ${MAX_FILES} 个，请分批扫描`)
  scanning.value = true; error.value = ''; uploadError.value = ''; uploadAbortController.value = new AbortController()
  try {
    // Web File objects intentionally do not expose absolute paths. Upload to
    // a session-scoped staging area first, then scan opaque source tokens.
    const reusable = targets.filter((item) => item.source_token && item.source_session_id === session.value.id)
    const pending = targets.filter((item) => !(item.source_token && item.source_session_id === session.value.id))
    let uploadedFiles = []
    if (pending.length) {
      uploadPhase.value = 'uploading'; uploadProgress.value = null; uploadBytesTotal.value = pending.reduce((sum, item) => sum + (Number(item.file?.size) || 0), 0)
      const form = new FormData(); const relativePaths = []
      pending.forEach(item => { form.append('files', item.file, item.name); relativePaths.push(renamePrefix.value ? `${renamePrefix.value}${item.relative_path}` : item.relative_path) })
      form.append('relative_paths', JSON.stringify(relativePaths))
      const uploaded = await assetImportAPI.upload(session.value.id, form, { timeout: 600000, signal: uploadAbortController.value.signal, onUploadProgress: (event) => { if (event.total) uploadProgress.value = Math.min(100, Math.round(event.loaded / event.total * 100)) } })
      uploadedFiles = uploaded.files || []
      uploadedFiles.forEach((descriptor, index) => { const item = pending[index]; if (item) { item.source_token = descriptor.source_token; item.source_session_id = session.value.id } })
    }
    const pathOf = (item) => (renamePrefix.value ? `${renamePrefix.value}${item.relative_path}` : item.relative_path)
    const descriptors = [
      ...reusable.map((item) => ({ relative_path: pathOf(item), file_name: item.name, source_token: item.source_token, bytes: item.file.size, mime_type: item.file.type })),
      ...uploadedFiles.map(item => ({ ...item, source_token: item.source_token })),
    ]
    uploadPhase.value = 'analyzing'; uploadProgress.value = null
    const classifierEnabled = classificationMode.value === 'ai'
    const res = await assetImportAPI.scan(session.value.id, {
      files: descriptors,
      classifier_enabled: classifierEnabled,
      options: {
        classifier_enabled: classifierEnabled,
        classifier_mode: classifierEnabled ? 'ai' : 'local',
        classifier_model: 'gpt-5.6-sol',
        template_id: templateId.value || session.value.options?.template_id || null,
        // 只有后端真正会读的键才进请求体：max_file_bytes 用于判超限，
        // 分类开关用 classifier_enabled / classifier_mode。包含与排除规则、
        // 类型限制、去重、重命名、默认阶段都在本页浏览器侧执行，随日志一起留档。
        max_file_bytes: maxFileMb.value ? Number(maxFileMb.value) * 1024 * 1024 : undefined,
        scan_rules: {
          include: includeRules.value.split('\n').map((line) => line.trim()).filter(Boolean),
          exclude: excludeRules.value.split('\n').map((line) => line.trim()).filter(Boolean),
          kinds: [...kindFilter.value],
          duplicates: duplicatePolicy.value,
          rename_prefix: renamePrefix.value || null,
          default_stage: defaultStage.value || null,
          applied_at: 'client',
        },
      },
    }, { timeout: 600000, signal: uploadAbortController.value.signal })
    const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = data.items || []
    applyDefaultStage()
    uploadPhase.value = 'success'; uploadProgress.value = 100
    ElMessage.success(`已分析 ${descriptors.length} 个文件，计划里共 ${items.value.length} 条`)
  } catch (e) {
    if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError' || e?.message === 'canceled') { uploadPhase.value = 'error'; uploadError.value = '本次上传已取消，已上传的文件仍保留，可点击重试。' }
    else { uploadPhase.value = 'error'; uploadError.value = e.message || '上传或分析失败'; error.value = uploadError.value }
  } finally { scanning.value = false; uploadAbortController.value = null }
}
function cancelUpload() { uploadAbortController.value?.abort() }
/* 默认阶段只补「还没识别出阶段」的行；要点「保存计划修改」才会写回后端。 */
function applyDefaultStage() {
  if (!defaultStage.value) return
  let filled = 0
  for (const row of items.value) {
    if (['excluded', 'failed'].includes(row.status)) continue
    if (row.candidate_stage) continue
    row.candidate_stage = defaultStage.value
    filled += 1
  }
  if (filled) ElMessage.info(`按默认阶段给 ${filled} 条没有阶段的条目填了「${stageLabel(defaultStage.value)}」，确认后点「保存计划修改」`)
}
async function reorganize() { if (!session.value || !reorganizeReason.value.trim()) return ElMessage.warning('请先填写整理要求'); reorganizing.value = true; try { const res = await assetImportAPI.reorganize(session.value.id, { instruction: reorganizeReason.value.trim() }); const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = plan.value.items || items.value; ElMessage.success(data.deferred ? '已保存整理要求，等待 AI 配置后重试' : 'AI 已重新整理导入计划') } catch (e) { error.value = e.message } finally { reorganizing.value = false } }
async function savePlanEdits() { if (!session.value || !items.value.length) return; savingPlan.value = true; error.value = ''; try { const res = await assetImportAPI.updatePlan(session.value.id, { expected_version: session.value.version, reason: '用户在导入预览中逐项确认类型、阶段、用途和是否导入', items: items.value.map(row => ({ id: row.id, detected_type: row.detected_type, candidate_stage: row.candidate_stage || null, candidate_scope_type: row.candidate_scope_type || 'run', candidate_scope_id: row.candidate_scope_id || '', usage_role: row.metadata?.usage_role || 'unclassified', direct_clip_candidate: row.metadata?.direct_clip_candidate === true, include: row.status !== 'excluded' })) }); const data = res.data || res; session.value = data.session; plan.value = data.plan || {}; items.value = data.items || items.value; ElMessage.success(`计划已保存（${data.changed_item_ids?.length || 0} 项更新）`) } catch (e) { error.value = e.message || '计划保存失败；可能是版本已经变化，重新读取会话后再改' } finally { savingPlan.value = false } }
async function apply() {
  const ready = items.value.filter((row) => row.status !== 'excluded').length
  try {
    const copy = targetRunId.value
      ? `将把 ${ready} 条可导入项写入制作任务 ${targetRunId.value}。这不产生生成费用；仍可通过「回滚」撤销本次导入。`
      : `将把 ${ready} 条可导入项写入制作任务；当前项目若还没有任务，会自动创建草稿任务。不会立即生成或扣费。`
    await ElMessageBox.confirm(copy, '确认导入')
    const res = await assetImportAPI.apply(session.value.id, { confirm: true, target_run_id: targetRunId.value || null }); const data = res.data || res
    session.value = data.session; targetRunId.value = data.target_run_id || session.value.target_run_id || ''
    targetDramaId.value = data.target_drama_id || session.value.options?.target_drama_id || targetDramaId.value
    ElMessage.success(data.target_drama_created ? '导入完成，已自动创建草稿项目' : data.target_run_created ? '导入完成，已自动创建草稿制作任务' : '导入完成')
  } catch (e) { if (e !== 'cancel') error.value = e.message }
}
async function rollback() {
  try {
    await ElMessageBox.confirm('回滚会软删除本次创建的资产并移除导入副本，已导入的素材会从项目里消失。原磁盘文件不动。', '确认回滚', { type: 'warning' })
    const res = await assetImportAPI.rollback(session.value.id); session.value = (res.data || res).session; ElMessage.success('已回滚')
  } catch (e) { if (e !== 'cancel') error.value = e.message }
}
onMounted(async () => {
  folderPickerSupported.value = 'webkitdirectory' in document.createElement('input')
  targetRunId.value = typeof route.query.target_run_id === 'string' ? route.query.target_run_id : ''
  targetDramaId.value = typeof route.query.drama_id === 'string' ? route.query.drama_id : ''
  targetEpisodeId.value = typeof route.query.episode_id === 'string' ? route.query.episode_id : ''
  sourceLabel.value = typeof route.query.source_label === 'string' ? route.query.source_label : ''
  loadRules()
  await loadSessions()
  try { const result = await templatesAPI.list(); templates.value = result?.items || []; if (templateId.value && !templates.value.some((item) => String(item.id) === String(templateId.value))) templateId.value = '' } catch (_) { templates.value = [] }
  if (route.query.picker === 'folder') await nextTick(() => chooseFolder())
  if (route.query.picker === 'files') await nextTick(() => fileInput.value?.click())
})
</script>
<style scoped>
.page{min-height:100vh;padding:36px clamp(20px,5vw,72px);background:var(--bg-page);color:var(--text-primary)}
.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:18px}
.kicker{color:var(--text-subtle);font-weight:600;letter-spacing:.02em;font-size:12px;margin:0}
.hero h1{margin:8px 0;font-size:32px;font-family:var(--font-display);line-height:1.3}
.sub{color:var(--text-muted);font-size:13px;line-height:1.8;margin:0;max-width:78ch}
.scope-note{max-width:1180px;margin:0 auto 8px;padding:11px 14px;border:1px solid var(--border-color);border-left:2px solid var(--border-bright);border-radius:var(--radius-sm);background:var(--bg-inner)}
.scope-note p{margin:0;max-width:104ch;color:var(--text-muted);font-size:12px;line-height:1.75}
.card{max-width:1180px;margin:16px auto;border:1px solid var(--border-color);border-radius:var(--radius-md);background:var(--bg-card)}
.form-row,.card-head,.actions,.stats{display:flex;gap:12px;align-items:center}
.form-row>*{flex:1}
.form-row .el-button{flex:0 0 auto}
/* 扫描规则区：实色面板 + 一根线，信息层级靠分隔线 */
.rules{margin-top:20px;padding-top:16px;border-top:1px solid var(--border-color);display:grid;gap:14px}
.rules-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.rules-head h2{margin:0;font-size:15px;font-family:var(--font-display)}
.rules-head p{margin:6px 0 0;color:var(--text-muted);font-size:12px;line-height:1.7;max-width:74ch}
.rules-buttons{display:flex;gap:8px;flex-wrap:wrap}
.rules-buttons .el-button+.el-button{margin-left:0}
.rules-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.rules-grid-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.rules-field{display:grid;gap:7px;font-size:12px;color:var(--text-muted)}
.rules-field>span{display:grid;gap:3px}
.rules-field em{color:var(--text-subtle);font-style:normal;font-size:11px;line-height:1.6}
.rules-field :deep(.el-input-number){width:100%}
/* 覆盖 Element Plus 内联的输入框宽度，否则数字框只显示最小值、看不清单位 */
.rules-field :deep(.el-input-number .el-input__inner){text-align:left;padding-left:12px}
.rules-summary{margin:0;padding:9px 11px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-inner);color:var(--text-muted);font-size:12px;line-height:1.75}
.rules-error{margin:0;padding:9px 11px;border:1px solid var(--ui-danger);border-radius:var(--radius-sm);color:var(--ui-danger);font-size:12px}
.num{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.choose-row{display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap;margin-top:18px}
.choose-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hint{display:block;margin-top:10px;color:var(--text-subtle);font-size:12px;line-height:1.7}
/* 扫描预览 */
.scan-preview{margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color);display:grid;gap:12px}
.preview-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap}
.preview-head h2{margin:0;font-size:15px;font-family:var(--font-display)}
.preview-head p{margin:6px 0 0;color:var(--text-muted);font-size:12px;line-height:1.7;max-width:74ch}
.preview-stats{display:flex;gap:16px;flex-wrap:wrap;color:var(--text-muted);font-size:12px}
.preview-stats b{color:var(--text-primary);font-family:var(--font-mono);font-variant-numeric:tabular-nums}
.preview-stats b.warn{color:var(--ui-warning)}
.excluded-list{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 11px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-inner)}
.excluded-label{color:var(--text-subtle);font-size:12px}
.excluded-more{color:var(--text-subtle);font-size:12px}
.preview-more{display:flex}
.preview-pager{display:flex;align-items:center;gap:10px;justify-content:flex-end;color:var(--text-muted);font-size:12px}
.preview-pager .el-button+.el-button{margin-left:0}
.selection-summary{display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:11px 12px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-inner);color:var(--text-muted);font-size:13px}
.selection-summary strong{color:var(--text-primary)}
.selection-summary .el-button{margin-left:auto}
.selected-files{display:grid;gap:6px;max-height:260px;overflow:auto;padding:8px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-inner)}
.selected-file{display:grid;grid-template-columns:26px minmax(0,1fr) auto auto 64px;align-items:center;gap:8px;min-width:0;padding:7px 8px;border-radius:var(--radius-sm);background:var(--bg-card)}
.selected-file:hover{background:var(--bg-hover)}
.file-kind{display:grid;place-items:center;width:24px;height:24px;border-radius:var(--radius-sm);background:var(--bg-inner);color:var(--ui-accent);font-size:12px;font-weight:700}
.file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary);font-size:12px}
.file-size{color:var(--text-subtle);font-size:12px;white-space:nowrap}
.upload-status{margin-top:14px;padding:12px 14px;border:1px solid var(--border-color);border-left:2px solid var(--border-bright);border-radius:var(--radius-sm);background:var(--bg-inner)}
.upload-status.is-success{border-left-color:var(--ui-success)}
.upload-status.is-error{border-left-color:var(--ui-danger)}
.upload-status-head{display:flex;justify-content:space-between;gap:12px;color:var(--text-primary);font-size:13px}
.upload-status.is-success .upload-status-head{color:var(--ui-success)}
.upload-status.is-error .upload-status-head{color:var(--ui-danger)}
.upload-status p{margin:8px 0 0;color:var(--text-muted);font-size:12px;line-height:1.6}
.upload-status-actions{display:flex;justify-content:flex-end;margin-top:5px}
.card-head{justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:12px}
.card-head h2{margin:0 0 0 0;font-size:16px;font-family:var(--font-display)}
.card-head small.revision{margin-left:10px;color:var(--text-subtle)}
.stats{padding:12px 0;flex-wrap:wrap;color:var(--text-muted);font-size:12px}
.stats span{padding:7px 12px;background:var(--bg-inner);border:1px solid var(--border-color);border-radius:var(--radius-sm)}
.stats b{color:var(--text-primary)}
.conflicts{margin-top:16px}
.reorganize-row{display:flex;gap:12px;margin:12px 0}
.reorganize-row .el-input{flex:1}
.plan-filters{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 10px;padding:9px 11px;border:1px solid var(--border-color);border-radius:var(--radius-sm);background:var(--bg-inner)}
.plan-filters .plan-search{max-width:280px}
.plan-empty{margin:10px 0 0;color:var(--text-muted);font-size:12px}
.scope-cell{display:flex;gap:4px;align-items:center}
.scope-cell .el-input{width:82px}
.clip-hint{display:block;margin-top:4px;color:var(--text-subtle);font-size:11px}
.recent-imports{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--border-color)}
.recent-label{font-size:12px;color:var(--text-subtle)}
@media(max-width:900px){.rules-grid,.rules-grid-3{grid-template-columns:1fr}.preview-stats{width:100%}}
@media(max-width:720px){.page{padding:24px 14px}.hero{align-items:flex-start;flex-direction:column}.hero h1{font-size:26px}.form-row{align-items:stretch;flex-direction:column}.form-row .el-button{width:100%}.choose-row{align-items:stretch;flex-direction:column}.choose-actions{display:grid;grid-template-columns:1fr 1fr}.choose-actions .el-button{margin-left:0}.selection-summary .el-button{width:100%;margin-left:0}.selected-file{grid-template-columns:26px minmax(0,1fr) auto 56px}.selected-file .el-tag{display:none}.file-size{grid-column:2;grid-row:2}.card-head{align-items:flex-start;flex-direction:column}.actions{width:100%;flex-wrap:wrap}.actions .el-button{margin-left:0;flex:1 1 140px}.plan-filters{align-items:stretch;flex-direction:column}.plan-filters .plan-search{max-width:none}.reorganize-row{align-items:stretch;flex-direction:column}}
.target-hint{margin:6px 0 0;color:var(--text-muted);font-size:12px;line-height:1.5}
</style>
