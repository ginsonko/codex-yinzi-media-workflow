<template>
  <div class="advanced-page">


    <main class="advanced-main">
      <section class="page-intro">
        <div>
          <span class="eyebrow">可控、可迁移、可回滚</span>
          <h1>高级设置</h1>
          <p>把工作流的系统提示词、自动化、通知、价格与预算、备份和迁移放在一个地方管理。普通用户可以保持默认，高标准制作时再逐项调整。</p>
        </div>
        <div class="intro-actions">
          <el-button :icon="Download" @click="exportBundleFile">导出完整配置</el-button>
          <el-button :icon="Upload" @click="bundleInput?.click()">导入配置</el-button>
          <input ref="bundleInput" type="file" accept=".json,application/json" hidden @change="readBundleFile" />
        </div>
      </section>

      <section class="health-strip" aria-label="配置摘要">
        <div><span>提示词</span><strong>{{ summary.prompts.customized || 0 }} / {{ summary.prompts.total || 0 }} 已自定义</strong></div>
        <div><span>价格目录</span><strong>{{ summary.prices.total || 0 }} 条<span v-if="summary.prices.automatic"> · {{ summary.prices.automatic }} 条自动目录</span></strong></div>
        <div><span>新任务预算</span><strong>{{ budgetLabel }}</strong></div>
        <div><span>备份</span><strong>{{ summary.backup.total || 0 }} 个快照</strong></div>
      </section>

      <el-tabs v-model="activeTab" class="advanced-tabs">
        <el-tab-pane label="系统提示词" name="prompts">
          <section class="settings-section">
            <div class="section-heading">
              <div><h2>系统提示词</h2><p>修改的是可编辑部分；输出 JSON 结构、变量和技术边界仍由系统契约锁定。</p></div>
              <div class="section-actions">
                <el-button :icon="Download" @click="exportPromptFile">导出提示词</el-button>
                <el-button :icon="Upload" @click="promptInput?.click()">导入提示词</el-button>
                <input ref="promptInput" type="file" accept=".json,application/json" hidden @change="readPromptFile" />
              </div>
            </div>
            <div class="prompt-layout">
              <aside class="prompt-sidebar">
                <el-input v-model="promptSearch" clearable placeholder="搜索提示词" :prefix-icon="Search" />
                <div class="prompt-category-list">
                  <button v-for="category in promptCategories" :key="category.key" type="button" :class="['category-button', { active: promptCategory === category.key }]" @click="promptCategory = category.key">
                    <span>{{ category.label }}</span><small>{{ category.count }}</small>
                  </button>
                </div>
                <div class="prompt-list">
                  <button v-for="item in filteredPrompts" :key="item.id" type="button" :class="['prompt-item', { active: selectedPromptId === item.id }]" @click="selectPrompt(item.id)">
                    <strong>{{ item.name }}</strong><small>{{ item.is_customized ? '已自定义' : '使用默认值' }}</small>
                  </button>
                  <p v-if="!filteredPrompts.length" class="empty-note">没有匹配的提示词</p>
                </div>
              </aside>
              <div v-if="selectedPrompt" class="prompt-editor-panel">
                <div class="editor-heading">
                  <div><span class="editor-category">{{ categoryLabel(selectedPrompt.category) }}</span><h3>{{ selectedPrompt.name }}</h3><p>{{ selectedPrompt.description }}</p></div>
                  <el-tag :type="selectedPrompt.is_customized ? 'warning' : 'info'" effect="plain">{{ selectedPrompt.is_customized ? '已覆盖默认' : '默认内容' }}</el-tag>
                </div>
                <div class="editor-meta">
                  <span><b>ID</b><code>{{ selectedPrompt.id }}</code></span>
                  <span><b>版本</b>v{{ selectedPrompt.version }}</span>
                  <span><b>可用变量</b>{{ promptVariablesLabel(selectedPrompt) }}</span>
                </div>
                <el-input v-model="promptDraft" type="textarea" :rows="18" resize="vertical" placeholder="编辑可配置的系统提示词" />
                <div class="editor-footer">
                  <span>最后修改：{{ formatDate(selectedPrompt.updated_at) || '尚未修改' }}</span>
                  <div><el-button @click="resetSelectedPrompt">恢复默认</el-button><el-button type="primary" :loading="savingPrompt" @click="saveSelectedPrompt">保存提示词</el-button></div>
                </div>
                <el-alert v-if="selectedPrompt.locked_suffix" type="info" :closable="false" show-icon title="技术输出契约已锁定" class="locked-note">{{ selectedPrompt.locked_suffix }}</el-alert>
              </div>
              <div v-else class="empty-editor">选择左侧提示词开始编辑</div>
            </div>
          </section>
        </el-tab-pane>

        <el-tab-pane label="自动化与通知" name="automation">
          <section class="settings-section">
            <div class="section-heading">
              <div><h2>自动化与通知</h2><p>控制独立 AI 审批的并发速度、无人值守提醒，以及视频内容审核失败后的授权兜底。</p></div>
              <el-button type="primary" :loading="savingAutomation" @click="saveAutomationPreferences">保存自动化设置</el-button>
            </div>

            <div class="automation-settings-grid">
              <article class="automation-setting-card">
                <div class="setting-card-heading">
                  <span class="setting-icon"><el-icon><Operation /></el-icon></span>
                  <div><strong>AI 审批并发</strong><p>角色、场景、道具和相互独立的资源图可同时审批；分镜和逐镜视频仍按依赖顺序处理。</p></div>
                </div>
                <div class="setting-control-line">
                  <label for="review-concurrency">同时审批任务数</label>
                  <el-input-number id="review-concurrency" v-model="automationDraft.review_concurrency" :min="1" :precision="0" controls-position="right" />
                </div>
                <small>推荐 3。提高并发会更快，也会增加文本模型的瞬时请求量。</small>
              </article>

              <article class="automation-setting-card">
                <div class="setting-card-heading">
                  <span class="setting-icon"><el-icon><Refresh /></el-icon></span>
                  <div><strong>新任务自动返工上限</strong><p>AI 打回后会把理由作为下一版的必修项继续生成；达到上限才请你介入。这里只影响之后新建的任务。</p></div>
                </div>
                <div class="setting-control-line">
                  <label for="review-rejection-limit">同一对象连续打回</label>
                  <el-input-number id="review-rejection-limit" v-model="automationDraft.max_consecutive_review_rejections" :min="1" :max="20" controls-position="right" />
                </div>
                <small>默认 5 次。已有任务可在任务页“模型、Key 与制作设置”中单独调整每个阶段。</small>
              </article>

              <article class="automation-setting-card">
                <div class="setting-card-heading">
                  <span class="setting-icon"><el-icon><Operation /></el-icon></span>
                  <div><strong>新任务故障恢复上限</strong><p>明确可安全重试的临时故障由系统自行分析和恢复；排队、等待和状态收敛不计入失败次数。</p></div>
                </div>
                <div class="setting-control-line">
                  <label for="recovery-failure-limit">同一对象连续恢复</label>
                  <el-input-number id="recovery-failure-limit" v-model="automationDraft.max_consecutive_recovery_failures" :min="1" :max="20" controls-position="right" />
                </div>
                <small>默认 5 次。不确定是否已扣费的外部任务仍会停止重复提交，避免重复扣费。</small>
              </article>

              <article class="automation-setting-card">
                <div class="setting-card-heading">
                  <span class="setting-icon"><el-icon><Bell /></el-icon></span>
                  <div><strong>无人值守提醒</strong><p>只在成片完成或系统确认必须由人处理时提醒；排队、轮询和自动恢复不会打扰你。</p></div>
                </div>
                <div class="switch-setting"><span><b>应用内通知</b><small>完成为绿色通知，人工介入为警示通知</small></span><el-switch v-model="automationDraft.notifications_enabled" /></div>
                <div class="switch-setting"><span><b>提示音</b><small>两种结果使用不同节奏；浏览器禁播时仍保留可见通知</small></span><el-switch v-model="automationDraft.notification_sound_enabled" :disabled="!automationDraft.notifications_enabled" /></div>
              </article>
            </div>

            <article class="moderation-fallback-panel">
              <div class="setting-card-heading">
                <span class="setting-icon is-warning"><el-icon><Switch /></el-icon></span>
                <div>
                  <strong>视频审核拒绝自动兜底</strong>
                  <p>普通视频模型明确返回内容审核、风控或安全策略拒绝时，自动改用你指定的更易通过审核模型。超时、排队和普通服务波动不会误触发。</p>
                </div>
                <el-switch v-model="automationDraft.moderation_fallback_enabled" />
              </div>
              <div class="fallback-controls">
                <div>
                  <label>兜底视频模型</label>
                  <el-select
                    v-model="automationDraft.moderation_fallback_model"
                    filterable
                    allow-create
                    default-first-option
                    placeholder="选择或输入真实模型名"
                    :disabled="!automationDraft.moderation_fallback_enabled"
                  >
                    <el-option
                      v-for="option in fallbackModelOptions"
                      :key="option.value"
                      :label="option.label"
                      :value="option.value"
                    />
                  </el-select>
                </div>
                <div class="fallback-receipt">
                  <el-tag :type="automationDraft.moderation_fallback_enabled ? 'warning' : 'info'" effect="plain">
                    {{ automationDraft.moderation_fallback_enabled ? '已授权自动切换' : '默认关闭' }}
                  </el-tag>
                  <span>{{ fallbackAuthorizationText }}</span>
                </div>
              </div>
              <el-alert
                :type="isExpensiveFallback ? 'warning' : 'info'"
                :closable="false"
                show-icon
                :title="isExpensiveFallback
                  ? '当前选择包含破甲等高价模型：开启并保存即表示允许在内容审核拒绝时自动使用，但仍受每个任务的金额上限约束。'
                  : '默认推荐 480p fast；开关默认关闭。兜底模型仍需兼容该镜头的时长和参考媒体，并受任务金额上限约束。'"
              />
            </article>
          </section>
        </el-tab-pane>

        <el-tab-pane label="价格与预算" name="costs">
          <section class="settings-section">
            <div class="section-heading"><div><h2>价格与预算</h2><p>每个外部动作在提交前先预留费用，成功后结算，明确失败释放，不确定结果保留待对账。</p></div><div class="section-actions"><el-button :icon="Plus" @click="openPriceDialog()">添加兼容站价格</el-button><el-button :icon="Refresh" :loading="syncingPrices" @click="syncPrices">同步 YinziAPI 价格目录</el-button></div></div>
            <div class="budget-panel">
              <div><strong>新任务默认金额上限</strong><p>只影响之后创建的新任务；已存在任务保持自己的授权上限。</p></div>
              <div class="budget-controls"><el-input-number v-model="budgetDraft.max_cost_usd" :min="0" :max="1000000" :precision="6" :step="0.1" controls-position="right" placeholder="不限额" /><span>USD</span><el-checkbox v-model="budgetDraft.allow_unknown_price">允许未定价模型提交</el-checkbox><el-button type="primary" :loading="savingBudget" @click="saveBudget">保存默认预算</el-button></div>
            </div>
            <div class="price-toolbar"><el-input v-model="priceSearch" clearable placeholder="按提供商、服务类型或模型搜索" :prefix-icon="Search" /><el-select v-model="priceServiceType" clearable placeholder="服务类型"><el-option label="文本" value="text" /><el-option label="图片" value="image" /><el-option label="视频" value="video" /><el-option label="TTS" value="tts" /></el-select></div>
            <el-table v-loading="pricesLoading" :data="filteredPrices" stripe class="price-table">
              <el-table-column prop="provider" label="提供商" width="110" />
              <el-table-column prop="service_type" label="服务" width="100" />
              <el-table-column prop="model" label="模型" min-width="170" show-overflow-tooltip />
              <el-table-column prop="group_name" label="分组" min-width="130" show-overflow-tooltip />
              <el-table-column label="计费" min-width="150"><template #default="{ row }">{{ priceLabel(row) }}</template></el-table-column>
              <el-table-column label="来源" width="110"><template #default="{ row }"><el-tag size="small" :type="row.source === 'yinzi-auto' ? 'success' : 'info'" effect="plain">{{ row.source === 'yinzi-auto' ? 'Yinzi 自动' : '手动维护' }}</el-tag></template></el-table-column>
              <el-table-column label="状态" width="80"><template #default="{ row }"><el-tag size="small" :type="row.enabled ? 'success' : 'danger'" effect="plain">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
              <el-table-column label="操作" width="100"><template #default="{ row }"><el-button v-if="row.source !== 'yinzi-auto'" link type="primary" @click="openPriceDialog(row)">编辑</el-button><span v-else class="auto-price-note">自动管理</span></template></el-table-column>
            </el-table>
            <p v-if="!filteredPrices.length && !pricesLoading" class="empty-note">暂无价格目录。YinziAPI 可自动同步，其它 OpenAI 兼容站点可点击“添加兼容站价格”手动维护。</p>
          </section>
        </el-tab-pane>

        <el-tab-pane label="备份与迁移" name="backups">
          <section class="settings-section">
            <div class="section-heading"><div><h2>备份与迁移</h2><p>导出包不包含 API Key、Token、Cookie 或本机绝对路径；在新设备导入后只需补填密钥。</p></div><el-button type="primary" :icon="Plus" :loading="creatingBackup" @click="createManualBackup">立即创建快照</el-button></div>
            <div class="migration-actions"><el-button :icon="Download" @click="exportBundleFile">导出完整配置包</el-button><el-button :icon="Upload" @click="bundleInput?.click()">导入配置包</el-button><span>导入必须先预览差异，再一次性应用。</span></div>
            <el-table v-loading="backupsLoading" :data="backups.items || []" stripe class="backup-table">
              <el-table-column prop="id" label="#" width="70" />
              <el-table-column label="类型" width="120"><template #default="{ row }"><el-tag size="small" effect="plain">{{ snapshotTypeLabel(row.snapshot_type) }}</el-tag></template></el-table-column>
              <el-table-column prop="reason" label="原因" min-width="240" show-overflow-tooltip />
              <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ formatDate(row.created_at) }}</template></el-table-column>
              <el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" :disabled="row.snapshot_type === 'pre_import'" @click="previewSnapshot(row)">预览回滚</el-button></template></el-table-column>
            </el-table>
            <p v-if="!(backups.items || []).length && !backupsLoading" class="empty-note">还没有快照。修改提示词、预算或配置包前系统也会自动创建保护快照。</p>
          </section>
        </el-tab-pane>
      </el-tabs>
    </main>

    <el-dialog v-model="previewVisible" :title="previewTitle" width="min(760px, 94vw)" :close-on-click-modal="false">
      <div v-if="previewError" class="dialog-error">{{ previewError }}</div>
      <template v-else-if="previewData">
        <el-alert v-if="previewData.warnings?.length" type="warning" :closable="false" show-icon title="导入提醒"><template #default><div v-for="warning in previewData.warnings" :key="warning">{{ warning }}</div></template></el-alert>
        <div class="diff-summary"><div v-for="item in diffItems" :key="item.key"><strong>{{ item.label }}</strong><span>{{ item.changed }} 项发生变化</span></div></div>
        <pre class="preview-json">{{ JSON.stringify(previewData.diff || previewData, null, 2) }}</pre>
      </template>
      <template #footer><el-button @click="previewVisible = false">取消</el-button><el-button type="primary" :loading="applyingPreview" :disabled="!previewData?.token && !previewAction" @click="applyPreviewAction">确认应用</el-button></template>
    </el-dialog>

    <el-dialog v-model="priceDialogVisible" :title="editingPrice ? '编辑手动价格' : '添加兼容站价格'" width="min(620px, 94vw)" :close-on-click-modal="false">
      <el-form label-position="top" class="price-form">
        <div class="price-form-grid">
          <el-form-item label="提供商标识" required><el-input v-model="priceForm.provider" :disabled="editingPrice" placeholder="例如 other-api" /></el-form-item>
          <el-form-item label="服务类型" required><el-select v-model="priceForm.service_type" :disabled="editingPrice"><el-option label="文本" value="text" /><el-option label="图片" value="image" /><el-option label="视频" value="video" /><el-option label="TTS" value="tts" /></el-select></el-form-item>
          <el-form-item label="模型名称" required><el-input v-model="priceForm.model" :disabled="editingPrice" placeholder="必须和实际请求模型一致" /></el-form-item>
          <el-form-item label="分组（可选）"><el-input v-model="priceForm.group_name" :disabled="editingPrice" placeholder="留空为通用价格" /></el-form-item>
          <el-form-item label="计价单位" required><el-select v-model="priceForm.billing_unit" :disabled="editingPrice"><el-option label="每次请求" value="per_request" /><el-option label="每张图片" value="per_image" /><el-option label="每秒视频" value="per_second" /><el-option label="每字符 TTS" value="per_character" /><el-option label="每 1K token" value="per_1k_tokens" /></el-select></el-form-item>
          <el-form-item label="启用"><el-switch v-model="priceForm.enabled" /></el-form-item>
        </div>
        <div v-if="priceForm.billing_unit === 'per_1k_tokens'" class="price-form-grid"><el-form-item label="输入价格（USD / 1K token）"><el-input-number v-model="priceForm.input_price_usd" :min="0" :precision="6" :step="0.001" /></el-form-item><el-form-item label="输出价格（USD / 1K token）"><el-input-number v-model="priceForm.output_price_usd" :min="0" :precision="6" :step="0.001" /></el-form-item></div>
        <el-form-item v-else label="单价（USD）" required><el-input-number v-model="priceForm.unit_price_usd" :min="0" :precision="6" :step="0.01" /></el-form-item>
        <el-alert type="info" :closable="false" show-icon title="模型名和计价单位必须与真实调用一致；系统会在动作提交时冻结价格快照，之后修改目录不会改写历史账单。" />
      </el-form>
      <template #footer><el-button @click="priceDialogVisible = false">取消</el-button><el-button type="primary" :loading="priceSaving" @click="savePrice">保存价格</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, Download, House, Operation, Plus, Refresh, Search, Setting, Switch, Upload } from '@element-plus/icons-vue'
import { advancedSettingsAPI } from '@/api/advancedSettings'
import { aiAPI } from '@/api/ai'
import { normalizeProductionNotificationPreferences } from '@/utils/productionNotifications'

const router = useRouter()
const loading = ref(false)
const activeTab = ref('prompts')
const summary = reactive({ prompts: {}, prices: {}, budget_defaults: {}, backup: {} })
const prompts = ref([])
const promptSearch = ref('')
const promptCategory = ref('all')
const selectedPromptId = ref('')
const promptDraft = ref('')
const savingPrompt = ref(false)
const prices = ref([])
const pricesLoading = ref(false)
const priceSearch = ref('')
const priceServiceType = ref('')
const syncingPrices = ref(false)
const priceDialogVisible = ref(false)
const priceSaving = ref(false)
const editingPrice = ref(false)
const priceForm = reactive({ provider: '', service_type: 'video', model: '', group_name: '', billing_unit: 'per_second', unit_price_usd: null, input_price_usd: null, output_price_usd: null, enabled: true })
const budgetDraft = reactive({ max_cost_usd: null, allow_unknown_price: false })
const savingBudget = ref(false)
const automationDraft = reactive(normalizeProductionNotificationPreferences())
const savingAutomation = ref(false)
const automationVideoModels = ref([])
const backups = reactive({ items: [], pagination: {} })
const backupsLoading = ref(false)
const creatingBackup = ref(false)
const promptInput = ref(null)
const bundleInput = ref(null)
const previewVisible = ref(false)
const previewTitle = ref('导入预览')
const previewData = ref(null)
const previewError = ref('')
const previewAction = ref(null)
const applyingPreview = ref(false)

const CATEGORY_LABELS = Object.freeze({ all: '全部', story: '剧本', assets: '资源', storyboard: '分镜', director: '导演台', assist: '帮写', review: '审核', automation: '自动化', video: '视频', image: '生图' })
const promptCategories = computed(() => [{ key: 'all', label: '全部', count: prompts.value.length }, ...Object.entries(CATEGORY_LABELS).filter(([key]) => key !== 'all').map(([key, label]) => ({ key, label, count: prompts.value.filter((item) => item.category === key).length })).filter((item) => item.count)])
const filteredPrompts = computed(() => prompts.value.filter((item) => (promptCategory.value === 'all' || item.category === promptCategory.value) && (!promptSearch.value.trim() || `${item.name} ${item.id} ${item.description}`.toLowerCase().includes(promptSearch.value.trim().toLowerCase()))))
const selectedPrompt = computed(() => prompts.value.find((item) => item.id === selectedPromptId.value) || null)
const filteredPrices = computed(() => prices.value.filter((item) => (!priceServiceType.value || item.service_type === priceServiceType.value) && (!priceSearch.value.trim() || `${item.provider} ${item.service_type} ${item.model} ${item.group_name || ''}`.toLowerCase().includes(priceSearch.value.trim().toLowerCase()))))
const budgetLabel = computed(() => budgetDraft.max_cost_usd == null || budgetDraft.max_cost_usd === '' ? '不限额' : `${Number(budgetDraft.max_cost_usd).toFixed(4)} USD`)
const diffItems = computed(() => Object.entries(previewData.value?.diff || {}).map(([key, value]) => ({ key, label: key, changed: Array.isArray(value) ? value.filter((item) => item.changed !== false).length : 0 })))
const fallbackModelOptions = computed(() => {
  const models = new Set([
    'mg-seedance2.0 -480p fast',
    'mg-seedance2.0 -480p mini',
    '破甲seedance 720p-fast',
    ...automationVideoModels.value,
    automationDraft.moderation_fallback_model,
  ].map((item) => String(item || '').trim()).filter(Boolean))
  return [...models].map((value) => ({
    value,
    label: value === 'mg-seedance2.0 -480p fast'
      ? `${value}（默认推荐）`
      : /破甲/i.test(value) ? `${value}（高价）` : value,
  }))
})
const isExpensiveFallback = computed(() => /破甲|bypass|uncensored/i.test(automationDraft.moderation_fallback_model || ''))
const fallbackAuthorizationText = computed(() => {
  if (!automationDraft.moderation_fallback_enabled) return '审核失败仍按普通自动诊断、改词和兼容换模处理，不会使用指定兜底。'
  return `仅在明确内容审核拒绝时允许切换到 ${automationDraft.moderation_fallback_model || '指定模型'}。`
})

function categoryLabel(category) { return CATEGORY_LABELS[category] || category || '其它' }
function promptVariablesLabel(prompt) { return prompt?.variables?.length ? prompt.variables.map((item) => `{{${item}}}`).join('、') : '无' }
function formatDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '' }
function snapshotTypeLabel(type) { return ({ automatic: '自动快照', manual: '手动快照', pre_import: '导入前保护', pre_rollback: '回滚前保护' }[type] || type || '快照') }
function priceLabel(row) {
  if (row.billing_unit === 'per_1k_tokens') return `输入 ${row.input_price_usd ?? '-'} / 输出 ${row.output_price_usd ?? '-'} USD / 1K token`
  return `${row.unit_price_usd ?? '-'} USD / ${row.billing_unit || '次'}`
}
function selectPrompt(id) { selectedPromptId.value = id; promptDraft.value = prompts.value.find((item) => item.id === id)?.current_content || prompts.value.find((item) => item.id === id)?.default_content || '' }
async function loadAll() {
  loading.value = true
  try {
    const [summaryResult, promptResult, priceResult, budgetResult, automationResult, backupResult, catalogResult] = await Promise.all([
      advancedSettingsAPI.summary(), advancedSettingsAPI.listPrompts(), advancedSettingsAPI.listPrices(), advancedSettingsAPI.getBudgetDefaults(), advancedSettingsAPI.getAutomationPreferences(), advancedSettingsAPI.listBackups({ page: 1, page_size: 30 }), aiAPI.getYinziCatalog().catch(() => null),
    ])
    Object.assign(summary, summaryResult || {})
    prompts.value = promptResult?.prompts || []
    if (!selectedPromptId.value && prompts.value[0]) selectPrompt(prompts.value[0].id)
    prices.value = priceResult?.items || []
    Object.assign(budgetDraft, { max_cost_usd: budgetResult?.max_cost_usd ?? null, allow_unknown_price: Boolean(budgetResult?.allow_unknown_price) })
    Object.assign(automationDraft, normalizeProductionNotificationPreferences(automationResult || summaryResult?.automation_preferences))
    automationVideoModels.value = (catalogResult?.video || []).map((item) => item.model || item.name).filter(Boolean)
    Object.assign(backups, backupResult || {})
  } catch (error) { ElMessage.error(error.message || '高级设置加载失败') } finally { loading.value = false }
}
async function saveSelectedPrompt() {
  if (!selectedPrompt.value) return
  savingPrompt.value = true
  try { const result = await advancedSettingsAPI.updatePrompt(selectedPrompt.value.id, promptDraft.value); const index = prompts.value.findIndex((item) => item.id === selectedPrompt.value.id); if (result?.prompt && index >= 0) prompts.value[index] = result.prompt; ElMessage.success('提示词已保存'); await refreshSummaryAndBackups() } catch (error) { ElMessage.error(error.message || '提示词保存失败') } finally { savingPrompt.value = false }
}
async function resetSelectedPrompt() {
  if (!selectedPrompt.value) return
  try { await ElMessageBox.confirm('恢复后会清除这个提示词的自定义内容，系统会自动保留保护快照。继续吗？', '恢复默认', { type: 'warning' }); const result = await advancedSettingsAPI.resetPrompt(selectedPrompt.value.id); const index = prompts.value.findIndex((item) => item.id === selectedPrompt.value.id); if (result?.prompt && index >= 0) prompts.value[index] = result.prompt; promptDraft.value = result?.prompt?.default_content || ''; ElMessage.success('已恢复默认提示词'); await refreshSummaryAndBackups() } catch (_) {}
}
function downloadJson(data, filename) { const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url) }
async function exportPromptFile() { try { downloadJson(await advancedSettingsAPI.exportPrompts(), `yinzi-prompts-${new Date().toISOString().slice(0, 10)}.json`) } catch (error) { ElMessage.error(error.message || '提示词导出失败') } }
async function exportBundleFile() { try { downloadJson(await advancedSettingsAPI.exportBundle(), `yinzi-workflow-config-${new Date().toISOString().slice(0, 10)}.json`) } catch (error) { ElMessage.error(error.message || '配置导出失败') } }
function readFile(file, callback) { if (!file) return; const reader = new FileReader(); reader.onload = () => { try { callback(JSON.parse(String(reader.result || ''))) } catch (_) { ElMessage.error('文件不是有效 JSON') } }; reader.onerror = () => ElMessage.error('读取文件失败'); reader.readAsText(file, 'utf-8') }
function readPromptFile(event) { readFile(event.target.files?.[0], async (bundle) => { event.target.value = ''; try { const result = await advancedSettingsAPI.previewPromptImport(bundle); previewTitle.value = '提示词导入预览'; previewData.value = { ...result, bundle, token: null }; previewAction.value = { type: 'prompt', bundle }; previewError.value = ''; previewVisible.value = true } catch (error) { ElMessage.error(error.message || '提示词预览失败') } }) }
function readBundleFile(event) { readFile(event.target.files?.[0], async (bundle) => { event.target.value = ''; try { const result = await advancedSettingsAPI.previewBundle(bundle); previewTitle.value = '完整配置导入预览'; previewData.value = { ...result, bundle }; previewAction.value = { type: 'bundle', token: result.token }; previewError.value = ''; previewVisible.value = true } catch (error) { ElMessage.error(error.message || '配置包预览失败') } }) }
async function applyPreviewAction() {
  if (!previewAction.value) return
  applyingPreview.value = true
  try {
    if (previewAction.value.type === 'prompt') await advancedSettingsAPI.applyPromptImport(previewAction.value.bundle)
    else if (previewAction.value.type === 'rollback') await advancedSettingsAPI.rollback(previewAction.value.id, previewAction.value.token)
    else await advancedSettingsAPI.applyBundle(previewAction.value.token)
    previewVisible.value = false; previewAction.value = null; ElMessage.success('配置已应用'); await loadAll()
  } catch (error) { ElMessage.error(error.message || '配置应用失败') } finally { applyingPreview.value = false }
}
async function saveBudget() { savingBudget.value = true; try { await advancedSettingsAPI.updateBudgetDefaults({ max_cost_usd: budgetDraft.max_cost_usd, allow_unknown_price: budgetDraft.allow_unknown_price }); ElMessage.success('新任务默认预算已保存'); await refreshSummaryAndBackups() } catch (error) { ElMessage.error(error.message || '预算保存失败') } finally { savingBudget.value = false } }
async function saveAutomationPreferences() {
  if (automationDraft.moderation_fallback_enabled && !automationDraft.moderation_fallback_model.trim()) return ElMessage.warning('请填写兜底视频模型')
  savingAutomation.value = true
  try {
    const result = await advancedSettingsAPI.updateAutomationPreferences(automationDraft)
    Object.assign(automationDraft, normalizeProductionNotificationPreferences(result?.preferences || automationDraft))
    ElMessage.success('自动化与通知设置已保存')
    await refreshSummaryAndBackups()
  } catch (error) { ElMessage.error(error.message || '自动化设置保存失败') } finally { savingAutomation.value = false }
}
async function syncPrices() { syncingPrices.value = true; try { const result = await advancedSettingsAPI.syncYinziPrices(); ElMessage.success(`已同步 ${result.imported || 0} 条价格`); await loadAll() } catch (error) { ElMessage.error(error.message || '价格同步失败') } finally { syncingPrices.value = false } }
function openPriceDialog(row = null) {
  editingPrice.value = Boolean(row)
  Object.assign(priceForm, row ? {
    provider: row.provider || '', service_type: row.service_type || 'video', model: row.model || '', group_name: row.group_name || '', billing_unit: row.billing_unit || 'per_request',
    unit_price_usd: row.unit_price_usd ?? null, input_price_usd: row.input_price_usd ?? null, output_price_usd: row.output_price_usd ?? null, enabled: row.enabled !== false,
  } : { provider: '', service_type: 'video', model: '', group_name: '', billing_unit: 'per_second', unit_price_usd: null, input_price_usd: null, output_price_usd: null, enabled: true })
  priceDialogVisible.value = true
}
async function savePrice() {
  if (!priceForm.provider.trim() || !priceForm.model.trim() || !priceForm.service_type || !priceForm.billing_unit) return ElMessage.warning('请完整填写提供商、服务类型、模型和计价单位')
  if (priceForm.billing_unit === 'per_1k_tokens' && priceForm.input_price_usd == null && priceForm.output_price_usd == null) return ElMessage.warning('Token 计价至少填写输入或输出价格')
  if (priceForm.billing_unit !== 'per_1k_tokens' && priceForm.unit_price_usd == null) return ElMessage.warning('请填写单价')
  priceSaving.value = true
  try {
    await advancedSettingsAPI.upsertPrice({ ...priceForm, source: 'manual', currency: 'USD' })
    priceDialogVisible.value = false; ElMessage.success('模型价格已保存'); await loadAll()
  } catch (error) { ElMessage.error(error.message || '价格保存失败') } finally { priceSaving.value = false }
}
async function createManualBackup() { creatingBackup.value = true; try { await advancedSettingsAPI.createBackup({ reason: '用户从高级设置手动创建' }); ElMessage.success('快照已创建'); await refreshSummaryAndBackups() } catch (error) { ElMessage.error(error.message || '快照创建失败') } finally { creatingBackup.value = false } }
async function previewSnapshot(row) { try { const result = await advancedSettingsAPI.previewRollback(row.id); previewTitle.value = `回滚到快照 #${row.id}`; previewData.value = result; previewAction.value = { type: 'rollback', id: row.id, token: result.token }; previewError.value = ''; previewVisible.value = true } catch (error) { ElMessage.error(error.message || '回滚预览失败') } }
async function refreshSummaryAndBackups() { const [summaryResult, backupResult] = await Promise.all([advancedSettingsAPI.summary(), advancedSettingsAPI.listBackups({ page: 1, page_size: 30 })]); Object.assign(summary, summaryResult || {}); Object.assign(backups, backupResult || {}) }
onMounted(loadAll)
useWorkbenchPage({ refresh: loadAll, loading: () => loading.value })
</script>

<style scoped>
.advanced-page { min-height: 100vh; background: var(--shell-bg); color: var(--shell-text); --accent: var(--shell-accent); --line: var(--shell-line); --muted: var(--shell-muted); }
.advanced-header { position: sticky; top: 0; z-index: 20; background: var(--bg-card); border-bottom: 1px solid var(--line); backdrop-filter: blur(12px); }
.header-inner { max-width: 1240px; min-height: 66px; margin: 0 auto; padding: 10px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.brand { display: inline-flex; align-items: center; gap: 10px; border: 0; background: none; color: inherit; cursor: pointer; text-align: left; }.brand-mark { width: 32px; height: 32px; display: grid; place-items: center; color: var(--shell-panel); background: var(--accent); border-radius: 8px; }.brand-copy { display: grid; gap: 2px; }.brand-copy strong { font-size: 15px; }.brand-copy small { color: var(--muted); font-size:12px; }.header-actions { display: flex; align-items: center; gap: 8px; }
.advanced-main { max-width: 1240px; margin: 0 auto; padding: 30px 24px 72px; }.page-intro { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding-bottom: 24px; }.eyebrow { color: var(--accent); font-size:12px; font-weight: 800; }.page-intro h1 { margin: 5px 0 7px; font-size: 28px; letter-spacing: 0; }.page-intro p { max-width: 760px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.65; }.intro-actions, .section-actions, .migration-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.health-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin-bottom: 24px; border: 1px solid var(--line); background: var(--line); }.health-strip > div { min-height: 72px; padding: 14px 16px; display: grid; align-content: center; gap: 5px; background: var(--shell-panel); }.health-strip span { color: var(--muted); font-size:12px; }.health-strip strong { color: var(--ui-accent); font-size: 15px; overflow-wrap: anywhere; }.health-strip strong span { color: var(--text-muted); font-size:12px; font-weight: 500; }
.advanced-tabs :deep(.el-tabs__header) { margin-bottom: 0; }.settings-section { padding: 24px 0; }.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }.section-heading h2 { margin: 0 0 5px; font-size: 19px; }.section-heading p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
.prompt-layout { min-height: 650px; display: grid; grid-template-columns: 270px minmax(0, 1fr); border: 1px solid var(--line); background: var(--shell-panel); }.prompt-sidebar { min-width: 0; padding: 14px; border-right: 1px solid var(--line); background: var(--bg-card); }.prompt-category-list { display: flex; flex-wrap: wrap; gap: 6px; padding: 13px 0; border-bottom: 1px solid var(--line); }.category-button { min-height: 27px; padding: 3px 7px; display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--border-color); background: var(--shell-panel); color: var(--text-muted); font: inherit; font-size:12px; cursor: pointer; }.category-button.active { color: var(--ui-accent); border-color: var(--border-color); background: var(--bg-card); }.category-button small { color: var(--text-muted); }.prompt-list { display: grid; gap: 5px; padding-top: 12px; max-height: 510px; overflow: auto; }.prompt-item { min-width: 0; padding: 9px 10px; display: grid; gap: 3px; border: 1px solid transparent; background: transparent; color: var(--ui-info); text-align: left; cursor: pointer; }.prompt-item:hover { border-color: var(--border-color); background: var(--bg-hover); }.prompt-item.active { border-color: var(--border-color); background: var(--bg-card); }.prompt-item strong, .prompt-item small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.prompt-item strong { font-size: 12px; }.prompt-item small { color: var(--text-muted); font-size:12px; }.prompt-editor-panel { min-width: 0; padding: 24px; display: grid; align-content: start; gap: 14px; }.editor-heading { display: flex; justify-content: space-between; gap: 12px; }.editor-heading h3 { margin: 3px 0 4px; font-size: 18px; }.editor-heading p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.55; }.editor-category { color: var(--accent); font-size:12px; font-weight: 800; }.editor-meta { display: flex; flex-wrap: wrap; gap: 8px 20px; padding: 10px 12px; border: 1px solid var(--border-color); background: var(--bg-card); color: var(--text-muted); font-size:12px; }.editor-meta span { min-width: 0; display: flex; gap: 5px; align-items: baseline; }.editor-meta b { color: var(--ui-accent); font-size:12px; }.editor-meta code { overflow-wrap: anywhere; }.editor-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; color: var(--muted); font-size:12px; }.locked-note { white-space: pre-wrap; line-height: 1.5; }.empty-editor { display: grid; place-items: center; min-height: 500px; color: var(--muted); }.empty-note { margin: 16px 0; color: var(--muted); font-size: 12px; }
.budget-panel { display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 16px; border: 1px solid var(--border-color); background: var(--bg-card); }.budget-panel strong { font-size: 13px; }.budget-panel p { margin: 5px 0 0; color: var(--muted); font-size:12px; }.budget-controls { display: flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 9px; }.budget-controls :deep(.el-input-number) { width: 170px; }.budget-controls > span { color: var(--muted); font-size:12px; }.price-toolbar { display: flex; gap: 8px; margin: 18px 0 12px; }.price-toolbar :deep(.el-input) { max-width: 420px; }.price-toolbar :deep(.el-select) { width: 150px; }.price-table, .backup-table { border: 1px solid var(--line); }.price-table :deep(.el-table__header-wrapper), .price-table :deep(.el-table__body-wrapper), .backup-table :deep(.el-table__header-wrapper), .backup-table :deep(.el-table__body-wrapper) { overflow-x: auto; }.auto-price-note { color: var(--text-muted); font-size:12px; }.price-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 14px; }.price-form :deep(.el-select), .price-form :deep(.el-input-number) { width: 100%; }.migration-actions { margin-bottom: 14px; }.migration-actions > span { color: var(--muted); font-size:12px; }
.automation-settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }.automation-setting-card, .moderation-fallback-panel { padding: 18px; border: 1px solid var(--line); background: var(--shell-panel); }.setting-card-heading { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto; align-items: start; gap: 11px; }.setting-icon { width: 34px; height: 34px; display: grid; place-items: center; color: var(--shell-panel); background: var(--accent); border-radius: 7px; }.setting-icon.is-warning { background: var(--ui-danger-soft); }.setting-card-heading strong { display: block; margin-bottom: 4px; font-size: 14px; }.setting-card-heading p { margin: 0; color: var(--muted); font-size:12px; line-height: 1.6; }.setting-control-line { margin-top: 20px; display: flex; align-items: center; justify-content: space-between; gap: 14px; }.setting-control-line label, .fallback-controls label { color: var(--ui-accent); font-size:12px; font-weight: 700; }.automation-setting-card > small { display: block; margin-top: 10px; color: var(--muted); font-size:12px; line-height: 1.55; }.switch-setting { min-height: 54px; display: flex; align-items: center; justify-content: space-between; gap: 14px; border-bottom: 1px solid var(--border-color); }.switch-setting:last-child { border-bottom: 0; }.switch-setting span { min-width: 0; display: grid; gap: 3px; }.switch-setting b { color: var(--ui-accent); font-size:12px; }.switch-setting small { color: var(--muted); font-size:12px; line-height: 1.45; }.moderation-fallback-panel { margin-top: 14px; }.fallback-controls { display: grid; grid-template-columns: minmax(280px, .9fr) minmax(0, 1.1fr); gap: 18px; margin: 18px 0 14px; padding-top: 16px; border-top: 1px solid var(--line); }.fallback-controls > div:first-child { display: grid; gap: 7px; }.fallback-controls :deep(.el-select) { width: 100%; }.fallback-receipt { display: flex; align-items: center; gap: 10px; }.fallback-receipt span { color: var(--muted); font-size:12px; line-height: 1.55; }
.dialog-error { padding: 12px; color: var(--ui-danger); border: 1px solid var(--border-color); background: var(--bg-card); }.diff-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 14px 0; }.diff-summary > div { padding: 10px; display: grid; gap: 4px; border: 1px solid var(--line); background: var(--bg-card); }.diff-summary strong { font-size:12px; }.diff-summary span { color: var(--muted); font-size:12px; }.preview-json { max-height: 380px; padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-muted); background: var(--bg-card); border: 1px solid var(--line); font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
@media (max-width: 840px) { .page-intro, .section-heading, .budget-panel { align-items: flex-start; flex-direction: column; }.health-strip { grid-template-columns: 1fr 1fr; }.budget-controls { justify-content: flex-start; }.prompt-layout, .automation-settings-grid, .fallback-controls { grid-template-columns: 1fr; }.prompt-sidebar { border-right: 0; border-bottom: 1px solid var(--line); }.prompt-list { max-height: 240px; }.diff-summary { grid-template-columns: 1fr 1fr; } }
@media (max-width: 560px) { .header-inner, .advanced-main { padding-left: 14px; padding-right: 14px; }.header-actions > :deep(.el-button:not(.is-circle)) { width: 34px; min-width: 34px; padding: 0; }.header-actions > :deep(.el-button:not(.is-circle)) span { display: none; }.health-strip { grid-template-columns: 1fr; }.intro-actions, .section-actions, .migration-actions, .price-toolbar, .budget-controls { width: 100%; align-items: stretch; flex-direction: column; }.intro-actions :deep(.el-button), .section-actions :deep(.el-button), .migration-actions :deep(.el-button), .budget-controls :deep(.el-button), .price-toolbar :deep(.el-input), .price-toolbar :deep(.el-select) { width: 100%; max-width: none; margin-left: 0; }.prompt-editor-panel { padding: 16px; }.editor-footer { align-items: flex-start; flex-direction: column; }.price-form-grid { grid-template-columns: 1fr; }.diff-summary { grid-template-columns: 1fr; }.setting-card-heading { grid-template-columns: 34px minmax(0, 1fr); }.setting-card-heading > :deep(.el-switch) { grid-column: 1 / -1; justify-self: start; }.setting-control-line, .fallback-receipt { align-items: flex-start; flex-direction: column; } }
</style>
