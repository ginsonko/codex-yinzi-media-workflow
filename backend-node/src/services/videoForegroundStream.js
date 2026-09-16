'use strict';

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');

/**
 * Creates an on-demand frame reader process that streams rawvideo frames from a video source.
 * Handles looping for shorter auxiliary videos.
 */
function createVideoFrameReader({
  ffmpeg,
  inputPath,
  width,
  height,
  fps,
  duration,
  pixFmt = 'rgba', // 'rgba' (4 bytes) | 'gray' (1 byte)
  decoderArgs = [],
  signal,
  idleMs = 180000,
}) {
  const bytesPerPixel = pixFmt === 'gray' ? 1 : 4;
  const frameBytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0 || frameBytes > 200_000_000) {
    throw new Error(`Invalid frame dimensions for streaming: ${width}x${height}`);
  }

  const args = [
    '-nostdin', '-v', 'error',
    '-stream_loop', '-1',
    ...decoderArgs,
    '-i', inputPath,
    '-map', '0:v:0',
    '-vf', `setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height},setsar=1`,
    '-t', String(duration),
    '-pix_fmt', pixFmt,
    '-f', 'rawvideo',
    'pipe:1',
  ];

  const child = spawn(ffmpeg, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  let stderr = '';
  let closed = false;
  let timedOut = false;
  let pending = Buffer.alloc(0);
  let offset = 0;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const done = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', code => resolve({ code }));
  });
  const iterator = child.stdout[Symbol.asyncIterator]();
  const abort = () => child.kill();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();

  async function pull() {
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, idleMs);
    timer.unref();
    try { return await iterator.next(); }
    finally { clearTimeout(timer); }
  }

  async function nextFrame() {
    if (closed) return null;
    const frame = Buffer.allocUnsafe(frameBytes);
    let filled = 0;
    while (filled < frameBytes) {
      if (signal?.aborted) throw new Error('Video frame reader cancelled');
      if (offset === pending.length) {
        const chunk = await pull();
        if (chunk.done) {
          const result = await done;
          if (result.error || result.code !== 0 || timedOut || filled) {
            throw new Error(`Video frame reader failed: ${result.error?.message || stderr || (timedOut ? 'decoder timed out' : 'incomplete frame')}`);
          }
          return null;
        }
        pending = chunk.value;
        offset = 0;
      }
      const count = Math.min(frameBytes - filled, pending.length - offset);
      pending.copy(frame, filled, offset, offset + count);
      filled += count;
      offset += count;
    }
    return frame;
  }

  async function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', abort);
    child.kill();
    child.stdout.destroy();
    await done;
    pending = Buffer.alloc(0);
  }

  return { nextFrame, close, get bufferedBytes() { return pending.length - offset + child.stdout.readableLength; } };
}

/**
 * Streaming rawvideo frame transformation via FFmpeg child processes.
 * Decodes input video into RGBA raw bytes frame-by-frame and streams into transform.
 * The transformed RGBA buffer is immediately written into encoder stdin.
 *
 * Memory consumption is strictly bounded by 2-3 frame buffers and standard OS pipe buffers,
 * regardless of video duration (O(1) memory complexity, no PNG frame disk caching).
 */
async function transformVideoFrames({
  ffmpeg,
  inputPath,
  outputPath,
  width,
  height,
  fps,
  duration,
  transform,
  signal,
  idleMs = 180000,
  encoderArgs = [],
  pixFmt = 'yuv420p',
  container = 'mp4',
  decoderArgs = [],
}) {
  const frameBytes = width * height * 4; // RGBA input & intermediate
  if (!Number.isSafeInteger(frameBytes) || frameBytes <= 0 || frameBytes > 200_000_000) {
    throw new Error(`Invalid frame dimensions for streaming: ${width}x${height}`);
  }

  let stderr = '';
  let lastActivity = Date.now();

  function launch(args, stdio) {
    const child = spawn(ffmpeg, args, { stdio, windowsHide: true, shell: false });
    child.stderr.on('data', data => {
      stderr = (stderr + data).slice(-4000);
    });
    child.done = new Promise(resolve => {
      child.once('error', error => resolve({ error }));
      child.once('close', code => resolve({ code }));
    });
    return child;
  }

  // Decoder: rawvideo RGBA pipe
  const decArgs = [
    '-nostdin', '-v', 'error',
    '-threads', '2', '-filter_threads', '2',
    ...decoderArgs,
    '-i', inputPath,
    '-map', '0:v:0',
    '-vf', `setpts=PTS-STARTPTS,fps=${fps},scale=${width}:${height},setsar=1`,
    '-t', String(duration),
    '-pix_fmt', 'rgba',
    '-f', 'rawvideo',
    'pipe:1',
  ];

  // Encoder args based on output format & alpha requirement
  let defaultEncArgs;
  if (container === 'mov_alpha') {
    defaultEncArgs = [
      '-an',
      '-c:v', 'qtrle',
      '-pix_fmt', 'argb',
    ];
  } else if (container === 'webm_alpha') {
    defaultEncArgs = [
      '-an',
      '-c:v', 'libvpx-vp9',
      '-crf', '24',
      '-b:v', '0',
      '-auto-alt-ref', '0',
      '-pix_fmt', 'yuva420p',
      '-metadata:s:v:0', 'alpha_mode=1',
    ];
  } else {
    defaultEncArgs = [
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-pix_fmt', pixFmt,
      '-movflags', '+faststart',
    ];
  }

  const encArgs = [
    '-nostdin', '-y', '-v', 'error',
    '-threads', '2', '-filter_threads', '2',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`,
    '-r', String(fps),
    '-i', 'pipe:0',
    ...(encoderArgs.length ? encoderArgs : defaultEncArgs),
    outputPath,
  ];

  const decoder = launch(decArgs, ['ignore', 'pipe', 'pipe']);
  const encoder = launch(encArgs, ['pipe', 'ignore', 'pipe']);

  let pipeError;
  encoder.stdin.on('error', error => {
    pipeError = error;
    decoder.kill();
  });

  const abort = () => {
    decoder.kill();
    encoder.kill();
  };
  signal?.addEventListener('abort', abort, { once: true });

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > idleMs) {
      abort();
    }
  }, 1000);
  timer.unref();

  let frame = Buffer.allocUnsafe(frameBytes);
  let filled = 0;
  let count = 0;

  try {
    if (signal?.aborted) throw new Error('Video frame processing cancelled');

    for await (const chunk of decoder.stdout) {
      let offset = 0;
      while (offset < chunk.length) {
        const n = Math.min(chunk.length - offset, frameBytes - filled);
        chunk.copy(frame, filled, offset, offset + n);
        filled += n;
        offset += n;

        if (filled === frameBytes) {
          if (signal?.aborted) throw new Error('Video frame processing cancelled');
          lastActivity = Date.now();

          const output = await transform(frame, count++);
          if (!Buffer.isBuffer(output) || output.length !== frameBytes) {
            throw new Error(`Frame transform returned incorrect buffer length: expected ${frameBytes}, got ${output?.length}`);
          }

          if (pipeError) throw pipeError;
          if (!encoder.stdin.write(output)) {
            await once(encoder.stdin, 'drain');
          }

          frame = Buffer.allocUnsafe(frameBytes);
          filled = 0;
          lastActivity = Date.now();
        }
      }
    }

    encoder.stdin.end();
    const results = await Promise.all([decoder.done, encoder.done]);
    if (filled || !count || results.some(r => r.error || r.code !== 0)) {
      throw new Error(`Video streaming pipeline failed: ${stderr || 'child process exited non-zero'}`);
    }

    return {
      frame_count: count,
      processing: 'streaming',
      max_frame_buffer_bytes: frameBytes * 3,
    };
  } catch (error) {
    abort();
    await Promise.all([decoder.done, encoder.done]);
    fs.rmSync(outputPath, { force: true });
    throw error;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener('abort', abort);
  }
}

module.exports = {
  transformVideoFrames,
  createVideoFrameReader,
};
