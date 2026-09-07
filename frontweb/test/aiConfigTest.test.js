import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildDraftConfigTestRequest,
  buildSavedConfigTestRequest,
  configTestSuccessCopy,
  preferredConfigModel,
} from '../src/utils/aiConfigTest.js'

test('saved-list tests send only the trusted config ID', () => {
  const request = buildSavedConfigTestRequest({
    id: 42,
    base_url: 'https://api.example/v1',
    api_key: '',
    has_api_key: true,
  })
  assert.deepEqual(request, { config_id: 42 })
  assert.equal(JSON.stringify(request).includes('api_key'), false)
})

test('draft tests prefer default_model and omit an empty saved key placeholder', () => {
  const request = buildDraftConfigTestRequest({
    service_type: 'image', provider: 'yinzi', api_protocol: 'openai',
    base_url: ' https://draft.example/v1/ ', api_key: '',
    modelText: 'first-model\nsecond-model', default_model: 'second-model',
    endpoint: '/images/generations',
  }, 42)
  assert.equal(request.config_id, 42)
  assert.deepEqual(request.draft.model, ['first-model', 'second-model'])
  assert.equal(request.draft.default_model, 'second-model')
  assert.equal(Object.hasOwn(request.draft, 'api_key'), false)
  assert.equal(Object.hasOwn(request.draft, 'settings'), false)
})

test('new draft tests include a user-entered temporary key', () => {
  const request = buildDraftConfigTestRequest({
    service_type: 'text', provider: 'yinzi', base_url: 'https://draft.example/v1',
    api_key: 'temporary-runtime-value', modelText: 'gpt-5.6-sol',
  })
  assert.equal(Object.hasOwn(request, 'config_id'), false)
  assert.equal(request.draft.api_key, 'temporary-runtime-value')
})

test('preferred model and success copy do not overclaim reachability-only probes', () => {
  assert.equal(preferredConfigModel({ model: ['first'], default_model: 'chosen' }), 'chosen')
  assert.match(configTestSuccessCopy({ authenticated: true }), /凭据验证成功/)
  assert.match(configTestSuccessCopy({ authenticated: true, probe: 'minimal_text_response' }), /极少文本/)
  assert.match(configTestSuccessCopy({ reachable_only: true }), /没有可用的只读鉴权端点/)
})
