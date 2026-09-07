import { productionAspectSpec } from './aspectRatio.js'

export const DIRECTOR_DOCUMENT_VERSION = 2

export const DIRECTOR_RECIPE_SHAPES = Object.freeze(['box', 'sphere', 'capsule', 'cylinder', 'cone', 'plane', 'torus'])
export const DIRECTOR_POSE_IDS = Object.freeze(['neutral', 'sit', 'crouch', 'point', 'reach', 'arms_crossed', 'look_up'])
export const DIRECTOR_MOTION_IDS = Object.freeze(['none', 'idle', 'walk', 'run', 'wave', 'talk', 'turn', 'sit_down', 'stand_up', 'push', 'carry'])
export const DIRECTOR_ATTACHMENT_ANCHORS = Object.freeze(['root', 'head', 'left_hand', 'right_hand', 'left_forearm', 'right_forearm'])

const DIRECTOR_OBJECT_KINDS = new Set(['character', 'asset', 'procedural', 'box', 'sphere', 'plane', 'light', 'camera'])
const RECIPE_SHAPE_SET = new Set(DIRECTOR_RECIPE_SHAPES)
const POSE_ID_SET = new Set(DIRECTOR_POSE_IDS)
const MOTION_ID_SET = new Set(DIRECTOR_MOTION_IDS)
const ATTACHMENT_ANCHOR_SET = new Set(DIRECTOR_ATTACHMENT_ANCHORS)
const MAX_RECIPE_NODES = 48

export function cloneDirectorJson(value, fallback = {}) {
  return JSON.parse(JSON.stringify(value == null ? fallback : value))
}

export function selectWorkflowDirectorArtifact(artifacts, shotId) {
  const targetShotId = String(shotId || '').trim()
  if (!targetShotId) return null
  return (Array.isArray(artifacts) ? artifacts : [])
    .filter((artifact) => (
      artifact?.stage === 'director_plan'
      && String(artifact?.scope_id || '') === targetShotId
      && ['draft', 'approved'].includes(artifact?.status)
    ))
    .sort((left, right) => (
      (Number(right?.revision) || 0) - (Number(left?.revision) || 0)
      || (Number(right?.id) || 0) - (Number(left?.id) || 0)
    ))[0] || null
}

const DEFAULT_TRANSFORM = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function vec3(value, fallback) {
  const input = Array.isArray(value) ? value : []
  return [0, 1, 2].map((index) => finiteNumber(input[index], fallback[index]))
}

function boundedVec3(value, fallback, min, max) {
  return vec3(value, fallback).map((number) => Math.min(max, Math.max(min, number)))
}

function strictAttachmentVec3(value, fallback, label, min = -20, max = 20) {
  if (value == null) return [...fallback]
  if (!Array.isArray(value) || value.length < 3) throw new Error(`${label} must be a three-number array`)
  const numbers = value.slice(0, 3).map(Number)
  if (!numbers.every(Number.isFinite)) throw new Error(`${label} contains a non-finite number`)
  return numbers.map((number) => Math.min(max, Math.max(min, number)))
}

function normalizeAttachmentProps(value) {
  const props = { ...(value || {}) }
  const attachTo = String(props.attach_to || '').trim()
  if (!attachTo) {
    delete props.attach_to
    delete props.attach_anchor
    delete props.local_offset
    delete props.local_rotation
    delete props.local_scale
    return props
  }
  const anchor = String(props.attach_anchor || 'root').trim().toLowerCase()
  if (!ATTACHMENT_ANCHOR_SET.has(anchor)) throw new Error(`unsupported director attachment anchor: ${anchor}`)
  props.attach_to = attachTo.slice(0, 80)
  props.attach_anchor = anchor
  props.local_offset = strictAttachmentVec3(props.local_offset, [0, 0, 0], 'local_offset')
  props.local_rotation = strictAttachmentVec3(props.local_rotation, [0, 0, 0], 'local_rotation', -Math.PI * 4, Math.PI * 4)
  props.local_scale = strictAttachmentVec3(props.local_scale, [1, 1, 1], 'local_scale', 0.01, 50)
  return props
}

function safeColor(value, fallback = '#7f8b91') {
  const candidate = String(value || fallback).trim().slice(0, 32)
  return /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(candidate) ? candidate : fallback
}

function normalizeRecipeMaterial(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  return {
    color: safeColor(input.color),
    opacity: Math.min(1, Math.max(0.05, finiteNumber(input.opacity, 1))),
    roughness: Math.min(1, Math.max(0, finiteNumber(input.roughness, 0.72))),
    metalness: Math.min(1, Math.max(0, finiteNumber(input.metalness, 0.08))),
    emissive: safeColor(input.emissive, '#000000'),
    emissive_intensity: Math.min(12, Math.max(0, finiteNumber(input.emissive_intensity, 0))),
    wireframe: input.wireframe === true,
  }
}

export function normalizeDirectorRecipe(value, options = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const nodes = (Array.isArray(input.nodes) ? input.nodes : [])
    .slice(0, MAX_RECIPE_NODES)
    .map((node, index) => {
      const source = node && typeof node === 'object' && !Array.isArray(node) ? node : {}
      const shape = String(source.shape || '').trim().toLowerCase()
      if (!RECIPE_SHAPE_SET.has(shape)) return null
      return {
        id: String(source.id || `node-${index + 1}`).trim().slice(0, 64),
        shape,
        position: boundedVec3(source.position, [0, 0, 0], -30, 30),
        rotation: boundedVec3(source.rotation, [0, 0, 0], -Math.PI * 4, Math.PI * 4),
        scale: boundedVec3(source.scale, [1, 1, 1], 0.02, 30),
        material: normalizeRecipeMaterial(source.material),
      }
    })
    .filter(Boolean)
  if (!nodes.length && options.allowEmpty !== true) throw new Error('程序化模型必须包含至少一个支持的几何节点')
  return {
    label: String(input.label || '程序化模型').trim().slice(0, 100),
    nodes,
  }
}

function normalizeLocalModelUrl(value) {
  const url = String(value || '').trim()
  if (!url) return ''
  if (!/^\/director-assets\/[a-z0-9_./-]+$/i.test(url) || url.includes('..')) {
    throw new Error('导演台模型地址必须来自本地素材目录')
  }
  return url
}

function normalizeCharacterProps(value) {
  const props = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
  const pose = String(props.pose || 'neutral')
  const motion = String(props.motion || 'idle')
  if (!POSE_ID_SET.has(pose)) throw new Error(`不支持的人物姿势：${pose}`)
  if (!MOTION_ID_SET.has(motion)) throw new Error(`不支持的人物动作：${motion}`)
  props.asset_id = String(props.asset_id || 'human.procedural').slice(0, 80)
  props.profile_id = String(props.profile_id || (props.asset_id.startsWith('human.') ? props.asset_id : 'human.adult.male')).slice(0, 80)
  props.model_url = normalizeLocalModelUrl(props.model_url)
  if (!props.model_url) delete props.model_url
  props.pose = pose
  props.motion = motion
  props.motion_speed = Math.min(4, Math.max(0.1, finiteNumber(props.motion_speed, 1)))
  props.motion_phase = Math.min(1, Math.max(0, finiteNumber(props.motion_phase, 0)))
  props.motion_intensity = Math.min(1.5, Math.max(0, finiteNumber(props.motion_intensity, 1)))
  props.focus_height = Math.min(20, Math.max(0, finiteNumber(props.focus_height, 1.1)))
  props.target_height = Math.min(3, Math.max(0.6, finiteNumber(props.target_height, 1.7)))
  props.width_scale = Math.min(1.5, Math.max(0.5, finiteNumber(props.width_scale, 1)))
  return props
}

function normalizeCameraAims(objects) {
  const visible = objects.filter((object) => !['camera', 'light'].includes(object.kind))
  const principal = visible.find((object) => object.kind === 'character' || object.props?.asset_category === 'people')
    || visible.find((object) => object.kind !== 'plane')
    || visible[0]
    || null
  const byId = new Map(visible.map((object) => [object.id, object]))
  for (const camera of objects.filter((object) => object.kind === 'camera')) {
    const props = { ...(camera.props || {}) }
    if (props.aim_mode === 'rotation') {
      props.aim_mode = 'rotation'
      camera.props = props
      continue
    }
    const target = byId.get(String(props.target_id || '')) || principal
    if (!target) {
      props.aim_mode = 'rotation'
      delete props.target_id
      delete props.target_offset
    } else {
      props.aim_mode = 'target'
      props.target_id = target.id
      props.target_offset = vec3(
        props.target_offset,
        [0, finiteNumber(target.props?.focus_height, target.kind === 'character' ? 1.1 : 0), 0]
      )
    }
    camera.props = props
  }
}

export function normalizeDirectorObject(value, index = 0) {
  const object = value && typeof value === 'object' ? value : {}
  const kind = DIRECTOR_OBJECT_KINDS.has(object.kind) ? object.kind : 'box'
  let props = object.props && typeof object.props === 'object' && !Array.isArray(object.props)
    ? { ...object.props }
    : {}
  if (kind === 'character') props = normalizeCharacterProps(props)
  if (kind === 'asset') {
    props.asset_id = String(props.asset_id || '').trim().slice(0, 80)
    if (!props.asset_id) throw new Error('目录素材缺少 asset_id')
    props.recipe = normalizeDirectorRecipe(props.recipe)
    props.focus_height = Math.min(20, Math.max(0, finiteNumber(props.focus_height, 0.5)))
  }
  if (kind === 'procedural') {
    props.asset_id = 'procedural'
    props.recipe = normalizeDirectorRecipe(props.recipe)
    props.focus_height = Math.min(20, Math.max(0, finiteNumber(props.focus_height, 0.5)))
  }
  props = normalizeAttachmentProps(props)
  return {
    id: String(object.id || `object-${index + 1}`),
    kind,
    name: String(object.name || `${kind}-${index + 1}`).slice(0, 80),
    position: vec3(object.position, DEFAULT_TRANSFORM.position),
    rotation: vec3(object.rotation, DEFAULT_TRANSFORM.rotation),
    scale: vec3(object.scale, DEFAULT_TRANSFORM.scale).map((number) => Math.max(0.01, number)),
    props,
  }
}

function normalizeKeyframe(value, options = {}) {
  const keyframe = value && typeof value === 'object' ? value : {}
  const attached = options.attached === true
    || ['local_offset', 'local_rotation', 'local_scale'].some((key) => Object.prototype.hasOwnProperty.call(keyframe, key))
  if (attached) {
    const hasWorldTransform = ['position', 'rotation', 'scale']
      .some((key) => Object.prototype.hasOwnProperty.call(keyframe, key))
    if (hasWorldTransform) throw new Error(`attached director object cannot have world keyframes: ${String(keyframe.object_id || '')}`)
    const hasLocalTransform = ['local_offset', 'local_rotation', 'local_scale']
      .some((key) => Object.prototype.hasOwnProperty.call(keyframe, key))
    if (!hasLocalTransform) return null
    return {
      object_id: String(keyframe.object_id || ''),
      time: Math.max(0, finiteNumber(keyframe.time, 0)),
      local_offset: strictAttachmentVec3(keyframe.local_offset, [0, 0, 0], 'local_offset'),
      local_rotation: strictAttachmentVec3(keyframe.local_rotation, [0, 0, 0], 'local_rotation', -Math.PI * 4, Math.PI * 4),
      local_scale: strictAttachmentVec3(keyframe.local_scale, [1, 1, 1], 'local_scale', 0.01, 50),
    }
  }
  return {
    object_id: String(keyframe.object_id || ''),
    time: Math.max(0, finiteNumber(keyframe.time, 0)),
    position: vec3(keyframe.position, DEFAULT_TRANSFORM.position),
    rotation: vec3(keyframe.rotation, DEFAULT_TRANSFORM.rotation),
    scale: vec3(keyframe.scale, DEFAULT_TRANSFORM.scale).map((number) => Math.max(0.01, number)),
  }
}

export function validateDirectorAttachments(objects, keyframes = []) {
  const list = Array.isArray(objects) ? objects : []
  const byId = new Map(list.map((object) => [object.id, object]))
  const parents = new Map()
  for (const child of list) {
    const attachTo = String(child.props?.attach_to || '').trim()
    if (!attachTo) continue
    if (['camera', 'light'].includes(child.kind)) {
      throw new Error(`camera and light objects cannot be attached: ${child.id}`)
    }
    const parent = byId.get(attachTo)
    if (!parent) throw new Error(`director attachment parent does not exist: ${child.id} -> ${attachTo}`)
    if (['camera', 'light'].includes(parent.kind)) {
      throw new Error(`director attachments cannot target cameras or lights: ${child.id} -> ${attachTo}`)
    }
    const anchor = String(child.props?.attach_anchor || 'root')
    if (anchor !== 'root' && parent.kind !== 'character' && parent.props?.asset_category !== 'people') {
      throw new Error(`director anchor ${anchor} requires a character parent: ${child.id}`)
    }
    parents.set(child.id, attachTo)
  }
  const states = new Map()
  const visit = (id) => {
    if (states.get(id) === 1) throw new Error(`director attachment cycle detected at: ${id}`)
    if (states.get(id) === 2) return
    states.set(id, 1)
    const parent = parents.get(id)
    if (parent) visit(parent)
    states.set(id, 2)
  }
  for (const id of parents.keys()) visit(id)
  const attachedIds = new Set(parents.keys())
  for (const keyframe of Array.isArray(keyframes) ? keyframes : []) {
    if (!attachedIds.has(keyframe.object_id)) continue
    if (['position', 'rotation', 'scale'].some((key) => Object.prototype.hasOwnProperty.call(keyframe, key))) {
      throw new Error(`attached director object cannot have world keyframes: ${keyframe.object_id}`)
    }
  }
  return { parents }
}

export function normalizeDirectorDocument(value, expectedAspectRatio = null) {
  const input = value && typeof value === 'object' ? value : {}
  const aspect = productionAspectSpec(expectedAspectRatio || input.aspect_ratio)
  const objects = Array.isArray(input.objects)
    ? input.objects.slice(0, 200).map(normalizeDirectorObject)
    : []
  const ids = new Set(objects.map((object) => object.id))
  if (ids.size !== objects.length) throw new Error('director object IDs must be unique')
  const attachedIds = new Set(objects.filter((object) => object.props?.attach_to).map((object) => object.id))
  normalizeCameraAims(objects)
  for (const camera of objects.filter((object) => object.kind === 'camera')) {
    camera.props = { ...(camera.props || {}), aspect: aspect.ratio }
  }
  const duration = Math.min(60, Math.max(1, finiteNumber(input.timeline?.duration, 5)))
  const keyframes = Array.isArray(input.timeline?.keyframes)
    ? input.timeline.keyframes
      .slice(0, 2000)
      .map((keyframe) => normalizeKeyframe(keyframe, { attached: attachedIds.has(String(keyframe?.object_id || '')) }))
      .filter(Boolean)
      .filter((keyframe) => ids.has(keyframe.object_id) && keyframe.time <= duration)
      .sort((a, b) => a.time - b.time)
    : []
  validateDirectorAttachments(objects, keyframes)
  return {
    version: DIRECTOR_DOCUMENT_VERSION,
    aspect_ratio: aspect.value,
    active_camera_id: ids.has(String(input.active_camera_id || '')) ? String(input.active_camera_id) : null,
    objects,
    timeline: { duration, keyframes },
  }
}

export function createDefaultDirectorDocument(aspectRatio = '16:9') {
  const aspect = productionAspectSpec(aspectRatio)
  return normalizeDirectorDocument({
    aspect_ratio: aspect.value,
    active_camera_id: 'camera-1',
    objects: [
      { id: 'character-1', kind: 'character', name: '角色 1', position: [0, 0, 0], props: { color: '#1fc7a1' } },
      { id: 'box-1', kind: 'box', name: '道具箱', position: [2.2, 0.5, -0.8], scale: [1.2, 1, 1.2], props: { color: '#e46f51' } },
      { id: 'camera-1', kind: 'camera', name: '镜头 1', position: [6.5, 4.2, 8], rotation: [-0.28, 0.58, 0], props: { fov: 42, aspect: aspect.ratio, aim_mode: 'target', target_id: 'character-1', target_offset: [0, 1.1, 0] } },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, aspect.value)
}

export function directorKeyframesForObject(keyframes, objectId) {
  const id = String(objectId || '')
  return (Array.isArray(keyframes) ? keyframes : [])
    .filter((frame) => String(frame?.object_id || '') === id)
    .map((frame) => cloneDirectorJson(frame))
    .sort((left, right) => Number(left.time) - Number(right.time))
}

export function upsertDirectorKeyframe(keyframes, frame, epsilon = 0.001) {
  const next = (Array.isArray(keyframes) ? keyframes : []).map((item) => cloneDirectorJson(item))
  const candidate = cloneDirectorJson(frame)
  const objectId = String(candidate?.object_id || '')
  const time = Number(candidate?.time)
  if (!objectId || !Number.isFinite(time)) throw new Error('keyframe requires object_id and finite time')
  const index = next.findIndex((item) => (
    String(item?.object_id || '') === objectId
    && Math.abs(Number(item?.time) - time) <= Math.max(0, Number(epsilon) || 0)
  ))
  if (index >= 0) next.splice(index, 1, candidate)
  else next.push(candidate)
  return next.sort((left, right) => (
    Number(left.time) - Number(right.time)
    || String(left.object_id).localeCompare(String(right.object_id))
  ))
}

export function removeDirectorKeyframe(keyframes, objectId, time, epsilon = 0.001) {
  const id = String(objectId || '')
  const targetTime = Number(time)
  return (Array.isArray(keyframes) ? keyframes : [])
    .filter((item) => !(
      String(item?.object_id || '') === id
      && Number.isFinite(targetTime)
      && Math.abs(Number(item?.time) - targetTime) <= Math.max(0, Number(epsilon) || 0)
    ))
    .map((item) => cloneDirectorJson(item))
}

function lerp(a, b, amount) {
  return a + (b - a) * amount
}

function interpolateVec3(a, b, amount) {
  return [0, 1, 2].map((index) => lerp(a[index], b[index], amount))
}

export function interpolateObjectKeyframes(keyframes, time) {
  const input = Array.isArray(keyframes) ? keyframes : []
  const attached = input.some((keyframe) => (
    ['local_offset', 'local_rotation', 'local_scale']
      .some((key) => Object.prototype.hasOwnProperty.call(keyframe || {}, key))
  ))
  const track = input
    .map((keyframe) => normalizeKeyframe(keyframe, { attached }))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time)
  if (!track.length) return null
  const current = Math.max(0, finiteNumber(time, 0))
  if (current <= track[0].time) return { ...track[0] }
  if (current >= track[track.length - 1].time) return { ...track[track.length - 1] }
  let left = track[0]
  let right = track[track.length - 1]
  for (let index = 1; index < track.length; index += 1) {
    if (track[index].time >= current) {
      left = track[index - 1]
      right = track[index]
      break
    }
  }
  const span = Math.max(0.000001, right.time - left.time)
  const amount = Math.min(1, Math.max(0, (current - left.time) / span))
  if (attached) return {
    object_id: left.object_id,
    time: current,
    local_offset: interpolateVec3(left.local_offset, right.local_offset, amount),
    local_rotation: interpolateVec3(left.local_rotation, right.local_rotation, amount),
    local_scale: interpolateVec3(left.local_scale, right.local_scale, amount),
  }
  return {
    object_id: left.object_id,
    time: current,
    position: interpolateVec3(left.position, right.position, amount),
    rotation: interpolateVec3(left.rotation, right.rotation, amount),
    scale: interpolateVec3(left.scale, right.scale, amount),
  }
}
