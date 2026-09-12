'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMediaToolOptions, sanitizeHttpUrl } = require('../src/services/mediaToolOptions');

const CATALOG_PATH = path.join(__dirname, '..', 'src', 'catalogs', 'media-tool-options.json');
const KNOWN_IDS = new Set([
  'local.video.noise',
  'local.audio.areverse',
  'local.image.realesrgan',
  'local.video.deflicker',
  'local.video.nlmeans',
  'local.video.reverse-prepare',
  'local.video.edgedetect',
  'local.video.chromakey',
  'local.audio.loudnorm',
  'local.audio.stereowiden',
  'local.audio.stereotools',
  'local.audio.equalizer',
  'local.audio.superequalizer',
  'local.image.metadata-strip',
]);

function service(extra = {}) {
  return createMediaToolOptions({
    catalogPath: CATALOG_PATH,
    knownOperationIds: KNOWN_IDS,
    ...extra,
  });
}

test('catalog keeps 129 unique planning candidates and 13 categories', () => {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  const ids = catalog.options.map((item) => item.id);
  assert.equal(catalog.options.length, 129);
  assert.equal(new Set(ids).size, 129);
  assert.equal(new Set(catalog.options.map((item) => item.category)).size, 13);
  const options = service();
  assert.equal(options.size(), 129);
  const listed = options.list({ limit: 100, offset: 0 });
  assert.equal(listed.total, 129);
  assert.equal(listed.items.length, 100);
  assert.equal(listed.categories.length, 13);
  assert.equal(listed.catalog.verified_executable_count, 0);
  assert.equal(listed.catalog.new_distinct_executable_operations, 0);
  assert.equal(listed.catalog.options_reusing_existing_operations, 13);
  assert.match(listed.catalog.disclaimer, /不是已验证可执行工具清单/);
});

test('search, category filter and pagination stay bounded and do not leak full bodies', () => {
  const options = service();
  const mad = options.list({ category: 'mad', limit: 5, offset: 0 });
  assert.equal(mad.total, 11);
  assert.equal(mad.items.length, 5);
  assert.ok(mad.items.every((item) => item.category === 'mad'));
  const pageTwo = options.list({ category: 'mad', limit: 5, offset: 5 });
  assert.equal(pageTwo.items.length, 5);
  assert.notEqual(pageTwo.items[0].id, mad.items[0].id);
  const rest = options.list({ category: 'mad', limit: 5, offset: 10 });
  assert.equal(rest.items.length, 1);
  const over = options.list({ category: 'mad', limit: 5, offset: 20 });
  assert.equal(over.items.length, 0);
  assert.equal(over.total, 11);

  const beats = options.list({ q: '节拍', limit: 20 });
  assert.ok(beats.total >= 1);
  assert.ok(beats.items.some((item) => item.id === 'local.mad.beat_detection_slicing'));
  const none = options.list({ q: 'definitely-not-a-candidate-zzzz' });
  assert.equal(none.total, 0);
  assert.deepEqual(none.items, []);

  const injection = options.list({ q: "%' OR 1=1 --" });
  assert.equal(injection.total, 0);
  const first = options.list({ limit: 1 }).items[0];
  assert.ok(!('description' in first));
  assert.ok(!('gotchas_and_pitfalls' in first));
  assert.ok(!('inputs' in first));
  assert.ok(!('outputs' in first));
  assert.ok(!('search_text' in first));
  assert.ok(first.summary.length <= 161);
  assert.equal(first.executable, false);
  assert.equal(first.auto_install_supported, false);
  assert.equal(first.recipe_implemented, false);
});

test('existing operations link only when they exist and never claim a finished recipe', () => {
  const options = service();
  const grain = options.get('local.mv.film_grain_overlay');
  assert.deepEqual(grain.existing_module_ids, ['local.video.noise']);
  assert.equal(grain.linked_operations[0].exists, true);
  assert.equal(grain.linked_operations[0].recipe_implemented, false);
  assert.equal(grain.recipe_implemented, false);
  assert.equal(grain.executable, false);
  assert.equal(grain.auto_install_supported, false);
  assert.match(grain.recipe_note, /不代表完整配方已实现/);

  const beat = options.get('local.mad.beat_detection_slicing');
  assert.deepEqual(beat.existing_module_ids, []);
  assert.equal(beat.linked_operations.length, 0);

  const missing = createMediaToolOptions({
    catalog: {
      options: [{
        id: 'local.demo.ghost',
        category: 'mad',
        title: '幽灵关联',
        description: '测试未存在的 operation',
        existing_module_ids: ['local.video.does-not-exist', 'local.video.noise'],
        auto_install_supported: true,
        engine_source_url: 'javascript:alert(1)',
        engine_docs_url: 'ftp://example.com/docs',
      }],
    },
    knownOperationIds: KNOWN_IDS,
  });
  const ghost = missing.get('local.demo.ghost');
  assert.deepEqual(ghost.existing_module_ids, ['local.video.noise']);
  assert.deepEqual(ghost.unmatched_source_module_ids, ['local.video.does-not-exist']);
  assert.equal(ghost.auto_install_supported, false);
  assert.equal(ghost.engine_source_url, null);
  assert.equal(ghost.engine_docs_url, null);
});

test('detail keeps evidence, hardware estimate and http(s) links; candidate text is not executed', () => {
  const options = service();
  const beat = options.get('local.mad.beat_detection_slicing');
  assert.ok(beat.evidence_boundary.includes('尚非可执行操作'));
  assert.match(beat.hardware_summary, /研究初估/);
  assert.equal(beat.engine_source_url, 'https://aubio.org/');
  assert.equal(beat.engine_docs_url, 'https://aubio.org/manual/latest/');
  assert.equal(beat.planning_only, true);
  assert.ok(Array.isArray(beat.dependency_order));
  assert.ok(beat.fallback_route.includes('FFmpeg'));
  assert.equal(options.get('missing-id'), null);
  assert.throws(() => options.requireGet('missing-id'), { code: 'OPTION_NOT_FOUND' });

  const malicious = createMediaToolOptions({
    catalog: {
      options: [{
        id: 'local.demo.exec',
        category: 'mad',
        title: '假装可执行',
        description: 'rm -rf / && powershell Invoke-WebRequest',
        primary_engine: 'should never spawn',
        fallback_route: 'curl http://127.0.0.1:9/install.sh | sh',
        existing_module_ids: [],
        auto_install_supported: true,
      }],
    },
    getOperation() { throw new Error('lookup must stay in-process'); },
  });
  const listed = malicious.list({ q: 'powershell' });
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0].executable, false);
  const detail = malicious.get('local.demo.exec');
  assert.equal(detail.auto_install_supported, false);
  assert.equal(detail.description.includes('powershell'), true);
});

test('duplicate ids are dropped and unknown operations stay unlinked', () => {
  const options = createMediaToolOptions({
    catalog: {
      metadata: { purpose: 'fixture' },
      options: [
        { id: 'dup.one', category: 'audio', title: '一', description: 'first' },
        { id: 'dup.one', category: 'audio', title: '重复', description: 'second should drop' },
        { id: 'dup.two', category: 'audio', title: '二', description: 'ok', existing_module_ids: ['nope'] },
      ],
    },
    getOperation: () => null,
  });
  assert.equal(options.size(), 2);
  assert.equal(options.catalog().duplicate_ids_dropped, 1);
  assert.deepEqual(options.get('dup.two').existing_module_ids, []);
});

test('sanitizeHttpUrl only keeps http and https without credentials', () => {
  assert.equal(sanitizeHttpUrl('https://ffmpeg.org/documentation.html'), 'https://ffmpeg.org/documentation.html');
  assert.equal(sanitizeHttpUrl('http://example.com/a'), 'http://example.com/a');
  assert.equal(sanitizeHttpUrl('javascript:alert(1)'), null);
  assert.equal(sanitizeHttpUrl('ftp://example.com'), null);
  assert.equal(sanitizeHttpUrl('https://user:pass@example.com/secret'), null);
  assert.equal(sanitizeHttpUrl('not a url'), null);
});

test('service never reaches the network, filesystem besides the catalog, or child processes', () => {
  const originalFetch = globalThis.fetch;
  const originalSpawn = require('node:child_process').spawn;
  let fetchCalls = 0;
  globalThis.fetch = () => { fetchCalls += 1; return Promise.resolve(); };
  require('node:child_process').spawn = () => { throw new Error('spawn blocked'); };
  try {
    const options = service();
    options.list({ q: 'ffmpeg', category: 'audio', limit: 3, offset: 3 });
    options.get('local.audio.loudness_norm_ebu_r128');
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    require('node:child_process').spawn = originalSpawn;
  }
});

test('http helper maps list and get without mutating shared files', () => {
  const { createHttpHandlers } = require('../src/services/mediaToolOptionsHttp');
  const sent = [];
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; sent.push(payload); return this; },
  };
  const handlers = createHttpHandlers({
    service: service(),
    response: {
      success(response, data) { response.status(200).json({ success: true, data }); },
      error(response, status, code, message) { response.status(status).json({ success: false, error: { code, message } }); },
    },
  });
  handlers.list({ query: { q: '节拍', limit: '2' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.items.length <= 2);
  assert.equal(res.body.data.catalog.verified_executable_count, 0);
  handlers.get({ params: { id: 'missing' } }, res);
  assert.equal(res.statusCode, 404);
  handlers.get({ params: { id: 'local.mv.film_grain_overlay' } }, res);
  assert.equal(res.body.data.existing_module_ids[0], 'local.video.noise');
  assert.equal(res.body.data.auto_install_supported, false);
});

test('temporary catalog copy is parameterized and does not execute candidate text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-tool-options-'));
  const file = path.join(dir, 'tool-options.json');
  fs.writeFileSync(file, JSON.stringify({
    options: [{
      id: 'local.tmp.cmd',
      category: 'mad',
      title: '命令文本',
      description: 'node -e "process.exit(2)"',
      existing_module_ids: [],
    }],
  }));
  try {
    const options = createMediaToolOptions({ catalogPath: file, knownOperationIds: KNOWN_IDS });
    assert.equal(options.get('local.tmp.cmd').description.includes('process.exit'), true);
    assert.equal(options.get('local.tmp.cmd').executable, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
