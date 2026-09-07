import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cloneDirectorJson,
  createDefaultDirectorDocument,
  directorKeyframesForObject,
  interpolateObjectKeyframes,
  normalizeDirectorRecipe,
  normalizeDirectorDocument,
  removeDirectorKeyframe,
  selectWorkflowDirectorArtifact,
  upsertDirectorKeyframe,
} from '../src/utils/directorScene.js'

test('clones reactive-style director data into detached plain JSON', () => {
  const source = new Proxy({
    asset_id: 'human.adult.female',
    recipe: { nodes: [{ shape: 'box', scale: [1, 2, 3] }] },
  }, {})
  const cloned = cloneDirectorJson(source)
  cloned.recipe.nodes[0].scale[0] = 9

  assert.equal(cloned.asset_id, 'human.adult.female')
  assert.equal(source.recipe.nodes[0].scale[0], 1)
})

test('normalizes director documents and rejects dangling keyframes', () => {
  const doc = normalizeDirectorDocument({
    active_camera_id: 'missing',
    objects: [{ id: 'actor', kind: 'character', scale: [0, 1, 1] }],
    timeline: {
      duration: 5,
      keyframes: [
        { object_id: 'actor', time: 2, position: [1, 2, 3] },
        { object_id: 'missing', time: 3 },
      ],
    },
  })
  assert.equal(doc.active_camera_id, null)
  assert.equal(doc.objects[0].scale[0], 0.01)
  assert.equal(doc.timeline.keyframes.length, 1)
})

test('interpolates transforms between adjacent keyframes', () => {
  const value = interpolateObjectKeyframes([
    { object_id: 'actor', time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    { object_id: 'actor', time: 4, position: [8, 4, 0], rotation: [0, 2, 0], scale: [2, 2, 2] },
  ], 1)
  assert.deepEqual(value.position, [2, 1, 0])
  assert.deepEqual(value.rotation, [0, 0.5, 0])
  assert.deepEqual(value.scale, [1.25, 1.25, 1.25])
})

test('default director document contains a camera and visible stage objects', () => {
  const doc = createDefaultDirectorDocument()
  const camera = doc.objects.find((object) => object.kind === 'camera')
  assert.ok(camera)
  assert.ok(doc.objects.some((object) => object.kind === 'character'))
  assert.ok(doc.active_camera_id)
  assert.equal(camera.props.aim_mode, 'target')
  assert.equal(camera.props.target_id, 'character-1')
})

test('locks camera aspect to the production format and manages object keyframes deterministically', () => {
  const document = normalizeDirectorDocument({
    aspect_ratio: '16:9',
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { aspect: 16 / 9 } },
      { id: 'actor', kind: 'character' },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, '9:16')
  assert.equal(document.aspect_ratio, '9:16')
  assert.equal(document.objects[0].props.aspect, 9 / 16)

  const start = { object_id: 'actor', time: 0, position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
  const end = { object_id: 'actor', time: 4, position: [4, 0, 0], rotation: [0, 1, 0], scale: [1, 1, 1] }
  const replacedEnd = { ...end, position: [8, 0, 0] }
  let frames = upsertDirectorKeyframe([], end)
  frames = upsertDirectorKeyframe(frames, start)
  frames = upsertDirectorKeyframe(frames, replacedEnd)
  assert.deepEqual(directorKeyframesForObject(frames, 'actor').map((item) => item.time), [0, 4])
  assert.deepEqual(frames[1].position, [8, 0, 0])
  frames = removeDirectorKeyframe(frames, 'actor', 4)
  assert.deepEqual(directorKeyframesForObject(frames, 'actor').map((item) => item.time), [0])
})

test('normalizes legacy cameras to a principal visible target and preserves rotation mode', () => {
  const tracked = normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { fov: 50 } },
      { id: 'floor', kind: 'plane' },
      { id: 'actor', kind: 'character' },
    ],
    timeline: { duration: 5, keyframes: [] },
  })
  const trackedCamera = tracked.objects.find((object) => object.id === 'camera')
  assert.equal(trackedCamera.props.aim_mode, 'target')
  assert.equal(trackedCamera.props.target_id, 'actor')
  assert.deepEqual(trackedCamera.props.target_offset, [0, 1.1, 0])

  const rotation = normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { aim_mode: 'rotation' } },
      { id: 'actor', kind: 'character' },
    ],
    timeline: { duration: 5, keyframes: [] },
  })
  assert.equal(rotation.objects[0].props.aim_mode, 'rotation')
  assert.equal(rotation.objects[0].props.target_id, undefined)
})

test('normalizes bounded procedural recipes and rejects local executable or remote model input', () => {
  const recipe = normalizeDirectorRecipe({
    label: 'AI chair',
    nodes: [
      { shape: 'javascript', scale: [1, 1, 1] },
      { shape: 'box', position: [90, -90, 0], scale: [0, 90, 1], material: { color: '#abc', opacity: 0 } },
    ],
  })
  assert.equal(recipe.nodes.length, 1)
  assert.deepEqual(recipe.nodes[0].position, [30, -30, 0])
  assert.deepEqual(recipe.nodes[0].scale, [0.02, 30, 1])
  assert.equal(recipe.nodes[0].material.opacity, 0.05)

  assert.throws(() => normalizeDirectorDocument({
    objects: [{ id: 'remote', kind: 'character', props: { model_url: 'https://example.com/model.glb' } }],
    timeline: { duration: 5, keyframes: [] },
  }), /本地素材目录/)
})

test('selects the newest reviewable director plan for one workflow shot', () => {
  const artifacts = [
    { id: 10, stage: 'director_plan', scope_id: '2', revision: 1, status: 'approved' },
    { id: 12, stage: 'director_plan', scope_id: '2', revision: 2, status: 'rejected' },
    { id: 13, stage: 'director_plan', scope_id: '3', revision: 3, status: 'draft' },
    { id: 14, stage: 'director_plan', scope_id: '2', revision: 3, status: 'draft' },
    { id: 15, stage: 'director_plan', scope_id: '2', revision: 3, status: 'approved' },
    { id: 16, stage: 'storyboard_plan', scope_id: '2', revision: 9, status: 'draft' },
  ]

  assert.equal(selectWorkflowDirectorArtifact(artifacts, 2)?.id, 15)
  assert.equal(selectWorkflowDirectorArtifact(artifacts.filter((item) => item.id !== 15), '2')?.id, 14)
  assert.equal(selectWorkflowDirectorArtifact(artifacts, '4'), null)
  assert.equal(selectWorkflowDirectorArtifact(null, '2'), null)
  assert.equal(selectWorkflowDirectorArtifact(artifacts, ''), null)
})

test('normalizes attachments and interpolates local-only keyframes', () => {
  const document = normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { aim_mode: 'rotation' } },
      { id: 'actor', kind: 'character', props: {} },
      {
        id: 'talisman', kind: 'procedural',
        props: {
          attach_to: 'actor', attach_anchor: 'left_hand', local_offset: [0, 0.08, 0],
          recipe: { nodes: [{ shape: 'plane' }] },
        },
      },
    ],
    timeline: {
      duration: 5,
      keyframes: [
        { object_id: 'talisman', time: 1, local_scale: [1, 1, 1] },
        { object_id: 'talisman', time: 2, local_scale: [0.01, 0.01, 0.01] },
      ],
    },
  })
  const talisman = document.objects.find((object) => object.id === 'talisman')
  assert.equal(talisman.props.attach_to, 'actor')
  assert.equal(talisman.props.attach_anchor, 'left_hand')
  assert.deepEqual(talisman.props.local_scale, [1, 1, 1])
  const middle = interpolateObjectKeyframes(document.timeline.keyframes, 1.5)
  assert.deepEqual(middle.local_scale, [0.505, 0.505, 0.505])
  assert.equal(Object.hasOwn(middle, 'position'), false)
})

test('hard-fails invalid attachment graphs and attached world keyframes', () => {
  const document = (objects, keyframes = []) => normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [{ id: 'camera', kind: 'camera', props: { aim_mode: 'rotation' } }, ...objects],
    timeline: { duration: 5, keyframes },
  })
  assert.throws(() => document([
    { id: 'prop', kind: 'procedural', props: { attach_to: 'missing', recipe: { nodes: [{ shape: 'box' }] } } },
  ]), /parent does not exist/)
  assert.throws(() => document([
    { id: 'a', kind: 'procedural', props: { attach_to: 'b', recipe: { nodes: [{ shape: 'box' }] } } },
    { id: 'b', kind: 'procedural', props: { attach_to: 'a', recipe: { nodes: [{ shape: 'box' }] } } },
  ]), /cycle detected/)
  assert.throws(() => document([
    { id: 'actor', kind: 'character', props: {} },
    { id: 'prop', kind: 'procedural', props: { attach_to: 'actor', attach_anchor: 'right_hand', recipe: { nodes: [{ shape: 'box' }] } } },
  ], [{ object_id: 'prop', time: 0, position: [0, 0, 0] }]), /world keyframes/)
  assert.throws(() => document([
    { id: 'table', kind: 'box' },
    { id: 'prop', kind: 'box', props: { attach_to: 'table', attach_anchor: 'right_hand' } },
  ]), /requires a character parent/)
})
