const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const productionRoutes = require('../src/routes/production');

const log = { info() {}, warn() {}, error() {} };

function scene() {
  return {
    version: 2,
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { aim_mode: 'rotation' } },
      { id: 'floor', kind: 'plane', props: {} },
      { id: 'actor', kind: 'character', props: { profile_id: 'human.adult.male' } },
    ],
    timeline: { duration: 5, keyframes: [] },
  };
}

test('exposes Blender capability and no-side-effect smoke preparation through production routes', async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-director-routes-'));
  const db = new Database(':memory:');
  const fakeBlender = {
    detectBlender: () => ({ schema: 'yinzi.blender-capability/v1', status: 'unavailable', available: false, version_known: false, version: null, executable: null, reasons: ['BLENDER_NOT_FOUND'] }),
    prepareBlenderSmoke: (_cfg, input) => ({ schema: 'yinzi.blender-director/v1', status: 'blocked', request_key: input.request_key, executed: false, side_effects: { filesystem_write: false, process_started: false, paid: false } }),
    runBlenderRender: (_cfg, input) => ({ schema: 'yinzi.blender-render-result/v1', status: 'blocked', request_key: input.request_key, executed: false, side_effects: { filesystem_write: false, process_started: false, paid: false } }),
  };
  const routes = productionRoutes({ storage: { local_path: storageDir } }, db, log, { blenderDirector: fakeBlender });
  const app = express();
  app.use(express.json());
  app.get('/api/production-director/blender/capability', routes.blenderCapability);
  app.post('/api/production-director/blender/smoke/prepare', routes.prepareBlenderSmoke);
  app.post('/api/production-director/blender/render', routes.renderBlenderScene);
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    const capability = await fetch(`${base}/production-director/blender/capability`);
    assert.equal(capability.status, 200);
    const capabilityBody = await capability.json();
    assert.equal(capabilityBody.success, true);
    assert.equal(capabilityBody.data.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(capabilityBody), /api_key|Bearer|sk-/i);

    const plan = await fetch(`${base}/production-director/blender/smoke/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_key: 'route-smoke', scene: scene() }),
    });
    assert.equal(plan.status, 200);
    const planBody = await plan.json();
    assert.equal(planBody.data.executed, false);
    assert.equal(planBody.data.side_effects.filesystem_write, false);
    assert.equal(fs.readdirSync(storageDir).length, 0);

    const render = await fetch(`${base}/production-director/blender/render`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ request_key: 'route-render', scene: scene() }),
    });
    assert.equal(render.status, 200);
    const renderBody = await render.json();
    assert.equal(renderBody.data.schema, 'yinzi.blender-render-result/v1');
    assert.equal(renderBody.data.status, 'blocked');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
