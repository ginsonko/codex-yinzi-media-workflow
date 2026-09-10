const { it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { pollVideoTask } = require('../src/services/videoClient');
const { pollObservation, recordPollProgress } = require('../src/services/videoPollProgress');
const log = { info() {}, warn() {}, error() {} };

it('persists real provider progress during polling while retaining local delivery and cancellation states', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE video_generations (id INTEGER, status TEXT, provider_task_id TEXT, task_id TEXT, deleted_at TEXT);
    CREATE TABLE async_tasks (id TEXT, status TEXT, progress REAL, message TEXT, updated_at TEXT, completed_at TEXT, deleted_at TEXT);
    INSERT INTO video_generations VALUES (1,'processing','existing-provider-task','local-task',NULL);
    INSERT INTO async_tasks VALUES ('local-task','processing',5,'accepted',NULL,NULL,NULL);`);
  const originalFetch = global.fetch;
  const replies = [{ status: 'in_progress', progress: '30%' }, { status: 'in_progress', progress: null },
    { status: 'in_progress', progress: 60 }, { status: 'completed', progress: 100, video_url: 'https://media.test/result.mp4' }];
  const snapshots = [];
  global.fetch = async (url, init) => {
    assert.ok(!init?.method || init.method === 'GET');
    assert.match(url, /existing-provider-task$/);
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  };
  try {
    const result = await pollVideoTask(null, log, 1, 'existing-provider-task', { provider: 'yinzi', base_url: 'https://video.test/v1', api_key: 'test' }, 4, 0, null,
      observation => { recordPollProgress(db, 1, 'existing-provider-task', observation); snapshots.push(db.prepare('SELECT * FROM async_tasks').get()); });
    assert.equal(result.video_url, 'https://media.test/result.mp4');
    assert.deepEqual(snapshots.map(x => x.progress), [30, 30, 60, 99]);
    assert.ok(snapshots.every(x => x.updated_at && x.status === 'processing' && !x.completed_at));
    assert.match(snapshots[3].message, /100%/);
    db.prepare("UPDATE async_tasks SET status='failed', message='用户已取消'").run();
    assert.equal(recordPollProgress(db, 1, 'existing-provider-task', { status: 'in_progress', progress: 70 }), false);
    assert.equal(db.prepare('SELECT message FROM async_tasks').get().message, '用户已取消');
    db.prepare("UPDATE async_tasks SET status='processing'").run();
    assert.equal(recordPollProgress(db, 1, 'other-task', { progress: 90 }), false);
    db.prepare("UPDATE video_generations SET status='completed'").run();
    assert.equal(recordPollProgress(db, 1, 'existing-provider-task', { progress: 90 }), false);
  } finally { global.fetch = originalFetch; db.close(); }
});

it('does not invent progress for absent, blank, boolean, malformed or out-of-range values', () => {
  for (const value of [undefined, null, '', ' ', '%', true, {}, -1, 101, Infinity, 'NaN']) {
    assert.equal(pollObservation({ progress: value }, 'processing').progress, null);
  }
  assert.equal(pollObservation({ data: { progress: 0 } }, 'queued').progress, 0);
  assert.equal(pollObservation({ progress: '12.5%' }, 'processing').progress, 12.5);
});

it('an observation failure cannot discard the completed provider result', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ status: 'completed', progress: 100, video_url: 'https://media.test/result.mp4' }));
  try {
    const result = await pollVideoTask(null, log, 1, 'same-task', { provider: 'yinzi', base_url: 'https://video.test/v1' }, 1, 0, null, async () => { throw Error('observer unavailable'); });
    assert.equal(result.video_url, 'https://media.test/result.mp4');
  } finally { global.fetch = originalFetch; }
});
