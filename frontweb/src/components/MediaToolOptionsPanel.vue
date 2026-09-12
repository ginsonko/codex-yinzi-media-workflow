<template>
  <el-drawer :model-value="open" title="探索制作方案" size="min(820px, 100vw)" @update:model-value="$emit('update:open', $event)">
    <div class="panel-body">
      <p class="intro">从常见需求了解可选做法、备用工具和设备需求。告诉 Codex 你的目标，它会结合已接入工具选择合适的路径。这里的扩展方案仍待接入与实测。</p>
      <div v-if="catalog" class="count-row" role="status">
        <strong>{{ catalog.options_count || 0 }}</strong><span>条规划候选</span>
        <strong>{{ catalog.options_reusing_existing_operations || 0 }}</strong><span>条可复用现有工具</span>
      </div>
      <form class="search-row" @submit.prevent="search">
        <el-input v-model="query" clearable placeholder="搜索标题、引擎、依赖或分类" aria-label="搜索规划选项" />
        <el-select v-model="category" clearable placeholder="全部分类" aria-label="按分类筛选" style="width:180px" @change="search">
          <el-option v-for="item in categories" :key="item.key" :label="item.label + '（' + item.count + '）'" :value="item.key" />
        </el-select>
        <el-button native-type="submit" :loading="loading">搜索</el-button>
      </form>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon>
        <el-button text @click="load">重试</el-button>
      </el-alert>
      <p v-if="loading" role="status">正在读取规划选项…</p>
      <p v-else-if="!items.length && !error" class="empty">没有匹配的规划候选。这不代表没有可用的已接入工具；请回到工具目录查看已验证模块，或改用更短的关键词。</p>
      <div class="entries" :aria-busy="loading">
        <article v-for="item in items" :key="item.id" class="entry">
          <button type="button" class="entry-title" @click="read(item.id)">{{ item.title }}</button>
          <p>{{ item.summary }}</p>
          <div class="badges">
            <span>{{ categoryLabel(item.category) }}</span>
            <span>待接入方案</span>
            <span v-if="item.linked_operation_count">可链接 {{ item.linked_operation_count }} 个已有基础操作</span>
            <span v-else>无已确认基础操作</span>
          </div>
          <small>{{ item.primary_engine }} · {{ item.hardware_summary }}</small>
        </article>
      </div>
      <el-pagination v-if="total > pageSize" :current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next" @current-change="changePage" />
      <el-dialog v-model="detailOpen" title="规划选项详情" width="min(700px, calc(100vw - 24px))" append-to-body>
        <p v-if="detailLoading" role="status">正在读取详情…</p>
        <el-alert v-if="detailError" :title="detailError" type="error" :closable="false">
          <el-button text @click="read(selectedId)">重试</el-button>
        </el-alert>
        <div v-if="detail" class="detail">
          <h3>{{ detail.title }}</h3>
          <p class="disclaimer">{{ detail.planning_disclaimer }}</p>
          <p>{{ detail.description }}</p>
          <div class="badges">
            <span>{{ detail.category_label }}</span>
            <span>待接入与实测</span>
          </div>
          <section>
            <h4>证据边界</h4>
            <p>{{ detail.evidence_boundary }}</p>
          </section>
          <section>
            <h4>主引擎与备用路线</h4>
            <p>主引擎：{{ detail.primary_engine || '未写明' }}</p>
            <p>备用路线：{{ detail.fallback_route || '未写明' }}</p>
          </section>
          <section>
            <h4>依赖与安装说明</h4>
            <p>安装方式（研究描述，不是本机已支持动作）：{{ detail.install_method || '未写明' }}</p>
            <p v-if="detail.dependency_order?.length">依赖顺序：{{ detail.dependency_order.join(' → ') }}</p>
            <p v-else>未列出依赖顺序。</p>
            <p>{{ detail.auto_install_note }}</p>
          </section>
          <section>
            <h4>已有基础操作</h4>
            <template v-if="detail.linked_operations?.length">
              <p>{{ detail.recipe_note }}</p>
              <p v-for="op in detail.linked_operations" :key="op.module_id">{{ op.title }}（{{ op.module_id }}）。完整配方尚未实现。</p>
            </template>
            <p v-else>当前没有已确认存在的基础操作可链接。</p>
            <p v-if="detail.unmatched_source_module_ids?.length">资料中另有未确认编号，已忽略：{{ detail.unmatched_source_module_ids.join('、') }}</p>
          </section>
          <section>
            <h4>设备估计</h4>
            <p>{{ detail.hardware_summary }}</p>
            <p>候选平台：{{ (detail.candidate_platforms || []).join('、') || '未列出' }}。平台列表不是已跑通证明。</p>
          </section>
          <section>
            <h4>官网链接</h4>
            <p v-if="safeHref(detail.engine_source_url)"><a :href="safeHref(detail.engine_source_url)" target="_blank" rel="noopener noreferrer">引擎来源</a></p>
            <p v-else>没有可展示的安全来源链接。</p>
            <p v-if="safeHref(detail.engine_docs_url)"><a :href="safeHref(detail.engine_docs_url)" target="_blank" rel="noopener noreferrer">文档</a></p>
            <p v-else>没有可展示的安全文档链接。</p>
          </section>
          <section>
            <h4>研究阈值与易错点</h4>
            <p>样本核验设想：{{ detail.sample_verification || '未写明' }}。这是研究初估，不是执行门控。</p>
            <p>{{ detail.gotchas_and_pitfalls || '未写明易错点。' }}</p>
          </section>
          <details>
            <summary>输入、输出与原始字段（纯文本）</summary>
            <pre>{{ pretty({ inputs: detail.inputs, outputs: detail.outputs, license: detail.license, baseline_relation: detail.baseline_relation, operation_validation: detail.operation_validation, source_verification: detail.source_verification }) }}</pre>
          </details>
        </div>
      </el-dialog>
    </div>
  </el-drawer>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import orchestrationAPI from '@/api/orchestration'

const props = defineProps({
  open: { type: Boolean, default: false },
  pageSize: { type: Number, default: 12 },
})
defineEmits(['update:open'])

const query = ref('')
const category = ref('')
const items = ref([])
const categories = ref([])
const catalog = ref(null)
const total = ref(0)
const page = ref(1)
const loading = ref(false)
const error = ref('')
const detailOpen = ref(false)
const detail = ref(null)
const selectedId = ref('')
const detailLoading = ref(false)
const detailError = ref('')
let listSequence = 0
let detailSequence = 0
const pageSize = computed(() => Math.max(1, Math.min(100, Number(props.pageSize) || 12)))

function pretty(value) {
  try { return JSON.stringify(value ?? {}, null, 2) } catch { return String(value ?? '') }
}
function categoryLabel(key) {
  const found = categories.value.find((item) => item.key === key)
  return found?.label || key || '未分类'
}
function safeHref(value) {
  const raw = String(value || '').trim()
  if (!/^https?:\/\//i.test(raw)) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username || url.password) return ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}

async function requestList(params) {
  if (typeof orchestrationAPI.mediaToolOptions === 'function') return orchestrationAPI.mediaToolOptions(params)
  throw new Error('当前后台尚未提供制作方案，请更新工作流后重试。')
}
async function requestDetail(id) {
  if (typeof orchestrationAPI.mediaToolOption === 'function') return orchestrationAPI.mediaToolOption(id)
  throw new Error('当前后台尚未提供方案详情，请更新工作流后重试。')
}

async function load() {
  const seq = ++listSequence
  loading.value = true
  error.value = ''
  try {
    const data = await requestList({
      q: query.value,
      category: category.value,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    })
    if (seq !== listSequence) return
    items.value = Array.isArray(data?.items) ? data.items : []
    total.value = Number(data?.total) || 0
    categories.value = Array.isArray(data?.categories) ? data.categories : []
    catalog.value = data?.catalog || null
  } catch (e) {
    if (seq === listSequence) error.value = e?.message || '暂时无法读取规划选项'
  } finally {
    if (seq === listSequence) loading.value = false
  }
}
function search() { page.value = 1; load() }
function changePage(value) { page.value = value; load() }
async function read(id) {
  selectedId.value = id
  detailOpen.value = true
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  const seq = ++detailSequence
  try {
    const result = await requestDetail(id)
    if (seq === detailSequence) detail.value = result
  } catch (e) {
    if (seq === detailSequence) detailError.value = e?.message || '暂时无法读取这条规划选项'
  } finally {
    if (seq === detailSequence) detailLoading.value = false
  }
}

watch(() => props.open, (value) => {
  if (value) load()
  else {
    detailOpen.value = false
    listSequence += 1
    detailSequence += 1
    loading.value = false
    detailLoading.value = false
  }
})
onMounted(() => { if (props.open) load() })
</script>

<style scoped>
.panel-body {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow-x: hidden;
}
.intro,
.empty,
.disclaimer,
.detail p,
.entry p {
  color: var(--el-text-color-secondary);
  line-height: 1.7;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.disclaimer {
  color: var(--el-color-warning);
  font-size: 13px;
}
.count-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: baseline;
  margin: 12px 0;
  font-size: 13px;
}
.count-row strong {
  color: var(--el-color-primary);
  font-size: 22px;
}
.search-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 18px 0;
}
.search-row > .el-input {
  flex: 1;
  min-width: 160px;
}
.entries {
  display: grid;
  gap: 12px;
  margin: 16px 0;
}
.entry {
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  padding: 16px;
  background: var(--el-bg-color);
  min-width: 0;
}
.entry-title {
  font: inherit;
  font-weight: 650;
  font-size: 16px;
  background: transparent;
  border: 0;
  color: var(--el-color-primary);
  text-align: left;
  cursor: pointer;
  padding: 0;
  overflow-wrap: anywhere;
}
.entry small {
  display: block;
  margin-top: 10px;
  color: var(--el-text-color-secondary);
  overflow-wrap: anywhere;
}
.badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: 10px 0;
}
.badges span {
  font-size: 12px;
  background: var(--el-fill-color-light);
  border-radius: 5px;
  padding: 4px 7px;
}
.detail pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.65;
  background: var(--el-fill-color-light);
  padding: 12px;
  border-radius: 8px;
}
.detail h3,
.detail h4 {
  overflow-wrap: anywhere;
}
summary {
  cursor: pointer;
  margin: 12px 0;
}
@media (max-width: 390px) {
  .search-row {
    flex-direction: column;
    align-items: stretch;
  }
  .search-row > .el-input,
  .search-row :deep(.el-select),
  .search-row :deep(.el-button) {
    width: 100%;
    max-width: 100%;
  }
  .count-row strong {
    font-size: 18px;
  }
  :deep(.el-pagination) {
    justify-content: center;
    flex-wrap: wrap;
  }
}
</style>
