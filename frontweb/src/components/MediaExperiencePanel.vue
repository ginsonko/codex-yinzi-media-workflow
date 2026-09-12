<template>
  <el-drawer :model-value="open" title="制作经验" size="min(820px, 100vw)" @update:model-value="$emit('update:open', $event)">
    <p class="intro">本机处理会自动留下执行记录。你和 AI 可以补充有效做法与质量反馈，下次遇到相似任务时直接参考。</p>
    <form class="search-row" @submit.prevent="search">
      <el-input v-model="query" placeholder="搜索任务、工具或错误" clearable aria-label="搜索制作经验" />
      <el-select v-model="status" clearable placeholder="全部执行状态" aria-label="执行状态" style="width:160px">
        <el-option label="执行完成" value="succeeded" /><el-option label="执行失败" value="failed" /><el-option label="未核实" value="unknown" />
      </el-select>
      <el-button native-type="submit" :loading="loading">搜索</el-button>
      <el-button @click="newNote()">记一条经验</el-button>
    </form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon><el-button text @click="load">重试</el-button></el-alert>
    <p v-if="loading" role="status">正在读取记录…</p>
    <p v-else-if="!items.length && !error" class="empty">还没有匹配的记录。完成本地处理后会自动留档，也可以手动记下已经验证的方法。</p>
    <div class="entries" :aria-busy="loading">
      <article v-for="item in items" :key="item.id" class="entry">
        <button type="button" class="entry-title" @click="read(item.id)">{{ item.title }}</button>
        <p>{{ item.summary }}</p>
        <div class="badges"><span>{{ sourceLabel(item.source) }}</span><span>{{ technicalLabel(item.technical_status) }}</span><span>{{ qualityLabel(item.quality_status) }}</span><span v-if="item.supersedes_id">补充 / 纠正记录</span></div>
        <small>{{ dateLabel(item.created_at) }}<template v-if="item.module_id"> · {{ item.module_id }}</template></small>
      </article>
    </div>
    <el-pagination v-if="total > pageSize" :current-page="page" :page-size="pageSize" :total="total" layout="prev, pager, next" @current-change="changePage" />
    <el-dialog v-model="detailOpen" title="经验详情" width="min(700px, calc(100vw - 24px))" append-to-body>
      <p v-if="detailLoading" role="status">正在读取详情…</p>
      <el-alert v-if="detailError" :title="detailError" type="error" :closable="false"><el-button text @click="read(selectedId)">重试</el-button></el-alert>
      <div v-if="detail" class="detail">
        <h3>{{ detail.title }}</h3><p>{{ detail.summary }}</p>
        <div class="badges"><span>{{ sourceLabel(detail.source) }} · {{ detail.actor }}</span><span>{{ technicalLabel(detail.technical_status) }}</span><span>{{ qualityLabel(detail.quality_status) }}</span></div>
        <p v-if="detail.source === 'system_receipt'" class="intro">这条是工具执行事实。成片是否达到你的要求，需要另外记录内容验收结果。</p>
        <p v-if="detail.superseded_by?.length">已有补充或纠正：<el-button v-for="id in detail.superseded_by" :key="id" text @click="read(id)">查看后续记录</el-button></p>
        <el-button v-if="detail.supersedes_id" text @click="read(detail.supersedes_id)">查看原记录</el-button>
        <section v-if="Object.keys(detail.guidance || {}).length"><h4>做法与适用条件</h4><pre>{{ pretty(detail.guidance) }}</pre></section>
        <section v-if="detail.error"><h4>执行时的错误</h4><pre>{{ pretty(detail.error) }}</pre></section>
        <details><summary>组件、参数与文件校验信息</summary><pre>{{ pretty(detail.context) }}</pre></details>
        <section v-if="detail.evidence_refs?.length"><h4>证据位置</h4><p v-for="ref in detail.evidence_refs" :key="ref" class="evidence">{{ ref }}</p></section>
        <router-link v-if="detail.session_id" :to="'/codex-console/' + encodeURIComponent(detail.session_id)" @click="$emit('update:open', false); detailOpen = false">查看原任务</router-link>
        <div class="note-action"><el-button @click="newNote(detail)">补充做法或质量反馈</el-button></div>
      </div>
    </el-dialog>
    <el-dialog v-model="noteOpen" title="记录已验证的经验" width="min(620px, calc(100vw - 24px))" append-to-body>
      <el-form label-position="top" @submit.prevent="saveNote">
        <el-form-item label="标题"><el-input v-model="note.title" maxlength="240" /></el-form-item>
        <el-form-item label="观察到什么"><el-input v-model="note.summary" type="textarea" :rows="2" maxlength="2000" /></el-form-item>
        <el-form-item label="有效做法"><el-input v-model="note.method" type="textarea" :rows="3" /></el-form-item>
        <el-form-item label="适用条件与限制"><el-input v-model="note.limits" type="textarea" :rows="2" /></el-form-item>
        <el-form-item label="内容质量"><el-select v-model="note.quality_status"><el-option v-for="value in ['not_reviewed','passed','partial','failed']" :key="value" :value="value" :label="qualityLabel(value)" /></el-select></el-form-item>
        <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" />
        <p class="intro">只保存在本机。请记下实际结果和证据，勿填写 Key、密码或 Cookie。</p>
      </el-form>
      <template #footer><el-button @click="noteOpen=false">取消</el-button><el-button type="primary" :loading="saving" @click="saveNote">保存经验</el-button></template>
    </el-dialog>
  </el-drawer>
</template>

<script setup>
import { reactive, ref, watch } from 'vue'
import orchestrationAPI from '@/api/orchestration'
const props = defineProps({ open: Boolean })
defineEmits(['update:open'])
const query=ref(''),status=ref(''),items=ref([]),total=ref(0),page=ref(1),loading=ref(false),error=ref('')
const pageSize=20, detailOpen=ref(false),detail=ref(null),selectedId=ref(''),detailLoading=ref(false),detailError=ref('')
let listSequence=0,detailSequence=0,savedPayload='',requestKey=''
const sourceLabel=v=>({system_receipt:'系统执行记录',user_note:'用户笔记',agent_note:'AI 笔记'})[v]||'来源未知'
const technicalLabel=v=>({succeeded:'执行完成',failed:'执行失败',unknown:'执行结果未核实'})[v]||'执行结果未核实'
const qualityLabel=v=>({not_reviewed:'内容尚未验收',passed:'内容已通过',partial:'内容部分通过',failed:'内容未通过'})[v]||'内容尚未验收'
const dateLabel=v=>v?new Date(v).toLocaleString():''
const pretty=v=>JSON.stringify(v||{},null,2)
async function load(){const seq=++listSequence;loading.value=true;error.value='';try{const data=await orchestrationAPI.experiences({q:query.value,technical_status:status.value,limit:pageSize,offset:(page.value-1)*pageSize});if(seq!==listSequence)return;items.value=data.items||[];total.value=data.total||0}catch(e){if(seq===listSequence)error.value=e?.message||'暂时无法读取经验，请稍后重试。若刚更新前端，请在当前任务结束后更新后台。'}finally{if(seq===listSequence)loading.value=false}}
function search(){page.value=1;load()}
function changePage(value){page.value=value;load()}
async function read(id){selectedId.value=id;detailOpen.value=true;detail.value=null;detailError.value='';detailLoading.value=true;const seq=++detailSequence;try{const result=await orchestrationAPI.experience(id);if(seq===detailSequence)detail.value=result}catch(e){if(seq===detailSequence)detailError.value=e?.message||'暂时无法读取这条记录'}finally{if(seq===detailSequence)detailLoading.value=false}}
const noteOpen=ref(false),saving=ref(false),saveError=ref(''),note=reactive({})
function newNote(original){Object.assign(note,{title:original?original.title+' · 补充':'',summary:'',method:'',limits:'',quality_status:'not_reviewed',module_id:original?.module_id||'',session_id:original?.session_id||'',job_id:original?.job_id||null,supersedes_id:original?.id||null,evidence_refs:original?.evidence_refs||[]});savedPayload='';requestKey='';saveError.value='';noteOpen.value=true}
async function saveNote(){if(!note.title.trim()){saveError.value='请填写经验标题';return}const body={title:note.title,summary:note.summary,module_id:note.module_id,session_id:note.session_id,job_id:note.job_id,supersedes_id:note.supersedes_id,evidence_refs:note.evidence_refs,quality_status:note.quality_status,source:'user_note',actor:'user',guidance:{method:note.method,limits:note.limits}};const payload=JSON.stringify(body);if(payload!==savedPayload){savedPayload=payload;requestKey='user-note:'+crypto.randomUUID()}saving.value=true;saveError.value='';try{await orchestrationAPI.recordExperience({...body,request_key:requestKey});noteOpen.value=false;await load();if(detail.value?.id)await read(detail.value.id)}catch(e){saveError.value=e?.message||'保存未完成，请重试'}finally{saving.value=false}}
watch(()=>props.open,value=>{if(value)load();else{detailOpen.value=false;noteOpen.value=false;listSequence++;detailSequence++;loading.value=false;detailLoading.value=false}})
</script>

<style scoped>
.intro,.empty{color:var(--el-text-color-secondary);line-height:1.7}.search-row{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.search-row>.el-input{flex:1;min-width:190px}.entries{display:grid;gap:12px;margin:16px 0}.entry{border:1px solid var(--el-border-color);border-radius:12px;padding:16px;background:var(--el-bg-color)}.entry-title{font:inherit;font-weight:650;font-size:16px;background:transparent;border:0;color:var(--el-color-primary);text-align:left;cursor:pointer;padding:0;overflow-wrap:anywhere}.entry p,.detail p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}.entry small{display:block;margin-top:10px;color:var(--el-text-color-secondary);overflow-wrap:anywhere}.badges{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.badges span{font-size:12px;background:var(--el-fill-color-light);border-radius:5px;padding:4px 7px}.detail pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.65;background:var(--el-fill-color-light);padding:12px;border-radius:8px}.evidence{font-size:12px;font-family:monospace}.note-action{margin-top:18px}summary{cursor:pointer;margin:12px 0}
</style>
