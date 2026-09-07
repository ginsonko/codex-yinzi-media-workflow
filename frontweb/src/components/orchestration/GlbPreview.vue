<template>
  <div class="glb-preview">
    <canvas ref="canvas" aria-label="3D 模型预览"></canvas>
    <div v-if="loading" class="glb-overlay">正在载入 3D 预览…</div>
    <div v-else-if="error" class="glb-overlay glb-error"><strong>模型暂时无法预览</strong><span>{{ error }}</span></div>
    <div v-else-if="!hasAsset" class="glb-overlay">等待 3D 成果</div>
  </div>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

const props = defineProps({ src: { type: String, default: '' } })
const canvas = ref(null), loading = ref(false), error = ref(''), hasAsset = ref(false)
let renderer, scene, camera, controls, frame, model, resizeObserver, requestVersion = 0, disposed = false
function disposeModel(value) {
  value?.traverse((object) => {
    object.geometry?.dispose()
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue
      for (const item of Object.values(material)) if (item?.isTexture) item.dispose()
      material.dispose()
    }
  })
}
function frameModel() {
  if (!model) return
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  if (box.isEmpty()) throw new Error('模型没有可显示的几何体')
  const radius = Math.max(size.x, size.y, size.z, .01) / 2
  model.position.sub(box.getCenter(new THREE.Vector3()))
  const fov = THREE.MathUtils.degToRad(camera.fov)
  const distance = radius / Math.sin(fov / 2) / Math.min(camera.aspect, 1) * 1.3
  camera.position.copy(new THREE.Vector3(1, .65, 1).normalize().multiplyScalar(distance))
  camera.near = Math.max(.001, radius / 1000); camera.far = distance + radius * 100
  camera.updateProjectionMatrix(); controls.target.set(0, 0, 0); controls.update()
}
async function loadAsset(src) {
  const version = ++requestVersion
  error.value = ''; loading.value = Boolean(src); hasAsset.value = false
  if (model) { scene.remove(model); disposeModel(model); model = null }
  if (!src) return
  try {
    const gltf = await new GLTFLoader().loadAsync(src)
    if (disposed || version !== requestVersion) { disposeModel(gltf.scene); return }
    model = gltf.scene; scene.add(model); frameModel(); hasAsset.value = true
  } catch (e) { if (version === requestVersion) error.value = e.message || '文件或贴图不可用' }
  finally { if (version === requestVersion) loading.value = false }
}
onMounted(() => {
  try {
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x171c1a)
    camera = new THREE.PerspectiveCamera(40, 1, .01, 10000)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x58625b, 2.5))
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(3, 5, 4); scene.add(light)
    renderer = new THREE.WebGLRenderer({ canvas: canvas.value, antialias: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2))
    controls = new OrbitControls(camera, canvas.value); controls.enableDamping = true
    resizeObserver = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = canvas.value.parentElement
      renderer.setSize(Math.max(1, w), Math.max(1, h), false)
      camera.aspect = Math.max(1, w) / Math.max(1, h); camera.updateProjectionMatrix()
    })
    resizeObserver.observe(canvas.value.parentElement)
    const tick = () => { frame = requestAnimationFrame(tick); controls.update(); renderer.render(scene, camera) }; tick()
    loadAsset(props.src)
  } catch (_) { error.value = '当前设备无法启动 3D 预览，可下载工程查看' }
})
watch(() => props.src, (src) => { if (scene && renderer) loadAsset(src) })
onBeforeUnmount(() => {
  disposed = true; requestVersion++; cancelAnimationFrame(frame)
  resizeObserver?.disconnect(); controls?.dispose(); disposeModel(model); renderer?.dispose()
})
</script>

<style scoped>
.glb-preview{position:relative;min-height:150px;height:100%;overflow:hidden;background:var(--bg-card)}
.glb-preview canvas{display:block;width:100%;height:100%;touch-action:none}
.glb-overlay{position:absolute;inset:0;display:grid;place-content:center;gap:6px;padding:16px;color:var(--text-primary);background:var(--bg-card);text-align:center;font-size:12px;overflow-wrap:anywhere}
.glb-error strong{color:var(--ui-danger)}
</style>
