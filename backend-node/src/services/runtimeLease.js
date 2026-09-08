const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function canonical(file) {
  const absolute = path.resolve(file);
  if (fs.existsSync(absolute)) return fs.realpathSync(absolute);
  return path.join(fs.realpathSync(path.dirname(absolute)), path.basename(absolute));
}
// Acquired before createApp: a second process must not run startup recovery,
// migrations, or queue claiming against a database already in use.
function acquireRuntimeLease(databasePath, metadata = {}) {
  fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const database = canonical(databasePath);
  const locks = [database + '.runtime-lock'];
  if (process.env.YINZI_WORKFLOW_RUNTIME_DIR) {
    fs.mkdirSync(process.env.YINZI_WORKFLOW_RUNTIME_DIR, { recursive: true });
    locks.push(path.join(canonical(process.env.YINZI_WORKFLOW_RUNTIME_DIR), 'backend.lock'));
  }
  const owned = [];
  const record = { ...metadata, pid: process.pid, token: crypto.randomUUID(), database_path: database };
  const release = () => {
    for (const file of owned.reverse()) {
      try { if (JSON.parse(fs.readFileSync(file, 'utf8')).token === record.token) fs.unlinkSync(file); } catch (_) {}
    }
  };
  try {
    for (const file of locks) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let fd;
        try { fd = fs.openSync(file, 'wx', 0o600); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let previous;
          try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
          if (!previous || alive(previous.pid)) {
            const busy = new Error('工作流后台已经运行；请使用现有工作台，不会创建第二个后台。');
            busy.code = 'WORKFLOW_ALREADY_RUNNING'; busy.runtime = previous; throw busy;
          }
          // Serialize stale-owner reclamation. Two starters must not both
          // unlink the old inode and accidentally remove the winner's lease.
          const reclaim = file + '.reclaim';
          let guard;
          try { guard = fs.openSync(reclaim, 'wx', 0o600); }
          catch (e) { if (e.code === 'EEXIST') throw new Error('另一个启动正在恢复实例锁，请再次打开工作台'); throw e; }
          try {
            let current;
            try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            if (current && !alive(current.pid)) fs.unlinkSync(file);
          } finally { fs.closeSync(guard); fs.unlinkSync(reclaim); }
          continue;
        }
        try { fs.writeFileSync(fd, JSON.stringify(record)); } finally { fs.closeSync(fd); }
        owned.push(file); break;
      }
      if (!owned.includes(file)) throw new Error('无法取得工作流实例锁，现有数据保持不变。');
    }
    return { record, release };
  } catch (error) { release(); throw error; }
}
module.exports = { acquireRuntimeLease, alive };
