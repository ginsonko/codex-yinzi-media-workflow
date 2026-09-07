<template>
  <section class="projects-workspace">
    <div class="workspace-hero-row">
      <div>
        <span class="workspace-kicker">PROJECTS / 剧集与交付</span>
        <h2>项目、剧集和 Codex 产出，在一个工作区继续</h2>
        <p>每个项目保留制作入口、最近任务和已经交付的图片与视频。打开项目后，侧栏仍然留在当前工作台。</p>
      </div>
      <div class="workspace-hero-actions">
        <el-button :loading="loading" @click="loadAll"><el-icon><Refresh /></el-icon>刷新</el-button>
        <el-button type="primary" @click="newProjectVisible = true"><el-icon><Plus /></el-icon>新建项目</el-button>
      </div>
    </div>

    <div class="workspace-toolbar">
      <el-input v-model="query" clearable placeholder="搜索项目或任务" :prefix-icon="Search" />
      <div class="toolbar-spacer" />
      <el-radio-group v-model="projectFilter" size="small">
        <el-radio-button value="active">进行中</el-radio-button>
        <el-radio-button value="archived">已归档</el-radio-button>
      </el-radio-group>
    </div>

    <el-alert v-if="error" type="warning" :closable="false" show-icon>{{ error }}</el-alert>
    <div v-loading="loading" class="workspace-grid projects-grid">
      <article v-for="project in filteredProjects" :key="project.id" class="workspace-card project-card">
        <div class="card-heading">
          <span class="project-mark"><el-icon><Film /></el-icon></span>
          <div><h3>{{ project.title || '未命名项目' }}</h3><small>{{ project.updated_at ? formatTime(project.updated_at) : '尚未更新' }}</small></div>
        </div>
        <p>{{ project.description || '还没有项目说明。进入制作流程后，Codex 会继续补充脚本、资产和镜头信息。' }}</p>
        <div class="project-facts"><span>{{ episodeCount(project) }} 集</span><span>{{ taskCount(project.id) }} 个任务</span><span>{{ projectStatus(project) }}</span></div>
        <footer>
          <el-button type="primary" plain @click="openProject(project)">继续制作</el-button>
          <el-button text @click="openProjectTasks(project)">查看任务</el-button>
          <el-dropdown trigger="click" @command="(command) => projectAction(command, project)">
            <el-button text aria-label="项目更多操作"><el-icon><MoreFilled /></el-icon></el-button>
            <template #dropdown><el-dropdown-menu><el-dropdown-item command="archive">{{ project.archived_at ? '恢复项目' : '归档项目' }}</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </footer>
      </article>
      <div v-if="!loading && !filteredProjects.length" class="workspace-empty"><el-icon><Film /></el-icon><strong>{{ projectFilter === 'archived' ? '还没有归档项目' : '从一个目标开始你的第一个项目' }}</strong><p>新建项目后，Codex 会把计划、素材、任务和交付成果放在同一条链路里。</p><el-button type="primary" @click="newProjectVisible = true">新建项目</el-button></div>
    </div>

    <h3 class="workspace-section-title"><el-icon><List /></el-icon>最近的 Codex 任务</h3>
    <div v-if="filteredTasks.length" class="tasks-list">
      <button v-for="task in filteredTasks" :key="task.id" class="task-row" type="button" @click="router.push(`/codex-console/${task.id}`)">
        <span class="task-icon"><el-icon><Operation /></el-icon></span><span class="task-copy"><strong>{{ task.title || 'Codex 视频任务' }}</strong><small>{{ task.user_goal || '没有补充目标' }}</small></span><el-tag :type="taskTagType(task.status)" size="small">{{ statusLabel(task.status) }}</el-tag><span class="task-time">{{ formatTime(task.updated_at) }}</span><el-icon><ArrowRight /></el-icon>
      </button>
    </div>
    <div v-else class="workspace-empty compact"><el-icon><List /></el-icon><span>还没有匹配的 Codex 任务</span></div>

    <h3 class="workspace-section-title">已经交付的成果 <router-link to="/media-library">查看全部素材</router-link></h3>
    <OrchestrationArtifactGallery :items="artifacts" :loading="loading" :error="error" />
    <el-dialog v-model="newProjectVisible" title="新建项目" width="min(520px, calc(100vw - 28px))" @closed="resetForm">
      <el-form label-position="top" @submit.prevent="createProject">
        <el-form-item label="项目名称"><el-input v-model="form.title" autofocus placeholder="例如：春日旅行 Vlog" /></el-form-item>
        <el-form-item label="项目说明"><el-input v-model="form.description" type="textarea" :rows="3" placeholder="说明想做什么，Codex 会在制作流程里继续拆解" /></el-form-item>
        <el-form-item label="画面比例"><el-select v-model="form.aspect_ratio"><el-option label="横屏 16:9" value="16:9" /><el-option label="竖屏 9:16" value="9:16" /><el-option label="方形 1:1" value="1:1" /></el-select></el-form-item>
      </el-form>
      <template #footer><el-button @click="newProjectVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="createProject">创建并开始</el-button></template>
    </el-dialog>
  </section>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import request from '@/utils/request'
import OrchestrationArtifactGallery from '@/components/orchestration/OrchestrationArtifactGallery.vue'
import { dramaAPI } from '@/api/drama'
import orchestrationAPI from '@/api/orchestration'
import { useWorkbenchPage } from '@/composables/useWorkbenchPage'

const router = useRouter()
const artifacts = ref([])
const loading = ref(false); const saving = ref(false); const error = ref(''); const query = ref(''); const projectFilter = ref('active'); const projects = ref([]); const tasks = ref([]); const newProjectVisible = ref(false)
const form = ref({ title: '', description: '', aspect_ratio: '16:9' })
const normalize = (data) => Array.isArray(data) ? data : (data?.items || data?.data || [])
const filteredProjects = computed(() => projects.value.filter((item) => Boolean(item.archived_at) === (projectFilter.value === 'archived') && (!query.value.trim() || `${item.title} ${item.description}`.toLowerCase().includes(query.value.trim().toLowerCase()))))
const filteredTasks = computed(() => tasks.value.filter((item) => !query.value.trim() || `${item.title} ${item.user_goal}`.toLowerCase().includes(query.value.trim().toLowerCase())).slice(0, 12))
function statusLabel(status) { return ({ draft: '待规划', planned: '已规划', running: '执行中', paused: '已暂停', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消' })[status] || '未知' }
function taskTagType(status) { return ({ succeeded: 'success', running: '', planned: 'info', failed: 'danger', partial: 'warning', paused: 'warning' })[status] || 'info' }
function formatTime(value) { if (!value) return '刚刚'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? '刚刚' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
function episodeCount(project) { return Array.isArray(project.episodes) ? project.episodes.length : Number(project.episode_count || 0) }
function taskCount(id) { return tasks.value.filter((task) => String(task.linked_drama_id || '') === String(id)).length }
function projectStatus(project) { const linked = tasks.value.filter((task) => String(task.linked_drama_id || '') === String(project.id)); if (linked.some((task) => task.status === 'running')) return 'Codex 执行中'; if (linked.some((task) => ['partial', 'failed'].includes(task.status))) return '需要查看'; if (linked.some((task) => task.status === 'succeeded')) return '已有交付'; return project.archived_at ? '已归档' : '待开始' }
async function loadAll() { loading.value = true; error.value = ''; try { const [dramaResult, taskResult, artifactResult] = await Promise.all([dramaAPI.list({ archive_state: 'all', page_size: 100 }), orchestrationAPI.sessions({ limit: 100 }), request.get('/orchestration-artifacts',{params:{page_size:12},suppressGlobalError:true})]); projects.value = normalize(dramaResult); tasks.value = normalize(taskResult); artifacts.value = artifactResult.items || [] } catch (e) { error.value = e?.message || '项目和任务暂时无法读取' } finally { loading.value = false } }
function openProject(project) { router.push(`/workflow/${project.id}`) }
function openProjectTasks(project) { const task = tasks.value.find((item) => String(item.linked_drama_id || '') === String(project.id)); router.push(task ? `/codex-console/${task.id}` : '/codex-console') }
async function projectAction(command, project) { if (command !== 'archive') return; try { await dramaAPI.update(project.id, { archived: !project.archived_at }); await loadAll(); ElMessage.success(project.archived_at ? '项目已恢复' : '项目已归档') } catch (e) { ElMessage.error(e?.message || '操作失败') } }
function resetForm() { form.value = { title: '', description: '', aspect_ratio: '16:9' } }
async function createProject() { const title = form.value.title.trim(); if (!title) return ElMessage.warning('请先填写项目名称'); saving.value = true; try { const project = await dramaAPI.create({ title, description: form.value.description.trim() || undefined, metadata: { aspect_ratio: form.value.aspect_ratio } }); newProjectVisible.value = false; await loadAll(); router.push(`/workflow/${project.id}`) } catch (e) { ElMessage.error(e?.message || '创建失败') } finally { saving.value = false } }
onMounted(loadAll); useWorkbenchPage({ refresh: loadAll, loading: () => loading.value, error: () => error.value })
</script>

<style scoped>
.projects-workspace{max-width:1200px}.workspace-hero-row{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:30px}.workspace-hero-row h2{max-width:760px;margin:10px 0 8px;font-size:clamp(22px,3vw,34px);line-height:1.35}.workspace-hero-row p{max-width:760px;margin:0;color:var(--shell-muted);font-size:13px;line-height:1.8}.workspace-kicker{color:var(--shell-accent);font-size:12px;letter-spacing:.14em}.workspace-hero-actions{display:flex;gap:8px;flex:none}.projects-grid{min-height:160px}.project-card{min-height:240px}.card-heading{display:flex;align-items:center;gap:12px}.card-heading h3{margin:0 0 3px}.project-mark,.task-icon{display:grid;place-items:center;flex:none;background:var(--bg-card);color:var(--shell-accent);border-radius:10px}.project-mark{width:38px;height:38px}.project-facts{display:flex;flex-wrap:wrap;gap:7px}.project-facts span{padding:4px 7px;border:1px solid var(--shell-line);color:var(--shell-muted);font-size:12px}.project-card footer{display:flex;align-items:center;gap:5px}.workspace-empty{min-height:220px;grid-column:1/-1;display:grid;place-items:center;align-content:center;gap:10px;border:1px dashed var(--shell-line);color:var(--shell-muted);text-align:center}.workspace-empty .el-icon{font-size:30px;color:var(--shell-accent)}.workspace-empty p{max-width:360px;margin:0;font-size:12px;line-height:1.7}.workspace-empty.compact{min-height:100px;display:flex}.tasks-list{display:grid;border:1px solid var(--shell-line);border-radius:12px;overflow:hidden}.task-row{display:flex;align-items:center;gap:12px;min-width:0;padding:13px 16px;border:0;border-bottom:1px solid var(--shell-line);background:var(--shell-panel);color:var(--shell-text);text-align:left;cursor:pointer}.task-row:last-child{border-bottom:0}.task-row:hover{background:var(--shell-panel-2)}.task-icon{width:32px;height:32px}.task-copy{min-width:0;flex:1;display:grid;gap:4px}.task-copy strong,.task-copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.task-copy small,.task-time{color:var(--shell-muted);font-size:12px}.task-time{width:95px;flex:none;text-align:right}@media(max-width:700px){.workspace-hero-row{display:block}.workspace-hero-actions{margin-top:16px}.task-time{display:none}.task-row{padding:12px 10px}.project-card footer{flex-wrap:wrap}}
</style>
