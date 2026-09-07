const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createFallbackDirectorDocument,
  directorPrompts,
  normalizeDirectorDocument,
} = require('../src/services/productionDirector');
const {
  MAX_RECIPE_NODES,
  listDirectorAssets,
  normalizeRecipe,
} = require('../src/services/productionDirectorAssets');

test('normalizes legacy cameras to the principal character target', () => {
  const document = normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { fov: 42 } },
      { id: 'floor', kind: 'plane' },
      { id: 'actor', kind: 'character' },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5);
  const camera = document.objects.find((object) => object.id === 'camera');
  assert.equal(camera.props.aim_mode, 'target');
  assert.equal(camera.props.target_id, 'actor');
  assert.deepEqual(camera.props.target_offset, [0, 1.1, 0]);
});

test('fallback and AI prompt carry explicit composition and transparent-material contracts', () => {
  const fallback = createFallbackDirectorDocument({
    duration: 5,
    character_names: ['Actor'],
    prop_names: [],
  });
  const camera = fallback.objects.find((object) => object.id === fallback.active_camera_id);
  assert.equal(camera.props.aim_mode, 'target');
  assert.equal(camera.props.target_id, 'character-1');

  const prompts = directorPrompts({ duration: 5 }, [], '16:9');
  assert.match(prompts.system, /target_id/);
  assert.match(prompts.system, /opacity/);
  assert.match(prompts.system, /wireframe/);
  assert.match(prompts.system, /human\.adult\.female/);
  assert.match(prompts.system, /kind=procedural/);
  assert.match(prompts.system, /MUST NEVER be written to props\.asset_id/);
});

test('director prompt carries stable asset authority and shared material context', () => {
  const prompts = directorPrompts({
    duration: 5,
    character_ids: ['character-1'],
    scene_id: 'scene-1',
  }, [{
    artifact_id: 21,
    scope_id: 'character-1',
    type: 'character',
    name: '猫娘',
    source_artifact_id: 9,
    authority: 'uploaded_asset',
    authority_subject_id: 'subject-cat',
    identity_anchors: ['猫耳', '棕色长发'],
  }], '16:9', {
    material_context: JSON.stringify({
      subjects: [{ id: 'subject-cat', target_scope: 'character-1', source_artifact_id: 9, authority: 'uploaded_asset' }],
      assets: [{ id: 'asset-cat', artifact_id: 9, target_scope: 'character-1', role: 'primary_subject_reference' }],
    }),
  });
  assert.match(prompts.user, /source_artifact_id/);
  assert.match(prompts.user, /subject-cat/);
  assert.match(prompts.user, /uploaded_asset/);
  assert.match(prompts.user, /不得另造或替换主体/);
  assert.match(prompts.user, /猫娘/);
});

test('locks every director camera to the production aspect ratio', () => {
  const fallback = createFallbackDirectorDocument({
    duration: 5,
    character_names: ['Actor'],
  }, '9:16');
  assert.equal(fallback.aspect_ratio, '9:16');
  assert.equal(
    fallback.objects.find((object) => object.id === fallback.active_camera_id).props.aspect,
    9 / 16
  );

  const normalized = normalizeDirectorDocument({
    aspect_ratio: '16:9',
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { aspect: 16 / 9 } },
      { id: 'actor', kind: 'character' },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5, '1:1');
  assert.equal(normalized.aspect_ratio, '1:1');
  assert.equal(normalized.objects[0].props.aspect, 1);

  const prompts = directorPrompts({ duration: 5 }, [], '9:16');
  assert.match(prompts.system, /"aspect_ratio":"9:16"/);
  assert.match(prompts.system, /Every camera props\.aspect must equal 0\.5625/);
  assert.match(prompts.user, /目标画幅 9:16/);
});

test('director catalog exposes six age-and-gender human profiles and common assets', () => {
  const catalog = listDirectorAssets();
  const people = catalog.filter((asset) => asset.category === 'people');
  assert.deepEqual(people.map((asset) => asset.id), [
    'human.child.male',
    'human.child.female',
    'human.adult.male',
    'human.adult.female',
    'human.senior.male',
    'human.senior.female',
  ]);
  assert.ok(catalog.some((asset) => asset.id === 'environment.indoor_room'));
  assert.ok(catalog.some((asset) => asset.id === 'furniture.chair'));
  assert.ok(catalog.some((asset) => asset.id === 'prop.console'));
  assert.ok(people.every((asset) => asset.license === 'CC0-1.0' && asset.default_props.model_url.endsWith('.glb')));
});

test('normalizes catalog assets and rejects unknown asset identifiers', () => {
  const document = normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: {} },
      { id: 'actor', kind: 'asset', props: { asset_id: 'human.child.female', motion: 'wave' } },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5);
  const actor = document.objects.find((object) => object.id === 'actor');
  assert.equal(actor.kind, 'character');
  assert.equal(actor.props.asset_id, 'human.child.female');
  assert.equal(actor.props.motion, 'wave');
  assert.equal(actor.props.model_url, '/director-assets/kenney/character-e.glb');
  assert.deepEqual(document.objects[0].props.target_offset, [0, actor.props.focus_height, 0]);

  assert.throws(() => normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera' },
      { id: 'bad', kind: 'asset', props: { asset_id: 'invented.object' } },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5), /未知导演台素材/);
});

test('degrades workflow external reference ids to honest procedural placeholders', () => {
  const document = normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: {} },
      {
        id: 'actor', kind: 'character', name: 'Uploaded heroine reference',
        props: { asset_id: 'asset-6cf48daa07ead57c', profile_id: 'human.adult.female', motion: 'wave' },
      },
      {
        id: 'garden-anchor', kind: 'asset', name: 'Uploaded garden reference',
        props: { asset_id: 'subject-garden-001' },
      },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5);
  const actor = document.objects.find((object) => object.id === 'actor');
  const garden = document.objects.find((object) => object.id === 'garden-anchor');
  assert.equal(actor.kind, 'character');
  assert.equal(actor.props.asset_id, 'human.procedural');
  assert.equal(actor.props.external_reference_asset_id, 'asset-6cf48daa07ead57c');
  assert.equal(actor.props.external_reference_role, 'identity_reference');
  assert.equal(actor.props.model_url, undefined);
  assert.equal(garden.kind, 'procedural');
  assert.equal(garden.props.asset_id, 'procedural');
  assert.equal(garden.props.external_reference_asset_id, 'subject-garden-001');
  assert.ok(garden.props.recipe.nodes.length > 0);

  assert.throws(() => normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera' },
      { id: 'bad', kind: 'asset', props: { asset_id: 'invented.object' } },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5), /未知导演台素材/);
});

test('accepts a frontend-resaved legacy procedural character without changing its profile', () => {
  const document = normalizeDirectorDocument({
    version: 2,
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: {} },
      {
        id: 'actor',
        kind: 'character',
        props: {
          asset_id: 'human.procedural',
          profile_id: 'human.adult.female',
          color: '#eceff1',
          trousers_color: '#dce4e5',
          target_height: 2.1,
          width_scale: 1.2,
          pose: 'point',
          motion: 'wave',
          focus_height: 1.23,
          asset_label: 'Silver heroine rig',
          asset_category: 'props',
          asset_license: 'Untrusted external license',
          asset_source: 'https://untrusted.example/model',
          model_url: 'https://untrusted.example/model.glb',
        },
      },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5);

  const actor = document.objects.find((object) => object.id === 'actor');
  const camera = document.objects.find((object) => object.id === 'camera');
  assert.equal(actor.kind, 'character');
  assert.equal(actor.props.asset_id, 'human.procedural');
  assert.equal(actor.props.profile_id, 'human.adult.female');
  assert.equal(actor.props.color, '#eceff1');
  assert.equal(actor.props.trousers_color, '#dce4e5');
  assert.equal(actor.props.target_height, 2.1);
  assert.equal(actor.props.width_scale, 1.2);
  assert.equal(actor.props.pose, 'point');
  assert.equal(actor.props.motion, 'wave');
  assert.equal(actor.props.focus_height, 1.23);
  assert.equal(actor.props.asset_label, 'Silver heroine rig');
  assert.equal(actor.props.asset_category, 'people');
  assert.equal(actor.props.asset_license, 'Project-native');
  assert.equal(actor.props.asset_source, 'Built-in procedural rig');
  assert.equal(actor.props.model_url, undefined);
  assert.deepEqual(camera.props.target_offset, [0, 1.23, 0]);

  const twice = normalizeDirectorDocument(document, 5);
  assert.deepEqual(twice, document);
});

test('normalized procedural objects remain valid when approval normalizes them again', () => {
  const input = {
    version: 2,
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: {} },
      {
        id: 'bridge',
        kind: 'procedural',
        props: {
          recipe: {
            label: 'Bounded bridge',
            nodes: [{ shape: 'box', position: [0, 0.2, 0], scale: [1, 0.2, 4] }],
          },
        },
      },
    ],
    timeline: { duration: 5, keyframes: [] },
  };

  const once = normalizeDirectorDocument(input, 5);
  const twice = normalizeDirectorDocument(once, 5);
  const bridge = twice.objects.find((object) => object.id === 'bridge');

  assert.equal(bridge.kind, 'procedural');
  assert.equal(bridge.props.asset_id, 'procedural');
  assert.equal(bridge.props.recipe.nodes.length, 1);
  assert.equal(bridge.props.recipe.nodes[0].shape, 'box');
});

test('bounds declarative procedural recipes and drops unsupported geometry', () => {
  const recipe = normalizeRecipe({
    label: 'Generated console',
    nodes: [
      { shape: 'script', scale: [999, 999, 999] },
      ...Array.from({ length: MAX_RECIPE_NODES + 10 }, () => ({
        shape: 'box', position: [999, -999, 0], scale: [0, 100, 1],
      })),
    ],
  });
  assert.equal(recipe.nodes.length, MAX_RECIPE_NODES - 1);
  assert.deepEqual(recipe.nodes[0].position, [30, -30, 0]);
  assert.deepEqual(recipe.nodes[0].scale, [0.02, 30, 1]);
  assert.throws(() => normalizeRecipe({ nodes: [{ shape: 'javascript' }] }), /至少一个支持的几何节点/);
});

test('normalizes hand attachments and preserves local-only keyframes', () => {
  const document = normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { aim_mode: 'rotation' } },
      { id: 'actor', kind: 'character', props: { profile_id: 'human.adult.female' } },
      {
        id: 'sword', kind: 'procedural',
        props: {
          attach_to: 'actor', attach_anchor: 'right_hand', local_offset: [0, 0.1, 0],
          local_rotation: [0, 1, 0], recipe: { nodes: [{ shape: 'box' }] },
        },
      },
    ],
    timeline: {
      duration: 6,
      keyframes: [
        { object_id: 'actor', time: 0, position: [0, 0, 0] },
        { object_id: 'sword', time: 0, local_scale: [1, 1, 1] },
        { object_id: 'sword', time: 2, local_scale: [0.01, 0.01, 0.01] },
      ],
    },
  }, 6);
  const sword = document.objects.find((object) => object.id === 'sword');
  assert.equal(sword.props.attach_to, 'actor');
  assert.equal(sword.props.attach_anchor, 'right_hand');
  assert.deepEqual(sword.props.local_offset, [0, 0.1, 0]);
  assert.deepEqual(document.timeline.keyframes.filter((frame) => frame.object_id === 'sword')[0].local_scale, [1, 1, 1]);
  assert.equal(Object.hasOwn(document.timeline.keyframes[1], 'position'), false);
});

test('hard-fails invalid attachment parents, cycles, and world tracks', () => {
  const base = (objects, keyframes = []) => normalizeDirectorDocument({
    active_camera_id: 'camera', objects: [{ id: 'camera', kind: 'camera', props: { aim_mode: 'rotation' } }, ...objects],
    timeline: { duration: 5, keyframes },
  }, 5);
  assert.throws(() => base([{ id: 'prop', kind: 'procedural', props: { attach_to: 'missing', recipe: { nodes: [{ shape: 'box' }] } } }]), /parent does not exist/);
  assert.throws(() => base([
    { id: 'a', kind: 'procedural', props: { attach_to: 'b', recipe: { nodes: [{ shape: 'box' }] } } },
    { id: 'b', kind: 'procedural', props: { attach_to: 'a', recipe: { nodes: [{ shape: 'box' }] } } },
  ]), /cycle detected/);
  assert.throws(() => base([
    { id: 'actor', kind: 'character', props: {} },
    { id: 'prop', kind: 'procedural', props: { attach_to: 'actor', attach_anchor: 'right_hand', recipe: { nodes: [{ shape: 'box' }] } } },
  ], [{ object_id: 'prop', time: 0, position: [1, 2, 3] }]), /world keyframes/);
  assert.throws(() => normalizeDirectorDocument({
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: {} },
      { id: 'prop', kind: 'procedural', props: { attach_to: 'camera', recipe: { nodes: [{ shape: 'box' }] } } },
    ],
    timeline: { duration: 5, keyframes: [] },
  }, 5), /cameras or lights/);
});

test('director prompt carries attachment and motivated-cut contracts', () => {
  const prompts = directorPrompts({ duration: 5 }, [], '16:9');
  assert.match(prompts.system, /attach_to/);
  assert.match(prompts.system, /local_offset\/local_rotation\/local_scale keyframes/);
  assert.match(prompts.system, /Never emit position, rotation, or scale on a keyframe for an attached object/);
  assert.match(prompts.system, /If static attachment is sufficient, omit that object from timeline\.keyframes/);
  assert.match(prompts.system, /complete camera shot/);
  assert.match(prompts.system, /hard_cut/);
  assert.match(prompts.system, /first_frame/);
});
