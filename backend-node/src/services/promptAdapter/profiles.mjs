import { validateProfile } from './schema.mjs';
import referenceContracts from '../yinziVideoReferenceContracts.js';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const unknown = {
  availability: 'unknown', duration_mode: 'unknown',
  first_last_frame_supported: null, negative_prompt_supported: null,
  max_prompt_length: null, reference_template: '@{type}{index}',
  supported_resolutions: [], capabilities: {},
};
export const TARGET_PROFILES = freeze({
  'seedance-2.5': {
    ...unknown, profile_id: 'seedance-2.5', model_name: 'Seedance 2.5',
    availability: 'supported', duration_mode: 'range', duration_min: 4, duration_max: 30,
    supported_resolutions: ['480p', '720p', '1080p'], default_resolution: '720p',
    max_images: 30, max_videos: 10, max_audios: 10, max_total_references: 50,
    ...referenceContracts.SEEDANCE_25_REFERENCE_CONTRACT,
    contract_source: { kind: 'user_supplied_channel_contract', observed_at: '2026-09-14', model: 'Seedance 2.5' },
    notes: '按所选渠道的已确认合同编译；部署到其它渠道时以实际模型合同覆盖。负面参数和字符上限尚未确认，约束保留在正文。',
  },
  'seedance-2.5-720': {
    ...unknown, profile_id: 'seedance-2.5-720', model_name: 'Seedance 2.5-720',
    availability: 'supported', duration_mode: 'fixed', fixed_duration_seconds: 30,
    supported_resolutions: ['720p'],
    contract_source: { kind: 'historical_channel_contract', observed_at: '2026-09-13' },
    notes: '历史精确型号合同；与新 Seedance 2.5 独立，引用上限保留未知。',
  },
  'seedance-2.0': {
    ...unknown, profile_id: 'seedance-2.0', model_name: 'Seedance 2.0',
    notes: '精确型号与历史 -720 别名独立。请用当前渠道的可配置合同，不从旧别名推断时长。',
  },
  'seedance-2.0-720': {
    ...unknown, profile_id: 'seedance-2.0-720', model_name: 'Seedance 2.0-720',
    availability: 'supported', duration_mode: 'enumerated', allowed_durations: [5, 10, 15],
    supported_resolutions: ['720p'],
    contract_source: { kind: 'historical_channel_contract', observed_at: '2026-09-13' },
  },
  'minimax-h3': {
    ...unknown, profile_id: 'minimax-h3', model_name: 'MiniMax H3',
    notes: '用户名称尚无已核实官方合同或离线权重依据。可编译通用镜头描述并覆盖profile，不承诺本地运行或模型同效果。',
  },
});
const customRegistry = new Map();
export function getProfile(id) {
  const normalized = String(id || '').trim().toLowerCase();
  const alias = normalized.replace(/^seedance\s*(?=2\.)/, 'seedance-').replace(/^minimax\s+h3$/, 'minimax-h3');
  return customRegistry.get(normalized) || customRegistry.get(alias) || TARGET_PROFILES[alias] || (normalized === 'h3' ? TARGET_PROFILES['minimax-h3'] : null);
}
export function registerCustomProfile(profile) {
  const validation = validateProfile(profile);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  const copy = structuredClone(profile);
  copy.profile_id = copy.profile_id.trim().toLowerCase();
  customRegistry.set(copy.profile_id, freeze(copy));
}
export function listProfiles() {
  return [...new Map([...Object.values(TARGET_PROFILES), ...customRegistry.values()].map(p => [p.profile_id, p])).values()];
}
