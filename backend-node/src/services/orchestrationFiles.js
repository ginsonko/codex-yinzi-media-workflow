const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function fileError(code, message) { return Object.assign(new Error(message), { code }); }

function absolutePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) {
    throw fileError('LOCAL_PATH_INVALID', '请提供本机绝对路径');
  }
  return path.resolve(value);
}

function workDirectory(source = {}) {
  const value = source.work_dir || source.output_dir || source.cwd;
  if (!value) return null;
  try {
    const target = absolutePath(value);
    return { path: target, exists: fs.existsSync(target) && fs.statSync(target).isDirectory() };
  } catch { return { path: String(value), exists: false }; }
}

function prepareLocalArtifact(input) {
  const target = absolutePath(input.path);
  let stat;
  try { stat = fs.statSync(target); } catch { throw fileError('ARTIFACT_FILE_MISSING', '成果文件尚未落盘，请在写入完成后登记'); }
  if (!stat.isFile() || stat.size === 0) throw fileError('ARTIFACT_FILE_INCOMPLETE', '成果必须是已写入的非空文件');
  const canonical = fs.realpathSync(target);
  return { ...input, bytes: stat.size, path: target, validation: {
    ...input.validation,
    local_file: { canonical_path: canonical, bytes: stat.size, mtime_ms: stat.mtimeMs },
  } };
}

function artifactFile(artifact) {
  const saved = artifact?.validation?.local_file;
  if (!saved || !artifact.path) throw fileError('ARTIFACT_FILE_UNAVAILABLE', '此成果没有已登记的本地文件');
  const target = absolutePath(artifact.path);
  let stat, canonical;
  try { canonical = fs.realpathSync(target); stat = fs.statSync(target); }
  catch { throw fileError('ARTIFACT_FILE_MISSING', '成果文件已移动或删除'); }
  if (canonical !== saved.canonical_path || !stat.isFile() || stat.size !== saved.bytes || stat.mtimeMs !== saved.mtime_ms) {
    throw fileError('ARTIFACT_FILE_CHANGED', '文件已变化，请登记新版本后预览');
  }
  return canonical;
}

function isLoopback(address = '') { return ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost', '[::1]'].includes(address); }

function assertLocalFileRequest(req) {
  let originAllowed = true;
  try {
    if (req.headers?.origin) {
      const origin = new URL(req.headers.origin);
      originAllowed = ['http:', 'https:'].includes(origin.protocol) && isLoopback(origin.hostname);
    }
    if (req.headers?.host && !isLoopback(new URL(`http://${req.headers.host}`).hostname)) originAllowed = false;
    if (!req.headers?.origin && req.headers?.['sec-fetch-site'] === 'cross-site') originAllowed = false;
  } catch { originAllowed = false; }
  if (!isLoopback(req.socket?.remoteAddress) || !originAllowed) throw fileError('LOCAL_ONLY', '本地文件仅可在运行工作流的本机访问；远程访问可复制路径');
}

function openWorkDirectory(req, source, launch = spawn) {
  assertLocalFileRequest(req);
  const directory = workDirectory(source);
  if (!directory?.exists) throw fileError('WORK_DIRECTORY_MISSING', '工作目录未登记、已移动或不可访问');
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  return new Promise((resolve, reject) => {
    const child = launch(command, [directory.path], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve({ requested: true, path: directory.path }); });
  });
}

module.exports = { absolutePath, workDirectory, prepareLocalArtifact, artifactFile, openWorkDirectory, assertLocalFileRequest };
