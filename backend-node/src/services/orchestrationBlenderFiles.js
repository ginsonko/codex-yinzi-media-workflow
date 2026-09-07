const fs = require('node:fs');
const path = require('node:path');

function localFile(root, relative) {
  if (typeof relative !== 'string' || !relative || /[:\x00-\x1f]/.test(relative) || path.isAbsolute(relative)) return null;
  const target = path.resolve(root, relative);
  const check = path.relative(root, target);
  if (!check || check === '..' || check.startsWith('..' + path.sep) || path.isAbsolute(check)) return null;
  try {
    const real = fs.realpathSync(target);
    const actual = path.relative(fs.realpathSync(root), real);
    if (actual.startsWith('..') || path.isAbsolute(actual)) return null;
    const stat = fs.statSync(real);
    return stat.isFile() && stat.size > 0 ? { absolute: real, relative: check.replace(/\\/g, '/'), bytes: stat.size } : null;
  } catch (_) { return null; }
}

function validFile(root, relative) {
  const file = localFile(root, relative);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file.absolute, 'r');
    const header = Buffer.alloc(12);
    fs.readSync(fd, header, 0, 12, 0);
    if (/\.png$/i.test(relative)) {
      const tail = Buffer.alloc(12);
      if (file.bytes < 32 || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
      fs.readSync(fd, tail, 0, 12, file.bytes - 12);
      if (tail.subarray(4, 8).toString() !== 'IEND') return null;
    }
    if (/\.glb$/i.test(relative) && (header.toString('ascii', 0, 4) !== 'glTF' || header.readUInt32LE(8) !== file.bytes)) return null;
    // Blender can save gzip or Zstandard containers by default. These headers
    // identify the container; editable-scene QA remains a separate Blender open.
    if (/\.blend$/i.test(relative) && header.toString('ascii', 0, 7) !== 'BLENDER'
      && header.subarray(0, 4).toString('hex') !== '28b52ffd'
      && header.subarray(0, 2).toString('hex') !== '1f8b') return null;
    if (/\.mp4$/i.test(relative) && header.toString('ascii', 4, 8) !== 'ftyp') return null;
    return file;
  } catch (_) { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readManifest(outputDir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    return value?.blender ? { ...value.blender, video: value.video || value.blender.video } : value;
  } catch (_) { return {}; }
}

function inspectOutputs(outputDir, plan) {
  const expected = plan.profile.frames.map((frame) => 'frames/frame-' + String(frame).padStart(4, '0') + '.png');
  const frames = expected.filter((file) => validFile(outputDir, file));
  const manifest = readManifest(outputDir);
  const blend = validFile(outputDir, 'scene.blend') ? 'scene.blend' : null;
  const glb = validFile(outputDir, 'scene.glb') ? 'scene.glb' : null;
  const video = validFile(outputDir, 'preview.mp4') && manifest.video?.status === 'succeeded'
    ? { ...manifest.video, relative_path: 'preview.mp4' } : { status: 'pending' };
  return {
    schema: 'yinzi.blender-render-result/v1',
    plan_id: plan.plan_id, scene_hash: plan.scene.hash,
    engine: manifest.engine || plan.profile.engine, frames, blend, glb, video,
    warnings: Array.isArray(manifest.warnings) ? manifest.warnings.slice(0, 100) : [],
    missing_frames: expected.filter((file) => !frames.includes(file)),
    render_complete: frames.length === expected.length && Boolean(blend && glb),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(temp, file);
}

function encodingArgs(outputDir, plan, frames) {
  const fps = plan.profile.fps;
  const numbers = frames.map((name) => Number(/frame-(\d+)/.exec(name)?.[1]));
  const total = Math.max(1, Math.round(plan.scene.duration_seconds * fps));
  const lines = frames.flatMap((name, index) => {
    const duration = Math.max(1, (numbers[index + 1] || total + 1) - numbers[index]) / fps;
    return ["file '" + name.replace(/'/g, "'\\''") + "'", 'duration ' + duration.toFixed(8)];
  });
  lines.push("file '" + frames.at(-1).replace(/'/g, "'\\''") + "'");
  fs.writeFileSync(path.join(outputDir, 'frames.concat.txt'), lines.join('\n') + '\n', 'utf8');
  return [
    '-y', '-f', 'concat', '-safe', '0', '-i', 'frames.concat.txt',
    '-t', String(plan.scene.duration_seconds),
    '-vf', 'fps=' + fps + ',pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'preview.pending.mp4',
  ];
}

module.exports = { localFile, validFile, readManifest, inspectOutputs, writeJson, encodingArgs };
