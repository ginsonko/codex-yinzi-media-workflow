import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildShotVideoRoutingPayload,
  buildProjectVideoRoutingPayload,
  catalogModelOption,
  modelMediaLabel,
  modelPriceLabel,
  projectVideoModelDisplay,
  projectVideoRoutingChanged,
  projectVideoRoutingState,
  shotVideoPrevisMode,
  videoGroupsFromCatalog,
} from '../src/utils/videoModelRouting.js'

const catalog = [
  {
    model: 'balanced-video',
    name: 'Balanced Video',
    groups: ['特价视频分组(即梦)', '视频模型渠道'],
    prices: [
      { group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.02 },
      { group: '视频模型渠道', billing_unit: 'per_second', effective_price: 0.05 },
    ],
    capabilities: {
      resolution: '480p', quality_tier: 'balanced', duration_mode: 'range', duration_min: 5, duration_max: 15,
      max_images: 4, max_videos: 3, max_audios: 1, expensive_bypass: false,
    },
  },
  {
    model: 'bypass-video',
    name: 'Bypass Video',
    groups: ['视频模型渠道'],
    prices: [{ group: '视频模型渠道', billing_unit: 'per_second', effective_price: 0.6 }],
    capabilities: {
      resolution: '720p', quality_tier: 'bypass', duration_mode: 'range', duration_min: 5, duration_max: 15,
      max_images: 4, max_videos: 3, max_audios: 1, expensive_bypass: true,
    },
  },
]

test('normalizes project routing and detects only material project-route changes', () => {
  const policy = {
    video_routing_mode: 'fixed',
    video_model: 'balanced-video',
    video_group: '特价视频分组(即梦)',
    video_quality: 'balanced',
    video_config_id: 17,
    video_model_overrides: { 5: 'other-video' },
  }
  assert.deepEqual(projectVideoRoutingState(policy), {
    mode: 'fixed', model: 'balanced-video', group: '特价视频分组(即梦)', quality: 'balanced',
    configId: 17,
  })
  assert.equal(projectVideoRoutingChanged(policy, {
    video_routing_mode: 'fixed', video_model: 'balanced-video', video_group: '特价视频分组(即梦)', video_quality: 'balanced', video_config_id: 17,
  }), false)
  assert.equal(projectVideoRoutingChanged(policy, {
    video_routing_mode: 'fixed', video_model: 'balanced-video', video_group: '特价视频分组(即梦)', video_quality: 'balanced', video_config_id: 18,
  }), true)
  assert.equal(projectVideoRoutingChanged(policy, {
    video_routing_mode: 'auto', video_model: 'balanced-video', video_group: '特价视频分组(即梦)', video_quality: 'balanced',
  }), true)
})

test('does not show the persisted model while a switched config is unavailable', () => {
  assert.equal(projectVideoModelDisplay({
    settingsVisible: true,
    draft: { video_config_id: 14, video_routing_mode: 'auto', video_model: '' },
    activePolicy: { video_config_id: 12 },
    currentModel: 'old-video-model',
    catalogConfigId: 14,
    catalog: [],
    catalogError: 'model discovery failed',
  }), '尚未选择（保存前需读取模型目录）')
  assert.equal(projectVideoModelDisplay({
    settingsVisible: true,
    draft: { video_config_id: 14, video_routing_mode: 'auto', video_model: '' },
    activePolicy: { video_config_id: 12 },
    currentModel: 'old-video-model',
    catalogConfigId: 14,
    catalog: [{ model: 'new-video' }],
  }), '按镜头自动选择（保存后生效）')
  assert.equal(projectVideoModelDisplay({
    settingsVisible: true,
    draft: { video_config_id: 14, video_routing_mode: 'fixed', video_model: 'new-video' },
    activePolicy: { video_config_id: 12 },
    currentModel: 'old-video-model',
    catalogConfigId: 14,
    catalog: [{ model: 'new-video' }],
  }), 'new-video')
})

test('builds a redacted atomic project-routing payload and clears fixed model in auto mode', () => {
  const fixed = buildProjectVideoRoutingPayload({
    video_routing_mode: 'fixed', video_model: ' balanced-video ', video_group: '视频模型渠道', video_quality: 'quality', video_config_id: 23, api_key: 'secret',
  }, { shotId: 5, expectedVersion: 8091, confirmExpensive: true })
  assert.deepEqual(fixed, {
    scope: 'run', shot_id: '5', mode: 'fixed', model: 'balanced-video', group: '视频模型渠道',
    quality: 'quality', config_id: 23, confirm_expensive: true, expected_version: 8091,
  })
  assert.equal(Object.hasOwn(fixed, 'api_key'), false)

  const automatic = buildProjectVideoRoutingPayload({
    video_routing_mode: 'auto', video_model: 'balanced-video', video_group: '特价视频分组(即梦)', video_quality: 'economy',
  }, { expectedVersion: 3 })
  assert.equal(automatic.model, '')
  assert.equal(automatic.mode, 'auto')
})

test('maps live group, capability and expensive warnings for manual model selection', () => {
  assert.deepEqual(videoGroupsFromCatalog(catalog), ['视频模型渠道', '特价视频分组(即梦)'])
  const option = catalogModelOption(catalog, 'balanced-video', '特价视频分组(即梦)')
  assert.equal(option.selectable, true)
  assert.equal(option.unit_price, 0.02)
  assert.equal(modelMediaLabel(option), '4 图 · 3 视频 · 1 音频')

  const unavailable = catalogModelOption(catalog, 'bypass-video', '特价视频分组(即梦)')
  assert.equal(unavailable.selectable, true)
  assert.equal(unavailable.group_available, false)
  assert.match(unavailable.incompatibility_reason, /尚未确认/)
  assert.equal(unavailable.requires_explicit_confirmation, true)

  const unregistered = catalogModelOption(catalog, 'new-upstream-video', '特价视频分组(即梦)')
  assert.equal(unregistered.selectable, true)
  assert.equal(unregistered.catalog_verified, false)
  assert.equal(unregistered.contract_status, 'missing')
  assert.deepEqual(unregistered.limits, { images: null, videos: null, audios: null })
  assert.ok(unregistered.warnings.includes('model_not_in_catalog'))
})

test('labels local capability hints without turning them into a manual gate', () => {
  const option = catalogModelOption([{
    model: 'local-video',
    groups: ['特价视频分组(即梦)'],
    contract_status: 'local',
    capability_source: 'local',
    capabilities: {
      resolution: '720p', quality_tier: 'balanced', duration_mode: 'range', duration_min: 5, duration_max: 15,
      max_images: 30, max_videos: 10, max_audios: 10,
    },
  }], 'local-video', '特价视频分组(即梦)')
  assert.equal(option.selectable, true)
  assert.equal(option.contract_status, 'local')
  assert.deepEqual(option.limits, { images: 30, videos: 10, audios: 10 })
  assert.ok(!option.warnings.includes('unknown_contract'))
})

test('never presents an incompatible or unestimated model as free', () => {
  assert.equal(modelPriceLabel({ estimated_price: null, unit_price: null }), '价格待目录刷新')
  assert.equal(modelPriceLabel({
    estimated_price: null,
    unit_price: 0.1125,
    billing_unit: 'per_request',
  }), '0.1125 / 次')
  assert.equal(modelPriceLabel({
    estimated_price: 1.4312,
    unit_price: 0.20475,
    billing_unit: 'per_second',
    currency: 'CNY',
  }), '本镜预计 ¥1.4312')
  assert.equal(modelPriceLabel({
    estimated_price: null,
    unit_price: 0.1125,
    billing_unit: 'per_request',
    currency: 'USD',
  }), '$0.1125 / 次')
})

test('builds a shot routing payload that can explicitly omit director media', () => {
  const routing = {
    run_version: 8507,
    project: { director_mode: 'auto', config_id: 17 },
    shot: { id: '6', mode: 'inherit', model: '' },
    effective_route: { model: 'balanced-video', previs_mode: 'auto' },
  }
  assert.equal(shotVideoPrevisMode(routing), 'auto')
  assert.deepEqual(buildShotVideoRoutingPayload(routing, {
    mode: 'fixed', model: ' balanced-video ', previs_mode: 'skip',
  }), {
    scope: 'shot', shot_id: '6', config_id: 17, mode: 'fixed', model: 'balanced-video', previs_mode: 'skip',
    authorize_retry: false, retry_reason: '', confirm_expensive: false, expected_version: 8507,
  })
})

test('global director off forces the shot payload to skip', () => {
  const routing = {
    run_version: 4,
    project: { director_mode: 'off' },
    shot: { id: '2', mode: 'inherit', model: '' },
    effective_route: { model: 'balanced-video', previs_mode: 'auto' },
  }
  assert.equal(shotVideoPrevisMode(routing), 'skip')
  assert.equal(buildShotVideoRoutingPayload(routing, { previs_mode: 'force' }).previs_mode, 'skip')
})
