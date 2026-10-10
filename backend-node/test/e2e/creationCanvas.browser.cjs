// Run after frontweb build: node test/e2e/creationCanvas.browser.cjs
// Real browser, multipart, HTTP model tool loop, media adapters and FFmpeg;
// every provider endpoint is a local fixture. No installed data or paid calls.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { startCanvasHarness } = require('../helpers/canvasHarness');
const toolCall = (name, args) => ({ id: 'call-' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } });
async function waitFor(fn, label, timeout = 30000) { const started = Date.now(); while (Date.now() - started < timeout) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw Error('Timeout: ' + label); }
(async () => {
  let h, canvasId;
  h = await startCanvasHarness({ frontend: path.resolve(__dirname, '../../../frontweb/dist'), keep: true,
    completion: (request, count) => {
      if (count === 1) {
        const uploaded = h.canvas.service.get(canvasId).nodes.find(n => n.kind === 'image');
        return { content: '先整理剧本并创建两个使用同一参考图的视频节点。', tool_calls: [toolCall('edit_canvas', { operations: [
          { type: 'add_node', id: 'story', kind: 'text', data: { title: '开场剧本', text: '从角色登场到场景展开，保持动作连续。' } },
          ...['shot-a', 'shot-b'].flatMap((id, i) => [{ type: 'add_node', id, kind: 'video', position: { x: 340 + i * 320, y: 60 }, data: { title: '镜头 ' + (i + 1), prompt: 'Local fixture scene ' + i, settings: { video_config_id: h.configs.video.id, model: h.configs.video.default_model, duration: 3, aspect_ratio: '16:9' } } }, { type: 'connect', source: uploaded.id, target: id, role: 'first_frame' }]),
        ] })] };
      }
      if (count === 2) return { tool_calls: [toolCall('generate_nodes', { node_ids: ['shot-a', 'shot-b'] })] };
      if (count === 3) {
        const result = JSON.parse(request.messages.filter(m => m.role === 'tool').at(-1).content);
        return { tool_calls: [toolCall('wait_job', { job_id: result.job_id, seconds: 30 })] };
      }
      return { content: '两个镜头已经保存到画布。请查看实际素材，再决定修改或导出。' };
    } });
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1080 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const checks = [];
  try {
    await page.goto(h.base + '/create-canvas');
    await page.getByRole('button', { name: '创建第一张画布' }).click();
    await page.locator('.el-message-box input').fill('画布本地闭环验收');
    await page.locator('.el-message-box').getByRole('button', { name: 'OK', exact: true }).click().catch(async () => page.locator('.el-message-box__btns button').last().click());
    await waitFor(async () => /\/create-canvas\/[a-f0-9-]+/.test(page.url()), 'create canvas route');
    canvasId = page.url().split('/').pop();
    checks.push('manual creation and persistent route');
    await page.getByLabel('上传画布素材', { exact: true }).setInputFiles({ name: '角色参考.png', mimeType: 'image/png', buffer: h.image });
    await waitFor(() => h.canvas.service.get(canvasId).nodes.length === 1, 'uploaded reference node');
    await page.getByRole('button', { name: 'Agent 配置', exact: true }).click();
    await page.locator('.el-select').filter({ has: page.getByRole('combobox', { name: 'Agent文本配置', exact: true }) }).locator('.el-select__wrapper').click();
    await page.getByRole('option', { name: '本地验收 text', exact: true }).click();
    await page.getByRole('button', { name: '用于当前画布', exact: true }).click();
    await page.getByRole('tab', { name: '创作助手', exact: true }).click();
    await page.getByLabel('画布助手消息', { exact: true }).fill('根据上传角色制作两个连续镜头，生成后保留结果供我验收。');
    await page.getByRole('button', { name: '发送给创作助手', exact: true }).click();
    await waitFor(() => h.canvas.service.get(canvasId).runs.some(r => r.status === 'completed'), 'agent tool loop completed', 45000);
    const state = h.canvas.service.get(canvasId);
    assert.equal(state.nodes.length, 4); assert.equal(state.edges.length, 2); assert.equal(h.submissions.length, 2);
    assert.ok(h.submissions.every(s => s.body.references?.[0]?.role === 'first_frame'));
    checks.push('browser-selected model, conversation -> actual native tool calls -> linked references -> two provider requests -> downloaded videos');
    await page.reload();
    await page.locator('[data-node-id="shot-a"] video').waitFor();
    await waitFor(async () => page.locator('.creation-node').count().then(n => n === 4), 'refresh graph');
    await page.locator('[data-node-id="shot-a"] header').click();
    await page.getByLabel('节点内容', { exact: true }).fill('人工修订：镜头延续动作，保留旧视频');
    await page.getByRole('button', { name: '保存节点', exact: true }).click();
    await waitFor(() => h.canvas.service.get(canvasId).nodes.find(n => n.id === 'shot-a').data.prompt.startsWith('人工修订'), 'manual edit');
    assert.ok(h.canvas.service.get(canvasId).nodes.find(n => n.id === 'shot-a').data.media.local_path);
    checks.push('refresh restores graph and completed media; manual editing keeps media');
    // Hold the save response while the user selects another node. The original
    // click must still generate shot-a and must preserve shot-b's editor.
    let heldSave, releaseSave;
    const saving = new Promise(resolve => { heldSave = resolve; });
    const resume = new Promise(resolve => { releaseSave = resolve; });
    await page.route('**/creation-canvases/*/operations', async route => {
      const body = route.request().postDataJSON();
      if (body.operations?.some(op => op.type === 'update_node' && op.id === 'shot-a')) {
        const response = await route.fetch(); heldSave(); await resume; await route.fulfill({ response });
      } else await route.continue();
    });
    await page.getByRole('button', { name: '保存并生成', exact: true }).click();
    await saving;
    await page.locator('[data-node-id="shot-b"] header').click();
    await page.getByLabel('节点内容', { exact: true }).fill('镜头二未保存的草稿');
    releaseSave();
    await waitFor(() => h.canvas.service.get(canvasId).nodes.find(n => n.id === 'shot-a').attempts.length === 2, 'original target after selection switch');
    assert.equal(h.canvas.service.get(canvasId).nodes.find(n => n.id === 'shot-b').attempts.length, 1);
    assert.equal(await page.getByLabel('节点内容', { exact: true }).inputValue(), '镜头二未保存的草稿');
    await page.unroute('**/creation-canvases/*/operations');
    checks.push('delayed save plus switching nodes keeps original generation target and other node draft');
    await waitFor(() => h.canvas.service.get(canvasId).nodes.find(n => n.id === 'shot-a').attempts.at(-1).status === 'completed', 'manual regeneration');
    await page.getByRole('button',{name:'新建画布',exact:true}).click();
    await page.locator('.el-message-box input').fill('另一个画布');
    await page.locator('.el-message-box__btns button').last().click();
    await waitFor(()=>page.url().split('/').pop()!==canvasId,'new canvas route');
    const otherCanvasId=page.url().split('/').pop();
    async function pickCanvas(title) { await page.locator('.canvas-toolbar > .el-select .el-select__wrapper').click(); await page.getByRole('option',{name:title,exact:true}).click(); }
    await pickCanvas('画布本地闭环验收');
    await page.locator('[data-node-id="shot-a"] header').click();
    let heldAcross,releaseAcross;
    const crossSaving=new Promise(r=>{heldAcross=r;}),crossResume=new Promise(r=>{releaseAcross=r;});
    await page.route('**/creation-canvases/*/operations',async route=>{const response=await route.fetch();heldAcross();await crossResume;await route.fulfill({response});});
    await page.getByRole('button',{name:'保存并生成',exact:true}).click();await crossSaving;
    await pickCanvas('另一个画布');releaseAcross();
    await waitFor(()=>h.canvas.service.get(canvasId).nodes.find(n=>n.id==='shot-a').attempts.length===3,'original canvas after switch');
    assert.equal(h.canvas.service.get(otherCanvasId).jobs.length,0);
    assert.equal(page.url().split('/').pop(),otherCanvasId);
    await page.unroute('**/creation-canvases/*/operations');
    await pickCanvas('画布本地闭环验收');
    await waitFor(()=>h.canvas.service.get(canvasId).nodes.find(n=>n.id==='shot-a').attempts.at(-1).status==='completed','third generation');
    checks.push('switching whole canvases during save never redirects a generation or switches the user back');
    await page.screenshot({ path: path.join(h.root, 'canvas-desktop.png'), fullPage: true });
    // Reset selection so export uses all completed video nodes.
    await page.locator('.vue-flow__pane').click({ position: { x: 25, y: 25 } });
    await page.getByRole('button', { name: '导出成片', exact: true }).click();
    // When a single video is selected the dialog intentionally exports only it.
    assert.ok(await page.locator('.export-row').count() >= 1);
    await page.getByRole('button', { name: '合成并保存', exact: true }).click();
    await waitFor(() => h.canvas.service.get(canvasId).jobs.some(j => j.kind === 'export' && ['completed', 'failed'].includes(j.status)), 'FFmpeg export', 60000);
    const exported = h.canvas.service.get(canvasId).jobs.find(j => j.kind === 'export');
    assert.equal(exported.status, 'completed', JSON.stringify(exported));
    const file = await fetch(h.base + `/api/v1/creation-canvases/${canvasId}/exports/${exported.id}/file`);
    assert.equal(file.status, 200); assert.ok((await file.arrayBuffer()).byteLength > 8192);
    checks.push('real FFmpeg child process creates a downloadable MP4 from ordered video nodes');
    await page.setViewportSize({ width: 430, height: 930 }); await page.screenshot({ path: path.join(h.root, 'canvas-mobile.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2), 'no page horizontal overflow');
    checks.push('mobile layout has no horizontal page overflow');
    await page.setViewportSize({ width: 1440, height: 1000 });
    for (const route of ['/batch','/free-create','/research']) { await page.goto(h.base + route); await page.locator('.workspace-frame').waitFor(); assert.ok((await page.locator('.workspace-frame').textContent()).length > 50); }
    checks.push('manual batch, free creation and research routes still render');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(h.root, 'browser-evidence.json'), JSON.stringify({ checks, errors, canvasId, submissions: h.submissions.length, model_requests: h.completions.length, export: exported }, null, 2));
    console.log(JSON.stringify({ ok: true, root: h.root, checks, errors }, null, 2));
  } catch (e) {
    await page.screenshot({ path: path.join(h.root, 'browser-failure.png'), fullPage: true });
    console.error(JSON.stringify({ error: e.message, root: h.root, page_errors: errors })); throw e;
  } finally { await browser.close(); await h.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
