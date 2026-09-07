const settings = require('./settingsService');
const KEY = 'codex_creative_preferences';
const PROFILES = Object.freeze({
  quality: { label: '质量优先', guidance: '以最终作品质量为首要目标。先研究受众、场景与优秀表达，比较创意方向后选择最合适方案；建立必要的一致性资产与镜头设计，精细处理构图、节奏、文字可读性、配音和配乐。逐项检查事实、画面、连续性和声音，对明显弱项主动返工，在已授权预算内完成精修。按任务需要选择步骤，不机械增加无关流程。' },
  balanced: { label: '均衡', guidance: '平衡质量、时间和费用。先明确受众与核心信息，优先复用可靠资产和模板；在关键镜头、核心卖点和声音体验上重点打磨。做一次覆盖全片的审查，针对影响交付的缺陷返工。' },
  speed: { label: '速度优先', guidance: '优先尽快交付清晰可用的作品。选择最短可行制作路径，复用已有素材、布局和成熟工具；减少非必要方案探索。保留事实核验、基本可读性、音画同步和可播放性检查，直接修复影响使用的缺陷。' },
});
function profile(value) { const id = value || 'quality'; if (!PROFILES[id]) throw Object.assign(new Error('质量档位应为 quality、balanced 或 speed'), { code:'QUALITY_PROFILE_INVALID' }); return { id,...PROFILES[id] }; }
function get(db) { const value=settings.getGlobalSetting(db,KEY,{quality_profile:'quality'}); return { quality_profile: PROFILES[value?.quality_profile] ? value.quality_profile : 'quality' }; }
function set(db,input={}) { const value={quality_profile:profile(input.quality_profile).id}; settings.setGlobalSetting(db,KEY,value);return value; }
module.exports={KEY,PROFILES,profile,get,set};
