import { validateShotIR, validateProfile } from './schema.mjs';
const mediaNames = { image:'图片', video:'视频', audio:'音频' };
export function compileShotIR(ir, profile, options = {}) {
  const errors = [validateShotIR(ir), validateProfile(profile)].flatMap(v => v.errors);
  if (errors.length) return {success:false, code:'INVALID_PROMPT_INPUT', errors, prompt:'', negative_prompt:'', loss_report:[]};
  const losses = [], unsupported = [], references = new Map();
  const report = (field, message, severity = 'warning') => losses.push({field, message, severity});
  const referenceConflicts = new Map();
  const identityFields = ['asset_id', 'path', 'url', 'sha256'];
  const identified = ref => identityFields.filter(field => ref[field]?.trim());
  const token = ref => (profile.reference_template || '@{type}{index}').replaceAll('{type}', mediaNames[ref.type || 'image'] || ref.type).replaceAll('{index}', String(ref.index));
  for (const shot of ir.shots) for (const ref of shot.references || []) {
    const key = `${ref.type || 'image'}:${ref.index}`;
    const previous = references.get(key);
    if (previous) {
      const common = identified(previous).filter(field => identified(ref).includes(field));
      const mismatched = common.filter(field => previous[field] !== ref[field]);
      if (referenceConflicts.has(key) || mismatched.length || (identified(previous).length && identified(ref).length && !common.length)) {
        const variants = referenceConflicts.get(key) || [{...previous}];
        variants.push({...ref});
        referenceConflicts.set(key, variants);
        report(`references.${key}`, `同一引用槽 ${token(ref)} 的素材身份冲突或无法确认相同；请提供相同资产ID/哈希，或使用不同序号。`, 'dropped');
        continue;
      }
      references.set(key, {...previous, ...ref});
    } else references.set(key, {...ref, type:ref.type || 'image'});
  }
  const refs = [...references.entries()].filter(([key]) => !referenceConflicts.has(key)).map(([,ref]) => ref);
  for (const [type, cap] of [['image','max_images'],['video','max_videos'],['audio','max_audios']]) {
    const count = refs.filter(r => r.type === type).length;
    if (profile[cap] != null && count > profile[cap]) report(`references.${type}`, `${mediaNames[type]} ${count} 个超过合同上限 ${profile[cap]}；素材未裁掉。`);
  }
  if (profile.max_total_references != null && refs.length > profile.max_total_references) report('references.count', `素材总数 ${refs.length} 超过合同上限 ${profile.max_total_references}；素材未裁掉。`);
  const starts = ir.shots.map(s => s.time?.start).filter(v => v != null);
  const duration = starts.length === ir.shots.length ? Math.max(...ir.shots.map(s => s.time.start + (s.time.duration || 0))) : ir.shots.reduce((sum, s) => sum + (s.time?.duration || 0), 0);
  if (duration > 0) {
    if (profile.duration_mode === 'fixed' && duration !== profile.fixed_duration_seconds) report('time.duration', `所选合同固定 ${profile.fixed_duration_seconds} 秒，分镜为 ${duration} 秒；转换器未修改时长。`);
    if (profile.duration_mode === 'range' && (duration < profile.duration_min || duration > profile.duration_max)) report('time.duration', `分镜 ${duration} 秒超出 ${profile.duration_min}–${profile.duration_max} 秒合同范围；请检查分段。`);
    if (profile.duration_mode === 'enumerated' && !profile.allowed_durations.includes(duration)) report('time.duration', `合同支持 ${profile.allowed_durations.join('/')} 秒，分镜为 ${duration} 秒；转换器未修改时长。`);
  }
  if (options.resolution && profile.supported_resolutions?.length && !profile.supported_resolutions.includes(options.resolution)) report('resolution', `合同未列出 ${options.resolution}；支持 ${profile.supported_resolutions.join('/')}。`);
  const hasFrameBinding = options.first_frame || options.last_frame || ir.shots.some(s => s.custom_extensions?.first_frame || s.custom_extensions?.last_frame || (s.references || []).some(r => ['first_frame','last_frame'].includes(r.role)));
  if (hasFrameBinding && profile.first_last_frame_supported !== true) {
    unsupported.push('first_last_frame');
    report('first_last_frame', profile.first_last_frame_supported === false ? '该合同不支持首尾帧角色；请改为普通参考或调整切镜。' : '首尾帧合同未知，绑定保留在IR，未转换为请求参数。');
  }
  if (profile.availability !== 'supported') report('profile.availability', `目标 ${profile.model_name} 的执行合同为 ${profile.availability}；生成可读分镜描述，具体控制效果待实际合同确认。`);
  const negative = ir.shots.map(s => s.negative).filter(Boolean);
  if (negative.length && profile.negative_prompt_supported !== true) report('negative', '独立负面参数未确认或不支持；全部约束保留在每镜正文。', 'info');
  const prompts = ir.shots.map((shot, index) => {
    const parts = [];
    if (ir.shots.length > 1) parts.push(`【镜头${shot.shot_id ?? index + 1}】`);
    if (shot.time?.start != null) parts.push(`起点：${shot.time.start}秒`);
    if (shot.time?.duration != null) parts.push(`时长：${shot.time.duration}秒`);
    if (shot.camera) {
      const camera = [shot.camera.shot_type, shot.camera.movement, shot.camera.description].filter(Boolean);
      if (camera.length) parts.push(`运镜：${[...new Set(camera)].join('，')}`);
    }
    if (shot.references?.length) parts.push(`参考：${shot.references.map(r => `${token(r)}${r.label || r.role ? `（${r.label || r.role}）` : ''}`).join(' ')}`);
    if (shot.subject?.trim()) parts.push(`画面：${shot.subject}`);
    if (shot.action?.trim()) parts.push(`动作：${shot.action}`);
    if (shot.style) parts.push(`风格：${shot.style}`);
    if (shot.audio?.description) parts.push(`声音：${shot.audio.description}`);
    if (shot.negative) parts.push(`约束：${shot.negative}`);
    if (!shot.subject?.trim() && !shot.action?.trim() && shot.raw_text) parts.push(`内容：${shot.raw_text}`);
    if (shot.unsupported?.length) { unsupported.push(...shot.unsupported); report(`shots.${index}.unsupported`, '原IR中有尚未支持的控制项，已保留以便人工或Agent处理。'); }
    if (shot.custom_extensions && Object.keys(shot.custom_extensions).length) report(`shots.${index}.custom_extensions`, '自定义控制保留在IR，通用编译器未把它们当作生成参数。');
    return parts.join('； ');
  });
  const prompt = prompts.join(profile.shot_separator || '\n\n');
  if (profile.max_prompt_length != null && [...prompt].length > profile.max_prompt_length) report('prompt.length', `提示词超过配置的 ${profile.max_prompt_length} 字符；文本完整保留。`);
  const success = !referenceConflicts.size && !(options.strict && losses.some(l => l.severity !== 'info'));
  return {
    success,
    ...(!success ? {code:referenceConflicts.size ? 'REFERENCE_CONFLICT' : 'PROMPT_CONTRACT_MISMATCH', errors:losses.filter(l => l.severity !== 'info').map(l => l.message)} : {}),
    prompt, negative_prompt: profile.negative_prompt_supported === true ? negative.join('; ') : '',
    loss_report:losses, unsupported:[...new Set(unsupported)], reference_manifest:refs.map(r => ({...r, token:token(r)})),
    reference_conflicts:[...referenceConflicts.entries()].map(([slot,variants]) => ({slot,variants})),
    metadata:{profile_id:profile.profile_id, model_name:profile.model_name, total_shots:ir.shots.length, total_references:refs.length, estimated_duration:duration || null, availability:profile.availability, contract_source:profile.contract_source || null, raw_text_provenance:ir.shots.map(s => s.raw_text).filter(Boolean), generation_submitted:false},
  };
}