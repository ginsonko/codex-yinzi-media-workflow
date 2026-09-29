import test from 'node:test'
import assert from 'node:assert/strict'
import { imageRatios, imageTiers, imageSizeFor, imageSizePresets, usesImageSizePresets } from '../src/utils/imageSizes.js'
import { manualItemRequest, newManualItem } from '../src/utils/manualBatch.js'

const expected = {
  '1:1': ['1024x1024','2048x2048','2880x2880'],
  '3:2': ['1536x1024','2160x1440','3456x2304'],
  '16:9': ['1280x720','2560x1440','3840x2160'],
  '9:16': ['720x1280','1440x2560','2160x3840'],
  '4:3': ['1024x768','2048x1536','3200x2400'],
  '3:4': ['768x1024','1536x2048','2400x3200'],
  '21:9': ['1280x544','2560x1088','3840x1600'],
}

test('image2 and image2.5 expose exactly the supplied 21 ratio/tier dimensions', () => {
  assert.deepEqual(imageRatios, Object.keys(expected))
  assert.deepEqual(imageTiers, ['1K','2K','4K'])
  for (const [ratio, sizes] of Object.entries(expected)) {
    assert.deepEqual(Object.values(imageSizePresets[ratio]), sizes)
    for (const model of ['gpt-image-2','gpt-image-2.5']) {
      sizes.forEach((size, index) => assert.equal(imageSizeFor(model, ratio, imageTiers[index]), size))
    }
  }
})

test('changing item model, aspect ratio or tier recomputes size without stale inherited dimensions', () => {
  const defaults = { model: 'gpt-image-2', settings: { aspect_ratio: '16:9', image_tier: '2K', size: '' } }
  const item = newManualItem({ prompt: 'test' })
  assert.equal(manualItemRequest(item, 'image', defaults, []).size, '2560x1440')
  item.aspect_ratio = '9:16'; item.image_tier = '4K'
  assert.equal(manualItemRequest(item, 'image', defaults, []).size, '2160x3840')
  item.model = 'gpt-image-2.5'; item.aspect_ratio = '3:2'
  assert.equal(manualItemRequest(item, 'image', defaults, []).size, '3456x2304')
  item.model = 'other-image'; item.size = '1000x1500'
  assert.equal(usesImageSizePresets(item.model), false)
  assert.equal(manualItemRequest(item, 'image', defaults, []).size, '1000x1500')
  item.size = ''
  assert.equal(manualItemRequest(item, 'image', defaults, []).size, undefined)
})

test('system-default image2 uses the same preset dimensions as an explicit item model', () => {
  const options = [{ value: 'default-image', model: 'gpt-image-2.5', config_id: 4, preferred: true }]
  const request = manualItemRequest(newManualItem({ prompt: 'default' }), 'image', { model: '', settings: { aspect_ratio: '1:1', image_tier: '4K' } }, options)
  assert.equal(request.image_config_id, 4)
  assert.equal(request.size, '2880x2880')
})
