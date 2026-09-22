// Prepare a separate editor copy. Never mutate Jianying's home index or an
// already prepared copy: the editor may rewrite/encrypt its saved project.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function discoverDraftRoot(config = {}, env = process.env, platform = process.platform) {
  const choices = [], warnings = [];
  if (config.drafts_root) choices.push({ path: path.resolve(path.dirname(config.config_path), config.drafts_root), source: 'configuration' });
  if (platform === 'win32' && env.LOCALAPPDATA) {
    const data = path.join(env.LOCALAPPDATA, 'JianyingPro', 'User Data');
    try {
      const ini = fs.readFileSync(path.join(data, 'Config', 'globalSetting'), 'utf8');
      const match = ini.match(/^\s*currentCustomDraftPath\s*=\s*(.*?)\s*$/m);
      if (match?.[1]) {
        // Qt INI string values may use doubled backslashes. Do not interpret
        // arbitrary escapes or expand environment/shell expressions.
        const value = match[1].replace(/^"(.*)"$/, '$1').replace(/\\\\/g, '\\');
        if (path.isAbsolute(value)) choices.push({ path: value, source: 'jianying_settings' });
      }
    } catch (e) { if (e.code !== 'ENOENT') warnings.push({ source: 'jianying_settings', error: e.message }); }
    choices.push({ path: path.join(data, 'Projects', 'com.lveditor.draft'), source: 'default_existing_directory' });
  }
  // A configured/custom location that is unavailable must not silently route
  // into a different old directory that Jianying is no longer using.
  const selected = choices[0];
  if (!selected) return { ready: false, path: null, source: null, warnings, reason: '未找到剪映草稿位置，可在配置中填写 drafts_root。' };
  try {
    if (!fs.statSync(selected.path).isDirectory()) throw new Error('草稿位置不是文件夹');
    return { ready: true, ...selected, warnings };
  } catch (e) { return { ready: false, ...selected, warnings, reason: `当前草稿位置不可用：${e.message}` }; }
}

function files(root) {
  const result = [];
  function visit(folder) {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) throw new Error('工程副本不跟随符号链接');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) result.push(file);
      else throw new Error('工程包含不支持的文件类型');
    }
  }
  visit(root); return result;
}

function prepareEditorCopy(result, location) {
  const fallback = reason => ({ status: 'manual_location_needed', reason, draft_path: result.draft_path,
    project_name: result.project_name || path.basename(result.draft_path), next_action: `工程已保存在 ${result.draft_path}。${reason} 由宿主补齐草稿位置后再接续；不要使用素材导入窗口打开 JSON。` });
  if (!location.ready) return fallback(location.reason || '未找到可用的剪映草稿目录。');
  let staging;
  try {
    const meta = readJson(path.join(result.draft_path, 'draft_meta_info.json'));
    const title = String(meta.draft_name || result.project_name || '银子剪映工程');
    const safeName = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 64) || '银子剪映工程';
    const suffix = crypto.createHash('sha256').update(String(result.draft_id)).digest('hex').slice(0, 12);
    const projectName = `${safeName}-${suffix}`;
    const target = path.join(location.path, projectName);
    const markerName = 'yinzi-editor-copy.json';
    const sourceIdentity = crypto.createHash('sha256').update(JSON.stringify(files(result.draft_path).sort().map(f => [path.relative(result.draft_path, f), digest(f)]))).digest('hex');
    if (fs.existsSync(target)) {
      let prior; try { prior = readJson(path.join(target, markerName)); } catch (_) { /* Never overwrite another directory. */ }
      if (prior?.source_identity !== sourceIdentity || prior?.draft_id !== result.draft_id) return fallback(`同名目录已存在且不属于本次工程：${target}。已保留它，不会覆盖。`);
      // The editor may encrypt these files, so verify presence without parsing
      // or comparing their contents to the generated master.
      for (const name of ['draft_content.json', 'draft_meta_info.json']) {
        const file = path.join(target, name);
        if (!fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size === 0) {
          return fallback(`已有编辑器副本缺少完整的 ${name}：${target}。请先检查或恢复该副本，原始工程仍保留。`);
        }
      }
      return { status: 'editor_copy_prepared', draft_path: target, project_name: projectName, reused: true,
        note: '沿用独立副本，保留剪映中已保存的用户修改。', next_action: `在剪映首页打开「${projectName}」，预览后导出。若首页尚未刷新，返回首页后重新查看；不要从素材导入窗口打开 JSON。` };
    }
    // Stage alongside the drafts directory so Jianying cannot discover an
    // incomplete draft. Rename on the same volume; never replace a target.
    staging = fs.mkdtempSync(path.join(path.dirname(location.path), '.yinzi-jianying-'));
    fs.cpSync(result.draft_path, staging, { recursive: true, force: false, errorOnExist: true,
      filter: source => source !== path.join(result.draft_path, markerName) });
    const copiedMeta = { ...meta, draft_name: projectName, draft_fold_path: target, draft_root_path: location.path };
    fs.writeFileSync(path.join(staging, 'draft_meta_info.json'), JSON.stringify(copiedMeta, null, 2));
    fs.writeFileSync(path.join(staging, markerName), JSON.stringify({ draft_id: result.draft_id, source_identity: sourceIdentity, source_path: result.draft_path, created_at: new Date().toISOString() }, null, 2), { flag: 'wx' });
    if (fs.existsSync(target)) return fallback(`工程目录刚被其它进程创建：${target}，未覆盖。`);
    fs.renameSync(staging, target); staging = null;
    return { status: 'editor_copy_prepared', draft_path: target, project_name: projectName, reused: false,
      note: '已准备剪映草稿位置的独立副本；首页收录、载入和导出需分别核对。',
      next_action: `工程已放入剪映草稿位置。在首页打开「${projectName}」，预览后导出；素材导入窗口不能打开工程 JSON。` };
  } catch (e) { return fallback(`自动准备剪映副本未完成：${e.message}。`); }
  finally { if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch (_) { /* scoped staging only */ } } }
}

module.exports = { discoverDraftRoot, prepareEditorCopy };
