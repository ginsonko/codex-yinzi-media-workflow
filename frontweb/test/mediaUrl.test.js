import test from 'node:test'
import assert from 'node:assert/strict'
import { assetImageUrl, normalizeLocalMediaUrl, storyboardVideoUrl } from '../src/utils/mediaUrl.js'

test('rewrites only stale loopback static media to the current app origin', () => {
  const current = 'http://127.0.0.1:43123'
  assert.equal(
    normalizeLocalMediaUrl('http://localhost:5679/static/images/a.png?x=1', current),
    'http://127.0.0.1:43123/static/images/a.png?x=1'
  )
  assert.equal(normalizeLocalMediaUrl('https://cdn.example.com/a.png', current), 'https://cdn.example.com/a.png')
  assert.equal(normalizeLocalMediaUrl('http://localhost:5679/api/v1/status', current), 'http://localhost:5679/api/v1/status')
})

test('local paths remain preferred over historical remote fields', () => {
  assert.equal(assetImageUrl({ local_path: 'images/a.png', image_url: 'http://localhost:5679/static/old.png' }), '/static/images/a.png')
  assert.equal(storyboardVideoUrl({ video_local_path: 'videos/a.mp4', video_url: 'http://localhost:5679/static/old.mp4' }), '/static/videos/a.mp4')
})
