'use strict';

const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

const cdpUrl = process.argv[2] || 'http://127.0.0.1:9225';
const outputDir = process.argv[3] || 'release-acceptance/v01-beta1/ui-evidence';
fs.mkdirSync(outputDir, { recursive: true });

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const target = (await getJson(`${cdpUrl}/json`)).find((item) => item.type === 'page');
  if (!target) throw new Error('没有找到 Electron 页面');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message));
    else item.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expression, awaitPromise = true) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面执行失败');
    return result.result?.value;
  };
  const capture = async (name) => {
    const result = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(`${outputDir}/${name}.png`, Buffer.from(result.data, 'base64'));
  };
  const navigate = async (pathname) => {
    await evaluate(`location.href = ${JSON.stringify(pathname)}`);
    await new Promise((resolve) => setTimeout(resolve, 900));
  };
  const snapshot = async (name) => {
    const value = await evaluate(`JSON.stringify({
      title: document.title,
      url: location.href,
      text: (document.body.innerText || '').slice(0, 6000),
      buttons: [...document.querySelectorAll('button')].map((node) => (node.innerText || node.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 60),
      errors: [...document.querySelectorAll('.el-message--error, .el-alert--error')].map((node) => (node.innerText || '').trim()),
    })`);
    fs.writeFileSync(`${outputDir}/${name}.json`, `${value}\n`, 'utf8');
    await capture(name);
    return JSON.parse(value);
  };
  const report = { pages: [], simulation: {}, console_errors: [] };
  report.pages.push(await snapshot('home'));
  await navigate('/guided-demo');
  report.pages.push(await snapshot('guided-demo-start'));
  await evaluate(`(() => { const node = [...document.querySelectorAll('button')].find((x) => /下一步|开始|继续/.test(x.innerText || '')); if (node) node.click(); return Boolean(node); })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  report.simulation.after_first_action = await snapshot('guided-demo-after-action');
  await navigate('/advanced-settings');
  report.pages.push(await snapshot('advanced-settings'));
  await navigate('/help');
  report.pages.push(await snapshot('help'));
  await navigate('/director?tutorial=1');
  report.pages.push(await snapshot('director'));
  report.simulation.canvas = await evaluate(`(() => { const node = [...document.querySelectorAll('canvas')].find((x) => x.offsetWidth > 100 && x.offsetHeight > 100); if (!node) return null; return { width: node.width, height: node.height, cssWidth: node.offsetWidth, cssHeight: node.offsetHeight }; })()`);
  fs.writeFileSync(`${outputDir}/report.json`, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ outputDir, pages: report.pages.length, canvas: report.simulation.canvas, errors: report.console_errors.length }, null, 2));
  socket.close();
}

main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
