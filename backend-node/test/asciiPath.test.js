const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { isAscii, escapeNonAscii, shortPath, asciiFile } = require('../src/services/asciiPath');
const job = require('../src/services/afterEffectsJob');
const temp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-ascii-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('AE job script is pure ASCII and still carries the Chinese paths', t => {
  const d = path.join(temp(t), '成果', '漫剧', '工程');
  const asset = path.join(d, '镜头 1.mp4');
  fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(asset, 'x');
  job.prepare({ mode: 'inspect', assets: [{ id: 'a', path: asset }] }, d);
  const text = fs.readFileSync(path.join(d, 'ae-job.jsx'), 'utf8');
  assert.ok(isAscii(text.replace(/[\r\n\t]/g, '')));
  const ctx = {}; new vm.Script(text.split(';\n')[0]).runInNewContext(ctx);
  assert.equal(ctx.YINZI_AE_JOB.assets[0].path, asset);
  assert.equal(ctx.YINZI_AE_JOB.output_dir, d.replace(/\\/g, '/'));
  assert.equal(escapeNonAscii('a中\u2028'), 'a\\u4e2d\\u2028');
});

test('a script under a Chinese folder gets an ASCII path to hand to the tool', t => {
  const root = temp(t);
  const file = path.join(root, '工程', 'ae-job.jsx');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'var a=1;');
  assert.equal(asciiFile(path.join(root, 'plain.jsx')), path.join(root, 'plain.jsx'));
  const env = { PUBLIC: path.join(root, 'pub'), SystemDrive: '' };
  const tmp = os.tmpdir;
  os.tmpdir = () => path.join(root, '临时');
  t.after(() => { os.tmpdir = tmp; });
  const stale = path.join(root, 'pub', 'Documents', 'yinzi-ascii', 'old.jsx');
  fs.mkdirSync(path.dirname(stale), { recursive: true }); fs.writeFileSync(stale, '');
  fs.utimesSync(stale, new Date(Date.now() - 3 * 86400000), new Date(Date.now() - 3 * 86400000));
  const got = asciiFile(file, { env, platform: 'linux' });
  if (isAscii(root)) {
    assert.ok(isAscii(got));
    assert.equal(path.dirname(got), path.dirname(stale));
    assert.equal(fs.readFileSync(got, 'utf8'), 'var a=1;');
    assert.equal(fs.existsSync(stale), false);
    assert.equal(asciiFile(file, { env, platform: 'linux' }), got);
  }
  const short = shortPath(file, { platform: 'win32', run: () => 'C:\\PROGRA~1\\x\r\n' });
  assert.equal(short, file);
  assert.equal(shortPath(file, { platform: 'win32', run: () => file + '\r\n' }), file);
});

test('on Windows the 8.3 name is used when the volume has one', { skip: process.platform !== 'win32' }, t => {
  const root = temp(t);
  const file = path.join(root, '中文目录', 'a.jsx');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, '');
  const short = shortPath(file);
  assert.ok(short === file || (isAscii(short) && fs.existsSync(short)));
});
