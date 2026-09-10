import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artifactReviewLabel } from '../src/utils/orchestrationExperience.js'

test('artifact labels distinguish playable files from content acceptance', () => {
  assert.equal(artifactReviewLabel({ status: 'validated' }), '文件检查通过')
  assert.equal(artifactReviewLabel({ status: 'review_required' }), '待核对内容')
  assert.equal(artifactReviewLabel({ status: 'validated', validation: { content_review: { verdict: 'needs_changes' } } }), '需要修改')
  assert.equal(artifactReviewLabel({ status: 'validated', validation: { content_review: { verdict: 'accepted' } } }), '内容已核对')
})
