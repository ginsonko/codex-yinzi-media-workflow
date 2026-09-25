const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { callYinziVideoApi, buildProviderConfigSnapshot, resolveYinziCapabilityContext } = require('../src/services/videoClient');
const aiConfigService = require('../src/services/aiConfigService');
const { getYinziVideoCapability } = require('../src/services/yinziVideoCapabilities');

const log = { info() {}, warn() {}, error() {} };
const config = { id: 9, provider: 'yinzi', api_protocol: 'yinzi', base_url: 'https://provider.test/v1', api_key: 'test-only', endpoint: '/videos' };
const image = (name) => `https://media.test/${name}.png`;
const referenceContract = {
  roles: { image: ['reference'], video: ['reference'], audio: ['reference'] },
  reference_template: '@{type}{index}',
  each_reference_must_be_mentioned: true,
};

async function submit(options, selectedConfig = config, upstream = null) {
  const prior = global.fetch;
  const posts = [];
  global.fetch = async (url, init) => {
    assert.equal(init.method, 'POST');
    posts.push({ url, body: JSON.parse(init.body) });
    if (upstream) return upstream();
    return new Response(JSON.stringify({ id: 'mock-task', status: 'queued' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await callYinziVideoApi(null, selectedConfig, log, {
      model: 'test-route', prompt: '角色走向镜头。', duration: 8, ...options,
    });
    return { result, posts, body: posts[0]?.body };
  } finally { global.fetch = prior; }
}

describe('Yinzi final reference contract adaptation', () => {
  it('shares the exact recorded Seedance 2.5 reference rules without family-wide inference', async () => {
    const { getProfile } = await import('../src/services/promptAdapter/profiles.mjs');
    const profile = getProfile('Seedance 2.5');
    const capability = getYinziVideoCapability('Seedance 2.5');
    assert.equal(capability.roles, profile.roles);
    assert.equal(capability.reference_template, profile.reference_template);
    assert.equal(capability.each_reference_must_be_mentioned, true);
    assert.equal(getYinziVideoCapability('Seedance 2.5-720').each_reference_must_be_mentioned, undefined);
    assert.equal(getYinziVideoCapability('seedance-2.5-720p').each_reference_must_be_mentioned, undefined);
    assert.equal(getYinziVideoCapability('another-seedance-2.5-route'), null);
    const { result, body, posts } = await submit({
      model: 'Seedance 2.5', first_frame_url: image('start'), last_frame_url: image('end'),
    });
    assert.equal(posts.length, 1);
    assert.deepEqual(body.references.map((ref) => ref.role), ['reference', 'reference']);
    assert.deepEqual(body.references.map((ref) => ref.url), [image('start'), image('end')]);
    assert.match(body.prompt, /开场画面以 @图片1 为参考。/);
    assert.match(body.prompt, /收尾画面以 @图片2 为参考。/);
    assert.equal(body.model, 'Seedance 2.5');
    assert.equal(body.duration, 8);
    assert.equal(result.contract_validation.submitted_prompt, body.prompt);
    assert.equal(result.contract_validation.catalog_verified, false);
  });

  it('retains generic input slots and reuses a frame alias without uploading it twice', async () => {
    const { result, body } = await submit({
      prompt: '@图片1 的角色走向 @图片2 中的背景。',
      reference_urls: [image('actor'), image('scene')],
      first_frame_url: image('actor'), last_frame_url: image('end'),
      capability_context: { capability: referenceContract },
    });
    assert.deepEqual(body.references.map((ref) => ref.url), [image('actor'), image('scene'), image('end')]);
    assert.ok(body.prompt.startsWith('@图片1 的角色走向 @图片2 中的背景。'));
    assert.match(body.prompt, /开场画面以 @图片1 为参考。/);
    assert.match(body.prompt, /收尾画面以 @图片3 为参考。/);
    const bindings = result.contract_validation.reference_bindings;
    assert.deepEqual(bindings.map((binding) => binding.input_index), [1, 2, null]);
    assert.deepEqual(bindings.map((binding) => binding.requested_roles), [['first_frame'], [], ['last_frame']]);
    assert.equal(JSON.stringify(bindings).includes('media.test'), false);
  });

  it('keeps repeated explicit image, video, and audio slots and independent media numbering', async () => {
    const { body } = await submit({
      prompt: 'Use @图片3 and @视频2 and @音频2.',
      reference_urls: [image('a'), image('a'), image('b')],
      reference_video_urls: ['https://media.test/a.mp4', 'https://media.test/a.mp4'],
      reference_audio_urls: ['https://media.test/a.mp3', 'https://media.test/a.mp3'],
      capability_context: { capability: referenceContract },
    });
    assert.equal(body.references.length, 7);
    assert.deepEqual(body.references.slice(0, 3).map((ref) => ref.url), [image('a'), image('a'), image('b')]);
    for (const marker of ['@图片1', '@图片2', '@图片3', '@视频1', '@视频2', '@音频1', '@音频2']) {
      assert.ok(body.prompt.includes(marker), marker);
    }
  });

  it('retains explicit frame order and remaps original generic markers to their actual image slots', async () => {
    const { body } = await submit({
      prompt: '@图片1保持角色身份，@图片2保持环境。',
      reference_urls: [image('actor'), image('scene')],
      first_frame_url: image('start'), last_frame_url: image('end'),
      capability_context: { capability: referenceContract },
    });
    assert.deepEqual(body.references.map((ref) => ref.url), [image('start'), image('actor'), image('scene'), image('end')]);
    assert.ok(body.prompt.startsWith('@图片2保持角色身份，@图片3保持环境。'));
    assert.match(body.prompt, /开场画面以 @图片1/);
    assert.match(body.prompt, /收尾画面以 @图片4/);
  });

  it('preserves strict roles in a dynamic contract and remaps generic markers atomically', async () => {
    const { result, body } = await submit({
      model: 'Seedance 2.5', prompt: '@图片1 对应主角，@图片2 对应背景。',
      first_frame_url: image('start'), last_frame_url: image('end'),
      reference_urls: [image('actor'), image('scene')],
      capability_context: { capability: { ...referenceContract, roles: { image: ['reference', 'first_frame', 'last_frame'] } } },
    });
    assert.deepEqual(body.references.map((ref) => ref.role), ['first_frame', 'reference', 'reference', 'last_frame']);
    assert.ok(body.prompt.startsWith('@图片2 对应主角，@图片3 对应背景。'));
    assert.doesNotMatch(body.prompt, /开场画面|收尾画面/);
    assert.ok(result.contract_validation.warnings.includes('reference_indices_remapped'));
  });

  it('keeps same-source first and last as explicit slots when no generic slot aliases them', async () => {
    const { body } = await submit({
      first_frame_url: image('same'), last_frame_url: image('same'),
      capability_context: { capability: referenceContract },
    });
    assert.equal(body.references.length, 2);
    assert.match(body.prompt, /开场画面以 @图片1/);
    assert.match(body.prompt, /收尾画面以 @图片2/);
  });

  it('does not treat @图片10 as a mention of @图片1 or duplicate a fully mentioned prompt', async () => {
    const originalPrompt = '让 @图片10 的角色移动。';
    const { body } = await submit({
      prompt: originalPrompt,
      reference_urls: Array.from({ length: 10 }, (_, index) => image(String(index))),
      capability_context: { capability: referenceContract },
    });
    assert.equal((body.prompt.match(/@图片10(?!\d)/g) || []).length, 1);
    assert.equal((body.prompt.match(/@图片1(?!\d)/g) || []).length, 1);
    const repeated = await submit({
      prompt: body.prompt,
      reference_urls: Array.from({ length: 10 }, (_, index) => image(String(index))),
      capability_context: { capability: referenceContract },
    });
    assert.equal(repeated.body.prompt, body.prompt);
  });

  it('honors custom templates and local overrides without catalog refresh, then freezes them', async () => {
    const override = aiConfigService.normalizeModelCapabilityOverride({
      reference_template: '[{type}{index}]', each_reference_must_be_mentioned: true,
      first_last_frame_supported: false,
    });
    const selectedConfig = { ...config, settings: { model_capability_overrides: { 'test-route': override } } };
    const { body } = await submit({ reference_urls: [image('one')] }, selectedConfig);
    assert.match(body.prompt, /\[图片1\]/);
    assert.doesNotMatch(body.prompt, /@图片/);
    const frozen = buildProviderConfigSnapshot(selectedConfig, 'test-route');
    assert.equal(frozen.capability_snapshot.reference_template, '[{type}{index}]');
    const changedConfig = { ...selectedConfig, settings: { model_capability_overrides: { 'test-route': { reference_template: '<{type}{index}>', each_reference_must_be_mentioned: false } } } };
    assert.equal(resolveYinziCapabilityContext(changedConfig, 'test-route', frozen).capability.reference_template, '[{type}{index}]');
  });

  it('keeps unknown routes unchanged and respects an explicit disabled marker rule', async () => {
    const originalPrompt = '请按原提示词生成。';
    const unknown = await submit({
      model: 'some-seedance-route', prompt: originalPrompt,
      first_frame_url: image('start'), reference_urls: [image('actor')], last_frame_url: image('end'),
    });
    assert.equal(unknown.body.prompt, originalPrompt);
    assert.deepEqual(unknown.body.references.map((ref) => ref.role), ['first_frame', 'reference', 'last_frame']);
    const disabled = await submit({
      model: 'Seedance 2.5', prompt: originalPrompt, reference_urls: [image('actor')],
      capability_context: { capability: { ...referenceContract, each_reference_must_be_mentioned: false } },
    });
    assert.equal(disabled.body.prompt, originalPrompt);
  });

  it('preserves frame semantics without guessing a marker syntax for historical routes', async () => {
    const { body } = await submit({
      model: 'Seedance 2.5-720', first_frame_url: image('start'), last_frame_url: image('end'),
    });
    assert.deepEqual(body.references.map((ref) => ref.role), ['reference', 'reference']);
    assert.match(body.prompt, /开场画面以 第 1 张参考图/);
    assert.match(body.prompt, /收尾画面以 第 2 张参考图/);
    assert.doesNotMatch(body.prompt, /@图片/);
  });

  it('warns after prompt adaptation exceeds a local hint without truncating or refusing', async () => {
    const { result, body, posts } = await submit({
      prompt: '短句', reference_urls: [image('actor')],
      capability_context: { capability: { ...referenceContract, max_prompt_chars: 3 } },
    });
    assert.equal(posts.length, 1);
    assert.ok(body.prompt.startsWith('短句'));
    assert.match(body.prompt, /@图片1/);
    assert.ok(result.contract_validation.warnings.includes('prompt_over_contract'));
  });

  it('keeps malformed marker metadata advisory and never replays an ambiguous submission', async () => {
    const { result, posts, body } = await submit({
      first_frame_url: image('start'),
      capability_context: { capability: { ...referenceContract, reference_template: '@missing-index' } },
    }, config, () => { throw new Error('mock socket closed after POST'); });
    assert.equal(posts.length, 1);
    assert.equal(result.submission_status, 'ambiguous');
    assert.ok(result.contract_validation.warnings.includes('reference_template_invalid'));
    assert.match(body.prompt, /开场画面以 第 1 张参考图/);
  });
});
