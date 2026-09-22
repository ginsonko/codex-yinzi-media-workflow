const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const SCRIPT = path.resolve(__dirname, '../../scripts/jianying-draft.py');
const { discoverDraftRoot, prepareEditorCopy } = require('./jianyingDelivery');
const fail = (code, message) => Object.assign(new Error(message), { code });
const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { throw fail('JIANYING_INVALID_JSON', `无法读取明文 JSON：${file} (${e.message})`); }
};
const hash = file => {
  const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buf = Buffer.alloc(1024 * 1024);
  try { let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null))) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
};
function resolveLocal(value, base, label) {
  if (typeof value !== 'string' || !value.trim() || /^(?:[a-z]+:\/\/|file:)/i.test(value)) {
    throw fail('JIANYING_LOCAL_PATH_REQUIRED', `${label} 必须是本地路径，工具不会下载或上传素材`);
  }
  return path.resolve(base, value);
}
function filesIn(root) {
  const out = [];
  function walk(p) {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) throw fail('JIANYING_SYMLINK_UNSUPPORTED', `模板不能包含符号链接或目录联接：${p}`);
    if (st.isDirectory()) for (const item of fs.readdirSync(p).sort()) walk(path.join(p, item));
    else if (st.isFile()) out.push(p);
    else throw fail('JIANYING_INPUT_INVALID', `不是普通文件：${p}`);
  }
  walk(root);
  return out;
}
// A template is copied as a whole; track every copied file and external resource.
// Resource identifiers/URLs remain references and are not silently downloaded.
function templateReferences(value, base, out = []) {
  if (Array.isArray(value)) for (const item of value) templateReferences(item, base, out);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if ((key === 'path' || key.endsWith('_path')) && typeof item === 'string' && item.trim() && !/^[a-z]+:\/\//i.test(item)) {
      const p = resolveLocal(item, base, `模板 ${key}`);
      if (!fs.existsSync(p)) throw fail('JIANYING_TEMPLATE_RESOURCE_MISSING', `模板依赖不存在：${p}`);
      out.push(...filesIn(p));
    } else if (key === 'content' && typeof item === 'string' && item.trim().startsWith('{')) {
      let parsed; try { parsed = JSON.parse(item); } catch (_) { /* Not all content values are JSON. */ }
      if (parsed) templateReferences(parsed, base, out);
    } else if (item && typeof item === 'object') templateReferences(item, base, out);
  }
  return out;
}
function readJob(inputPath) {
  const job = json(inputPath);
  if (!job || Array.isArray(job) || typeof job !== 'object') throw fail('JIANYING_INVALID_JOB', 'job 必须是 JSON 对象');
  const base = path.dirname(path.resolve(inputPath));
  for (const field of ['clips', 'texts', 'subtitles']) if (job[field] != null && !Array.isArray(job[field])) throw fail('JIANYING_INVALID_JOB', `${field} 必须是数组`);
  for (const clip of job.clips || []) clip.path = resolveLocal(clip.path, base, 'clip.path');
  for (const sub of job.subtitles || []) sub.path = resolveLocal(sub.path, base, 'subtitles.path');
  if (job.template) {
    const original = resolveLocal(job.template.path, base, 'template.path');
    job.template.path = fs.statSync(original).isDirectory() ? original : path.dirname(original);
    if (!fs.statSync(original).isDirectory() && path.basename(original) !== 'draft_content.json') {
      throw fail('JIANYING_TEMPLATE_INVALID', '模板请选择草稿目录或 draft_content.json');
    }
    const content = json(path.join(job.template.path, 'draft_content.json'));
    if (!content.materials || !Array.isArray(content.tracks) || !content.canvas_config) {
      throw fail('JIANYING_TEMPLATE_INVALID', '模板不是可识别的明文剪映草稿，不会尝试解密或调用内部接口');
    }
    for (const replacement of job.template.media_replacements || []) {
      replacement.path = resolveLocal(replacement.path, base, 'media_replacements.path');
    }
  }
  return job;
}
function sourcesForJob(inputPath) {
  const job = readJob(inputPath), out = [];
  const add = (role, p) => { if (!out.some(v => v.path === p)) out.push({ role, path: p }); };
  for (const item of job.clips || []) add('jianying_media', item.path);
  for (const item of job.subtitles || []) add('jianying_subtitles', item.path);
  if (job.template) {
    for (const file of filesIn(job.template.path)) add('jianying_template', file);
    const content = json(path.join(job.template.path, 'draft_content.json'));
    for (const file of templateReferences(content.materials, job.template.path)) add('jianying_template_media', file);
    for (const item of job.template.media_replacements || []) add('jianying_replacement', item.path);
  }
  return out;
}
function snapshot(inputPath) {
  return [{ role: 'job', path: path.resolve(inputPath) }, ...sourcesForJob(inputPath)].map(item => {
    const stat = fs.statSync(item.path);
    if (!stat.isFile() || !stat.size) throw fail('JIANYING_INPUT_INVALID', `需要非空普通文件：${item.path}`);
    return { ...item, size: stat.size, sha256: hash(item.path) };
  });
}
function configFile(options = {}) {
  return path.resolve(options.configPath || process.env.YINZI_JIANYING_CONFIG || path.join(os.homedir(), '.yinzi-media/jianying.json'));
}
function config(options = {}) {
  const file = configFile(options), exists = fs.existsSync(file), cfg = exists ? json(file) : {};
  const base = path.dirname(file);
  return { ...cfg, config_path: file, config_exists: exists,
    python: options.python || (cfg.python ? resolveLocal(cfg.python, base, 'config.python') : null),
    executable: process.env.YINZI_JIANYING_PATH || (cfg.executable ? resolveLocal(cfg.executable, base, 'config.executable') : null) };
}
async function probePython(python) {
  if (!python) return { ready: false, error: '未安装草稿依赖；运行 setup-jianying.py 创建独立环境' };
  try {
    const { stdout } = await runFile(python, [SCRIPT, 'probe'], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
    return JSON.parse(stdout.trim());
  } catch (e) { return { ready: false, error: String(e.stderr || e.message).slice(0, 2000) }; }
}
async function inspect(options = {}) {
  const cfg = config(options), candidates = [], add = p => { if (p && fs.existsSync(p) && !candidates.includes(p)) candidates.push(p); };
  add(cfg.executable);
  if (process.platform === 'win32') {
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      add(path.join(root, 'JianyingPro/JianyingPro.exe'));
    }
    // Windows reg.exe uses a legacy codepage. Read Chinese paths through UTF-8
    // PowerShell JSON instead; do not execute the registered command.
    try {
      const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; $p='Registry::HKEY_CLASSES_ROOT\\.JYPack'; $id=(Get-ItemProperty -LiteralPath $p).'(default)'; $command=(Get-ItemProperty -LiteralPath ('Registry::HKEY_CLASSES_ROOT\\'+$id+'\\shell\\open\\command')).'(default)'; ConvertTo-Json -InputObject $command -Compress`;
      const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      const match = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')).match(/^"([^"]+\.exe)"/i); if (match) add(match[1]);
    } catch (_) { /* Absence is a normal inspection result. */ }
  }
  let editorVersion = null;
  if (process.platform === 'win32' && candidates[0]) {
    try {
      const quoted = candidates[0].replace(/'/g, "''");
      const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); (Get-Item -LiteralPath '${quoted}').VersionInfo | Select-Object FileVersion,ProductVersion | ConvertTo-Json -Compress`;
      const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
      editorVersion = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''));
    } catch (_) { /* Version may be unavailable for a launcher. */ }
  }
  const dependency = await probePython(cfg.python);
  let presets;
  if (options.preset_type) {
    if (!dependency.ready) throw fail('JIANYING_SETUP_REQUIRED', '预设索引需要先准备隔离草稿依赖');
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('JIANYING_INVALID_LIMIT', '预设查询 limit 应为 1–100 的整数');
    try {
      const { stdout } = await runFile(cfg.python, [SCRIPT, 'catalog', '--type', String(options.preset_type), '--query', String(options.query || ''), '--limit', String(limit)], { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' } });
      presets = JSON.parse(stdout.trim());
    } catch (e) {
      let detail; try { detail = JSON.parse(e.stdout?.trim()); } catch (_) { /* startup failure */ }
      throw fail(detail?.code || 'JIANYING_CATALOG_FAILED', detail?.error || e.message);
    }
  }
  const draftLocation = discoverDraftRoot(cfg);
  return { status: 'inspected', stage: 'environment_inspected', platform: process.platform, config_path: cfg.config_path,
    config_exists: cfg.config_exists, executable: candidates[0] || null, installation_candidates: candidates, editor_version: editorVersion,
    dependency, draft_location: draftLocation, ...(presets ? { presets } : {}), draft_ready: dependency.ready === true, editor_load_verified: false, export_verified: false,
    note: '探测成功不代表新版剪映能自动打开、应用在线资源或导出；安装剪映与草稿依赖是两件事。',
    setup_script: path.resolve(__dirname, '../../scripts/setup-jianying.py') };
}
function saveReceipt(outputPath, value) {
  const temp = `${outputPath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
    fs.renameSync(temp, outputPath);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
async function execute(inputPath, outputPath, options = {}) {
  const report = options.report || (() => {}), before = snapshot(inputPath), job = readJob(inputPath), cfg = config(options);
  if (!cfg.python) throw fail('JIANYING_SETUP_REQUIRED', '请先运行 setup-jianying.py 安装隔离草稿依赖，或配置 YINZI_JIANYING_CONFIG');
  const identity = crypto.createHash('sha256').update(JSON.stringify({ sources: before, python: cfg.python, adapter: 1 })).digest('hex');
  if (fs.existsSync(outputPath)) {
    const prior = json(outputPath);
    if (prior.input_identity !== identity || prior.stage !== 'draft_ready') throw fail('JIANYING_OUTPUT_CONFLICT', '该输出已属于不同输入；请为修改后的任务选择新的输出路径');
    for (const artifact of prior.artifacts || []) {
      if (!fs.existsSync(artifact.path) || hash(artifact.path) !== artifact.sha256) throw fail('JIANYING_OUTPUT_CHANGED', '已有工程被修改或缺失，不会覆盖用户编辑，请建立新的输出任务');
    }
    if (!prior.artifacts?.length) throw fail('JIANYING_OUTPUT_INVALID', '已有回执缺少工程验证记录');
    if (options.prepareEditor === true) {
      const deliveryLock = outputPath + '.jianying.lock'; let fd;
      try { fd = fs.openSync(deliveryLock, 'wx'); }
      catch (e) { if (e.code === 'EEXIST') throw fail('JIANYING_BUSY', '工程接续正在进行，请读取原任务进度'); throw e; }
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
        const delivery = prepareEditorCopy(prior, discoverDraftRoot(cfg));
        const updated = { ...prior, editor_delivery: delivery, next_action: delivery.next_action };
        saveReceipt(outputPath, updated);
        return { ...updated, reused: true };
      } finally { fs.closeSync(fd); fs.unlinkSync(deliveryLock); }
    }
    return { ...prior, reused: true };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const lockPath = outputPath + '.jianying.lock'; let lock;
  try { lock = fs.openSync(lockPath, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw fail('JIANYING_BUSY', '该输出已有草稿任务在处理；先核对原任务，不会并行重写'); throw e; }
  const buildId = crypto.randomUUID(), root = path.join(path.dirname(outputPath), 'jianying-drafts');
  const normalizedPath = path.join(path.dirname(outputPath), `jianying-job-${buildId}.json`);
  let result;
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
    if (fs.existsSync(outputPath)) throw fail('JIANYING_OUTPUT_CONFLICT', '输出刚刚已被其它任务创建，请重新读取');
    fs.writeFileSync(normalizedPath, JSON.stringify(job, null, 2), { flag: 'wx' });
    report({ stage: 'jianying_draft_build', message: '正在创建独立剪映草稿，原始素材与模板保持不变' });
    let stdout;
    try {
      ({ stdout } = await runFile(cfg.python, [SCRIPT, 'build', '--job', normalizedPath, '--output-root', root, '--id', buildId], {
        encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONUTF8: '1' }
      }));
    } catch (e) {
      let detail; try { detail = JSON.parse(e.stdout?.trim()); } catch (_) { /* Child startup errors have no JSON. */ }
      throw fail(detail?.code || 'JIANYING_DRAFT_FAILED', detail?.error || String(e.stderr || e.message).slice(0, 4000));
    }
    result = JSON.parse(stdout.trim());
    const after = snapshot(inputPath);
    if (JSON.stringify(before) !== JSON.stringify(after)) throw fail('JIANYING_INPUT_CHANGED', '生成期间输入素材或模板发生变化；已保留候选目录，但不会报告成功');
    if (result.stage !== 'draft_ready' || !result.draft_path) throw fail('JIANYING_DRAFT_INVALID', '草稿脚本未返回可验证的工程');
    const artifacts = filesIn(result.draft_path).map(file => ({ path: file, sha256: hash(file), size: fs.statSync(file).size }));
    const value = { ...result, input_identity: identity, sources: before, artifacts, reused: false,
      normalized_job_path: normalizedPath, created_at: new Date().toISOString() };
    // Persist the stable draft identity before creating an editor-owned copy.
    // If the delivery receipt cannot be saved, a retry recovers this master
    // and the same editor copy instead of generating another UUID/project.
    saveReceipt(outputPath, value);
    if (options.prepareEditor === true) {
      report({ stage: 'jianying_editor_copy', message: '正在为剪映准备独立工程副本，保留原始工程和用户已有草稿' });
      value.editor_delivery = prepareEditorCopy(value, discoverDraftRoot(cfg));
      value.next_action = value.editor_delivery.next_action;
      saveReceipt(outputPath, value);
    }
    report({ stage: 'draft_ready', message: '剪映工程已准备；接下来需要在应用内载入、确认效果资源并导出验片', path: result.draft_path });
    return value;
  } finally { if (lock !== undefined) fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
module.exports = { sourcesForJob, readJob, snapshot, inspect, execute, configFile };
if (require.main === module) {
  const [command, input, output, extra] = process.argv.slice(2);
  const action = command === 'inspect' ? inspect() : command === 'catalog' && input ? inspect({ preset_type: input, query: output || '', limit: extra ? Number(extra) : 20 }) : command === 'run' && input && output ? execute(path.resolve(input), path.resolve(output), { prepareEditor: extra !== '--draft-only' }) : null;
  if (!action) {
    process.stderr.write('Usage: node jianyingDraft.js inspect | catalog TYPE [QUERY] [LIMIT] | run JOB.json OUTPUT.json [--draft-only]\n'); process.exitCode = 2;
  } else action.then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(err => {
    process.stderr.write(JSON.stringify({ status: 'failed', code: err.code || 'JIANYING_FAILED', error: err.message }) + '\n'); process.exitCode = 1;
  });
}
