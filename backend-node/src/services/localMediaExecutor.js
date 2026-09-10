const fs = require('node:fs');
const path = require('node:path');
const { getOperation } = require('./localMediaOperations');
const { createComponentManager, run, sha256, writeJson } = require('./componentRuntime');
async function execute(request, options = {}) {
  const op = getOperation(request.module_id); if (!op) throw Error('该合同尚无本地执行器');
  const input = path.resolve(request.input_path || '');
  const stat = fs.statSync(input); if (!stat.isFile() || !stat.size) throw Error('输入素材不是可读取的非空文件');
  fs.accessSync(input, fs.constants.R_OK);
  const dir = path.resolve(options.outputDir); fs.mkdirSync(dir, { recursive: true });
  const params = { ...op.defaults, ...(request.parameters || {}) };
  const manager = options.manager || createComponentManager();
  const report = options.onProgress || (() => {});
  report({ stage: 'preflight', message: '输入已就绪，正在准备所需组件' });
  const component = op.component_id ? await manager.ensureComponent(op.component_id, report) : { component_id: 'builtin', version: process.version, reused: true };
  const components = op.component_id ? { [op.component_id]: component } : {};
  for (const id of op.additional_components || []) components[id] = await manager.ensureComponent(id, report);
  if (request.input_identity) {
    const current=fs.statSync(input),expected=request.input_identity;
    if(current.size!==expected.size || current.mtimeMs!==expected.mtime_ms || current.ctimeMs!==expected.ctime_ms || current.ino!==expected.ino) throw Object.assign(Error('排队期间原素材已变化，请使用当前素材建立新处理请求'),{code:'INPUT_CHANGED'});
  }
  const inputHash = await sha256(input);
  report({ stage: 'executing', message: op.title + '，完成后自动检查成果' });
  // Keep the container/codec extension aligned with the Sharp operation. A
  // mismatched extension makes downstream previews and MIME sniffers report a
  // successful file that cannot actually be decoded as the advertised type.
  const imageExt = op.id.endsWith('.cmyk') || op.id.endsWith('.jpeg-quality') ? 'jpg'
    : op.id.endsWith('.webp-quality') ? 'webp'
    : op.id.endsWith('.convert') ? (params.format || 'webp')
    : 'png';
  const ext = op.output_extension || (op.kind === 'audio' ? 'wav' : op.kind === 'video' ? 'mp4' : imageExt);
  const output = path.join(dir, 'result.' + ext); let details;
  if (op.executeNative) {
    const perform = () => op.executeNative({ inputPath: input, outputPath: output, parameters: params, components, report });
    details = op.resource_group ? await manager.withResource(op.resource_group, perform) : await perform();
  } else if (op.kind === 'image' || op.processFile) {
    const workerInput = path.join(dir, 'image-job.json');
    writeJson(workerInput, { module_id: op.id, input_path: input, output_path: output, component_dir: component.directory,
      component_dirs: Object.fromEntries(Object.entries(components).map(([id, value]) => [id, value.directory])), parameters: params });
    const result = await run(process.execPath, [path.join(__dirname, 'localMediaWorker.js'), workerInput], { timeout: 120000 });
    details = JSON.parse(result.stdout);
  } else {
    const binaries = component.executables;
    const probe = async file => JSON.parse((await run(binaries.ffprobe, ['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
    const before = await probe(input), filter = op.build(params);
    if(op.id.endsWith('.reverse') && Number(before.format?.duration)>120) throw Object.assign(Error('倒放会缓存帧；请先将素材分为不超过 120 秒的片段，处理后拼接'),{code:'INPUT_SEGMENT_REQUIRED'});
    const args = ['-nostdin','-y','-v','error','-threads','2','-filter_threads','2','-protocol_whitelist','file,pipe','-i',input];
    const audioHandling = [];
    if (op.kind === 'video') {
      args.push('-map','0:v:0','-map','0:a?','-vf',filter,'-c:v','libx264','-threads','2','-preset','veryfast','-crf','20','-pix_fmt','yuv420p');
      let af;
      if (op.id.endsWith('.speed')) af = 'atempo=' + (params.speed || 1.5);
      if (op.id.endsWith('.trim')) af = 'atrim=start=' + (params.start ?? 0.1) + ':duration=' + (params.duration ?? 0.4) + ',asetpts=PTS-STARTPTS';
      if (op.id.endsWith('.reverse')) af = 'areverse';
      if (af) args.push('-af',af);
      for (const [index, stream] of before.streams.filter(s => s.codec_type === 'audio').entries()) {
        const copy = !af && ['aac', 'mp3', 'alac'].includes(stream.codec_name);
        args.push(`-c:a:${index}`, copy ? 'copy' : 'aac');
        audioHandling.push({ index, input_codec: stream.codec_name, mode: copy ? 'copy' : 'encode_aac', reason: af ? 'audio_filter' : copy ? 'preserve_original' : 'mp4_compatibility' });
      }
    } else args.push('-vn','-af',filter,'-c:a','pcm_s16le');
    args.push(output); await run(binaries.ffmpeg,args,{timeout:options.timeout || 10*60*1000});
    const after = await probe(output);
    if (!after.streams?.length || !(Number(after.format.duration)>0)) throw Error('输出媒体未通过可播放性检查');
    await run(binaries.ffmpeg,['-nostdin','-v','error','-i',output,'-f','null','-'],{timeout:120000});
    if (op.kind==='video' && before.streams.some(s=>s.codec_type==='audio') && !after.streams.some(s=>s.codec_type==='audio')) throw Error('输出意外缺少音轨');
    details = { before, after, ...(op.kind === 'video' ? { audio_handling: audioHandling } : {}) };
  }
  report({ stage: 'validating', message: '已生成成果，正在校验源文件和输出' });
  if (op.validateResult) op.validateResult(details, params);
  if (inputHash !== await sha256(input)) throw Error('原素材发生变化，需核对');
  const receipt = { schema_version:1,module_id:op.id,component_id:component.component_id,component_version:component.version,
    components: Object.values(components).map(value => ({ component_id: value.component_id, version: value.version, reused: Boolean(value.reused) })),
    component_reused:Boolean(component.reused),status:'succeeded',input_sha256:inputHash,output_sha256:await sha256(output),bytes:fs.statSync(output).size,
    output_path:output,parameters:params,details,verified_at:new Date().toISOString() };
  writeJson(path.join(dir,'receipt.json'),receipt); report({stage:'validated',message:'素材检查通过，正在保存成果记录'}); return receipt;
}
module.exports = { execute };
