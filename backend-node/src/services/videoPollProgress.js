const taskService = require('./taskService');

function pollObservation(data, status) {
  const raw = data?.progress ?? data?.data?.progress;
  const text = typeof raw === 'string' ? raw.trim().replace(/%$/, '').trim() : raw;
  const value = (typeof text === 'number' || (typeof text === 'string' && text !== '')) ? Number(text) : NaN;
  return {
    status: String(status || '').slice(0, 80),
    progress: Number.isFinite(value) && value >= 0 && value <= 100 ? value : null,
  };
}

function recordPollProgress(db, videoGenId, providerTaskId, observation) {
  const row = db.prepare('SELECT status, provider_task_id, task_id FROM video_generations WHERE id = ? AND deleted_at IS NULL').get(videoGenId);
  if (!row || row.status !== 'processing' || row.provider_task_id !== providerTaskId || !row.task_id) return false;
  const task = taskService.getTask(db, row.task_id);
  if (!task || !['pending', 'processing'].includes(task.status)) return false;
  const state = observation.status;
  const waiting = ['queued', 'pending', 'submitted', 'waiting'].includes(state);
  const finished = ['completed', 'succeeded', 'success', 'done', 'finalizing'].includes(state);
  const label = finished ? '上游已结束生成，正在准备取回成片' : waiting ? '上游正在排队' : '已查询上游，正在等待生成结果';
  const percent = observation.progress;
  const hasProgress = typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100;
  // Local completion still requires the existing finalization/download path.
  const progress = hasProgress ? Math.min(99, percent) : task.progress;
  const message = hasProgress ? `${label}（上游进度 ${percent}%）` : label;
  taskService.updateTaskStatus(db, row.task_id, 'processing', progress, message);
  return true;
}

module.exports = { pollObservation, recordPollProgress };
