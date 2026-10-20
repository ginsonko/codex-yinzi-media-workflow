import test from 'node:test'
import assert from 'node:assert/strict'
import { findDurationInfo, isSmartVideoModel, supportCountFor, videoDurationHint } from '../src/utils/videoDurations.js'
import { imageSizeSubmissionNote, snapImageSize } from '../src/utils/imageSizes.js'

const smart = { kind: 'smart', source: 'site', recommended_duration: 15,
  duration_support: [{ seconds: 5, count: 6 }, { seconds: 10, count: 6 }, { seconds: 15, count: 5 }, { seconds: 30, count: 3 }] }

test('smart-video hint counts the routes for the chosen duration and recommends one', () => {
  assert.equal(isSmartVideoModel('smart-video'), true)
  assert.equal(isSmartVideoModel('Seedance 2.0-720'), false)
  assert.deepEqual(videoDurationHint(smart, 30, 'smart-video'), { warning: false, text: '当前 30 秒：智能视频可用 3 个模型（5 秒 6 个、10 秒 6 个、15 秒 5 个），建议 15 秒' })
  assert.deepEqual(videoDurationHint(smart, 15, 'smart-video'), { warning: false, text: '当前 15 秒：智能视频可用 5 个模型（5 秒 6 个、10 秒 6 个、30 秒 3 个）' })
  const none = videoDurationHint(smart, 90, 'smart-video')
  assert.equal(none.warning, true)
  assert.match(none.text, /^当前 90 秒：智能视频没有可用模型（5 秒 6 个、10 秒 6 个、15 秒 5 个、30 秒 3 个），建议 15 秒/)
  assert.match(videoDurationHint(smart, 8, 'smart-video').text, /^当前 8 秒：智能视频可用时长/)
  assert.equal(supportCountFor(smart.duration_support, 3), 0)
})

test('an estimate from the saved catalog says so', () => {
  assert.match(videoDurationHint({ ...smart, source: 'catalog_routes' }, 10, 'smart-video').text, /按已保存的模型目录估算/)
})

test('concrete models list their durations and warn when the choice is outside them', () => {
  assert.deepEqual(videoDurationHint({ kind: 'model', durations: [5, 10, 15] }, 10, 'Seedance 2.0-720'), { warning: false, text: '当前 10 秒：Seedance 2.0-720 单次生成支持 5 / 10 / 15 秒' })
  const outside = videoDurationHint({ kind: 'model', durations: [5, 10, 15] }, 30, 'Seedance 2.0-720')
  assert.equal(outside.warning, true)
  assert.match(outside.text, /只支持 5 \/ 10 \/ 15 秒，建议 15 秒。仍可提交/)
  assert.match(videoDurationHint({ kind: 'model', duration_min: 5, duration_max: 15 }, 20, 'x').text, /只支持 5-15 秒，建议 15 秒/)
})

test('missing data hides the hint', () => {
  assert.equal(videoDurationHint(null, 10, 'smart-video'), null)
  assert.equal(videoDurationHint({ kind: 'smart', duration_support: [] }, 10, 'smart-video'), null)
  assert.equal(videoDurationHint({ kind: 'model' }, 10, 'x'), null)
  assert.equal(findDurationInfo(undefined, 'smart-video'), null)
  assert.deepEqual(findDurationInfo([{ model: 'Smart-Video', duration_info: smart }], 'smart-video'), smart)
  assert.equal(findDurationInfo([{ model: 'smart-video' }], 'smart-video'), null)
})

test('image size snapping matches the backend table and is shown only when it changes the request', () => {
  assert.equal(snapImageSize('1920x1920'), '2048x2048')
  assert.equal(snapImageSize('1024x1536'), '1536x2048')
  assert.equal(snapImageSize('2940x1260'), '2560x1088')
  assert.equal(snapImageSize('2K', '9:16'), '1440x2560')
  assert.equal(snapImageSize('auto'), '')
  assert.equal(imageSizeSubmissionNote('gpt-image-2', '1920x1920', '1:1'), '请求 1920×1920 → 实际提交 2048×2048')
  assert.equal(imageSizeSubmissionNote('smart-image', '2048x2048', '1:1'), '')
  assert.equal(imageSizeSubmissionNote('nano-banana-pro', '1920x1920', '1:1'), '', 'other models are submitted as asked')
  assert.equal(imageSizeSubmissionNote('gpt-image-2', '', '1:1'), '')
})
