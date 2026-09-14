const fs = require('node:fs');
const path = require('node:path');
const bridge = require('./afterEffectsJob');
module.exports = {
  id: 'local.ae.compose', title: 'After Effects 可见关键帧与专业合成', kind: 'document',
  description: '在本机 AE 编辑器中执行结构化工程：素材、合成、图层、摄像机、关键帧缓动、蒙版、效果、时间重映射与渲染；保留可编辑 AEP 和原工程恢复副本。AE 须已安装。',
  component_id: null, output_extension: 'json', resource_group: 'after-effects-editor',
  source: 'https://ae-scripting.docsforadobe.dev/', defaults: {},
  inputs: ['input_path: AE job JSON', 'parameters'],
  parameter_schema: { type:'object', properties:{} },
  async executeNative({inputPath, outputPath, report}) {
    const job=JSON.parse(fs.readFileSync(inputPath,'utf8').replace(/^\uFEFF/,''));
    report({stage:'ae_dispatch',message:'正在可见的 After Effects 窗口中执行工程'});
    const result=await bridge.execute(job,path.join(path.dirname(outputPath),'after-effects'));
    if(result.status==='failed')throw Object.assign(Error(result.error),{code:'AE_SCRIPT_FAILED'});
    fs.writeFileSync(outputPath,JSON.stringify(result,null,2));
    return {...result,quality_status:job.render?'review_required':'engineering_result',quality_note:'AE 回执与实际工程已核对；成片构图、运动和声音需独立查看。'};
  }
};