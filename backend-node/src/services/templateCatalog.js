/**
 * Shared template catalog. Templates are prompt/rule metadata only; the
 * production runner remains the single execution engine for every template.
 */
const executionPlan = require('./templateExecutionPlan');
const TEMPLATE_DEFAULT_STYLE = 'CG 写实风格，电影级构图与真实材质；角色外观、服装、发型和道具保持严格一致，光照方向与色彩逻辑统一；镜头运动有明确动机，空间关系、动作先后和视线方向连续；细节清晰但不过度锐化，不出现多余人物、畸形肢体、漂移文字或不合剧情的装饰。';
const TEMPLATE_STYLE_HINTS = Object.freeze({
  ecommerce: 'CG 写实商品摄影，材质、包装、logo、颜色和文字严格依据素材，镜头干净明亮，突出一个卖点，不虚构价格或参数。',
  'outfit-change': 'CG 写实人物时尚展示，固定脸部、体态和发型，只改变服装与配饰；布料结构、接缝、褶皱和光照连续。',
  'dance-action': 'CG 写实动作影像，保持人物身份和场景锚点，动作节拍清晰，肢体比例正确，镜头运动服务于节奏。',
  'image-to-video': 'CG 写实参考生视频，严格保持主体外观、构图和光线，只执行明确描述的动作，避免背景和身份漂移。',
  'novel-drama': 'CG 写实叙事短剧，按剧本事实构建场景，人物、道具和空间连续，台词、动作和镜头逻辑一致。',
  'knowledge-explainer': 'CG 写实信息可视化，画面简洁、重点明确，数字和引用可追溯，不添加资料中没有的结论。',
  'travel-memory': 'CG 写实旅行纪录风格，尊重原始照片和视频中的地点、人物与时间关系，转场自然，不虚构事件。',
  'game-tutorial': 'CG 写实产品演示，界面文字、操作顺序和版本准确，镜头聚焦关键步骤，不遮挡按钮或提示。',
  'music-mv': 'CG 写实音乐影像，镜头切换贴合节拍，人物和场景保持一致，歌词与画面段落清晰对应。',
  'brand-promo': 'CG 写实品牌宣传，遵循品牌手册的色彩、logo 和语气，产品细节真实，未经确认不新增承诺。',
  'course-clipping': 'CG 写实课程切片，保留原始课程重点和时间关系，字幕与画面同步，不断章取义。',
  'podcast-video': 'CG 写实播客视觉化，保持说话人身份与观点原意，字幕和镜头按逐字稿时间关系组织。',
  'virtual-drama': 'CG 写实虚拟短剧，角色身份、服装、场景和声音锚点稳定，动作与空间关系连续，可复用已确认资产。',
});
const TEMPLATES = [
  ['ecommerce', '电商商品视频', '商品图、包装图、卖点、品牌规范', '展示商品事实、卖点与口播，价格/型号/logo/颜色不得虚构'],
  ['outfit-change', '换装与造型展示', '人物图、服装图、姿态图、场景图', '固定人物身份和镜头锚点，只改变服装、发型、体态或配饰'],
  ['dance-action', '舞蹈与动作参考', '动作视频、音乐、人物图、场景图', '提取节拍、关键姿态和动作强度，不默认复制他人身份或声音'],
  ['image-to-video', '图片/真人参考生视频', '主体图、构图图、首帧图、风格图', '提交前明确每张图片的角色，保持主体和构图一致'],
  ['novel-drama', '小说改漫剧', '小说文档、角色设定、画风参考', '事实与 AI 补写分层，章节、台词、画面和旁白可追溯'],
  ['knowledge-explainer', '知识与讲解口播', '资料、提纲、截图、图表', '结论、数字和引用必须可追溯，口播与字幕同步'],
  ['travel-memory', '旅行与活动回忆', '照片、视频、地点和日期资料', '按时间整理，地点、人物关系和事件不凭空补写'],
  ['game-tutorial', '游戏/产品教程', '录屏、步骤文档、界面截图', '操作顺序、版本号和 UI 文本保持准确'],
  ['music-mv', '音乐 MV', '歌曲、歌词、人物图、风格参考', '按节拍设计镜头，歌词和画面段落可对齐'],
  ['brand-promo', '企业与品牌宣传', '品牌手册、产品图、宣传文案', '遵守品牌色、logo 和合规文案，未经确认不新增承诺'],
  ['course-clipping', '课程切片', '课程视频、讲义、章节目录', '从原始课程提取重点，保留章节和引用时间码'],
  ['podcast-video', '播客转视频', '播客音频、逐字稿、嘉宾图', '保留说话人和时间关系，字幕不擅自改写观点'],
  ['virtual-drama', '虚拟角色短剧', '角色设定、场景设定、声音与风格参考', '维护角色锚点、场景连贯和可复用资产版本'],
].map(([id, name, inputs, guardrail]) => Object.freeze({
  id, version: 1, name, description: `${name}模板`, inputs: inputs.split('、'),
  slots: inputs.split('、').map((label, index) => ({ id: `${id}-slot-${index + 1}`, label, required: index === 0 })),
  output_stages: Object.freeze(['script', 'asset_text', 'asset_images', 'storyboard_plan', 'shot_video', 'final_edit']),
  prompt_key: `template.${id}.v1`, guardrails: [guardrail], examples: { positive: `按${name}模板提供事实和参考素材`, negative: '不要臆造文件中没有的事实或静默替换已确认素材' },
  defaults: { target_shots: executionPlan.getWorkflowSpec(id)?.default_shots || 1, style: TEMPLATE_STYLE_HINTS[id] || TEMPLATE_DEFAULT_STYLE, max_seconds: 60 },
  workflow: executionPlan.getWorkflowSpec(id),
}));
const BY_ID = new Map(TEMPLATES.map((item) => [item.id, item]));
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function listTemplates(query = {}) {
  const q = String(query.q || '').trim().toLowerCase();
  const items = q ? TEMPLATES.filter((item) => `${item.id} ${item.name} ${item.description}`.toLowerCase().includes(q)) : TEMPLATES;
  return { schema_version: 1, items: clone(items), total: items.length };
}
function getTemplate(id) { return clone(BY_ID.get(String(id || '').trim()) || null); }
module.exports = { TEMPLATES, listTemplates, getTemplate };
