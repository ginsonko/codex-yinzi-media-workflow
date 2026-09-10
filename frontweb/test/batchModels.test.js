import test from 'node:test'
import assert from 'node:assert/strict'
import { batchModelOptions, batchModelSelection } from '../src/utils/batchModels.js'

test('multi-model batch options retain distinct provider configurations and preferred defaults', () => {
  const options = batchModelOptions([
    { id: 1, name: '站点一', provider: 'yinzi', model: ['gpt-image-2', 'gpt-image-2.5', 'gpt-image-2.5-flare'], default_model: 'gpt-image-2.5', is_default: true },
    { id: 2, name: '站点二', provider: 'openai', model: ['gpt-image-2.5'], default_model: 'gpt-image-2.5' },
    { id: 3, model: ['disabled'], is_active: false },
  ])
  assert.equal(options.length, 4)
  assert.equal(options[0].model, 'gpt-image-2.5')
  assert.deepEqual(batchModelSelection(options[0].value, options, 'image'), { model: 'gpt-image-2.5', provider: 'yinzi', image_config_id: 1 })
  const other = options.find(option => option.config_id === 2)
  assert.deepEqual(batchModelSelection(other.value, options, 'image'), { model: 'gpt-image-2.5', provider: 'openai', image_config_id: 2 })
})

test('legacy strings, incomplete model lists and manual future names remain usable', () => {
  const options = batchModelOptions([{ id: 8, model: '["video-a"]', default_model: 'video-b', provider: 'custom' }, { id: 9, model: 'legacy-image' }])
  assert.equal(options.length, 3)
  assert.deepEqual(batchModelSelection(options[1].value, options, 'video'), { model: 'video-b', provider: 'custom', video_config_id: 8 })
  assert.deepEqual(batchModelSelection('future-model', options, 'image'), { model: 'future-model' })
  assert.deepEqual(batchModelSelection('', options, 'image'), {})
})
