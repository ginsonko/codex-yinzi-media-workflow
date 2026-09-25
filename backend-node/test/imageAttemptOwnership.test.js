const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const config = require('../src/config');
const upload = require('../src/services/uploadService');
const realLoadConfig = config.loadConfig;
const realDownload = upload.downloadImageToLocal;
config.loadConfig = () => ({ app: { name: 'ownership test' }, storage: { local_path: './fixture-unused-storage' }, style: {}, ai: {} });
const imageClient = require('../src/services/imageClient');
const imageService = require('../src/services/imageService');
const propImages = require('../src/services/propImageGenerationService');
const aiConfig = require('../src/services/aiConfigService');
const ownership = require('../src/services/imageAttemptOwnership');
const log = { info() {}, warn() {}, error() {} };
let db, server, baseUrl, requests;

async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for image fixture');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

before(async () => {
  server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ body: JSON.parse(Buffer.concat(chunks).toString()), res });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(async () => {
  config.loadConfig = realLoadConfig;
  upload.downloadImageToLocal = realDownload;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  upload.downloadImageToLocal = async () => null;
  db = new Database(':memory:');
  const oldLog = console.log, oldWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = oldLog; console.warn = oldWarn; }
  db.pragma('foreign_keys = OFF');
  db.prepare("INSERT INTO dramas (id,title,status) VALUES (1,'test','draft')").run();
  db.prepare("INSERT INTO characters (id,drama_id,name) VALUES (1,1,'character')").run();
  db.prepare("INSERT INTO scenes (id,drama_id,location) VALUES (1,1,'scene')").run();
  db.prepare("INSERT INTO props (id,drama_id,name,prompt) VALUES (1,1,'prop','prop image')").run();
  db.prepare("INSERT INTO storyboards (id,episode_id,characters) VALUES (1,1,'[]')").run();
  aiConfig.createConfig(db, log, {
    service_type: 'image', provider: 'openai', api_protocol: 'openai',
    base_url: baseUrl, api_key: 'local-test-only', model: ['fixture'],
    is_default: true, is_active: true,
  });
});

afterEach(async () => {
  for (const request of requests) {
    if (!request.res.writableEnded) {
      request.res.writeHead(500, { 'content-type': 'application/json' });
      request.res.end(JSON.stringify({ error: { message: 'fixture cleanup' } }));
    }
  }
  await until(() => db.prepare("SELECT COUNT(*) AS n FROM async_tasks WHERE status IN ('pending','processing')").get().n === 0);
  db.close();
});

function asset(kind) {
  return imageClient.createAndGenerateImage(db, log, {
    drama_id: 1, [kind + '_id']: 1, prompt: 'fixture image', model: 'fixture',
  });
}

function storyboard(frameType = 'storyboard_first') {
  return imageService.create(db, log, {
    drama_id: 1, storyboard_id: 1, frame_type: frameType,
    prompt: 'fixture frame', model: 'fixture', use_first_frame_layout_lock: 0,
  });
}

async function reply(index, value, fail = false) {
  await until(() => !!requests[index]);
  const res = requests[index].res;
  res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(fail ? { error: { message: value } } : { data: [{ url: value }] }));
}

async function done(taskId) {
  await until(() => ['completed', 'failed'].includes(db.prepare('SELECT status FROM async_tasks WHERE id = ?').get(taskId)?.status));
}

for (const kind of ['character', 'scene']) {
  const table = kind === 'character' ? 'characters' : 'scenes';
  test(`${kind}: old success cannot replace a newer image, and both histories complete`, async () => {
    const old = asset(kind), current = asset(kind);
    await reply(1, 'https://fixture.invalid/new.png'); await done(current.task_id);
    await reply(0, 'https://fixture.invalid/old.png'); await done(old.task_id);
    assert.equal(db.prepare(`SELECT image_url FROM ${table} WHERE id=1`).get().image_url, 'https://fixture.invalid/new.png');
    assert.deepEqual(db.prepare('SELECT status FROM image_generations ORDER BY id').all().map((row) => row.status), ['completed', 'completed']);
    assert.equal(db.prepare('SELECT image_url FROM image_generations WHERE id=?').get(old.id).image_url, 'https://fixture.invalid/old.png');
  });

  test(`${kind}: old errors do not overwrite current successful state`, async () => {
    const old = asset(kind), current = asset(kind);
    await reply(1, 'https://fixture.invalid/new.png'); await done(current.task_id);
    await reply(0, 'older request failed', true); await done(old.task_id);
    const entity = db.prepare(`SELECT image_url,error_msg FROM ${table} WHERE id=1`).get();
    assert.equal(entity.image_url, 'https://fixture.invalid/new.png');
    assert.ok(!entity.error_msg);
    assert.match(db.prepare('SELECT error_msg FROM image_generations WHERE id=?').get(old.id).error_msg, /older request failed/);
  });
}

test('scene paths share ownership; a new pending image blocks old success even during download', async () => {
  let release;
  upload.downloadImageToLocal = async (_storage, url) => {
    if (url.endsWith('old.png')) await new Promise((resolve) => { release = resolve; });
    return null;
  };
  const old = asset('scene');
  await reply(0, 'https://fixture.invalid/old.png');
  await until(() => !!release);
  const current = imageService.create(db, log, { drama_id: 1, scene_id: 1, prompt: 'new scene', model: 'fixture' });
  release(); await done(old.task_id);
  assert.ok(!db.prepare('SELECT image_url FROM scenes WHERE id=1').get().image_url);
  await reply(1, 'https://fixture.invalid/new.png'); await done(current.task_id);
  assert.equal(db.prepare('SELECT image_url FROM scenes WHERE id=1').get().image_url, 'https://fixture.invalid/new.png');
});

test('storyboard first and last frames are independent and ignore derived grid panels', async () => {
  const firstOld = storyboard('first'), firstNew = storyboard('storyboard_first'), last = storyboard('last_frame');
  db.prepare("INSERT INTO image_generations (storyboard_id,frame_type,status) VALUES (1,'quad_panel_0','completed'),(1,'nine_panel_8','completed')").run();
  await reply(1, 'https://fixture.invalid/first.png'); await done(firstNew.task_id);
  await reply(2, 'https://fixture.invalid/last.png'); await done(last.task_id);
  await reply(0, 'https://fixture.invalid/old.png'); await done(firstOld.task_id);
  const row = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(row.first_frame_image_id, Number(firstNew.id));
  assert.equal(row.last_frame_image_id, Number(last.id));
  assert.equal(row.image_url, 'https://fixture.invalid/first.png');
  assert.equal(row.last_frame_image_url, 'https://fixture.invalid/last.png');
});

test('storyboard failure stays in old history and does not taint its source scene', async () => {
  const old = imageService.create(db, log, { drama_id: 1, storyboard_id: 1, scene_id: 1, frame_type: 'first', prompt: 'old', model: 'fixture' });
  const current = storyboard();
  await reply(1, 'https://fixture.invalid/new.png'); await done(current.task_id);
  await reply(0, 'older storyboard error', true); await done(old.task_id);
  assert.ok(!db.prepare('SELECT error_msg FROM storyboards WHERE id=1').get().error_msg);
  assert.ok(!db.prepare('SELECT error_msg FROM scenes WHERE id=1').get().error_msg);
  assert.match(db.prepare('SELECT error_msg FROM image_generations WHERE id=?').get(old.id).error_msg, /older storyboard error/);
});

test('frame destination is fixed before a later prompt changes the selected slot', async () => {
  db.prepare("INSERT INTO frame_prompts (storyboard_id,frame_type,created_at,updated_at) VALUES (1,'first','1','1')").run();
  const old = storyboard(null);
  await until(() => requests.length === 1);
  db.prepare("UPDATE frame_prompts SET frame_type='last',updated_at='2' WHERE storyboard_id=1").run();
  const current = storyboard(null);
  await reply(1, 'https://fixture.invalid/last.png'); await done(current.task_id);
  await reply(0, 'https://fixture.invalid/first.png'); await done(old.task_id);
  const row = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(row.first_frame_image_id, Number(old.id));
  assert.equal(row.last_frame_image_id, Number(current.id));
});

test('prop results and errors retain per-task history without replacing the newer prop image', async () => {
  const old = propImages.generatePropImage(db, log, 1, { model: 'fixture' });
  const middle = propImages.generatePropImage(db, log, 1, { model: 'fixture' });
  const current = propImages.generatePropImage(db, log, 1, { model: 'fixture' });
  await reply(2, 'https://fixture.invalid/new.png'); await done(current);
  await reply(0, 'https://fixture.invalid/old.png'); await done(old);
  await reply(1, 'older prop failed', true); await done(middle);
  const prop = db.prepare('SELECT image_url,error_msg FROM props WHERE id=1').get();
  assert.equal(prop.image_url, 'https://fixture.invalid/new.png');
  assert.ok(!prop.error_msg);
  assert.equal(JSON.parse(db.prepare('SELECT result FROM async_tasks WHERE id=?').get(old).result).image_url, 'https://fixture.invalid/old.png');
  assert.match(db.prepare('SELECT error FROM async_tasks WHERE id=?').get(middle).error, /older prop failed/);
});

test('deleting a newer attempt never revives a late old callback; grid requests retain their own lane', () => {
  const insert = db.prepare('INSERT INTO image_generations (storyboard_id,frame_type,status,deleted_at) VALUES (1,?,?,?)');
  const first = insert.run('first', 'completed', null).lastInsertRowid;
  const tail = insert.run('last', 'completed', null).lastInsertRowid;
  const quad = insert.run('quad_grid', 'completed', null).lastInsertRowid;
  assert.equal(ownership.isLatestImageAttempt(db, first), true);
  assert.equal(ownership.isLatestImageAttempt(db, tail), true);
  assert.equal(ownership.isLatestImageAttempt(db, quad), true);
  insert.run('storyboard_first', 'failed', 'deleted');
  assert.equal(ownership.isLatestImageAttempt(db, first), false);
  assert.equal(ownership.isLatestImageAttempt(db, tail), true);
  assert.equal(ownership.isLatestImageAttempt(db, tail, { shared: true }), false);
});

test('a later successful retry clears the prior entity error while preserving failure history', async () => {
  const failed = asset('character');
  await reply(0, 'retry me', true); await done(failed.task_id);
  assert.match(db.prepare('SELECT error_msg FROM characters WHERE id=1').get().error_msg, /retry me/);
  const retried = asset('character');
  await reply(1, 'https://fixture.invalid/retried.png'); await done(retried.task_id);
  assert.equal(db.prepare('SELECT error_msg FROM characters WHERE id=1').get().error_msg, null);
  assert.match(db.prepare('SELECT error_msg FROM image_generations WHERE id=?').get(failed.id).error_msg, /retry me/);
});

test('a generic frame keeps its first-frame destination even if a tail prompt appears before processing', async () => {
  const first = storyboard(null);
  db.prepare("INSERT INTO frame_prompts (storyboard_id,frame_type,created_at,updated_at) VALUES (1,'last','1','1')").run();
  const last = storyboard(null);
  await reply(1, 'https://fixture.invalid/last.png'); await done(last.task_id);
  await reply(0, 'https://fixture.invalid/first.png'); await done(first.task_id);
  const row = db.prepare('SELECT * FROM storyboards WHERE id=1').get();
  assert.equal(row.first_frame_image_id, Number(first.id));
  assert.equal(row.last_frame_image_id, Number(last.id));
});

test('a newer failed request remains current and the older successful result remains recoverable', async () => {
  const old = asset('scene'), current = asset('scene');
  await reply(1, 'new request failed', true); await done(current.task_id);
  await reply(0, 'https://fixture.invalid/old.png'); await done(old.task_id);
  const scene = db.prepare('SELECT image_url,error_msg FROM scenes WHERE id=1').get();
  assert.ok(!scene.image_url);
  assert.match(scene.error_msg, /new request failed/);
  assert.equal(db.prepare('SELECT image_url FROM image_generations WHERE id=?').get(old.id).image_url, 'https://fixture.invalid/old.png');
});
