const { safeParseAIJSON } = require('../utils/safeJson');
const {
  DIRECTOR_MOTIONS,
  DIRECTOR_POSES,
  RECIPE_SHAPES,
  canonicalAssetProps,
  compactAssetCatalogForPrompt,
  getDirectorAsset,
  normalizeRecipe,
} = require('./productionDirectorAssets');
const {
  productionAspectPrompt,
  productionAspectSpec,
} = require('./productionAspectRatio');

const VERSION = 2;
const OBJECT_KINDS = new Set(['character', 'asset', 'procedural', 'box', 'sphere', 'plane', 'light', 'camera']);
const ATTACH_ANCHORS = new Set(['root', 'head', 'left_hand', 'right_hand', 'left_forearm', 'right_forearm']);
const ATTACHMENT_VECTOR_LIMIT = 20;
const WORKFLOW_EXTERNAL_ASSET_ID = /^(?:asset|subject|artifact)-[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/i;

function finite(value, fallback = 0, min = -100, max = 100) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function vec3(value, fallback, min = -100, max = 100) {
  const source = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((index) => finite(source[index], fallback[index], min, max));
}

function strictAttachmentVec3(value, fallback, label, min = -ATTACHMENT_VECTOR_LIMIT, max = ATTACHMENT_VECTOR_LIMIT) {
  if (value == null) return [...fallback];
  if (!Array.isArray(value) || value.length < 3) throw new Error(`${label} must be a three-number array`);
  const numbers = value.slice(0, 3).map(Number);
  if (!numbers.every(Number.isFinite)) throw new Error(`${label} contains a non-finite number`);
  return numbers.map((number) => Math.min(max, Math.max(min, number)));
}

function normalizeAttachmentProps(incomingProps) {
  const props = { ...(incomingProps || {}) };
  const attachTo = String(props.attach_to || '').trim();
  if (!attachTo) {
    delete props.attach_to;
    delete props.attach_anchor;
    delete props.local_offset;
    delete props.local_rotation;
    delete props.local_scale;
    return props;
  }
  const anchor = String(props.attach_anchor || 'root').trim().toLowerCase();
  if (!ATTACH_ANCHORS.has(anchor)) throw new Error(`unsupported director attachment anchor: ${anchor}`);
  props.attach_to = attachTo.slice(0, 80);
  props.attach_anchor = anchor;
  props.local_offset = strictAttachmentVec3(props.local_offset, [0, 0, 0], 'local_offset');
  props.local_rotation = strictAttachmentVec3(props.local_rotation, [0, 0, 0], 'local_rotation', -Math.PI * 4, Math.PI * 4);
  props.local_scale = strictAttachmentVec3(props.local_scale, [1, 1, 1], 'local_scale', 0.01, 50);
  return props;
}

function normalizeProceduralCharacterProps(incomingProps) {
  const profileId = String(incomingProps.profile_id || 'human.adult.male').trim();
  const profile = getDirectorAsset(profileId);
  if (!profile || profile.category !== 'people') {
    throw new Error(`未知导演台人物类型：${profileId}`);
  }
  const props = canonicalAssetProps(profile, incomingProps);
  delete props.model_url;
  props.asset_id = 'human.procedural';
  props.asset_label = String(incomingProps.asset_label || '').trim().slice(0, 120) || '程序化通用人物';
  props.asset_category = 'people';
  props.asset_license = 'Project-native';
  props.asset_source = 'Built-in procedural rig';
  props.profile_id = profile.id;
  props.focus_height = finite(incomingProps.focus_height, 1.1, 0, 20);
  return props;
}

function isWorkflowExternalAssetId(value) {
  return WORKFLOW_EXTERNAL_ASSET_ID.test(String(value || '').trim());
}

function normalizeWorkflowExternalReference(kind, input, incomingProps, requestedAssetId) {
  const label = String(
    incomingProps.asset_label
    || incomingProps.label
    || input.name
    || '用户上传参考素材'
  ).trim().slice(0, 120);
  if (kind === 'character' || incomingProps.asset_category === 'people') {
    return {
      kind: 'character',
      props: {
        ...normalizeProceduralCharacterProps({
          ...incomingProps,
          asset_id: 'human.procedural',
          profile_id: incomingProps.profile_id || 'human.adult.female',
          asset_label: label || '用户参考主体占位人物',
        }),
        external_reference_asset_id: requestedAssetId,
        external_reference_role: String(incomingProps.external_reference_role || 'identity_reference').slice(0, 80),
      },
    };
  }
  return {
    kind: 'procedural',
    props: {
      ...incomingProps,
      asset_id: 'procedural',
      asset_label: label || '用户参考素材占位物体',
      external_reference_asset_id: requestedAssetId,
      external_reference_role: String(incomingProps.external_reference_role || 'visual_reference').slice(0, 80),
      recipe: normalizeRecipe(incomingProps.recipe || {
        label: label || '用户参考素材占位物体',
        nodes: [{ shape: 'box', position: [0, 0.5, 0], scale: [1, 1, 1], material: { color: '#9aa6b2' } }],
      }),
      focus_height: finite(incomingProps.focus_height, 0.5, 0, 20),
    },
  };
}

function normalizeObject(value, index) {
  const input = value && typeof value === 'object' ? value : {};
  let kind = OBJECT_KINDS.has(input.kind) ? input.kind : 'box';
  const incomingProps = input.props && typeof input.props === 'object' && !Array.isArray(input.props)
    ? { ...input.props }
    : {};
  const requestedAssetId = String(incomingProps.asset_id || input.asset_id || '').trim();
  let props = incomingProps;
  if (requestedAssetId === 'human.procedural') {
    kind = 'character';
    props = normalizeProceduralCharacterProps(incomingProps);
  } else if (isWorkflowExternalAssetId(requestedAssetId)) {
    const external = normalizeWorkflowExternalReference(kind, input, incomingProps, requestedAssetId);
    kind = external.kind;
    props = external.props;
  } else if (kind === 'procedural') {
    props = {
      ...incomingProps,
      asset_id: 'procedural',
      recipe: normalizeRecipe(incomingProps.recipe),
      focus_height: finite(incomingProps.focus_height, 0.5, 0, 20),
    };
  } else if (requestedAssetId) {
    const asset = getDirectorAsset(requestedAssetId);
    if (!asset) throw new Error(`未知导演台素材：${requestedAssetId}`);
    kind = asset.kind;
    props = canonicalAssetProps(asset, incomingProps);
  } else if (kind === 'asset') {
    throw new Error('目录素材缺少 asset_id');
  } else if (kind === 'character') {
    props = normalizeProceduralCharacterProps(incomingProps);
  }
  props = normalizeAttachmentProps(props);
  return {
    id: String(input.id || `${kind}-${index + 1}`).slice(0, 80),
    kind,
    name: String(input.name || `${kind}-${index + 1}`).slice(0, 100),
    position: vec3(input.position, [0, 0, 0]),
    rotation: vec3(input.rotation, [0, 0, 0], -Math.PI * 4, Math.PI * 4),
    scale: vec3(input.scale, [1, 1, 1], 0.01, 50),
    props,
  };
}

function normalizeKeyframe(value, ids, duration, attachedIds = new Set()) {
  const input = value && typeof value === 'object' ? value : {};
  const objectId = String(input.object_id || '');
  if (!ids.has(objectId)) return null;
  const hasWorldTransform = ['position', 'rotation', 'scale']
    .some((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (attachedIds.has(objectId)) {
    if (hasWorldTransform) throw new Error(`attached director object cannot have world keyframes: ${objectId}`);
    const hasLocalTransform = ['local_offset', 'local_rotation', 'local_scale']
      .some((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (!hasLocalTransform) return null;
    return {
      object_id: objectId,
      time: finite(input.time, 0, 0, duration),
      local_offset: strictAttachmentVec3(input.local_offset, [0, 0, 0], 'local_offset'),
      local_rotation: strictAttachmentVec3(input.local_rotation, [0, 0, 0], 'local_rotation', -Math.PI * 4, Math.PI * 4),
      local_scale: strictAttachmentVec3(input.local_scale, [1, 1, 1], 'local_scale', 0.01, 50),
    };
  }
  return {
    object_id: objectId,
    time: finite(input.time, 0, 0, duration),
    position: vec3(input.position, [0, 0, 0]),
    rotation: vec3(input.rotation, [0, 0, 0], -Math.PI * 4, Math.PI * 4),
    scale: vec3(input.scale, [1, 1, 1], 0.01, 50),
  };
}

function validateAttachments(objects) {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const parents = new Map();
  for (const child of objects) {
    const attachTo = String(child.props?.attach_to || '').trim();
    if (!attachTo) continue;
    if (['camera', 'light'].includes(child.kind)) {
      throw new Error(`camera and light objects cannot be attached: ${child.id}`);
    }
    const parent = byId.get(attachTo);
    if (!parent) throw new Error(`director attachment parent does not exist: ${child.id} -> ${attachTo}`);
    if (['camera', 'light'].includes(parent.kind)) {
      throw new Error(`director attachments cannot target cameras or lights: ${child.id} -> ${attachTo}`);
    }
    const anchor = String(child.props?.attach_anchor || 'root');
    if (anchor !== 'root' && parent.kind !== 'character' && parent.props?.asset_category !== 'people') {
      throw new Error(`director anchor ${anchor} requires a character parent: ${child.id}`);
    }
    parents.set(child.id, attachTo);
  }
  const states = new Map();
  const visit = (id) => {
    if (states.get(id) === 1) throw new Error(`director attachment cycle detected at: ${id}`);
    if (states.get(id) === 2) return;
    states.set(id, 1);
    const parent = parents.get(id);
    if (parent) visit(parent);
    states.set(id, 2);
  };
  for (const id of parents.keys()) visit(id);
}

function normalizeCameraAims(objects, visibleObjects) {
  const principal = visibleObjects.find((object) => object.kind === 'character' || object.props?.asset_category === 'people')
    || visibleObjects.find((object) => object.kind !== 'plane')
    || visibleObjects[0]
    || null;
  const visibleById = new Map(visibleObjects.map((object) => [object.id, object]));
  for (const camera of objects.filter((object) => object.kind === 'camera')) {
    const props = { ...(camera.props || {}) };
    if (props.aim_mode === 'rotation') {
      props.aim_mode = 'rotation';
      camera.props = props;
      continue;
    }
    const target = visibleById.get(String(props.target_id || '')) || principal;
    if (!target) {
      props.aim_mode = 'rotation';
      delete props.target_id;
      delete props.target_offset;
    } else {
      props.aim_mode = 'target';
      props.target_id = target.id;
      props.target_offset = vec3(
        props.target_offset,
        [0, finite(target.props?.focus_height, target.kind === 'character' ? 1.1 : 0, 0, 20), 0]
      );
    }
    camera.props = props;
  }
}

function normalizeDirectorDocument(value, expectedDuration = null, expectedAspectRatio = null) {
  const input = value && typeof value === 'object' ? value : {};
  const aspect = productionAspectSpec(expectedAspectRatio || input.aspect_ratio);
  const objects = (Array.isArray(input.objects) ? input.objects : []).slice(0, 80).map(normalizeObject);
  const ids = new Set();
  for (const object of objects) {
    if (ids.has(object.id)) throw new Error(`导演台对象 ID 重复：${object.id}`);
    ids.add(object.id);
  }
  // Director timelines follow the provider execution unit when one is known
  // (e.g. Seedance 2.5 executes a fixed 30-second request).  The timeline is
  // still bounded for safety, but it no longer carries the old global 5–15s
  // assumption.
  const duration = finite(expectedDuration ?? input.timeline?.duration, 5, 1, 60);
  const attachedIds = new Set(objects.filter((object) => object.props?.attach_to).map((object) => object.id));
  const keyframes = (Array.isArray(input.timeline?.keyframes) ? input.timeline.keyframes : [])
    .slice(0, 1000)
    .map((item) => normalizeKeyframe(item, ids, duration, attachedIds))
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);
  const activeCameraId = ids.has(String(input.active_camera_id || '')) ? String(input.active_camera_id) : null;
  const cameras = objects.filter((object) => object.kind === 'camera');
  const visibleObjects = objects.filter((object) => !['camera', 'light'].includes(object.kind));
  if (!cameras.length || !activeCameraId || !cameras.some((camera) => camera.id === activeCameraId)) {
    throw new Error('导演台方案必须包含并启用至少一台摄像机');
  }
  if (!visibleObjects.length) throw new Error('导演台方案没有可见主体');
  normalizeCameraAims(objects, visibleObjects);
  for (const camera of cameras) {
    camera.props = { ...(camera.props || {}), aspect: aspect.value };
  }
  validateAttachments(objects);
  return {
    version: VERSION,
    aspect_ratio: aspect.aspect_ratio,
    active_camera_id: activeCameraId,
    objects,
    timeline: { duration, keyframes },
  };
}

function colorFor(index, kind) {
  const characterColors = ['#32b89c', '#e45e55', '#e4b84f', '#4d87d8'];
  const propColors = ['#f18f55', '#70a6cf', '#b18bd3', '#7cab6d'];
  return (kind === 'character' ? characterColors : propColors)[index % 4];
}

function createFallbackDirectorDocument(shot, aspectRatio = '16:9') {
  const requestedDuration = shot?.provider_duration_seconds
    ?? shot?.duration_plan?.provider_seconds
    ?? shot?.duration;
  const duration = finite(requestedDuration, 5, 1, 60);
  const aspect = productionAspectSpec(aspectRatio);
  const characters = Array.isArray(shot?.character_names) && shot.character_names.length
    ? shot.character_names.slice(0, 4)
    : ['主体'];
  const props = Array.isArray(shot?.prop_names) ? shot.prop_names.slice(0, 4) : [];
  const objects = [
    { id: 'stage-floor', kind: 'plane', name: shot?.scene_name || '场景地面', position: [0, -0.02, 0], rotation: [-Math.PI / 2, 0, 0], scale: [7, 7, 1], props: { color: '#626a70' } },
    { id: 'key-light', kind: 'light', name: '主光', position: [2, 6, 4], rotation: [0, 0, 0], scale: [1, 1, 1], props: { color: '#fff3d6', intensity: 2.1 } },
    { id: 'camera-1', kind: 'camera', name: '主摄影机', position: [6.5, 3.8, 8], rotation: [-0.25, 0.62, 0], scale: [1, 1, 1], props: { fov: 42, aspect: aspect.value, aim_mode: 'target', target_id: 'character-1', target_offset: [0, 1.1, 0] } },
  ];
  characters.forEach((name, index) => objects.push({
    id: `character-${index + 1}`, kind: 'character', name,
    position: [(index - (characters.length - 1) / 2) * 1.6, 0, index % 2 ? -0.5 : 0.35],
    rotation: [0, index === 0 ? 0.15 : -0.15, 0], scale: [1, 1, 1],
    props: {
      asset_id: index % 2 ? 'human.adult.female' : 'human.adult.male',
      color: colorFor(index, 'character'),
      pose: 'neutral',
      motion: index === 0 ? 'walk' : 'idle',
    },
  }));
  props.forEach((name, index) => objects.push({
    id: `prop-${index + 1}`, kind: index % 2 ? 'sphere' : 'box', name,
    position: [(index - (props.length - 1) / 2) * 1.2, 0.5, -1.4],
    rotation: [0, 0, 0], scale: [0.55, 0.55, 0.55], props: { color: colorFor(index, 'prop') },
  }));
  const keyframes = [
    { object_id: 'camera-1', time: 0, position: [6.5, 3.8, 8], rotation: [-0.25, 0.62, 0], scale: [1, 1, 1] },
    { object_id: 'camera-1', time: duration, position: [4.9, 3.1, 6.2], rotation: [-0.22, 0.58, 0], scale: [1, 1, 1] },
  ];
  if (objects.some((object) => object.id === 'character-1')) {
    keyframes.push(
      { object_id: 'character-1', time: 0, position: objects.find((object) => object.id === 'character-1').position, rotation: [0, 0.15, 0], scale: [1, 1, 1] },
      { object_id: 'character-1', time: duration, position: [0.4, 0, -0.35], rotation: [0, -0.1, 0], scale: [1, 1, 1] },
    );
  }
  return normalizeDirectorDocument({ version: VERSION, active_camera_id: 'camera-1', objects, timeline: { duration, keyframes } }, duration, aspect.aspect_ratio);
}

function parseDirectorDocument(raw, shot, log, aspectRatio = '16:9') {
  let parsed;
  try { parsed = raw && typeof raw === 'object' ? raw : safeParseAIJSON(String(raw || ''), log); }
  catch (error) {
    error.code = 'DIRECTOR_JSON_INVALID';
    throw error;
  }
  const expectedDuration = shot?.provider_duration_seconds
    ?? shot?.duration_plan?.provider_seconds
    ?? shot?.duration;
  return normalizeDirectorDocument(parsed, expectedDuration, aspectRatio);
}

function directorPrompts(shot, assets = [], aspectRatio = '16:9', options = {}) {
  const aspect = productionAspectSpec(aspectRatio);
  const poseIds = DIRECTOR_POSES.map((item) => item.id).join('|');
  const motionIds = DIRECTOR_MOTIONS.map((item) => item.id).join('|');
  const attachmentContract = 'HIGHEST-PRIORITY ATTACHMENT CONTRACT: props.attach_to references a non-camera parent; props.attach_anchor is root, head, left_hand, right_hand, left_forearm, or right_forearm. An attached object such as peachwood-sword must use only local_offset/local_rotation/local_scale keyframes, for example {"object_id":"peachwood-sword","time":1.5,"local_rotation":[0,0.4,0]}. Never emit position, rotation, or scale on a keyframe for an attached object. If static attachment is sufficient, omit that object from timeline.keyframes. World position/rotation/scale keyframes are allowed only for unattached objects. Missing parents, cycles, camera/light parents, unresolved hand anchors, and world keyframes on attached objects are hard errors. Each provider request is one complete camera shot. Do not split a continuous action or camera move across requests. Use a motivated hard_cut at flash or occlusion when strict first_frame is unavailable; use a predecessor tail frame only when first_frame is explicitly supported.';
  const providerDuration = shot?.provider_duration_seconds
    ?? shot?.duration_plan?.provider_seconds
    ?? null;
  const creativeDuration = shot?.creative_duration_seconds ?? shot?.duration ?? null;
  const durationHint = providerDuration != null
    ? `Provider execution duration: ${providerDuration}s; creative/edit target: ${creativeDuration ?? providerDuration}s.`
    : `Creative/edit target duration: ${creativeDuration ?? 'provider-defined'}s; do not invent provider limits.`;
  const materialContext = String(options?.material_context || '').trim().slice(0, 26000);
  const materialInstruction = materialContext
    ? '\n素材权威上下文（与剧本、资源文本和媒体阶段相同的稳定事实）：\n'
      + materialContext
      + '\n导演台必须优先使用这些稳定 scope/artifact/source/authority 绑定；uploaded_asset 是用户上传的身份/事实权威，不得另造或替换主体；imported_clip 仅是已有时间线素材，不得生成替代视频。'
    : '';
  const prompts = {
    system: `You are a 3D previs director. Return one JSON object and no Markdown. Schema:\n{"version":2,"aspect_ratio":"${aspect.aspect_ratio}","active_camera_id":"camera-1","objects":[{"id":"...","kind":"asset|procedural|box|sphere|plane|light|camera","name":"...","position":[x,y,z],"rotation":[rx,ry,rz],"scale":[sx,sy,sz],"props":{"asset_id":"registered.id","pose":"${poseIds}","motion":"${motionIds}","motion_speed":1,"motion_phase":0,"motion_intensity":1,"recipe":{"label":"simple missing prop","nodes":[{"shape":"${RECIPE_SHAPES.join('|')}","position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1],"material":{"color":"#RRGGBB"}}]},"color":"#RRGGBB","opacity":1,"wireframe":false,"emissive":"#000000","emissive_intensity":0,"fov":42,"aspect":${aspect.value},"aim_mode":"target","target_id":"character-1","target_offset":[0,1.1,0]}}],"timeline":{"duration":5,"keyframes":[{"object_id":"...","time":0,"position":[x,y,z],"rotation":[rx,ry,rz],"scale":[sx,sy,sz]}]}}. Every camera props.aspect must equal ${aspect.value}. Registered asset IDs: ${compactAssetCatalogForPrompt()}. Prefer registered assets. Use kind=asset with props.asset_id for catalog objects. Workflow IDs such as asset-*, subject-*, artifact ids, database ids, filenames, and uploaded-image references are identity/appearance evidence only and MUST NEVER be written to props.asset_id. Represent a referenced person as kind=character with props.asset_id=human.procedural and a registered profile_id; represent a missing scene or prop as kind=procedural with a bounded recipe. Use kind=procedural with a bounded recipe only for a simple missing object; never emit code, URLs, or unsupported geometry. Keep coordinates between -20 and 20 and use radians for rotation. Include one active camera, a ground/environment, lights, and every principal character and prop. The active camera must use aim_mode=target and target_id must reference the principal animated subject; camera position keyframes then define dolly, orbit, follow, or crane movement while target tracking keeps the action framed. Give first and last keyframes to the camera and every moving subject. Large glass or enclosing geometry must use low opacity and/or wireframe so it cannot hide the action.`,
    user: `${productionAspectPrompt(aspect.aspect_ratio)}\n${durationHint}\nShot: ${JSON.stringify(shot).slice(0, 12000)}\nAssets: ${JSON.stringify(assets).slice(0, 16000)}${materialInstruction}\nCreate a readable previs of composition, blocking, prop motion, lighting changes, and camera movement. Preserve every approved asset identity and spatial anchor.`,
  };
  prompts.system = `${attachmentContract}\n${prompts.system}`;
  return prompts;
}

function directorPromptVariables(aspectRatio = '16:9') {
  const aspect = productionAspectSpec(aspectRatio);
  return {
    attachment_contract: 'HIGHEST-PRIORITY ATTACHMENT CONTRACT: props.attach_to must reference an existing non-camera, non-light parent. Non-root anchors require a character parent. Attached objects use only local_offset/local_rotation/local_scale and local_position/local_rotation/local_scale keyframes; world transforms are forbidden. Missing parents, invalid anchors, self-links, attachment cycles, and world keyframes on attached objects are hard errors.',
    aspect_ratio: aspect.aspect_ratio,
    aspect_value: aspect.value,
    pose_ids: DIRECTOR_POSES.map((item) => item.id).join('|'),
    motion_ids: DIRECTOR_MOTIONS.map((item) => item.id).join('|'),
    recipe_shapes: RECIPE_SHAPES.join('|'),
    asset_catalog: compactAssetCatalogForPrompt(),
  };
}

module.exports = {
  VERSION,
  normalizeDirectorDocument,
  createFallbackDirectorDocument,
  parseDirectorDocument,
  directorPrompts,
  directorPromptVariables,
};
