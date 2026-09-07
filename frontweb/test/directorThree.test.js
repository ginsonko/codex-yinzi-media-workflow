import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {
  applyDirectorCameraAim,
  createDirectorMaterial,
  inspectDirectorCameraFraming,
} from '../src/utils/directorThree.js'

test('director material honors bounded transparency, wireframe, and emissive properties', () => {
  const material = createDirectorMaterial({
    color: '#88aabb',
    opacity: 0.12,
    wireframe: true,
    emissive: '#22ffaa',
    emissive_intensity: 2.5,
  })
  assert.equal(material.opacity, 0.12)
  assert.equal(material.transparent, true)
  assert.equal(material.wireframe, true)
  assert.equal(material.depthWrite, false)
  assert.equal(material.side, THREE.DoubleSide)
  assert.equal(material.emissiveIntensity, 2.5)
  material.dispose()
})

test('target-mode camera follows the animated subject and passes framing inspection', () => {
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 300)
  camera.position.set(4, 2.5, 7)
  const subject = new THREE.Object3D()
  subject.position.set(0, 0, 0)
  const objects = new Map([['subject', subject]])
  const record = { props: { aim_mode: 'target', target_id: 'subject', target_offset: [0, 1.2, 0] } }
  const target = applyDirectorCameraAim(camera, record, objects)
  const framing = inspectDirectorCameraFraming(camera, target)
  assert.equal(framing.ok, true)
  assert.ok(Math.abs(framing.ndc[0]) < 1e-6)
  assert.ok(Math.abs(framing.ndc[1]) < 1e-6)
})

test('rotation-mode camera remains untouched', () => {
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 300)
  camera.rotation.set(0.1, 0.2, 0.3)
  const before = camera.rotation.toArray().slice(0, 3)
  const result = applyDirectorCameraAim(camera, { props: { aim_mode: 'rotation' } }, new Map())
  assert.equal(result, null)
  assert.deepEqual(camera.rotation.toArray().slice(0, 3), before)
})

test('target camera uses the runtime asset focus height when no explicit offset exists', () => {
  const camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.05, 300)
  camera.position.set(0, 2, 6)
  const subject = new THREE.Object3D()
  subject.userData.directorFocusHeight = 1.35
  const target = applyDirectorCameraAim(camera, { props: { aim_mode: 'target', target_id: 'subject' } }, new Map([['subject', subject]]))
  assert.equal(target.y, 1.35)
})
