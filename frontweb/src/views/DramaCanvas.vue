<template>
  <div class="drama-canvas-page">
    <header class="header">
      <div class="header-inner">
        <div class="header-head">
          <span class="page-title">{{ drama?.title || '加载中…' }}</span>
        </div>

        <p class="page-note">
          画布模式把一集的剧本、素材和分镜摊在一个面上：拖节点改位置，点节点展开编辑，框选分镜后建工作流批量跑。
          <span class="mono">{{ (drama?.episodes || []).length }}</span> 集 ·
          <span class="mono">{{ filteredCharacters.length + filteredScenes.length + filteredProps.length }}</span> 素材 ·
          <span class="mono">{{ nodeCount }}</span> 节点
        </p>

        <div class="header-actions">
          <el-select
            v-model="filterEpisodeId"
            class="episode-select"
            placeholder="全部集数"
            clearable
            size="small"
            style="width: 150px"
          >
            <el-option
              v-for="ep in (drama?.episodes || [])"
              :key="ep.id"
              :label="ep.title || '第' + (ep.episode_number || 0) + '集'"
              :value="ep.id"
            />
          </el-select>

          <span v-if="layoutSaveState === 'saving'" class="layout-status saving">保存中…</span>
          <span v-else-if="layoutSaveState === 'saved'" class="layout-status saved">已保存</span>
          <span v-else-if="layoutSaveState === 'error'" class="layout-status error">保存失败</span>

          <span class="toolbar-sep" />

          <el-button size="small" @click="focusScriptNode">剧本</el-button>
          <el-button size="small" @click="openCreateDialog('storyboard')">
            <el-icon><Plus /></el-icon>
            分镜
          </el-button>
          <el-button size="small" @click="openCreateDialog('character')">角色</el-button>
          <el-button size="small" @click="openCreateDialog('scene')">场景</el-button>
          <el-button size="small" @click="openCreateDialog('prop')">道具</el-button>
          <el-button size="small" @click="openCreateDialog('episode')">
            <el-icon><Plus /></el-icon>
            集
          </el-button>

          <span class="toolbar-sep" />

          <el-button size="small" :loading="aligningNodes" @click="onAlignNodes">
            <el-icon><Grid /></el-icon>
            对齐节点
          </el-button>
          <el-button size="small" :class="{ 'is-on': viewPref.grid }" title="显示 / 隐藏网格底纹" @click="toggleGrid">
            网格
          </el-button>
          <el-button size="small" :class="{ 'is-on': viewPref.minimap }" title="显示 / 隐藏右下角小地图" @click="toggleMiniMap">
            小地图
          </el-button>

          <el-button type="primary" plain @click="goListMode">
            <el-icon><List /></el-icon>
            列表模式
          </el-button>
          <el-button class="btn-theme" @click="toggleTheme">
            <el-icon><Sunny v-if="isDark" /><Moon v-else /></el-icon>
            {{ isDark ? '浅色' : '暗色' }}
          </el-button>
        </div>
      </div>

      <div class="workflow-bar">
        <span class="wf-hint">已选 {{ selectedStoryboardIds.length }} 个分镜</span>
        <el-checkbox-group v-model="pipelineSteps" size="small" class="wf-steps">
          <el-checkbox value="image">生图</el-checkbox>
          <el-checkbox value="video">生视频</el-checkbox>
          <el-checkbox value="audio">配音</el-checkbox>
        </el-checkbox-group>
        <el-button size="small" :disabled="selectedStoryboardIds.length === 0" @click="onCreateWorkflowGroup">
          创建工作流
        </el-button>
        <el-select
          v-model="activeGroupId"
          class="group-select"
          size="small"
          placeholder="选择工作流"
          clearable
          style="width: 160px"
        >
          <el-option
            v-for="g in workflowGroups"
            :key="g.id"
            :label="`${g.title} (${(g.storyboard_ids || []).length}镜)`"
            :value="g.id"
          />
        </el-select>
        <el-button
          size="small"
          type="primary"
          :loading="workflowRunning"
          :disabled="!activeGroupId"
          @click="onRunActiveGroup"
        >
          整组重跑
        </el-button>
        <el-button size="small" type="danger" plain :disabled="!activeGroupId" @click="onDeleteActiveGroup">
          删除工作流
        </el-button>
        <span v-if="workflowGroups.length" class="wf-summary mono">
          共 {{ workflowGroups.length }} 组 · 覆盖 {{ coveredStoryboardCount }} 镜
        </span>
      </div>

      <div v-if="workflowProgress" class="workflow-progress">{{ workflowProgress }}</div>

      <div class="generate-bar">
        <span class="gen-label">本集生成</span>
        <el-button
          size="small"
          type="primary"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="aiGenerateStoryboards"
        >
          AI 生成分镜
        </el-button>
        <el-button
          size="small"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="batchGenerateImages"
        >
          批量生图
        </el-button>
        <el-button
          size="small"
          :loading="episodeGenerating"
          :disabled="!filterEpisodeId || workflowRunning"
          @click="batchGenerateVideos"
        >
          批量生视频
        </el-button>
        <span v-if="!filterEpisodeId" class="gen-hint needs-episode">先在右上角选一集，本集生成才知道跑在哪一集</span>
        <span v-else class="gen-hint" title="完整创作流水线">当前集 {{ currentEpisodeShotCount }} 镜 · 流水线：剧本 → 提取角色/场景/道具 → 分镜 → 生图 → 视频（生图/生视频会按已有的次数计费）</span>
      </div>
      <div v-if="episodeGenProgress" class="workflow-progress episode-gen">{{ episodeGenProgress }}</div>
    </header>

    <div v-loading="loading" class="canvas-shell">
      <aside v-if="drama" class="canvas-sidebar">
        <div class="sidebar-section sidebar-script">
          <div class="sec-label sec-label-row">
            <span>剧本</span>
            <span class="sec-count mono">{{ (drama.episodes || []).length }} 集</span>
          </div>
          <p class="sidebar-script-tip">从头创作：先写剧本，再提取素材</p>
          <el-button size="small" class="sidebar-script-btn" @click="focusScriptNode">打开剧本节点</el-button>
        </div>

        <div class="sidebar-title">
          素材库
          <el-button v-if="highlightAssetId" link size="small" @click="clearAssetHighlight">清除高亮</el-button>
        </div>

        <div class="sidebar-filters">
          <el-input v-model="assetQuery" size="small" clearable placeholder="按名称筛选" />
          <el-select v-model="assetSort" size="small" class="asset-sort" title="素材排序方式">
            <el-option label="默认顺序" value="default" />
            <el-option label="按名称" value="name" />
          </el-select>
        </div>

        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>角色 <span class="sec-count mono">{{ filteredCharacters.length }}</span></span>
            <el-button link size="small" @click="openCreateDialog('character')">新建</el-button>
          </div>
          <div
            v-for="c in filteredCharacters"
            :key="'c-' + c.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'char:' + c.id }"
            :title="c.name || '未命名'"
            @click="selectSidebarAsset('char:' + c.id)"
          >
            {{ c.name || '未命名' }}
          </div>
          <div v-if="!filteredCharacters.length" class="sidebar-empty">
            {{ assetQuery ? '没有匹配的角色' : '还没有角色，先在剧本节点提取或手动新建' }}
          </div>
        </div>

        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>场景 <span class="sec-count mono">{{ filteredScenes.length }}</span></span>
            <el-button link size="small" @click="openCreateDialog('scene')">新建</el-button>
          </div>
          <div
            v-for="s in filteredScenes"
            :key="'s-' + s.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'scene:' + s.id }"
            :title="s.location || '未命名'"
            @click="selectSidebarAsset('scene:' + s.id)"
          >
            {{ s.location || '未命名' }}
          </div>
          <div v-if="!filteredScenes.length" class="sidebar-empty">
            {{ assetQuery ? '没有匹配的场景' : '还没有场景，先在剧本节点提取或手动新建' }}
          </div>
        </div>

        <div class="sidebar-section">
          <div class="sec-label sec-label-row">
            <span>道具 <span class="sec-count mono">{{ filteredProps.length }}</span></span>
            <el-button link size="small" @click="openCreateDialog('prop')">新建</el-button>
          </div>
          <div
            v-for="p in filteredProps"
            :key="'p-' + p.id"
            class="sidebar-item"
            :class="{ active: highlightAssetId === 'prop:' + p.id }"
            :title="p.name || '未命名'"
            @click="selectSidebarAsset('prop:' + p.id)"
          >
            {{ p.name || '未命名' }}
          </div>
          <div v-if="!filteredProps.length" class="sidebar-empty">
            {{ assetQuery ? '没有匹配的道具' : '还没有道具，先在剧本节点提取或手动新建' }}
          </div>
        </div>

        <div class="sidebar-section workflow-list">
          <div class="sec-label sec-label-row">
            <span>工作流 <span class="sec-count mono">{{ workflowGroups.length }}</span></span>
          </div>
          <div
            v-for="g in workflowGroups"
            :key="g.id"
            class="sidebar-item workflow-item"
            :class="{ active: activeGroupId === g.id }"
            @click="activeGroupId = g.id"
          >
            <div class="wf-item-title">{{ g.title }}</div>
            <div class="wf-item-meta mono">{{ (g.storyboard_ids || []).length }} 镜 · {{ (g.pipeline || []).join(' → ') }}</div>
          </div>
          <div v-if="!workflowGroups.length" class="sidebar-empty">
            还没有工作流，先在画布上框选分镜
            <el-button
              link
              size="small"
              :disabled="selectedStoryboardIds.length === 0"
              @click="onCreateWorkflowGroup"
            >
              用选中的 {{ selectedStoryboardIds.length }} 个分镜建一个
            </el-button>
          </div>
        </div>

        <p class="sidebar-tip">经典模式流水线：分镜 → 脚本摘要 → 分镜图 → 视频。摘要节点是画布可视化，列表里合并在分镜编辑区。顶栏「本集生成」可 AI 批量操作；单击分镜可单镜生图 / 生视频。</p>
      </aside>

      <div ref="canvasMainRef" class="canvas-main">
        <VueFlow
          v-if="nodes.length"
          v-model:nodes="nodes"
          v-model:edges="edges"
          :node-types="nodeTypes"
          :default-viewport="initialViewport"
          :min-zoom="0.08"
          :max-zoom="2"
          :nodes-connectable="false"
          :elements-selectable="true"
          :selection-key-code="true"
          :pan-on-drag="[1, 2]"
          :pan-on-scroll="true"
          :fit-view-on-init="!hasSavedViewport"
          class="vue-flow-canvas"
          @node-double-click="onNodeDoubleClick"
          @node-click="onNodeClick"
          @pane-click="onPaneClick"
          @pane-context-menu="onPaneContextMenu"
          @node-drag-stop="scheduleLayoutSave"
          @viewport-change="onViewportChange"
          @move-end="scheduleLayoutSave"
          @selection-change="onSelectionChange"
        >
          <CanvasFlowAligner />
          <Background v-if="viewPref.grid" pattern-color="var(--border-color, #3f3f46)" :gap="20" />
          <Controls />
          <MiniMap
            v-if="viewPref.minimap"
            pannable
            zoomable
            node-color="var(--text-faint, #5a606a)"
            mask-color="rgba(9, 11, 14, .72)"
            :width="168"
            :height="112"
          />
        </VueFlow>
        <el-empty v-else-if="!loading" description="这一集还没有画布数据">
          <el-button type="primary" plain @click="openCreateDialog('storyboard')">新建第一个分镜</el-button>
        </el-empty>
        <CanvasFloatingToolbar v-if="drama && nodes.length" />
      </div>
    </div>

    <CanvasCreateDialog
      v-model="createDialogVisible"
      :type="createDialogType"
      :on-submit="onCreateSubmit"
    />
    <CanvasContextMenu
      :visible="contextMenuVisible"
      :x="contextMenuX"
      :y="contextMenuY"
      @select="onContextMenuSelect"
      @close="closeContextMenu"
    />
  </div>
</template>

<script setup>
import { computed, markRaw, nextTick, onBeforeUnmount, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { VueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import { List, Moon, Plus, Sunny, Grid } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'

import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import { dramaAPI } from '@/api/drama'
import { useTheme } from '@/composables/useTheme'
import { runWorkflowGroup } from '@/composables/useCanvasWorkflowRunner'
import { CANVAS_CONTEXT_KEY } from '@/composables/useCanvasContext'
import { useCanvasStoryboardMedia } from '@/composables/useCanvasStoryboardMedia'
import { useCanvasCrud } from '@/composables/useCanvasCrud'
import { useCanvasEpisodeGenerate } from '@/composables/useCanvasEpisodeGenerate'
import { useCanvasScript, scriptNodeId } from '@/composables/useCanvasScript'
import { fxEnabled } from '@/composables/useEffects'
import { createCanvasNodeStatusStore } from '@/composables/useCanvasNodeStatus'
import {
  applyCanvasHighlight,
  buildDramaCanvasGraph,
  computeAutoLayoutPositions,
  getStoryboardRefFromNode,
  stampEdgeBaseStyles,
} from '@/utils/dramaCanvasAdapter'
import {
  buildCanvasLayoutPayload,
  parseCanvasLayout,
  parseDramaMetadata,
  resolveViewport,
} from '@/utils/canvasLayout'
import {
  createWorkflowGroup,
  deleteWorkflowGroup,
  findStoryboardInDrama,
  normalizePipeline,
  parseWorkflowGroups,
  storyboardIdFromNodeId,
  getDramaGenerationOptions,
} from '@/utils/canvasWorkflow'

import CanvasLabelNode from '@/components/dramaCanvas/CanvasLabelNode.vue'
import CanvasDramaHeaderNode from '@/components/dramaCanvas/CanvasDramaHeaderNode.vue'
import CanvasAssetNode from '@/components/dramaCanvas/CanvasAssetNode.vue'
import CanvasEpisodeNode from '@/components/dramaCanvas/CanvasEpisodeNode.vue'
import CanvasScriptNode from '@/components/dramaCanvas/CanvasScriptNode.vue'
import CanvasStoryboardNode from '@/components/dramaCanvas/CanvasStoryboardNode.vue'
import CanvasMediaNode from '@/components/dramaCanvas/CanvasMediaNode.vue'
import CanvasCreateDialog from '@/components/dramaCanvas/CanvasCreateDialog.vue'
import CanvasContextMenu from '@/components/dramaCanvas/CanvasContextMenu.vue'
import CanvasAddButtonNode from '@/components/dramaCanvas/CanvasAddButtonNode.vue'
import CanvasFloatingToolbar from '@/components/dramaCanvas/CanvasFloatingToolbar.vue'
import CanvasFlowAligner from '@/components/dramaCanvas/CanvasFlowAligner.vue'

const route = useRoute()
const router = useRouter()
const { isDark, toggle: toggleTheme } = useTheme()
const { imagesBySbId, videosBySbId, loadForDrama } = useCanvasStoryboardMedia()

const loading = ref(false)
const drama = ref(null)
const nodes = ref([])
const edges = ref([])
const filterEpisodeId = ref(null)
const highlightAssetId = ref(null)
const layoutCache = ref(null)
const workflowGroups = ref([])
const activeGroupId = ref(null)
const selectedStoryboardIds = ref([])
const pipelineSteps = ref(readPipelineSteps() || ['image', 'video', 'audio'])
const workflowRunning = ref(false)
const workflowProgress = ref('')
const layoutSaveState = ref('idle')
const layoutDirty = ref(false)
const currentViewport = ref({ x: 0, y: 0, zoom: 0.75 })
const focusedNodeId = ref(null)
const canvasMainRef = ref(null)
const contextMenuVisible = ref(false)
const contextMenuX = ref(0)
const contextMenuY = ref(0)
const contextMenuFlowPos = ref(null)
const paneClickSuppressed = ref(false)
const nodeStatus = createCanvasNodeStatusStore()
const aligningNodes = ref(false)
const canvasFlowApi = ref(null)

const PANEL_NODE_TYPES = new Set(['canvasStoryboard', 'canvasMedia', 'canvasAsset', 'canvasScript'])

let saveTimer = null
let savedHintTimer = null
let pollTimer = null
let paneClickSuppressTimer = null

/* ── 画布视图偏好：记住上次用的网格 / 小地图，键名前缀 yinzi- ───────── */
const VIEW_KEY = 'yinzi-drama-canvas-view'
function readViewPref() {
  try {
    const raw = localStorage.getItem(VIEW_KEY)
    if (!raw) return { grid: true, minimap: true }
    const v = JSON.parse(raw)
    return { grid: v?.grid !== false, minimap: v?.minimap !== false }
  } catch (_) {
    return { grid: true, minimap: true }
  }
}
const viewPref = ref(readViewPref())
function persistViewPref() {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(viewPref.value)) } catch (_) {}
}
function toggleGrid() {
  viewPref.value.grid = !viewPref.value.grid
  persistViewPref()
}
function toggleMiniMap() {
  viewPref.value.minimap = !viewPref.value.minimap
  persistViewPref()
}
/* 边线动画只在「完整」档位开；低档位保留虚线样式，去掉流动效果 */
const edgeAnimOn = computed(() => fxEnabled('anim'))
watch(edgeAnimOn, () => rebuildGraph())

/* ── 流水线勾选：默认值同时记住上次的选择 ─────────────────────────── */
const PIPELINE_KEY = 'yinzi-drama-pipeline-steps'
function readPipelineSteps() {
  try {
    const raw = localStorage.getItem(PIPELINE_KEY)
    if (!raw) return null
    const arr = JSON.parse(raw)
    if (Array.isArray(arr) && arr.length) return arr
  } catch (_) {}
  return null
}
watch(pipelineSteps, (v) => {
  try { localStorage.setItem(PIPELINE_KEY, JSON.stringify(v)) } catch (_) {}
}, { deep: true })

/* ── 素材库筛选与排序：列表长了要能找得到 ─────────────────────────── */
const assetQuery = ref('')
const assetSort = ref('default')
const ASSET_SORT_KEY = 'yinzi-drama-asset-sort'
try {
  const savedSort = localStorage.getItem(ASSET_SORT_KEY)
  if (savedSort) assetSort.value = savedSort
} catch (_) {}
watch(assetSort, (v) => {
  try { localStorage.setItem(ASSET_SORT_KEY, v) } catch (_) {}
})

function filterAssets(list, labelOf) {
  const q = assetQuery.value.trim().toLowerCase()
  let out = (list || []).map((item, idx) => ({ item, idx }))
  if (q) {
    out = out.filter(({ item }) => String(labelOf(item) || '未命名').toLowerCase().includes(q))
  }
  if (assetSort.value === 'name') {
    out = out.slice().sort((a, b) =>
      String(labelOf(a.item) || '').localeCompare(String(labelOf(b.item) || ''), 'zh-Hans-CN')
    )
  }
  return out.map(({ item }) => item)
}
const charLabel = (c) => c?.name
const sceneLabel = (s) => s?.location
const propLabel = (p) => p?.name

const filteredCharacters = computed(() => filterAssets(drama.value?.characters, charLabel))
const filteredScenes = computed(() => filterAssets(drama.value?.scenes, sceneLabel))
const filteredProps = computed(() => filterAssets(drama.value?.props, propLabel))

const nodeTypes = {
  canvasLabel: markRaw(CanvasLabelNode),
  canvasDramaHeader: markRaw(CanvasDramaHeaderNode),
  canvasAsset: markRaw(CanvasAssetNode),
  canvasEpisode: markRaw(CanvasEpisodeNode),
  canvasScript: markRaw(CanvasScriptNode),
  canvasStoryboard: markRaw(CanvasStoryboardNode),
  canvasMedia: markRaw(CanvasMediaNode),
  canvasAddButton: markRaw(CanvasAddButtonNode),
}

const dramaId = computed(() => Number(route.params.id))
const savedLayout = computed(() => layoutCache.value || parseCanvasLayout(drama.value?.metadata))

const initialViewport = computed(() => {
  const v = resolveViewport(savedLayout.value)
  return { x: v.x, y: v.y, zoom: v.zoom }
})

const hasSavedViewport = computed(() => Boolean(savedLayout.value?.viewport))

/* 顶栏上要露出来的几个数：节点数、工作流覆盖镜数、当前集镜数 */
const nodeCount = computed(() => nodes.value.length)
const coveredStoryboardCount = computed(() => {
  const ids = new Set()
  for (const g of workflowGroups.value) for (const id of g.storyboard_ids || []) ids.add(id)
  return ids.size
})
const currentEpisodeShotCount = computed(() => {
  if (!filterEpisodeId.value) return 0
  const ep = (drama.value?.episodes || []).find((e) => e.id === filterEpisodeId.value)
  return (ep?.storyboards || []).length
})

function syncWorkflowFromDrama() {
  workflowGroups.value = parseWorkflowGroups(drama.value?.metadata)
  if (activeGroupId.value && !workflowGroups.value.some((g) => g.id === activeGroupId.value)) {
    activeGroupId.value = null
  }
}

function rebuildGraph() {
  if (!drama.value) {
    nodes.value = []
    edges.value = []
    return
  }
  const graph = buildDramaCanvasGraph(drama.value, {
    episodeId: filterEpisodeId.value,
    savedLayout: savedLayout.value,
    workflowGroups: workflowGroups.value,
    imagesBySbId: imagesBySbId.value,
    videosBySbId: videosBySbId.value,
  })
  let nextNodes = graph.nodes
  // 连线流动动画只在「完整」档位开；低档位去掉 animated，保留静态边线
  let nextEdges = stampEdgeBaseStyles(
    edgeAnimOn.value ? graph.edges : graph.edges.map((e) => ({ ...e, animated: false }))
  )
  if (highlightAssetId.value) {
    const highlighted = applyCanvasHighlight(nextNodes, nextEdges, highlightAssetId.value, drama.value, {
      anim: edgeAnimOn.value,
    })
    nextNodes = highlighted.nodes
    nextEdges = highlighted.edges
  }
  nodes.value = nextNodes
  edges.value = nextEdges
}

function applyHighlight() {
  if (!nodes.value.length) return
  const highlighted = applyCanvasHighlight(
    nodes.value.map((n) => ({ ...n, class: undefined, data: { ...n.data, highlighted: false, dimmed: false } })),
    edges.value,
    highlightAssetId.value,
    drama.value,
    { anim: edgeAnimOn.value }
  )
  nodes.value = highlighted.nodes
  edges.value = highlighted.edges
}

function selectSidebarAsset(assetNodeId) {
  highlightAssetId.value = highlightAssetId.value === assetNodeId ? null : assetNodeId
  applyHighlight()
}

function setHighlightAsset(assetNodeId) {
  highlightAssetId.value = assetNodeId
  applyHighlight()
}

async function refreshDrama(preserveFocus = true) {
  const keepId = preserveFocus ? focusedNodeId.value : null
  await loadDrama(true)
  await loadForDrama(drama.value, filterEpisodeId.value)
  rebuildGraph()
  if (keepId) focusedNodeId.value = keepId
}

async function refreshCanvas(preserveFocus = true) {
  await refreshDrama(preserveFocus)
}

function suppressPaneClick(ms = 350) {
  paneClickSuppressed.value = true
  if (paneClickSuppressTimer) clearTimeout(paneClickSuppressTimer)
  paneClickSuppressTimer = setTimeout(() => {
    paneClickSuppressed.value = false
    paneClickSuppressTimer = null
  }, ms)
}

function screenToFlowPosition(clientX, clientY) {
  const el = canvasMainRef.value
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const vp = currentViewport.value
  return {
    x: (clientX - rect.left - vp.x) / vp.zoom,
    y: (clientY - rect.top - vp.y) / vp.zoom,
  }
}

function onPaneContextMenu(payload) {
  const event = payload?.event || payload
  if (event?.preventDefault) event.preventDefault()
  const flowPos = payload?.flowPosition || screenToFlowPosition(event.clientX, event.clientY)
  contextMenuFlowPos.value = flowPos
  contextMenuX.value = event.clientX
  contextMenuY.value = event.clientY
  contextMenuVisible.value = true
}

function closeContextMenu() {
  contextMenuVisible.value = false
  contextMenuFlowPos.value = null
}

function onContextMenuSelect(type) {
  pendingFlowPosition.value = contextMenuFlowPos.value
  openCreateDialog(type, contextMenuFlowPos.value)
  closeContextMenu()
}

async function onCreateSubmit(form) {
  try {
    await submitCreate(form)
  } catch (e) {
    ElMessage.error(e?.message || '创建失败')
  }
}

function getCanvasGenerationOptions() {
  return {
    ...getDramaGenerationOptions(drama.value),
    imagesBySbId: imagesBySbId.value,
  }
}

const scriptActionsHolder = {}

provide(CANVAS_CONTEXT_KEY, {
  focusedNodeId,
  drama,
  imagesBySbId,
  videosBySbId,
  getGenerationOptions: getCanvasGenerationOptions,
  setFocusedNode: (nodeId) => {
    focusedNodeId.value = nodeId
  },
  clearFocusedNode: () => {
    focusedNodeId.value = null
  },
  setHighlightAsset,
  refresh: refreshCanvas,
  refreshDrama,
  suppressPaneClick,
  nodeStatus,
  openCreateDialog: (...args) => openCreateDialog(...args),
  scriptActions: scriptActionsHolder,
  registerCanvasFlowApi: (api) => {
    canvasFlowApi.value = api
  },
})

function clearAssetHighlight() {
  highlightAssetId.value = null
  applyHighlight()
}

function onSelectionChange({ nodes: selectedNodes }) {
  selectedStoryboardIds.value = (selectedNodes || [])
    .filter((n) => n.type === 'canvasStoryboard' && n.data?.storyboard?.id)
    .map((n) => n.data.storyboard.id)
}

function onViewportChange(viewport) {
  currentViewport.value = { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
}

function scheduleLayoutSave() {
  layoutDirty.value = true
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistCanvasState({ layoutOnly: true })
  }, 700)
}

async function persistCanvasState({ layoutOnly = false, groupsOnly = false } = {}) {
  if (!dramaId.value) return

  let layoutPayload = null
  if (!groupsOnly) {
    layoutPayload = buildCanvasLayoutPayload(nodes.value, currentViewport.value, layoutCache.value)
    if (layoutOnly && layoutPayload) layoutCache.value = layoutPayload
  }
  const groupsPayload = groupsOnly || !layoutOnly ? workflowGroups.value : undefined

  layoutSaveState.value = 'saving'
  try {
    const updated = await dramaAPI.saveCanvasLayout(dramaId.value, layoutPayload, groupsPayload)
    const meta = parseDramaMetadata(updated.metadata)
    if (meta.canvas_layout) layoutCache.value = meta.canvas_layout
    if (meta.workflow_groups) workflowGroups.value = meta.workflow_groups
    // 仅合并 metadata / 时间戳，勿用精简对象覆盖 episodes、characters 等完整数据
    if (drama.value && updated) {
      drama.value = {
        ...drama.value,
        metadata: updated.metadata,
        updated_at: updated.updated_at,
        title: updated.title ?? drama.value.title,
        style: updated.style ?? drama.value.style,
        genre: updated.genre ?? drama.value.genre,
        description: updated.description ?? drama.value.description,
      }
      if (Array.isArray(updated.episodes) && updated.episodes.length) {
        drama.value.episodes = updated.episodes
      }
      if (Array.isArray(updated.characters)) {
        drama.value.characters = updated.characters
      }
      if (Array.isArray(updated.scenes)) {
        drama.value.scenes = updated.scenes
      }
      if (Array.isArray(updated.props)) {
        drama.value.props = updated.props
      }
    } else if (updated) {
      drama.value = updated
    }
    layoutSaveState.value = 'saved'
    layoutDirty.value = false
    if (savedHintTimer) clearTimeout(savedHintTimer)
    savedHintTimer = setTimeout(() => {
      if (layoutSaveState.value === 'saved') layoutSaveState.value = 'idle'
    }, 2000)
  } catch (e) {
    layoutSaveState.value = 'error'
    ElMessage.error(e?.message || '保存失败')
  }
}

const {
  createDialogVisible,
  createDialogType,
  pendingFlowPosition,
  openCreateDialog,
  submitCreate,
} = useCanvasCrud({
  drama,
  filterEpisodeId,
  layoutCache,
  focusedNodeId,
  refreshCanvas,
  persistCanvasState,
})

const {
  episodeGenerating,
  episodeGenProgress,
  aiGenerateStoryboards,
  batchGenerateImages,
  batchGenerateVideos,
} = useCanvasEpisodeGenerate({
  drama,
  filterEpisodeId,
  imagesBySbId,
  videosBySbId,
  refreshCanvas,
  nodeStatus,
})

Object.assign(
  scriptActionsHolder,
  useCanvasScript({
    drama,
    dramaId,
    refreshCanvas: refreshDrama,
    nodeStatus,
  })
)

function focusScriptNode() {
  let epId = filterEpisodeId.value
  if (!epId) {
    const eps = drama.value?.episodes || []
    if (eps.length === 1) epId = eps[0].id
  }
  if (!epId) {
    ElMessage.warning('请先选择或新建集数')
    return
  }
  if (!filterEpisodeId.value) filterEpisodeId.value = epId
  focusedNodeId.value = scriptNodeId(epId)
}

async function onAlignNodes() {
  if (!drama.value || !nodes.value.length || aligningNodes.value) return
  aligningNodes.value = true
  focusedNodeId.value = null
  try {
    const { positions } = computeAutoLayoutPositions(drama.value, {
      episodeId: filterEpisodeId.value,
      workflowGroups: workflowGroups.value,
      imagesBySbId: imagesBySbId.value,
      videosBySbId: videosBySbId.value,
    })
    nodes.value = nodes.value.map((n) => {
      const pos = positions[n.id]
      return pos ? { ...n, position: { x: pos.x, y: pos.y } } : n
    })
    layoutCache.value = {
      version: 1,
      nodes: { ...positions },
      viewport: layoutCache.value?.viewport,
    }
    await nextTick()
    const flowApi = canvasFlowApi.value
    if (flowApi?.fitView) {
      await flowApi.fitView({
        padding: 0.14,
        duration: 380,
        includeHiddenNodes: false,
      })
      await new Promise((r) => setTimeout(r, 400))
      const vp = flowApi.getViewport?.()
      if (vp) {
        currentViewport.value = { x: vp.x, y: vp.y, zoom: vp.zoom }
      }
    }
    await persistCanvasState({ layoutOnly: true })
    ElMessage.success('节点已按规则对齐并适配当前视图')
  } catch (e) {
    ElMessage.error(e?.message || '对齐失败')
  } finally {
    aligningNodes.value = false
  }
}

async function loadDrama(silent = false) {
  if (!dramaId.value) return
  if (!silent) loading.value = true
  try {
    drama.value = await dramaAPI.get(dramaId.value)
    layoutCache.value = parseCanvasLayout(drama.value.metadata)
    syncWorkflowFromDrama()
    const vp = resolveViewport(layoutCache.value)
    currentViewport.value = vp
    if (route.query.episode) filterEpisodeId.value = Number(route.query.episode)
    await loadForDrama(drama.value, filterEpisodeId.value)
    rebuildGraph()
  } catch (e) {
    if (!silent) ElMessage.error(e?.message || '加载项目失败')
  } finally {
    if (!silent) loading.value = false
  }
}

async function onCreateWorkflowGroup() {
  if (!selectedStoryboardIds.value.length) {
    ElMessage.warning('请先框选或 Ctrl 点击选择分镜节点')
    return
  }
  try {
    const { value } = await ElMessageBox.prompt('工作流名称', '创建工作流', {
      confirmButtonText: '创建',
      cancelButtonText: '取消',
      inputValue: `工作流 ${workflowGroups.value.length + 1}`,
    })
    workflowGroups.value = createWorkflowGroup(workflowGroups.value, {
      title: value?.trim() || undefined,
      storyboardIds: selectedStoryboardIds.value,
      pipeline: normalizePipeline(pipelineSteps.value),
    })
    activeGroupId.value = workflowGroups.value[workflowGroups.value.length - 1]?.id || null
    await persistCanvasState({ groupsOnly: true })
    rebuildGraph()
    ElMessage.success('工作流已创建')
  } catch (_) {}
}

async function onDeleteActiveGroup() {
  if (!activeGroupId.value) return
  try {
    await ElMessageBox.confirm('确定删除该工作流？', '删除工作流', { type: 'warning' })
    workflowGroups.value = deleteWorkflowGroup(workflowGroups.value, activeGroupId.value)
    activeGroupId.value = workflowGroups.value[0]?.id || null
    await persistCanvasState({ groupsOnly: true })
    rebuildGraph()
    ElMessage.success('已删除')
  } catch (_) {}
}

async function onRunActiveGroup() {
  const group = workflowGroups.value.find((g) => g.id === activeGroupId.value)
  if (!group) {
    ElMessage.warning('请先选择工作流')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将对 ${(group.storyboard_ids || []).length} 个分镜依次执行：${(group.pipeline || pipelineSteps.value).join(' → ')}\n耗时可能较长，是否继续？`,
      '整组重跑',
      { type: 'warning', confirmButtonText: '开始执行' }
    )
  } catch {
    return
  }

  workflowRunning.value = true
  workflowProgress.value = '准备执行…'
  try {
    const summary = await runWorkflowGroup(drama.value, {
      ...group,
      pipeline: normalizePipeline(group.pipeline?.length ? group.pipeline : pipelineSteps.value),
    }, {
      stopOnError: true,
      generationOptions: getCanvasGenerationOptions(),
      reloadStoryboard: async (storyboardId) => {
        await loadDrama(true)
        return findStoryboardInDrama(drama.value, storyboardId)?.storyboard
      },
      onStepStart: ({ storyboardId, step }) => {
        workflowProgress.value = `分镜 #${storyboardId}：${step === 'image' ? '生图' : step === 'video' ? '生视频' : '配音'}…`
      },
      onStoryboardError: ({ storyboardId, error }) => {
        ElMessage.error(`分镜 #${storyboardId} 失败：${error?.message || error}`)
      },
    })
    await loadDrama(true)
    await loadForDrama(drama.value, filterEpisodeId.value)
    rebuildGraph()
    if (summary.failed.length) {
      ElMessage.warning(`完成 ${summary.ok.length} 镜，失败 ${summary.failed.length} 镜`)
    } else {
      ElMessage.success(`工作流执行完成，共 ${summary.ok.length} 镜`)
    }
  } catch (e) {
    ElMessage.error(e?.message || '工作流执行失败')
  } finally {
    workflowRunning.value = false
    workflowProgress.value = ''
  }
}

function hasProcessingStoryboards() {
  for (const ep of drama.value?.episodes || []) {
    for (const sb of ep.storyboards || []) {
      if (sb.status === 'processing') return true
    }
  }
  return false
}

function startStatusPoll() {
  stopStatusPoll()
  if (!hasProcessingStoryboards()) return
  pollTimer = setInterval(() => {
    if (hasProcessingStoryboards()) loadDrama(true)
    else stopStatusPoll()
  }, 8000)
}

function stopStatusPoll() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function goListMode() {
  const query = filterEpisodeId.value ? { episode: String(filterEpisodeId.value) } : {}
  router.push({ path: `/film/${dramaId.value}`, query })
}

function navigateToStoryboard(episodeId, storyboardId) {
  router.push({
    path: `/film/${dramaId.value}`,
    query: episodeId ? { episode: String(episodeId) } : {},
    hash: storyboardId ? `#sb-${storyboardId}` : undefined,
  })
}

function onNodeDoubleClick({ node }) {
  if (node.type === 'canvasStoryboard') {
    navigateToStoryboard(node.data.episodeId || node.data.storyboard?.episode_id, node.data.storyboard?.id)
    return
  }
  const ref = getStoryboardRefFromNode(node)
  if (ref?.storyboardId) navigateToStoryboard(ref.episodeId, ref.storyboardId)
}

function onPaneClick(event) {
  if (paneClickSuppressed.value) return
  const target = event?.event?.target || event?.target
  if (target?.closest?.('.canvas-node-panel') || target?.closest?.('.el-popper') || target?.closest?.('.canvas-context-menu')) {
    return
  }
  focusedNodeId.value = null
  closeContextMenu()
}

function onNodeClick({ node, event }) {
  if (node.type === 'canvasAddButton') {
    event?.stopPropagation?.()
    openCreateDialog(node.data?.assetType || 'storyboard')
    return
  }

  if (PANEL_NODE_TYPES.has(node.type)) {
    focusedNodeId.value = node.id
  }

  if (node.type === 'canvasAsset') {
    const prefix = node.data.kind === 'character' ? 'char' : node.data.kind === 'scene' ? 'scene' : 'prop'
    selectSidebarAsset(`${prefix}:${node.data.entity.id}`)
    return
  }
  const sbId = storyboardIdFromNodeId(node.id)
  if (sbId) activeGroupId.value = workflowGroups.value.find((g) => (g.storyboard_ids || []).includes(sbId))?.id || activeGroupId.value
}

watch(filterEpisodeId, async (val) => {
  if (drama.value) await loadForDrama(drama.value, val)
  rebuildGraph()
  const query = { ...route.query }
  if (val != null) query.episode = String(val)
  else delete query.episode
  router.replace({ query }).catch(() => {})
})

watch(() => route.params.id, () => {
  highlightAssetId.value = null
  layoutCache.value = null
  activeGroupId.value = null
  selectedStoryboardIds.value = []
  focusedNodeId.value = null
  loadDrama()
}, { immediate: true })

watch(drama, () => startStatusPoll())

onBeforeUnmount(() => {
  if (saveTimer) clearTimeout(saveTimer)
  if (savedHintTimer) clearTimeout(savedHintTimer)
  if (paneClickSuppressTimer) clearTimeout(paneClickSuppressTimer)
  stopStatusPoll()
  if (layoutDirty.value) persistCanvasState({ layoutOnly: true })
})
</script>

<style scoped>
/* ── 页面骨架：暗房底色，一根线分区，不用卡片堆 ────────────── */
.drama-canvas-page {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-page);
  color: var(--text-primary);
  overflow: hidden;
}

.header {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-card);
}

/* 标题 + 说明在左，操作在右；操作允许换到第二行，别把它挤成一格一格的 */
.header-inner {
  display: flex;
  align-items: center;
  gap: 10px 14px;
  padding: 9px 16px 7px;
  flex-wrap: wrap;
}
.header-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-width: 0;
  flex: 0 1 auto;
}

.page-title {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  letter-spacing: -.01em;
  color: var(--text-bright);
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 一行说明：这一页管什么，改了会影响什么 */
.page-note {
  margin: 0;
  min-width: 0;
  flex: 1 1 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-subtle);
}
.page-note .mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-left: auto;
}
/* 按钮之间的竖线：分组靠一根线，不靠间距猜 */
.toolbar-sep {
  flex: 0 0 1px;
  align-self: center;
  height: 18px;
  background: var(--border-muted);
  margin: 0 3px;
}
/* 视图开关：开着才是铬底，一眼看出当前状态 */
.header-actions :deep(.el-button.is-on) {
  border-color: var(--border-bright);
  background: var(--ui-accent-soft);
  color: var(--text-bright);
}

.workflow-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 8px;
  flex-wrap: wrap;
}

.wf-hint {
  font-size: 11.5px;
  color: var(--text-subtle);
}

.wf-steps {
  display: flex;
  gap: 4px;
}

.wf-summary {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
}

.workflow-progress {
  padding: 0 16px 8px;
  font-size: 11.5px;
  color: var(--ui-warning);
}

.workflow-progress.episode-gen {
  color: var(--ui-warning);
}

.generate-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px 9px;
  flex-wrap: wrap;
  border-top: 1px solid var(--border-color);
}

.gen-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
  margin-right: 2px;
}

.gen-hint {
  font-size: 11px;
  color: var(--text-faint);
  flex: 1;
  min-width: 200px;
}
.gen-hint.needs-episode { color: var(--ui-warning); }

.layout-status { font-size: 11.5px; }
.layout-status.saving { color: var(--ui-warning); }
.layout-status.saved { color: var(--ui-success); }
.layout-status.error { color: var(--ui-danger); }

/* ── 左侧素材栏 ──────────────────────────────────────────── */
.canvas-shell {
  flex: 1;
  display: flex;
  min-height: 0;
}

.canvas-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  background: var(--bg-card);
  padding: 12px 12px 16px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border-muted) transparent;
}

.sidebar-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: .02em;
  margin: 4px 0 8px;
  color: var(--text-muted);
}

.sidebar-section { margin-bottom: 14px; }
.sidebar-script {
  padding-bottom: 12px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
}
.sidebar-script-tip {
  margin: 0 0 8px;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-subtle);
}
.sidebar-script-btn { width: 100%; justify-content: center; }

.sidebar-filters {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 92px;
  gap: 6px;
  margin-bottom: 12px;
}

.sec-label {
  font-size: 11px;
  color: var(--text-subtle);
  margin-bottom: 5px;
}
.sec-count {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
  font-size: 10.5px;
}

.sec-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sidebar-item {
  font-size: 12px;
  padding: 5px 8px;
  border-left: 2px solid transparent;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  transition: background .15s, border-color .15s;
}
.sidebar-item:hover { background: var(--bg-hover); }
/* 选中用铬色的左竖线标示，不是绿色块 */
.sidebar-item.active {
  background: var(--ui-accent-soft);
  border-left-color: var(--ui-accent);
  color: var(--text-bright);
}

.workflow-item { white-space: normal; }
.wf-item-title { font-weight: 600; }
.wf-item-meta {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  color: var(--text-faint);
  margin-top: 2px;
}
.sidebar-empty {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-faint);
  padding: 4px 0;
}

.sidebar-tip {
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-faint);
  margin-top: 16px;
  padding-top: 10px;
  border-top: 1px solid var(--border-color);
}

/* ── 画布 ────────────────────────────────────────────────── */
.canvas-main {
  flex: 1;
  min-width: 0;
  position: relative;
}

.vue-flow-canvas {
  width: 100%;
  height: 100%;
  background: var(--bg-deep, #0e1013);
}

:deep(.vue-flow__minimap) {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

:deep(.vue-flow__controls) {
  box-shadow: none;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

:deep(.vue-flow__controls button) {
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
}
:deep(.vue-flow__controls button:hover) { background: var(--bg-hover); }

/* 选中用铬线，不用紫色 */
:deep(.vue-flow__node.selected) {
  box-shadow: 0 0 0 1px var(--border-bright);
}

/* 连线与端口统一成铬色，避免和状态色抢注意力 */
:deep(.vue-flow__edge-path) { stroke: var(--border-bright); }
:deep(.vue-flow__edge.selected .vue-flow__edge-path) { stroke: var(--ui-accent); }
:deep(.vue-flow__handle) {
  width: 7px;
  height: 7px;
  background: var(--bg-card);
  border: 1px solid var(--border-bright);
}
:deep(.vue-flow__handle:hover) { background: var(--ui-accent); }

/* 这一页节点多，拖动时不要在每个节点上做滤镜/毛玻璃 */
:deep(.vue-flow__node) { backdrop-filter: none; filter: none; }
</style>

<style>
html.light .drama-canvas-page { background: var(--bg-page); }
html.light .vue-flow-canvas { background: var(--bg-deep); }
</style>
