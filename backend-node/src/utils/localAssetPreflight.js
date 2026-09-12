const fs = require('node:fs');
const path = require('node:path');

function inspectLocalAssets(input = {}) {
  const raw = input.local_paths || input.reference_media || input.assets || [];
  const paths = [...new Set((Array.isArray(raw) ? raw : [raw])
    .filter((value) => typeof value === 'string' && value.trim()))];
  const checks = paths.map((value) => {
    const reference = value.trim();
    const kind = reference.startsWith('file_id:') ? 'provider_file'
      : reference.startsWith('data:') ? 'inline'
        : /^https?:\/\//i.test(reference) ? 'remote' : 'local';
    if (kind !== 'local') {
      // Availability and media-role compatibility belong to the provider
      // adapter. A deferred check is not proof of upload or remote readability.
      return {
        path: kind === 'inline' ? '[内联媒体]' : value,
        kind, exists: null, readable: null, foreign_device_hint: false,
        ok: true, verification: 'deferred',
        reason: '非本地引用，实际内容和媒体类型由提交适配器及提供方确认',
      };
    }
    const normalized = path.normalize(value);
    let exists = false;
    let readable = false;
    let isFile = false;
    try {
      const stat = fs.statSync(normalized);
      exists = true;
      isFile = stat.isFile();
      if (isFile) {
        fs.accessSync(normalized, fs.constants.R_OK);
        readable = true;
      }
    } catch (_) {}
    const foreign = /^[A-Za-z]:[\\/]/.test(value)
      && path.parse(value).root.toLowerCase() !== path.parse(process.cwd()).root.toLowerCase();
    return {
      path: value, kind, exists, readable, is_file: isFile,
      foreign_device_hint: foreign, ok: readable, verification: 'local',
      reason: !exists ? '文件不存在或当前设备不可见'
        : !isFile ? '路径不是普通文件'
          : !readable ? '文件不可读取' : '可读取',
    };
  });
  const checkedLocal = checks.filter((item) => item.kind === 'local').length;
  return {
    checked: checks.length, checked_local: checkedLocal,
    deferred: checks.length - checkedLocal,
    ok: checks.every((item) => item.ok), checks,
  };
}
module.exports = { inspectLocalAssets };
