const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const reviewMedia = require('../src/services/productionReviewMedia');

test('detects visual review media without treating narration settings as video', () => {
  assert.equal(reviewMedia.visualMediaKind({ stage: 'asset_images', media_path: 'a.png' }), 'image');
  assert.equal(reviewMedia.visualMediaKind({ stage: 'shot_video', media_path: 'a.mp4' }), 'video');
  assert.equal(reviewMedia.visualMediaKind({ stage: 'final_edit', content: { kind: 'narration_plan' } }), null);
  assert.equal(reviewMedia.visualMediaKind({ stage: 'final_edit', content: { kind: 'final_video' }, media_path: 'a.mp4' }), 'video');
})

test('chooses stable first, middle and last review times', () => {
  assert.deepEqual(reviewMedia.sampleTimes(10), [0.8, 5, 9.2]);
  assert.deepEqual(reviewMedia.sampleTimes(0.5), [0.04, 0.25, 0.42]);
})

test('prepares an original image as visual evidence without creating a copy', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-review-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const imagePath = path.join(root, 'frame.png');
  fs.writeFileSync(imagePath, Buffer.from('fake-image-content'));
  const evidence = await reviewMedia.prepareVisualReviewEvidence({ storage: { local_path: root } }, {
    stage: 'storyboard_images', media_path: 'frame.png', content_hash: 'abc123', mime_type: 'image/png',
  });
  assert.equal(evidence.imageSource.localAbsPath, imagePath);
  assert.equal(evidence.receipt.kind, 'source_image');
  assert.equal(evidence.receipt.media_sha256, 'abc123');
  evidence.cleanup();
  assert.equal(fs.existsSync(imagePath), true);
})

test('prepares video frame evidence and removes only the temporary review sheet', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-review-video-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoPath = path.join(root, 'shot.mp4');
  fs.writeFileSync(videoPath, Buffer.alloc(2048, 7));
  let reviewSheetPath = '';
  const sampledAt = [0.4, 2.5, 4.6];
  const evidence = await reviewMedia.prepareVisualReviewEvidence({ storage: { local_path: root } }, {
    stage: 'shot_video', media_path: 'shot.mp4', content_hash: 'video-hash', mime_type: 'video/mp4',
    content: { validation: { duration: 5 } },
  }, {
    createVideoReviewSheet(sourcePath, duration, outputPath) {
      assert.equal(sourcePath, videoPath);
      assert.equal(duration, 5);
      reviewSheetPath = outputPath;
      fs.writeFileSync(outputPath, Buffer.alloc(2048, 9));
      return sampledAt;
    },
  });

  try {
    assert.equal(evidence.imageSource.localAbsPath, reviewSheetPath);
    assert.equal(fs.existsSync(reviewSheetPath), true);
    assert.deepEqual(evidence.receipt, {
      kind: 'video_first_middle_last_sheet',
      media_sha256: 'video-hash',
      relative_path: 'shot.mp4',
      sampled_at_seconds: sampledAt,
    });
  } finally {
    evidence.cleanup();
  }
  assert.equal(fs.existsSync(reviewSheetPath), false);
  assert.equal(fs.existsSync(path.dirname(reviewSheetPath)), false);
  assert.equal(fs.existsSync(videoPath), true);
})
