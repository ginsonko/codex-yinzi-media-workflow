import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isCrossProjectMedia,
  mapLatestFinalsByDrama,
  normalizeProductionMedia,
  normalizeUploadedMedia,
  productionMediaUrl,
  productionStageLabel,
  reusableMaterializeBody,
} from '../src/utils/productionMedia.js'

test('maps only valid final videos once per drama in server order', () => {
  const items = [
    { artifact_id: 3, drama_id: 1, stage: 'final_edit', kind: 'final_video', media_type: 'video' },
    { artifact_id: 2, drama_id: 1, stage: 'final_edit', kind: 'final_video', media_type: 'video' },
    { artifact_id: 4, drama_id: 2, stage: 'final_edit', kind: 'narration_audio', media_type: 'audio' },
    { artifact_id: 5, drama_id: 3, stage: 'shot_video', kind: null, media_type: 'video' },
  ]
  const mapped = mapLatestFinalsByDrama(items)
  assert.equal(mapped.size, 1)
  assert.equal(mapped.get(1).artifact_id, 3)
})

test('builds safe media urls and labels', () => {
  assert.equal(productionMediaUrl({ media_url: '/static/final.mp4' }), '/static/final.mp4')
  assert.equal(productionMediaUrl({ media_path: '\\videos\\final.mp4' }), '/static/videos/final.mp4')
  assert.equal(productionMediaUrl({ available: false, media_path: 'missing.mp4' }), '')
  assert.equal(productionStageLabel('director_preview'), '3D 预演')
})

test('normalizes production and uploaded media without mixing delete ownership', () => {
  const production = normalizeProductionMedia({
    artifact_id: 41, media_type: 'audio', title: '默认旁白', media_url: '/static/voice.mp3',
  })
  assert.equal(production.id, 'production-41')
  assert.equal(production.type, 'audio')
  assert.equal(production.read_only, true)
  assert.equal(production.library_source, 'production')

  const upload = normalizeUploadedMedia({ id: 2, local_path: 'uploads/clip.webm' })
  assert.equal(upload.type, 'video')
  assert.equal(upload.library_source, 'upload')
  assert.equal(upload.name, 'clip.webm')
})

test('cross-project selection is explicit only when source and target differ', () => {
  const item = { drama_id: 9 }
  assert.equal(isCrossProjectMedia(item, 7), true)
  assert.deepEqual(reusableMaterializeBody(item, 7), { allow_cross_project: true })
  assert.deepEqual(reusableMaterializeBody(item, 9), {})
  assert.deepEqual(reusableMaterializeBody({}, 9), {})
})
