const MAX_RECIPE_NODES = 48;
const RECIPE_SHAPES = Object.freeze(['box', 'sphere', 'capsule', 'cylinder', 'cone', 'plane', 'torus']);
const RECIPE_SHAPE_SET = new Set(RECIPE_SHAPES);

const DIRECTOR_POSES = Object.freeze([
  { id: 'neutral', label: '自然站立' },
  { id: 'sit', label: '坐姿' },
  { id: 'crouch', label: '蹲下' },
  { id: 'point', label: '指向' },
  { id: 'reach', label: '伸手' },
  { id: 'arms_crossed', label: '抱臂' },
  { id: 'look_up', label: '抬头' },
]);

const DIRECTOR_MOTIONS = Object.freeze([
  { id: 'none', label: '保持姿势' },
  { id: 'idle', label: '自然待机' },
  { id: 'walk', label: '行走' },
  { id: 'run', label: '奔跑' },
  { id: 'wave', label: '挥手' },
  { id: 'talk', label: '说话手势' },
  { id: 'turn', label: '转身观察' },
  { id: 'sit_down', label: '坐下' },
  { id: 'stand_up', label: '起身' },
  { id: 'push', label: '推物' },
  { id: 'carry', label: '搬运' },
]);

const POSE_IDS = new Set(DIRECTOR_POSES.map((item) => item.id));
const MOTION_IDS = new Set(DIRECTOR_MOTIONS.map((item) => item.id));

const KENNEY_SOURCE = 'https://kenney.nl/assets/blocky-characters';
const KENNEY_LICENSE = 'CC0-1.0';

function finite(value, fallback = 0, min = -100, max = 100) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function vec3(value, fallback, min = -30, max = 30) {
  const source = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((index) => finite(source[index], fallback[index], min, max));
}

function text(value, fallback = '', limit = 120) {
  return String(value == null ? fallback : value).trim().slice(0, limit);
}

function safeColor(value, fallback = '#7f8b91') {
  const candidate = text(value, fallback, 32);
  return /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(candidate) ? candidate : fallback;
}

function normalizeRecipeMaterial(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    color: safeColor(input.color, '#7f8b91'),
    opacity: finite(input.opacity, 1, 0.05, 1),
    roughness: finite(input.roughness, 0.72, 0, 1),
    metalness: finite(input.metalness, 0.08, 0, 1),
    emissive: safeColor(input.emissive, '#000000'),
    emissive_intensity: finite(input.emissive_intensity, 0, 0, 12),
    wireframe: input.wireframe === true,
  };
}

function normalizeRecipeNode(value, index = 0) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const shape = text(input.shape, '', 24).toLowerCase();
  if (!RECIPE_SHAPE_SET.has(shape)) return null;
  return {
    id: text(input.id, `node-${index + 1}`, 64),
    shape,
    position: vec3(input.position, [0, 0, 0]),
    rotation: vec3(input.rotation, [0, 0, 0], -Math.PI * 4, Math.PI * 4),
    scale: vec3(input.scale, [1, 1, 1], 0.02, 30),
    material: normalizeRecipeMaterial(input.material),
  };
}

function normalizeRecipe(value, options = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const source = Array.isArray(input.nodes) ? input.nodes : [];
  const nodes = source
    .slice(0, MAX_RECIPE_NODES)
    .map(normalizeRecipeNode)
    .filter(Boolean);
  if (!nodes.length && options.allowEmpty !== true) {
    const error = new Error('程序化模型必须包含至少一个支持的几何节点');
    error.code = 'DIRECTOR_RECIPE_INVALID';
    throw error;
  }
  return {
    label: text(input.label, '程序化模型', 100),
    nodes,
  };
}

function recipe(label, nodes) {
  return normalizeRecipe({ label, nodes });
}

function node(shape, position, scale, color, extra = {}) {
  return {
    shape,
    position,
    rotation: extra.rotation || [0, 0, 0],
    scale,
    material: {
      color,
      roughness: extra.roughness == null ? 0.72 : extra.roughness,
      metalness: extra.metalness == null ? 0.08 : extra.metalness,
      opacity: extra.opacity == null ? 1 : extra.opacity,
      emissive: extra.emissive || '#000000',
      emissive_intensity: extra.emissive_intensity || 0,
      wireframe: extra.wireframe === true,
    },
  };
}

function humanAsset({ id, label, model, preview, age, gender, height, width }) {
  return {
    id,
    label,
    category: 'people',
    kind: 'character',
    source: 'Kenney Blocky Characters 2.0',
    source_url: KENNEY_SOURCE,
    license: KENNEY_LICENSE,
    preview_url: `/director-assets/kenney/${preview}`,
    default_props: {
      asset_id: id,
      profile_id: id,
      model_url: `/director-assets/kenney/${model}`,
      age,
      gender,
      target_height: height,
      width_scale: width,
      focus_height: Number((height * 0.72).toFixed(3)),
      pose: 'neutral',
      motion: 'idle',
      motion_speed: 1,
      motion_phase: 0,
      motion_intensity: 1,
    },
  };
}

function proceduralAsset(id, label, category, modelRecipe, options = {}) {
  return {
    id,
    label,
    category,
    kind: 'asset',
    source: 'Built-in procedural pack',
    source_url: null,
    license: 'Project-native',
    preview_url: null,
    default_props: {
      asset_id: id,
      focus_height: finite(options.focus_height, 0.5, 0, 20),
      recipe: normalizeRecipe(modelRecipe),
    },
    default_position: vec3(options.default_position, [0, 0, 0]),
  };
}

const DIRECTOR_ASSETS = Object.freeze([
  humanAsset({ id: 'human.child.male', label: '儿童男孩', model: 'character-k.glb', preview: 'character-k.png', age: 'child', gender: 'male', height: 1.38, width: 0.9 }),
  humanAsset({ id: 'human.child.female', label: '儿童女孩', model: 'character-e.glb', preview: 'character-e.png', age: 'child', gender: 'female', height: 1.34, width: 0.88 }),
  humanAsset({ id: 'human.adult.male', label: '成年男性', model: 'character-b.glb', preview: 'character-b.png', age: 'adult', gender: 'male', height: 1.78, width: 1.02 }),
  humanAsset({ id: 'human.adult.female', label: '成年女性', model: 'character-f.glb', preview: 'character-f.png', age: 'adult', gender: 'female', height: 1.68, width: 0.94 }),
  humanAsset({ id: 'human.senior.male', label: '老年男性', model: 'character-c.glb', preview: 'character-c.png', age: 'senior', gender: 'male', height: 1.7, width: 1 }),
  humanAsset({ id: 'human.senior.female', label: '老年女性', model: 'character-i.glb', preview: 'character-i.png', age: 'senior', gender: 'female', height: 1.62, width: 0.94 }),

  proceduralAsset('environment.flat_stage', '通用平地', 'environments', recipe('通用平地', [
    node('plane', [0, 0, 0], [12, 12, 1], '#758078', { rotation: [-Math.PI / 2, 0, 0] }),
  ]), { focus_height: 0 }),
  proceduralAsset('environment.indoor_room', '简洁室内', 'environments', recipe('简洁室内', [
    node('plane', [0, 0, 0], [10, 8, 1], '#73797c', { rotation: [-Math.PI / 2, 0, 0] }),
    node('box', [0, 2.5, -4], [10, 5, 0.16], '#aeb5b5'),
    node('box', [-5, 2.5, 0], [0.16, 5, 8], '#969fa1'),
    node('box', [5, 2.5, 0], [0.16, 5, 8], '#969fa1'),
  ]), { focus_height: 1.2 }),
  proceduralAsset('environment.grassland', '草原', 'environments', recipe('草原', [
    node('plane', [0, 0, 0], [14, 14, 1], '#4f8c54', { rotation: [-Math.PI / 2, 0, 0] }),
    node('cylinder', [-4, 1, -4], [0.35, 2, 0.35], '#75553a'),
    node('cone', [-4, 3.1, -4], [1.4, 2.5, 1.4], '#2f6f45'),
    node('cylinder', [4, 0.8, -3], [0.28, 1.6, 0.28], '#75553a'),
    node('cone', [4, 2.7, -3], [1.2, 2.3, 1.2], '#397c4d'),
  ]), { focus_height: 1 }),
  proceduralAsset('environment.platform', '圆形平台', 'environments', recipe('圆形平台', [
    node('cylinder', [0, 0.3, 0], [3.2, 0.6, 3.2], '#7d858c', { metalness: 0.28 }),
    node('cylinder', [0, 0.65, 0], [2.85, 0.12, 2.85], '#a8b4b9', { metalness: 0.38 }),
  ]), { focus_height: 0.7 }),
  proceduralAsset('environment.corridor', '走廊', 'environments', recipe('走廊', [
    node('plane', [0, 0, 0], [5, 14, 1], '#626b70', { rotation: [-Math.PI / 2, 0, 0] }),
    node('box', [-2.5, 2.3, -1], [0.14, 4.6, 14], '#8d9799'),
    node('box', [2.5, 2.3, -1], [0.14, 4.6, 14], '#8d9799'),
  ]), { focus_height: 1.1 }),

  proceduralAsset('furniture.table', '桌子', 'furniture', recipe('桌子', [
    node('box', [0, 0.78, 0], [2.2, 0.14, 1.2], '#8a5a37'),
    node('box', [-0.88, 0.38, -0.4], [0.14, 0.76, 0.14], '#65402b'),
    node('box', [0.88, 0.38, -0.4], [0.14, 0.76, 0.14], '#65402b'),
    node('box', [-0.88, 0.38, 0.4], [0.14, 0.76, 0.14], '#65402b'),
    node('box', [0.88, 0.38, 0.4], [0.14, 0.76, 0.14], '#65402b'),
  ]), { focus_height: 0.78 }),
  proceduralAsset('furniture.chair', '椅子', 'furniture', recipe('椅子', [
    node('box', [0, 0.52, 0], [0.9, 0.12, 0.9], '#6d88a0'),
    node('box', [0, 1.05, -0.39], [0.9, 1, 0.12], '#5f7c94'),
    node('box', [-0.34, 0.25, -0.34], [0.12, 0.5, 0.12], '#4e6475'),
    node('box', [0.34, 0.25, -0.34], [0.12, 0.5, 0.12], '#4e6475'),
    node('box', [-0.34, 0.25, 0.34], [0.12, 0.5, 0.12], '#4e6475'),
    node('box', [0.34, 0.25, 0.34], [0.12, 0.5, 0.12], '#4e6475'),
  ]), { focus_height: 0.72 }),
  proceduralAsset('furniture.stool', '圆凳', 'furniture', recipe('圆凳', [
    node('cylinder', [0, 0.52, 0], [0.62, 0.14, 0.62], '#b97847'),
    node('cylinder', [0, 0.25, 0], [0.14, 0.5, 0.14], '#6a4c39'),
    node('cylinder', [0, 0.05, 0], [0.48, 0.1, 0.48], '#6a4c39'),
  ]), { focus_height: 0.55 }),
  proceduralAsset('furniture.sofa', '沙发', 'furniture', recipe('沙发', [
    node('box', [0, 0.38, 0], [2.6, 0.5, 0.95], '#617f88'),
    node('box', [0, 0.92, -0.36], [2.6, 0.85, 0.24], '#6f919a'),
    node('box', [-1.2, 0.68, 0], [0.24, 0.65, 0.95], '#547078'),
    node('box', [1.2, 0.68, 0], [0.24, 0.65, 0.95], '#547078'),
  ]), { focus_height: 0.8 }),
  proceduralAsset('furniture.bed', '床', 'furniture', recipe('床', [
    node('box', [0, 0.38, 0], [2.2, 0.42, 3.6], '#6b5849'),
    node('box', [0, 0.64, 0], [2.05, 0.24, 3.42], '#d2d6d1'),
    node('box', [0, 1.05, -1.72], [2.2, 1.3, 0.16], '#725b49'),
  ]), { focus_height: 0.7 }),
  proceduralAsset('furniture.shelf', '置物架', 'furniture', recipe('置物架', [
    node('box', [-0.92, 1.3, 0], [0.14, 2.6, 0.7], '#6d513a'),
    node('box', [0.92, 1.3, 0], [0.14, 2.6, 0.7], '#6d513a'),
    node('box', [0, 0.12, 0], [2, 0.16, 0.7], '#8a684b'),
    node('box', [0, 0.88, 0], [2, 0.12, 0.7], '#8a684b'),
    node('box', [0, 1.65, 0], [2, 0.12, 0.7], '#8a684b'),
    node('box', [0, 2.45, 0], [2, 0.16, 0.7], '#8a684b'),
  ]), { focus_height: 1.3 }),

  proceduralAsset('prop.crate', '箱子', 'props', recipe('箱子', [
    node('box', [0, 0.5, 0], [1, 1, 1], '#9a6841'),
  ]), { focus_height: 0.5 }),
  proceduralAsset('prop.door', '门', 'props', recipe('门', [
    node('box', [0, 1.1, 0], [1.05, 2.2, 0.12], '#785238'),
    node('sphere', [0.38, 1.08, 0.09], [0.08, 0.08, 0.08], '#d3ad51', { metalness: 0.7 }),
  ]), { focus_height: 1.1 }),
  proceduralAsset('prop.stairs', '台阶', 'props', recipe('台阶', [
    node('box', [0, 0.15, 0.9], [2.4, 0.3, 0.8], '#858d91'),
    node('box', [0, 0.45, 0.3], [2.4, 0.6, 0.8], '#858d91'),
    node('box', [0, 0.75, -0.3], [2.4, 0.9, 0.8], '#858d91'),
    node('box', [0, 1.05, -0.9], [2.4, 1.2, 0.8], '#858d91'),
  ]), { focus_height: 0.8 }),
  proceduralAsset('prop.rock', '岩石', 'props', recipe('岩石', [
    node('sphere', [0, 0.42, 0], [1.2, 0.82, 0.92], '#686d6d', { roughness: 0.98 }),
  ]), { focus_height: 0.45 }),
  proceduralAsset('prop.tree', '树', 'props', recipe('树', [
    node('cylinder', [0, 1.25, 0], [0.38, 2.5, 0.38], '#735139'),
    node('cone', [0, 3.25, 0], [1.5, 2.8, 1.5], '#347349'),
  ]), { focus_height: 2.2 }),
  proceduralAsset('prop.console', '控制台', 'props', recipe('控制台', [
    node('box', [0, 0.55, 0], [2.2, 1.1, 0.72], '#4e5f69', { metalness: 0.35 }),
    node('box', [0, 1.08, -0.18], [1.9, 0.65, 0.12], '#213841', { emissive: '#4cc4da', emissive_intensity: 0.55 }),
    node('cylinder', [-0.55, 1.15, -0.27], [0.08, 0.08, 0.08], '#ffcc55', { emissive: '#ffb326', emissive_intensity: 1.2 }),
    node('cylinder', [0, 1.15, -0.27], [0.08, 0.08, 0.08], '#68e08e', { emissive: '#45c972', emissive_intensity: 1.2 }),
    node('cylinder', [0.55, 1.15, -0.27], [0.08, 0.08, 0.08], '#e66c6c', { emissive: '#d84c4c', emissive_intensity: 1.2 }),
  ]), { focus_height: 0.95 }),
  proceduralAsset('prop.lamp', '落地灯', 'props', recipe('落地灯', [
    node('cylinder', [0, 0.08, 0], [0.55, 0.16, 0.55], '#555e63', { metalness: 0.45 }),
    node('cylinder', [0, 1.35, 0], [0.09, 2.6, 0.09], '#6f7d83', { metalness: 0.55 }),
    node('cone', [0, 2.65, 0], [0.65, 0.85, 0.65], '#f0d6a1', { emissive: '#ffd77a', emissive_intensity: 0.8 }),
  ]), { focus_height: 2 }),
]);

const ASSET_BY_ID = new Map(DIRECTOR_ASSETS.map((asset) => [asset.id, asset]));

function getDirectorAsset(id) {
  return ASSET_BY_ID.get(String(id || '')) || null;
}

function listDirectorAssets() {
  return DIRECTOR_ASSETS.map((asset) => ({
    ...asset,
    default_props: {
      ...asset.default_props,
      ...(asset.default_props.recipe ? { recipe: normalizeRecipe(asset.default_props.recipe) } : {}),
    },
    default_position: [...(asset.default_position || [0, 0, 0])],
  }));
}

function canonicalAssetProps(asset, input = {}) {
  const incoming = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = {};
  for (const key of [
    'color', 'opacity', 'wireframe', 'roughness', 'metalness', 'reflective',
    'emissive', 'emissive_intensity', 'pose', 'motion', 'motion_speed',
    'motion_phase', 'motion_intensity', 'skin_tone', 'hair_color',
    'trousers_color', 'target_height', 'width_scale', 'focus_height',
    'attach_to', 'attach_anchor', 'local_offset', 'local_rotation', 'local_scale',
  ]) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) allowed[key] = incoming[key];
  }
  const props = {
    ...asset.default_props,
    ...allowed,
    asset_id: asset.id,
    asset_label: asset.label,
    asset_category: asset.category,
    asset_license: asset.license,
    asset_source: asset.source,
  };
  if (asset.kind === 'character') {
    const pose = text(props.pose, 'neutral', 32);
    const motion = text(props.motion, 'idle', 32);
    if (!POSE_IDS.has(pose)) throw new Error(`不支持的人物姿势：${pose}`);
    if (!MOTION_IDS.has(motion)) throw new Error(`不支持的人物动作：${motion}`);
    props.pose = pose;
    props.motion = motion;
    props.motion_speed = finite(props.motion_speed, 1, 0.1, 4);
    props.motion_phase = finite(props.motion_phase, 0, 0, 1);
    props.motion_intensity = finite(props.motion_intensity, 1, 0, 1.5);
    props.color = safeColor(props.color, '#3d7796');
    props.skin_tone = safeColor(props.skin_tone, '#d8a07c');
    props.hair_color = safeColor(props.hair_color, '#342b29');
    props.trousers_color = safeColor(props.trousers_color, '#34434e');
    props.target_height = finite(props.target_height, asset.default_props.target_height || 1.7, 0.6, 3);
    props.width_scale = finite(props.width_scale, asset.default_props.width_scale || 1, 0.5, 1.5);
    props.focus_height = finite(props.focus_height, asset.default_props.focus_height || 1.1, 0, 20);
  }
  if (props.recipe) props.recipe = normalizeRecipe(props.recipe);
  return props;
}

function compactAssetCatalogForPrompt() {
  return DIRECTOR_ASSETS.map((asset) => `${asset.id}=${asset.label}`).join(', ');
}

module.exports = {
  MAX_RECIPE_NODES,
  RECIPE_SHAPES,
  DIRECTOR_POSES,
  DIRECTOR_MOTIONS,
  POSE_IDS,
  MOTION_IDS,
  normalizeRecipeMaterial,
  normalizeRecipeNode,
  normalizeRecipe,
  getDirectorAsset,
  listDirectorAssets,
  canonicalAssetProps,
  compactAssetCatalogForPrompt,
};
