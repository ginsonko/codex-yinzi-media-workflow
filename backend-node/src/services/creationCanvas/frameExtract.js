'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fail, clone } = require('./store');
const { nodeById } = require('./graph');
const { getFfmpegPath } = require('../../utils/ffmpegPath');

const segment = value => String(value || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'node';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(getFfmpegPath(), args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(stderr.slice(-300) || `FFmpeg 退出 ${code}`))));
  });
}

// A finished clip's boundary frame becomes an image node, so the next shot can
// use it as a strict first frame or a plain visual reference. The output path
// and node id are deterministic per source node and position: re-extracting
// after a regeneration overwrites the same file and updates the same node.
async function extractFrame(service, id, nodeId, body = {}) {
  const position = body.position === 'first' ? 'first' : 'last';
  const canvas = service.store.get(id);
  const node = nodeById(canvas, nodeId);
  if (node.kind !== 'video') throw fail('FRAME_SOURCE_NOT_VIDEO', `「${node.data.title || nodeId}」不是视频节点，只能从已完成视频提取画面`);
  const file = service.mediaFile(id, nodeId);
  const root = path.resolve(service.cfg.storage?.local_path || './data/storage');
  const safe = segment(nodeId);
  const relative = `canvas-frames/${segment(id)}/${safe}-${position}.png`;
  const target = path.join(root, 'canvas-frames', segment(id), `${safe}-${position}.png`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // -update 1 decodes to completion and keeps rewriting one PNG, so the final
  // write is the true last decoded frame rather than a near-tail seek.
  const args = ['-v', 'error', '-y', '-i', file.path, '-map', '0:v:0', '-an'];
  if (position === 'last') args.push('-fps_mode', 'passthrough', '-update', '1');
  else args.push('-frames:v', '1');
  try {
    await runFfmpeg([...args, target]);
  } catch (error) {
    throw fail('FRAME_EXTRACT_FAILED', `画面提取失败：${error.message}`);
  }
  if (!fs.existsSync(target) || !fs.statSync(target).size) throw fail('FRAME_EXTRACT_FAILED', '画面提取后没有生成文件');
  const result = service.store.once(id, body.request_id, { node_id: nodeId, position }, () =>
    service.store.mutate(id, current => {
      const source = nodeById(current, nodeId);
      const frameId = `frame-${safe}-${position}`;
      const media = { local_path: relative, url: '/static/' + relative, type: 'image' };
      const title = `「${source.data.title || nodeId}」${position === 'last' ? '尾帧' : '首帧'}`;
      const existing = current.nodes.find(n => n.id === frameId);
      if (existing) {
        existing.data = { ...existing.data, title, media };
        existing.active_attempt_id = null;
        existing.version++;
        return { position, node: clone(existing), updated: true };
      }
      const frame = { id: frameId, kind: 'image', version: 1,
        position: { x: source.position.x + 360, y: source.position.y },
        data: { title, prompt: '', settings: {}, media, provenance: { type: 'frame_extraction', source_node_id: nodeId, position } },
        attempts: [] };
      current.nodes.push(frame);
      return { position, node: clone(frame), created: true };
    }));
  if (!result.reused) service.message(id, { role: 'event', content: `已提取${result.node.data.title}，可连接为下一镜头的首帧或参考图`, node_id: result.node.id });
  return result;
}

module.exports = { extractFrame };
