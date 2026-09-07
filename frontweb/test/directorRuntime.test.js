import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  applyDirectorAttachments,
  configureLoadedCharacterAnchors,
  createDirectorObject,
  directorModelClipName,
  disposeDirectorObject,
  setDirectorHelperVisibility,
  updateDirectorObjectAtTime,
  waitForDirectorObjects,
} from '../src/utils/directorRuntime.js'
import { normalizeDirectorDocument, normalizeDirectorObject } from '../src/utils/directorScene.js'

test('maps visible GLB gestures to arm-driven Kenney clips', () => {
  assert.equal(directorModelClipName('wave'), 'interact-right')
  assert.equal(directorModelClipName('talk'), 'interact-left')
  assert.equal(directorModelClipName('run'), 'sprint')
})

test('shared runtime builds an articulated grounded human and applies readable motion', async () => {
  const record = normalizeDirectorObject({
    id: 'actor',
    kind: 'character',
    name: 'Actor',
    props: {
      profile_id: 'human.senior.female',
      focus_height: 1.15,
      target_height: 1.62,
      motion: 'walk',
    },
  })
  const object = createDirectorObject(record)
  await waitForDirectorObjects([object])
  const rig = object.userData.directorVisual.userData.directorHumanRig
  assert.ok(rig)
  assert.ok(rig.head && rig.leftArm && rig.rightLeg)
  assert.equal(object.position.y, 0)
  assert.equal(object.userData.directorFocusHeight, 1.15)

  updateDirectorObjectAtTime(object, 0)
  const start = rig.leftLeg.rotation.x
  updateDirectorObjectAtTime(object, 0.25)
  assert.notEqual(rig.leftLeg.rotation.x, start)
  disposeDirectorObject(object)
})

test('procedural character honors canonical identity palette colors', async () => {
  const record = normalizeDirectorObject({
    id: 'silver-heroine',
    kind: 'character',
    props: {
      asset_id: 'human.procedural',
      profile_id: 'human.adult.female',
      hair_color: '#dce6ee',
      skin_tone: '#d8a07c',
      color: '#162e36',
      trousers_color: '#151b20',
    },
  })
  const object = createDirectorObject(record)
  await waitForDirectorObjects([object])
  const colors = new Set()
  object.traverse((child) => {
    if (child.isMesh && child.material?.color) colors.add(child.material.color.getHexString())
  })
  assert.ok(colors.has('dce6ee'), 'silver hair material is present')
  assert.ok(colors.has('d8a07c'), 'skin material is present')
  disposeDirectorObject(object)
})

test('procedural carry motion keeps both arms engaged while advancing the gait', async () => {
  const record = normalizeDirectorObject({
    id: 'carrier',
    kind: 'character',
    props: { profile_id: 'human.adult.female', motion: 'carry' },
  })
  const object = createDirectorObject(record)
  await waitForDirectorObjects([object])
  const rig = object.userData.directorVisual.userData.directorHumanRig

  updateDirectorObjectAtTime(object, 0)
  const startLeg = rig.leftLeg.rotation.x
  updateDirectorObjectAtTime(object, 0.2)
  assert.equal(rig.leftForearm.rotation.x, 2.3)
  assert.equal(rig.rightForearm.rotation.x, 2.3)
  assert.notEqual(rig.leftLeg.rotation.x, startLeg)
  disposeDirectorObject(object)
})

test('shared runtime builds a multi-node procedural asset without code execution', async () => {
  const record = normalizeDirectorObject({
    id: 'chair',
    kind: 'procedural',
    props: {
      recipe: {
        label: 'Chair',
        nodes: [
          { shape: 'box', position: [0, 0.5, 0], scale: [1, 0.1, 1] },
          { shape: 'cylinder', position: [0, 0.25, 0], scale: [0.1, 0.5, 0.1] },
        ],
      },
    },
  })
  const object = createDirectorObject(record)
  await waitForDirectorObjects([object])
  assert.equal(object.children.length, 2)
  assert.equal(object.children[0].name, 'node-1')
  disposeDirectorObject(object)
})

test('object material overrides reach every recipe mesh without erasing node-only values', () => {
  const object = createDirectorObject(normalizeDirectorObject({
    id: 'wireframe-shell',
    kind: 'procedural',
    props: {
      opacity: 0.24,
      wireframe: true,
      recipe: {
        label: 'Shell',
        nodes: [
          { shape: 'torus', material: { color: '#336699', roughness: 0.2 } },
          { shape: 'sphere', material: { color: '#993366', metalness: 0.6 } },
        ],
      },
    },
  }))

  assert.equal(object.children.length, 2)
  assert.deepEqual(object.children.map((child) => child.material.opacity), [0.24, 0.24])
  assert.deepEqual(object.children.map((child) => child.material.transparent), [true, true])
  assert.deepEqual(object.children.map((child) => child.material.wireframe), [true, true])
  assert.equal(object.children[0].material.color.getHexString(), '336699')
  assert.equal(object.children[1].material.color.getHexString(), '993366')
  assert.equal(object.children[0].material.roughness, 0.2)
  assert.equal(object.children[1].material.metalness, 0.6)
  disposeDirectorObject(object)
})

test('light fixtures are editor helpers that can be hidden without disabling the light', () => {
  const object = createDirectorObject(normalizeDirectorObject({
    id: 'key-light',
    kind: 'light',
    props: { color: '#d8f8ff', intensity: 2 },
  }))
  const fixture = object.children.find((child) => child.userData.directorHelper)
  const light = object.children.find((child) => child.isPointLight)
  assert.ok(fixture)
  assert.ok(light)

  setDirectorHelperVisibility(object, false)
  assert.equal(fixture.visible, false)
  assert.equal(light.visible, true)
  disposeDirectorObject(object)
})

test('attached props follow procedural hand anchors after parent motion and local scale changes', async () => {
  const document = normalizeDirectorDocument({
    active_camera_id: null,
    objects: [
      { id: 'actor', kind: 'character', props: { profile_id: 'human.adult.female', motion: 'none', pose: 'reach' } },
      {
        id: 'sword', kind: 'procedural',
        props: {
          attach_to: 'actor', attach_anchor: 'right_hand', local_offset: [0, 0, 0],
          recipe: { nodes: [{ shape: 'box', scale: [0.1, 1, 0.1] }] },
        },
      },
    ],
    timeline: {
      duration: 5,
      keyframes: [
        { object_id: 'actor', time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        { object_id: 'sword', time: 0, local_scale: [1, 1, 1] },
        { object_id: 'sword', time: 2, local_scale: [0.01, 0.01, 0.01] },
      ],
    },
  })
  const actor = createDirectorObject(document.objects.find((item) => item.id === 'actor'))
  const sword = createDirectorObject(document.objects.find((item) => item.id === 'sword'))
  await waitForDirectorObjects([actor, sword])
  const objectMap = new Map([['actor', actor], ['sword', sword]])
  updateDirectorObjectAtTime(actor, 0)
  applyDirectorAttachments(document, objectMap, 0)
  const hand = actor.userData.directorAnchors.get('right_hand')
  hand.updateMatrixWorld(true)
  const first = new THREE.Vector3()
  hand.getWorldPosition(first)
  assert.ok(sword.position.distanceTo(first) < 0.0001)
  actor.position.x = 2
  updateDirectorObjectAtTime(actor, 0.5)
  applyDirectorAttachments(document, objectMap, 0.5)
  hand.updateMatrixWorld(true)
  const moved = new THREE.Vector3()
  hand.getWorldPosition(moved)
  assert.ok(sword.position.distanceTo(moved) < 0.0001)
  applyDirectorAttachments(document, objectMap, 2)
  assert.ok(sword.scale.x < 0.02)
  disposeDirectorObject(actor)
  disposeDirectorObject(sword)
})

test('Kenney arm aliases produce deterministic forearm and hand anchors', () => {
  const root = new THREE.Group()
  const visual = new THREE.Group()
  const head = new THREE.Object3D()
  head.name = 'head'
  const left = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2))
  left.name = 'arm-left'
  const right = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1, 0.2))
  right.name = 'arm-right'
  visual.add(head, left, right)
  configureLoadedCharacterAnchors(root, visual)
  assert.equal(root.userData.directorAnchors.get('head'), head)
  assert.ok(root.userData.directorAnchors.get('left_hand'))
  assert.ok(root.userData.directorAnchors.get('right_hand'))
  assert.ok(root.userData.directorAnchors.get('left_forearm'))
  assert.ok(root.userData.directorAnchors.get('right_forearm'))
  left.geometry.dispose()
  right.geometry.dispose()
})

test('attachment resolver reports an unresolved named anchor instead of using origin', () => {
  const parent = new THREE.Group()
  const child = new THREE.Group()
  const objectMap = new Map([['parent', parent], ['child', child]])
  const document = {
    objects: [
      { id: 'parent', kind: 'character', props: {} },
      { id: 'child', kind: 'procedural', props: { attach_to: 'parent', attach_anchor: 'left_hand', local_offset: [0, 0, 0], local_rotation: [0, 0, 0], local_scale: [1, 1, 1] } },
    ],
    timeline: { keyframes: [] },
  }
  assert.throws(() => applyDirectorAttachments(document, objectMap, 0), /anchor is unresolved/)
})
