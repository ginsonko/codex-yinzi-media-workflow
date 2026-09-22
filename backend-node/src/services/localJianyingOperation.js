const fs = require('node:fs');
const bridge = require('./jianyingDraft');
const common = { kind: 'document', output_extension: 'json', component_id: null,
  source: 'https://github.com/GuanYixuan/pyJianYingDraft', defaults: {},
  side_effects: { network: false, launches_editor: false, edits_originals: false },
  parameter_schema: { type: 'object', properties: {} } };
const operations = [
  { ...common, id: 'local.jianying.inspect', title: '剪映：环境与草稿能力探测',
    outputs: ['environment_report', 'execution_receipt'],
    parameter_schema: { type: 'object', properties: {
      preset_type: { type: 'string', enum: ['filter', 'transition', 'text_intro', 'text_outro', 'text_loop', 'font', 'clip_intro', 'clip_outro', 'clip_group', 'keyframe'] },
      query: { type: 'string', default: '' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
    } },
    description: '只读探测剪映安装和隔离草稿依赖；不会打开应用、下载模板或上传素材。安装存在不代表已验证导出。',
    inputs: ['input_path: 本地探测请求 JSON（可为空对象）'],
    async executeNative({ outputPath, parameters = {} }) {
      const result = await bridge.inspect({ preset_type: parameters.preset_type, query: parameters.query, limit: parameters.limit });
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2)); return result;
    } },
  { ...common, id: 'local.jianying.draft', title: '剪映：可编辑时间线与模板副本',
    side_effects: { ...common.side_effects, prepares_editor_copy: true },
    parameter_schema: { type: 'object', properties: { prepare_editor: { type: 'boolean', default: true, description: '将独立副本放入已探测的剪映草稿位置；关闭时仅生成工程。不会改写首页索引或已有草稿。' } } },
    validateParameters(parameters) { if (parameters.prepare_editor != null && typeof parameters.prepare_editor !== 'boolean') throw Object.assign(new Error('prepare_editor 应为 true 或 false'), { code: 'JIANYING_INVALID_PARAMETER' }); },
    outputs: ['editable_draft', 'execution_receipt'],
    description: '生成独立剪映工程，支持剪辑、字幕、关键帧、滤镜/转场资源引用，以及合法明文模板的文字与素材替换。结果是草稿；需在剪映确认资源并真实导出验片。',
    inputs: ['input_path: 剪映 job JSON（相对路径以 JSON 所在目录为基准）'],
    async executeNative({ inputPath, outputPath, report, parameters = {} }) {
      const result = await bridge.execute(inputPath, outputPath, { report, prepareEditor: parameters.prepare_editor !== false });
      return { ...result, quality_status: 'engineering_result', quality_note: '草稿数据通过检查；应用载入、预设效果、收费状态、导出和视觉质量尚需独立验证。' };
    } }
];
module.exports = { operations };
