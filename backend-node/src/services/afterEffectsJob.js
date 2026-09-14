const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { findExecutable } = require('./afterEffectsBridge');
const fail = (code, message) => Object.assign(new Error(message), { code });
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' });
const existsFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

function discover(env = process.env, platform = process.platform) {
  const configured = findExecutable(env, platform);
  if (configured || env.YINZI_AFTERFX_PATH || env.AFTERFX_PATH) return configured;
  if (platform === 'win32') {
    for (const root of ['HKLM', 'HKCU']) {
      try {
        const result = execFileSync('reg.exe', ['query', `${root}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\AfterFX.exe`, '/ve'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        const value = result.split(/\r?\n/).map(line => line.match(/REG_SZ\s+(.+)$/)?.[1]?.trim().replace(/^"|"$/g, '')).find(Boolean);
        if (value && existsFile(value)) return value;
      } catch {}
    }
    try {
      const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', "@(Get-Process -Name AfterFX -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path -Unique) | ConvertTo-Json -Compress"], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const paths = JSON.parse(result || '[]');
      const found = (Array.isArray(paths) ? paths : [paths]).filter(x => typeof x === 'string' && existsFile(x));
      if (found.length === 1) return found[0];
    } catch {}
  }
  if (platform === 'darwin') {
    try {
      return fs.readdirSync('/Applications').filter(n => /^Adobe After Effects /.test(n)).sort().reverse()
        .map(n => path.join('/Applications', n, `${n}.app/Contents/MacOS/After Effects`)).find(existsFile) || null;
    } catch {}
  }
  return null;
}

function validate(job) {
  if (!job || !['inspect', 'compose'].includes(job.mode)) throw fail('INVALID_AE_JOB', 'mode must be inspect or compose');
  if (Buffer.byteLength(JSON.stringify(job)) > 4 * 1024 * 1024) throw fail('INVALID_AE_JOB', 'Split this job into smaller editable compositions');
  const ids = new Set();
  const number = (v, min, max, label) => { if (!Number.isFinite(v) || v < min || v > max) throw fail('INVALID_AE_JOB', label); };
  const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value) || ids.has(value)) throw fail('INVALID_AE_JOB', 'IDs must be unique simple names'); ids.add(value); };
  if (job.open_project && !existsFile(job.open_project)) throw fail('INVALID_AE_JOB', 'open_project is missing');
  if ((job.assets || []).length > 256 || (job.comps || []).length > 128) throw fail('INVALID_AE_JOB', 'Too many items');
  for (const a of job.assets || []) { id(a.id); if (!existsFile(a.path)) throw fail('INVALID_AE_JOB', `Missing asset ${a.id}`); }
  for (const c of job.comps || []) {
    id(c.id);
    if (!c.existing_name) { number(c.width, 16, 16384, 'width'); number(c.height, 16, 16384, 'height'); number(c.duration, 0.04, 10800, 'duration'); number(c.fps || 30, 1, 120, 'fps'); }
    if ((c.layers || []).length > 2000) throw fail('INVALID_AE_JOB', 'Too many layers');
    const layers = new Set();
    for (const l of c.layers || []) {
      if (!l.id || layers.has(l.id)) throw fail('INVALID_AE_JOB', 'Layer IDs must be unique within a comp'); layers.add(l.id);
      if (!l.existing_name && !['footage', 'comp', 'solid', 'text', 'shape', 'camera', 'null'].includes(l.type)) throw fail('INVALID_AE_JOB', 'Unknown layer type');
      if (['footage', 'comp'].includes(l.type) && !ids.has(l.source)) throw fail('INVALID_AE_JOB', 'Source must precede its layer');
      for (const p of [...(l.properties || []), ...(l.effects || []).flatMap(e => e.properties || [])]) {
        if (!Array.isArray(p.path) || p.path.length < 1 || p.path.length > 20) throw fail('INVALID_AE_JOB', 'A property needs a bounded matchName/index path');
        if ((p.keys || []).length > 10000) throw fail('INVALID_AE_JOB', 'Too many keyframes');
        let last = -Infinity;
        for (const k of p.keys || []) { number(k.time, 0, c.duration || 10800, 'key time'); if (k.time <= last) throw fail('INVALID_AE_JOB', 'Key times must increase'); last = k.time; if(k.influence != null) number(k.influence, 0.1, 100, 'influence'); }
      }
    }
    for (const l of c.layers || []) if (l.parent && (!layers.has(l.parent) || l.parent === l.id)) throw fail('INVALID_AE_JOB', 'Invalid parent');
    for (const l of c.layers || []) { const seen = new Set([l.id]); let p = l.parent; while(p) { if(seen.has(p)) throw fail('INVALID_AE_JOB','Parent cycle'); seen.add(p); p = c.layers.find(x=>x.id===p)?.parent; } }
  }
  if (job.mode === 'compose' && !(job.comps || []).length) throw fail('INVALID_AE_JOB', 'compose needs a comp');
  if (job.render && !ids.has(job.render.comp)) throw fail('INVALID_AE_JOB', 'Render comp missing');
  if (job.render?.extension && !/^(mp4|mov|avi)$/.test(job.render.extension)) throw fail('INVALID_AE_JOB', 'Use a single movie output extension');
  if (job.render?.multi_frame !== undefined && typeof job.render.multi_frame !== 'boolean') throw fail('INVALID_AE_JOB','multi_frame must be boolean');
  if (job.render?.max_cpu_percent !== undefined) number(job.render.max_cpu_percent,1,100,'CPU percentage');
  if (job.render?.start !== undefined) number(job.render.start,0,10800,'render start');
  if (job.render?.duration !== undefined) number(job.render.duration,0.001,10800,'render duration');
  if (job.render?.resolution_factor && (!Array.isArray(job.render.resolution_factor) || job.render.resolution_factor.length!==2 || job.render.resolution_factor.some(v=>![1,2,3,4,8].includes(v)))) throw fail('INVALID_AE_JOB','Invalid resolution factor');
  return job;
}

function prepare(job, outputDir) {
  validate(job);
  const dir = path.resolve(outputDir);
  const request = JSON.stringify(job);
  const hash = digest(request);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = path.join(dir, 'ae-job.json');
  if (fs.existsSync(manifest)) {
    if (json(manifest).request_sha256 !== hash) throw fail('AE_JOB_CONFLICT', 'This directory belongs to another job');
    return { dir, request_sha256: hash, reused: true };
  }
  if (fs.readdirSync(dir).some(n => /^ae-|^project\.aep$|^render\./.test(n))) throw fail('AE_OUTPUT_EXISTS', 'Choose a new job directory');
  const spec = { ...job, output_dir: dir.replace(/\\/g, '/'), request_sha256: hash };
  const runtime = fs.readFileSync(path.join(__dirname, 'afterEffectsRuntime.jsx'), 'utf8');
  write(manifest, { request_sha256: hash, job });
  fs.writeFileSync(path.join(dir, 'ae-job.jsx'), 'var YINZI_AE_JOB = ' + JSON.stringify(spec).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') + ';\n' + runtime, { flag: 'wx' });
  return { dir, request_sha256: hash, reused: false };
}

function read(dir) {
  const receiptFile = path.join(dir, 'ae-receipt.json');
  if (!fs.existsSync(receiptFile)) return null;
  let receipt; try { receipt = json(receiptFile); } catch (error) { if(error instanceof SyntaxError) return null; throw error; }
  if (receipt.request_sha256 !== json(path.join(dir, 'ae-job.json')).request_sha256) throw fail('AE_RECEIPT_MISMATCH', 'Receipt belongs to a different job');
  if (!['failed', 'inspected', 'composed', 'rendered_pending_media_qa'].includes(receipt.status)) throw fail('AE_RECEIPT_INVALID', 'Unknown result state');
  // AE can change an output suffix to match the selected output-module format.
  const actual = receipt.output_settings?.['Output File Info']?.['Full Flat Path'];
  if (actual && path.dirname(path.resolve(actual)) === path.resolve(dir)) {
    receipt.outputs = (receipt.outputs || []).map(file => {
      if (!existsFile(file) && /^render\.(avi|mov|mp4)$/.test(path.basename(file)) && existsFile(actual)) {
        receipt.output_path_adjusted_by_ae = { requested: file, actual };
        return actual;
      }
      return file;
    });
  }
  if (receipt.status !== 'failed') for (const file of receipt.outputs || []) if (!existsFile(file) || !fs.statSync(file).size) throw fail('AE_OUTPUT_MISSING', file);
  return receipt;
}

async function execute(job, outputDir, options = {}) {
  const prepared = prepare(job, outputDir), dir = prepared.dir;
  const lock = options.lockPath || path.join(os.tmpdir(), 'yinzi-after-effects-editor.lock.json');
  const release = () => { if (fs.existsSync(lock) && json(lock).dir === dir) fs.unlinkSync(lock); };
  const prior = read(dir); if (prior) { release(); return { ...prior, reused: true }; }
  const executable = options.executable || discover();
  if (!executable) throw fail('AFTERFX_MISSING', 'Install AE or configure YINZI_AFTERFX_PATH; native AE is unavailable on Linux');
  const dispatch = path.join(dir, 'ae-dispatch.json');
  if (!fs.existsSync(dispatch)) {
    try { write(lock, { dir, created_at: new Date().toISOString() }); }
    catch (e) { if (e.code === 'EEXIST') throw fail('AE_EDITOR_BUSY', 'Reconcile the job named in ' + lock); throw e; }
    try {
      write(dispatch, { executable, dir, request_sha256: prepared.request_sha256, submitted_at: new Date().toISOString() });
      const child = spawn(executable, ['-r', path.join(dir, 'ae-job.jsx')], { cwd: dir, windowsHide: false, shell: false, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    } catch(e) { release(); throw e; }
  }
  const start = Date.now(), timeout = options.timeout ?? 20 * 60 * 1000;
  while (Date.now() - start < timeout) {
    const result = read(dir);
    if (result) { release(); return result; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw fail('AE_RESULT_UNKNOWN', 'Editor preserved; inspect/reconcile this same directory, do not resubmit a new job');
}

module.exports = { discover, validate, prepare, execute, read };
if (require.main === module) {
  const [command, input, output] = process.argv.slice(2);
  Promise.resolve().then(async () => {
    if (command === 'discover') return { executable: discover(), platform: process.platform };
    if (command === 'read') return read(path.resolve(input));
    if (command === 'prepare') return prepare(json(input), output);
    if (command === 'run') { const r = await execute(json(input), output); return { status:r.status, error:r.error, project:r.project, outputs:r.outputs, layers:r.layer_count, keys:r.keyframe_count, seconds:r.elapsed_seconds, receipt:path.join(path.resolve(output),'ae-receipt.json'), requested_resolution_factor:r.requested_resolution_factor, applied_resolution_factor:r.applied_resolution_factor, render_resolution:r.render_resolution, expected_output_size:r.expected_output_size, actual_output_size:r.actual_output_size }; }
    throw Error('Usage: afterEffectsJob.js discover | read DIR | prepare JOB.json DIR | run JOB.json DIR');
  }).then(value => { console.log(JSON.stringify(value));if(value&&value.status==='failed')process.exitCode=1; }).catch(error => { console.error(JSON.stringify({code:error.code,message:error.message}));process.exitCode=1; });
}