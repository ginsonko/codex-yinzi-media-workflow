<template>
  <div class="page">
    <header class="sg-head">
      <div class="sg-head-main">
        <p class="sg-kicker">剧集组与续集复用</p>
        <h1 class="sg-title">把角色、场景、道具锁成一组版本化资产</h1>
        <p class="sg-lead">
          这一页管「跨集复用」：同一个世界观下的多集挂进一个剧集组，角色、场景、道具和风格定好版本，
          新集只引用不覆盖。下面选中的剧集组决定「创建续集」时带哪些资产；改动只影响之后新建的集，
          已经出片的集不会被回改。
        </p>
      </div>
      <el-button @click="$router.push('/')">返回项目</el-button>
    </header>

    <section class="sg-panel">
      <div class="sg-create">
        <el-input v-model="name" placeholder="新剧集组名称，例：《潮汐线》第二季" class="sg-create-name" />
        <el-input v-model="description" placeholder="简介（可选）：世界观、色调、主要场景" class="sg-create-desc" />
        <el-button type="primary" :loading="creating" @click="create">创建剧集组</el-button>
      </div>

      <div class="sg-toolbar">
        <el-input v-model="groupQuery" clearable placeholder="搜索剧集组名称或简介" :prefix-icon="Search" class="sg-search" />
        <el-select v-model="groupSort" class="sg-sort" aria-label="剧集组排序">
          <el-option label="按名称" value="name" />
          <el-option label="按集数" value="episodes" />
          <el-option label="按资产数" value="assets" />
        </el-select>
        <span class="sg-count">共 <b class="silver-num">{{ filteredGroups.length }}</b> 组</span>
      </div>

      <el-table v-loading="loading" :data="filteredGroups" class="sg-table" @row-click="select" :row-class-name="rowClass">
        <el-table-column prop="name" label="剧集组" min-width="180">
          <template #default="{ row }"><span class="sg-name">{{ row.name }}</span></template>
        </el-table-column>
        <el-table-column prop="description" label="说明" min-width="220">
          <template #default="{ row }"><span class="sg-desc">{{ row.description || '还没有简介' }}</span></template>
        </el-table-column>
        <el-table-column label="剧集数" width="96" align="right">
          <template #default="{ row }"><span class="silver-num">{{ row.episodes?.length || 0 }}</span></template>
        </el-table-column>
        <el-table-column label="资产数" width="96" align="right">
          <template #default="{ row }"><span class="silver-num">{{ row.assets?.length || 0 }}</span></template>
        </el-table-column>
        <el-table-column label="" width="76" align="right">
          <template #default="{ row }">
            <span :class="['sg-mark', String(row.id) === String(selected?.id) ? 'is-on' : '']">{{ String(row.id) === String(selected?.id) ? '已选' : '选择' }}</span>
          </template>
        </el-table-column>
        <template #empty>
          <div class="sg-empty">
            <strong>{{ groupQuery ? '没有匹配的剧集组' : '还没有剧集组' }}</strong>
            <span>{{ groupQuery ? '换个关键词，或清空搜索看全部。' : '在上面的输入框里填一个名称，点「创建剧集组」；也可以先做一集，再把角色和场景存进来。' }}</span>
            <el-button v-if="groupQuery" @click="groupQuery = ''">清空搜索</el-button>
          </div>
        </template>
      </el-table>
    </section>

    <section v-if="selected" class="sg-panel">
      <div class="sg-panel-head">
        <div>
          <h2 class="sg-panel-title">{{ selected.name }}</h2>
          <p class="sg-panel-note">新建任务时选择本剧集组即可创建续集；勾选资产后才会复用，编辑时系统会自动 fork 新版本。</p>
        </div>
        <div class="sg-panel-actions">
          <el-button type="primary" @click="openSequelDialog">创建续集</el-button>
          <el-button :loading="loading" @click="refresh">刷新</el-button>
        </div>
      </div>

      <div class="sg-metrics">
        <span class="sg-metric"><small>已加入剧集</small><b class="silver-num">{{ selected.episodes?.length || 0 }}</b></span>
        <span class="sg-metric"><small>版本化资产</small><b class="silver-num">{{ selected.assets?.length || 0 }}</b></span>
        <span class="sg-metric"><small>资产类型</small><b class="silver-num">{{ assetTypeCount }}</b></span>
      </div>

      <div v-if="selected.episodes?.length" class="sg-episodes">
        <span class="sg-episodes-label">已加入的剧集</span>
        <ul class="sg-episode-list">
          <li v-for="(episode, index) in selected.episodes" :key="`${episode.drama_id}-${episode.episode_id || 0}`">
            <i class="dot is-ok" />
            <span>第 {{ index + 1 }} 集</span>
            <small class="silver-num">项目 {{ episode.drama_id }}{{ episode.episode_id ? ` · 分集 ${episode.episode_id}` : '' }}</small>
          </li>
        </ul>
      </div>
      <div v-else class="sg-hint">
        <strong>这一组还没有剧集</strong>
        <p>点「创建续集」选一个项目，系统会在制作向导里把它加入本剧集组；也可以进入某个项目的向导，在阶段设置里挂到这一组。</p>
        <el-button text @click="openSequelDialog">去加入第一集</el-button>
      </div>
    </section>

    <section class="sg-panel">
      <div class="sg-panel-head">
        <div>
          <h2 class="sg-panel-title">{{ selected ? `${selected.name} · 版本化资产` : '版本化资产' }}</h2>
          <p class="sg-panel-note">{{ selected ? '资产只在续集创建时被明确勾选才会复用；这里的版本号是当前生效的版本。' : '先在上面选中一个剧集组，这里会列出它的角色、场景与道具。' }}</p>
        </div>
        <span class="sg-count" v-if="selected">共 <b class="silver-num">{{ selected.assets?.length || 0 }}</b> 项</span>
      </div>
      <el-table :data="selected?.assets || []" class="sg-table">
        <el-table-column prop="title" label="资产" min-width="160" />
        <el-table-column prop="asset_type" label="类型" width="120" />
        <el-table-column label="当前版本" width="110" align="right">
          <template #default="{ row }"><span class="silver-num">v{{ row.current_version || '—' }}</span></template>
        </el-table-column>
        <el-table-column prop="asset_key" label="稳定键" min-width="140" />
        <el-table-column label="复用说明" min-width="240">
          <template #default="{ row }">来源版本 v{{ row.current_version || '—' }} · 仅在续集创建时明确勾选后使用</template>
        </el-table-column>
        <template #empty>
          <div class="sg-empty">
            <strong>{{ selected ? '这个剧集组还没有资产' : '还没有选中剧集组' }}</strong>
            <span>{{ selected ? '在制作向导的资产阶段把角色、场景或道具存进本组，之后这里会按版本列出。' : '点上面任意一行的「选择」查看它的资产。' }}</span>
          </div>
        </template>
      </el-table>
    </section>

    <el-dialog v-model="sequelVisible" title="创建续集制作任务" width="min(560px, calc(100vw - 28px))" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon title="先选择承载新集的项目" description="项目会在制作向导中加入当前剧集组；资产默认只作为候选，只有你在向导里明确勾选的版本才会复用。" />
      <el-form label-position="top" class="sequel-form">
        <el-form-item label="目标项目" required>
          <el-select v-model="sequelDramaId" filterable placeholder="选择一个已有项目" class="sequel-select" :loading="sequelProjectsLoading">
            <el-option v-for="project in sequelProjects" :key="project.id" :label="project.title || `项目 #${project.id}`" :value="project.id">
              <span>{{ project.title || `项目 #${project.id}` }}</span><small v-if="project.description"> · {{ project.description }}</small>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="sequelVisible = false">取消</el-button><el-button type="primary" :disabled="!sequelDramaId" @click="startSequel">进入制作向导</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { seriesGroupsAPI } from '@/api/seriesGroups'
import { dramaAPI } from '@/api/drama'
import { useRouter } from 'vue-router'

const router = useRouter()
const groups = ref([]); const selected = ref(null); const name = ref(''); const description = ref('')
const loading = ref(false); const creating = ref(false)
const sequelVisible = ref(false); const sequelProjects = ref([]); const sequelProjectsLoading = ref(false); const sequelDramaId = ref(null)

/* 搜索与排序记在本机，回到这一页还是上次的看法 */
const Q_KEY = 'yinzi-series-group-query'
const SORT_KEY = 'yinzi-series-group-sort'
const groupQuery = ref(localStorage.getItem(Q_KEY) || '')
const savedSort = localStorage.getItem(SORT_KEY)
const groupSort = ref(['name', 'episodes', 'assets'].includes(savedSort) ? savedSort : 'name')

watch(groupQuery, (value) => { try { localStorage.setItem(Q_KEY, value) } catch (_) {} })
watch(groupSort, (value) => { try { localStorage.setItem(SORT_KEY, value) } catch (_) {} })

const filteredGroups = computed(() => {
  const keyword = groupQuery.value.trim().toLowerCase()
  const list = groups.value.filter((item) => !keyword || `${item.name || ''} ${item.description || ''}`.toLowerCase().includes(keyword))
  const sorted = [...list]
  if (groupSort.value === 'episodes') sorted.sort((a, b) => (b.episodes?.length || 0) - (a.episodes?.length || 0))
  else if (groupSort.value === 'assets') sorted.sort((a, b) => (b.assets?.length || 0) - (a.assets?.length || 0))
  else sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN'))
  return sorted
})

const assetTypeCount = computed(() => new Set((selected.value?.assets || []).map((item) => item.asset_type).filter(Boolean)).size)

function rowClass({ row }) { return String(row.id) === String(selected.value?.id) ? 'sg-row-selected' : '' }

async function refresh() {
  loading.value = true
  try {
    const res = await seriesGroupsAPI.list({ page_size: 100 })
    groups.value = (res.data || res).items || []
    if (selected.value) {
      const detail = await seriesGroupsAPI.get(selected.value.id)
      selected.value = detail.data || detail
    }
  } catch (error) { ElMessage.error(error?.message || '剧集组列表读取失败') }
  finally { loading.value = false }
}
async function create() {
  if (!name.value.trim()) return ElMessage.warning('请输入剧集组名称')
  creating.value = true
  try {
    await seriesGroupsAPI.create({ name: name.value, description: description.value })
    name.value = ''; description.value = ''; await refresh(); ElMessage.success('剧集组已创建')
  } catch (e) { ElMessage.error(e?.message || '创建剧集组失败') }
  finally { creating.value = false }
}
function select(row) { selected.value = row }
async function openSequelDialog() {
  if (!selected.value) return
  sequelVisible.value = true; sequelDramaId.value = null; sequelProjectsLoading.value = true
  try {
    const result = await dramaAPI.list({ page: 1, page_size: 100, archive_state: 'active' })
    sequelProjects.value = result?.items || []
    if (!sequelProjects.value.length) ElMessage.info('暂无可用项目，请先返回首页创建项目')
  } catch (error) { sequelProjects.value = []; ElMessage.error(error?.message || '项目列表加载失败') }
  finally { sequelProjectsLoading.value = false }
}
function startSequel() {
  if (!selected.value || !sequelDramaId.value) return
  const groupId = String(selected.value.id)
  sequelVisible.value = false
  router.push({ path: `/workflow/${sequelDramaId.value}`, query: { series_group_id: groupId } })
}
onMounted(refresh)
</script>
<style scoped>
.page{max-width:1180px;margin:0 auto;padding:28px clamp(16px,4vw,40px) 56px;background:var(--bg-page);color:var(--text-primary);min-height:100%}
/* ── 页头 ─────────────────────────────────────────────────── */
.sg-head{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;margin-bottom:20px}
.sg-head-main{max-width:780px}
.sg-kicker{margin:0 0 7px;color:var(--text-subtle);font-size:11px;letter-spacing:.14em}
.sg-title{font-family:var(--font-display);font-weight:600;margin:0 0 8px;font-size:clamp(20px,2.4vw,27px);line-height:1.35}
.sg-lead{margin:0;color:var(--text-muted);font-size:13px;line-height:1.85}

/* ── 面板 ─────────────────────────────────────────────────── */
.sg-panel{margin:0 0 18px;border:1px solid var(--border-color);border-radius:var(--radius-lg);background:var(--bg-card);box-shadow:var(--shadow-xs);overflow:hidden}
.sg-panel-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:16px 20px;border-bottom:1px solid var(--border-color)}
.sg-panel-title{margin:0;font-size:16px;font-weight:600}
.sg-panel-note{margin:5px 0 0;color:var(--text-muted);font-size:12px;line-height:1.7;max-width:70ch}
.sg-panel-actions{display:flex;gap:8px;flex:none}

/* ── 新建行 ───────────────────────────────────────────────── */
.sg-create{display:flex;gap:10px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--border-color)}
.sg-create .sg-create-name{flex:0 0 300px}
.sg-create .sg-create-desc{flex:1;min-width:0}

/* ── 工具条 ───────────────────────────────────────────────── */
.sg-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--border-color)}
.sg-toolbar .sg-search{width:min(300px,100%)}
.sg-toolbar .sg-sort{width:140px}
.sg-count{margin-left:auto;color:var(--text-subtle);font-size:11px}
.sg-count b{font-family:var(--font-mono);color:var(--text-muted)}

/* ── 表格 ────────────────────────────────────────────────── */
.sg-table{background:transparent}
.sg-table :deep(.el-table__inner-wrapper)::before,.sg-table :deep(.el-table__border-left-patch){background:var(--border-color)}
.sg-name{font-weight:600}
.sg-desc{color:var(--text-muted)}
.sg-mark{color:var(--text-faint);font-size:11px;cursor:pointer}
.sg-mark.is-on{color:var(--text-bright)}
.sg-table :deep(.sg-row-selected) > td.el-table__cell{background:var(--ui-accent-soft)}
.sg-table :deep(.el-table__row){cursor:pointer}

/* ── 指标条 ───────────────────────────────────────────────── */
.sg-metrics{display:flex;flex-wrap:wrap;gap:26px;padding:13px 20px;border-bottom:1px solid var(--border-color)}
.sg-metric{display:grid;gap:2px}
.sg-metric small{color:var(--text-subtle);font-size:11px}
.sg-metric b{font-family:var(--font-mono);font-variant-numeric:tabular-nums;font-size:18px;font-weight:600;color:var(--text-bright)}

/* ── 已加入剧集 ───────────────────────────────────────────── */
.sg-episodes{padding:14px 20px}
.sg-episodes-label{color:var(--text-subtle);font-size:11px}
.sg-episode-list{list-style:none;margin:9px 0 0;padding:0;display:grid;gap:6px}
.sg-episode-list li{display:flex;align-items:center;gap:9px;font-size:13px}
.sg-episode-list small{color:var(--text-subtle);font-size:11px;font-family:var(--font-mono)}
.dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--ui-accent-2);display:inline-block}
.dot.is-ok{background:var(--ui-success)}

.sg-hint{padding:16px 20px;display:grid;gap:6px}
.sg-hint strong{font-size:14px}
.sg-hint p{margin:0;color:var(--text-muted);font-size:12px;line-height:1.7;max-width:64ch}
.sg-hint .el-button{align-self:flex-start;margin-top:2px;padding-left:0}

/* ── 空态 ────────────────────────────────────────────────── */
.sg-empty{display:grid;gap:7px;justify-items:center;padding:22px 12px;color:var(--text-muted);text-align:center}
.sg-empty strong{color:var(--text-primary);font-size:14px}
.sg-empty span{max-width:460px;font-size:12px;line-height:1.7}

.sequel-form{margin-top:18px}
.sequel-select{width:100%}
.sequel-form small{color:var(--text-muted)}

@media(max-width:820px){
  .sg-head{display:block}
  .sg-create{flex-wrap:wrap}
  .sg-create .sg-create-name,.sg-create .sg-create-desc{flex:1 1 100%}
  .sg-toolbar .sg-search,.sg-toolbar .sg-sort{width:100%}
  .sg-count{margin-left:0}
  .sg-panel-head{flex-direction:column}
}
</style>
