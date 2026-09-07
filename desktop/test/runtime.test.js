const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  backendHasUserData,
  buildMacApplicationMenuTemplate,
  closeRuntimeResources,
  copyVerifiedExecutable,
  isMachOExecutableForArch,
  isSafeExternalUrl,
  migrateLegacyUserData,
  normalizeLocalOrigin,
  probeExecutable,
  reserveLocalHttpServer,
  resolveAcceptanceAppData,
  resolveAcceptanceRoot,
} = require('../runtime');

describe('desktop runtime boundary', () => {
  it('accepts only credential-free loopback HTTP origins', () => {
    assert.equal(normalizeLocalOrigin('http://127.0.0.1:5679'), 'http://127.0.0.1:5679');
    assert.equal(normalizeLocalOrigin('http://localhost:3015/'), 'http://localhost:3015');
    assert.equal(normalizeLocalOrigin('https://127.0.0.1:5679'), '');
    assert.equal(normalizeLocalOrigin('http://example.com:5679'), '');
    assert.equal(normalizeLocalOrigin('http://user:pass@127.0.0.1:5679'), '');
  });

  it('allows only ordinary http(s) external links without embedded credentials', () => {
    assert.equal(isSafeExternalUrl('https://www.yinziapi.top'), true);
    assert.equal(isSafeExternalUrl('file:///C:/Windows/System32/calc.exe'), false);
    assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
    assert.equal(isSafeExternalUrl('https://user:secret@example.com'), false);
  });

  it('accepts an absolute acceptance profile only beneath the exact release-acceptance root', () => {
    const root = path.resolve(os.tmpdir(), 'yinzi-workspace', 'desktop', 'release-acceptance');
    const fallback = path.resolve(os.tmpdir(), 'yinzi-user', 'AppData', 'Roaming');
    const valid = path.join(root, 'fresh-user', 'AppData', 'Roaming');
    assert.equal(resolveAcceptanceAppData({ requested: valid, allowedRoot: root, fallback }), path.resolve(valid));
    assert.equal(resolveAcceptanceAppData({ requested: path.join('..', 'release-acceptance', 'fresh'), allowedRoot: root, fallback }), fallback);
    assert.equal(resolveAcceptanceAppData({
      requested: path.resolve(os.tmpdir(), 'yinzi-workspace', 'desktop', 'release-acceptance-copy', 'fresh'),
      allowedRoot: root,
      fallback,
    }), fallback);
    assert.equal(resolveAcceptanceAppData({
      requested: path.join(root, '..', 'outside'),
      allowedRoot: root,
      fallback,
    }), fallback);
  });

  it('anchors portable acceptance beside the original portable package instead of its temp extraction', () => {
    const portableDir = path.resolve(os.tmpdir(), 'yinzi-workspace', 'desktop', 'release');
    const expected = path.resolve(portableDir, '..', 'release-acceptance');
    assert.equal(resolveAcceptanceRoot({
      packaged: true,
      execPath: path.resolve(os.tmpdir(), 'portable-build', 'yinzi-video-workflow'),
      appDir: path.resolve(os.tmpdir(), 'ignored'),
      portableExecutableDir: portableDir,
    }), expected);
    assert.equal(resolveAcceptanceRoot({
      packaged: true,
      execPath: path.join(portableDir, 'win-unpacked', 'yinzi-video-workflow'),
      appDir: path.resolve(os.tmpdir(), 'ignored'),
      portableExecutableDir: '',
    }), expected);
  });

  it('copies legacy backend data without removing the source and writes a receipt', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-desktop-migration-'));
    const legacy = path.join(root, 'legacy');
    const target = path.join(root, 'target');
    try {
      fs.mkdirSync(path.join(legacy, 'backend', 'data'), { recursive: true });
      fs.mkdirSync(path.join(legacy, 'backend', 'configs'), { recursive: true });
      fs.writeFileSync(path.join(legacy, 'backend', 'data', 'drama_generator.db'), 'database');
      fs.writeFileSync(path.join(legacy, 'backend', 'configs', 'config.yaml'), 'app:\n  name: test\n');

      const result = migrateLegacyUserData({
        targetDir: target,
        legacyDirs: [legacy],
        now: () => new Date('2026-08-12T00:00:00.000Z'),
      });
      assert.equal(result.status, 'migrated');
      assert.equal(backendHasUserData(target), true);
      assert.equal(fs.existsSync(path.join(legacy, 'backend', 'data', 'drama_generator.db')), true);
      const receipt = JSON.parse(fs.readFileSync(path.join(target, 'legacy-data-migration.json'), 'utf8'));
      assert.equal(receipt.source_retained, true);
      assert.equal(receipt.migrated_at, '2026-08-12T00:00:00.000Z');

      const second = migrateLegacyUserData({ targetDir: target, legacyDirs: [legacy] });
      assert.deepEqual(second, { status: 'skipped', reason: 'target_has_data', source: null });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects placeholder binaries before spawning them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-tool-probe-'));
    const placeholder = path.join(root, 'ffmpeg.exe');
    try {
      fs.writeFileSync(placeholder, '');
      let spawned = false;
      const ok = probeExecutable(placeholder, ['-version'], {
        spawn: () => { spawned = true; return { status: 0 }; },
      });
      assert.equal(ok, false);
      assert.equal(spawned, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies a bundled tool only after source and destination probes pass', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-tool-copy-'));
    const source = path.join(root, 'source.exe');
    const destination = path.join(root, 'tools', 'ffmpeg.exe');
    try {
      fs.writeFileSync(source, 'verified-binary');
      const calls = [];
      const result = copyVerifiedExecutable({
        source,
        destination,
        probe(filePath) {
          calls.push(filePath);
          return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === 'verified-binary';
        },
      });
      assert.equal(result.status, 'copied');
      assert.equal(fs.readFileSync(destination, 'utf8'), 'verified-binary');
      assert.equal(calls.includes(source), true);
      assert.equal(calls.some((item) => item.includes('.copying-')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('recognizes only the requested thin Mach-O architecture', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-macho-'));
    const x64 = path.join(root, 'ffmpeg-x64');
    const arm64 = path.join(root, 'ffmpeg-arm64');
    try {
      const x64Header = Buffer.alloc(32);
      x64Header.writeUInt32LE(0xfeedfacf, 0);
      x64Header.writeUInt32LE(0x01000007, 4);
      fs.writeFileSync(x64, x64Header);
      const arm64Header = Buffer.from(x64Header);
      arm64Header.writeUInt32LE(0x0100000c, 4);
      fs.writeFileSync(arm64, arm64Header);

      assert.equal(isMachOExecutableForArch(x64, 'x64'), true);
      assert.equal(isMachOExecutableForArch(x64, 'arm64'), false);
      assert.equal(isMachOExecutableForArch(arm64, 'arm64'), true);
      assert.equal(isMachOExecutableForArch(arm64, 'x64'), false);
      assert.equal(isMachOExecutableForArch(arm64, 'ia32'), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares a copied Mac tool before probing the temporary file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-tool-prepare-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'tools', 'ffmpeg');
    const prepared = new Set();
    try {
      fs.writeFileSync(source, 'mach-o-binary');
      const result = copyVerifiedExecutable({
        source,
        destination,
        sourceValidator: (filePath) => filePath === source,
        prepareCopy(filePath) {
          prepared.add(filePath);
        },
        probe(filePath) {
          return filePath === destination
            ? fs.existsSync(filePath)
            : prepared.has(filePath);
        },
      });
      assert.equal(result.status, 'copied');
      assert.equal(fs.readFileSync(destination, 'utf8'), 'mach-o-binary');
      assert.equal([...prepared].some((filePath) => filePath.includes('.copying-')), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('provides standard editable-field and window roles in the Mac menu', () => {
    const opened = [];
    const template = buildMacApplicationMenuTemplate({ openExternal: (url) => opened.push(url) });
    const roles = template.flatMap((item) => item.submenu || []).map((item) => item.role).filter(Boolean);
    for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll', 'togglefullscreen', 'quit']) {
      assert.equal(roles.includes(role), true, `missing Mac menu role: ${role}`);
    }
    const help = template.find((item) => item.role === 'help');
    help.submenu[0].click();
    assert.deepEqual(opened, ['https://www.yinziapi.top']);
  });

  it('preserves an invalid destination before replacing it with a verified tool', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-tool-replace-'));
    const source = path.join(root, 'source.exe');
    const destination = path.join(root, 'tools', 'ffmpeg.exe');
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(source, 'verified-binary');
      fs.writeFileSync(destination, 'damaged-binary');
      const result = copyVerifiedExecutable({
        source,
        destination,
        probe(filePath) {
          return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === 'verified-binary';
        },
      });

      assert.equal(result.status, 'replaced');
      assert.equal(fs.readFileSync(destination, 'utf8'), 'verified-binary');
      assert.equal(fs.readFileSync(result.preservedInvalid, 'utf8'), 'damaged-binary');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('can update a valid but stale bundled tool while preserving the previous build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-tool-update-'));
    const source = path.join(root, 'source.exe');
    const destination = path.join(root, 'tools', 'ffmpeg.exe');
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(source, 'new-verified-binary');
      fs.writeFileSync(destination, 'old-verified-binary');
      const result = copyVerifiedExecutable({
        source,
        destination,
        replaceExisting: true,
        probe(filePath) {
          return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8').includes('verified-binary');
        },
      });

      assert.equal(result.status, 'updated');
      assert.equal(fs.readFileSync(destination, 'utf8'), 'new-verified-binary');
      assert.equal(fs.readFileSync(result.preservedPrevious, 'utf8'), 'old-verified-binary');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores an invalid destination when the final verified-tool rename fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-tool-rollback-'));
    const source = path.join(root, 'source.exe');
    const destination = path.join(root, 'tools', 'ffmpeg.exe');
    try {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(source, 'verified-binary');
      fs.writeFileSync(destination, 'damaged-binary');
      let failedFinalRename = false;
      const fileSystem = Object.create(fs);
      fileSystem.renameSync = (from, to) => {
        if (!failedFinalRename && from.includes('.copying-') && to === destination) {
          failedFinalRename = true;
          throw new Error('simulated final rename failure');
        }
        return fs.renameSync(from, to);
      };

      assert.throws(() => copyVerifiedExecutable({
        source,
        destination,
        fileSystem,
        probe(filePath) {
          return fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf8') === 'verified-binary';
        },
      }), /simulated final rename failure/);
      assert.equal(fs.readFileSync(destination, 'utf8'), 'damaged-binary');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stops the autonomy runner before closing the server and database', async () => {
    const events = [];
    await closeRuntimeResources({
      productionAutonomyRunner: { stop: () => events.push('runner') },
      server: { close: (done) => { events.push('server'); done(); } },
      closeDatabase: () => events.push('database'),
      timeoutMs: 50,
    });
    assert.deepEqual(events, ['runner', 'server', 'database']);
  });

  it('falls back to an available loopback HTTP port without a probe/listen race', async () => {
    const occupied = await reserveLocalHttpServer(0);
    const occupiedPort = occupied.address().port;
    const reserved = await reserveLocalHttpServer(occupiedPort);
    try {
      assert.notEqual(reserved.address().port, occupiedPort);
      assert.equal(reserved.address().address, '127.0.0.1');
    } finally {
      await new Promise((resolve) => reserved.close(resolve));
      await new Promise((resolve) => occupied.close(resolve));
    }
  });

  it('falls back when Windows reserves the preferred port through HTTP.sys', async () => {
    let created = 0;
    const createServer = () => {
      created += 1;
      const current = created;
      let errorHandler = null;
      return {
        once(event, handler) {
          if (event === 'error') errorHandler = handler;
        },
        listen(port, host, ready) {
          assert.equal(host, '127.0.0.1');
          if (current === 1) {
            assert.equal(port, 5679);
            queueMicrotask(() => errorHandler({ code: 'EACCES' }));
          } else {
            assert.equal(port, 0);
            queueMicrotask(ready);
          }
        },
        address() {
          return { address: '127.0.0.1', port: 49152 };
        },
      };
    };

    const reserved = await reserveLocalHttpServer(5679, { createServer });
    assert.equal(created, 2);
    assert.equal(reserved.address().port, 49152);
  });
});
