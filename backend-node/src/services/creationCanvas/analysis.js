'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { uid, fail } = require('./store');
const { nodeById } = require('./graph');
const { getFfmpegPath, getFfprobePath } = require('../../utils/ffmpegPath');

async function inspectMedia(service, id, nodeId) {
  const node = nodeById(service.store.get(id), nodeId);
  const file = service.mediaFile(id, nodeId);
  let report, images = [];
  if (node.kind === 'image') {
    const metadata = await require('sharp')(file.path).metadata();
    report = { type: 'image', format: metadata.format, width: metadata.width, height: metadata.height, bytes: file.size,
      limitation: '这是文件属性；视觉判断需要读取图片。' };
    images.push(node.data.media.local_path);
  } else {
    const root = path.resolve(service.cfg.storage?.local_path || './data/storage');
    const output = path.join(root, 'canvas-analysis', uid(), 'report.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const operation = node.kind === 'audio' ? require('../audioBeatAnalysis') : require('../videoShotAnalysis');
    await operation.executeNative({ inputPath: file.path, outputPath: output,
      components: { 'media.ffmpeg': { executables: { ffmpeg: getFfmpegPath(), ffprobe: getFfprobePath() } }, 'media.sharp': { directory: path.resolve(__dirname, '../../..') } },
      report: progress => service.message(id, { role: 'event', content: progress.message || progress.stage, node_id: nodeId }) });
    report = JSON.parse(fs.readFileSync(output, 'utf8'));
    const contact = path.join(path.dirname(output), 'contact-sheet.png');
    if (fs.existsSync(contact)) images.push(path.relative(root, contact).replaceAll('\\', '/'));
    report.report_url = '/static/' + path.relative(root, output).replaceAll('\\', '/');
  }
  const result = { node_id: nodeId, analysis: service.clean(report), vision_paths: images };
  service.message(id, { role: 'analysis', content: JSON.stringify(result.analysis), node_id: nodeId, vision_paths: images });
  return result;
}
async function imageContent(service, localPaths) {
  const assets = require('../assetService'), result = [];
  for (const local_path of localPaths) {
    const file = assets.localFileMetadata(local_path, service.cfg);
    if (!file) throw fail('VISION_FILE_MISSING', '待查看图片已不存在');
    const image = await require('sharp')(file.path).resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    result.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + image.toString('base64') } });
  }
  return result;
}
module.exports = { inspectMedia, imageContent };
