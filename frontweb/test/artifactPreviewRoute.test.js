import test from 'node:test'
import assert from 'node:assert/strict'
import { artifactMediaUrl } from '../src/utils/mediaUrl.js'
import { artifactReviewLabel } from '../src/utils/orchestrationExperience.js'

test('registered local preview routes stay on the current API rather than becoming static paths', () => {
  const url='/api/v1/orchestration-sessions/task-1/artifacts/v1%20cut/file'
  assert.equal(artifactMediaUrl({url}),url)
  assert.equal(artifactMediaUrl({path:'C:\\not-registered.mp4'}),'')
  assert.equal(artifactReviewLabel({status:'review_required'}),'待核对内容')
})
