const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { contracts } = require('../src/services/localMediaOperations');
const { snapshot, verify } = require('../src/services/localMediaSources');
const { execute } = require('../src/services/localMediaExecutor');

test('Jianying catalog advertises document delivery and does not claim network generation', () => {
  const ops = contracts().filter(o => o.module_id.startsWith('local.jianying.'));
  assert.equal(ops.length, 2);
  assert.deepEqual(ops.find(o => o.module_id.endsWith('.draft')).outputs, ['editable_draft', 'execution_receipt']);
  for (const o of ops) {
    assert.equal(o.side_effects.network, false);
    assert.equal(o.side_effects.paid, false);
    assert.equal(o.validation_status, 'execution_receipt_required');
  }
});

test('queued draft job protects relative media, SRT and external template resources', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-integrity-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  fs.mkdirSync(path.join(root, 'template'));
  const media = path.join(root, '素材.mp4');
  const srt = path.join(root, '字幕.srt');
  const job = path.join(root, 'job.json');
  fs.writeFileSync(media, 'immutable media fixture'); fs.writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
  fs.writeFileSync(path.join(root, 'template/draft_content.json'), JSON.stringify({canvas_config:{width:100,height:100},tracks:[],materials:{videos:[{path:'../素材.mp4'}]}}));
  fs.writeFileSync(job, JSON.stringify({clips:[{path:'素材.mp4'}], subtitles:[{path:'字幕.srt'}],template:{path:'template'}}));
  const sources = snapshot({module_id:'local.jianying.draft',input_path:job});
  assert.equal(sources.filter(s => s.path === media).length, 1);
  assert.ok(sources.some(s => s.path === srt));
  assert.ok(sources.some(s => s.path.endsWith('draft_content.json')));
  verify(sources);
  fs.writeFileSync(srt, 'changed caption');
  assert.throws(() => verify(sources), {code:'INPUT_CHANGED'});
});

test('normal executor exposes inspection as a document with an honest stage and preserves input', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jy-inspect-executor-'));
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const job = path.join(root, 'inspect.json');fs.writeFileSync(job, '{}');
  const old = process.env.YINZI_JIANYING_CONFIG;
  process.env.YINZI_JIANYING_CONFIG = path.join(root,'not-configured.json');
  t.after(() => {if(old == null) delete process.env.YINZI_JIANYING_CONFIG;else process.env.YINZI_JIANYING_CONFIG=old;});
  const r = await execute({module_id:'local.jianying.inspect',input_path:job},{outputDir:path.join(root,'out'),manager:{ensureComponent(){throw Error('inspection must not install')}}});
  assert.equal(r.status,'succeeded');
  assert.equal(r.details.stage,'environment_inspected');
  assert.equal(r.details.export_verified,false);
  assert.equal(r.details.dependency.ready,false);
  assert.equal(path.extname(r.output_path),'.json');
  assert.equal(fs.readFileSync(job,'utf8'),'{}');
  assert.ok(r.output_sha256);
});
