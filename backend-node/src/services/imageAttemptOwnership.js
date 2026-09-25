// Attempts always keep their own result. Only the newest request may publish
// into an entity's current image; completion order must not decide ownership.
const LAST_FRAME_TYPES = new Set(['last', 'storyboard_last', 'tail', 'last_frame']);

function frameSlot(frameType) {
  const type = String(frameType || '').trim().toLowerCase();
  if (/^(quad|nine)_panel_\d+$/.test(type)) return null;
  if (type === 'quad_grid' || type === 'nine_grid') return type;
  return LAST_FRAME_TYPES.has(type) ? 'last' : 'first';
}

function resolveStoryboardFrameType(db, storyboardId, frameType) {
  if (storyboardId == null || String(frameType || '').trim()) return frameType ?? null;
  // Fix the destination before any asynchronous work. Looking at the newest
  // prompt on completion can otherwise turn an old first frame into a tail.
  try {
    const prompt = db.prepare(
      'SELECT frame_type FROM frame_prompts WHERE storyboard_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1'
    ).get(Number(storyboardId));
    const type = String(prompt?.frame_type || '').trim().toLowerCase();
    if (LAST_FRAME_TYPES.has(type)) return 'storyboard_last';
    if (['first', 'storyboard_first', 'first_frame'].includes(type)) return 'storyboard_first';
  } catch (_) {}
  return frameType ?? null;
}

function isLatestTaskAttempt(db, taskId) {
  const current = db.prepare('SELECT rowid AS attempt_order, * FROM async_tasks WHERE id = ?').get(taskId);
  if (!current || current.deleted_at) return false;
  // rowid is insertion order even when requests share a timestamp. A deleted
  // newer attempt does not make an older in-flight callback current again.
  const newer = db.prepare(
    'SELECT 1 FROM async_tasks WHERE type = ? AND resource_id = ? AND rowid > ? LIMIT 1'
  ).get(current.type, current.resource_id, current.attempt_order);
  return !newer;
}

function isLatestImageAttempt(db, imageGenId, target = {}) {
  const current = db.prepare('SELECT * FROM image_generations WHERE id = ?').get(imageGenId);
  if (!current || current.deleted_at || frameSlot(current.frame_type) === null) return false;
  const kind = target.kind || (current.storyboard_id != null ? 'storyboard'
    : current.character_id != null ? 'character' : current.scene_id != null ? 'scene' : null);
  if (!kind) return true;
  const column = { character: 'character_id', scene: 'scene_id', storyboard: 'storyboard_id' }[kind];
  if (!column) return false;
  const entityId = target.id ?? current[column];
  if (entityId == null) return false;
  let candidates;
  try {
    candidates = db.prepare(`SELECT id, storyboard_id, frame_type FROM image_generations WHERE ${column} = ? AND id > ? ORDER BY id DESC`)
      .all(entityId, imageGenId);
  } catch (error) {
    // Legacy character/scene creation already supports databases without their
    // relation columns. Their task resource still identifies the same entity.
    if (!String(error.message || '').includes('no such column')) throw error;
    return !!current.task_id && isLatestTaskAttempt(db, current.task_id);
  }
  const slot = frameSlot(target.frameType ?? current.frame_type);
  return !candidates.some((candidate) => {
    const candidateSlot = frameSlot(candidate.frame_type);
    if (candidateSlot === null) return false;
    if (kind !== 'storyboard') return candidate.storyboard_id == null;
    return target.shared === true || candidateSlot === slot;
  });
}

module.exports = { frameSlot, resolveStoryboardFrameType, isLatestTaskAttempt, isLatestImageAttempt };
