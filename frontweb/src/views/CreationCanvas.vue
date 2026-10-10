<template>
  <section class="creation-workspace">
    <header class="canvas-toolbar">
      <el-select v-model="canvasId" aria-label="选择画布" placeholder="选择画布" filterable @change="switchCanvas">
        <el-option v-for="item in canvases" :key="item.id" :label="item.title" :value="item.id" />
      </el-select>
      <el-button @click="newCanvas">新建画布</el-button>
      <template v-if="canvas">
        <el-dropdown @command="addNode"><el-button>添加节点 ▾</el-button><template #dropdown><el-dropdown-menu><el-dropdown-item v-for="(label, kind) in names" :key="kind" :command="kind">{{ label }}</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
        <label class="file-button">上传素材<input type="file" multiple accept="image/*,video/*,audio/*" aria-label="上传画布素材" @change="uploadFiles" /></label>
        <el-button @click="openLibrary">素材库 / 研究</el-button>
        <el-button type="primary" @click="generateSelected">生成选中</el-button>
        <el-button @click="openExport">导出成片</el-button>
        <el-button @click="showConfig = true">Agent 配置</el-button>
        <el-button text @click="layout">整理画布</el-button>
        <a :href="`/api/v1/creation-canvases/${canvas.id}/export.json`" target="_blank">项目 JSON</a>
      </template>
    </header>
    <p class="canvas-tip">从剧本、角色图、参考素材到视频成片。连线表示参考关系；Shift 多选可按依赖生成。右侧助手与手动操作共用这张画布。</p>
    <p v-if="loadError" class="error" role="alert">{{ loadError }} <el-button text @click="refresh">重新连接</el-button></p>
    <div v-if="pending.length" class="pending-requests"><div v-for="item in pending" :key="item.body.request_id">上次「{{ actionNames[item.action] || item.action }}」提交结果待确认。<el-button text @click="recoverRequest(item)">查询并恢复这次提交</el-button></div></div>
    <div v-if="canvas" class="canvas-layout">
      <div class="flow-area" @dragover.prevent @drop.prevent="dropFiles">
        <VueFlow :key="canvas.id" v-model:nodes="flowNodes" v-model:edges="flowEdges" :node-types="nodeTypes" :default-viewport="canvas.viewport" :min-zoom="0.1" :max-zoom="2.5" :delete-key-code="null" :selection-key-code="'Shift'" fit-view-on-init
          @node-click="selectNode" @node-double-click="selectNode" @connect="connect" @node-drag-start="dragging = true" @node-drag-stop="moveNodes" @selection-change="selectionChanged" @move-end="saveViewport" @edge-click="selectEdge">
          <Background :gap="22" /><Controls /><MiniMap pannable zoomable />
          <div v-if="!canvas.nodes.length" class="canvas-empty"><strong>把创意放上画布</strong><p>上传图片或视频，添加剧本节点，或告诉右侧助手你想做什么。</p><el-button @click="addNode('text')">写一段创意</el-button></div>
        </VueFlow>
      </div>
      <aside class="canvas-panel">
        <el-tabs v-model="panel">
          <el-tab-pane label="节点与参考" name="node">
            <div v-if="selectedEdge" class="edge-editor"><strong>参考用途</strong><el-select v-model="edgeRole" aria-label="连线用途" @change="changeEdgeRole"><el-option v-for="(label,key) in roles" :key="key" :label="label" :value="key" /></el-select><el-button @click="removeEdge">移除连线</el-button></div>
            <div v-if="selected && draft" class="node-editor">
              <label>节点名称<el-input v-model="draft.title" aria-label="节点名称" /></label>
              <label>{{ selected.kind === 'text' ? '剧本 / 创意 / 说明' : '提示词' }}<el-input v-model="draft[selected.kind === 'text' ? 'text' : 'prompt']" type="textarea" :rows="6" aria-label="节点内容" /></label>
              <template v-if="['image','video'].includes(selected.kind)">
                <label>生成模型<el-select v-model="draft.modelSelection" filterable allow-create default-first-option aria-label="节点生成模型" placeholder="选择已有配置或填写模型名"><el-option v-for="option in modelOptions[selected.kind]" :key="option.value" :label="option.label" :value="option.value" /></el-select></label>
                <div class="field-pair"><label>画幅<el-select v-model="draft.settings.aspect_ratio" aria-label="生成画幅"><el-option v-for="ratio in imageRatios" :key="ratio" :value="ratio" :label="ratio" /></el-select></label>
                  <label v-if="selected.kind === 'image' && presetSize">清晰度<el-select v-model="draft.tier" aria-label="图片清晰度"><el-option v-for="tier in imageTiers" :key="tier" :value="tier" :label="tier" /></el-select></label>
                  <label v-else-if="selected.kind === 'video'">时长（秒）<el-input-number v-model="draft.settings.duration" :min="1" aria-label="视频时长" /></label></div>
                <p v-if="presetSize" class="muted">尺寸：{{ resolvedSize }}</p>
                <label v-else-if="selected.kind === 'image'">自定义尺寸<el-input v-model="draft.settings.size" placeholder="如 1024x1024" /></label>
                <label v-if="selected.kind === 'video'">分辨率<el-input v-model="draft.settings.resolution" placeholder="按模型能力，如 720p" /></label>
                <details><summary>高级参数（JSON）</summary><el-input v-model="advanced" type="textarea" :rows="4" aria-label="节点高级参数" /><small>已填写的常用参数优先。参数和模型能力以上游支持为准。</small></details>
              </template>
              <p v-if="editConflict" class="error">节点已由其他操作更新。你的草稿已保留，请对照最新内容后保存。<el-button text @click="reloadDraft">载入最新版本</el-button></p>
              <div class="editor-actions"><el-button type="primary" @click="saveNode">保存节点</el-button><el-button v-if="['image','video'].includes(selected.kind)" @click="generateNode">保存并生成</el-button><el-button @click="deleteNode">删除节点</el-button></div>
              <p class="muted">ID：{{ selected.id }} · 版本 {{ selected.version }}</p>
              <div v-if="selected.data.media" class="selected-media"><img v-if="selected.kind==='image'" :src="mediaUrl(selected)" alt="选中素材预览" /><video v-else-if="selected.kind==='video'" :src="mediaUrl(selected)" controls /><audio v-else-if="selected.kind==='audio'" :src="mediaUrl(selected)" controls /><a :href="mediaUrl(selected)" target="_blank">打开 / 下载素材</a><el-button @click="inspectNode" :loading="inspecting">分析素材</el-button></div>
              <h4>连接的参考</h4><p v-if="!inputs.length" class="muted">从其他节点右侧圆点拖到这个节点左侧。点击连线可设为首帧、尾帧或普通参考。</p><div v-for="edge in inputs" :key="edge.id" class="reference-row"><span>{{ nodeTitle(edge.source) }}</span><el-select :model-value="edge.role" @change="value => setRole(edge,value)"><el-option v-for="(label,key) in roles" :key="key" :label="label" :value="key" /></el-select></div>
              <h4>生成版本</h4><div v-for="attempt in [...selected.attempts].reverse()" :key="attempt.id" class="attempt"><strong>{{ statusLabel(attempt.status) }}</strong><small>{{ attempt.created_at }}</small><p v-if="attempt.error" class="error">{{ attempt.error }}</p><el-button v-if="attempt.media" size="small" @click="chooseAttempt(attempt)">{{ selected.active_attempt_id===attempt.id ? '当前版本' : '使用此版本' }}</el-button><a v-if="attempt.media?.url" :href="safeUrl(attempt.media.download_url || attempt.media.url)" target="_blank">查看</a></div>
            </div>
            <p v-else-if="!selectedEdge" class="muted">点击一个节点编辑内容。手动操作无需配置文本模型。</p>
          </el-tab-pane>
          <el-tab-pane label="创作助手" name="agent">
            <div class="agent-summary"><strong>{{ agentLabel }}</strong><el-button text @click="showConfig=true">配置</el-button><el-button v-if="activeRun" type="warning" size="small" @click="stopAgent">停止</el-button></div>
            <p v-if="activeRun" class="muted">正在推进第 {{ activeRun.turn }} 步；关闭页面后仍会继续。发新消息会停止旧轮并按你的纠正继续。</p>
            <p v-if="lastRun?.error" class="error">{{ lastRun.error }}</p>
            <div class="chat-log" ref="chatLog"><template v-for="message in messages" :key="message.seq"><details v-if="['tool','analysis'].includes(message.role)" class="chat-tool"><summary>{{ message.tool || '素材分析' }} · 实际回执</summary><pre>{{ message.content }}</pre></details><div v-else class="chat-message" :class="message.role"><small>{{ roleNames[message.role] || message.role }}</small><p>{{ message.content }}</p></div></template><p v-if="!messages.length" class="muted">描述目标，例如：根据我上传的角色图，设计三段连续分镜。先写方案与提示词。</p></div>
            <el-input v-model="chat" type="textarea" :rows="4" aria-label="画布助手消息" placeholder="输入要求、修改意见，或让助手继续完成…" @keydown.ctrl.enter.prevent="sendMessage" /><el-button type="primary" class="send-button" :loading="sending" @click="sendMessage">{{ activeRun ? '发送纠正并继续' : '发送给创作助手' }}</el-button>
          </el-tab-pane>
          <el-tab-pane :label="`任务 (${canvas.jobs.length})`" name="jobs"><div v-for="job in canvas.jobs" :key="job.id" class="job-card"><strong>{{ job.kind==='export' ? '成片导出' : `${job.steps?.length || 0} 个节点生成` }} · {{ statusLabel(job.status) }}</strong><small>{{ job.id }}</small><div v-for="step in job.steps" :key="step.attempt_id"><p>{{ step.data.title }}：{{ statusLabel(step.status) }}</p><p v-if="step.error" class="error">{{ step.error }}</p><a v-if="step.batch_id" :href="`/batch?batch_id=${step.batch_id}`" target="_blank">查看生成队列</a></div><p v-if="job.error" class="error">{{ job.error }}</p><div v-if="job.kind==='generation'"><el-button size="small" @click="control(job,'pause')">暂停</el-button><el-button size="small" @click="control(job,'resume')">继续</el-button><el-button size="small" @click="control(job,'cancel')">停止后续</el-button><el-button size="small" @click="regenerate(job)">重新生成</el-button></div><a v-if="job.media" :href="`/api/v1/creation-canvases/${canvas.id}/exports/${job.id}/file`" target="_blank">打开 / 下载成片</a><details><summary>参数与结果快照</summary><pre>{{ JSON.stringify(job,null,2) }}</pre></details></div><p v-if="!canvas.jobs.length" class="muted">生成与导出任务会保留在这里，刷新页面不会丢失。</p></el-tab-pane>
        </el-tabs>
      </aside>
    </div>
    <div v-else class="welcome"><h2>无限画布创作</h2><p>组织剧本、素材与镜头，使用专用助手推进创作，也可以自己连接、生成和验收。</p><el-button type="primary" @click="newCanvas">创建第一张画布</el-button></div>
    <el-dialog v-model="showConfig" title="画布专用 Agent" width="560px" class="canvas-dialog">
      <div class="config-form"><label>已有文本配置<el-select v-model="agentForm.config_id" aria-label="Agent文本配置" @change="pickAgentModel"><el-option v-for="config in textConfigs" :key="config.id" :value="config.id" :label="config.name" /></el-select></label><label>模型名称<el-input v-model="agentForm.model" aria-label="Agent模型名称" /></label><label>调用方式<el-select v-model="agentForm.mode"><el-option value="tools" label="原生工具调用（推荐）" /><el-option value="json_actions" label="JSON动作（兼容无工具调用的模型）" /></el-select></label><p class="muted">使用 OpenAI Chat Completions 兼容地址；模型需支持所选方式。Key只保存在本机模型配置中。</p><div class="field-pair"><label>每轮最多步骤<el-input-number v-model="agentForm.max_turns" :min="1" :max="100" /></label><label>请求超时（秒）<el-input-number v-model="agentTimeout" :min="1" :max="600" /></label></div><label>创作偏好<el-input v-model="agentForm.instructions" type="textarea" :rows="3" placeholder="例如人物一致、动漫质感、中文对白…" /></label>
        <details><summary>添加独立 URL / Key / 模型</summary><div class="config-form"><el-input v-model="newConfig.name" placeholder="配置名称" aria-label="新配置名称" /><el-input v-model="newConfig.base_url" placeholder="Base URL，如 https://你的服务/v1" aria-label="新配置URL" /><el-input v-model="newConfig.api_key" type="password" show-password placeholder="API Key（本地无需认证的服务可留空）" aria-label="新配置Key" /><el-input v-model="newConfig.model" placeholder="模型名称" aria-label="新配置模型" /><el-button :loading="savingConfig" @click="saveNewConfig">保存这份独立配置</el-button></div></details></div>
      <template #footer><el-button @click="showConfig=false">关闭</el-button><el-button type="primary" @click="saveAgentConfig">用于当前画布</el-button></template>
    </el-dialog>
    <el-dialog v-model="showLibrary" title="复用已有素材与研究" width="680px" class="canvas-dialog"><el-tabs v-model="libraryTab"><el-tab-pane label="素材库" name="assets"><div class="library-search"><el-input v-model="assetKeyword" placeholder="搜索名称" @keyup.enter="loadAssets" /><el-button @click="loadAssets">搜索</el-button></div><el-checkbox-group v-model="assetIds"><div v-for="asset in libraryAssets" :key="asset.id" class="library-row"><el-checkbox :value="asset.id">{{ asset.name }} · {{ names[asset.type] || asset.type }}</el-checkbox></div></el-checkbox-group><el-pagination layout="prev,pager,next" :page-size="20" :total="assetTotal" v-model:current-page="assetPage" @current-change="loadAssets" /><el-button type="primary" @click="importSelectedAssets">加入画布</el-button></el-tab-pane><el-tab-pane label="视频研究" name="research"><p class="muted">导入已有的研究文字和来源；视频文件仍需合法取得后上传。</p><div v-for="job in researchJobs" :key="job.id" class="library-row"><span>{{ researchTitle(job) }} · {{ job.state }}</span><el-button @click="importResearch(job)">导入报告</el-button></div><router-link to="/research">去调研热门 / 商品视频</router-link></el-tab-pane></el-tabs></el-dialog>
    <el-dialog v-model="showExport" title="按镜头顺序导出成片" width="560px" class="canvas-dialog"><p class="muted">使用已经完成的视频。可调整镜头顺序，后端将统一画幅并合成MP4。</p><el-input v-model="exportTitle" placeholder="成片名称" /><div v-for="(id,index) in exportIds" :key="id" class="export-row"><span>{{ index+1 }}. {{ nodeTitle(id) }}</span><el-button text :disabled="index===0" @click="moveExport(index,-1)">↑</el-button><el-button text :disabled="index===exportIds.length-1" @click="moveExport(index,1)">↓</el-button><el-button text @click="exportIds.splice(index,1)">移除</el-button></div><el-select v-model="exportRatio"><el-option v-for="ratio in ['16:9','9:16','1:1']" :key="ratio" :label="ratio" :value="ratio" /></el-select><template #footer><el-button type="primary" @click="exportVideo">合成并保存</el-button></template></el-dialog>
  </section>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'
import { ElMessage, ElMessageBox } from 'element-plus'
import CreationCanvasNode from '@/components/CreationCanvasNode.vue'
import { canvasAPI } from '@/api/creationCanvas'
import { aiAPI } from '@/api/ai'
import { uploadAPI } from '@/api/upload'
import request from '@/utils/request'
import { batchModelOptions, batchModelSelection } from '@/utils/batchModels'
import { imageRatios, imageTiers, imageSizeFor, usesImageSizePresets } from '@/utils/imageSizes'
const route=useRoute(),router=useRouter(),clone=v=>JSON.parse(JSON.stringify(v)),rid=()=>crypto.randomUUID()
const names={text:'文本 / 剧本',image:'图片',video:'视频',audio:'音频'},roles={reference:'普通参考',first_frame:'首帧',last_frame:'尾帧',context:'上下文参考'}
const roleNames={user:'你 / 宿主Agent',assistant:'画布助手',event:'任务动态',tool_start:'执行中',error:'错误'}
const statusLabel=s=>({queued:'等待执行',running:'运行中',processing:'生成中',completed:'已完成',failed:'失败',cancelled:'已停止',paused:'已暂停',interrupted:'已中断',needs_review:'待核对'}[s]||s)
const actionNames={generate:'生成',messages:'助手消息','export-video':'导出成片','import-assets':'导入素材','import-research':'导入研究'}
const canvases=ref([]),canvasId=ref(''),canvas=ref(null),flowNodes=ref([]),flowEdges=ref([]),messages=ref([]),loadError=ref(''),panel=ref('agent'),dragging=ref(false),selectedIds=ref([]),selectedId=ref(''),draft=ref(null),draftVersion=ref(0),advanced=ref('{}')
const nodeTypes={creation:markRaw(CreationCanvasNode)},selectedEdge=ref(null),edgeRole=ref('reference'),configs=ref([]),showConfig=ref(false),agentForm=ref({mode:'tools',max_turns:24}),agentTimeout=ref(120),newConfig=ref({name:'画布专用模型',base_url:'',api_key:'',model:''}),savingConfig=ref(false)
const chat=ref(''),chatLog=ref(null),sending=ref(false),inspecting=ref(false),showLibrary=ref(false),libraryTab=ref('assets'),libraryAssets=ref([]),assetIds=ref([]),assetKeyword=ref(''),assetPage=ref(1),assetTotal=ref(0),researchJobs=ref([]),showExport=ref(false),exportIds=ref([]),exportTitle=ref(''),exportRatio=ref('16:9'),pending=ref([])
let alive=true,timer,polling=false,epoch=0
const selected=computed(()=>canvas.value?.nodes.find(n=>n.id===selectedId.value)),inputs=computed(()=>canvas.value?.edges.filter(e=>e.target===selectedId.value)||[]),editConflict=computed(()=>selected.value&&selected.value.version!==draftVersion.value)
const textConfigs=computed(()=>configs.value.filter(c=>c.service_type==='text'))
const modelOptions=computed(()=>({image:batchModelOptions(configs.value.filter(c=>['image','storyboard_image'].includes(c.service_type))),video:batchModelOptions(configs.value.filter(c=>c.service_type==='video'))}))
const draftSelection=computed(()=>draft.value&&selected.value?batchModelSelection(draft.value.modelSelection,modelOptions.value[selected.value.kind]||[],selected.value.kind):{})
const presetSize=computed(()=>selected.value?.kind==='image'&&usesImageSizePresets(draftSelection.value.model)),resolvedSize=computed(()=>imageSizeFor(draftSelection.value.model,draft.value?.settings.aspect_ratio,draft.value?.tier))
const activeRun=computed(()=>canvas.value?.runs.find(r=>['queued','running'].includes(r.status))),lastRun=computed(()=>canvas.value?.runs[0]),agentLabel=computed(()=>canvas.value?.agent?.model||'尚未选择专用文本模型')
const safeUrl=value=> /^(https?:\/\/|\/(?!\/))/.test(String(value||''))?value:''
function mediaUrl(n){return n?.data.media?.local_path?`/api/v1/creation-canvases/${canvasId.value}/nodes/${encodeURIComponent(n.id)}/media?v=${encodeURIComponent(n.active_attempt_id||n.data.media.local_path)}`:safeUrl(n?.data.media?.download_url||n?.data.media?.url)}
function nodeTitle(id){return canvas.value?.nodes.find(n=>n.id===id)?.data.title||id}
function viewGraph(){if(dragging.value)return;flowNodes.value=canvas.value.nodes.map(n=>({id:n.id,type:'creation',position:n.position,selected:selectedIds.value.includes(n.id),data:{...n.data,kind:n.kind,mediaUrl:mediaUrl(n),attemptCount:n.attempts.length,statusLabel:statusLabel(n.attempts.find(a=>a.id===n.active_attempt_id)?.status)}}));flowEdges.value=canvas.value.edges.map(e=>({...e,label:roles[e.role],animated:canvas.value.jobs.some(j=>['running','queued'].includes(j.status)&&j.steps?.some(s=>s.node_id===e.target)),style:{stroke:'var(--ui-accent)'}}))}
async function refresh(){const id=canvasId.value,token=epoch;if(!id||polling)return;polling=true;try{const [data,events]=await Promise.all([canvasAPI.get(id),canvasAPI.messages(id,messages.value.at(-1)?.seq||0)]);if(!alive||token!==epoch||id!==canvasId.value)return;if(!canvas.value||data.revision>=canvas.value.revision)canvas.value=data;messages.value.push(...events.items.filter(item=>!messages.value.some(m=>m.seq===item.seq)));loadError.value='';viewGraph();if(events.items.length)await nextTick(()=>chatLog.value?.scrollTo({top:chatLog.value.scrollHeight,behavior:'smooth'}))}catch(e){if(token===epoch)loadError.value=e.message}finally{polling=false}}
async function tick(){await refresh();if(alive)timer=setTimeout(tick,1500)}
async function switchCanvas(id){const token=++epoch;canvasId.value=id;canvas.value=null;showConfig.value=false;showLibrary.value=false;showExport.value=false;chat.value='';selectedId.value='';selectedIds.value=[];draft.value=null;messages.value=[];selectedEdge.value=null;loadPending();await router.replace({name:'creation-canvas',params:{id}});const data=await canvasAPI.get(id);if(token!==epoch||id!==canvasId.value)return;canvas.value=data;agentForm.value={mode:'tools',max_turns:24,...data.agent};agentTimeout.value=(data.agent.timeout_ms||120000)/1000;viewGraph();await refresh()}
async function newCanvas(){try{const {value}=await ElMessageBox.prompt('给创作起个名字','新建画布',{inputValue:'新的漫剧 / 视频创作'});const created=await canvasAPI.create({title:value});canvases.value.unshift(created);await switchCanvas(created.id)}catch(e){if(e!=='cancel'&&e!=='close')ElMessage.error(e.message)}}
function actionContext(){return {canvasId:canvasId.value,nodeId:selectedId.value,epoch}}
function currentContext(context,node=false){return alive&&context.epoch===epoch&&context.canvasId===canvasId.value&&(!node||context.nodeId===selectedId.value)}
async function ops(operations,id=canvasId.value){const token=epoch,result=await canvasAPI.operations(id,{request_id:rid(),operations});if(id===canvasId.value&&token===epoch){const data=await canvasAPI.get(id);if(id===canvasId.value&&token===epoch&&(!canvas.value||data.revision>=canvas.value.revision)){canvas.value=data;viewGraph()}}return result}
async function addNode(kind){const context=actionContext(),result=await ops([{type:'add_node',kind,data:{title:names[kind],settings:{aspect_ratio:'16:9',...(kind==='video'?{duration:5}:{})}}}],context.canvasId);if(!currentContext(context))return;selectedId.value=result.changed[0].id;selectedIds.value=[selectedId.value];reloadDraft();panel.value='node'}
function selectNode({node}){selectedId.value=node.id;selectedEdge.value=null;reloadDraft();panel.value='node'}
function selectionChanged({nodes}){selectedIds.value=nodes.map(n=>n.id)}
function reloadDraft(){if(!selected.value)return;const data=clone(selected.value.data),settings=data.settings||{},key=selected.value.kind==='video'?'video_config_id':'image_config_id';draft.value={...data,settings,modelSelection:settings[key]?JSON.stringify([settings[key],settings.model]):settings.model||'',tier:imageTiers.find(t=>imageSizeFor(settings.model,settings.aspect_ratio,t)===settings.size)||'2K'};draftVersion.value=selected.value.version;advanced.value='{}'}
async function saveNode(){if(!selected.value)return;const context=actionContext(),draftBefore=JSON.stringify(draft.value),advancedBefore=advanced.value,version=draftVersion.value;let extra;try{extra=JSON.parse(advanced.value);if(!extra||Array.isArray(extra)||typeof extra!=='object')throw Error()}catch{ElMessage.error('高级参数需要填写JSON对象');throw new Error('高级参数需要填写JSON对象')};const {title,text,prompt,settings}=clone(draft.value),data={title,text,prompt,settings:{...extra,...settings,...draftSelection.value}};if(presetSize.value)data.settings.size=resolvedSize.value;await ops([{type:'update_node',id:context.nodeId,expected_version:version,data}],context.canvasId);if(currentContext(context,true)){if(JSON.stringify(draft.value)===draftBefore&&advanced.value===advancedBefore)reloadDraft();else draftVersion.value=version+1}return context}
async function deleteNode(){const context=actionContext();await ops([{type:'delete_node',id:context.nodeId,expected_version:selected.value.version}],context.canvasId);if(currentContext(context,true)){selectedId.value='';draft.value=null}}
async function moveNodes({node,nodes}){const moved=nodes?.length?nodes:[node];try{await ops(moved.map(n=>({type:'move_node',id:n.id,position:n.position})))}finally{dragging.value=false;viewGraph()}}
async function connect(e){await ops([{type:'connect',source:e.source,target:e.target,role:'reference'}])}
function selectEdge({edge}){selectedEdge.value=edge;edgeRole.value=edge.role||'reference';panel.value='node'}
async function setRole(edge,role){await ops([{type:'disconnect',id:edge.id},{type:'connect',id:edge.id,source:edge.source,target:edge.target,role}]);if(selectedEdge.value?.id===edge.id)selectedEdge.value={...edge,role}}
async function changeEdgeRole(role){await setRole(selectedEdge.value,role)}
async function removeEdge(){await ops([{type:'disconnect',id:selectedEdge.value.id}]);selectedEdge.value=null}
async function saveViewport({viewport}){if(canvas.value&&viewport)await canvasAPI.configure(canvas.value.id,{viewport})}
async function layout(){const nodes=canvas.value.nodes;await ops(nodes.map((n,i)=>({type:'move_node',id:n.id,position:{x:(i%4)*320,y:Math.floor(i/4)*300}})))}
function loadPending(){try{pending.value=JSON.parse(localStorage.getItem('canvas-pending:'+canvasId.value)||'[]')}catch{pending.value=[]}}
async function submit(action,input,id=canvasId.value){const entry={canvas_id:id,action,body:clone({...input,request_id:rid()})};const key='canvas-pending:'+id;let saved;try{saved=JSON.parse(localStorage.getItem(key)||'[]')}catch{saved=[]}saved.push(entry);localStorage.setItem(key,JSON.stringify(saved));if(id===canvasId.value)pending.value=saved;return recoverRequest(entry)}
async function recoverRequest(entry){const id=entry.canvas_id;try{const result=await canvasAPI.submit(id,entry.action,entry.body);removePending(entry);if(id===canvasId.value)await refresh();return result}catch(error){if(error.response&&error.response.status<500&&error.response.status!==408)removePending(entry);throw error}}
function removePending(entry){const key='canvas-pending:'+entry.canvas_id;let saved;try{saved=JSON.parse(localStorage.getItem(key)||'[]')}catch{saved=[]};saved=saved.filter(p=>p.body.request_id!==entry.body.request_id);localStorage.setItem(key,JSON.stringify(saved));if(entry.canvas_id===canvasId.value)pending.value=saved}
async function generateSelected(){const ids=selectedIds.value.filter(id=>['image','video'].includes(canvas.value.nodes.find(n=>n.id===id)?.kind));if(!ids.length&&['image','video'].includes(selected.value?.kind))ids.push(selected.value.id);if(!ids.length)return ElMessage.info('请选择图片或视频节点');await submit('generate',{node_ids:ids});panel.value='jobs'}
async function generateNode(){const context=await saveNode();if(!context)return;await submit('generate',{node_ids:[context.nodeId]},context.canvasId);if(currentContext(context,true))panel.value='jobs'}
async function regenerate(job){await submit('generate',{node_ids:job.steps.map(s=>s.node_id)})}
async function control(job,action){await canvasAPI.control(canvasId.value,job.id,action);await refresh()}
async function uploadFiles(event){const files=Array.from(event.target.files||[]);event.target.value='';await upload(files)}
async function dropFiles(event){await upload(Array.from(event.dataTransfer.files||[]))}
async function upload(files){const id=canvasId.value;for(const file of files){try{ElMessage.info(`正在上传 ${file.name}`);const media=await uploadAPI.uploadReferenceMedia(file);await ops([{type:'add_node',kind:media.media_type||file.type.split('/')[0],data:{title:file.name,media:{url:media.url,local_path:media.local_path},provenance:{type:'upload',filename:file.name}}}],id)}catch(e){ElMessage.error(`${file.name}：${e.message}`)}}}
async function chooseAttempt(attempt){const context=actionContext();await ops([{type:'select_attempt',id:context.nodeId,expected_version:selected.value.version,attempt_id:attempt.id}],context.canvasId);if(currentContext(context,true))reloadDraft()}
async function inspectNode(){const context=actionContext();inspecting.value=true;try{await canvasAPI.inspect(context.canvasId,context.nodeId);if(currentContext(context,true)){await refresh();panel.value='agent'}}finally{inspecting.value=false}}
async function sendMessage(){if(!chat.value.trim())return;if(!canvas.value.agent.config_id){showConfig.value=true;return};const context=actionContext();sending.value=true;const text=chat.value;try{await submit('messages',{message:text,selected_node_ids:selectedIds.value},context.canvasId);if(currentContext(context)){if(chat.value===text)chat.value='';panel.value='agent'}}finally{sending.value=false}}
async function stopAgent(){await canvasAPI.stop(canvasId.value,activeRun.value.id);await refresh()}
function pickAgentModel(){const config=textConfigs.value.find(c=>c.id===agentForm.value.config_id);agentForm.value.model=config?.default_model||config?.model?.[0]||''}
async function saveAgentConfig(){const context=actionContext();await canvasAPI.configure(context.canvasId,{agent:clone({...agentForm.value,timeout_ms:agentTimeout.value*1000})});if(currentContext(context)){await refresh();showConfig.value=false}}
async function loadConfigs(){configs.value=await aiAPI.list()}
async function saveNewConfig(){savingConfig.value=true;try{const context=actionContext(),c=clone(newConfig.value);const saved=await aiAPI.create({name:c.name,service_type:'text',provider:'openai',base_url:c.base_url,api_key:c.api_key,model:[c.model],default_model:c.model,endpoint:'/chat/completions',is_default:false,is_active:true});newConfig.value.api_key='';await loadConfigs();if(currentContext(context)){agentForm.value.config_id=saved.id;agentForm.value.model=c.model;}ElMessage.success('配置已保存')}finally{savingConfig.value=false}}
async function openLibrary(){showLibrary.value=true;await Promise.all([loadAssets(),loadResearch()])}
async function loadAssets(){const data=await request.get('/assets',{params:{keyword:assetKeyword.value,page:assetPage.value,page_size:20}});libraryAssets.value=data.items||[];assetTotal.value=data.total||0}
async function loadResearch(){researchJobs.value=(await request.get('/research/jobs')).items||[]}
function researchTitle(job){return typeof job.query==='string'?job.query:job.query?.product||job.title||job.id}
async function importSelectedAssets(){if(!assetIds.value.length)return;await submit('import-assets',{asset_ids:assetIds.value});assetIds.value=[];showLibrary.value=false}
async function importResearch(job){await submit('import-research',{job_id:job.id});showLibrary.value=false}
function openExport(){const videos=canvas.value.nodes.filter(n=>n.kind==='video'&&n.data.media);const picked=videos.filter(n=>selectedIds.value.includes(n.id));exportIds.value=(picked.length?picked:videos).sort((a,b)=>a.position.y-b.position.y||a.position.x-b.position.x).map(n=>n.id);exportTitle.value=canvas.value.title;showExport.value=true}
function moveExport(index,delta){const other=index+delta;[exportIds.value[index],exportIds.value[other]]=[exportIds.value[other],exportIds.value[index]]}
async function exportVideo(){if(!exportIds.value.length)return ElMessage.info('先生成或上传视频');await submit('export-video',{node_ids:exportIds.value,title:exportTitle.value,aspect_ratio:exportRatio.value});showExport.value=false;panel.value='jobs'}
watch(showConfig,value=>{if(value&&canvas.value){agentForm.value={mode:'tools',max_turns:24,...canvas.value.agent};agentTimeout.value=(canvas.value.agent.timeout_ms||120000)/1000}})
onMounted(async()=>{try{canvases.value=(await canvasAPI.list()).items;await loadConfigs();const initial=String(route.params.id||canvases.value[0]?.id||'');if(initial)await switchCanvas(initial)}catch(e){loadError.value=e.message}finally{tick()}})
onBeforeUnmount(()=>{alive=false;epoch++;clearTimeout(timer)})
</script>

<style scoped>
.creation-workspace{display:grid;gap:10px}.canvas-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.canvas-toolbar>.el-select{width:215px}.canvas-toolbar .el-button+.el-button{margin-left:0}.canvas-tip,.muted{font-size:12px;color:var(--text-muted);line-height:1.65;margin:4px 0}.canvas-layout{display:grid;grid-template-columns:minmax(350px,1fr) 355px;border:1px solid var(--border-color);height:calc(100vh - 242px);min-height:580px;border-radius:10px;overflow:hidden}.flow-area{min-width:0;position:relative;background:var(--bg-inner)}.canvas-panel{background:var(--bg-card);border-left:1px solid var(--border-color);padding:0 14px;min-width:0;overflow:auto}.canvas-panel :deep(.el-tab-pane){padding-bottom:16px}.node-editor,.config-form{display:grid;gap:12px}.node-editor label,.config-form label{display:grid;gap:7px;font-size:12px}.node-editor .el-select,.config-form .el-select,.field-pair .el-input-number{width:100%}.field-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.editor-actions{display:flex;gap:6px;flex-wrap:wrap}.editor-actions .el-button{margin:0}.error{color:var(--ui-danger,#d55252);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.file-button{position:relative;cursor:pointer;border:1px solid var(--border-color);border-radius:4px;font-size:13px;padding:8px 12px;color:var(--text-primary);background:var(--bg-card)}.file-button input{position:absolute;inset:0;opacity:0;width:100%;cursor:pointer}.canvas-empty{position:absolute;left:50%;top:35%;transform:translate(-50%,-50%);width:290px;text-align:center;z-index:2;color:var(--text-muted);font-size:13px;line-height:1.7;pointer-events:none}.canvas-empty .el-button{pointer-events:auto}.selected-media{display:grid;gap:8px}.selected-media img,.selected-media video,.selected-media audio{width:100%;max-height:240px;object-fit:contain}.reference-row{display:grid;grid-template-columns:1fr 130px;gap:8px;align-items:center;font-size:12px}.attempt,.job-card{padding:12px;border:1px solid var(--border-color);border-radius:6px;display:grid;gap:8px;margin:8px 0;font-size:12px}.attempt small,.job-card small{display:block;color:var(--text-muted);overflow-wrap:anywhere}.job-card .el-button{margin:4px}.edge-editor{display:grid;gap:10px;padding:12px 0}.agent-summary{display:flex;gap:8px;align-items:center;font-size:13px}.agent-summary strong{overflow-wrap:anywhere}.chat-log{height:calc(100vh - 525px);min-height:250px;overflow:auto;padding:8px 0;margin-bottom:12px}.chat-message{border-radius:6px;padding:10px;margin:8px 0;background:var(--bg-inner);font-size:13px;line-height:1.65}.chat-message.user{background:var(--ui-accent-soft)}.chat-message small{color:var(--text-muted)}.chat-message p{margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere}.chat-message.tool_start,.chat-message.event{font-size:11px;padding:6px}.chat-tool{font-size:11px;color:var(--text-muted);margin:8px 0}.send-button{width:100%;margin-top:8px}.welcome{padding:80px 30px;text-align:center}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:340px;overflow:auto}details summary{cursor:pointer;color:var(--text-muted);font-size:12px;padding:6px 0}.library-search{display:flex;gap:8px}.library-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border-color);font-size:13px}.export-row{display:flex;gap:8px;align-items:center;margin:12px 0}.export-row span{flex:1}.pending-requests{padding:8px;background:var(--ui-accent-soft);font-size:12px}a{color:var(--ui-accent);font-size:12px}h4{margin:10px 0 0;font-size:13px}@media(max-width:1100px){.canvas-layout{grid-template-columns:minmax(280px,1fr) 310px}}@media(max-width:750px){.canvas-layout{grid-template-columns:1fr;height:auto;min-height:0}.flow-area{height:440px}.canvas-panel{border-left:0;border-top:1px solid var(--border-color);max-height:650px}.chat-log{height:280px}.canvas-toolbar>.el-select{width:100%}}
</style>
