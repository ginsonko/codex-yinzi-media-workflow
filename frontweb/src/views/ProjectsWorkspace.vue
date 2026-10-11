<template>
  <section class="projects-workspace">
    <header class="pw-head">
      <div class="pw-head-main">
        <p class="pw-kicker">项目与剧集</p>
        <h2 class="pw-title">一个项目，从一句说明到成片</h2>
        <p class="pw-lead">
          这一页管所有项目本体：每个项目保留集数、画面比例、跑在里面的 Codex 任务和已经交付的成果。
          在这里归档会把项目从「进行中」移走，不会删除任何素材；改名或调整比例请进入项目内的制作向导。
        </p>
      </div>
      <div class="pw-head-actions">
        <el-button :loading="loading" @click="loadAll"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button type="primary" @click="newProjectVisible = true"><el-icon><Plus /></el-icon>新建项目</el-button>
      </div>
    </header>

    <div class="pw-stats">
      <span class="pw-stat"><small>进行中项目</small><b class="silver-num">{{ activeCount }}</b></span>
      <span class="pw-stat"><small>已归档</small><b class="silver-num">{{ archivedCount }}</b></span>
      <span class="pw-stat"><small>当前范围集数</small><b class="silver-num">{{ scopedEpisodeCount }}</b></span>
      <span class="pw-stat"><small>Codex 任务</small><b class="silver-num">{{ tasks.length }}</b></span>
      <span class="pw-spacer" />
      <span class="pw-scope">范围 <b class="silver-num">{{ filteredProjects.length }}</b> 个项目 · 最近任务显示 <b class="silver-num">{{ filteredTasks.length }}</b> 条</span>
    </div>

    <div class="pw-toolbar">
      <el-input v-model="query" clearable placeholder="搜索项目名、说明或任务目标" :prefix-icon="Search" class="pw-search" />
      <el-select v-model="sortBy" class="pw-sort" aria-label="项目排序">
        <el-option label="按最近更新" value="updated" />
        <el-option label="按创建时间" value="created" />
        <el-option label="按名称" value="title" />
        <el-option label="按集数" value="episodes" />
      </el-select>
      <el-radio-group v-model="projectFilter" size="small">
        <el-radio-button value="active">进行中</el-radio-button>
        <el-radio-button value="archived">已归档</el-radio-button>
      </el-radio-group>
      <el-button v-if="query || sortBy !== 'updated'" text @click="resetFilters">重置筛选</el-button>
    </div>

    <!-- 读不到数据是失败态，用红；琥珀在这套设计里只表示「在跑 / 等你确认」 -->
    <el-alert v-if="error" type="error" :closable="false" show-icon :title="'项目和任务没能读出来：' + error" class="pw-alert">
      <template #default>后端没有返回数据时这里会留空。点右上角「刷新」重试，或到「模型与 Key」确认运行时身份。</template>
    </el-alert>

    <div v-loading="loading" class="workspace-grid projects-grid">
      <article v-for="project in visibleProjects" :key="project.id" class="workspace-card project-card">
        <div class="card-heading">
          <span class="project-mark"><el-icon><Film /></el-icon></span>
          <div class="card-heading-copy">
            <h3>{{ project.title || '未命名项目' }}</h3>
            <small class="silver-num">{{ project.updated_at ? formatTime(project.updated_at) : '尚未更新' }}</small>
          </div>
        </div>
        <p>{{ project.description || '还没有项目说明。进入制作流程后，Codex 会继续补充脚本、资产和镜头信息。' }}</p>
        <div class="project-facts">
          <span><b class="silver-num">{{ episodeCount(project) }}</b> 集</span>
          <span><b class="silver-num">{{ taskCount(project.id) }}</b> 个任务</span>
          <span class="fact-status"><i :class="['dot', statusTone(project)]" />{{ projectStatus(project) }}</span>
        </div>
        <footer>
          <el-button type="primary" @click="openProject(project)">继续制作</el-button>
          <el-button @click="openProjectTasks(project)">查看任务</el-button>
          <el-dropdown trigger="click" @command="(command) => projectAction(command, project)">
            <el-button text aria-label="项目更多操作"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="archive">{{ project.archived_at ? '恢复项目' : '归档项目' }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </footer>
      </article>

      <div v-if="!loading && !filteredProjects.length" class="workspace-empty">
        <el-icon><Film /></el-icon>
        <strong>{{ emptyTitle }}</strong>
        <p>{{ emptyHint }}</p>
        <div class="empty-actions">
          <el-button v-if="query" @click="query = ''">清空搜索</el-button>
          <el-button v-if="projectFilter === 'archived'" @click="projectFilter = 'active'">看进行中的项目</el-button>
          <el-button v-else type="primary" @click="newProjectVisible = true">新建项目</el-button>
        </div>
      </div>
    </div>

    <div v-if="filteredProjects.length > visibleLimit" class="pw-more">
      <el-button @click="visibleLimit += 12">再显示 12 个（还有 {{ filteredProjects.length - visibleLimit }} 个）</el-button>
    </div>

    <h3 class="workspace-section-title">最近的 Codex 任务<small class="section-note">按最近更新排序，只显示前 12 条</small></h3>
    <div v-if="filteredTasks.length" class="tasks-list">
      <button v-for="task in filteredTasks" :key="task.id" class="task-row" type="button" @click="router.push(`/codex-console/${task.id}`)">
        <i :class="['dot', taskTone(task.status)]" />
        <span class="task-copy"><strong>{{ task.title || 'Codex 视频任务' }}</strong><small>{{ task.user_goal || '没有补充目标' }}</small></span>
        <span class="task-status">{{ statusLabel(task.status) }}</span>
        <span class="task-time silver-num">{{ formatTime(task.updated_at) }}</span>
        <el-icon><ArrowRight /></el-icon>
      </button>
    </div>
    <div v-else class="workspace-empty compact">
      <el-icon><List /></el-icon>
      <span>{{ query ? '没有匹配这句话的任务，换个词或清空搜索' : '这个项目范围内还没有 Codex 任务' }}</span>
      <el-button v-if="query" text @click="query = ''">清空搜索</el-button>
      <el-button v-else text @click="router.push('/codex-console')">去任务与计划页发起一个</el-button>
    </div>

    <h3 class="workspace-section-title">已经交付的成果 <router-link to="/media-library">查看全部素材</router-link></h3>
    <OrchestrationArtifactGallery :items="artifacts" :loading="loading" :error="error" />

    <el-dialog v-model="newProjectVisible" title="新建项目" width="min(520px, calc(100vw - 28px))" @closed="resetForm">
      <el-form label-position="top" @submit.prevent="createProject">
        <el-form-item label="项目名称"><el-input v-model="form.title" autofocus placeholder="例如：春日旅行 Vlog" /></el-form-item>
        <el-form-item label="项目说明"><el-input v-model="form.description" type="textarea" :rows="3" placeholder="说明想做什么，Codex 会在制作流程里继续拆解" /></el-form-item>
        <el-form-item label="画面比例">
          <el-select v-model="form.aspect_ratio">
            <el-option label="横屏 16:9" value="16:9" />
            <el-option label="竖屏 9:16" value="9:16" />
            <el-option label="方形 1:1" value="1:1" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="newProjectVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="createProject">创建并开始</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import request from '@/utils/request'
import OrchestrationArtifactGallery from '@/components/orchestration/OrchestrationArtifactGallery.vue'
import { dramaAPI } from '@/api/drama'
import orchestrationAPI from '@/api/orchestration'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'

const router = useRouter()
const artifacts = ref([])
const loading = ref(false); const saving = ref(false); const error = ref('')
const query = ref(''); const projectFilter = ref('active'); const projects = ref([]); const tasks = ref([])
const newProjectVisible = ref(false); const visibleLimit = ref(12)
const form = ref({ title: '', description: '', aspect_ratio: '16:9' })

/* 排序与上次浏览范围记在本机，下次进来不用重新挑 */
const SORT_KEY = 'yinzi-projects-sort'
const FILTER_KEY = 'yinzi-projects-filter'
const savedSort = localStorage.getItem(SORT_KEY)
const savedFilter = localStorage.getItem(FILTER_KEY)
const sortBy = ref(['updated', 'created', 'title', 'episodes'].includes(savedSort) ? savedSort : 'updated')
if (['active', 'archived'].includes(savedFilter)) projectFilter.value = savedFilter
watch(sortBy, (value) => { try { localStorage.setItem(SORT_KEY, value) } catch (_) {} })
watch(projectFilter, (value) => {
  try { localStorage.setItem(FILTER_KEY, value) } catch (_) {}
  visibleLimit.value = 12
})

const normalize = (data) => Array.isArray(data) ? data : (data?.items || data?.data || [])
const timeValue = (item, key) => { const t = Date.parse(item?.[key] || ''); return Number.isNaN(t) ? 0 : t }

const activeCount = computed(() => projects.value.filter((item) => !item.archived_at).length)
const archivedCount = computed(() => projects.value.filter((item) => Boolean(item.archived_at)).length)

const filteredProjects = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  const list = projects.value
    .filter((item) => Boolean(item.archived_at) === (projectFilter.value === 'archived'))
    .filter((item) => !keyword || `${item.title || ''} ${item.description || ''}`.toLowerCase().includes(keyword))
  const sorted = [...list]
  if (sortBy.value === 'updated') sorted.sort((a, b) => timeValue(b, 'updated_at') - timeValue(a, 'updated_at'))
  else if (sortBy.value === 'created') sorted.sort((a, b) => timeValue(b, 'created_at') - timeValue(a, 'created_at'))
  else if (sortBy.value === 'episodes') sorted.sort((a, b) => episodeCount(b) - episodeCount(a))
  else sorted.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN'))
  return sorted
})

/* 大列表分批渲染：一次 12 个，避免上百个项目同时建 DOM */
const visibleProjects = computed(() => filteredProjects.value.slice(0, visibleLimit.value))

const scopedEpisodeCount = computed(() => filteredProjects.value.reduce((sum, item) => sum + episodeCount(item), 0))

const filteredTasks = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return tasks.value
    .filter((item) => !keyword || `${item.title || ''} ${item.user_goal || ''}`.toLowerCase().includes(keyword))
    .slice()
    .sort((a, b) => timeValue(b, 'updated_at') - timeValue(a, 'updated_at'))
    .slice(0, 12)
})

const emptyTitle = computed(() => {
  if (query.value) return '没有匹配的项目'
  return projectFilter.value === 'archived' ? '还没有归档项目' : '从一个目标开始你的第一个项目'
})
const emptyHint = computed(() => {
  if (query.value) return '搜索按项目名和说明匹配。清空搜索，或换个更短的关键词。'
  return projectFilter.value === 'archived'
    ? '在项目卡片的「更多操作」里归档的项目会出现在这里，可以随时恢复。'
    : '新建项目后，Codex 会把计划、素材、任务和交付成果放在同一条链路里。'
})

function resetFilters() { query.value = ''; sortBy.value = 'updated'; visibleLimit.value = 12 }

function statusLabel(status) { return ({ draft: '待规划', planned: '已规划', running: '执行中', paused: '已暂停', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' })[status] || '未知' }
/* 状态点：只有「在跑」用琥珀，成了用绿，砸了用红，其余保持铬色 */
function taskTone(status) { if (status === 'running') return 'is-live'; if (status === 'succeeded') return 'is-ok'; if (['failed', 'partial'].includes(status)) return 'is-bad'; return 'is-idle' }
function statusTone(project) {
  const linked = tasks.value.filter((task) => String(task.linked_drama_id || '') === String(project.id))
  if (linked.some((task) => task.status === 'running')) return 'is-live'
  if (linked.some((task) => ['partial', 'failed'].includes(task.status))) return 'is-bad'
  if (linked.some((task) => task.status === 'succeeded')) return 'is-ok'
  return 'is-idle'
}
function formatTime(value) { if (!value) return '刚刚'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? '刚刚' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function episodeCount(project) { return Array.isArray(project.episodes) ? project.episodes.length : Number(project.episode_count || 0) }
function taskCount(id) { return tasks.value.filter((task) => String(task.linked_drama_id || '') === String(id)).length }
function projectStatus(project) { const linked = tasks.value.filter((task) => String(task.linked_drama_id || '') === String(project.id)); if (linked.some((task) => task.status === 'running')) return 'Codex 执行中'; if (linked.some((task) => ['partial', 'failed'].includes(task.status))) return '需要查看'; if (linked.some((task) => task.status === 'succeeded')) return '已有交付'; return project.archived_at ? '已归档' : '待开始' }

async function loadAll() {
  loading.value = true; error.value = ''
  try {
    const [dramaResult, taskResult, artifactResult] = await Promise.all([
      dramaAPI.list({ archive_state: 'all', page_size: 100 }),
      orchestrationAPI.sessions({ limit: 100 }),
      request.get('/orchestration-artifacts', { params: { page_size: 12 }, suppressGlobalError: true }),
    ])
    projects.value = normalize(dramaResult); tasks.value = normalize(taskResult); artifacts.value = artifactResult.items || []
  } catch (e) { error.value = e?.message || '项目和任务暂时无法读取' }
  finally { loading.value = false }
}

function openProject(project) { router.push(`/workflow/${project.id}`) }
function openProjectTasks(project) { const task = tasks.value.find((item) => String(item.linked_drama_id || '') === String(project.id)); router.push(task ? `/codex-console/${task.id}` : '/codex-console') }

/* 归档会改变项目在列表里的归属，先问一次；恢复是安全方向，做了直接反馈 */
async function projectAction(command, project) {
  if (command !== 'archive') return
  const archiving = !project.archived_at
  if (archiving) {
    try {
      const linked = tasks.value.filter((task) => String(task.linked_drama_id || '') === String(project.id))
      const running = linked.filter((task) => ['running', 'planned', 'draft'].includes(task.status)).length
      await ElMessageBox.confirm(
        `「${project.title || '未命名项目'}」会从「进行中」移到「已归档」，共涉及 ${episodeCount(project)} 集、${linked.length} 个任务${running ? `，其中 ${running} 个还没结束` : ''}。素材、成片和任务记录都保留，随时能恢复。`,
        '归档项目',
        { confirmButtonText: '归档', cancelButtonText: '取消', type: 'warning' },
      )
    } catch (_) { return }
  }
  try {
    await dramaAPI.update(project.id, { archived: archiving })
    await loadAll()
    ElMessage.success(archiving ? '项目已归档，可以在「已归档」里找回' : '项目已恢复')
  } catch (e) { ElMessage.error(e?.message || '操作失败') }
}

function resetForm() { form.value = { title: '', description: '', aspect_ratio: '16:9' } }
async function createProject() {
  const title = form.value.title.trim(); if (!title) return ElMessage.warning('请先填写项目名称')
  saving.value = true
  try {
    const project = await dramaAPI.create({ title, description: form.value.description.trim() || undefined, metadata: { aspect_ratio: form.value.aspect_ratio } })
    newProjectVisible.value = false; await loadAll(); router.push(`/workflow/${project.id}`)
  } catch (e) { ElMessage.error(e?.message || '创建失败') }
  finally { saving.value = false }
}
onMounted(loadAll)
useWorkbenchPage({ refresh: loadAll, loading: () => loading.value, error: () => error.value })
</script>

<style scoped>
.projects-workspace{max-width:1200px}
/* ── 页头：说明这一页在管什么 ─────────────────────────────── */
.pw-head{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:22px}
.pw-head-main{max-width:760px}
.pw-kicker{margin:0 0 8px;color:var(--text-subtle);font-size:11px;letter-spacing:.14em}
.pw-title{font-family:var(--font-display);font-weight:600;margin:0 0 8px;font-size:clamp(20px,2.4vw,28px);line-height:1.35}
.pw-lead{margin:0;color:var(--text-muted);font-size:13px;line-height:1.85}
.pw-head-actions{display:flex;gap:8px;flex:none}

/* ── 计数条：数字走等宽 ───────────────────────────────────── */
.pw-stats{display:flex;align-items:baseline;gap:22px;flex-wrap:wrap;padding:12px 0;margin-bottom:16px;border-top:1px solid var(--border-color);border-bottom:1px solid var(--border-color)}
.pw-stat{display:grid;gap:2px}
.pw-stat small{color:var(--text-subtle);font-size:11px}
.pw-stat b{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:18px;font-weight:600;color:var(--text-bright)}
.pw-spacer{flex:1}
.pw-scope{color:var(--text-faint);font-size:11px}
.pw-scope b{font-family:var(--font-mono);color:var(--text-muted)}

/* ── 筛选 / 排序 ──────────────────────────────────────────── */
.pw-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:20px}
.pw-toolbar .pw-search{width:min(320px,100%)}
.pw-toolbar .pw-sort{width:150px}
.pw-alert{margin-bottom:16px}
/* Element Plus 的 error alert 默认是整块淡红底，在这套暗房里太"卡片"了。
   改成实底 + 单线红边，红只出现在文字和描边上。
   这里的 !important 是为了盖掉 Element Plus 自己给 .el-alert--error 的
   内联级背景/边框声明（它带 box-shadow 光晕），不盖住就会重新变成粉色块。 */
.pw-alert :deep(.el-alert__content){color:var(--text-primary)}
.pw-alert{background:var(--bg-inner)!important;border:1px solid var(--ui-danger)!important;border-radius:var(--radius-md)}
.pw-alert :deep(.el-alert__title){color:var(--ui-danger);font-weight:600}
.pw-alert :deep(.el-alert__description){color:var(--text-muted)}
.pw-alert :deep(.el-alert__icon){color:var(--ui-danger)}

/* ── 卡片 ────────────────────────────────────────────────── */
.projects-grid{min-height:160px;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:14px}
:deep(.workspace-card){background:var(--bg-card);border:1px solid var(--border-color);border-radius:var(--radius-lg);box-shadow:var(--shadow-xs)}
:deep(.workspace-card):hover{border-color:var(--border-muted)}
.project-card{gap:10px}
.card-heading{display:flex;align-items:flex-start;gap:11px}
.card-heading-copy{min-width:0}
.card-heading h3{margin:0 0 3px;font-size:16px;font-weight:600;overflow-wrap:anywhere}
.card-heading small{color:var(--text-subtle);font-size:11px}
.project-mark,.task-icon{display:grid;place-items:center;flex:none;background:var(--bg-inner);color:var(--text-muted);border:1px solid var(--border-color);border-radius:var(--radius-sm)}
.project-mark{width:34px;height:34px}
.project-facts{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.project-facts span{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border:1px solid var(--border-color);border-radius:var(--radius-sm);color:var(--text-muted);font-size:11px}
.project-facts b{font-family:var(--font-mono);font-variant-numeric:tabular-nums;color:var(--text-primary);font-weight:600}
.project-card footer{display:flex;align-items:center;gap:6px;margin-top:auto;padding-top:10px;border-top:1px solid var(--border-color)}

/* 状态点：6px 圆点 + 极短标签，不用大色块徽章 */
.dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--ui-accent-2);display:inline-block}
.dot.is-live{background:var(--ui-warning)}
.dot.is-ok{background:var(--ui-success)}
.dot.is-bad{background:var(--ui-danger)}
.dot.is-idle{background:var(--ui-accent-2)}
.fact-status{gap:6px}

/* ── 空态：写清下一步 ─────────────────────────────────────── */
.workspace-empty{min-height:200px;grid-column:1/-1;display:grid;place-items:center;align-content:center;gap:9px;padding:28px;border:1px dashed var(--border-muted);border-radius:var(--radius-lg);color:var(--text-muted);text-align:center}
.workspace-empty .el-icon{font-size:26px;color:var(--text-subtle)}
.workspace-empty strong{color:var(--text-primary);font-size:15px}
.workspace-empty p{max-width:420px;margin:0;font-size:12px;line-height:1.75}
.empty-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:4px}
.workspace-empty.compact{min-height:96px;display:flex;flex-wrap:wrap;gap:9px;border-style:solid;border-radius:var(--radius-md)}
.pw-more{display:flex;justify-content:center;margin-top:14px}

/* ── 任务列表 ─────────────────────────────────────────────── */
.section-note{margin-left:10px;color:var(--text-faint);font-size:11px;font-weight:400}
.tasks-list{display:grid;border:1px solid var(--border-color);border-radius:var(--radius-md);overflow:hidden;background:var(--bg-card)}
.task-row{display:flex;align-items:center;gap:11px;min-width:0;padding:12px 15px;border:0;border-bottom:1px solid var(--border-color);background:transparent;color:var(--text-primary);text-align:left;cursor:pointer;transition:background .15s}
.task-row:last-child{border-bottom:0}
.task-row:hover{background:var(--bg-hover)}
.task-icon{width:28px;height:28px}
.task-copy{min-width:0;flex:1;display:grid;gap:3px}
.task-copy strong,.task-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-copy strong{font-size:13px;font-weight:600}
.task-copy small,.task-time{color:var(--text-subtle);font-size:11px}
.task-status{flex:none;color:var(--text-muted);font-size:11px}
.task-time{width:92px;flex:none;text-align:right;font-family:var(--font-mono);font-variant-numeric:tabular-nums}

@media(max-width:760px){
  .pw-head{display:block}
  .pw-head-actions{margin-top:14px}
  .pw-toolbar .pw-search,.pw-toolbar .pw-sort{width:100%}
  .pw-stats{gap:16px}
  .task-time,.task-status{display:none}
  .task-row{padding:11px 10px}
}
</style>
