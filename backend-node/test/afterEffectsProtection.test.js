const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const bridge = require('../src/services/afterEffectsJob');
const cli = require.resolve('../src/services/afterEffectsJob');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-protect-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.aep');
  fs.writeFileSync(source, JSON.stringify({ marker: 'disk-original', items: 1 }));
  return { root, source, dir: path.join(root, 'job') };
}
const compose = () => ({ mode: 'compose', preserve_current: true, comps: [{ id: 'main', width: 1920, height: 1080, duration: 0.2, layers: [] }] });

function run(job, fixture, options = {}) {
  bridge.prepare(job, fixture.dir);
  const log = [];
  function File(p) {
    this.fsName = path.resolve(p);
    Object.defineProperty(this, 'exists', { get: () => fs.existsSync(this.fsName) });
    this.open = () => true;
    this.write = s => fs.writeFileSync(this.fsName, s);
    this.close = () => {};
  }
  let rq;
  const project = {
    numItems: 1, dirty: true, file: options.currentFile ? new File(options.currentFile) : null,
    marker: 'unsaved-work',
    save(file) {
      log.push(['save', file.fsName, this.marker]);
      if (options.saveFails) throw Error('Disk full');
      fs.writeFileSync(file.fsName, JSON.stringify({ marker: this.marker, items: this.numItems }));
      this.file = file; this.dirty = false;
    },
    item() { return { name: this.marker, typeName: 'Folder' }; },
    importFile() {
      const factor = job.render.resolution_factor;
      const actual = options.actualOutputSize || [Math.ceil(job.comps[0].width / factor[0]), Math.ceil(job.comps[0].height / factor[1])];
      return { width: actual[0], height: actual[1], remove() { log.push(['remove-probe-footage']); } };
    },
    items: { addComp(name, width, height) { project.numItems++; return { name, width, height, openInViewer() {} }; } },
    renderQueue: {
      rendering: !!options.rendering, numItems: 0,
      items: { add() {
        let om = { Resize: true, Crop: true };
        let resolution = { x: 1, y: 1 };
        const module = {
          templates: ['H.264'], file: null,
          applyTemplate() { log.push(['output-template']); om = { Resize: true, Crop: true }; },
          setSettings(s) { log.push(['output-settings']); if (!options.ignoreOutputSettings) om = { ...om, ...s }; },
          getSettings(format) { return format === 2 ? { ...om } : { Resize: String(om.Resize), Crop: String(om.Crop) }; }
        };
        rq = {
          status: 1, templates: ['Best Settings'],
          outputModule() { return module; },
          applyTemplate() { log.push(['render-template']); resolution = { x: 1, y: 1 }; },
          setSettings(s) {
            assert.equal(typeof s.Resolution, 'object');
            assert.deepEqual(Object.keys(s), ['Resolution']);
            log.push(['resolution', s.Resolution.x, s.Resolution.y]);
            resolution = options.wrongResolution || { x: s.Resolution.x, y: s.Resolution.y };
          },
          getSettings(format) {
            if (options.readFails) throw Error('Cannot read settings');
            if (format === 2) return options.missingResolution ? {} : { Resolution: { ...resolution } };
            return { Resolution: resolution.x === 4 && resolution.y === 4 ? 'Quarter' : `${resolution.x},${resolution.y}` };
          }
        };
        return rq;
      } },
      render() { log.push(['render']); rq.status = 2; fs.writeFileSync(rq.outputModule(1).file.fsName, 'mock movie'); }
    }
  };
  const app = {
    version: 'mock', project, effects: [],
    open(file) {
      log.push(['open', file.fsName]);
      if (options.cancelOpen) return null;
      const data = JSON.parse(fs.readFileSync(file.fsName));
      project.marker = data.marker; project.numItems = data.items; project.file = file; project.dirty = false;
      return project;
    },
    newProject() { log.push(['new']); project.numItems = 0; project.file = null; project.marker = 'new'; project.dirty = false; },
    beginUndoGroup() {}, endUndoGroup() {}
  };
  vm.runInNewContext(fs.readFileSync(path.join(fixture.dir, 'ae-job.jsx'), 'utf8'), {
    app, File, Folder: function(p) { this.fsName = p; this.exists = true; },
    CompItem: function() {}, ImportOptions: function() {}, RQItemStatus: { QUEUED: 1, DONE: 2 }, GetSettingsFormat: { STRING: 1, NUMBER: 2 }, $: { os: process.platform === 'win32' ? 'Windows' : 'Mac OS' }
  });
  return { receipt: JSON.parse(fs.readFileSync(path.join(fixture.dir, 'ae-receipt.json'))), project, log };
}

test('switch saves the original unsaved content before opening the target exactly once', t => {
  const f = setup(t), r = run({ ...compose(), open_project: f.source }, f);
  assert.equal(r.receipt.status, 'composed');
  assert.deepEqual(r.log.slice(0, 2).map(x => x[0]), ['save', 'open']);
  assert.equal(r.log.filter(x => x[0] === 'open').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(r.receipt.recovery_project)).marker, 'unsaved-work');
  assert.equal(JSON.parse(fs.readFileSync(f.source)).marker, 'disk-original');
});

test('compose on the already loaded file preserves unsaved changes instead of reopening disk', t => {
  const f = setup(t), r = run({ ...compose(), open_project: f.source }, f, { currentFile: f.source });
  assert.equal(r.receipt.status, 'composed');
  assert.equal(r.receipt.open_count, 0);
  assert.equal(r.project.marker, 'unsaved-work');
  assert.equal(JSON.parse(fs.readFileSync(r.receipt.project)).marker, 'unsaved-work');
  assert.equal(JSON.parse(fs.readFileSync(f.source)).marker, 'disk-original');
});

for (const mode of ['inspect', 'compose']) test(`${mode} refuses a busy switch before opening or saving`, t => {
  const f = setup(t), r = run({ ...compose(), mode, preserve_current: false, open_project: f.source }, f);
  assert.match(r.receipt.error, /AE_PROJECT_BUSY/);
  assert.equal(r.log.length, 0);
  assert.equal(r.project.marker, 'unsaved-work');
  assert.equal(r.project.dirty, true);
});

for (const target of ['omitted', 'same']) test(`inspect ${target} target leaves current project untouched`, t => {
  const f = setup(t), r = run({ mode: 'inspect', ...(target === 'same' ? { open_project: f.source } : {}) }, f, { currentFile: f.source });
  assert.equal(r.receipt.status, 'inspected');
  assert.equal(r.log.length, 0);
  assert.equal(r.project.dirty, true);
});

test('recovery failure does not open the target or attempt another save', t => {
  const f = setup(t), r = run({ ...compose(), open_project: f.source }, f, { saveFails: true });
  assert.equal(r.receipt.status, 'failed');
  assert.match(r.receipt.error, /Disk full/);
  assert.deepEqual(r.log.map(x => x[0]), ['save']);
});

test('cancelled open cannot save the recovery project as a successful target', t => {
  const f = setup(t), r = run({ ...compose(), open_project: f.source }, f, { cancelOpen: true });
  assert.match(r.receipt.error, /Target project did not open/);
  assert.equal(r.log.filter(x => x[0] === 'save').length, 1);
  assert.equal(fs.existsSync(path.join(f.dir, 'project.aep')), false);
});

for (const factor of [[4, 4], [2, 4], [8, 8]]) test(`render factors ${factor} override templates and output resize/crop`, t => {
  const f = setup(t), r = run({ ...compose(), render: { comp: 'main', render_template: 'Best Settings', output_template: 'H.264', resolution_factor: factor } }, f);
  assert.equal(r.receipt.status, 'rendered_pending_media_qa');
  const kinds = r.log.map(x => x[0]);
  assert.ok(kinds.indexOf('resolution') > kinds.indexOf('render-template'));
  assert.ok(kinds.indexOf('resolution') > kinds.indexOf('output-template'));
  assert.deepEqual(r.receipt.applied_resolution_factor, { x: factor[0], y: factor[1] });
  assert.equal(r.receipt.output_settings.Resize, 'false');
  assert.equal(r.receipt.output_settings.Crop, 'false');
  assert.equal(kinds.filter(x => x === 'render').length, 1);
});

for (const bad of [{ missingResolution: true }, { readFails: true }, { wrongResolution: { x: 2, y: 2 } }, { ignoreOutputSettings: true }]) test(`invalid resolution/output readback stops before rendering: ${JSON.stringify(bad)}`, t => {
  const f = setup(t), r = run({ ...compose(), render: { comp: 'main', resolution_factor: [4, 4] } }, f, bad);
  assert.equal(r.receipt.status, 'failed');
  assert.equal(r.log.some(x => x[0] === 'render'), false);
});

test('an active render prevents project replacement', t => {
  const f = setup(t), r = run(compose(), f, { rendering: true });
  assert.match(r.receipt.error, /AE_RENDER_BUSY/);
  assert.equal(r.log.length, 0);
});

test('codec-adjusted dimensions fail while retaining the rendered movie and removing probe footage', t => {
  const f = setup(t), r = run({ ...compose(), render: { comp: 'main', resolution_factor: [8, 8] } }, f, { actualOutputSize: [240, 134] });
  assert.equal(r.receipt.status, 'failed');
  assert.match(r.receipt.error, /AE_OUTPUT_SIZE_MISMATCH/);
  assert.deepEqual(r.receipt.expected_output_size, [240, 135]);
  assert.deepEqual(r.receipt.actual_output_size, [240, 134]);
  assert.equal(fs.existsSync(r.receipt.outputs[1]), true);
  assert.ok(r.log.some(x => x[0] === 'remove-probe-footage'));
});

test('CLI read and reconciled run report failed receipts with exit 1 and no launch', t => {
  const f = setup(t), job = { mode: 'inspect' }, prepared = bridge.prepare(job, f.dir);
  fs.writeFileSync(path.join(f.dir, 'ae-receipt.json'), JSON.stringify({ request_sha256: prepared.request_sha256, status: 'failed', error: 'saved failure' }));
  const input = path.join(f.root, 'input.json'); fs.writeFileSync(input, JSON.stringify(job));
  for (const args of [['read', f.dir], ['run', input, f.dir]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'failed');
    assert.equal(fs.existsSync(path.join(f.dir, 'ae-dispatch.json')), false);
  }
});