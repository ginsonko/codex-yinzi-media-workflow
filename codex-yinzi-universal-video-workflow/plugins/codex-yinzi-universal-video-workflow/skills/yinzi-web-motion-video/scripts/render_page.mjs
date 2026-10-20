#!/usr/bin/env node
// Fallback renderer when the app's render_video tool is unavailable.
// Drives a local Chrome/Edge over the DevTools protocol (no npm packages; Node 22+ for the global
// WebSocket), calls window.renderFrame(i / fps) for every frame, captures a PNG and pipes it into
// FFmpeg as H.264.
//
// node render_page.mjs --html page.html --out out.mp4 --seconds 12 [--fps 30] [--width 1920]
//      [--height 1080] [--audio voice.wav] [--start 0] [--crf 16] [--browser path/to/chrome.exe]
//
// --start renders a partial range (seconds) so several processes can each encode one segment;
// join segments with ffmpeg's concat demuxer (-c copy).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    out[argv[i].slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

const a = args(process.argv.slice(2));
if (!a.html || !a.seconds) {
  console.error('usage: node render_page.mjs --html page.html --seconds N [--out out.mp4] [--fps 30] [--width 1920] [--height 1080] [--audio file] [--start 0]');
  process.exit(2);
}
const html = path.resolve(a.html);
const fps = Number(a.fps || 30);
const width = Number(a.width || 1920);
const height = Number(a.height || 1080);
const start = Number(a.start || 0);
const seconds = Number(a.seconds);
const out = path.resolve(a.out || path.join(path.dirname(html), path.basename(html, path.extname(html)) + '.mp4'));
const first = Math.round(start * fps);
const count = Math.round(seconds * fps);

function findBrowser() {
  const candidates = [
    a.browser, process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Edge found; pass --browser <path>');
  return hit;
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'web-motion-'));
const browser = spawn(findBrowser(), [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  '--force-device-scale-factor=1', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--allow-file-access-from-files', 'about:blank',
], { stdio: 'ignore' });

let ws;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  const port = await waitFor(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').split('\n')[0].trim(), 30000, 'DevTools port');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let seq = 0;
  const pending = new Map();
  const listeners = [];
  const errors = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    } else if (msg.method) {
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push(msg.params.args.map((x) => x.value ?? x.description).join(' '));
      listeners.forEach((l) => l(msg));
    }
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  const loaded = new Promise((res) => listeners.push((m) => m.method === 'Page.loadEventFired' && res()));
  await send('Page.navigate', { url: pathToFileURL(html).href });
  await loaded;
  await evaluate('Promise.resolve(window.ready).then(() => document.fonts.ready).then(() => true)');
  if (!(await evaluate('typeof window.renderFrame === "function"'))) throw new Error('page does not define window.renderFrame(t)');

  const ffArgs = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-'];
  if (a.audio) ffArgs.push('-ss', String(start), '-i', path.resolve(a.audio), '-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
  ffArgs.push('-c:v', 'libx264', '-preset', 'slow', '-crf', String(a.crf || 16), '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-t', String(count / fps), '-movflags', '+faststart', out);
  const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
  const ffDone = new Promise((res) => ff.on('close', res));

  const t0 = Date.now();
  for (let i = 0; i < count; i++) {
    const t = (first + i) / fps;
    await evaluate(`Promise.resolve(window.renderFrame(${t})).then(() => true)`);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width, height, scale: 1 } });
    if (!ff.stdin.write(Buffer.from(shot.data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % (fps * 2) === 0) process.stdout.write(`\rframe ${i}/${count}  ${((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1)} fps   `);
  }
  ff.stdin.end();
  const code = await ffDone;
  console.log(`\n${count} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${out}`);
  if (errors.length) console.log('page errors:', errors.slice(0, 10).join('\n'));
  if (code !== 0) throw new Error('ffmpeg exited with ' + code);
  if (errors.length) process.exitCode = 1;
} finally {
  try { ws?.close(); } catch {}
  browser.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}
