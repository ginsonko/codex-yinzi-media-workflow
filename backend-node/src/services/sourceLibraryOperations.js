'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
const download = require('./mediaDownload');
const index = require('./mediaIndex');
const fail = (code, message) => Object.assign(new Error(message), {code});
function loadSharp(components) {
  const directory = components['media.sharp']?.directory;
  if (!directory) throw fail('PROBE_UNAVAILABLE', '图片探针组件尚未准备完成');
  return createRequire(path.join(directory, 'package.json'))('sharp');
}
function validateNumbers(parameters, limits) {
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (parameters[key] == null) continue;
    const n = Number(parameters[key]);
    if (!Number.isInteger(n) || n < min || n > max) throw fail('INVALID_PARAMETER', `${key} 应为 ${min}–${max} 的整数`);
  }
}
const downloadLimits = { max_items:[1,100], max_bytes_per_file:[1,10*1024**3], max_total_bytes:[1,100*1024**3], max_duration_seconds:[1,10800], timeout_ms:[1000,600000] };
const indexLimits = { max_files:[1,10000], max_depth:[1,20] };
function schema(limits, extras) { return {type:'object',properties:{...Object.fromEntries(Object.entries(limits).map(([k,[minimum,maximum]])=>[k,{type:'integer',minimum,maximum}])),...extras}}; }
const operations = [{
  id:'local.media.download', title:'公开素材下载与恢复', description:'按来源清单下载，校验实际媒体、保存来源和失败原因；网页抽取需要时自动准备 yt-dlp。',
  kind:'document', phase:'prepare', component_id:'media.ffmpeg', additional_components:['media.sharp'], output_extension:'json',
  source:'https://github.com/yt-dlp/yt-dlp', defaults:download.defaults,
  parameter_schema:schema(downloadLimits,{prefer_direct:{type:'boolean'},allowed_formats:{type:['array','null'],items:{type:'string'}}}),
  validateParameters(parameters) { validateNumbers(parameters,downloadLimits); },
  async executeNative(ctx) { validateNumbers(ctx.parameters,downloadLimits); return download.executeNative({...ctx,sharp:loadSharp(ctx.components)}); },
  validateResult(result) {
    if (result.summary.succeeded_count === 0) {
      const first = result.summary.items?.find(x=>x.status==='failed');
      throw fail(first?.error_code || 'DOWNLOAD_BATCH_FAILED', `下载未成功：${first?.error_message || '请查看作业目录 result.json 中的逐项结果'}`);
    }
  }
},{
  id:'local.media.index', title:'本地素材索引与去重', description:'有界扫描授权目录，提取技术规格、记录重复引用和损坏文件，复用未变更文件缓存。',
  kind:'document', phase:'analyze', component_id:'media.ffmpeg', additional_components:['media.sharp'], output_extension:'json',
  source:'https://ffmpeg.org/ffprobe.html', defaults:{max_files:2000,max_depth:10,follow_symlinks:false,compute_sha256:true,probe_media:true},
  parameter_schema:schema(indexLimits,{follow_symlinks:{type:'boolean'},compute_sha256:{type:'boolean'},probe_media:{type:'boolean'},include_kinds:{type:'array',items:{type:'string'}},cache_path:{type:'string'}}),
  validateParameters(parameters) { validateNumbers(parameters,indexLimits); },
  async executeNative(ctx) { validateNumbers(ctx.parameters,indexLimits); return index.executeNative({...ctx,sharp:loadSharp(ctx.components)}); }
}];
module.exports={operations};