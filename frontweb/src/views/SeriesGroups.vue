<template>
  <div class="page">
    <header class="hero"><div><p class="eyebrow">V0.4 · 剧集资产</p><h1>剧集组与续集复用</h1><p class="sub">把角色、场景、道具和声音沉淀成不可变版本，新集只引用，不污染旧集。</p></div><el-button @click="$router.push('/')">返回项目</el-button></header>
    <el-card class="card" shadow="never"><div class="form-row"><el-input v-model="name" placeholder="新剧集组名称"/><el-input v-model="description" placeholder="简介（可选）"/><el-button type="primary" @click="create">创建剧集组</el-button></div><el-table :data="groups" stripe @row-click="select"><el-table-column prop="name" label="剧集组"/><el-table-column prop="description" label="说明"/><el-table-column label="剧集数" width="100"><template #default="{row}">{{ row.episodes?.length || 0 }}</template></el-table-column><el-table-column label="资产数" width="100"><template #default="{row}">{{ row.assets?.length || 0 }}</template></el-table-column></el-table></el-card>
    <el-card v-if="selected" class="card" shadow="never"><div class="card-head"><div><h2>{{ selected.name }} · 版本化资产</h2><p class="selected-help">新建任务时选择本剧集组即可创建续集；勾选资产后才会复用，编辑时系统会自动 fork 新版本。</p></div><div class="card-actions"><el-button type="primary" @click="openSequelDialog">创建续集</el-button><el-button @click="refresh">刷新</el-button></div></div><el-alert v-if="selected.episodes?.length" title="已加入的剧集" type="success" :closable="false" class="episodes-alert"><template #default><span v-for="(episode,index) in selected.episodes" :key="`${episode.drama_id}-${episode.episode_id || 0}`">第 {{ index + 1 }} 集（项目 {{ episode.drama_id }}{{ episode.episode_id ? ` · 分集 ${episode.episode_id}` : '' }}）<i v-if="index < selected.episodes.length - 1"> · </i></span></template></el-alert><el-alert v-else title="还没有加入剧集" description="点击“创建续集”选择一个项目，系统会在制作向导中把它加入本剧集组。" type="info" :closable="false" /></el-card>
    <el-card v-if="selected" class="card" shadow="never"><el-table :data="selected.assets" stripe><el-table-column prop="title" label="资产"/><el-table-column prop="asset_type" label="类型" width="120"/><el-table-column label="当前版本" width="120"><template #default="{row}">v{{ row.current_version || '—' }}</template></el-table-column><el-table-column prop="asset_key" label="稳定键"/><el-table-column label="复用说明" min-width="240"><template #default="{row}">来源版本 v{{ row.current_version || '—' }} · 仅在续集创建时明确勾选后使用</template></el-table-column></el-table></el-card>
    <el-dialog v-model="sequelVisible" title="创建续集制作任务" width="560px" :close-on-click-modal="false">
      <el-alert type="info" :closable="false" show-icon title="先选择承载新集的项目" description="项目会在制作向导中加入当前剧集组；资产默认只作为候选，只有你在向导里明确勾选的版本才会复用。" />
      <el-form label-position="top" class="sequel-form">
        <el-form-item label="目标项目" required>
          <el-select v-model="sequelDramaId" filterable placeholder="选择一个已有项目" style="width:100%" :loading="sequelProjectsLoading">
            <el-option v-for="project in sequelProjects" :key="project.id" :label="project.title || `项目 #${project.id}`" :value="project.id"><span>{{ project.title || `项目 #${project.id}` }}</span><small v-if="project.description"> · {{ project.description }}</small></el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer><el-button @click="sequelVisible=false">取消</el-button><el-button type="primary" :disabled="!sequelDramaId" @click="startSequel">进入制作向导</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup>
import { onMounted, ref } from 'vue'; import { ElMessage } from 'element-plus'; import { seriesGroupsAPI } from '@/api/seriesGroups'; import { dramaAPI } from '@/api/drama'; import { useRouter } from 'vue-router'
const router = useRouter(); const groups=ref([]); const selected=ref(null); const name=ref(''); const description=ref(''); const sequelVisible=ref(false); const sequelProjects=ref([]); const sequelProjectsLoading=ref(false); const sequelDramaId=ref(null)
async function refresh(){ const res=await seriesGroupsAPI.list({page_size:100}); groups.value=(res.data||res).items||[]; if(selected.value){ const detail=await seriesGroupsAPI.get(selected.value.id); selected.value=detail.data||detail } }
async function create(){ if(!name.value.trim()) return ElMessage.warning('请输入剧集组名称'); try{ await seriesGroupsAPI.create({name:name.value,description:description.value}); name.value='';description.value='';await refresh();ElMessage.success('剧集组已创建') }catch(e){ElMessage.error(e.message)} }
function select(row){ selected.value=row }
async function openSequelDialog(){
  if (!selected.value) return
  sequelVisible.value = true; sequelDramaId.value = null; sequelProjectsLoading.value = true
  try {
    const result = await dramaAPI.list({ page: 1, page_size: 100, archive_state: 'active' })
    sequelProjects.value = result?.items || []
    if (!sequelProjects.value.length) ElMessage.info('暂无可用项目，请先返回首页创建项目')
  } catch (error) { sequelProjects.value = []; ElMessage.error(error.message || '项目列表加载失败') }
  finally { sequelProjectsLoading.value = false }
}
function startSequel(){
  if (!selected.value || !sequelDramaId.value) return
  const groupId = String(selected.value.id)
  sequelVisible.value = false
  router.push({ path: `/workflow/${sequelDramaId.value}`, query: { series_group_id: groupId } })
}
onMounted(refresh)
</script>
<style scoped>.page{min-height:100%;padding:42px clamp(20px,5vw,72px);background:var(--shell-bg);color:var(--shell-text)}.hero{display:flex;justify-content:space-between;margin-bottom:24px}.eyebrow{color:var(--shell-accent);font-weight:700}.hero h1{font-size:34px;margin:8px 0}.sub{color:var(--shell-muted)}.card{max-width:1180px;margin:16px auto;border:1px solid var(--shell-line);border-radius:18px;background:var(--shell-panel);color:var(--shell-text)}.form-row,.card-head,.card-actions{display:flex;gap:12px;align-items:center}.form-row>*{flex:1}.form-row .el-button{flex:0 0 auto}.card-head{justify-content:space-between;margin-bottom:16px}.selected-help{margin:4px 0 0;color:var(--shell-muted);font-size:13px}.episodes-alert{margin-bottom:16px}.episodes-alert i{font-style:normal;color:var(--shell-muted)}.sequel-form{margin-top:18px}.sequel-form small{color:var(--shell-muted)}</style>

