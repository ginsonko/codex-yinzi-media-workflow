'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createStore, uid, now, clone, fail } = require('./store');
const { applyOperations, snapshotGeneration, requestForStep, nodeById } = require('./graph');
const aiConfig = require('../aiConfigService');
const assets = require('../assetService');
const merges = require('../videoMergeService');
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_review']);

function createCanvasService(db, cfg, log, mediaBatch, injected = {}) {
  const store = createStore(db);
  let closed = false, pumping = false, timer, terminalCursor = '', lastTerminalPoll = 0;
  const exports = new Map();
  function clean(value) {
    const secrets = db.prepare("SELECT api_key FROM ai_service_configs WHERE api_key IS NOT NULL AND api_key != ''").all().map(r => r.api_key).filter(s => s.length >= 8);
    const scrub = item => {
      if (typeof item === 'string') { for (const secret of secrets) item = item.split(secret).join('[redacted]'); return item.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted]'); }
      if (Array.isArray(item)) return item.map(scrub);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !/^(api_?key|authorization|access_token|password|secret)$/i.test(key)).map(([key, v]) => [key, scrub(v)]));
      return item;
    };
    return scrub(value);
  }
  function message(id, value) { return store.message(id, clean(value)); }
  function get(id) {
    const canvas = store.get(id);
    return { ...canvas, jobs: store.records('job', id), runs: store.records('run', id).map(({ history, ...run }) => run) };
  }
  function operate(id, body) {
    const input = clean({ operations: body.operations });
    return store.once(id, body.request_id, input, () => store.mutate(id, canvas => applyOperations(canvas, input.operations)));
  }
  function configure(id, body) {
    return store.mutate(id, canvas => {
      if (body.title !== undefined) canvas.title = clean(String(body.title).slice(0, 160));
      if (body.viewport) {
        const { x, y, zoom } = body.viewport;
        if (![x, y, zoom].every(Number.isFinite) || zoom <= 0) throw fail('VIEWPORT_INVALID', '画布视口参数无效');
        canvas.viewport = { x, y, zoom };
      }
      if (body.agent) {
        const source = body.agent, next = { ...canvas.agent };
        for (const key of ['config_id', 'model', 'mode', 'instructions', 'max_turns', 'timeout_ms']) if (source[key] !== undefined) next[key] = clean(source[key]);
        if (next.config_id) {
          const config = aiConfig.getConfig(db, Number(next.config_id));
          if (!config || config.service_type !== 'text') throw fail('TEXT_CONFIG_REQUIRED', '请选择已保存的文本模型配置');
        }
        if (!['tools', 'json_actions'].includes(next.mode || 'tools')) throw fail('AGENT_MODE_INVALID', '选择原生工具或 JSON 动作模式');
        canvas.agent = next;
      }
      return { revision: canvas.revision + 1, title: canvas.title, agent: canvas.agent, viewport: canvas.viewport };
    });
  }
  function generate(id, body = {}) {
    const input = clean({ node_ids: body.node_ids, run_id: body.run_id || null });
    const result = store.once(id, body.request_id, input, () => {
      const steps = snapshotGeneration(store.get(id), input.node_ids);
      // Validate missing external references before starting any part of the graph.
      for (const step of steps) for (const ref of step.inputs) if (!ref.dependency && ref.node.kind !== 'text' && !ref.node.data.media?.local_path && !ref.node.data.media?.url)
        throw fail('REFERENCE_NOT_READY', `参考节点「${ref.node.data.title}」尚无媒体，请先上传或一同选择生成`);
      const job = store.record('job', { id: uid(), canvas_id: id, kind: 'generation', status: 'queued', steps, run_id: input.run_id, created_at: now() });
      store.mutate(id, canvas => { for (const step of steps) {
        const node = nodeById(canvas, step.node_id); node.active_attempt_id = step.attempt_id;
        node.attempts.push({ id: step.attempt_id, job_id: job.id, status: 'queued', created_at: now() });
      } });
      message(id, { role: 'event', content: `已创建 ${steps.length} 个节点的生成任务`, job_id: job.id });
      return { job_id: job.id };
    });
    schedule(); return { ...result, job: store.read('job', result.job_id, id) };
  }
  function updateAttempt(job, step) {
    store.mutate(job.canvas_id, canvas => {
      const node = canvas.nodes.find(n => n.id === step.node_id); if (!node) return;
      const attempt = node.attempts.find(a => a.id === step.attempt_id); if (!attempt) return;
      Object.assign(attempt, { status: step.status, batch_id: step.batch_id, media: step.media, error: step.error,
        delivery: step.delivery, updated_at: now() });
      // Result ownership stays with its attempt; older generations cannot replace a newer one.
      if (node.active_attempt_id === attempt.id && step.status === 'completed') node.data.media = clone(step.media);
    });
  }
  function reconcile(job) {
    for (const step of job.steps) if (step.batch_id) {
      const batch = mediaBatch.get(step.batch_id);
      const item = batch?.items?.[0];
      if (!item) { step.status = 'needs_review'; step.error = '原生成记录未找到，记录已保留，可重新生成'; updateAttempt(job, step); continue; }
      const awaitingDownload = item.generation_status === 'completed' && ['pending','downloading','failed','waiting_provider'].includes(item.download_status);
      const status = awaitingDownload ? 'processing' : item.status === 'completed' ? 'completed' : ['failed', 'needs_review', 'cancelled'].includes(item.status) ? item.status : 'processing';
      const delivery = { generation_status: item.generation_status || null, download_status: item.download_status || null,
        download_error: clean(item.download_error || null), progress: item.progress ?? null, message: clean(item.progress_message || null) };
      const media = status === 'completed' ? { url: item.media_url || item.download_url, local_path: item.local_path, asset_id: item.asset_id,
        download_url: item.download_url, batch_id: batch.id, item_id: item.id, type: step.kind, download_status: item.download_status } : undefined;
      const error = awaitingDownload ? null : clean(item.error_message || null);
      if (step.status !== status || JSON.stringify(step.media) !== JSON.stringify(media) || step.error !== error || JSON.stringify(step.delivery) !== JSON.stringify(delivery)) {
        step.status = status; step.media = media; step.error = error; step.delivery = delivery; updateAttempt(job, step);
      }
      const phase = status === 'completed' ? 'completed' : awaitingDownload ? (delivery.download_status === 'failed' ? 'download_recovery' : 'downloading') : null;
      if (phase) store.once(job.canvas_id, `delivery:${step.attempt_id}:${phase}`, { attempt_id: step.attempt_id, phase }, () => {
        const url = media?.download_url || (media?.local_path ? `/static/${media.local_path.split('/').map(encodeURIComponent).join('/')}` : media?.url);
        const text = phase === 'completed' ? (media?.local_path ? '已生成并下载到本地，可以打开查看。' : '已生成，结果可以打开查看。')
          : phase === 'download_recovery' ? '上游生成成功；下载暂时失败，后台正在恢复原文件，无需重新生成。'
            : '上游生成成功，正在下载到本地；下载完成后会自动回填画布并在此通知。';
        message(job.canvas_id, { role: 'event', event: 'media_delivery', phase, content: `「${step.data.title}」${text}`,
          job_id: job.id, node_id: step.node_id, attempt_id: step.attempt_id, delivery,
          ...(url ? { results: [{ title: step.data.title, url, local_path: media.local_path || null }] } : {}) });
        return { notified: true };
      });
    }
  }
  function schedule() { if (closed || timer) return; timer = setTimeout(() => { timer = null; pump(); }, injected.pollMs || 600); timer.unref?.(); }
  function pump() {
    if (closed || pumping) return;
    if (!db.open) { closed = true; clearTimeout(timer); return; }
    pumping = true;
    try {
      const jobs = db.prepare("SELECT data_json FROM creation_canvas_jobs WHERE status NOT IN ('completed','failed','cancelled','needs_review')").all().map(row => JSON.parse(row.data_json));
      // Late receipts and recovered downloads are read back without resubmission.
      if (Date.now() - lastTerminalPoll >= (injected.terminalPollMs ?? 15000)) {
        const rows = db.prepare("SELECT id,data_json FROM creation_canvas_jobs WHERE status IN ('completed','failed','cancelled','needs_review') AND id>? ORDER BY id LIMIT 100").all(terminalCursor);
        jobs.push(...rows.map(row => JSON.parse(row.data_json)));
        terminalCursor = rows.length === 100 ? rows.at(-1).id : '';
        lastTerminalPoll = Date.now();
      }
      for (const job of jobs) {
        if (job.kind === 'export') { reconcileExport(job); continue; }
        if (job.kind !== 'generation') continue;
        const wasTerminal = TERMINAL.has(job.status), before = JSON.stringify(job);
        reconcile(job);
        if (!['paused', 'cancelled'].includes(job.status)) {
          for (const step of job.steps.filter(s => !wasTerminal && s.status === 'queued')) {
            const dependencies = step.inputs.filter(i => i.dependency).map(i => job.steps.find(s => s.node_id === i.source));
            if (dependencies.some(s => ['failed', 'cancelled', 'needs_review'].includes(s.status))) {
              step.status = 'failed'; step.error = '参考节点未生成成功，可修正后重新生成'; updateAttempt(job, step); continue;
            }
            if (dependencies.some(s => s.status !== 'completed')) continue;
            try {
              // Synchronous DB transaction closes the create-batch/save-ID crash window.
              db.transaction(() => {
                step.request = clean(requestForStep(step, job.steps));
                const batch = mediaBatch.create({ kind: step.kind, title: step.data.title, items: [step.request], concurrency: 1,
                  idempotency_key: `canvas:${job.id}:${step.attempt_id}`, settings: { _origin: 'canvas' } });
                step.batch_id = batch.id; step.status = 'processing'; store.record('job', job); updateAttempt(job, step);
              })();
            } catch (error) { step.status = 'failed'; step.error = clean(error.message); updateAttempt(job, step); }
          }
          job.status = job.steps.every(s => TERMINAL.has(s.status)) ? (job.steps.every(s => s.status === 'completed') ? 'completed' : 'failed') : 'running';
        }
        if (before !== JSON.stringify(job)) store.record('job', job);
      }
    } catch (error) { log.warn('Canvas job reconciliation', { error: clean(error.message) }); }
    finally { pumping = false; schedule(); }
  }
  function controlJob(id, jobId, action) {
    const job = store.read('job', jobId, id);
    if (job.kind !== 'generation') throw fail('EXPORT_RUNNING', '成片合成记录可观察或重新导出');
    if (action === 'pause' || action === 'cancel') {
      job.status = action === 'pause' ? 'paused' : 'cancelled';
      for (const step of job.steps) {
        if (step.batch_id && !TERMINAL.has(step.status)) mediaBatch.pause(step.batch_id);
        else if (action === 'cancel' && step.status === 'queued') { step.status = 'cancelled'; updateAttempt(job, step); }
      }
    } else if (action === 'resume') {
      job.status = 'queued';
      for (const step of job.steps) {
        if (step.batch_id && (!TERMINAL.has(step.status) || step.status === 'needs_review')) mediaBatch.resume(step.batch_id);
        else if (step.status === 'cancelled' && !step.batch_id) { step.status = 'queued'; updateAttempt(job, step); }
      }
    } else throw fail('CONTROL_INVALID', '操作支持 pause/resume/cancel');
    store.record('job', job); schedule(); return job;
  }
  function importAssets(id, body) {
    return store.once(id, body.request_id, clean({ asset_ids: body.asset_ids }), () => store.mutate(id, canvas => applyOperations(canvas, body.asset_ids.map(assetId => {
      const asset = assets.getById(db, assetId, cfg); if (!asset) throw fail('ASSET_NOT_FOUND', `素材不存在：${assetId}`);
      return { type: 'add_node', kind: asset.type, data: { title: asset.name, media: { url: asset.url, local_path: asset.local_path, download_url: asset.download_url, asset_id: asset.id }, provenance: { asset_id: asset.id } } };
    }))));
  }
  function importResearch(id, body) {
    const research = injected.research || require('../productResearchJobs').createResearchJobs();
    const record = research.get(body.job_id);
    const data = research.records(body.job_id, { limit: 100, v: body.revision });
    const text = JSON.stringify(clean(data), null, 2);
    const query = record.query || data.query;
    const title = typeof query === 'string' ? query : query?.product || record.title || body.job_id;
    return operate(id, { request_id: body.request_id, operations: [{ type: 'add_node', kind: 'text', data: { title: `研究：${title}`, text,
      provenance: { type: 'research', job_id: body.job_id, revision: data.report_revision, total: data.total, imported: data.items.length, next_offset: data.next_offset } } }] });
  }
  function exportVideo(id, body) {
    const input = clean({ node_ids: body.node_ids, title: body.title || '画布成片', aspect_ratio: body.aspect_ratio || '16:9' });
    const result = store.once(id, body.request_id, input, () => {
      const canvas = store.get(id);
      if (!Array.isArray(input.node_ids) || !input.node_ids.length) throw fail('VIDEOS_REQUIRED', '按成片顺序选择视频节点');
      const scenes = input.node_ids.map(nodeId => {
        const n = nodeById(canvas, nodeId), media = n.data.media;
        if (n.kind !== 'video' || !(media?.local_path || media?.url)) throw fail('VIDEO_NOT_READY', `「${n.data.title}」还没有视频产物`);
        return { video_url: media.local_path || media.url, duration: n.data.settings?.duration || 0 };
      });
      const merge = merges.create(db, log, { title: input.title, scenes, merge_options: { strict: true, aspect_ratio: input.aspect_ratio } });
      const job = store.record('job', { id: uid(), canvas_id: id, kind: 'export', status: 'queued', merge_id: Number(merge.merge_id), node_ids: input.node_ids, created_at: now() });
      return { job_id: job.id };
    });
    schedule(); return { ...result, job: store.read('job', result.job_id, id) };
  }
  function reconcileExport(job) {
    if (TERMINAL.has(job.status)) return;
    const merge = merges.getById(db, job.merge_id);
    if (!merge) { job.status = 'failed'; job.error = '合成记录不存在'; store.record('job', job); return; }
    if (merge.status === 'completed') {
      job.status = 'completed'; job.media = { local_path: merge.merged_url, url: '/static/' + merge.merged_url.replaceAll('\\', '/'), type: 'video' };
      store.record('job', job); return;
    }
    if (merge.status === 'failed') { job.status = 'failed'; job.error = clean(merge.error_msg); store.record('job', job); return; }
    if (exports.has(job.id)) return;
    job.status = 'running'; store.record('job', job);
    // A child owns the FFmpeg tree, allowing shutdown during native decoding.
    const controller = new AbortController();
    const run = injected.exportRunner || (async () => {
      if (!db.name || db.name === ':memory:') return merges.processVideoMerge(db, log, job.merge_id, cfg.storage?.base_url, cfg.storage?.local_path);
      const { fork, spawn } = require('node:child_process');
      await new Promise((resolve, reject) => {
        if (controller.signal.aborted) return reject(new Error('导出已中断'));
        const child = fork(path.join(__dirname, 'mergeWorker.js'), [], { windowsHide: true, stdio: ['ignore','ignore','ignore','ipc'] });
        let receipt, timedOut = false;
        const kill = () => {
          if (process.platform === 'win32' && child.pid) {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => child.kill());
          } else child.kill('SIGTERM');
        };
        controller.signal.addEventListener('abort', kill, { once: true });
        const timeout = setTimeout(() => { timedOut = true; kill(); }, cfg.canvas?.export_timeout_ms || 1800000);
        child.once('message', result => { receipt = result; });
        child.once('error', reject);
        child.once('exit', code => {
          clearTimeout(timeout); controller.signal.removeEventListener('abort', kill);
          if (receipt?.ok && code === 0) resolve();
          else reject(new Error(timedOut ? '导出超时，可调整 canvas.export_timeout_ms 后重新导出' : receipt?.error || `导出进程退出 ${code}`));
        });
        child.send({ database: db.name, merge_id: job.merge_id, storage: cfg.storage });
      });
    });
    const promise = Promise.resolve().then(() => run(job, controller.signal)).catch(error => { const current = store.read('job', job.id); current.status = closed ? 'interrupted' : 'failed'; current.error = closed ? '本地导出已中断，下次启动继续合成' : clean(error.message); store.record('job', current); })
      .finally(() => { exports.delete(job.id); schedule(); });
    exports.set(job.id, { promise, controller });
  }
  function mediaFile(id, nodeId, jobId) {
    const media = jobId ? store.read('job', jobId, id).media : nodeById(store.get(id), nodeId).data.media;
    const file = assets.localFileMetadata(media?.local_path, cfg);
    if (!file) throw fail('MEDIA_FILE_MISSING', '本地媒体尚未下载成功，原始地址和任务仍保留', 404);
    return file;
  }
  async function stop() { closed = true; clearTimeout(timer); const active = [...exports.values()]; for (const entry of active) entry.controller.abort(); await Promise.allSettled(active.map(entry => entry.promise)); }
  const api = { store, clean, get, create: body => store.create(clean(body)), list: store.list, configure, operate, generate, pump, controlJob, importAssets, importResearch,
    exportVideo, mediaFile, message, messages: store.messages, stop, cfg, db, log,
    models: () => aiConfig.listConfigs(db).map(c => ({ id: c.id, name: c.name, service_type: c.service_type, model: c.model, default_model: c.default_model, provider: c.provider, api_protocol: c.api_protocol, is_active: c.is_active })) };
  schedule(); return api;
}
module.exports = { createCanvasService };
