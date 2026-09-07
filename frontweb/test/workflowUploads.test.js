import test from 'node:test'
import assert from 'node:assert/strict'
import {
  describeWorkflowFile,
  preflightWorkflowFiles,
  workflowFileMediaType,
  workflowUploadLimits,
} from '../src/utils/workflowUploads.js'

function fakeFile(name, type, size = 100) {
  return { name, type, size, async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer } }
}

test('workflowFileMediaType uses MIME first and extension as fallback', () => {
  assert.equal(workflowFileMediaType(fakeFile('shot.bin', 'video/mp4')), 'video')
  assert.equal(workflowFileMediaType(fakeFile('voice.m4a', '')), 'audio')
  assert.equal(workflowFileMediaType(fakeFile('unknown.data', '')), 'unknown')
})

test('describeWorkflowFile records hash and video duration without coupling validation to the browser', async () => {
  const descriptor = await describeWorkflowFile(fakeFile('shot.mp4', 'video/mp4'), {
    hashFile: async () => 'abc123',
    probeVideoDuration: async () => 4.25,
  })
  assert.equal(descriptor.mediaType, 'video')
  assert.equal(descriptor.sha256, 'abc123')
  assert.equal(descriptor.durationSeconds, 4.25)
})

test('preflight enforces per-type, total, byte and video-duration limits', () => {
  const capability = {
    limits: { images: 2, videos: 2, audios: 1 },
    media_constraints: {
      contract_status: 'known',
      max_video_bytes: 50,
      max_total_references: 3,
      max_reference_video_seconds_total: 10,
    },
  }
  const result = preflightWorkflowFiles([
    { name: 'ok.mp4', mediaType: 'video', size: 40, sha256: 'one', durationSeconds: 4 },
    { name: 'too-long.mp4', mediaType: 'video', size: 40, sha256: 'two', durationSeconds: 7 },
    { name: 'too-large.mp4', mediaType: 'video', size: 60, sha256: 'three', durationSeconds: 1 },
  ], {
    expectedMediaType: 'video',
    currentItems: [{ path: 'existing.png', mime_type: 'image/png', sha256: 'existing' }],
    capability,
  })
  assert.equal(result.results[0].accepted, true)
  assert.match(result.results[1].errors.join(' '), /总时长/)
  assert.match(result.results[2].errors.join(' '), /文件大小/)
})

test('unknown capability warns but does not invent a blocking contract', () => {
  const result = preflightWorkflowFiles([
    { name: 'ref.png', mediaType: 'image', size: 10, sha256: 'one' },
  ], { expectedMediaType: 'image', capability: {} })
  assert.equal(result.results[0].accepted, true)
  assert.match(result.results[0].warnings.join(' '), /服务端会在提交前再次校验/)
  assert.equal(workflowUploadLimits({}).counts.image, null)
})

test('reference-bundle uploads treat known contract counts and durations as advisory', () => {
  const capability = {
    limits: { images: 1, videos: 1, audios: 0 },
    media_constraints: {
      contract_status: 'known',
      max_total_references: 1,
      max_reference_video_seconds_total: 5,
    },
  }
  const result = preflightWorkflowFiles([
    { name: 'extra.mp4', mediaType: 'video', size: 10, sha256: 'extra', durationSeconds: 12 },
  ], {
    expectedMediaType: 'video',
    currentItems: [{ path: 'existing.mp4', mime_type: 'video/mp4', sha256: 'existing', duration_seconds: 4 }],
    capability,
    maxFiles: 0,
    enforceContractLimits: false,
  })
  assert.equal(result.results[0].accepted, true)
  assert.deepEqual(result.results[0].errors, [])
})

test('duplicate references are skipped while repeated content can be mapped to distinct targets', () => {
  const descriptor = { name: 'same.png', mediaType: 'image', size: 10, sha256: 'same' }
  const blocked = preflightWorkflowFiles([descriptor], {
    expectedMediaType: 'image', currentItems: [{ sha256: 'same', mime_type: 'image/png' }], capability: {},
  })
  assert.equal(blocked.results[0].accepted, false)
  const allowed = preflightWorkflowFiles([descriptor, descriptor], {
    expectedMediaType: 'image', allowRepeatedContent: true, maxFiles: 2, capability: {},
  })
  assert.deepEqual(allowed.results.map((item) => item.accepted), [true, true])
})
