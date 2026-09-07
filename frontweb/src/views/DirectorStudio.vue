<template>
  <div :class="['director-studio', { 'has-blender-result': blenderRendering || blenderRenderResult || blenderJob }]">
    <header class="director-header">
      <div class="director-brand">
        <el-button :icon="ArrowLeft" circle title="返回项目" @click="goBack" />
        <div>
          <strong>3D 导演台</strong>
          <span>{{ storyboardLabel }}</span>
        </div>
      </div>
      <div class="director-header-actions">
        <span class="save-state">{{ saveState }}</span>
        <el-button :icon="QuestionFilled" circle title="打开 3D 导演台教程" aria-label="打开 3D 导演台教程" @click="tutorialVisible = true" />
        <el-button
          :icon="DocumentChecked"
          :circle="!workflowRunId"
          :loading="workflowSaving"
          :title="workflowRunId ? '保存并确认到制作流程' : '保存到本机'"
          @click="saveLocal"
        >{{ workflowRunId ? '保存并确认' : '' }}</el-button>
        <el-button :icon="FolderOpened" circle title="导入场景 JSON" @click="fileInputRef?.click()" />
        <el-button :icon="Download" circle title="导出场景 JSON" @click="exportJson" />
        <input ref="fileInputRef" type="file" accept="application/json,.json" hidden @change="importJson" />
      </div>
    </header>

    <div class="director-toolbar">
      <el-button type="primary" :icon="Grid" @click="assetPaletteVisible = true">素材库</el-button>
      <el-dropdown trigger="click" @command="addStageObject">
        <el-button>
          <el-icon><Plus /></el-icon>
          基础对象
          <el-icon class="el-icon--right"><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="character">代理角色</el-dropdown-item>
            <el-dropdown-item command="box">方盒道具</el-dropdown-item>
            <el-dropdown-item command="sphere">球形道具</el-dropdown-item>
            <el-dropdown-item command="plane">平面</el-dropdown-item>
            <el-dropdown-item command="light">聚光灯</el-dropdown-item>
            <el-dropdown-item command="camera" divided>摄像机</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>

      <div class="toolbar-divider" />
      <el-radio-group v-model="transformMode" size="small" @change="setTransformMode">
        <el-radio-button value="translate" title="移动"><el-icon><Rank /></el-icon></el-radio-button>
        <el-radio-button value="rotate" title="旋转"><el-icon><RefreshRight /></el-icon></el-radio-button>
        <el-radio-button value="scale" title="缩放"><el-icon><FullScreen /></el-icon></el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="transformSpace" size="small" @change="setTransformSpace">
        <el-radio-button value="world">世界</el-radio-button>
        <el-radio-button value="local">局部</el-radio-button>
      </el-radio-group>

      <div class="toolbar-divider" />
      <el-button :icon="RefreshLeft" circle title="撤销" :disabled="historyIndex <= 0" @click="undo" />
      <el-button :icon="RefreshRight" circle title="重做" :disabled="historyIndex >= historyLength - 1" @click="redo" />
      <el-button :icon="Aim" circle title="重置自由视角" @click="resetEditorCamera" />

      <div class="toolbar-divider" />
      <el-radio-group v-model="previewMode" size="small" @change="onPreviewModeChange">
        <el-radio-button value="free">自由视角</el-radio-button>
        <el-radio-button value="shot">镜头预览</el-radio-button>
      </el-radio-group>
      <el-button :icon="Camera" circle title="下载当前画面" @click="downloadScreenshot" />
      <el-button :icon="Crop" circle title="保存为项目参考图" :loading="uploadingFrame" @click="saveFrameToProject" />
      <el-button :icon="VideoCamera" :loading="blenderRendering" :disabled="blenderActive(blenderJob)" title="用 Blender 生成参考成果" @click="renderWithBlender">Blender 参考渲染</el-button>
      <el-button
        :icon="recording ? VideoPause : VideoCamera"
        circle
        :type="recording ? 'danger' : 'default'"
        :title="recording ? '停止录制' : '录制 WebM 预览'"
        @click="toggleRecording"
      />
    </div>

    <section v-if="blenderRendering || blenderRenderResult || blenderJob" class="blender-render-result" aria-live="polite">
      <div class="blender-render-heading">
        <div><strong>Blender 专业参考成果</strong><span>{{ blenderStatusMessage }}</span></div>
        <el-tag effect="plain">{{ blenderStatusLabel(blenderJob?.status || blenderRenderResult?.status) }}</el-tag>
      </div>
      <div v-if="blenderFrameProgress(blenderJob) !== null"><small>参考帧 {{ blenderJob.progress.completed_frames }}/{{ blenderJob.progress.total_frames }}</small><el-progress :percentage="blenderFrameProgress(blenderJob)" :show-text="false" /></div>
      <p v-else-if="blenderRendering || blenderActive(blenderJob)" class="blender-working">正在处理，请稍候…</p>
      <div v-if="blenderJob" class="blender-render-actions">
        <el-button v-if="blenderActive(blenderJob)" :disabled="blenderJob.status === 'cancelling'" size="small" type="warning" plain @click="cancelBlenderJob">停止本地渲染</el-button>
        <el-button v-if="blenderResumable(blenderJob)" :loading="blenderRendering" size="small" type="primary" @click="resumeBlenderJob">恢复缺失阶段</el-button>
        <el-button v-if="orchestrationSessionId" size="small" plain @click="router.push(`/codex-console/${orchestrationSessionId}`)">回到本次任务</el-button>
      </div>
      <div v-if="blenderRenderLinks.length" class="blender-render-links">
        <a v-for="item in blenderRenderLinks" :key="item.href" :href="item.href" target="_blank" rel="noreferrer">{{ item.label }}</a>
      </div>
      <div v-if="blenderRenderLinks.length" class="blender-previews">
        <template v-for="item in blenderRenderLinks" :key="item.href">
          <img v-if="item.type === 'image'" :src="item.href" alt="Blender 参考分镜" />
          <video v-else-if="item.type === 'video'" :src="item.href" controls preload="metadata" />
          <GlbPreview v-else-if="item.type === 'glb'" :src="item.href" />
        </template>
      </div>
      <small v-if="blenderPollError" class="blender-render-error">{{ blenderPollError }}；仍保留上次状态，将继续检查。</small>
      <small v-if="blenderJob?.error?.message || blenderRenderResult?.error_message" class="blender-render-error">{{ blenderJob?.error?.message || blenderRenderResult.error_message }}</small>
    </section>

    <main class="director-main">
      <section ref="viewportRef" class="director-viewport">
        <div v-if="previewMode === 'shot'" class="preview-indicator">
          <span class="record-dot" />
          {{ activeCameraName }}
        </div>
        <div v-if="!webglReady" class="webgl-fallback">{{ initError || '正在初始化 3D 场景…' }}</div>
      </section>

      <aside class="director-inspector">
        <div class="panel-title">
          <span>场景对象</span>
          <span>{{ stageItems.length }}</span>
        </div>
        <div class="object-list">
          <button
            v-for="item in stageItems"
            :key="item.id"
            type="button"
            :class="['object-row', { selected: item.id === selectedId }]"
            @click="selectObject(item.id)"
          >
            <span class="object-kind">{{ kindLabel(item.kind) }}</span>
            <span class="object-name">{{ item.name }}</span>
            <span v-if="item.id === activeCameraId" class="active-camera-mark">LIVE</span>
          </button>
        </div>

        <div v-if="selectedId" class="transform-panel">
          <div class="inspector-heading">
            <span>对象属性</span>
            <el-button :icon="Delete" link type="danger" title="删除对象" @click="removeSelected" />
          </div>
          <el-input v-model="selectedForm.name" size="small" maxlength="80" @input="applyInspector()" @change="applyInspector(true)" />

          <label class="field-label">位置</label>
          <div class="vector-row">
            <el-input-number v-model="selectedForm.px" :step="0.1" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.py" :step="0.1" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.pz" :step="0.1" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
          </div>
          <label class="field-label">旋转</label>
          <div class="vector-row">
            <el-input-number v-model="selectedForm.rx" :step="1" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.ry" :step="1" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.rz" :step="1" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
          </div>
          <label class="field-label">缩放</label>
          <div class="vector-row">
            <el-input-number v-model="selectedForm.sx" :step="0.1" :min="0.01" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.sy" :step="0.1" :min="0.01" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            <el-input-number v-model="selectedForm.sz" :step="0.1" :min="0.01" :disabled="Boolean(selectedForm.attachTo)" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
          </div>

          <section class="keyframe-editor" aria-label="物体随时间移动">
            <div class="keyframe-editor-heading">
              <span><strong>随时间移动</strong><small>{{ selectedKeyframes.length }} 个姿态</small></span>
              <el-switch v-model="autoRecordKeyframes" size="small" inline-prompt active-text="自动" inactive-text="手动" />
            </div>
            <template v-if="!selectedForm.attachTo">
              <div class="keyframe-steps" aria-label="关键帧操作顺序">
                <span>1 起点</span><span>2 移动时间</span><span>3 调整终点</span><span>4 播放</span>
              </div>
              <div class="keyframe-actions">
                <el-button size="small" :icon="Aim" @click="recordStartKeyframe">记录起点</el-button>
                <el-button size="small" :icon="Timer" @click="addKeyframe">记录 {{ currentTime.toFixed(2) }}s</el-button>
                <el-button size="small" :icon="VideoPlay" :disabled="selectedKeyframes.length < 2" @click="previewSelectedMotion">播放检查</el-button>
              </div>
              <div v-if="selectedKeyframes.length" class="keyframe-list">
                <div v-for="frame in selectedKeyframes" :key="`${selectedId}-${frame.time}`" class="keyframe-row">
                  <button type="button" :title="`跳到 ${Number(frame.time).toFixed(2)} 秒`" @click="jumpToKeyframe(frame)">
                    <strong>{{ Number(frame.time).toFixed(2) }}s</strong>
                    <small>{{ keyframePositionText(frame) }}</small>
                  </button>
                  <el-button :icon="Delete" link type="danger" :title="`删除 ${Number(frame.time).toFixed(2)} 秒姿态`" @click="deleteSelectedKeyframe(frame)" />
                </div>
              </div>
              <div v-else class="keyframe-empty">先摆好起始姿态并记录起点</div>
            </template>
            <div v-else class="keyframe-attached-note">此对象由父对象驱动，请选择「{{ attachmentParentName }}」记录移动。</div>
          </section>

          <template v-if="!['camera', 'light'].includes(selectedKind)">
            <label class="field-label">对象挂接</label>
            <div class="camera-row">
              <el-select v-model="selectedForm.attachTo" clearable placeholder="不挂接" @change="applyInspector(true)">
                <el-option v-for="item in attachmentParentOptions" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
              <el-select v-if="selectedForm.attachTo" v-model="selectedForm.attachAnchor" @change="applyInspector(true)">
                <el-option v-for="anchor in attachmentAnchorOptions" :key="anchor" :label="attachmentAnchorLabel(anchor)" :value="anchor" />
              </el-select>
            </div>
            <div v-if="selectedForm.attachTo" class="attachment-status" role="status">
              已挂接到「{{ attachmentParentName }}」的{{ attachmentAnchorLabel(selectedForm.attachAnchor) }}；父对象的姿态和关键帧会驱动此对象。
            </div>
            <template v-if="selectedForm.attachTo">
              <label class="field-label">局部偏移</label>
              <div class="vector-row">
                <el-input-number v-model="selectedForm.lx" :step="0.05" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.ly" :step="0.05" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.lz" :step="0.05" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
              </div>
              <label class="field-label">局部旋转（度）</label>
              <div class="vector-row">
                <el-input-number v-model="selectedForm.lrx" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.lry" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.lrz" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
              </div>
              <label class="field-label">局部缩放</label>
              <div class="vector-row">
                <el-input-number v-model="selectedForm.lsx" :min="0.01" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.lsy" :min="0.01" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.lsz" :min="0.01" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
              </div>
            </template>
          </template>

          <template v-if="selectedKind === 'character'">
            <label class="field-label">人物模型</label>
            <el-select v-model="selectedForm.assetId" filterable @change="replaceSelectedCharacter">
              <el-option v-for="asset in humanAssets" :key="asset.id" :label="asset.label" :value="asset.id" />
            </el-select>
            <label class="field-label">姿势与动作</label>
            <div class="camera-row">
              <el-select v-model="selectedForm.pose" @change="applyInspector(true)">
                <el-option v-for="pose in directorPoses" :key="pose.id" :label="pose.label" :value="pose.id" />
              </el-select>
              <el-select v-model="selectedForm.motion" @change="applyInspector(true)">
                <el-option v-for="motion in directorMotions" :key="motion.id" :label="motion.label" :value="motion.id" />
              </el-select>
            </div>
            <label class="field-label">动作速度 / 幅度</label>
            <div class="camera-row">
              <el-input-number v-model="selectedForm.motionSpeed" :min="0.1" :max="4" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
              <el-input-number v-model="selectedForm.motionIntensity" :min="0" :max="1.5" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
            </div>
          </template>

          <template v-if="selectedKind === 'camera'">
            <label class="field-label">镜头</label>
            <div class="camera-row">
              <el-input-number v-model="selectedForm.fov" :min="10" :max="120" :step="1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
              <el-select v-model="selectedForm.aspect" :disabled="workflowAspectLocked" @change="applyInspector(true)">
                <el-option label="16:9" :value="16 / 9" />
                <el-option label="9:16" :value="9 / 16" />
                <el-option label="4:3" :value="4 / 3" />
                <el-option label="1:1" :value="1" />
                <el-option label="21:9" :value="21 / 9" />
              </el-select>
            </div>
            <div v-if="workflowAspectLocked" class="aspect-lock-note">项目画幅 {{ projectAspect.label }}，镜头预览与录制保持一致</div>
            <label class="field-label">构图控制</label>
            <div class="camera-row">
              <el-select v-model="selectedForm.aimMode" @change="applyInspector(true)">
                <el-option label="跟踪主体" value="target" />
                <el-option label="按旋转角度" value="rotation" />
              </el-select>
              <el-select
                v-if="selectedForm.aimMode === 'target'"
                v-model="selectedForm.targetId"
                placeholder="选择主体"
                @change="applyInspector(true)"
              >
                <el-option v-for="item in cameraTargetOptions" :key="item.id" :label="item.name" :value="item.id" />
              </el-select>
            </div>
            <template v-if="selectedForm.aimMode === 'target'">
              <label class="field-label">焦点偏移</label>
              <div class="vector-row">
                <el-input-number v-model="selectedForm.tx" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.ty" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
                <el-input-number v-model="selectedForm.tz" :step="0.1" controls-position="right" @input="applyInspector()" @change="applyInspector(true)" />
              </div>
            </template>
            <el-button class="activate-camera" :type="selectedId === activeCameraId ? 'success' : 'primary'" plain @click="activateSelectedCamera">
              {{ selectedId === activeCameraId ? '当前镜头' : '设为当前镜头' }}
            </el-button>
          </template>
        </div>
        <div v-else class="empty-inspector">选择一个对象</div>
      </aside>
    </main>

    <footer class="director-timeline">
      <el-button :icon="playing ? VideoPause : VideoPlay" circle :title="playing ? '暂停' : '播放'" @click="togglePlayback" />
      <span class="timecode">{{ currentTime.toFixed(2) }}s</span>
      <div class="timeline-track">
        <el-slider v-model="currentTime" :min="0" :max="timelineDuration" :step="0.05" :show-tooltip="false" @input="scrubTimeline" />
        <span
          v-for="mark in visibleKeyframeMarks"
          :key="mark.key"
          class="keyframe-mark"
          :style="{ left: `${mark.percent}%` }"
        />
      </div>
      <span class="timecode">{{ timelineDuration.toFixed(1) }}s</span>
      <el-input-number v-model="timelineDuration" :min="1" :max="60" :step="1" size="small" controls-position="right" @change="changeTimelineDuration" />
      <el-button :icon="Timer" :disabled="!selectedId || Boolean(selectedForm.attachTo)" :title="selectedForm.attachTo ? '挂接对象请给父对象记录姿态' : '在当前播放头记录或覆盖姿态'" @click="addKeyframe">记录当前姿态</el-button>
    </footer>

    <el-drawer v-model="assetPaletteVisible" class="director-asset-drawer" title="导演素材库" size="min(760px, 94vw)" append-to-body>
      <div class="asset-palette-tools">
        <el-input v-model="assetSearch" :prefix-icon="Search" clearable placeholder="搜索人物、场景、家具或道具" />
        <el-segmented v-model="assetCategory" :options="assetCategoryOptions" />
      </div>
      <div v-if="filteredDirectorAssets.length" class="asset-palette-grid">
        <button
          v-for="asset in filteredDirectorAssets"
          :key="asset.id"
          type="button"
          class="asset-palette-item"
          @click="addCatalogAsset(asset)"
        >
          <img v-if="asset.preview_url" :src="asset.preview_url" :alt="asset.label" />
          <span v-else class="asset-palette-icon"><el-icon><component :is="assetCategoryIcon(asset.category)" /></el-icon></span>
          <span class="asset-palette-copy">
            <strong>{{ asset.label }}</strong>
            <small>{{ assetSourceLabel(asset) }}</small>
          </span>
          <el-icon class="asset-add-icon"><Plus /></el-icon>
        </button>
      </div>
      <el-empty v-else description="没有匹配的素材" />
    </el-drawer>

    <el-drawer v-model="tutorialVisible" class="director-tutorial-drawer" title="3D 导演台教程" size="min(440px, 94vw)" append-to-body>
      <div class="tutorial-boundary">
        <el-icon><CircleCheckFilled /></el-icon>
        <div><strong>这是可选的构图工具</strong><p>不需要运动参考时可以直接跳过。关闭项目 3D 或把镜头设为“跳过”后，最终参考包不会携带旧预演视频。</p></div>
      </div>
      <ol class="tutorial-steps">
        <li><span>1</span><div><strong>添加角色与场景对象</strong><p>从素材库选择常用人物、场景、家具和道具；缺少模型时也可以先用基础几何体占位。</p><el-button size="small" :icon="Grid" @click="tutorialVisible = false; assetPaletteVisible = true">打开素材库</el-button></div></li>
        <li><span>2</span><div><strong>摆放对象和摄像机</strong><p>先选对象，再使用移动、旋转、缩放。切换“世界/局部”坐标，避免复杂姿态下移动方向混乱。</p></div></li>
        <li><span>3</span><div><strong>检查镜头构图</strong><p>添加或选择摄像机，切到“镜头预览”。检查主体是否出框、视线方向、遮挡和背景锚点。</p></div></li>
        <li><span>4</span><div><strong>让对象随时间移动</strong><p>选中对象并“记录起点”，把时间轴移到目标时刻，再拖动物体到终点；自动记录开启时会保存终点。点击“播放检查”即可预览，重录同一时刻会覆盖旧姿态。</p></div></li>
        <li><span>5</span><div><strong>录制并返回审批</strong><p>点击摄像机旁的录制按钮生成 WebM。效果不好可以打回并修改 JSON；满意后保存确认，或回到工作流明确跳过。</p></div></li>
      </ol>
      <div class="tutorial-when">
        <div><strong>建议使用</strong><span>多人走位、复杂空间关系、运镜、长镜头、道具交互。</span></div>
        <div><strong>建议跳过</strong><span>表情特写、静态场景、2–4 秒短镜头、模型不接收参考视频。</span></div>
      </div>
      <el-button class="tutorial-guide-link" type="primary" plain @click="router.push('/help#director')">阅读完整 3D 说明</el-button>
    </el-drawer>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import {
  Aim,
  ArrowDown,
  ArrowLeft,
  Camera,
  Crop,
  Delete,
  DocumentChecked,
  Download,
  FolderOpened,
  FullScreen,
  Grid,
  House,
  OfficeBuilding,
  Plus,
  QuestionFilled,
  Rank,
  RefreshLeft,
  RefreshRight,
  Search,
  Timer,
  UserFilled,
  VideoCamera,
  VideoPause,
  VideoPlay,
  CircleCheckFilled,
} from '@element-plus/icons-vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { TransformControls } from 'three/addons/controls/TransformControls.js'
import { uploadAPI } from '@/api/upload'
import { storyboardsAPI } from '@/api/storyboards'
import { productionAPI } from '@/api/production'
import orchestrationAPI from '@/api/orchestration'
import GlbPreview from '@/components/orchestration/GlbPreview.vue'
import { blenderActive, blenderResumable, blenderStatusLabel, blenderFrameProgress, blenderLinks } from '@/utils/blenderExperience'
import {
  cloneDirectorJson,
  createDefaultDirectorDocument,
  DIRECTOR_ATTACHMENT_ANCHORS,
  directorKeyframesForObject,
  interpolateObjectKeyframes,
  normalizeDirectorDocument,
  removeDirectorKeyframe,
  selectWorkflowDirectorArtifact,
  upsertDirectorKeyframe,
} from '@/utils/directorScene'
import { productionAspectSpec } from '@/utils/aspectRatio'
import { applyDirectorCameraAim } from '@/utils/directorThree'
import {
  createDirectorObject,
  disposeDirectorObject,
  applyDirectorAttachments,
  setDirectorHelperVisibility,
  updateDirectorObjectAtTime,
  waitForDirectorObjects,
} from '@/utils/directorRuntime'

const route = useRoute()
const router = useRouter()
const dramaId = computed(() => Number(route.params.id) || null)
const storyboardId = computed(() => Number(route.query.storyboard) || null)
const workflowRunId = computed(() => String(route.query.workflow_run || '').trim())
const workflowShotId = computed(() => String(route.query.shot || '').trim())
const orchestrationSessionId = computed(() => String(route.query.session || '').trim())
const orchestrationNodeKey = computed(() => String(route.query.node || '').trim())
const storyboardRecord = ref(null)
const workflowArtifact = ref(null)
const viewportRef = ref(null)
const fileInputRef = ref(null)
const webglReady = ref(false)
const initError = ref('')
const stageItems = ref([])
const selectedId = ref(null)
const selectedKind = ref('')
const activeCameraId = ref(null)
const previewMode = ref('free')
const transformMode = ref('translate')
const transformSpace = ref('world')
const saveState = ref('未保存')
const uploadingFrame = ref(false)
const recording = ref(false)
const workflowSaving = ref(false)
const blenderRendering = ref(false)
const blenderRenderResult = ref(null)
const blenderJob = ref(null)
const blenderPollError = ref('')
let blenderPollPending = false
const blenderStatusMessage = computed(() => blenderJob.value?.progress?.message || (blenderRendering.value ? '正在渲染当前场景，完成后会保留可编辑工程和参考视频' : blenderRenderResult.value?.status === 'succeeded' ? '渲染完成，可继续修改场景或下载成果' : blenderRenderResult.value?.blocked_reason ? `暂时无法运行：${blenderRenderResult.value.blocked_reason}` : '渲染未完成，已保留可恢复的中间结果'))
let blenderPollTimer = null
const playing = ref(false)
const currentTime = ref(0)
const timelineDuration = ref(5)
const keyframes = ref([])
const historyIndex = ref(-1)
const historyLength = ref(0)
const directorAssets = ref([])
const directorPoses = ref([])
const directorMotions = ref([])
const assetPaletteVisible = ref(false)
const assetSearch = ref('')
const assetCategory = ref('all')
const tutorialVisible = ref(false)
const autoRecordKeyframes = ref(true)
const workflowAspectRatio = ref('16:9')

const blenderRenderLinks = computed(() => blenderLinks(blenderJob.value || blenderRenderResult.value))

const selectedForm = reactive({
  name: '', px: 0, py: 0, pz: 0,
  rx: 0, ry: 0, rz: 0,
  sx: 1, sy: 1, sz: 1,
  fov: 42, aspect: 16 / 9,
  aimMode: 'target', targetId: '',
  tx: 0, ty: 1.1, tz: 0,
  assetId: 'human.adult.male', pose: 'neutral', motion: 'idle',
  motionSpeed: 1, motionIntensity: 1,
  attachTo: '', attachAnchor: 'root',
  lx: 0, ly: 0, lz: 0,
  lrx: 0, lry: 0, lrz: 0,
  lsx: 1, lsy: 1, lsz: 1,
})

let renderer
let scene
let editorCamera
let orbit
let transform
let transformHelper
let resizeObserver
let animationFrame
let mediaRecorder
let recordChunks = []
let playStartedAt = 0
let isRestoring = false
const objectById = new Map()
const cameraHelpers = new Map()
const history = []
const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

const storageKey = computed(() => workflowRunId.value
  ? `local-mini-drama:director:workflow:${workflowRunId.value}:${workflowShotId.value}`
  : `local-mini-drama:director:${dramaId.value || 'standalone'}:${storyboardId.value || 'project'}`)
const storyboardLabel = computed(() => {
  if (workflowArtifact.value) {
    return `制作流程 · 镜头 #${workflowArtifact.value.scope_id} · 修订 ${workflowArtifact.value.revision}`
  }
  if (storyboardRecord.value) {
    return `项目 ${dramaId.value} · 分镜 #${storyboardRecord.value.storyboard_number || storyboardId.value}`
  }
  return dramaId.value ? `项目 ${dramaId.value}` : '独立场景'
})
const activeCameraName = computed(() => stageItems.value.find((item) => item.id === activeCameraId.value)?.name || '未设置镜头')
const visibleKeyframeMarks = computed(() => keyframes.value.map((keyframe, index) => ({
  key: `${keyframe.object_id}-${keyframe.time}-${index}`,
  percent: Math.min(100, Math.max(0, (keyframe.time / timelineDuration.value) * 100)),
})))
const projectAspect = computed(() => productionAspectSpec(workflowAspectRatio.value))
const workflowAspectLocked = computed(() => Boolean(workflowRunId.value))
const selectedKeyframes = computed(() => directorKeyframesForObject(keyframes.value, selectedId.value))
const cameraTargetOptions = computed(() => stageItems.value.filter((item) => !['camera', 'light'].includes(item.kind)))
const attachmentParentOptions = computed(() => stageItems.value.filter((item) => (
  item.id !== selectedId.value
  && !['camera', 'light'].includes(item.kind)
  && !wouldCreateAttachmentCycle(item.id, selectedId.value)
)))
const attachmentAnchorOptions = computed(() => {
  const parent = stageItems.value.find((item) => item.id === selectedForm.attachTo)
  return parent?.kind === 'character' ? DIRECTOR_ATTACHMENT_ANCHORS : ['root']
})
const attachmentParentName = computed(() => (
  stageItems.value.find((item) => item.id === selectedForm.attachTo)?.name || selectedForm.attachTo
))
const humanAssets = computed(() => directorAssets.value.filter((asset) => asset.category === 'people'))
const assetCategoryOptions = computed(() => [
  { label: '全部', value: 'all' },
  { label: '人物', value: 'people' },
  { label: '场景', value: 'environments' },
  { label: '家具', value: 'furniture' },
  { label: '道具', value: 'props' },
])
const filteredDirectorAssets = computed(() => {
  const query = assetSearch.value.trim().toLowerCase()
  return directorAssets.value.filter((asset) => (
    (assetCategory.value === 'all' || asset.category === assetCategory.value)
    && (!query || `${asset.label} ${asset.id}`.toLowerCase().includes(query))
  ))
})

function uid(kind) {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function kindLabel(kind) {
  return { character: '角色', asset: '素材', procedural: '拼装', box: '方盒', sphere: '球体', plane: '平面', light: '灯光', camera: '镜头' }[kind] || kind
}

function attachmentAnchorLabel(anchor) {
  return {
    root: '根节点', head: '头部', left_hand: '左手', right_hand: '右手',
    left_forearm: '左前臂', right_forearm: '右前臂',
  }[anchor] || anchor
}

function wouldCreateAttachmentCycle(parentId, childId) {
  if (!parentId || !childId) return false
  const visited = new Set()
  let cursor = parentId
  while (cursor && !visited.has(cursor)) {
    if (cursor === childId) return true
    visited.add(cursor)
    cursor = String(objectById.get(cursor)?.userData?.props?.attach_to || '')
  }
  return false
}

function assetCategoryIcon(category) {
  if (category === 'people') return UserFilled
  if (category === 'environments') return House
  if (category === 'furniture') return OfficeBuilding
  return Grid
}

function assetSourceLabel(asset) {
  if (asset.category === 'people') return `${asset.default_props?.age === 'child' ? '儿童' : asset.default_props?.age === 'senior' ? '老年' : '成人'} · ${asset.license}`
  return '本地程序化素材'
}

function createStageObject(record) {
  const object = createDirectorObject(record)
  scene.add(object)
  objectById.set(record.id, object)

  if (record.kind === 'camera') {
    object.updateProjectionMatrix()
    const helper = new THREE.CameraHelper(object)
    helper.userData.directorHelper = true
    helper.material?.color?.set('#54b9ff')
    scene.add(helper)
    cameraHelpers.set(record.id, helper)
  }
  object.userData.directorReady.catch((error) => {
    saveState.value = '素材加载失败'
    ElMessage.error(error.message || '3D 素材加载失败')
  })
  return object
}

function defaultRecord(kind) {
  const count = stageItems.value.filter((item) => item.kind === kind).length + 1
  const record = {
    id: uid(kind), kind, name: `${kindLabel(kind)} ${count}`,
    position: [0, kind === 'box' ? 0.5 : kind === 'sphere' ? 0.65 : kind === 'plane' ? 0.01 : kind === 'light' ? 4 : 0, 0],
    rotation: kind === 'plane' ? [-Math.PI / 2, 0, 0] : [0, 0, 0], scale: [1, 1, 1], props: {},
  }
  if (kind === 'character') {
    const fallbackAsset = humanAssets.value.find((asset) => asset.id === 'human.adult.male')
    record.position = [0, 0, 0]
    record.props = fallbackAsset ? cloneDirectorJson(fallbackAsset.default_props) : {
      asset_id: 'human.procedural', profile_id: 'human.adult.male',
      focus_height: 1.1, pose: 'neutral', motion: 'idle', motion_speed: 1, motion_intensity: 1,
    }
  }
  if (kind === 'camera') {
    const target = stageItems.value.find((item) => item.kind === 'character')
      || stageItems.value.find((item) => !['camera', 'light', 'plane'].includes(item.kind))
    record.position = editorCamera ? editorCamera.position.toArray() : [6, 4, 8]
    record.rotation = editorCamera ? editorCamera.rotation.toArray().slice(0, 3) : [-0.3, 0.65, 0]
    record.props = target
      ? { fov: 42, aspect: projectAspect.value.ratio, aim_mode: 'target', target_id: target.id, target_offset: [0, target.kind === 'character' ? 1.1 : 0, 0] }
      : { fov: 42, aspect: projectAspect.value.ratio, aim_mode: 'rotation' }
  }
  if (kind === 'light') record.props = { intensity: 2 }
  return record
}

function addStageObject(kind) {
  const object = createStageObject(defaultRecord(kind))
  syncStageItems()
  selectObject(object.userData.id)
  if (kind === 'camera' && !activeCameraId.value) activeCameraId.value = object.userData.id
  commitHistory()
}

function addCatalogAsset(asset) {
  const count = stageItems.value.filter((item) => item.asset_id === asset.id).length + 1
  const record = {
    id: uid(asset.kind),
    kind: asset.kind,
    name: count > 1 ? `${asset.label} ${count}` : asset.label,
    position: [...(asset.default_position || [0, 0, 0])],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    props: cloneDirectorJson(asset.default_props),
  }
  const object = createStageObject(record)
  syncStageItems()
  selectObject(record.id)
  assetPaletteVisible.value = false
  commitHistory()
  object.userData.directorReady.then(() => {
    updateDirectorObjectAtTime(object, currentTime.value)
    renderScene()
  }).catch(() => {})
}

function replaceSelectedCharacter(assetId) {
  const current = objectById.get(selectedId.value)
  const asset = humanAssets.value.find((item) => item.id === assetId)
  if (!current || !asset || current.userData.kind !== 'character') return
  const previous = objectRecord(current)
  const record = {
    ...previous,
    kind: 'character',
    props: {
      ...cloneDirectorJson(asset.default_props),
      pose: selectedForm.pose,
      motion: selectedForm.motion,
      motion_speed: selectedForm.motionSpeed,
      motion_intensity: selectedForm.motionIntensity,
    },
  }
  if (transform?.object === current) transform.detach()
  scene.remove(current)
  disposeDirectorObject(current)
  objectById.delete(record.id)
  const replacement = createStageObject(record)
  syncStageItems()
  selectObject(record.id)
  commitHistory()
  replacement.userData.directorReady.then(() => {
    updateDirectorObjectAtTime(replacement, currentTime.value)
    renderScene()
  }).catch(() => {})
}

function disposeObject(object) {
  disposeDirectorObject(object)
}

function removeStageObject(id) {
  const object = objectById.get(id)
  if (!object) return
  const dependents = [...objectById.values()].filter((entry) => entry.userData.props?.attach_to === id)
  for (const dependent of dependents) {
    const props = { ...(dependent.userData.props || {}) }
    delete props.attach_to
    delete props.attach_anchor
    delete props.local_offset
    delete props.local_rotation
    delete props.local_scale
    dependent.userData.props = props
    dependent.userData.directorRecordTransform = {
      position: dependent.position.toArray(),
      rotation: [dependent.rotation.x, dependent.rotation.y, dependent.rotation.z],
      scale: dependent.scale.toArray(),
    }
    keyframes.value = keyframes.value.filter((frame) => frame.object_id !== dependent.userData.id)
  }
  if (dependents.length) ElMessage.warning(`已解除 ${dependents.length} 个下游对象的挂接，避免留下失效锚点`)
  if (transform?.object === object) transform.detach()
  const helper = cameraHelpers.get(id)
  if (helper) {
    scene.remove(helper)
    helper.dispose?.()
    cameraHelpers.delete(id)
  }
  scene.remove(object)
  disposeObject(object)
  objectById.delete(id)
  keyframes.value = keyframes.value.filter((keyframe) => keyframe.object_id !== id)
  if (activeCameraId.value === id) {
    activeCameraId.value = stageItems.value.find((item) => item.kind === 'camera' && item.id !== id)?.id || null
    if (!activeCameraId.value) previewMode.value = 'free'
  }
  if (selectedId.value === id) {
    selectedId.value = null
    selectedKind.value = ''
  }
  syncStageItems()
}

function removeSelected() {
  if (!selectedId.value) return
  removeStageObject(selectedId.value)
  commitHistory()
}

function objectRecord(object) {
  const props = { ...(object.userData.props || {}) }
  if (object.userData.kind === 'camera') {
    props.fov = object.fov
    props.aspect = object.aspect
  }
  if (object.userData.kind === 'light') props.intensity = object.userData.light?.intensity || 60
  const attached = Boolean(props.attach_to)
  if (!attached) {
    object.userData.directorRecordTransform = {
      position: object.position.toArray(),
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: object.scale.toArray(),
    }
  }
  const stored = object.userData.directorRecordTransform || {
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  }
  return {
    id: object.userData.id,
    kind: object.userData.kind,
    name: object.name,
    position: attached ? [...stored.position] : object.position.toArray(),
    rotation: attached ? [...stored.rotation] : [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: attached ? [...stored.scale] : object.scale.toArray(),
    props,
  }
}

function serializeDocument() {
  return normalizeDirectorDocument({
    aspect_ratio: projectAspect.value.value,
    active_camera_id: activeCameraId.value,
    objects: [...objectById.values()].map(objectRecord),
    timeline: { duration: timelineDuration.value, keyframes: keyframes.value },
  }, projectAspect.value.value)
}

function clearStageObjects() {
  for (const id of [...objectById.keys()]) removeStageObject(id)
  objectById.clear()
  cameraHelpers.clear()
}

async function restoreDocument(value, options = {}) {
  const document = normalizeDirectorDocument(value, projectAspect.value.value)
  isRestoring = true
  try {
    clearStageObjects()
    for (const record of document.objects) createStageObject(record)
    activeCameraId.value = document.active_camera_id
    timelineDuration.value = document.timeline.duration
    keyframes.value = document.timeline.keyframes
    currentTime.value = Math.min(currentTime.value, timelineDuration.value)
    syncStageItems()
    if (document.objects.length) selectObject(document.objects[0].id)
    else selectObject(null)
    await waitForDirectorObjects([...objectById.values()])
    applyTimeline(currentTime.value)
  } finally {
    isRestoring = false
  }
  if (options.commit) commitHistory()
}

function syncStageItems() {
  stageItems.value = [...objectById.values()].map((object) => ({
    id: object.userData.id,
    kind: object.userData.kind,
    name: object.name,
    asset_id: object.userData.props?.asset_id || null,
  }))
}

function syncSelectedForm() {
  const object = objectById.get(selectedId.value)
  if (!object) return
  selectedForm.name = object.name
  selectedForm.px = Number(object.position.x.toFixed(3))
  selectedForm.py = Number(object.position.y.toFixed(3))
  selectedForm.pz = Number(object.position.z.toFixed(3))
  selectedForm.rx = Number(THREE.MathUtils.radToDeg(object.rotation.x).toFixed(2))
  selectedForm.ry = Number(THREE.MathUtils.radToDeg(object.rotation.y).toFixed(2))
  selectedForm.rz = Number(THREE.MathUtils.radToDeg(object.rotation.z).toFixed(2))
  selectedForm.sx = Number(object.scale.x.toFixed(3))
  selectedForm.sy = Number(object.scale.y.toFixed(3))
  selectedForm.sz = Number(object.scale.z.toFixed(3))
  const attachmentProps = object.userData.props || {}
  selectedForm.attachTo = String(attachmentProps.attach_to || '')
  selectedForm.attachAnchor = String(attachmentProps.attach_anchor || 'root')
  const localOffset = Array.isArray(attachmentProps.local_offset) ? attachmentProps.local_offset : [0, 0, 0]
  const localRotation = Array.isArray(attachmentProps.local_rotation) ? attachmentProps.local_rotation : [0, 0, 0]
  const localScale = Array.isArray(attachmentProps.local_scale) ? attachmentProps.local_scale : [1, 1, 1]
  selectedForm.lx = Number(Number(localOffset[0] || 0).toFixed(3))
  selectedForm.ly = Number(Number(localOffset[1] || 0).toFixed(3))
  selectedForm.lz = Number(Number(localOffset[2] || 0).toFixed(3))
  selectedForm.lrx = Number(THREE.MathUtils.radToDeg(Number(localRotation[0] || 0)).toFixed(2))
  selectedForm.lry = Number(THREE.MathUtils.radToDeg(Number(localRotation[1] || 0)).toFixed(2))
  selectedForm.lrz = Number(THREE.MathUtils.radToDeg(Number(localRotation[2] || 0)).toFixed(2))
  selectedForm.lsx = Number(Number(localScale[0] || 1).toFixed(3))
  selectedForm.lsy = Number(Number(localScale[1] || 1).toFixed(3))
  selectedForm.lsz = Number(Number(localScale[2] || 1).toFixed(3))
  if (object.userData.kind === 'character') {
    const props = object.userData.props || {}
    selectedForm.assetId = String(props.asset_id && props.asset_id !== 'human.procedural' ? props.asset_id : (props.profile_id || 'human.adult.male'))
    selectedForm.pose = String(props.pose || 'neutral')
    selectedForm.motion = String(props.motion || 'idle')
    selectedForm.motionSpeed = Number(Number(props.motion_speed ?? 1).toFixed(2))
    selectedForm.motionIntensity = Number(Number(props.motion_intensity ?? 1).toFixed(2))
  }
  if (object.userData.kind === 'camera') {
    selectedForm.fov = object.fov
    selectedForm.aspect = workflowAspectLocked.value ? projectAspect.value.ratio : object.aspect
    const props = object.userData.props || {}
    selectedForm.aimMode = props.aim_mode === 'rotation' ? 'rotation' : 'target'
    selectedForm.targetId = String(props.target_id || '')
    const targetOffset = Array.isArray(props.target_offset) ? props.target_offset : [0, 1.1, 0]
    selectedForm.tx = Number(Number(targetOffset[0] || 0).toFixed(3))
    selectedForm.ty = Number(Number(targetOffset[1] || 0).toFixed(3))
    selectedForm.tz = Number(Number(targetOffset[2] || 0).toFixed(3))
  }
}

function selectObject(id) {
  const object = id ? objectById.get(id) : null
  selectedId.value = object?.userData.id || null
  selectedKind.value = object?.userData.kind || ''
  if (object && previewMode.value === 'free' && !object.userData.props?.attach_to) transform.attach(object)
  else transform?.detach()
  syncSelectedForm()
}

function applyInspector(shouldCommit = false) {
  const object = objectById.get(selectedId.value)
  if (!object) return
  object.name = String(selectedForm.name || object.name).slice(0, 80)
  const nextAttachTo = String(selectedForm.attachTo || '')
  if (nextAttachTo && wouldCreateAttachmentCycle(nextAttachTo, selectedId.value)) {
    ElMessage.warning('不能把对象挂接到自己的下游对象')
    syncSelectedForm()
    return
  }
  const props = { ...(object.userData.props || {}) }
  if (nextAttachTo) {
    props.attach_to = nextAttachTo
    props.attach_anchor = String(selectedForm.attachAnchor || 'root')
    props.local_offset = [Number(selectedForm.lx) || 0, Number(selectedForm.ly) || 0, Number(selectedForm.lz) || 0]
    props.local_rotation = [
      THREE.MathUtils.degToRad(Number(selectedForm.lrx) || 0),
      THREE.MathUtils.degToRad(Number(selectedForm.lry) || 0),
      THREE.MathUtils.degToRad(Number(selectedForm.lrz) || 0),
    ]
    props.local_scale = [
      Math.max(0.01, Number(selectedForm.lsx) || 1),
      Math.max(0.01, Number(selectedForm.lsy) || 1),
      Math.max(0.01, Number(selectedForm.lsz) || 1),
    ]
    object.userData.props = props
  } else {
    delete props.attach_to
    delete props.attach_anchor
    delete props.local_offset
    delete props.local_rotation
    delete props.local_scale
    object.userData.props = props
    object.position.set(Number(selectedForm.px) || 0, Number(selectedForm.py) || 0, Number(selectedForm.pz) || 0)
    object.rotation.set(
      THREE.MathUtils.degToRad(Number(selectedForm.rx) || 0),
      THREE.MathUtils.degToRad(Number(selectedForm.ry) || 0),
      THREE.MathUtils.degToRad(Number(selectedForm.rz) || 0)
    )
    object.scale.set(
      Math.max(0.01, Number(selectedForm.sx) || 1),
      Math.max(0.01, Number(selectedForm.sy) || 1),
      Math.max(0.01, Number(selectedForm.sz) || 1)
    )
    object.userData.directorRecordTransform = {
      position: object.position.toArray(),
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: object.scale.toArray(),
    }
  }
  if (object.userData.kind === 'camera') {
    object.fov = Math.min(120, Math.max(10, Number(selectedForm.fov) || 42))
    object.aspect = workflowAspectLocked.value
      ? projectAspect.value.ratio
      : Math.max(0.2, Number(selectedForm.aspect) || 16 / 9)
    selectedForm.aspect = object.aspect
    const cameraProps = { ...(object.userData.props || {}) }
    cameraProps.fov = object.fov
    cameraProps.aspect = object.aspect
    cameraProps.aim_mode = selectedForm.aimMode === 'rotation' ? 'rotation' : 'target'
    if (cameraProps.aim_mode === 'target') {
      cameraProps.target_id = String(selectedForm.targetId || '')
      cameraProps.target_offset = [
        Number(selectedForm.tx) || 0,
        Number(selectedForm.ty) || 0,
        Number(selectedForm.tz) || 0,
      ]
    } else {
      delete cameraProps.target_id
      delete cameraProps.target_offset
    }
    object.userData.props = cameraProps
    object.updateProjectionMatrix()
  }
  if (object.userData.kind === 'character') {
    object.userData.props = {
      ...(object.userData.props || {}),
      pose: selectedForm.pose,
      motion: selectedForm.motion,
      motion_speed: Math.min(4, Math.max(0.1, Number(selectedForm.motionSpeed) || 1)),
      motion_intensity: Math.min(1.5, Math.max(0, Number(selectedForm.motionIntensity) || 0)),
    }
    updateDirectorObjectAtTime(object, currentTime.value)
  }
  if (nextAttachTo) {
    keyframes.value = keyframes.value.filter((frame) => (
      frame.object_id !== selectedId.value || Object.prototype.hasOwnProperty.call(frame, 'local_offset')
    ))
    transform?.detach()
    try {
      applyDirectorAttachments(serializeDocument(), objectById, currentTime.value)
    } catch (error) {
      ElMessage.error(error.message)
    }
  } else if (previewMode.value === 'free' && transform && transform.object !== object) {
    transform.attach(object)
  }
  syncStageItems()
  cameraHelpers.get(selectedId.value)?.update()
  if (shouldCommit) {
    if (autoRecordKeyframes.value && currentTime.value > 0 && !nextAttachTo) {
      recordSelectedKeyframe(currentTime.value, { commit: false })
    }
    commitHistory()
  }
}

function activateSelectedCamera() {
  if (selectedKind.value !== 'camera') return
  activeCameraId.value = selectedId.value
  commitHistory()
}

function setTransformMode(value) {
  transform?.setMode(value)
}

function setTransformSpace(value) {
  transform?.setSpace(value)
}

function onPreviewModeChange(value) {
  if (value === 'shot' && !objectById.get(activeCameraId.value)) {
    previewMode.value = 'free'
    ElMessage.warning('请先添加并启用摄像机')
  }
  orbit.enabled = previewMode.value === 'free'
  if (previewMode.value === 'free' && selectedId.value) transform.attach(objectById.get(selectedId.value))
  else transform.detach()
}

function resetEditorCamera() {
  editorCamera.position.set(7.5, 5.5, 9)
  orbit.target.set(0, 1.1, 0)
  orbit.update()
}

function commitHistory() {
  if (isRestoring) return
  const snapshot = JSON.stringify(serializeDocument())
  if (history[historyIndex.value] === snapshot) return
  history.splice(historyIndex.value + 1)
  history.push(snapshot)
  if (history.length > 60) history.shift()
  historyIndex.value = history.length - 1
  historyLength.value = history.length
  saveState.value = '有未保存更改'
}

async function undo() {
  if (historyIndex.value <= 0) return
  historyIndex.value -= 1
  await restoreDocument(JSON.parse(history[historyIndex.value]))
  historyLength.value = history.length
  saveState.value = '有未保存更改'
}

async function redo() {
  if (historyIndex.value >= history.length - 1) return
  historyIndex.value += 1
  await restoreDocument(JSON.parse(history[historyIndex.value]))
  historyLength.value = history.length
  saveState.value = '有未保存更改'
}

async function persistStoryboardWorkflow(patch = {}) {
  if (!storyboardId.value) return null
  const updated = await storyboardsAPI.update(storyboardId.value, patch)
  storyboardRecord.value = updated
  return updated
}

async function saveLocal() {
  applyInspector()
  const document = serializeDocument()
  localStorage.setItem(storageKey.value, JSON.stringify(document))
  workflowSaving.value = true
  try {
    if (workflowArtifact.value) {
      const revised = await productionAPI.updateArtifact(workflowArtifact.value.id, {
        content: { ...workflowArtifact.value.content, document, manually_adjusted: true },
      })
      const approved = await productionAPI.reviewArtifact(revised.id, {
        decision: 'approved',
        reason: '用户在 3D 导演台完成精调并确认',
      })
      workflowArtifact.value = approved.artifact
      saveState.value = '已保存并确认到制作流程'
      ElMessage.success('导演台方案已写回；返回后会重新录制本镜头预演')
    } else if (storyboardId.value) {
      await persistStoryboardWorkflow({ director_scene_json: document })
      saveState.value = '已保存到分镜'
    } else {
      saveState.value = '已保存到本机'
    }
  } catch (error) {
    saveState.value = '保存失败'
    ElMessage.error(error.message || '导演台方案保存失败')
  } finally {
    workflowSaving.value = false
  }
}

async function renderWithBlender() {
  if (blenderRendering.value || blenderActive(blenderJob.value)) return
  applyInspector()
  blenderRendering.value = true
  try {
    const document = serializeDocument()
    const source = JSON.stringify([orchestrationSessionId.value, orchestrationNodeKey.value, workflowRunId.value, workflowShotId.value, document])
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
    const requestKey = 'director:' + Array.from(new Uint8Array(digest)).map((v) => v.toString(16).padStart(2, '0')).join('')
    if (orchestrationSessionId.value && orchestrationNodeKey.value) {
      const result = await orchestrationAPI.blenderRender(orchestrationSessionId.value, orchestrationNodeKey.value, {
        request_key: requestKey,
        scene: document,
        max_preview_frames: 24,
        width: 640,
        height: 360,
      })
      blenderJob.value = result?.job || result
      blenderRenderResult.value = null
      startBlenderPolling()
      if (['succeeded', 'partial'].includes(blenderJob.value?.status)) ElMessage.success('Blender 编排成果已更新')
      else if (blenderJob.value?.status === 'blocked') ElMessage.warning('当前设备没有可用 Blender，已保留 Three.js 预演')
      else ElMessage.info('Blender 作业已排队，进度会在本页和编排台同步更新')
    } else {
      const result = await productionAPI.renderBlenderScene({ request_key: requestKey, scene: serializeDocument(), max_preview_frames: 24, width: 640, height: 360 })
      blenderRenderResult.value = result
      if (result?.status === 'succeeded') ElMessage.success('Blender 参考成果已生成')
      else if (result?.status === 'blocked') ElMessage.warning('当前设备没有可用 Blender，已保留 Three.js 预演')
      else ElMessage.warning('Blender 渲染未完成，但已保留可恢复结果')
    }
  } catch (error) {
    ElMessage.error(error.message || 'Blender 渲染失败')
  } finally {
    blenderRendering.value = false
  }
}

function stopBlenderPolling() {
  if (blenderPollTimer) window.clearInterval(blenderPollTimer)
  blenderPollTimer = null
}

function startBlenderPolling() {
  stopBlenderPolling()
  if (!orchestrationSessionId.value || !blenderJob.value?.id || !blenderActive(blenderJob.value)) return
  blenderPollTimer = window.setInterval(async () => {
    if (blenderPollPending) return
    blenderPollPending = true
    try {
      const latest = await orchestrationAPI.blenderJob(orchestrationSessionId.value, blenderJob.value.id)
      blenderJob.value = latest
      blenderPollError.value = ''
      if (!blenderActive(latest)) stopBlenderPolling()
    } catch (error) { blenderPollError.value = error.message || '暂时无法刷新进度' }
    finally { blenderPollPending = false }
  }, 1800)
}

async function cancelBlenderJob() {
  if (!orchestrationSessionId.value || !blenderJob.value?.id) return
  try {
    const result = await orchestrationAPI.blenderCancel(orchestrationSessionId.value, blenderJob.value.id, { actor: 'user', note: '用户在导演台停止本地参考渲染' })
    blenderJob.value = result?.job || result
    startBlenderPolling()
    ElMessage.info(blenderJob.value.status === 'cancelling' ? '已请求停止，正在等待本地进程退出' : '本地作业已停止')
  } catch (error) { ElMessage.error(error.message || '停止 Blender 作业失败') }
}

async function resumeBlenderJob() {
  if (!orchestrationSessionId.value || !blenderJob.value?.id) return
  blenderRendering.value = true
  try {
    const result = await orchestrationAPI.blenderResume(orchestrationSessionId.value, blenderJob.value.id, { actor: 'user' })
    blenderJob.value = result?.job || result
    startBlenderPolling()
    ElMessage.info('已恢复 Blender 作业；系统只补缺失阶段')
  } catch (error) { ElMessage.error(error.message || '恢复 Blender 作业失败') }
  finally { blenderRendering.value = false }
}

function exportJson() {
  applyInspector()
  const blob = new Blob([JSON.stringify(serializeDocument(), null, 2)], { type: 'application/json' })
  downloadBlob(blob, `director-scene-${dramaId.value || 'standalone'}.json`)
  saveState.value = '已导出'
}

async function importJson(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  try {
    const document = normalizeDirectorDocument(JSON.parse(await file.text()), projectAspect.value.value)
    await restoreDocument(document, { commit: true })
    saveLocal()
    ElMessage.success('场景已导入')
  } catch (error) {
    ElMessage.error('场景 JSON 无效：' + error.message)
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function canvasBlob() {
  await waitForDirectorObjects([...objectById.values()])
  renderScene()
  return new Promise((resolve, reject) => {
    renderer.domElement.toBlob((blob) => blob ? resolve(blob) : reject(new Error('截图失败')), 'image/png')
  })
}

async function downloadScreenshot() {
  try {
    downloadBlob(await canvasBlob(), `director-frame-${Date.now()}.png`)
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function saveFrameToProject() {
  uploadingFrame.value = true
  try {
    const blob = await canvasBlob()
    const file = new File([blob], `director-frame-${Date.now()}.png`, { type: 'image/png' })
    const result = await uploadAPI.uploadImage(file, { dramaId: dramaId.value })
    const localPath = result.local_path || result.path
    if (storyboardId.value && localPath) {
      const refs = storyboardRecord.value?.workflow_references || { images: [], videos: [], audios: [] }
      await persistStoryboardWorkflow({
        director_scene_json: serializeDocument(),
        director_frame_path: localPath,
        workflow_references: {
          ...refs,
          images: [...(refs.images || []).filter((item) => item.path !== localPath), {
            path: localPath,
            label: '3D 导演台确认帧',
            source: 'director',
          }].slice(-4),
        },
      })
    }
    ElMessage.success(`参考图已保存：${localPath}`)
  } catch (error) {
    ElMessage.error('保存参考图失败：' + error.message)
  } finally {
    uploadingFrame.value = false
  }
}

async function toggleRecording() {
  if (recording.value) {
    mediaRecorder?.stop()
    return
  }
  try {
    await waitForDirectorObjects([...objectById.values()])
  } catch (error) {
    ElMessage.error(error.message || '3D 素材尚未准备完成')
    return
  }
  if (!renderer?.domElement.captureStream || typeof MediaRecorder === 'undefined') {
    ElMessage.error('当前浏览器不支持画布录制')
    return
  }
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type)) || ''
  recordChunks = []
  mediaRecorder = new MediaRecorder(renderer.domElement.captureStream(30), mimeType ? { mimeType } : undefined)
  mediaRecorder.ondataavailable = (event) => { if (event.data.size) recordChunks.push(event.data) }
  mediaRecorder.onstop = async () => {
    recording.value = false
    playing.value = false
    if (recordChunks.length) {
      const blob = new Blob(recordChunks, { type: mimeType || 'video/webm' })
      const filename = `director-preview-${Date.now()}.webm`
      downloadBlob(blob, filename)
      if (storyboardId.value) {
        try {
          const uploaded = await uploadAPI.uploadReferenceMedia(new File([blob], filename, { type: blob.type || 'video/webm' }))
          const localPath = uploaded.local_path || uploaded.path
          const refs = storyboardRecord.value?.workflow_references || { images: [], videos: [], audios: [] }
          await persistStoryboardWorkflow({
            director_scene_json: serializeDocument(),
            director_preview_path: localPath,
            workflow_references: {
              ...refs,
              videos: [...(refs.videos || []).filter((item) => item.path !== localPath), {
                path: localPath,
                label: '3D 导演台预演',
                source: 'director',
              }].slice(-3),
            },
          })
          ElMessage.success('预演视频已加入分镜参考')
        } catch (error) {
          ElMessage.error('预演已下载，但加入分镜参考失败：' + error.message)
        }
      }
    }
    recordChunks = []
  }
  currentTime.value = 0
  playStartedAt = performance.now()
  playing.value = true
  mediaRecorder.start(500)
  recording.value = true
}

function selectedKeyframeRecord(time = currentTime.value) {
  const object = objectById.get(selectedId.value)
  if (!object) return null
  if (object.userData.props?.attach_to) {
    ElMessage.warning('挂接对象不能添加世界关键帧，请给父对象添加关键帧')
    return null
  }
  return {
    object_id: selectedId.value,
    time: Number(Math.min(timelineDuration.value, Math.max(0, Number(time) || 0)).toFixed(3)),
    position: object.position.toArray(),
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: object.scale.toArray(),
  }
}

function recordSelectedKeyframe(time = currentTime.value, options = {}) {
  const frame = selectedKeyframeRecord(time)
  if (!frame) return false
  keyframes.value = upsertDirectorKeyframe(keyframes.value, frame)
  if (options.commit !== false) commitHistory()
  if (options.announce) ElMessage.success(`${frame.time.toFixed(2)} 秒姿态已记录；同一时刻再次记录会覆盖`)
  return true
}

function recordStartKeyframe() {
  currentTime.value = 0
  recordSelectedKeyframe(0, { announce: true })
}

function addKeyframe() {
  recordSelectedKeyframe(currentTime.value, { announce: true })
}

function jumpToKeyframe(frame) {
  scrubTimeline(Number(frame?.time) || 0)
}

function deleteSelectedKeyframe(frame) {
  keyframes.value = removeDirectorKeyframe(keyframes.value, selectedId.value, frame?.time)
  applyTimeline(currentTime.value)
  commitHistory()
}

function keyframePositionText(frame) {
  const position = Array.isArray(frame?.position) ? frame.position : []
  if (position.length < 3) return '局部姿态'
  return `X ${Number(position[0]).toFixed(1)} · Y ${Number(position[1]).toFixed(1)} · Z ${Number(position[2]).toFixed(1)}`
}

function previewSelectedMotion() {
  if (selectedKeyframes.value.length < 2) {
    ElMessage.warning('请至少记录起点和终点两个关键帧')
    return
  }
  currentTime.value = 0
  applyTimeline(0)
  playStartedAt = performance.now()
  playing.value = true
}

function applyTimeline(time) {
  const tracks = new Map()
  for (const keyframe of keyframes.value) {
    if (!tracks.has(keyframe.object_id)) tracks.set(keyframe.object_id, [])
    tracks.get(keyframe.object_id).push(keyframe)
  }
  for (const [id, track] of tracks) {
    const value = interpolateObjectKeyframes(track, time)
    const object = objectById.get(id)
    if (!value || !object) continue
    if (Array.isArray(value.position) && Array.isArray(value.rotation) && Array.isArray(value.scale)) {
      object.position.fromArray(value.position)
      object.rotation.set(...value.rotation)
      object.scale.fromArray(value.scale)
      cameraHelpers.get(id)?.update()
    }
  }
  for (const object of objectById.values()) updateDirectorObjectAtTime(object, time)
  applyDirectorAttachments(serializeDocument(), objectById, time)
  syncSelectedForm()
}

function scrubTimeline(value) {
  playing.value = false
  currentTime.value = Number(value)
  applyTimeline(currentTime.value)
}

function togglePlayback() {
  if (playing.value) {
    playing.value = false
    return
  }
  if (currentTime.value >= timelineDuration.value) currentTime.value = 0
  playStartedAt = performance.now() - currentTime.value * 1000
  playing.value = true
}

function changeTimelineDuration(value) {
  timelineDuration.value = Math.min(60, Math.max(1, Number(value) || 5))
  keyframes.value = keyframes.value.filter((frame) => frame.time <= timelineDuration.value)
  currentTime.value = Math.min(currentTime.value, timelineDuration.value)
  commitHistory()
}

function onTransformMouseUp() {
  if (autoRecordKeyframes.value && currentTime.value > 0 && selectedId.value && !selectedForm.attachTo) {
    recordSelectedKeyframe(currentTime.value, { commit: false })
  }
  commitHistory()
}

function stageObjectFromIntersection(object) {
  let cursor = object
  while (cursor && !cursor.userData?.stageObject) cursor = cursor.parent
  return cursor?.userData?.stageObject ? cursor : null
}

function onCanvasPointerDown(event) {
  if (previewMode.value !== 'free') return
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, editorCamera)
  const hits = raycaster.intersectObjects([...objectById.values()], true)
  const hit = hits.map((entry) => stageObjectFromIntersection(entry.object)).find(Boolean)
  if (hit) selectObject(hit.userData.id)
}

function onKeyDown(event) {
  const tag = event.target?.tagName?.toLowerCase()
  if (tag === 'input' || tag === 'textarea') return
  if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId.value) removeSelected()
}

function resizeRenderer() {
  const container = viewportRef.value
  if (!container || !renderer) return
  const width = Math.max(1, container.clientWidth)
  const height = Math.max(1, container.clientHeight)
  renderer.setSize(width, height, false)
  editorCamera.aspect = width / height
  editorCamera.updateProjectionMatrix()
}

function orientTargetCameras() {
  for (const object of objectById.values()) {
    if (!object?.isPerspectiveCamera) continue
    applyDirectorCameraAim(object, { props: object.userData.props || {} }, objectById)
  }
}

function renderScene() {
  if (!renderer || !scene) return
  const width = renderer.domElement.width / renderer.getPixelRatio()
  const height = renderer.domElement.height / renderer.getPixelRatio()
  const shotCamera = objectById.get(activeCameraId.value)
  orientTargetCameras()
  const showDirectorHelpers = previewMode.value === 'free' && !recording.value
  setDirectorHelperVisibility(scene, showDirectorHelpers)
  for (const [id, helper] of cameraHelpers) {
    helper.visible = showDirectorHelpers && id !== activeCameraId.value
    helper.update()
  }
  renderer.setScissorTest(false)
  renderer.setViewport(0, 0, width, height)
  renderer.setClearColor('#090c12', 1)
  renderer.clear()
  if (previewMode.value === 'shot' && shotCamera?.isPerspectiveCamera) {
    const targetAspect = shotCamera.aspect || 16 / 9
    let viewWidth = width
    let viewHeight = viewWidth / targetAspect
    if (viewHeight > height) {
      viewHeight = height
      viewWidth = viewHeight * targetAspect
    }
    const x = Math.floor((width - viewWidth) / 2)
    const y = Math.floor((height - viewHeight) / 2)
    renderer.setScissorTest(true)
    renderer.setScissor(x, y, Math.floor(viewWidth), Math.floor(viewHeight))
    renderer.setViewport(x, y, Math.floor(viewWidth), Math.floor(viewHeight))
    renderer.render(scene, shotCamera)
    renderer.setScissorTest(false)
  } else {
    renderer.render(scene, editorCamera)
  }
}

function animate(now) {
  if (playing.value) {
    const next = (now - playStartedAt) / 1000
    if (next >= timelineDuration.value) {
      currentTime.value = timelineDuration.value
      playing.value = false
      if (recording.value && mediaRecorder?.state === 'recording') mediaRecorder.stop()
    } else {
      currentTime.value = next
    }
    applyTimeline(currentTime.value)
  }
  orbit?.update()
  renderScene()
  animationFrame = requestAnimationFrame(animate)
}

async function initScene() {
  scene = new THREE.Scene()
  scene.background = new THREE.Color('#0d1119')
  scene.fog = new THREE.Fog('#0d1119', 24, 72)
  editorCamera = new THREE.PerspectiveCamera(48, 1, 0.1, 300)
  editorCamera.position.set(7.5, 5.5, 9)

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.shadowMap.enabled = true
  renderer.outputColorSpace = THREE.SRGBColorSpace
  viewportRef.value.appendChild(renderer.domElement)
  renderer.domElement.className = 'director-canvas'
  renderer.domElement.addEventListener('pointerdown', onCanvasPointerDown)

  orbit = new OrbitControls(editorCamera, renderer.domElement)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.target.set(0, 1.1, 0)
  orbit.maxPolarAngle = Math.PI * 0.495
  orbit.minDistance = 2
  orbit.maxDistance = 60

  transform = new TransformControls(editorCamera, renderer.domElement)
  transform.setMode(transformMode.value)
  transform.setSpace(transformSpace.value)
  transform.addEventListener('dragging-changed', (event) => { orbit.enabled = !event.value && previewMode.value === 'free' })
  transform.addEventListener('objectChange', () => {
    syncSelectedForm()
    cameraHelpers.get(selectedId.value)?.update()
  })
  transform.addEventListener('mouseUp', onTransformMouseUp)
  transformHelper = transform.getHelper ? transform.getHelper() : transform
  scene.add(transformHelper)

  const grid = new THREE.GridHelper(80, 80, '#257a6c', '#28313f')
  grid.material.opacity = 0.62
  grid.material.transparent = true
  grid.userData.directorHelper = true
  scene.add(grid)
  const ambient = new THREE.HemisphereLight('#c8dcff', '#253327', 2.2)
  scene.add(ambient)
  const key = new THREE.DirectionalLight('#fff0df', 3.2)
  key.position.set(6, 10, 4)
  key.castShadow = true
  scene.add(key)

  resizeObserver = new ResizeObserver(resizeRenderer)
  resizeObserver.observe(viewportRef.value)
  resizeRenderer()

  let initial = workflowArtifact.value?.content?.document || storyboardRecord.value?.director_scene_json || createDefaultDirectorDocument()
  const saved = localStorage.getItem(storageKey.value)
  if (saved && !workflowArtifact.value?.content?.document && !storyboardRecord.value?.director_scene_json) {
    try {
      initial = normalizeDirectorDocument(JSON.parse(saved), projectAspect.value.value)
      saveState.value = '已从本机恢复'
    } catch (_) {
      saveState.value = '本机存档损坏，已载入默认场景'
    }
  }
  await restoreDocument(initial)
  commitHistory()
  saveState.value = workflowArtifact.value?.content?.document
    ? '已从制作流程恢复'
    : storyboardRecord.value?.director_scene_json
      ? '已从分镜恢复'
    : saved ? '已从本机恢复' : '默认场景'
  webglReady.value = true
  animationFrame = requestAnimationFrame(animate)
}

function goBack() {
  if (dramaId.value && workflowRunId.value) {
    router.push({ path: `/workflow/${dramaId.value}`, query: { run: workflowRunId.value } })
  } else if (dramaId.value && storyboardId.value) {
    router.push({ path: `/workflow/${dramaId.value}`, query: { stage: 'director', storyboard: storyboardId.value } })
  } else {
    router.push('/')
  }
}

onMounted(async () => {
  tutorialVisible.value = route.query.tutorial === '1'
  await nextTick()
  try {
    const graphResult = await productionAPI.graph()
    directorAssets.value = graphResult.director_assets || []
    directorPoses.value = graphResult.director_poses || []
    directorMotions.value = graphResult.director_motions || []
    if (workflowRunId.value) {
      const summary = await productionAPI.getRun(workflowRunId.value)
      workflowAspectRatio.value = summary.run?.policy?.aspect_ratio || '16:9'
      workflowArtifact.value = selectWorkflowDirectorArtifact(summary.artifacts, workflowShotId.value)
      if (!workflowArtifact.value) throw new Error('找不到这个镜头可审查的导演台方案')
    } else if (storyboardId.value) {
      storyboardRecord.value = await storyboardsAPI.get(storyboardId.value)
    }
    await initScene()
    if (orchestrationSessionId.value && orchestrationNodeKey.value) {
      try {
        const jobs = await orchestrationAPI.blenderJobs(orchestrationSessionId.value)
        blenderJob.value = (jobs?.items || []).filter((item) => item.node_key === orchestrationNodeKey.value).at(-1) || null
        if (blenderJob.value?.plan?.scene?.document) await restoreDocument(blenderJob.value.plan.scene.document)
        startBlenderPolling()
      } catch (error) { blenderPollError.value = error.message || '无法恢复作业状态' }
    }
    window.addEventListener('keydown', onKeyDown)
  } catch (error) {
    initError.value = '3D 场景初始化失败：' + error.message
    ElMessage.error(initError.value)
  }
})

onBeforeUnmount(() => {
  stopBlenderPolling()
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop()
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  window.removeEventListener('keydown', onKeyDown)
  renderer?.domElement?.removeEventListener('pointerdown', onCanvasPointerDown)
  transform?.dispose?.()
  orbit?.dispose?.()
  clearStageObjects()
  renderer?.dispose?.()
  renderer?.domElement?.remove()
})
</script>

<style scoped>
.blender-render-result { min-height: 0; max-height: 250px; overflow: auto; padding: 12px 14px; border-bottom: 1px solid var(--border-color); background: var(--bg-inner); color: var(--text-muted); display: grid; gap: 9px; }
.director-studio.has-blender-result { grid-template-rows: 56px 48px auto minmax(180px, 1fr) 76px; }
.blender-render-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.blender-previews { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.blender-previews > * { width: 100%; min-width: 0; height: 150px; object-fit: contain; }
.blender-working { margin: 0; font-size: 12px; }
.blender-render-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.blender-render-heading > div { display: grid; gap: 3px; min-width: 0; }
.blender-render-heading strong { color: var(--text-muted); font-size: 13px; }
.blender-render-heading span { color: var(--text-muted); font-size: 11px; line-height: 1.45; }
.blender-render-links { display: flex; flex-wrap: wrap; gap: 8px 14px; }
.blender-render-links a { color: var(--text-muted); font-size: 12px; text-decoration: none; }
.blender-render-links a:hover { text-decoration: underline; }
.blender-render-error { color: var(--text-muted); line-height: 1.5; }
.director-studio {
  height: 100vh;
  min-height: 560px;
  display: grid;
  grid-template-rows: 56px 48px minmax(0, 1fr) 76px;
  overflow: hidden;
  background: #090c12;
  color: var(--text-primary);
}
.director-header,
.director-toolbar,
.director-timeline {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  border-color: var(--border-color);
  background: var(--bg-inner);
}
.director-header {
  justify-content: space-between;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-color);
}
.director-brand,
.director-header-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.director-brand > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.director-brand strong {
  font-size: 15px;
  line-height: 1.2;
  letter-spacing: 0;
  white-space: nowrap;
}
.director-brand span,
.save-state {
  color: var(--text-muted);
  font-size: 11px;
  white-space: nowrap;
}
.director-toolbar {
  gap: 8px;
  padding: 6px 12px;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid var(--border-color);
}
.director-toolbar::-webkit-scrollbar {
  display: none;
}
.director-toolbar > * {
  flex: 0 0 auto;
}
.toolbar-divider {
  flex: 0 0 1px;
  align-self: stretch;
  background: var(--bg-inner);
  margin: 0 2px;
}
.director-main {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 286px;
}
.director-viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #090c12;
}
.director-viewport :deep(.director-canvas) {
  display: block;
  width: 100%;
  height: 100%;
  outline: none;
}
.preview-indicator {
  position: absolute;
  top: 12px;
  left: 12px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  background: rgba(11, 14, 20, 0.78);
  color: var(--text-primary);
  font-size: 12px;
  backdrop-filter: blur(8px);
}
.record-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f05b68;
  box-shadow: 0 0 0 3px rgba(240, 91, 104, 0.18);
}
.webgl-fallback {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  font-size: 13px;
}
.director-inspector {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border-color);
  background: var(--bg-card);
  overflow: hidden;
}
.panel-title,
.inspector-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.panel-title {
  min-height: 42px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-color);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
}
.panel-title span:last-child {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
}
.object-list {
  flex: 0 1 220px;
  min-height: 84px;
  overflow: auto;
  padding: 6px;
  border-bottom: 1px solid var(--border-color);
}
.object-row {
  width: 100%;
  height: 34px;
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0 8px;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.object-row:hover {
  background: var(--bg-inner);
}
.object-row.selected {
  border-color: var(--border-color);
  background: var(--bg-inner);
  color: var(--text-primary);
}
.object-kind {
  color: var(--text-muted);
  font-size: 11px;
}
.object-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.attachment-status {
  margin: 6px 0 10px;
  padding: 7px 8px;
  border-left: 3px solid var(--border-color);
  color: var(--el-color-primary);
  background: rgba(53, 182, 160, .12);
  font-size: 12px;
  line-height: 1.45;
}
.keyframe-editor {
  display: grid;
  gap: 8px;
  margin-top: 14px;
  padding: 10px;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--bg-inner);
}
.keyframe-editor-heading,
.keyframe-editor-heading > span {
  display: flex;
  align-items: center;
  gap: 7px;
}
.keyframe-editor-heading {
  justify-content: space-between;
}
.keyframe-editor-heading strong {
  color: var(--text-primary);
  font-size: 12px;
}
.keyframe-editor-heading small {
  color: var(--text-muted);
  font-size: 10px;
}
.keyframe-steps {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px;
}
.keyframe-steps span {
  min-width: 0;
  padding: 4px 3px;
  border: 1px solid var(--border-color);
  color: var(--text-muted);
  background: var(--bg-inner);
  font-size: 9px;
  text-align: center;
  white-space: nowrap;
}
.keyframe-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}
.keyframe-actions :deep(.el-button) {
  width: 100%;
  min-width: 0;
  margin-left: 0;
  padding-inline: 6px;
  font-size: 10px;
}
.keyframe-list {
  display: grid;
  gap: 4px;
  max-height: 132px;
  overflow: auto;
}
.keyframe-row {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 28px;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--border-color);
  background: var(--bg-inner);
}
.keyframe-row > button {
  min-width: 0;
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  align-items: center;
  gap: 6px;
  padding: 6px 7px;
  border: 0;
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.keyframe-row > button:hover,
.keyframe-row > button:focus-visible {
  background: var(--bg-inner);
  outline: 1px solid #3e8e80;
}
.keyframe-row strong {
  color: #f1bd59;
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 10px;
}
.keyframe-row small {
  min-width: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.keyframe-empty,
.keyframe-attached-note,
.aspect-lock-note {
  padding: 7px 8px;
  color: var(--text-muted);
  background: var(--bg-inner);
  font-size: 10px;
  line-height: 1.45;
}
.keyframe-attached-note {
  color: var(--el-color-primary);
}
.aspect-lock-note {
  margin-top: 6px;
  color: var(--text-primary);
  border-left: 3px solid var(--border-color);
}
.active-camera-mark {
  color: var(--text-primary);
  font-size: 9px;
  font-weight: 700;
}
.transform-panel {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px 16px;
}
.inspector-heading {
  height: 30px;
  margin-bottom: 7px;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 600;
}
.field-label {
  display: block;
  margin: 12px 0 5px;
  color: var(--text-muted);
  font-size: 11px;
}
.vector-row,
.camera-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}
.camera-row {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}
.vector-row :deep(.el-input-number),
.camera-row :deep(.el-input-number),
.camera-row :deep(.el-select) {
  width: 100%;
}
.vector-row :deep(.el-input-number.is-controls-right .el-input__wrapper) {
  padding-left: 6px;
  padding-right: 30px;
}
.vector-row :deep(.el-input-number.is-controls-right .el-input-number__increase),
.vector-row :deep(.el-input-number.is-controls-right .el-input-number__decrease) {
  width: 26px;
}
.vector-row :deep(.el-input__inner) {
  min-width: 0;
  padding: 0 2px;
  text-align: center;
}
.activate-camera {
  width: 100%;
  margin-top: 10px;
}
.empty-inspector {
  flex: 1;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  font-size: 12px;
}
.director-timeline {
  gap: 10px;
  padding: 0 14px;
  border-top: 1px solid var(--border-color);
}
.timeline-track {
  position: relative;
  flex: 1;
  min-width: 120px;
}
.timecode {
  min-width: 46px;
  color: var(--text-primary);
  font-family: 'Menlo', 'Consolas', monospace;
  font-size: 11px;
  text-align: center;
}
.keyframe-mark {
  position: absolute;
  top: 50%;
  width: 7px;
  height: 7px;
  transform: translate(-50%, -50%) rotate(45deg);
  border: 1px solid var(--border-color);
  background: #f1bd59;
  pointer-events: none;
}
.director-timeline :deep(.el-input-number) {
  width: 88px;
}
.director-studio :deep(.el-button),
.director-studio :deep(.el-radio-button__inner),
.director-studio :deep(.el-input__wrapper),
.director-studio :deep(.el-select__wrapper) {
  --el-fill-color-blank: var(--bg-inner);
  --el-bg-color: var(--bg-inner);
  --el-border-color: var(--border-color);
  --el-text-color-regular: var(--text-primary);
  --el-text-color-primary: var(--text-primary);
}
.director-studio :deep(.el-input__wrapper),
.director-studio :deep(.el-select__wrapper) {
  background: var(--bg-inner);
  box-shadow: 0 0 0 1px var(--border-color) inset;
}
.director-studio :deep(.el-input__inner),
.director-studio :deep(.el-select__selected-item) {
  color: var(--text-primary);
}
.director-studio :deep(.el-input-number) {
  --el-input-bg-color: var(--bg-inner);
  --el-input-text-color: var(--text-primary);
  --el-disabled-bg-color: var(--bg-inner);
  --el-disabled-text-color: var(--text-muted);
  --el-fill-color-light: var(--bg-inner);
  --el-fill-color: var(--bg-inner);
}
.director-studio :deep(.el-input-number .el-input__wrapper) {
  background: var(--bg-inner) !important;
  box-shadow: 0 0 0 1px var(--border-color) inset !important;
}
.director-studio :deep(.el-input-number .el-input__inner) {
  color: var(--text-primary) !important;
  -webkit-text-fill-color: var(--bg-inner) !important;
}
.director-studio :deep(.el-input-number__increase),
.director-studio :deep(.el-input-number__decrease) {
  border-color: var(--border-color) !important;
  background: var(--bg-inner) !important;
  color: var(--text-primary) !important;
}
.director-studio :deep(.el-input-number__increase:hover),
.director-studio :deep(.el-input-number__decrease:hover) {
  background: var(--bg-inner) !important;
  color: var(--el-color-primary) !important;
}
.director-studio :deep(.el-input-number .el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px #35b69d inset, 0 0 0 2px rgba(53, 182, 157, .16) !important;
}
.director-studio :deep(.el-input-number.is-disabled .el-input__wrapper),
.director-studio :deep(.el-input-number .el-input.is-disabled .el-input__wrapper) {
  background: var(--bg-inner) !important;
  box-shadow: 0 0 0 1px var(--border-color) inset !important;
}
.director-studio :deep(.el-input-number.is-disabled .el-input__inner),
.director-studio :deep(.el-input-number .el-input.is-disabled .el-input__inner) {
  color: var(--text-muted) !important;
  -webkit-text-fill-color: var(--bg-inner) !important;
}
.director-studio :deep(.el-input-number.is-disabled .el-input-number__increase),
.director-studio :deep(.el-input-number.is-disabled .el-input-number__decrease) {
  background: var(--bg-card) !important;
  color: var(--text-muted) !important;
}
.asset-palette-tools {
  display: grid;
  gap: 12px;
  margin-bottom: 16px;
}
.asset-palette-tools :deep(.el-segmented) {
  width: 100%;
  overflow-x: auto;
}
.asset-palette-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
}
.asset-palette-item {
  min-width: 0;
  min-height: 76px;
  display: grid;
  grid-template-columns: 58px minmax(0, 1fr) 24px;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  background: var(--bg-card);
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
}
.asset-palette-item:hover,
.asset-palette-item:focus-visible {
  border-color: var(--border-color);
  box-shadow: 0 0 0 2px rgba(47, 156, 137, 0.14);
  outline: none;
}
.asset-palette-item img,
.asset-palette-icon {
  width: 58px;
  height: 58px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  background: var(--bg-inner);
  object-fit: contain;
}
.asset-palette-icon :deep(.el-icon) {
  font-size: 25px;
  color: var(--text-muted);
}
.asset-palette-copy {
  min-width: 0;
  display: grid;
  gap: 5px;
}
.asset-palette-copy strong,
.asset-palette-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.asset-palette-copy strong {
  font-size: 13px;
}
.asset-palette-copy small {
  color: var(--text-muted);
  font-size: 10px;
}
.asset-add-icon {
  color: var(--el-color-primary);
}
:global(.director-asset-drawer .el-drawer__header) {
  margin-bottom: 12px;
}
@media (max-width: 860px) {
  .director-studio {
    min-height: 600px;
    grid-template-rows: 52px 46px minmax(0, 1fr) 70px;
  }
  .director-studio.has-blender-result { grid-template-rows: 52px 46px auto minmax(240px, 1fr) 70px; height: auto; min-height: 100vh; overflow: visible; }
  .blender-previews { grid-template-columns: 1fr; }
  .director-main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(240px, 1fr) 205px;
  }
  .director-inspector {
    border-left: 0;
    border-top: 1px solid var(--border-color);
    display: grid;
    grid-template-columns: minmax(150px, 0.8fr) minmax(220px, 1.2fr);
    grid-template-rows: 42px minmax(0, 1fr);
  }
  .panel-title {
    grid-column: 1 / -1;
  }
  .object-list {
    min-height: 0;
    border-right: 1px solid var(--border-color);
    border-bottom: 0;
  }
  .transform-panel,
  .empty-inspector {
    min-height: 0;
  }
  .save-state {
    display: none;
  }
}
@media (max-width: 520px) {
  .asset-palette-grid {
    grid-template-columns: 1fr;
  }
  .director-header {
    padding: 0 8px;
  }
  .director-brand span {
    display: none;
  }
  .director-header-actions {
    gap: 5px;
  }
  .director-toolbar {
    padding-inline: 8px;
  }
  .director-inspector {
    grid-template-columns: 126px minmax(210px, 1fr);
  }
  .transform-panel {
    overflow-x: hidden;
  }
  .vector-row :deep(.el-input-number__increase),
  .vector-row :deep(.el-input-number__decrease) {
    display: none;
  }
  .vector-row :deep(.el-input-number.is-controls-right .el-input__wrapper) {
    padding-inline: 6px;
  }
  .director-timeline {
    gap: 6px;
    padding: 0 8px;
  }
  .director-timeline > .timecode:last-of-type,
  .director-timeline :deep(.el-input-number) {
    display: none;
  }
}
:global(.director-tutorial-drawer .el-drawer__body) {
  padding: 0 18px 24px;
  background: var(--bg-card);
}
:global(.director-tutorial-drawer .el-drawer__header) {
  margin-bottom: 0;
  padding: 18px;
  color: var(--text-primary);
  background: var(--bg-card);
  border-bottom: 1px solid var(--border-color);
}
.tutorial-boundary {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr);
  gap: 9px;
  margin: 16px 0;
  padding: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--el-color-primary);
  background: var(--bg-inner);
}
.tutorial-boundary strong { color: var(--text-primary); font-size: 12px; }
.tutorial-boundary p { margin: 4px 0 0; color: var(--text-muted); font-size: 11px; line-height: 1.6; }
.tutorial-steps { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
.tutorial-steps li {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 10px;
  padding: 13px 0;
  border-bottom: 1px solid var(--border-color);
}
.tutorial-steps li > span {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 1px solid var(--border-color);
  border-radius: 50%;
  color: var(--el-color-primary);
  font-size: 11px;
}
.tutorial-steps strong { color: var(--text-primary); font-size: 12px; }
.tutorial-steps p { margin: 4px 0 8px; color: var(--text-muted); font-size: 11px; line-height: 1.55; }
.tutorial-when { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 15px 0; }
.tutorial-when div { display: grid; gap: 4px; padding: 10px; border-radius: 5px; background: var(--bg-inner); }
.tutorial-when strong { color: var(--text-primary); font-size: 11px; }
.tutorial-when span { color: var(--text-muted); font-size: 10px; line-height: 1.5; }
.tutorial-guide-link { width: 100%; }
</style>
