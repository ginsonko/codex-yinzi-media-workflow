import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { createDirectorMaterial } from './directorThree.js'

const loader = new GLTFLoader()
const modelCache = new Map()
const RECIPE_MATERIAL_OVERRIDE_FIELDS = Object.freeze([
  'color',
  'opacity',
  'roughness',
  'metalness',
  'emissive',
  'emissive_intensity',
  'wireframe',
])
const CHARACTER_ANCHOR_ALIASES = Object.freeze({
  head: ['head', 'mixamorighead', 'headbone'],
  left_forearm: ['leftforearm', 'forearmleft', 'lowerarmleft', 'mixamorigleftforearm', 'armleft'],
  right_forearm: ['rightforearm', 'forearmright', 'lowerarmright', 'mixamorigrightforearm', 'armright'],
  left_hand: ['lefthand', 'handleft', 'wristleft', 'mixamoriglefthand', 'armleft'],
  right_hand: ['righthand', 'handright', 'wristright', 'mixamorig-righthand', 'mixamorigrighthand', 'armright'],
})

const MOTION_CLIPS = Object.freeze({
  idle: 'idle',
  walk: 'walk',
  run: 'sprint',
  wave: 'interact-right',
  talk: 'interact-left',
  turn: 'emote-no',
  sit_down: 'sit',
  stand_up: 'sit',
  push: 'holding-both',
  carry: 'holding-both',
})

const POSE_CLIPS = Object.freeze({
  neutral: ['static', 0],
  sit: ['sit', 0.98],
  crouch: ['pick-up', 0.56],
  point: ['interact-right', 0.72],
  reach: ['pick-up', 0.72],
  arms_crossed: ['holding-both', 0.98],
  look_up: ['emote-yes', 0.42],
})

export function directorModelClipName(motion) {
  return MOTION_CLIPS[String(motion || 'idle')] || 'idle'
}

function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, min, max, fallback) {
  return Math.min(max, Math.max(min, finite(value, fallback)))
}

function safeColor(value, fallback) {
  try { return new THREE.Color(value || fallback) } catch (_) { return new THREE.Color(fallback) }
}

function material(props = {}, color = '#7c8a90', defaults = {}) {
  return createDirectorMaterial({ ...props, color: props.color || color }, color, {
    roughness: 0.72,
    metalness: 0.08,
    ...defaults,
  })
}

function markShadow(object) {
  object.traverse((child) => {
    if (!child.isMesh) return
    child.castShadow = true
    child.receiveShadow = true
  })
  return object
}

function loadModel(url) {
  if (!modelCache.has(url)) {
    modelCache.set(url, new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, (error) => reject(new Error(`3D 素材加载失败：${url}；${error?.message || error}`)))
    }))
  }
  return modelCache.get(url)
}

function cloneLoadedScene(gltf) {
  const scene = cloneSkeleton(gltf.scene)
  scene.traverse((child) => {
    if (!child.isMesh) return
    child.geometry = child.geometry?.clone?.() || child.geometry
    if (Array.isArray(child.material)) child.material = child.material.map((entry) => entry.clone())
    else child.material = child.material?.clone?.() || child.material
    child.castShadow = true
    child.receiveShadow = true
  })
  return scene
}

function meshAt(geometry, meshMaterial, position = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, meshMaterial)
  mesh.position.fromArray(position)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function createLimb(length, radius, meshMaterial) {
  const pivot = new THREE.Group()
  const segment = meshAt(
    new THREE.CapsuleGeometry(radius, Math.max(0.02, length - radius * 2), 4, 8),
    meshMaterial,
    [0, -length / 2, 0]
  )
  pivot.add(segment)
  return pivot
}

function normalizedNodeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function findCharacterNode(root, aliases) {
  const wanted = new Set((aliases || []).map(normalizedNodeName))
  let match = null
  root?.traverse?.((node) => {
    if (!match && wanted.has(normalizedNodeName(node.name))) match = node
  })
  return match
}

function derivedLimbAnchor(node, anchorName, fraction) {
  if (!node) return null
  const existing = node.children?.find((child) => child.userData?.directorAnchor === anchorName)
  if (existing) return existing
  const anchor = new THREE.Object3D()
  anchor.name = `director-anchor-${anchorName}`
  anchor.userData.directorAnchor = anchorName
  const geometry = node.geometry
  if (geometry) {
    geometry.computeBoundingBox?.()
    const bounds = geometry.boundingBox
    if (bounds) {
      anchor.position.set(
        (bounds.min.x + bounds.max.x) / 2,
        THREE.MathUtils.lerp(bounds.max.y, bounds.min.y, fraction),
        (bounds.min.z + bounds.max.z) / 2
      )
    }
  }
  node.add(anchor)
  return anchor
}

export function configureLoadedCharacterAnchors(root, visual) {
  const anchors = new Map([['root', root]])
  const head = findCharacterNode(visual, CHARACTER_ANCHOR_ALIASES.head)
  if (head) anchors.set('head', head)
  for (const side of ['left', 'right']) {
    const forearmName = `${side}_forearm`
    const handName = `${side}_hand`
    const forearmNode = findCharacterNode(visual, CHARACTER_ANCHOR_ALIASES[forearmName])
    const handNode = findCharacterNode(visual, CHARACTER_ANCHOR_ALIASES[handName])
    const derivedForearm = forearmNode
      ? derivedLimbAnchor(forearmNode, forearmName, 0.58)
      : null
    const derivedHand = handNode
      ? derivedLimbAnchor(handNode, handName, 1)
      : null
    if (derivedForearm) anchors.set(forearmName, derivedForearm)
    if (derivedHand) anchors.set(handName, derivedHand)
  }
  root.userData.directorAnchors = anchors
  return anchors
}

function profileFor(props = {}) {
  const profileId = String(props.profile_id || props.asset_id || 'human.adult.male')
  const age = profileId.includes('.child.') ? 'child' : profileId.includes('.senior.') ? 'senior' : 'adult'
  const gender = profileId.endsWith('.female') ? 'female' : 'male'
  const presets = {
    child: { height: 1.36, head: 0.2, leg: 0.52, torso: 0.43, upperArm: 0.27, lowerArm: 0.25, shoulder: 0.28, hip: 0.19 },
    adult: { height: 1.72, head: 0.22, leg: 0.78, torso: 0.56, upperArm: 0.34, lowerArm: 0.32, shoulder: 0.36, hip: 0.22 },
    senior: { height: 1.64, head: 0.23, leg: 0.7, torso: 0.55, upperArm: 0.33, lowerArm: 0.31, shoulder: 0.34, hip: 0.23 },
  }
  const base = presets[age]
  return {
    ...base,
    age,
    gender,
    height: clamp(props.target_height, 0.8, 2.4, base.height),
    shoulder: base.shoulder * (gender === 'female' ? 0.92 : 1.04),
    hip: base.hip * (gender === 'female' ? 1.06 : 0.98),
  }
}

function createProceduralHuman(record) {
  const props = record.props || {}
  const profile = profileFor(props)
  const group = new THREE.Group()
  const skinTone = props.skin_tone || props.skin_color || (profile.gender === 'female' ? '#d9a67e' : '#c9946e')
  const hairTone = props.hair_color || (profile.age === 'senior' ? '#d5d6d2' : (profile.gender === 'female' ? '#5a382c' : '#342b29'))
  const shirtColor = props.color || (profile.gender === 'female' ? '#4e8f9b' : '#3d7796')
  const trousersColor = props.trousers_color || '#34434e'
  const skin = material({}, skinTone, { roughness: 0.86, metalness: 0 })
  const shirt = material(props, shirtColor, { roughness: 0.7, metalness: 0.02 })
  const trousers = material({}, trousersColor, { roughness: 0.8, metalness: 0.02 })
  const hair = material({}, hairTone, { roughness: 0.9, metalness: 0 })
  const shoe = material({}, '#20272c', { roughness: 0.82, metalness: 0.03 })

  const hipHeight = profile.leg
  const hips = new THREE.Group()
  hips.name = 'hips'
  hips.position.y = hipHeight

  const torso = new THREE.Group()
  torso.name = 'torso'
  const torsoMesh = meshAt(
    new THREE.CapsuleGeometry(profile.shoulder * 0.72, Math.max(0.08, profile.torso - profile.shoulder), 5, 10),
    shirt,
    [0, profile.torso / 2, 0]
  )
  torsoMesh.scale.x = 1.1
  torso.add(torsoMesh)

  const neckTop = profile.torso + profile.head * 0.9
  const head = new THREE.Group()
  head.name = 'head'
  head.position.y = neckTop
  const headMesh = meshAt(new THREE.SphereGeometry(profile.head, 18, 14), skin)
  headMesh.scale.set(0.9, 1.05, 0.92)
  head.add(headMesh)
  const hairMesh = meshAt(
    new THREE.SphereGeometry(profile.head * 1.01, 16, 10, 0, Math.PI * 2, 0, Math.PI * (profile.gender === 'female' ? 0.68 : 0.52)),
    hair,
    [0, profile.head * 0.06, -profile.head * 0.015]
  )
  hairMesh.scale.set(0.92, 1.02, 0.94)
  head.add(hairMesh)
  if (profile.gender === 'female') {
    const backHair = meshAt(new THREE.CapsuleGeometry(profile.head * 0.62, profile.head * 0.9, 4, 8), hair, [0, -profile.head * 0.42, -profile.head * 0.13])
    backHair.scale.z = 0.55
    head.add(backHair)
  }

  const armRadius = profile.head * 0.28
  const legRadius = profile.head * 0.34
  const leftArm = createLimb(profile.upperArm, armRadius, shirt)
  const rightArm = createLimb(profile.upperArm, armRadius, shirt)
  leftArm.name = 'leftArm'
  rightArm.name = 'rightArm'
  leftArm.position.set(-profile.shoulder, profile.torso * 0.82, 0)
  rightArm.position.set(profile.shoulder, profile.torso * 0.82, 0)
  const leftForearm = createLimb(profile.lowerArm, armRadius * 0.92, skin)
  const rightForearm = createLimb(profile.lowerArm, armRadius * 0.92, skin)
  leftForearm.name = 'leftForearm'
  rightForearm.name = 'rightForearm'
  leftForearm.position.y = -profile.upperArm
  rightForearm.position.y = -profile.upperArm
  leftArm.add(leftForearm)
  rightArm.add(rightForearm)
  const leftHand = new THREE.Object3D()
  leftHand.name = 'left_hand'
  leftHand.userData.directorAnchor = 'left_hand'
  leftHand.position.y = -profile.lowerArm
  const rightHand = new THREE.Object3D()
  rightHand.name = 'right_hand'
  rightHand.userData.directorAnchor = 'right_hand'
  rightHand.position.y = -profile.lowerArm
  leftForearm.add(leftHand)
  rightForearm.add(rightHand)

  const upperLegLength = profile.leg * 0.52
  const lowerLegLength = profile.leg - upperLegLength
  const leftLeg = createLimb(upperLegLength, legRadius, trousers)
  const rightLeg = createLimb(upperLegLength, legRadius, trousers)
  leftLeg.name = 'leftLeg'
  rightLeg.name = 'rightLeg'
  leftLeg.position.x = -profile.hip
  rightLeg.position.x = profile.hip
  const leftShin = createLimb(lowerLegLength, legRadius * 0.9, trousers)
  const rightShin = createLimb(lowerLegLength, legRadius * 0.9, trousers)
  leftShin.name = 'leftShin'
  rightShin.name = 'rightShin'
  leftShin.position.y = -upperLegLength
  rightShin.position.y = -upperLegLength
  const leftShoe = meshAt(new THREE.BoxGeometry(legRadius * 2, legRadius, legRadius * 3), shoe, [0, -lowerLegLength, legRadius * 0.45])
  const rightShoe = meshAt(new THREE.BoxGeometry(legRadius * 2, legRadius, legRadius * 3), shoe, [0, -lowerLegLength, legRadius * 0.45])
  leftShin.add(leftShoe)
  rightShin.add(rightShoe)
  leftLeg.add(leftShin)
  rightLeg.add(rightShin)

  torso.add(head, leftArm, rightArm)
  hips.add(torso, leftLeg, rightLeg)
  group.add(hips)
  group.userData.directorHumanRig = {
    hips, torso, head, leftArm, rightArm, leftForearm, rightForearm,
    leftLeg, rightLeg, leftShin, rightShin,
    bind: {
      hipsY: hipHeight,
      torsoY: torso.position.y,
      headY: head.position.y,
    },
    profile,
  }
  group.userData.directorAnchors = new Map([
    ['root', group],
    ['head', head],
    ['left_forearm', leftForearm],
    ['right_forearm', rightForearm],
    ['left_hand', leftHand],
    ['right_hand', rightHand],
  ])
  group.userData.directorFocusHeight = Number(props.focus_height || profile.height * 0.72)
  markShadow(group)
  return group
}

function resetHumanRig(rig) {
  const joints = [
    rig.hips, rig.torso, rig.head, rig.leftArm, rig.rightArm, rig.leftForearm,
    rig.rightForearm, rig.leftLeg, rig.rightLeg, rig.leftShin, rig.rightShin,
  ]
  for (const joint of joints) joint.rotation.set(0, 0, 0)
  rig.hips.position.y = rig.bind.hipsY
  rig.torso.position.y = rig.bind.torsoY
  rig.head.position.y = rig.bind.headY
}

function applyHumanPose(rig, pose) {
  if (pose === 'sit') {
    rig.hips.position.y -= rig.profile.leg * 0.45
    rig.leftLeg.rotation.x = -1.25
    rig.rightLeg.rotation.x = -1.25
    rig.leftShin.rotation.x = 1.25
    rig.rightShin.rotation.x = 1.25
  } else if (pose === 'crouch') {
    rig.hips.position.y -= rig.profile.leg * 0.28
    rig.leftLeg.rotation.x = -0.72
    rig.rightLeg.rotation.x = -0.72
    rig.leftShin.rotation.x = 1.2
    rig.rightShin.rotation.x = 1.2
    rig.torso.rotation.x = 0.25
  } else if (pose === 'point') {
    rig.rightArm.rotation.set(Math.PI / 2, 0, -0.18)
    rig.rightForearm.rotation.x = -0.08
    rig.head.rotation.y = -0.18
  } else if (pose === 'reach') {
    rig.leftArm.rotation.x = Math.PI / 2
    rig.rightArm.rotation.x = Math.PI / 2
    rig.torso.rotation.x = 0.18
  } else if (pose === 'arms_crossed') {
    rig.leftArm.rotation.set(0.45, 0, 0.72)
    rig.rightArm.rotation.set(0.45, 0, -0.72)
    rig.leftForearm.rotation.x = -1.45
    rig.rightForearm.rotation.x = -1.45
  } else if (pose === 'look_up') {
    rig.head.rotation.x = -0.45
    rig.torso.rotation.x = -0.08
  }
}

function applyHumanMotion(rig, props, time) {
  const motion = String(props.motion || 'idle')
  const speed = clamp(props.motion_speed, 0.1, 4, 1)
  const intensity = clamp(props.motion_intensity, 0, 1.5, 1)
  const phase = clamp(props.motion_phase, 0, 1, 0) * Math.PI * 2
  const wave = time * speed * Math.PI * 2 + phase
  if (motion === 'none') {
    applyHumanPose(rig, String(props.pose || 'neutral'))
    return
  }
  if (motion === 'idle') {
    rig.torso.rotation.z = Math.sin(wave * 0.35) * 0.025 * intensity
    rig.head.rotation.y = Math.sin(wave * 0.22) * 0.08 * intensity
    rig.hips.position.y += Math.sin(wave * 0.5) * 0.012 * intensity
  } else if (motion === 'walk' || motion === 'run') {
    const amount = (motion === 'run' ? 0.82 : 0.48) * intensity
    const swing = Math.sin(wave) * amount
    rig.leftLeg.rotation.x = swing
    rig.rightLeg.rotation.x = -swing
    rig.leftArm.rotation.x = -swing * 0.85
    rig.rightArm.rotation.x = swing * 0.85
    rig.leftShin.rotation.x = Math.max(0, -Math.sin(wave)) * amount * 0.65
    rig.rightShin.rotation.x = Math.max(0, Math.sin(wave)) * amount * 0.65
    rig.torso.rotation.x = motion === 'run' ? 0.16 : 0.04
    rig.hips.position.y += Math.abs(Math.sin(wave)) * (motion === 'run' ? 0.055 : 0.025) * intensity
  } else if (motion === 'wave') {
    rig.rightArm.rotation.set(0, 0, -2.25)
    rig.rightForearm.rotation.z = -0.35 + Math.sin(wave * 1.3) * 0.5 * intensity
    rig.head.rotation.y = -0.16
  } else if (motion === 'talk') {
    rig.leftArm.rotation.set(0.25 + Math.sin(wave * 0.6) * 0.18, 0, 0.42)
    rig.rightArm.rotation.set(0.3 + Math.cos(wave * 0.55) * 0.2, 0, -0.42)
    rig.leftForearm.rotation.x = -0.9 + Math.sin(wave) * 0.24
    rig.rightForearm.rotation.x = -0.85 + Math.cos(wave * 0.8) * 0.22
    rig.head.rotation.y = Math.sin(wave * 0.25) * 0.12
  } else if (motion === 'turn') {
    rig.torso.rotation.y = Math.sin(wave * 0.3) * 0.38 * intensity
    rig.head.rotation.y = Math.sin(wave * 0.3) * 0.58 * intensity
  } else if (motion === 'sit_down' || motion === 'stand_up') {
    const cycle = Math.min(1, (time * speed) % 2)
    const progress = motion === 'stand_up' ? 1 - cycle : cycle
    rig.hips.position.y -= rig.profile.leg * 0.45 * progress
    rig.leftLeg.rotation.x = -1.25 * progress
    rig.rightLeg.rotation.x = -1.25 * progress
    rig.leftShin.rotation.x = 1.25 * progress
    rig.rightShin.rotation.x = 1.25 * progress
  } else if (motion === 'push') {
    rig.leftArm.rotation.x = 1.45
    rig.rightArm.rotation.x = 1.45
    rig.torso.rotation.x = 0.22 + Math.sin(wave * 0.5) * 0.08
  } else if (motion === 'carry') {
    const swing = Math.sin(wave) * 0.28 * intensity
    rig.leftArm.rotation.set(0.55, 0, 0.12)
    rig.rightArm.rotation.set(0.55, 0, -0.12)
    rig.leftForearm.rotation.x = 2.3
    rig.rightForearm.rotation.x = 2.3
    rig.leftLeg.rotation.x = swing
    rig.rightLeg.rotation.x = -swing
    rig.leftShin.rotation.x = Math.max(0, -Math.sin(wave)) * 0.18 * intensity
    rig.rightShin.rotation.x = Math.max(0, Math.sin(wave)) * 0.18 * intensity
    rig.hips.position.y += Math.abs(Math.sin(wave)) * 0.016 * intensity
    rig.torso.rotation.z = Math.sin(wave * 0.35) * 0.03
  }
}

function updateProceduralHuman(group, props, time) {
  const rig = group.userData.directorHumanRig
  if (!rig) return
  resetHumanRig(rig)
  if (rig.profile.age === 'senior') {
    rig.torso.rotation.x += 0.09
    rig.head.rotation.x -= 0.04
  }
  applyHumanMotion(rig, props, time)
}

function createRecipeGeometry(shape) {
  if (shape === 'sphere') return new THREE.SphereGeometry(0.5, 20, 14)
  if (shape === 'capsule') return new THREE.CapsuleGeometry(0.35, 0.55, 5, 10)
  if (shape === 'cylinder') return new THREE.CylinderGeometry(0.5, 0.5, 1, 20)
  if (shape === 'cone') return new THREE.ConeGeometry(0.5, 1, 20)
  if (shape === 'plane') return new THREE.PlaneGeometry(1, 1)
  if (shape === 'torus') return new THREE.TorusGeometry(0.42, 0.14, 10, 24)
  return new THREE.BoxGeometry(1, 1, 1)
}

function recipeMaterialOverrides(props = {}) {
  return Object.fromEntries(RECIPE_MATERIAL_OVERRIDE_FIELDS
    .filter((key) => Object.prototype.hasOwnProperty.call(props, key))
    .map((key) => [key, props[key]]))
}

function createRecipeObject(recipe, props = {}) {
  const group = new THREE.Group()
  const overrides = recipeMaterialOverrides(props)
  for (const node of recipe?.nodes || []) {
    const nodeMaterial = { ...(node.material || {}), ...overrides }
    const mesh = new THREE.Mesh(
      createRecipeGeometry(node.shape),
      material(nodeMaterial, nodeMaterial.color || '#7f8b91', node.shape === 'plane' ? { side: THREE.DoubleSide } : {})
    )
    mesh.name = node.id
    mesh.position.fromArray(node.position || [0, 0, 0])
    mesh.rotation.set(...(node.rotation || [0, 0, 0]))
    mesh.scale.fromArray(node.scale || [1, 1, 1])
    mesh.castShadow = node.shape !== 'plane'
    mesh.receiveShadow = true
    group.add(mesh)
  }
  return group
}

function createPrimitive(record) {
  const props = record.props || {}
  if (record.kind === 'box') return meshAt(new THREE.BoxGeometry(1, 1, 1), material(props, '#d8794f'))
  if (record.kind === 'sphere') {
    const geometry = props.wireframe === true
      ? new THREE.SphereGeometry(0.62, 14, 8)
      : new THREE.SphereGeometry(0.62, 24, 18)
    return meshAt(geometry, material(props, '#e8b84e'))
  }
  if (record.kind === 'plane') {
    const mesh = meshAt(new THREE.PlaneGeometry(3, 3), material(props, '#8a93a3', { side: THREE.DoubleSide }))
    mesh.castShadow = false
    return mesh
  }
  return null
}

function setModelScaleAndGround(visual, props) {
  visual.updateMatrixWorld(true)
  const initialBounds = new THREE.Box3().setFromObject(visual)
  const initialHeight = Math.max(0.001, initialBounds.max.y - initialBounds.min.y)
  const targetHeight = clamp(props.target_height, 0.6, 3, 1.7)
  const scale = targetHeight / initialHeight
  const widthScale = clamp(props.width_scale, 0.5, 1.5, 1)
  visual.scale.set(scale * widthScale, scale, scale * widthScale)
  visual.updateMatrixWorld(true)
  const scaledBounds = new THREE.Box3().setFromObject(visual)
  visual.position.y -= scaledBounds.min.y
}

function configureModelAnimation(root, gltf) {
  const visual = root.userData.directorVisual
  const mixer = new THREE.AnimationMixer(visual)
  const clips = new Map((gltf.animations || []).map((clip) => [clip.name, clip]))
  root.userData.directorModelAnimation = { mixer, clips, action: null, key: '' }
}

function modelAnimationSelection(props, clips) {
  const motion = String(props.motion || 'idle')
  if (motion !== 'none') {
    const clipName = directorModelClipName(motion)
    return { clip: clips.get(clipName) || clips.get('idle') || clips.values().next().value, fixed: false, reverse: motion === 'stand_up' }
  }
  const [clipName, fraction] = POSE_CLIPS[String(props.pose || 'neutral')] || POSE_CLIPS.neutral
  return { clip: clips.get(clipName) || clips.get('static') || clips.values().next().value, fixed: true, fraction }
}

function updateModelAnimation(root, props, time) {
  const state = root.userData.directorModelAnimation
  if (!state) return
  const selection = modelAnimationSelection(props, state.clips)
  if (!selection.clip) return
  const key = `${selection.clip.uuid}:${selection.fixed}:${selection.reverse}`
  if (state.key !== key) {
    state.mixer.stopAllAction()
    state.action = state.mixer.clipAction(selection.clip)
    state.action.enabled = true
    state.action.setLoop(selection.fixed || selection.reverse ? THREE.LoopOnce : THREE.LoopRepeat, selection.fixed || selection.reverse ? 1 : Infinity)
    state.action.clampWhenFinished = true
    state.action.play()
    state.key = key
  }
  state.action.setEffectiveWeight(clamp(props.motion_intensity, 0, 1.5, 1))
  const duration = Math.max(0.001, selection.clip.duration)
  let localTime
  if (selection.fixed) localTime = duration * selection.fraction
  else {
    localTime = (time * clamp(props.motion_speed, 0.1, 4, 1) + clamp(props.motion_phase, 0, 1, 0) * duration) % duration
    if (selection.reverse) localTime = duration - localTime
  }
  state.mixer.setTime(Math.max(0, Math.min(duration, localTime)))
}

function createCharacter(record) {
  const root = new THREE.Group()
  const fallback = createProceduralHuman(record)
  root.add(fallback)
  root.userData.directorVisual = fallback
  root.userData.directorAnchors = new Map(fallback.userData.directorAnchors || [])
  root.userData.directorAnchors.set('root', root)
  root.userData.directorFocusHeight = Number(record.props?.focus_height || fallback.userData.directorFocusHeight || 1.1)
  root.userData.directorUpdate = (time) => {
    const props = root.userData.props || record.props || {}
    if (root.userData.directorModelAnimation) updateModelAnimation(root, props, time)
    else updateProceduralHuman(root.userData.directorVisual, props, time)
  }
  const modelUrl = String(record.props?.model_url || '')
  if (!modelUrl) {
    root.userData.directorReady = Promise.resolve(root)
    return root
  }
  root.userData.directorReady = loadModel(modelUrl).then((gltf) => {
    const visual = cloneLoadedScene(gltf)
    setModelScaleAndGround(visual, record.props || {})
    root.remove(fallback)
    disposeDirectorObject(fallback)
    root.add(visual)
    root.userData.directorVisual = visual
    configureLoadedCharacterAnchors(root, visual)
    configureModelAnimation(root, gltf)
    root.userData.directorUpdate(0)
    return root
  })
  return root
}

export function createDirectorObject(record) {
  let object
  if (record.kind === 'character') object = createCharacter(record)
  else if (record.kind === 'asset' || record.kind === 'procedural') object = createRecipeObject(record.props?.recipe, record.props)
  else if (record.kind === 'camera') object = new THREE.PerspectiveCamera(Number(record.props?.fov) || 42, Number(record.props?.aspect) || 16 / 9, 0.05, 300)
  else if (record.kind === 'light') {
    object = new THREE.Group()
    const bulb = meshAt(
      new THREE.SphereGeometry(0.16, 14, 10),
      material({ color: record.props?.color || '#fff1b3', emissive: record.props?.color || '#ffd470', emissive_intensity: 1.2 }, '#fff1b3')
    )
    bulb.userData.directorHelper = true
    const light = new THREE.PointLight(safeColor(record.props?.color, '#fff2cf'), clamp(record.props?.intensity, 0.05, 20, 2), 60)
    light.castShadow = true
    object.add(bulb, light)
    object.userData.light = light
  } else object = createPrimitive(record) || meshAt(new THREE.BoxGeometry(1, 1, 1), material({}, '#d8794f'))

  object.name = record.name
  object.userData.stageObject = true
  object.userData.kind = record.kind
  object.userData.id = record.id
  object.userData.props = { ...(record.props || {}) }
  object.userData.directorFocusHeight = Number(record.props?.focus_height || object.userData.directorFocusHeight || 0)
  object.userData.directorReady ||= Promise.resolve(object)
  object.userData.directorUpdate ||= () => {}
  applyDirectorRecordTransform(object, record)
  object.userData.directorAttachmentBaseScale = object.scale.clone()
  object.userData.directorRecordTransform = {
    position: [...(record.position || [0, 0, 0])],
    rotation: [...(record.rotation || [0, 0, 0])],
    scale: [...(record.scale || [1, 1, 1])],
  }
  return object
}

export function setDirectorHelperVisibility(object, visible) {
  object?.traverse?.((child) => {
    if (child.userData?.directorHelper) child.visible = Boolean(visible)
  })
}

export function applyDirectorRecordTransform(object, state) {
  object.position.fromArray(state.position || [0, 0, 0])
  object.rotation.set(...(state.rotation || [0, 0, 0]))
  object.scale.fromArray(state.scale || [1, 1, 1])
}

function interpolateAttachmentTrack(track, time) {
  const entries = (Array.isArray(track) ? track : [])
    .filter((entry) => entry && Array.isArray(entry.local_offset) && Array.isArray(entry.local_rotation) && Array.isArray(entry.local_scale))
    .sort((left, right) => Number(left.time || 0) - Number(right.time || 0))
  if (!entries.length) return null
  const current = Math.max(0, finite(time, 0))
  if (current <= entries[0].time) return entries[0]
  if (current >= entries[entries.length - 1].time) return entries[entries.length - 1]
  let left = entries[0]
  let right = entries[entries.length - 1]
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index].time >= current) {
      left = entries[index - 1]
      right = entries[index]
      break
    }
  }
  const amount = Math.min(1, Math.max(0, (current - left.time) / Math.max(0.000001, right.time - left.time)))
  const mix = (a, b) => [0, 1, 2].map((index) => a[index] + (b[index] - a[index]) * amount)
  return {
    local_offset: mix(left.local_offset, right.local_offset),
    local_rotation: mix(left.local_rotation, right.local_rotation),
    local_scale: mix(left.local_scale, right.local_scale),
  }
}

export function resolveDirectorAnchor(object, anchorName = 'root') {
  const name = String(anchorName || 'root')
  if (name === 'root') return object || null
  const anchor = object?.userData?.directorAnchors?.get(name)
  return anchor || null
}

export function applyDirectorAttachments(document, objectMap, time = 0) {
  const objects = Array.isArray(document?.objects) ? document.objects : []
  const keyframes = Array.isArray(document?.timeline?.keyframes) ? document.timeline.keyframes : []
  const records = new Map(objects.map((record) => [record.id, record]))
  const states = new Map()
  const applyOne = (id) => {
    if (states.get(id) === 1) throw new Error(`director attachment cycle detected at: ${id}`)
    if (states.get(id) === 2) return
    const record = records.get(id)
    if (!record?.props?.attach_to) {
      states.set(id, 2)
      return
    }
    states.set(id, 1)
    const parentId = String(record.props.attach_to)
    const parentRecord = records.get(parentId)
    const parentObject = objectMap?.get(parentId)
    const childObject = objectMap?.get(id)
    if (!parentRecord || !parentObject || !childObject) throw new Error(`director attachment object is missing: ${id} -> ${parentId}`)
    applyOne(parentId)
    parentObject.updateMatrixWorld(true)
    const anchor = resolveDirectorAnchor(parentObject, record.props.attach_anchor)
    if (!anchor) {
      const error = new Error(`director attachment anchor is unresolved: ${parentId}.${record.props.attach_anchor}`)
      error.code = 'DIRECTOR_ANCHOR_UNRESOLVED'
      throw error
    }
    anchor.updateMatrixWorld(true)
    const localFrame = interpolateAttachmentTrack(keyframes.filter((frame) => frame.object_id === id), time)
    const localOffset = localFrame?.local_offset || record.props.local_offset || [0, 0, 0]
    const localRotation = localFrame?.local_rotation || record.props.local_rotation || [0, 0, 0]
    const localScale = localFrame?.local_scale || record.props.local_scale || [1, 1, 1]
    const baseScale = childObject.userData.directorAttachmentBaseScale || new THREE.Vector3(1, 1, 1)
    const localMatrix = new THREE.Matrix4().compose(
      new THREE.Vector3().fromArray(localOffset),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...localRotation)),
      new THREE.Vector3(baseScale.x * localScale[0], baseScale.y * localScale[1], baseScale.z * localScale[2])
    )
    const worldMatrix = anchor.matrixWorld.clone().multiply(localMatrix)
    worldMatrix.decompose(childObject.position, childObject.quaternion, childObject.scale)
    childObject.updateMatrixWorld(true)
    states.set(id, 2)
  }
  for (const record of objects) if (record?.props?.attach_to) applyOne(record.id)
  return true
}

export function updateDirectorObjectAtTime(object, time, props = null) {
  if (!object) return
  if (props) object.userData.props = { ...object.userData.props, ...props }
  object.userData.directorUpdate?.(Math.max(0, finite(time, 0)))
}

export async function waitForDirectorObjects(objects) {
  await Promise.all((objects || []).map((object) => object?.userData?.directorReady || Promise.resolve()))
  return objects
}

export function disposeDirectorObject(object) {
  object?.userData?.directorModelAnimation?.mixer?.stopAllAction?.()
  object?.traverse?.((child) => {
    child.geometry?.dispose?.()
    if (Array.isArray(child.material)) child.material.forEach((entry) => entry.dispose?.())
    else child.material?.dispose?.()
  })
}

export function clearDirectorModelCache() {
  modelCache.clear()
}
