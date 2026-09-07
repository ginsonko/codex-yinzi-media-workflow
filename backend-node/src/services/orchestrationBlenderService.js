const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const blenderDirector = require('./blenderDirector');
const { createOrchestrationService, ensureSchema, publicBlenderJob, sanitize } = require('./orchestrationService');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');
const { validFile, inspectOutputs, writeJson, encodingArgs } = require('./orchestrationBlenderFiles');
const TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled', 'blocked']);
const ACTIVE = new Set(['queued', 'preparing', 'rendering', 'encoding', 'cancelling']);
const connections = new WeakMap();
const stamp = () => new Date().toISOString();
const parse = (value) => { try { return JSON.parse(value || '{}'); } catch (_) { return {}; } };
const fail = (code, message) => Object.assign(new Error(message), { code });
function alive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function createOrchestrationBlenderService(db, cfg = {}, log = console, injected = {}) {
  if (connections.has(db)) return connections.get(db);
  ensureSchema(db);
  const orchestration = injected.orchestration || createOrchestrationService(db);
  const blender = injected.blenderDirector || blenderDirector;
  const spawnProcess = injected.spawn || spawn;
  const isAlive = injected.isProcessAlive || alive;
  const jobs = new Map();
  const root = path.resolve(cfg.storage?.local_path || './data/storage');
  const getRow = (id) => db.prepare('SELECT * FROM orchestration_blender_jobs WHERE id=?').get(id);
  const getJob = (id) => publicBlenderJob(getRow(id));
  function outputDir(row) {
    const absolute = path.resolve(root, row.output_dir);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw fail('BLENDER_OUTPUT_PATH_INVALID', '作业输出目录超出存储范围');
    return absolute;
  }
  function errorInfo(error) {
    return { code: error?.code || 'BLENDER_PROCESS_ERROR', message: String(sanitize(error?.message || '本地执行失败')).replaceAll(root, '[storage]').slice(-1500), retryable: 'true', next_actions: ['resume', 'fallback_threejs'] };
  }
  function setRow(id, patch) {
    const columns = { status: 'status', phase: 'phase', progress: 'progress_json', manifest: 'manifest_json', error: 'error_json', pid: 'pid', owner_pid: 'owner_pid', attempt: 'attempt', cancel_requested: 'cancel_requested', started_at: 'started_at', completed_at: 'completed_at' };
    const values = [], assignments = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!columns[key]) continue;
      assignments.push(columns[key] + '=?');
      values.push(['progress', 'manifest', 'error'].includes(key) ? JSON.stringify(sanitize(value)) : value);
    }
    db.prepare('UPDATE orchestration_blender_jobs SET ' + assignments.join(',') + ',updated_at=? WHERE id=?').run(...values, stamp(), id);
    return getRow(id);
  }
  function emit(row, phase, message, progress = {}) {
    const normalized = sanitize({ state: phase, phase, job_id: row.id, message, ...progress });
    setRow(row.id, { phase, progress: normalized });
    orchestration.recordEvent(row.session_id, {
      event_type: 'blender.' + phase, node_id: row.node_id, actor: 'system',
      event_idempotency_key: 'blender:' + row.id + ':' + row.attempt + ':' + phase + ':' + (progress.completed_frames || 0),
      payload: { job_id: row.id, ...normalized },
    });
    orchestration.updateNode(row.session_id, row.node_id, { progress: normalized, error: {}, actor: 'system' });
  }
  function listJobs(sessionId) {
    if (!orchestration.getBundle(sessionId)) throw fail('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    return db.prepare('SELECT * FROM orchestration_blender_jobs WHERE session_id=? ORDER BY created_at,id').all(sessionId).map(publicBlenderJob);
  }
  function registerArtifacts(row, manifest, dir, receipt = null) {
    const definitions = [
      [manifest.blend, 'file', 'Blender 可编辑工程', 'application/octet-stream', 'editable_scene'],
      [manifest.glb, 'glb', '3D 场景预览', 'model/gltf-binary', 'browser_proxy'],
      ...manifest.frames.map((file, index) => [file, 'image', '参考分镜 ' + (index + 1), 'image/png', 'rendered_frame']),
      [manifest.video?.status === 'succeeded' ? manifest.video.relative_path : null, 'video', '运镜参考视频', 'video/mp4', 'encoded_preview'],
      [receipt, 'file', '本次渲染回执', 'application/json', 'receipt'],
    ];
    const refs = [];
    for (const [relative, type, title, mime, authority] of definitions) {
      if (!relative) continue;
      const file = validFile(dir, relative);
      if (!file) continue;
      const id = row.id + ':' + relative.replace(/[^a-zA-Z0-9_.-]/g, '-');
      const storagePath = path.relative(root, file.absolute).replace(/\\/g, '/');
      const url = '/static/' + storagePath.split('/').map(encodeURIComponent).join('/');
      const result = orchestration.recordArtifact(row.session_id, {
        artifact_id: id, node_id: row.node_id, type, title, mime_type: mime,
        path: storagePath, url, bytes: file.bytes, status: 'validated',
        source_refs: [{ type: 'blender_job', id: row.id }, { type: 'scene', hash: row.scene_hash }],
        validation: { status: 'passed', authority, check: 'local_file_header_and_size' },
        ...(type === 'video' ? { duration_seconds: manifest.video.duration_seconds, frame_rate: manifest.video.fps } : {}),
      });
      refs.push({ artifact_id: result.artifact.artifact_id, id, type, path: storagePath, url, bytes: file.bytes });
    }
    return refs;
  }
  function finish(row, plan, dir, status, error = {}) {
    const current = getRow(row.id);
    if (!current) return null;
    if (current.cancel_requested) { status = 'cancelled'; error = parse(current.error_json); }
    const manifest = { ...inspectOutputs(dir, plan), status };
    const completed = stamp(), receipt = 'receipts/attempt-' + current.attempt + '.json';
    if (fs.existsSync(dir)) {
      writeJson(path.join(dir, 'manifest.json'), manifest);
      writeJson(path.join(dir, receipt), { ...manifest, job_id: row.id, request_hash: row.request_hash, completed_at: completed, error: sanitize(error) });
    }
    const refs = registerArtifacts(current, manifest, dir, fs.existsSync(dir) ? receipt : null);
    const message = status === 'succeeded' ? '参考图、运镜视频和可编辑工程已完成'
      : status === 'partial' ? '已有成果已保留，仍有阶段需要恢复：' + (error.message || '部分输出缺失')
        : status === 'cancelled' ? '本地作业已停止，已完成成果保留' : error.message || '作业未完成';
    const progress = { state: status, phase: status === 'succeeded' ? 'completed' : status, job_id: row.id, message, completed_frames: manifest.frames.length, total_frames: plan.profile.frames.length };
    db.transaction(() => {
      setRow(row.id, { status, phase: progress.phase, progress, manifest, error, pid: null, owner_pid: null, completed_at: completed });
      orchestration.updateNode(row.session_id, row.node_id, {
        status: status === 'blocked' ? 'failed' : status, output_refs: refs, error, progress, actor: 'system',
        receipt: { status, source: 'blender', message, original_code: error.code || null, retryable: status === 'succeeded' ? 'false' : 'true', fallback_available: true, next_actions: status === 'succeeded' ? ['continue'] : ['resume', 'fallback_threejs'], correlation_id: row.id },
      });
      orchestration.recordEvent(row.session_id, { event_type: 'blender.' + progress.phase, actor: 'system', node_id: row.node_id,
        event_idempotency_key: 'blender:' + row.id + ':' + current.attempt + ':finished',
        payload: { job_id: row.id, status, message, artifact_count: refs.length, error },
      });
    })();
    return getJob(row.id);
  }
  function checkBinding(sessionId, nodeKey, resume = false) {
    const bundle = orchestration.getBundle(sessionId);
    if (!bundle) throw fail('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    const node = bundle.nodes.find((item) => item.node_key === nodeKey || item.id === nodeKey);
    if (!node) throw fail('ORCHESTRATION_NODE_NOT_FOUND', '这个镜头已不在当前计划中');
    if (node.module_id !== 'director.blender-render' || !node.active) throw fail('BLENDER_NODE_INVALID', '请将当前节点规划为 Blender 参考渲染');
    if (['draft', 'waiting_confirmation', 'planned', 'paused'].includes(bundle.session.status)) throw fail('NODE_NOT_READY', '请先确认并启动计划；暂停的任务需要先继续编排');
    if (!resume && node.status !== 'ready') throw fail('NODE_NOT_READY', '镜头尚未就绪；已完成镜头需要先重开再生成新版本');
    if (node.depends_on.some((key) => !bundle.nodes.some((item) => item.node_key === key && ['succeeded', 'partial', 'skipped'].includes(item.status)))) throw fail('NODE_NOT_READY', '请先完成这个镜头依赖的前置步骤');
    return node;
  }
  function ensureNoOtherJob(sessionId, nodeKey, ownId) {
    const other = db.prepare("SELECT id FROM orchestration_blender_jobs WHERE session_id=? AND node_key=? AND id!=? AND status IN ('queued','preparing','rendering','encoding','cancelling','recoverable')").get(sessionId, nodeKey, ownId || '');
    if (other) throw fail('NODE_RUNNING', '这个镜头已有作业，请先读取、恢复或停止它');
  }
  function normalizeInput(input) {
    const redactions = new Set();
    sanitize(input, redactions);
    if (redactions.size) throw fail('BLENDER_SECRET_REJECTED', '场景或请求字段包含凭据，请从素材和计划中移除');
    for (const key of ['python', 'script', 'script_path', 'output', 'output_dir', 'executable', 'command']) {
      if (input[key] != null) throw fail('BLENDER_INPUT_UNSUPPORTED', '此接口只接受场景参数；脚本和输出路径由运行时管理');
    }
    const requestKey = blender.normalizeRequestKey(input.request_key || input.idempotency_key);
    const plan = blender.prepareBlenderRender(cfg, { ...input, request_key: requestKey });
    const contentHash = blenderDirector.hashJson({ scene: plan.scene.document, profile: plan.profile });
    const requestHash = input.request_hash || blenderDirector.hashJson({ request_key: requestKey, content_hash: contentHash });
    if (typeof requestHash !== 'string' || !/^[a-zA-Z0-9_.:-]{3,128}$/.test(requestHash)) throw fail('BLENDER_REQUEST_HASH_INVALID', '请求标识格式无效');
    return { requestKey, requestHash, plan, contentHash };
  }
  function runChild(op, executable, args, phase, dir, onProgress) {
    return new Promise((resolve, reject) => {
      let child, stderr = '', pending = '', processError = null;
      try { child = spawnProcess(executable, args, { cwd: dir, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (error) { reject(error); return; }
      op.child = child;
      setRow(op.id, { pid: child.pid || null, status: phase, phase, started_at: getRow(op.id).started_at || stamp() });
      const timer = setTimeout(() => {
        processError = fail(phase === 'encoding' ? 'FFMPEG_TIMEOUT' : 'BLENDER_TIMEOUT', '本地执行超时；已完成文件保留，可恢复');
        child.kill();
      }, injected.timeoutMs || (phase === 'encoding' ? 120000 : 600000));
      child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
      child.stdout?.on('data', (chunk) => {
        pending = (pending + chunk).slice(-16000);
        const lines = pending.split(/\r?\n/); pending = lines.pop();
        for (const line of lines) if (line.startsWith('YINZI_PROGRESS ')) {
          try { onProgress?.(JSON.parse(line.slice(15))); }
          catch (error) { log.warn?.('Blender progress', { error: errorInfo(error).message }); }
        }
      });
      child.once('error', (error) => { processError = error; });
      child.once('close', (code, signal) => {
        clearTimeout(timer); op.child = null; setRow(op.id, { pid: null });
        if (getRow(op.id)?.cancel_requested || op.restarting) resolve({ cancelled: true });
        else if (processError) reject(processError);
        else if (code !== 0) reject(fail(phase === 'encoding' ? 'FFMPEG_FAILED' : 'BLENDER_EXIT_FAILED', stderr || '本地进程异常退出：' + (signal || code)));
        else resolve({ cancelled: false });
      });
    });
  }
  function launch(row, plan) {
    const op = { id: row.id, child: null, restarting: false };
    jobs.set(row.id, op);
    op.done = new Promise((resolve) => setImmediate(resolve)).then(async () => {
      const dir = outputDir(row);
      try {
        if (op.restarting) return null;
        if (getRow(row.id).cancel_requested) return finish(row, plan, dir, 'cancelled');
        let outputs = inspectOutputs(dir, plan);
        if (!outputs.render_complete) {
          const executable = blender.resolveBlenderExecutable(cfg);
          if (!executable) return finish(row, plan, dir, 'blocked', errorInfo(fail('BLENDER_NOT_FOUND', '本机未找到 Blender；安装后可恢复，或继续使用快速 3D 预演')));
          fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });
          writeJson(path.join(dir, 'scene.json'), plan.scene.document);
          emit(row, 'preparing', '正在搭建场景、材质和相机');
          const args = ['--background', '--disable-autoexec', '--python-exit-code', '2',
            '--python', path.resolve(__dirname, '../../../runtime/blender/render_scene.py'), '--',
            '--output', dir, '--input', path.join(dir, 'scene.json'), '--engine', plan.profile.engine,
            '--frames', plan.profile.frames.join(','), '--width', String(plan.profile.resolution.width),
            '--height', String(plan.profile.resolution.height), '--fps', String(plan.profile.fps)];
          const rendered = await runChild(op, executable, args, 'rendering', dir, (progress) => {
            if (getRow(row.id).cancel_requested) return;
            const fresh = inspectOutputs(dir, plan);
            const refs = registerArtifacts(row, fresh, dir);
            const phase = ['modeling', 'exporting', 'rendering'].includes(progress.phase) ? progress.phase : 'rendering';
            emit(row, phase, phase === 'modeling' ? '场景与相机已搭建' : phase === 'exporting' ? '工程和 3D 预览已导出' : '参考帧 ' + fresh.frames.length + '/' + plan.profile.frames.length, { completed_frames: fresh.frames.length, total_frames: plan.profile.frames.length });
            orchestration.updateNode(row.session_id, row.node_id, { output_refs: refs, actor: 'system' });
          });
          if (rendered.cancelled) return op.restarting ? null : finish(row, plan, dir, 'cancelled');
          outputs = inspectOutputs(dir, plan);
        }
        if (op.restarting) return null;
        if (getRow(row.id).cancel_requested) return finish(row, plan, dir, 'cancelled');
        if (!outputs.render_complete) return finish(row, plan, dir, 'partial', errorInfo(fail('BLENDER_OUTPUT_INCOMPLETE', '参考帧或工程导出不完整')));
        if (outputs.video.status !== 'succeeded') {
          if (!injected.ffmpegPath && !hasLocalFfmpeg()) return finish(row, plan, dir, 'partial', errorInfo(fail('FFMPEG_NOT_FOUND', '工程和图片已完成；缺少 FFmpeg，尚未编码视频')));
          emit(row, 'encoding', '正在把参考帧编码为运镜视频', { completed_frames: outputs.frames.length, total_frames: plan.profile.frames.length });
          const encoded = await runChild(op, injected.ffmpegPath || getFfmpegPath(), encodingArgs(dir, plan, outputs.frames), 'encoding', dir);
          if (encoded.cancelled) return op.restarting ? null : finish(row, plan, dir, 'cancelled');
          if (!validFile(dir, 'preview.pending.mp4')) throw fail('FFMPEG_OUTPUT_INVALID', '编码器没有生成完整的 MP4 文件');
          fs.renameSync(path.join(dir, 'preview.pending.mp4'), path.join(dir, 'preview.mp4'));
          outputs.video = { status: 'succeeded', relative_path: 'preview.mp4', fps: plan.profile.fps, duration_seconds: plan.scene.duration_seconds, frame_count: outputs.frames.length };
          writeJson(path.join(dir, 'manifest.json'), outputs);
        }
        return finish(row, plan, dir, 'succeeded');
      } catch (error) {
        if (op.restarting) return null;
        const outputs = inspectOutputs(dir, plan);
        return finish(row, plan, dir, outputs.frames.length || outputs.blend || outputs.glb ? 'partial' : 'failed', errorInfo(error));
      }
    }).catch((error) => {
      log.error?.('Blender job persistence failed', { job_id: row.id, error: errorInfo(error) });
      setRow(row.id, { status: 'recoverable', phase: 'recoverable', owner_pid: null, pid: null, error: errorInfo(error) });
    }).finally(() => {
      jobs.delete(row.id);
      if (op.restarting) setRow(row.id, { status: 'recoverable', phase: 'recoverable', pid: null, owner_pid: null, progress: { state: 'recoverable', message: '服务已停止；可从已有成果恢复' } });
    });
  }
  async function createJob(sessionId, input = {}) {
    const bundle = orchestration.getBundle(sessionId);
    if (!bundle) throw fail('ORCHESTRATION_NOT_FOUND', '编排任务不存在');
    const node = bundle.nodes.find((item) => item.node_key === input.node_key || item.id === input.node_key);
    if (!node) throw fail('ORCHESTRATION_NODE_NOT_FOUND', 'Blender 作业绑定的镜头不存在');
    const { requestKey, requestHash, plan, contentHash } = normalizeInput(input);
    const reserved = db.transaction(() => {
      const previous = db.prepare('SELECT * FROM orchestration_blender_jobs WHERE session_id=? AND node_key=? AND (request_hash=? OR request_key=?)').get(sessionId, node.node_key, requestHash, requestKey);
      if (previous) {
        const prior = parse(previous.plan_json);
        if (blenderDirector.hashJson({ scene: prior.scene?.document, profile: prior.profile }) !== contentHash || previous.request_key !== requestKey) throw fail('REQUEST_HASH_CONFLICT', '同一请求标识已绑定不同场景或画质；请明确保存为新版本');
        return { reused: true, row: previous };
      }
      checkBinding(sessionId, node.node_key); ensureNoOtherJob(sessionId, node.node_key);
      const id = crypto.randomUUID(), time = stamp();
      db.prepare('INSERT INTO orchestration_blender_jobs (id,session_id,node_id,node_key,request_key,request_hash,plan_id,scene_hash,status,phase,output_dir,plan_json,owner_pid,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        id, sessionId, node.id, node.node_key, requestKey, requestHash, plan.plan_id, plan.scene.hash, 'queued', 'queued',
        'blender/jobs/' + sessionId + '/' + id, JSON.stringify(plan), process.pid, time, time);
      orchestration.updateNode(sessionId, node.id, { status: 'running', error: {}, request_hash: requestHash, progress: { state: 'queued', job_id: id, message: '准备启动本地 Blender 作业' }, actor: 'system' });
      return { reused: false, row: getRow(id) };
    }).immediate();
    if (!reserved.reused) launch(reserved.row, plan);
    return { reused: reserved.reused, job: getJob(reserved.row.id) };
  }
  async function resumeJob(id) {
    const reserved = db.transaction(() => {
      const row = getRow(id);
      if (!row) throw fail('BLENDER_JOB_NOT_FOUND', 'Blender 作业不存在');
      if (jobs.has(id)) return { reused: true, row };
      if (isAlive(row.pid) || (row.owner_pid !== process.pid && isAlive(row.owner_pid))) throw fail('BLENDER_PROCESS_STILL_ACTIVE', '先前进程仍在运行，暂不能重复启动；请等它退出后再恢复');
      const plan = parse(row.plan_json);
      if (!plan.scene?.document || !plan.profile?.frames?.length) throw fail('BLENDER_RECOVERY_INPUT_MISSING', '场景快照或原始渲染参数缺失，无法安全恢复');
      const outputs = inspectOutputs(outputDir(row), plan);
      if (row.status === 'succeeded' && outputs.render_complete && outputs.video.status === 'succeeded') return { reused: true, row };
      const node = checkBinding(row.session_id, row.node_key, true);
      ensureNoOtherJob(row.session_id, row.node_key, id);
      if (node.progress?.job_id && node.progress.job_id !== id) throw fail('REQUEST_HASH_CONFLICT', '镜头已有新版本，请查看最新作业');
      if (['failed', 'partial', 'cancelled', 'succeeded', 'skipped'].includes(node.status)) orchestration.retryNode(row.session_id, row.node_id, { force: true, actor: 'user' });
      setRow(id, { status: 'queued', phase: 'queued', attempt: row.attempt + 1, cancel_requested: 0, error: {}, owner_pid: process.pid, pid: null, completed_at: null });
      orchestration.updateNode(row.session_id, row.node_id, { status: 'running', error: {}, progress: { state: 'queued', job_id: id, message: '恢复原场景，只补缺失阶段' }, actor: 'system' });
      return { reused: false, row: getRow(id), plan };
    }).immediate();
    if (!reserved.reused) launch(reserved.row, reserved.plan);
    return { reused: reserved.reused, job: getJob(id) };
  }
  function cancelJob(id, input = {}) {
    const row = getRow(id);
    if (!row) throw fail('BLENDER_JOB_NOT_FOUND', 'Blender 作业不存在');
    if (TERMINAL.has(row.status)) return { reused: true, job: getJob(id) };
    const op = jobs.get(id);
    if (!op && (isAlive(row.pid) || isAlive(row.owner_pid))) throw fail('BLENDER_PROCESS_STILL_ACTIVE', '原进程仍在运行，当前实例无法确认其退出；请在原实例停止');
    const error = errorInfo(fail('BLENDER_CANCELLED', String(sanitize(input.note || '用户停止本地作业'))));
    setRow(id, { cancel_requested: 1, status: 'cancelling', phase: 'cancelling', error, progress: { state: 'cancelling', message: '正在停止本地进程，已有成果保留' } });
    if (op?.child) op.child.kill();
    if (!op) finish(getRow(id), parse(row.plan_json), outputDir(row), 'cancelled', error);
    return { reused: Boolean(row.cancel_requested), job: getJob(id) };
  }
  function recoverOnStartup() {
    const rows = db.prepare("SELECT * FROM orchestration_blender_jobs WHERE status IN ('queued','preparing','rendering','encoding','cancelling','recoverable')").all();
    for (const row of rows) {
      if (jobs.has(row.id)) continue;
      setRow(row.id, { status: 'recoverable', phase: 'recoverable', progress: { state: 'recoverable', message: isAlive(row.pid) || isAlive(row.owner_pid) ? '检测到先前进程仍存活，等待退出后恢复' : '服务曾中断，点击恢复继续已有成果' } });
    }
    return rows.length;
  }
  async function stop() {
    for (const op of jobs.values()) { op.restarting = true; op.child?.kill(); }
    await Promise.allSettled([...jobs.values()].map((op) => op.done));
  }
  const waitForIdle = async () => { await Promise.allSettled([...jobs.values()].map((op) => op.done)); };
  recoverOnStartup();
  const service = { createJob, getJob, listJobs, resumeJob, cancelJob, recoverOnStartup, stop, waitForIdle };
  connections.set(db, service);
  return service;
}
module.exports = { createOrchestrationBlenderService, publicJob: publicBlenderJob, TERMINAL, ACTIVE };
