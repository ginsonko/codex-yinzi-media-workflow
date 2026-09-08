const { test } = require('node:test');
const assert = require('node:assert/strict');
const manager = require('../src/services/mediaComponentManager');

test('component manifests require a trusted HTTPS source, SHA and executable healthcheck', () => {
  const base = { component_id: 'local.face-repair', version: '1.0.0', url: 'https://github.com/example/tool.zip', size_bytes: 1, sha256: 'a'.repeat(64), healthcheck: { executable: 'bin/probe.exe', expected: 'ok' } };
  assert.deepEqual(manager.validateManifest(base).healthcheck, { args: [], ...base.healthcheck });
  assert.throws(() => manager.validateManifest({ ...base, url: 'http://github.com/example/tool.zip' }), /清单/);
  assert.throws(() => manager.validateManifest({ ...base, url: 'https://example.com/tool.zip' }), /受信/);
  assert.throws(() => manager.validateManifest({ ...base, healthcheck: null }), /健康检查/);
});

test('machine profile is redacted and exposes no credentials', () => {
  const profile = manager.machineProfile();
  assert.ok(profile.platform && profile.arch && Number.isInteger(profile.cpu_count));
  assert.equal(Object.keys(profile).some((key) => /key|token|secret|password/i.test(key)), false);
});
