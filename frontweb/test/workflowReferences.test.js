import test from 'node:test'
import assert from 'node:assert/strict'
import {
  autoLinkStatusMeta,
  buildReferenceAutoLinkView,
  mergeWorkflowReferences,
  normalizeWorkflowReferences,
  referenceSourceLabel,
  selectedAutoLinkDependencyIds,
} from '../src/utils/workflowReferences.js'

test('smart fill preserves manually selected references before suggested assets', () => {
  const result = mergeWorkflowReferences(
    { images: [{ path: 'upload.png', label: '用户上传', source: 'upload' }] },
    { images: [
      { path: 'director.png', source: 'director' },
      { path: 'character.png', source: 'character' },
      { path: 'scene.png', source: 'scene' },
      { path: 'storyboard.png', source: 'storyboard' },
    ] }
  )
  assert.deepEqual(result.images.map((item) => item.path), [
    'upload.png', 'director.png', 'character.png', 'scene.png',
  ])
})

test('reference merge deduplicates and enforces the 4/3/1 contract', () => {
  const result = mergeWorkflowReferences(
    { videos: ['motion.webm'], audios: ['voice.wav'] },
    {
      videos: ['motion.webm', 'a.mp4', 'b.mp4', 'c.mp4'],
      audios: ['other.wav'],
      images: ['1.png', '2.png', '3.png', '4.png', '5.png'],
    }
  )
  assert.equal(result.images.length, 4)
  assert.deepEqual(result.videos.map((item) => item.path), ['motion.webm', 'a.mp4', 'b.mp4'])
  assert.deepEqual(result.audios.map((item) => item.path), ['voice.wav'])
  assert.deepEqual(normalizeWorkflowReferences(null), { images: [], videos: [], audios: [] })
})

test('AutoLink view explains exact matches, warnings, capacity and manual ownership', () => {
  const view = buildReferenceAutoLinkView({
    bundle_origin: 'manual_revision',
    autolink_receipt: {
      capacity: { provider_image_limit: 4, mandatory_image_count: 1, asset_slot_limit: 3 },
      items: [
        { status: 'matched', label: '场景 · 雨夜街区' },
        { status: 'missing_approved_image', label: '角色 · 犬妖' },
      ],
    },
  })
  assert.equal(view.originLabel, '用户修订')
  assert.equal(view.matchedCount, 1)
  assert.equal(view.warningCount, 1)
  assert.match(view.summaryText, /1 \/ 2/)
  assert.match(view.summaryText, /以下方文件为准/)
  assert.match(view.capacityText, /点名资产可用 3 格/)
  assert.equal(view.items[1].status_meta.label, '缺少已确认资源图')
})

test('AutoLink view never fabricates provenance for legacy or empty receipts', () => {
  const legacy = buildReferenceAutoLinkView({ images: [{ path: 'manual.png' }] })
  assert.equal(legacy.hasReceipt, false)
  assert.equal(legacy.originLabel, '旧版或手动参考包')

  const empty = buildReferenceAutoLinkView({ autolink_receipt: { items: [], capacity: {} } })
  assert.match(empty.summaryText, /没有用其它资产补满空位/)
  assert.equal(autoLinkStatusMeta('ambiguous_asset_definition').tone, 'warning')
  assert.equal(referenceSourceLabel({ source: 'asset', asset_name: '银发少女' }), '银发少女 · 名称精确匹配')
})

test('manual reference edits keep dependencies only for AutoLink images still selected', () => {
  const content = {
    images: [{ artifact_id: 22, path: 'selected.png' }],
    autolink_receipt: {
      items: [
        { status: 'matched', definition_artifact_id: 11, image_artifact_id: 22 },
        { status: 'omitted_by_capacity', definition_artifact_id: 33, image_artifact_id: 44 },
      ],
    },
  }
  assert.deepEqual(selectedAutoLinkDependencyIds(content), [11, 22])
  assert.deepEqual(selectedAutoLinkDependencyIds({ ...content, images: [] }), [])
})
