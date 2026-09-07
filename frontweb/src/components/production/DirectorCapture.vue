<template>
  <section class="capture-studio" aria-label="3D 导演台预演录制">
    <div ref="viewportRef" class="capture-viewport" :style="captureViewportStyle">
      <div class="capture-hud">
        <span><i :class="{ active: recording }" />{{ recording ? 'REC' : 'PREVIEW' }}</span>
        <span>{{ currentTime.toFixed(1) }} / {{ duration.toFixed(1) }}s</span>
      </div>
      <div v-if="validationError" class="capture-loading capture-error" role="alert">{{ validationError }}</div>
      <div v-else-if="!ready" class="capture-loading">正在初始化 3D 预演</div>
    </div>
    <div class="capture-footer">
      <div class="capture-state" role="status" aria-live="polite">
        <el-icon><VideoCamera /></el-icon>
        <span>{{ statusText }}</span>
      </div>
      <div class="capture-actions">
        <el-button :icon="Refresh" :disabled="recording || submitting" @click="restartPreview">重新预览</el-button>
        <el-button
          type="primary"
          :icon="VideoPlay"
          :loading="recording || submitting"
          :disabled="!ready || Boolean(validationError)"
          @click="captureAndSubmit"
        >录制并提交</el-button>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { Refresh, VideoCamera, VideoPlay } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { interpolateObjectKeyframes, normalizeDirectorDocument } from '@/utils/directorScene'
import {
  applyDirectorCameraAim,
  inspectDirectorCameraFraming,
} from '@/utils/directorThree'
import {
  applyDirectorRecordTransform,
  createDirectorObject,
  disposeDirectorObject,
  applyDirectorAttachments,
  setDirectorHelperVisibility,
  updateDirectorObjectAtTime,
  waitForDirectorObjects,
} from '@/utils/directorRuntime'
import { uploadAPI } from '@/api/upload'
import { productionAPI } from '@/api/production'
import { productionAspectCss, productionAspectSpec } from '@/utils/aspectRatio'

const props = defineProps({
  runId: { type: String, required: true },
  dramaId: { type: [String, Number], default: null },
  clientAction: { type: Object, required: true },
  autoStart: { type: Boolean, default: false },
})

const emit = defineEmits(['submitted', 'error'])
const viewportRef = ref(null)
const ready = ref(false)
const recording = ref(false)
const submitting = ref(false)
const currentTime = ref(0)
const frameCount = ref(0)
const runtimeError = ref('')
const targetAspect = computed(() => productionAspectSpec(props.clientAction?.expected_aspect_ratio))
const captureViewportStyle = computed(() => ({
  aspectRatio: productionAspectCss(targetAspect.value.value),
  '--capture-aspect-number': String(targetAspect.value.ratio),
}))

const documentState = computed(() => {
  try {
    return {
      document: normalizeDirectorDocument(
        props.clientAction?.director_document || {},
        targetAspect.value.value
      ),
      error: '',
    }
  } catch (error) {
    return { document: null, error: error.message || '导演台方案校验失败' }
  }
})
const documentValue = computed(() => documentState.value.document || { objects: [], active_camera_id: null, timeline: { duration: 5, keyframes: [] } })
const validationError = computed(() => documentState.value.error || runtimeError.value)
const duration = computed(() => Math.max(1, Number(props.clientAction?.expected_duration || documentValue.value.timeline.duration || 5)))
const statusText = computed(() => {
  if (validationError.value) return `无法录制：${validationError.value}`
  if (submitting.value) return '正在验证并保存预演文件'
  if (recording.value) return `正在录制第 ${frameCount.value} 帧`
  if (ready.value) return '预演已就绪'
  return '正在准备场景'
})

let renderer = null
let scene = null
let previewCamera = null
let resizeObserver = null
let animationFrame = null
let previewStartedAt = 0
let recorder = null
let chunks = []
let captureStartedAt = 0
let captureResolve = null
let captureReject = null
let sceneBuildVersion = 0
const objectMap = new Map()

async function buildScene() {
  const version = ++sceneBuildVersion
  if (validationError.value) throw new Error(validationError.value)
  disposeScene()
  scene = new THREE.Scene()
  scene.background = new THREE.Color('#aebac0')
  scene.fog = new THREE.Fog('#aebac0', 20, 55)
  scene.add(new THREE.HemisphereLight('#eaf5f2', '#4d5357', 1.8))
  objectMap.clear()
  for (const item of documentValue.value.objects) {
    const object = createDirectorObject(item)
    setDirectorHelperVisibility(object, false)
    objectMap.set(item.id, object)
    scene.add(object)
  }
  await waitForDirectorObjects([...objectMap.values()])
  if (version !== sceneBuildVersion) return false
  previewCamera = objectMap.get(documentValue.value.active_camera_id)
  if (!(previewCamera instanceof THREE.PerspectiveCamera)) {
    previewCamera = new THREE.PerspectiveCamera(42, targetAspect.value.ratio, 0.05, 300)
    previewCamera.position.set(6.5, 3.8, 8)
    previewCamera.lookAt(0, 1, 0)
    scene.add(previewCamera)
  }
  previewCamera.aspect = targetAspect.value.ratio
  previewCamera.updateProjectionMatrix()
  applyTimeline(0)
  return true
}

function resize() {
  if (!renderer || !viewportRef.value || !previewCamera) return
  const rect = viewportRef.value.getBoundingClientRect()
  const width = Math.max(320, Math.round(rect.width))
  const height = Math.max(220, Math.round(rect.height))
  renderer.setSize(width, height, false)
  previewCamera.aspect = targetAspect.value.ratio
  previewCamera.updateProjectionMatrix()
}

function applyTimeline(time) {
  const document = documentValue.value
  for (const item of document.objects) {
    const object = objectMap.get(item.id)
    if (!object) continue
    const frames = document.timeline.keyframes.filter((frame) => frame.object_id === item.id)
    const state = interpolateObjectKeyframes(frames, time)
    applyDirectorRecordTransform(object, state || item)
    updateDirectorObjectAtTime(object, time, item.props)
  }
  applyDirectorAttachments(document, objectMap, time)
  for (const item of document.objects.filter((object) => object.kind === 'camera')) {
    applyDirectorCameraAim(objectMap.get(item.id), item, objectMap)
  }
}

function validateCaptureComposition() {
  const document = documentValue.value
  const cameraRecord = document.objects.find((item) => item.id === document.active_camera_id)
  if (!cameraRecord || !previewCamera?.isPerspectiveCamera) throw new Error('3D 预演缺少有效的主摄影机')
  applyTimeline(0)
  const target = applyDirectorCameraAim(previewCamera, cameraRecord, objectMap)
  if (cameraRecord.props?.aim_mode === 'target') {
    const framing = inspectDirectorCameraFraming(previewCamera, target)
    if (!framing.ok) throw new Error('主摄影机的构图焦点不在画面内，请先调整导演台方案')
  }
  renderer.render(scene, previewCamera)
}

function animate(now) {
  if (!renderer || !scene || !previewCamera) return
  const elapsed = recording.value
    ? Math.min(duration.value, (now - captureStartedAt) / 1000)
    : ((now - previewStartedAt) / 1000) % duration.value
  currentTime.value = elapsed
  applyTimeline(elapsed)
  renderer.render(scene, previewCamera)
  if (recording.value) {
    frameCount.value += 1
    if (elapsed >= duration.value && recorder?.state === 'recording') recorder.stop()
  }
  animationFrame = requestAnimationFrame(animate)
}

async function initialize() {
  try {
    await nextTick()
    if (!viewportRef.value) return
    runtimeError.value = ''
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.shadowMap.enabled = true
    renderer.outputColorSpace = THREE.SRGBColorSpace
    viewportRef.value.appendChild(renderer.domElement)
    await buildScene()
    resizeObserver = new ResizeObserver(resize)
    resizeObserver.observe(viewportRef.value)
    resize()
    previewStartedAt = performance.now()
    animationFrame = requestAnimationFrame(animate)
    ready.value = true
    if (props.autoStart) setTimeout(() => captureAndSubmit(), 700)
  } catch (error) {
    ready.value = false
    runtimeError.value = error.message || '3D 场景初始化失败'
    emit('error', error)
  }
}

function restartPreview() {
  previewStartedAt = performance.now()
  currentTime.value = 0
}

function chooseMimeType() {
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((type) => window.MediaRecorder?.isTypeSupported(type)) || ''
}

function recordBlob() {
  return new Promise((resolve, reject) => {
    if (!renderer?.domElement.captureStream || typeof window.MediaRecorder === 'undefined') {
      reject(new Error('当前浏览器不支持画布录制'))
      return
    }
    try {
      validateCaptureComposition()
    } catch (error) {
      reject(error)
      return
    }
    const mimeType = chooseMimeType()
    chunks = []
    const stream = renderer.domElement.captureStream(30)
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : { videoBitsPerSecond: 6_000_000 })
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    recorder.onerror = (event) => reject(event.error || new Error('预演录制失败'))
    recorder.onstop = () => {
      recording.value = false
      stream.getTracks().forEach((track) => track.stop())
      if (!chunks.length) return reject(new Error('预演录制没有产生视频数据'))
      resolve(new Blob(chunks, { type: mimeType || 'video/webm' }))
    }
    captureStartedAt = performance.now()
    frameCount.value = 0
    currentTime.value = 0
    recording.value = true
    recorder.start(500)
  })
}

function screenshotBlob() {
  return new Promise((resolve, reject) => {
    renderer.render(scene, previewCamera)
    renderer.domElement.toBlob((blob) => blob ? resolve(blob) : reject(new Error('预演截图失败')), 'image/png')
  })
}

async function captureAndSubmit() {
  if (!ready.value || recording.value || submitting.value) return
  try {
    const blob = await recordBlob()
    submitting.value = true
    const frameBlob = await screenshotBlob()
    const timestamp = Date.now()
    const [videoUpload, frameUpload] = await Promise.all([
      uploadAPI.uploadReferenceMedia(new File([blob], `director-shot-${props.clientAction.shot_id}-${timestamp}.webm`, { type: blob.type || 'video/webm' })),
      uploadAPI.uploadImage(new File([frameBlob], `director-shot-${props.clientAction.shot_id}-${timestamp}.png`, { type: 'image/png' }), { dramaId: props.dramaId }),
    ])
    const result = await productionAPI.clientResult(props.runId, {
      action_id: props.clientAction.action_id,
      token: props.clientAction.token,
      media_path: videoUpload.local_path || videoUpload.path,
      frame_path: frameUpload.local_path || frameUpload.path,
      frame_count: frameCount.value,
    })
    emit('submitted', result)
    ElMessage.success('3D 分镜视频已录制并通过本地校验')
  } catch (error) {
    emit('error', error)
    ElMessage.error(error.message || '3D 预演录制失败')
  } finally {
    submitting.value = false
    recording.value = false
    restartPreview()
  }
}

function disposeScene() {
  if (!scene) return
  for (const object of objectMap.values()) disposeDirectorObject(object)
  objectMap.clear()
  for (const object of scene.children) {
    if (!object.geometry || object.userData?.stageObject) continue
    object.geometry.dispose?.()
    if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose?.())
    else object.material?.dispose?.()
  }
  scene.clear()
}

function teardown() {
  if (animationFrame) cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  if (recorder?.state === 'recording') recorder.stop()
  disposeScene()
  renderer?.dispose()
  renderer?.domElement?.remove()
  renderer = null
}

watch(() => props.clientAction?.action_id, async () => {
  if (!renderer) return
  ready.value = false
  runtimeError.value = ''
  try {
    await buildScene()
    resize()
    restartPreview()
    ready.value = true
  } catch (error) {
    runtimeError.value = error.message || '3D 素材加载失败'
    emit('error', error)
    ElMessage.error(error.message || '3D 素材加载失败')
  }
})

onMounted(initialize)
onBeforeUnmount(teardown)

defineExpose({ captureAndSubmit })
</script>

<style scoped>
.capture-studio { border: 1px solid #cfd8dc; background: #fff; border-radius: 6px; overflow: hidden; }
.capture-viewport { position: relative; width: min(100%, calc(68vh * var(--capture-aspect-number, 1.777778))); min-width: min(100%, 320px); margin-inline: auto; background: #aebac0; overflow: hidden; }
.capture-viewport :deep(canvas) { display: block; width: 100%; height: 100%; }
.capture-hud { position: absolute; z-index: 2; inset: 12px 12px auto; display: flex; justify-content: space-between; pointer-events: none; color: #fff; font: 600 12px/1.2 ui-monospace, monospace; text-shadow: 0 1px 3px #243238; }
.capture-hud span { display: inline-flex; align-items: center; gap: 6px; }
.capture-hud i { width: 8px; height: 8px; border-radius: 50%; background: #e7ecee; }
.capture-hud i.active { background: #ef5a50; box-shadow: 0 0 0 4px rgba(239,90,80,.2); }
.capture-loading { position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 13px; }
.capture-error { padding: 24px; color: #ffd9d6; background: rgba(71, 20, 24, .92); text-align: center; line-height: 1.55; }
.capture-footer { min-height: 62px; padding: 12px 14px; display: flex; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid #dfe5e8; }
.capture-state, .capture-actions { display: flex; align-items: center; gap: 8px; }
.capture-state { min-width: 0; color: #52636d; font-size: 13px; }
@media (max-width: 640px) {
  .capture-viewport { width: min(100%, calc(58vh * var(--capture-aspect-number, 1.777778))); min-width: 0; }
  .capture-footer { align-items: flex-start; flex-direction: column; }
  .capture-actions { width: 100%; }
  .capture-actions :deep(.el-button) { flex: 1; }
}
</style>
