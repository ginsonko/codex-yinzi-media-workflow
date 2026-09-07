const crypto = require('node:crypto');

const PLAN_VERSION = 1;
const SOURCE_TYPES = new Set(['generate', 'imported_clip', 'reuse_asset', 'skip', 'unresolved']);

// A template is an execution contract, not only a visual style. These rules
// are data so they can be versioned, shown in the UI, and passed to the
// classifier/prompt runtime without creating a second production engine.
const DEFAULT_STAGES = Object.freeze({
  asset_text: 'reuse_or_generate', asset_images: 'reuse_or_generate',
  storyboard_images: 'generate_if_needed', shot_video: 'generate_missing', final_edit: 'assemble',
});
const DEFAULT_DIRECT_CLIP_RULES = Object.freeze({
  accept_uploaded_video: true, prefer_existing_over_generation: true,
  require_explicit_shot_for_timeline: true, preserve_audio_by_default: true,
});
const DEFAULT_REFERENCE_RULES = Object.freeze({
  authority_order: ['user_confirmed', 'uploaded_asset', 'series_selected', 'ai_suggestion'],
  user_controls_inclusion: true, preserve_original_files: true,
  previous_tail_frame: 'candidate_only',
});
const DEFAULT_REVIEW_RULES = Object.freeze({
  missing_optional_input: 'continue_with_explanation',
  low_confidence_assignment: 'show_for_confirmation',
  imported_clip: 'validate_then_reuse',
});
function slot(id, label, required, accepts, description) {
  return { id, label, required: required === true, accepts: accepts || ['image', 'video', 'audio', 'document'], description: description || '' };
}
function workflowSpec(id, overrides = {}) {
  return {
    id, version: 1, requires_scene: false, direct_clip_priority: true, default_shots: 3,
    input_slots: [], primary_roles: ['visual_reference'], role_hints: {},
    stages: { ...DEFAULT_STAGES }, direct_clip_rules: { ...DEFAULT_DIRECT_CLIP_RULES },
    reference_rules: { ...DEFAULT_REFERENCE_RULES }, review_rules: { ...DEFAULT_REVIEW_RULES },
    skip_rules: { optional_stages: ['asset_images', 'storyboard_images', 'director_plan', 'director_preview', 'shot_video'], allow_partial_success: true },
    prompt_context: { instruction: '优先使用用户提供的事实和素材；只为缺失内容生成补充。', positive: '素材用途和来源清晰可追溯。', negative: '不得静默替换已确认主体或重复生成已有成片。' },
    ...overrides,
    stages: { ...DEFAULT_STAGES, ...(overrides.stages || {}) },
    direct_clip_rules: { ...DEFAULT_DIRECT_CLIP_RULES, ...(overrides.direct_clip_rules || {}) },
    reference_rules: { ...DEFAULT_REFERENCE_RULES, ...(overrides.reference_rules || {}) },
    review_rules: { ...DEFAULT_REVIEW_RULES, ...(overrides.review_rules || {}) },
    skip_rules: { optional_stages: ['asset_images', 'storyboard_images', 'director_plan', 'director_preview', 'shot_video'], allow_partial_success: true, ...(overrides.skip_rules || {}) },
    prompt_context: { instruction: '优先使用用户提供的事实和素材；只为缺失内容生成补充。', positive: '素材用途和来源清晰可追溯。', negative: '不得静默替换已确认主体或重复生成已有成片。', ...(overrides.prompt_context || {}) },
  };
}
const WORKFLOWS = Object.freeze({
  ecommerce: workflowSpec('ecommerce', { default_shots: 3, primary_roles: ['product_reference', 'source_document', 'direct_clip'], role_hints: { image_default: 'product_reference', video_default: 'direct_clip' }, input_slots: [slot('product', '商品/包装图', true, ['image', 'video'], '作为商品外观和品牌事实的权威来源'), slot('selling_points', '卖点或商品文档', false, ['document'], '用于口播、字幕和镜头排序'), slot('existing_clip', '已有商品视频', false, ['video'], '可直接进入时间线')], prompt_context: { instruction: '围绕商品事实安排卖点镜头；不得虚构价格、型号、材质或功效。', positive: '先复用商品图和已有视频，再补齐缺失镜头。', negative: '不得重绘 logo、包装文字或改变商品颜色。' } }),
  'outfit-change': workflowSpec('outfit-change', { primary_roles: ['person_reference', 'outfit_reference', 'scene_reference'], role_hints: { image_default: 'person_reference', outfit_keywords: ['服装', '衣服', 'outfit', 'dress', 'clothing'] }, input_slots: [slot('person', '人物图', true, ['image'], '固定脸部、体态和身份'), slot('outfit', '服装/配饰图', true, ['image'], '只改变服装和配饰'), slot('pose', '姿态或场景参考', false, ['image', 'video'], '用于动作和构图')], prompt_context: { instruction: '固定人物身份，只更换用户指定的服装、发型或配饰。', positive: '同一人物锚点在每个镜头复用。', negative: '不得生成无关人物或改变脸部身份。' } }),
  'dance-action': workflowSpec('dance-action', { primary_roles: ['person_reference', 'action_reference', 'source_audio', 'direct_clip'], role_hints: { image_default: 'person_reference', video_default: 'action_reference', audio_default: 'source_audio' }, input_slots: [slot('person', '人物图', true, ['image'], '动作主体身份来源'), slot('action', '舞蹈/动作参考视频', true, ['video'], '提取节拍和关键姿态'), slot('audio', '音乐或节拍', false, ['audio', 'video'], '用于剪辑节奏')], prompt_context: { instruction: '提取动作节拍和姿态，不复制参考者身份或声音。', positive: '动作边界完整，镜头跟随节拍。', negative: '不得把动作参考视频误当作最终成片或复制他人身份。' } }),
  'image-to-video': workflowSpec('image-to-video', { default_shots: 1, primary_roles: ['primary_subject_reference', 'visual_reference', 'direct_clip'], role_hints: { image_default: 'primary_subject_reference', video_default: 'direct_clip' }, input_slots: [slot('subject', '主体图', true, ['image'], '上传图中的主体是不可替换的身份权威'), slot('motion', '动作/构图参考', false, ['image', 'video', 'document'], '说明希望主体如何运动'), slot('existing_clip', '已有视频片段', false, ['video'], '可直接作为镜头成片')], prompt_context: { instruction: '让上传图片中的主体完成用户描述的动作，图片是每个镜头的首要参考。', positive: '猫娘、人物或商品保持原图身份与外观。', negative: '不得另造一个相似但不同的主体。' } }),
  'novel-drama': workflowSpec('novel-drama', { requires_scene: true, default_shots: 4, primary_roles: ['character_reference', 'style_reference', 'source_document'], role_hints: { image_default: 'character_reference', document_default: 'source_document' }, input_slots: [slot('novel', '小说/剧本文档', true, ['document'], '事实和章节来源'), slot('characters', '角色设定图', false, ['image', 'document'], '固定角色身份'), slot('style', '画风参考', false, ['image', 'document'], '只约束美术风格')], prompt_context: { instruction: '先保留原作事实，再补足可拍摄的场景、动作和对白。', positive: '章节、台词和画面有可追溯关系。', negative: '不得把风格参考误当成角色身份。' } }),
  'knowledge-explainer': workflowSpec('knowledge-explainer', { primary_roles: ['source_document', 'chart_reference', 'direct_clip'], role_hints: { image_default: 'chart_reference', video_default: 'direct_clip', document_default: 'source_document' }, input_slots: [slot('source', '资料/提纲', true, ['document'], '事实与引用来源'), slot('chart', '图表/截图', false, ['image'], '解释数据或界面'), slot('clip', '已有讲解片段', false, ['video'], '可直接剪入成片')], prompt_context: { instruction: '所有数字、结论和引用必须能回到输入资料。', positive: '图表和 B-roll 服务于口播重点。', negative: '不得凭空补写数字或因缺场景阻断。' } }),
  'travel-memory': workflowSpec('travel-memory', { default_shots: 4, primary_roles: ['direct_clip', 'visual_reference', 'source_document'], stages: { asset_text: 'reuse', asset_images: 'reuse_or_generate' }, role_hints: { image_default: 'visual_reference', video_default: 'direct_clip', document_default: 'source_document' }, input_slots: [slot('photos', '照片', true, ['image'], '按时间和地点组织'), slot('clips', '旅行视频', false, ['video'], '优先作为成片片段'), slot('notes', '地点/日期/行程资料', false, ['document'], '避免虚构事件')], prompt_context: { instruction: '尊重原始照片和视频的地点、人物与时间关系，优先复用原片。', positive: '已有视频直接进入时间线，缺口才生成。', negative: '不得编造地点、日期或人物关系。' } }),
  'game-tutorial': workflowSpec('game-tutorial', { default_shots: 4, primary_roles: ['direct_clip', 'source_document', 'screen_reference'], role_hints: { image_default: 'screen_reference', video_default: 'direct_clip', document_default: 'source_document' }, input_slots: [slot('recording', '录屏视频', true, ['video'], '作为教程主体片段'), slot('steps', '步骤文档', true, ['document'], '确定操作顺序'), slot('screens', '界面截图', false, ['image'], '补充重点说明')], prompt_context: { instruction: '以录屏和步骤文档为事实来源，保持 UI 文本、版本和操作顺序准确。', positive: '可直接剪辑录屏并只生成缺失讲解。', negative: '不得遮挡按钮、改写 UI 文本或臆造操作。' } }),
  'music-mv': workflowSpec('music-mv', { default_shots: 4, primary_roles: ['source_audio', 'person_reference', 'direct_clip'], role_hints: { image_default: 'person_reference', video_default: 'direct_clip', audio_default: 'source_audio' }, input_slots: [slot('song', '歌曲/音频', true, ['audio', 'video'], '节拍和段落来源'), slot('person', '人物图', false, ['image'], '固定出镜者身份'), slot('clips', '已有演出视频', false, ['video'], '优先剪入成片')], prompt_context: { instruction: '镜头切换服务于音乐节拍，保留人物身份和歌词段落关系。', positive: '已有视频、音频和新生成镜头混合剪辑。', negative: '不得擅自改写歌词或复制参考者声音。' } }),
  'brand-promo': workflowSpec('brand-promo', { primary_roles: ['product_reference', 'source_document', 'direct_clip'], role_hints: { image_default: 'product_reference', video_default: 'direct_clip', document_default: 'source_document' }, input_slots: [slot('product', '产品图/已有视频', true, ['image', 'video'], '产品事实权威来源'), slot('brand', '品牌手册', true, ['document', 'image'], '颜色、logo 和语气规则'), slot('copy', '宣传文案', false, ['document'], '可核对的卖点')], prompt_context: { instruction: '严格遵循品牌手册和产品事实，未经确认不新增承诺。', positive: '先复用产品资产和已有片段。', negative: '不得改变 logo、颜色、包装或宣传口径。' } }),
  'course-clipping': workflowSpec('course-clipping', { default_shots: 5, primary_roles: ['direct_clip', 'source_document'], stages: { asset_text: 'reuse' }, role_hints: { video_default: 'direct_clip', document_default: 'source_document' }, input_slots: [slot('course', '课程视频', true, ['video'], '原始内容和时间码来源'), slot('outline', '讲义/章节目录', true, ['document'], '确定重点'), slot('visuals', '课件截图', false, ['image'], '补充画面')], prompt_context: { instruction: '从原始课程提取重点，保留章节、时间码和原意，优先直接剪辑。', positive: '已有课程视频成为时间线片段。', negative: '不得断章取义或虚构讲师观点。' } }),
  'podcast-video': workflowSpec('podcast-video', { default_shots: 4, primary_roles: ['source_audio', 'source_document', 'direct_clip'], stages: { asset_text: 'reuse' }, role_hints: { audio_default: 'source_audio', video_default: 'direct_clip', document_default: 'source_document' }, input_slots: [slot('audio', '播客音频', true, ['audio', 'video'], '观点和时间关系来源'), slot('transcript', '逐字稿', false, ['document'], '字幕和章节依据'), slot('guest', '嘉宾图/已有视频', false, ['image', 'video'], '固定出镜身份或直接片段')], prompt_context: { instruction: '保持说话人身份、观点和时间关系，字幕按逐字稿组织。', positive: '音频和已有视频可直接参与成片。', negative: '不得擅自改写观点或把嘉宾图替换成新人物。' } }),
  'virtual-drama': workflowSpec('virtual-drama', { requires_scene: true, default_shots: 4, primary_roles: ['character_reference', 'scene_reference', 'style_reference'], role_hints: { image_default: 'character_reference' }, input_slots: [slot('characters', '角色设定', true, ['image', 'document'], '角色身份锚点'), slot('scene', '场景设定', true, ['image', 'document'], '空间锚点'), slot('style', '风格与声音参考', false, ['image', 'audio', 'document'], '统一视听风格')], prompt_context: { instruction: '维护角色、服装、场景和声音锚点，已确认资产可跨镜头复用。', positive: '只生成缺失资产，保留已确认版本。', negative: '不得让角色或场景在镜头间漂移。' } }),
});

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableId(prefix, value) {
  const digest = crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}
function text(value, max = 2000) { return String(value == null ? '' : value).trim().slice(0, max); }
function workflowFor(templateId) { return clone(WORKFLOWS[String(templateId || '').trim()] || workflowSpec('free')); }
function isImage(item) { return ['image', 'character', 'scene', 'prop', 'asset_images'].includes(String(item?.detected_type || '').trim()) || String(item?.mime_type || '').startsWith('image/'); }
function isVideo(item) { return ['video', 'shot_video', 'final_edit', 'director_preview'].includes(String(item?.detected_type || '').trim()) || String(item?.mime_type || '').startsWith('video/'); }
function isAudio(item) { return ['audio', 'source_audio'].includes(String(item?.detected_type || '').trim()) || String(item?.mime_type || '').startsWith('audio/'); }
function isText(item) { return ['script', 'storyboard', 'asset_text', 'text'].includes(String(item?.detected_type || '').trim()) || String(item?.mime_type || '').startsWith('text/'); }
function explicitShotNumber(item) {
  const explicit = Number(item?.shot_number ?? item?.metadata?.shot_number);
  if (Number.isSafeInteger(explicit) && explicit > 0) return explicit;
  const value = text(item?.candidate_scope_id || '', 120);
  const name = text(item?.file_name || item?.relative_path || '', 240);
  const match = `${value} ${name}`.match(/(?:shot|scene|镜头|分镜|clip)[ _-]*(\d{1,3})/i);
  return match ? Math.max(1, Number(match[1])) : null;
}
function pointsToUploadedSubject(intent) {
  return /图中|图片中|这张图|上传的图|照片中|画面中的|角色|人物|商品|猫娘|主体/.test(text(intent, 4000));
}
function roleFor(item, templateId, intent) {
  const type = String(item?.detected_type || '').trim();
  const usage = String(item?.usage_role || item?.metadata?.usage_role || '').trim();
  const name = `${item?.file_name || ''} ${item?.relative_path || ''}`.toLowerCase();
  // A confirmed classifier role is stronger than filename heuristics. Keep
  // generic video roles contextual so a model can distinguish a direct clip
  // from a motion/reference video without making an unknown asset unusable.
  const explicitRoles = new Set([
    'primary_subject_reference', 'character_reference', 'product_reference',
    'scene_reference', 'outfit_reference', 'action_reference', 'reference_video',
    'source_audio', 'source_document', 'screen_reference', 'chart_reference',
    'style_reference', 'prop_reference', 'visual_reference', 'direct_clip',
  ]);
  // The scanner's generic visual_reference is only a provisional default.
  // When the user explicitly points at a subject in an uploaded image, that
  // intent outranks the provisional role and upgrades the image to the
  // template's subject role. This is what keeps a user-provided cat/person/
  // product image from being treated as a decorative style reference.
  // A classifier's explicit scene/prop type is stronger than a story phrase
  // such as “图片中的角色”.  A single image may contain a character in a
  // setting, but we must not silently turn a scene or prop row into a second
  // character merely because the user also mentioned a character.
  if (usage === 'visual_reference' && isImage(item) && pointsToUploadedSubject(intent)
    && !['scene', 'prop', 'asset_text', 'storyboard'].includes(type)) {
    const workflow = workflowFor(templateId);
    if (workflow.primary_roles?.includes('primary_subject_reference')) return 'primary_subject_reference';
    if (workflow.primary_roles?.includes('product_reference')) return 'product_reference';
    if (workflow.primary_roles?.some((role) => ['person_reference', 'character_reference'].includes(role))) return 'character_reference';
  }
  // A classifier-provided semantic type is authoritative over a generic or
  // contradictory usage label.  This prevents a scene/prop that appears in a
  // story mentioning a character from being promoted to a character simply
  // because the classifier returned character_reference as a stale hint.
  if (type === 'scene') return 'scene_reference';
  if (type === 'prop') return templateId === 'ecommerce' || templateId === 'brand-promo' ? 'product_reference' : 'prop_reference';
  if (type === 'character' || type === 'person') return 'character_reference';
  if (explicitRoles.has(usage) && usage !== 'direct_clip') return usage;
  if (usage === 'direct_clip') return isVideo(item) ? 'direct_clip' : 'visual_reference';
  if (isAudio(item)) return 'source_audio';
  if (isText(item)) return type === 'script' ? 'source_document' : 'source_document';
  if (isVideo(item)) {
    if (/动作|舞蹈|dance|motion|action/.test(name) || templateId === 'dance-action') return 'action_reference';
    if (/参考|reference|guide|示范/.test(name) && !/shot|镜头|clip|成片|final|完成/.test(name)) return 'reference_video';
    return 'direct_clip';
  }
  if (type === 'character' || /角色|人物|猫娘|person|character|portrait/.test(name)) return 'character_reference';
  if (type === 'scene' || /场景|地点|背景|scene|location|background/.test(name)) return 'scene_reference';
  if (type === 'prop' || /商品|产品|服装|衣服|道具|product|outfit|prop|shoe|包装/.test(name)) return templateId === 'ecommerce' || templateId === 'brand-promo' ? 'product_reference' : 'prop_reference';
  if (pointsToUploadedSubject(intent) && isImage(item)) {
    const workflow = workflowFor(templateId);
    if (workflow.primary_roles?.includes('primary_subject_reference')) return 'primary_subject_reference';
    if (workflow.primary_roles?.includes('product_reference')) return 'product_reference';
    if (workflow.primary_roles?.some((role) => ['person_reference', 'character_reference'].includes(role))) return 'character_reference';
    // Free/unknown workflows still need a deterministic subject authority
    // when the user explicitly points at the uploaded image. A generic
    // template must not silently downgrade that image to decoration.
    return 'primary_subject_reference';
  }
  if (usage === 'visual_reference') return 'visual_reference';
  return 'visual_reference';
}
function sourceRef(item) {
  return { sha256: item?.sha256 || null, relative_path: text(item?.relative_path || item?.file_name || '', 500), source_token: item?.source_token || null };
}

function subjectRoleForTemplate(templateId) {
  const workflow = workflowFor(templateId);
  if (workflow.primary_roles?.includes('primary_subject_reference')) return 'primary_subject_reference';
  if (workflow.primary_roles?.includes('product_reference')) return 'product_reference';
  if (workflow.primary_roles?.some((role) => ['person_reference', 'character_reference'].includes(role))) return 'character_reference';
  return 'visual_reference';
}
function buildSubjects(items, intent, templateId) {
  const provisionalIndex = items.findIndex((item) => isImage(item)
    && String(item?.usage_role || item?.metadata?.usage_role || '').trim() === 'visual_reference'
    && !['scene', 'prop', 'asset_text', 'storyboard'].includes(String(item?.detected_type || '').trim()));
  const candidates = items.map((item, index) => ({
    item,
    index,
    role: roleFor(item, templateId, intent),
  })).filter(({ item, index, role }) => {
    if (!isImage(item)) return false;
    if (!['primary_subject_reference', 'character_reference', 'person_reference', 'product_reference'].includes(role)) return false;
    // A generic visual reference is provisional.  Treat only the first such
    // image as the primary subject unless the classifier explicitly labeled
    // the other images as character/product references.  This prevents a
    // background/scene image from becoming a second character while still
    // supporting multiple explicitly classified characters.
    if (String(item?.usage_role || item?.metadata?.usage_role || '').trim() === 'visual_reference'
      && index !== provisionalIndex
      && !['character', 'person', 'product'].includes(String(item?.detected_type || '').trim())) return false;
    return true;
  });
  if (!candidates.length || !pointsToUploadedSubject(intent)) return [];
  const scopeCounters = new Map();
  return candidates.slice(0, 8).map(({ item, index, role }) => {
    const scopeType = role === 'product_reference' ? 'product' : 'character';
    const scopeNumber = Number(scopeCounters.get(scopeType) || 0) + 1;
    scopeCounters.set(scopeType, scopeNumber);
    return {
      id: stableId('subject', item.sha256 || item.relative_path || index),
      kind: scopeType,
      name: text(item.subject_name || item.metadata?.subject_name || item.file_name || `上传主体 ${scopeNumber}`, 100),
      authority: 'uploaded_asset',
      source_ref: sourceRef(item),
      source_artifact_id: null,
      target_scope_type: scopeType,
      target_scope_id: `${scopeType}-${scopeNumber}`,
      must_preserve_identity: true,
      can_generate_replacement: false,
      identity_anchors: Array.isArray(item.identity_anchors || item.metadata?.identity_anchors)
        ? (item.identity_anchors || item.metadata.identity_anchors).map((value) => text(value, 300)).filter(Boolean).slice(0, 12)
        : [],
      visual_description: text(item.visual_description || item.metadata?.visual_description || '', 1200),
      evidence: item.evidence || item.metadata?.visual_description || '用户指向上传素材中的主体，原素材作为身份权威来源',
    };
  });
}
function buildExecutionPlan(input = {}) {
  const templateId = text(input.template_id || input.templateId || '', 100) || 'free';
  const workflow = workflowFor(templateId);
  const intent = text(input.user_intent || input.story || input.source_text || '', 12000);
  const items = Array.isArray(input.items) ? input.items.filter((item) => item && item.status !== 'excluded') : [];
  const subjects = buildSubjects(items, intent, templateId);
  const scopeCounters = new Map();
  const provisionalSubjectIndex = items.findIndex((item) => isImage(item)
    && String(item?.usage_role || item?.metadata?.usage_role || '').trim() === 'visual_reference'
    && !['scene', 'prop', 'asset_text', 'storyboard'].includes(String(item?.detected_type || '').trim()));
  const assets = items.map((item, index) => {
    let role = roleFor(item, templateId, intent);
    if (String(item?.usage_role || item?.metadata?.usage_role || '').trim() === 'visual_reference'
      && index !== provisionalSubjectIndex
      && !['character', 'person', 'product'].includes(String(item?.detected_type || '').trim())
      && ['primary_subject_reference', 'character_reference', 'product_reference'].includes(role)) {
      role = 'visual_reference';
    }
    const authority = ['primary_subject_reference', 'character_reference', 'product_reference', 'scene_reference', 'outfit_reference'].includes(role) ? 'uploaded_asset' : 'user_asset';
    const directCandidate = isVideo(item) && item.direct_clip_candidate !== false && role === 'direct_clip';
    const shotNumber = directCandidate ? explicitShotNumber(item) : null;
    const subject = subjects.find((candidate) => candidate.source_ref?.sha256 && candidate.source_ref.sha256 === item.sha256)
      || subjects.find((candidate) => candidate.source_ref?.relative_path && candidate.source_ref.relative_path === item.relative_path);
    const targetScopeType = subject?.target_scope_type
      || (['character_reference', 'primary_subject_reference'].includes(role) ? 'character'
        : role === 'product_reference' ? 'product'
          : role === 'scene_reference' ? 'scene'
            : role === 'prop_reference' ? 'prop' : null);
    const nextScopeNumber = targetScopeType
      ? (scopeCounters.set(targetScopeType, Number(scopeCounters.get(targetScopeType) || 0) + 1), scopeCounters.get(targetScopeType))
      : 0;
    const targetScopeId = subject?.target_scope_id || (targetScopeType ? `${targetScopeType}-${nextScopeNumber}` : null);
    return {
      id: stableId('asset', item.sha256 || item.relative_path || index),
      artifact_id: null,
      source_ref: sourceRef(item),
      file_name: text(item.file_name || item.relative_path || `素材 ${index + 1}`, 240),
      role,
      authority,
      usage: directCandidate ? ['timeline_candidate', 'continuity_source'] : [role],
      candidate_stage: item.candidate_stage || null,
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.2,
      confidence_observed: Number.isFinite(Number(item.confidence)),
      evidence: item.evidence || null,
      visual_description: text(item.visual_description || item.metadata?.visual_description || '', 1200),
      identity_anchors: Array.isArray(item.identity_anchors || item.metadata?.identity_anchors)
        ? (item.identity_anchors || item.metadata.identity_anchors).map((value) => text(value, 300)).filter(Boolean).slice(0, 12)
        : [],
      direct_clip_candidate: directCandidate,
      shot_number: shotNumber,
      requires_user_confirmation: directCandidate && shotNumber == null,
      target_scope_type: targetScopeType,
      target_scope_id: targetScopeId,
      authority_subject_id: subject?.id || null,
      authority_source_ref: subject ? sourceRef(item) : null,
      subject_name: subject?.name || text(item.subject_name || item.metadata?.subject_name || '', 100) || null,
      // Keep stable IDs alongside the human-readable role.  Downstream media
      // stages use these IDs first and only use names as a legacy fallback.
      source_artifact_ref: item.artifact_id || null,
    };
  });
  const targetShots = Math.max(1, Number(input.target_shots || input.targetShots || workflow.default_shots) || workflow.default_shots);
  const clipAssets = assets.filter((item) => item.direct_clip_candidate);
  const explicitClips = clipAssets.filter((item) => Number.isInteger(item.shot_number));
  const maxExplicit = explicitClips.reduce((max, item) => Math.max(max, item.shot_number), 0);
  const shotCount = Math.max(targetShots, maxExplicit, 1);
  const shots = [];
  for (let number = 1; number <= shotCount; number += 1) {
    const importedCandidates = explicitClips.filter((item) => item.shot_number === number);
    const imported = importedCandidates.length === 1 ? importedCandidates[0] : null;
    if (imported) {
      shots.push({ number, id: `shot-${number}`, source: 'imported_clip', artifact_id: null, source_asset_id: imported.id, source_ref: imported.source_ref, status: 'approved', duration_policy: 'trim_to_shot', preserve_audio: true, preserve_subtitles: true, first_frame_source: number > 1 ? { type: 'previous_shot_tail_candidate', shot_number: number - 1 } : null, last_frame_source: { type: 'imported_clip_tail', asset_id: imported.id } });
    } else if (importedCandidates.length > 1) {
      shots.push({ number, id: `shot-${number}`, source: 'unresolved', artifact_id: null, source_asset_id: null, source_ref: null, status: 'needs_confirmation', duration_policy: 'user_select_imported_clip', preserve_audio: true, preserve_subtitles: true, first_frame_source: number > 1 ? { type: 'previous_shot_tail_candidate', shot_number: number - 1 } : null, last_frame_source: null });
    } else {
      shots.push({ number, id: `shot-${number}`, source: 'generate', artifact_id: null, source_asset_id: null, source_ref: null, status: 'pending', duration_policy: 'provider_capability_then_trim', preserve_audio: false, preserve_subtitles: false, first_frame_source: number > 1 ? { type: 'previous_shot_tail_candidate', shot_number: number - 1 } : null, last_frame_source: null });
    }
  }
  const unresolved = assets.filter((item) => item.requires_user_confirmation).map((item) => ({ type: 'direct_clip_shot_assignment', asset_id: item.id, file_name: item.file_name, reason: '视频看起来可以作为成片片段，但文件名或内容不足以安全确定镜头位置，请在计划预览中选择镜头或仅作为参考' }));
  for (const shot of shots.filter((item) => item.source === 'unresolved')) {
    for (const asset of explicitClips.filter((item) => item.shot_number === shot.number)) {
      unresolved.push({ type: 'direct_clip_shot_conflict', asset_id: asset.id, file_name: asset.file_name, shot_number: shot.number, reason: `多个已有视频都指向镜头 ${shot.number}，请明确选择一个成片或重新安排镜头位置；系统不会静默挑选。` });
    }
  }
  for (const asset of assets.filter((item) => item.confidence_observed === true && Number(item.confidence) < 0.65)) {
    unresolved.push({ type: 'low_confidence_assignment', asset_id: asset.id, file_name: asset.file_name, role: asset.role, reason: 'AI 对这份素材的用途把握较低，请确认用途或手动改到正确槽位；这只是提醒，不会禁止继续。' });
  }
  const hasSubject = subjects.length > 0;
  const hasScene = assets.some((item) => item.role === 'scene_reference');
  const stagePolicy = {
    ...workflow.stages,
    asset_text: hasSubject || assets.some((item) => isText(item)) ? workflow.stages.asset_text : workflow.stages.asset_text,
    asset_images: assets.some((item) => item.authority === 'uploaded_asset') ? 'reuse_missing_only' : workflow.stages.asset_images,
    shot_video: shots.some((shot) => shot.source === 'unresolved')
      ? 'awaiting_clip_assignment'
      : shots.some((shot) => shot.source === 'generate') ? 'generate_missing' : 'skip_all_reused',
  };
  if (!workflow.requires_scene) stagePolicy.scene = 'optional';
  else if (hasScene) stagePolicy.scene = 'reuse';
  else stagePolicy.scene = 'generate_if_needed';
  return {
    schema_version: PLAN_VERSION,
    template_id: templateId,
    template_version: Number(input.template_version || 1),
    user_intent: intent,
    created_at: new Date().toISOString(),
    // Keep the execution contract in the persisted plan so the UI and a
    // resumed runner can explain the same decisions without re-inferring the
    // selected template from labels or filenames.
    workflow: clone(workflow),
    subjects,
    assets,
    shots,
    stage_policy: stagePolicy,
    reference_policy: { subject_assets_required: subjects.map((subject) => subject.id), direct_clip_assets: clipAssets.map((item) => item.id), include_roles: ['primary_subject_reference', 'character_reference', 'product_reference', 'scene_reference', 'prop_reference', 'visual_reference'] },
    unresolved_items: unresolved,
    summary: {
      subject_count: subjects.length,
      asset_count: assets.length,
      imported_clip_count: shots.filter((shot) => shot.source === 'imported_clip').length,
      generated_shot_count: shots.filter((shot) => shot.source === 'generate').length,
      planned_video_actions: shots.filter((shot) => shot.source === 'generate').length,
      unresolved_count: unresolved.length,
      requires_confirmation: unresolved.length > 0,
      scene_required: workflow.requires_scene,
      scene_available: hasScene,
    },
  };
}
function resolveArtifactBindings(plan, itemArtifactMap = {}) {
  if (!plan || typeof plan !== 'object') return plan;
  const next = clone(plan);
  const lookup = (ref) => {
    if (ref?.sha256 && itemArtifactMap[ref.sha256]) return Number(itemArtifactMap[ref.sha256]);
    if (ref?.relative_path && itemArtifactMap[`path:${ref.relative_path}`]) return Number(itemArtifactMap[`path:${ref.relative_path}`]);
    return null;
  };
  for (const asset of next.assets || []) {
    asset.artifact_id = asset.artifact_id || lookup(asset.source_ref);
    if (asset.authority === 'uploaded_asset' && !asset.authority_source_ref) asset.authority_source_ref = asset.source_ref || null;
  }
  for (const subject of next.subjects || []) {
    subject.source_artifact_id = subject.source_artifact_id || lookup(subject.source_ref);
    subject.authority_source_ref = subject.authority_source_ref || subject.source_ref || null;
  }
  for (const shot of next.shots || []) {
    shot.artifact_id = shot.artifact_id || (shot.source_ref ? lookup(shot.source_ref) : null);
    const source = next.assets.find((item) => item.id === shot.source_asset_id);
    if (source?.artifact_id) shot.artifact_id = source.artifact_id;
  }
  // Resolve any explicit reference IDs carried by a storyboard plan without
  // inventing a binding.  Stable plan IDs remain useful even when the source
  // artifact has not been copied into run storage yet.
  for (const shot of next.shots || []) {
    const refs = Array.isArray(shot.reference_asset_ids) ? shot.reference_asset_ids : [];
    shot.reference_asset_ids = refs.map((id) => {
      const asset = next.assets.find((item) => item.id === id || String(item.id) === String(id));
      return asset?.artifact_id || id;
    });
  }
  next.resolved_at = new Date().toISOString();
  return next;
}

// A compact, human-readable projection shared by every text/media stage. It
// deliberately includes provenance and authority rather than dumping an
// opaque JSON blob, so prompts can act on the same material facts.
function materialContext(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const subjects = (plan.subjects || []).map((subject) => ({
    id: subject.id,
    name: subject.name,
    authority: subject.authority,
    source_artifact_id: subject.source_artifact_id,
    target_scope: subject.target_scope_id || null,
    must_preserve_identity: subject.must_preserve_identity === true,
    evidence: subject.evidence || null,
    visual_description: subject.visual_description || null,
    identity_anchors: subject.identity_anchors || [],
  }));
  const assets = (plan.assets || []).map((asset) => ({
    id: asset.id,
    file_name: asset.file_name,
    role: asset.role,
    authority: asset.authority,
    artifact_id: asset.artifact_id,
    source_ref: asset.source_ref || null,
    target_scope: asset.target_scope_id || null,
    candidate_stage: asset.candidate_stage,
    shot_number: asset.shot_number,
    direct_clip_candidate: asset.direct_clip_candidate === true,
    confidence: asset.confidence,
    evidence: asset.evidence || null,
    visual_description: asset.visual_description || null,
    identity_anchors: asset.identity_anchors || [],
  }));
  const shots = (plan.shots || []).map((shot) => ({
    number: shot.number,
    source: shot.source,
    artifact_id: shot.artifact_id,
    source_ref: shot.source_ref,
    source_asset_id: shot.source_asset_id,
    reference_asset_ids: shot.reference_asset_ids || [],
    character_ids: shot.character_ids || [],
    scene_id: shot.scene_id || null,
    prop_ids: shot.prop_ids || [],
  }));
  return JSON.stringify({
    instruction: 'uploaded_asset 是身份/事实权威；imported_clip 已是时间线素材；只为缺失内容生成，不得静默替换或重复生成。',
    subjects,
    assets,
    shots,
    unresolved_items: plan.unresolved_items || [],
  }, null, 2).slice(0, 26000);
}

// Repair the hand-off from the text model's storyboard response to the
// persisted asset scopes. Models occasionally return the correct human name
// but omit (or slightly rewrite) the stable IDs required by the media stage.
// Resolve an ID through the execution plan first, then an exact unique name;
// never choose the first character/scene when more than one candidate exists.
function bindShotReferences(shot, plan, resources = []) {
  const next = clone(shot || {});
  const definitions = (Array.isArray(resources) ? resources : [])
    .map((item) => ({
      type: String(item?.scope_type || item?.type || '').trim(),
      scope_id: String(item?.scope_id || '').trim(),
      name: text(item?.content?.name || item?.name || '', 200),
      content: item?.content || item,
    }))
    .filter((item) => item.type && item.scope_id);
  const byType = (type) => definitions.filter((item) => item.type === type);
  const planAssets = Array.isArray(plan?.assets) ? plan.assets : [];
  const subjects = Array.isArray(plan?.subjects) ? plan.subjects : [];
  const norm = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[\p{White_Space}\p{P}\p{S}]+/gu, '');
  const planTargetFor = (type, value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const match = [...planAssets, ...subjects].find((item) => {
      const targetType = String(item?.target_scope_type || '').trim();
      const targetId = String(item?.target_scope_id || '').trim();
      const id = String(item?.id || '').trim();
      const sourceArtifact = String(item?.source_artifact_id || item?.artifact_id || '').trim();
      const authorityId = String(item?.authority_subject_id || '').trim();
      return (targetType === type || !targetType)
        && [targetId, id, sourceArtifact, authorityId].filter(Boolean).includes(raw);
    });
    return String(match?.target_scope_id || '').trim();
  };
  const resolve = (type, value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const planned = planTargetFor(type, raw);
    if (planned) return planned;
    const candidate = byType(type).find((item) => item.scope_id === raw);
    return candidate ? candidate.scope_id : '';
  };
  const resolveByName = (type, value) => {
    const key = norm(value);
    if (!key) return '';
    const matches = byType(type).filter((item) => norm(item.name) === key);
    return matches.length === 1 ? matches[0].scope_id : '';
  };
  const subjectTargetsFor = (type) => subjects
    .filter((item) => String(item?.target_scope_type || '').trim() === type)
    .map((item) => String(item?.target_scope_id || '').trim())
    .filter(Boolean);
  const typeTargets = (type) => [...new Set([
    ...byType(type).map((item) => item.scope_id),
    ...planAssets.filter((item) => String(item?.target_scope_type || '').trim() === type)
      .map((item) => String(item?.target_scope_id || '').trim()),
    ...subjectTargetsFor(type),
  ].filter(Boolean))];
  // Product authorities are represented as `product-*` scopes in the
  // execution plan but the legacy storyboard schema has no product_ids field.
  // They therefore travel through reference_asset_ids.  Keeping product as a
  // first-class lookup type prevents e-commerce/brand subjects from vanishing
  // when the text model omits a generic reference list.
  const productTargets = typeTargets('product');
  const implicitProductTargets = productTargets.length === 1 ? productTargets : [];
  const names = (value) => Array.isArray(value) ? value : [];
  const bindMany = (type, ids, named) => {
    const result = [];
    for (const id of names(ids)) {
      const resolved = resolve(type, typeof id === 'object' ? (id.id || id.scope_id || id.artifact_id) : id);
      if (resolved && !result.includes(resolved)) result.push(resolved);
    }
    for (const name of names(named)) {
      const resolved = resolveByName(type, typeof name === 'object' ? name.name : name);
      if (resolved && !result.includes(resolved)) result.push(resolved);
    }
    // A single available authority is safe to carry forward when the model
    // omitted the field. With multiple candidates, require an explicit name
    // or ID so two uploaded characters can never be conflated.
    if (!result.length && typeTargets(type).length === 1) result.push(typeTargets(type)[0]);
    return result;
  };
  next.character_ids = bindMany('character', next.character_ids, next.character_names);
  next.prop_ids = bindMany('prop', next.prop_ids, next.prop_names);
  let scene = resolve('scene', next.scene_id) || resolveByName('scene', next.scene_name);
  if (!scene && typeTargets('scene').length === 1) scene = typeTargets('scene')[0];
  next.scene_id = scene;
  const references = [];
  for (const id of [...next.reference_asset_ids || [], ...next.character_ids, next.scene_id, ...next.prop_ids, ...implicitProductTargets]) {
    const raw = String(id || '').trim();
    if (raw && !references.includes(raw)) references.push(raw);
  }
  next.reference_asset_ids = references;
  return next;
}
// Return informational gaps for the selected template.  These are surfaced
// in the import preview only; callers must not turn them into a submission
// gate because every slot is either optional or can be completed by the
// normal generation stages.
function missingInputSlots(plan) {
  if (!plan || typeof plan !== 'object') return [];
  const workflow = plan.workflow || workflowFor(plan.template_id);
  const assets = Array.isArray(plan.assets) ? plan.assets : [];
  const roles = new Set(assets.map((asset) => String(asset.role || '').trim()).filter(Boolean));
  const roleGroups = {
    subject: ['primary_subject_reference', 'character_reference', 'person_reference', 'product_reference'],
    person: ['primary_subject_reference', 'character_reference', 'person_reference'],
    characters: ['primary_subject_reference', 'character_reference', 'person_reference'],
    product: ['product_reference', 'primary_subject_reference'],
    outfit: ['outfit_reference'],
    action: ['action_reference', 'reference_video'],
    motion: ['action_reference', 'reference_video', 'visual_reference'],
    scene: ['scene_reference'],
    style: ['style_reference'],
    novel: ['source_document'],
    source: ['source_document', 'chart_reference'],
    transcript: ['source_document'],
    steps: ['source_document'],
    outline: ['source_document'],
    course: ['direct_clip'],
    recording: ['direct_clip'],
    clips: ['direct_clip'],
    clip: ['direct_clip'],
    existing_clip: ['direct_clip'],
    song: ['source_audio'],
    audio: ['source_audio'],
    guest: ['character_reference', 'primary_subject_reference', 'direct_clip'],
    photos: ['visual_reference', 'primary_subject_reference'],
  };
  return (workflow.input_slots || [])
    .filter((slot) => slot && slot.required === true)
    .filter((slot) => {
      const accepted = roleGroups[String(slot.id || '').trim()] || [];
      if (!accepted.length) return false;
      return !accepted.some((role) => roles.has(role));
    })
    .map((slot) => ({
      slot_id: String(slot.id || ''),
      label: String(slot.label || slot.id || '模板输入'),
      reason: `尚未发现可直接匹配“${String(slot.label || slot.id || '该输入')}”的已上传素材；可继续生成或稍后补充。`,
    }));
}
function getWorkflowSpec(id) { return workflowFor(id); }

module.exports = { PLAN_VERSION, SOURCE_TYPES, WORKFLOWS, getWorkflowSpec, buildExecutionPlan, resolveArtifactBindings, materialContext, bindShotReferences, missingInputSlots, stableId };
