const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { startCanvasHarness } = require('./helpers/canvasHarness');
const { createCanvasService } = require('../src/services/creationCanvas/service');
const { uid } = require('../src/services/creationCanvas/store');
const { localSource } = require('../src/services/creationCanvas/localMedia');

const noBatches = { create() { throw new Error('not used'); }, get() {}, pause() {}, resume() {} };

test('localSource tells files on disk from storage paths and web URLs', () => {
  assert.equal(localSource('D:\\照片\\主唱.jpg'), 'D:\\照片\\主唱.jpg');
  assert.equal(localSource('references/abc.png'), '');
  assert.equal(localSource('/static/references/abc.png'), '');
  assert.equal(localSource('https://example.com/a.png'), '');
  assert.equal(localSource(pathToFileURL(path.resolve('a b.png')).href), path.resolve('a b.png'));
});

test('a canvas node pointing at a file on the user disk is copied into storage and displays', async () => {
  const h = await startCanvasHarness({ video: false }); await h.canvas.close();
  const s = createCanvasService(h.db, h.cfg, h.log, noBatches, { terminalPollMs: 0 });
  try {
    const outside = path.join(h.root, '用户照片'); fs.mkdirSync(outside);
    const photo = path.join(outside, '主唱 (我).JPG'); fs.writeFileSync(photo, 'JPEGDATA');
    const clip = path.join(outside, 'take.mp4'); fs.writeFileSync(clip, 'MP4DATA');
    const c = s.create();
    s.operate(c.id, { request_id: uid(), operations: [
      { type: 'add_node', id: 'singer', kind: 'image', data: { title: '照片-主唱', media: { local_path: photo } } },
      { type: 'add_node', id: 'take', kind: 'video', data: { title: '素材', media: { url: pathToFileURL(clip).href } } },
    ] });
    const nodes = s.get(c.id).nodes;
    const singer = nodes.find(n => n.id === 'singer').data.media;
    assert.match(singer.local_path, /^references\/[0-9a-f]{64}\.jpg$/);
    assert.equal(singer.url, '/static/' + singer.local_path);
    assert.equal(singer.source_path, photo);
    const served = s.mediaFile(c.id, 'singer');
    assert.equal(fs.readFileSync(served.path, 'utf8'), 'JPEGDATA');
    assert.ok(served.path.startsWith(fs.realpathSync(h.storage)));
    assert.equal(fs.readFileSync(s.mediaFile(c.id, 'take').path, 'utf8'), 'MP4DATA');

    assert.throws(() => s.operate(c.id, { request_id: uid(), operations: [{ type: 'add_node', kind: 'image', data: { media: { local_path: path.join(outside, 'gone.png') } } }] }), { code: 'MEDIA_FILE_MISSING' });
    const notes = path.join(outside, 'notes.txt'); fs.writeFileSync(notes, 'x');
    assert.throws(() => s.operate(c.id, { request_id: uid(), operations: [{ type: 'add_node', kind: 'image', data: { media: { local_path: notes } } }] }), { code: 'MEDIA_TYPE_UNSUPPORTED' });

    // Nodes saved by older versions still hold the absolute path.
    s.store.mutate(c.id, canvas => { canvas.nodes.find(n => n.id === 'singer').data.media = { local_path: photo }; return {}; });
    assert.equal(s.mediaFile(c.id, 'singer').path, photo);
  } finally { await s.stop(); await h.close(); }
});
