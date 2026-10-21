'use strict';
const { uid, clone, fail } = require('./store');
const KINDS = ['text', 'image', 'video', 'audio'];
const ROLES = ['reference', 'first_frame', 'last_frame', 'context'];
const DATA_FIELDS = ['title', 'prompt', 'text', 'settings', 'media', 'provenance'];
const nodeById = (canvas, id) => { const node = canvas.nodes.find(n => n.id === id); if (!node) throw fail('NODE_NOT_FOUND', `节点不存在：${id}`, 404); return node; };
function position(value) {
  if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw fail('INVALID_POSITION', '节点坐标须为有限数字');
  return { x: value.x, y: value.y };
}
function plain(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_OBJECT', `${name} 须为对象`);
  return clone(value);
}
function fields(input = {}) {
  const result = {};
  for (const key of DATA_FIELDS) if (input[key] !== undefined) {
    result[key] = ['settings', 'media', 'provenance'].includes(key) ? plain(input[key], key) : String(input[key]);
  }
  return result;
}
function checkVersion(node, op) {
  if (op.expected_version == null || Number(op.expected_version) !== node.version)
    throw fail('NODE_VERSION_CONFLICT', `「${node.data.title || node.id}」已被编辑，请读取当前节点后合并修改（当前版本 ${node.version}）`, 409);
}
function applyOperations(canvas, operations) {
  if (!Array.isArray(operations) || !operations.length) throw fail('OPERATIONS_REQUIRED', '请提供画布操作列表');
  const changed = [];
  for (const op of operations) {
    if (op.type === 'add_node') {
      const kind = op.kind || 'text', id = String(op.id || uid());
      if (!KINDS.includes(kind)) throw fail('NODE_KIND_INVALID', '节点类型支持 text/image/video/audio');
      if (canvas.nodes.some(n => n.id === id)) throw fail('NODE_EXISTS', `节点 ${id} 已存在`, 409);
      const node = { id, kind, version: 1, position: position(op.position || { x: canvas.nodes.length % 4 * 320, y: Math.floor(canvas.nodes.length / 4) * 300 }),
        data: { title: kind === 'text' ? '文本 / 剧本' : kind, prompt: '', settings: {}, ...fields(op.data) }, attempts: [] };
      canvas.nodes.push(node); changed.push(node);
    } else if (op.type === 'update_node') {
      const node = nodeById(canvas, op.id); checkVersion(node, op);
      if (op.data?.media !== undefined) node.active_attempt_id = null;
      node.data = { ...node.data, ...fields(op.data) }; node.version++; changed.push(node);
    } else if (op.type === 'move_node') {
      const node = nodeById(canvas, op.id); node.position = position(op.position); changed.push(node);
    } else if (op.type === 'delete_node') {
      const node = nodeById(canvas, op.id); checkVersion(node, op);
      canvas.nodes = canvas.nodes.filter(n => n.id !== op.id); canvas.edges = canvas.edges.filter(e => e.source !== op.id && e.target !== op.id);
      changed.push({ deleted: op.id });
    } else if (op.type === 'connect') {
      nodeById(canvas, op.source); nodeById(canvas, op.target);
      if (op.source === op.target) throw fail('SELF_REFERENCE', '节点不能引用自己');
      const role = op.role || 'reference';
      if (!ROLES.includes(role)) throw fail('EDGE_ROLE_INVALID', '引用用途支持 reference/first_frame/last_frame/context');
      if (['first_frame', 'last_frame'].includes(role) && nodeById(canvas, op.source).kind !== 'image') throw fail('FRAME_KIND_INVALID', '首尾帧须连接图片节点');
      const existing = canvas.edges.find(e => e.source === op.source && e.target === op.target && e.role === role);
      if (existing) { changed.push(existing); continue; }
      const edge = { id: String(op.id || uid()), source: op.source, target: op.target, role };
      if (canvas.edges.some(e => e.id === edge.id)) throw fail('EDGE_EXISTS', '连线 ID 已存在', 409);
      canvas.edges.push(edge); changed.push(edge);
    } else if (op.type === 'disconnect') {
      canvas.edges = canvas.edges.filter(e => e.id !== op.id); changed.push({ disconnected: op.id });
    } else if (op.type === 'select_attempt') {
      const node = nodeById(canvas, op.id); checkVersion(node, op);
      const attempt = node.attempts.find(a => a.id === op.attempt_id && a.status === 'completed');
      if (!attempt?.media) throw fail('ATTEMPT_NOT_READY', '这个版本还没有可用产物');
      node.data.media = clone(attempt.media); node.active_attempt_id = attempt.id; node.version++; changed.push(node);
    } else throw fail('OPERATION_UNKNOWN', `不认识的画布操作：${op.type}`);
  }
  return { changed: clone(changed), revision: canvas.revision + 1 };
}

function snapshotGeneration(canvas, nodeIds) {
  if (!Array.isArray(nodeIds) || !nodeIds.length) throw fail('NODES_REQUIRED', '选择需要生成的节点');
  const ids = [...new Set(nodeIds)], selected = new Set(ids);
  const steps = ids.map(id => {
    const node = nodeById(canvas, id);
    if (!['image', 'video'].includes(node.kind)) throw fail('NOT_GENERATABLE', `「${node.data.title}」不是图片或视频生成节点`);
    const inputs = canvas.edges.filter(e => e.target === id).map(edge => ({ ...clone(edge), node: clone(nodeById(canvas, edge.source)), dependency: selected.has(edge.source) }));
    for (const role of ['first_frame', 'last_frame']) if (inputs.filter(i => i.role === role).length > 1) throw fail('DUPLICATE_FRAME', `${node.data.title} 的${role === 'first_frame' ? '首' : '尾'}帧连接了多张图片，请保留一张`);
    return { node_id: id, node_version: node.version, kind: node.kind, data: clone(node.data), inputs, status: 'queued', attempt_id: uid() };
  });
  const visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) throw fail('GENERATION_CYCLE', '本次生成的引用形成循环，请断开一条连线或分次生成');
    if (done.has(id)) return;
    visiting.add(id); steps.find(s => s.node_id === id).inputs.filter(i => i.dependency).forEach(i => visit(i.source)); visiting.delete(id); done.add(id);
  }
  ids.forEach(visit);
  return steps;
}
// Model names such as "Kling ... -1080p" or "seedance 720p-fast" already fix the output size.
const MODEL_RESOLUTION = /\d{3,4}\s*p|[248]k\b/i;
/** Videos default to 720p (cheaper and faster); higher only when the node or the model asks for it. */
function defaultVideoResolution(settings = {}) {
  if (settings.resolution || MODEL_RESOLUTION.test(String(settings.model || ''))) return settings.resolution;
  return '720p';
}
function requestForStep(step, steps) {
  const request = { ...step.data.settings, prompt: step.data.prompt || step.data.text || '' };
  if (step.kind === 'video') {
    const resolution = defaultVideoResolution(request);
    if (resolution) request.resolution = resolution;
  }
  const images = [], videos = [], audios = [], texts = [];
  for (const input of step.inputs) {
    const media = input.dependency ? steps.find(s => s.node_id === input.source)?.media : input.node.data.media;
    if (input.node.kind === 'text') { texts.push(input.node.data.text || input.node.data.prompt || ''); continue; }
    const value = media?.local_path || media?.url;
    if (!value) throw fail('REFERENCE_NOT_READY', `参考节点「${input.node.data.title}」尚无媒体，请先上传或生成`);
    if (input.node.kind === 'image') {
      if (step.kind === 'video' && ['first_frame', 'last_frame'].includes(input.role)) request[input.role + '_url'] = value;
      else images.push(value);
    } else if (input.node.kind === 'video') videos.push(value); else if (input.node.kind === 'audio') audios.push(value);
  }
  if (texts.length) request.prompt = [request.prompt, ...texts].filter(Boolean).join('\n\n');
  if (step.kind === 'image') request.reference_images = [...(request.reference_images || []), ...images];
  else {
    request.reference_image_urls = [...(request.reference_image_urls || []), ...images];
    request.reference_video_urls = [...(request.reference_video_urls || []), ...videos];
    request.reference_audio_urls = [...(request.reference_audio_urls || []), ...audios];
  }
  return request;
}
module.exports = { applyOperations, snapshotGeneration, requestForStep, defaultVideoResolution, nodeById, KINDS, ROLES };
