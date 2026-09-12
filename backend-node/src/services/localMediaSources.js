const fs = require('node:fs');
const path = require('node:path');
const error = (code, message) => Object.assign(new Error(message), { code });
function identity(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || !stat.size) throw error('INPUT_MISSING', '输入素材必须是可读取的非空普通文件');
  fs.accessSync(file, fs.constants.R_OK);
  return { size: stat.size, mtime_ms: stat.mtimeMs, ctime_ms: stat.ctimeMs, ino: stat.ino };
}
function sourcesFor(request) {
  const input = path.resolve(String(request.input_path || ''));
  if (request.sources != null && (!Array.isArray(request.sources) || request.sources.length === 0 || request.sources.length > 128)) {
    throw error('INVALID_SOURCES', 'sources 必须包含 1–128 个输入；更长时间线可分段处理后合成');
  }
  const sources = (request.sources || [{ role: 'primary', path: input, identity: request.input_identity }]).map(item => {
    if (!item || typeof item.path !== 'string' || !item.path.trim()) throw error('INVALID_SOURCES', '每份输入都需要本地文件路径');
    return { role: String(item.role || 'source').slice(0, 80), path: path.resolve(item.path), ...(item.identity ? { identity: item.identity } : {}) };
  });
  // Keep explicitly supplied source indices stable. The primary input remains
  // part of recovery identity even when it is not a clip in the composition.
  if (!sources.some(item => item.path === input)) sources.push({ role:'primary', path:input, identity:request.input_identity });
  const narration = request.module_id === 'local.video.edit-timeline' ? request.parameters?.narration_path : null;
  if (narration && !sources.some(item => item.path === path.resolve(narration))) sources.push({ role:'narration', path:path.resolve(narration) });
  return sources;
}
function snapshot(request) { return sourcesFor(request).map(item => ({ role:item.role, path:item.path, identity:identity(item.path) })); }
function verify(sources) {
  for (const source of sources) {
    const current = identity(source.path), expected = source.identity;
    if (expected && Object.keys(current).some(key => current[key] !== expected[key])) throw error('INPUT_CHANGED', `排队期间素材已变化（${source.role}），请用当前素材建立新处理请求`);
  }
}
module.exports = { identity, sourcesFor, snapshot, verify };
