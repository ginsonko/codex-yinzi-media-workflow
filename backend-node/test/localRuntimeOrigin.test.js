const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { applyLocalRuntimeOrigin } = require('../src/app');

describe('desktop local runtime origin', () => {
  it('uses the actual loopback port for static and file URLs', () => {
    const config = { storage: { local_path: './data/storage', base_url: 'http://localhost:5679/static' } };
    applyLocalRuntimeOrigin(config, 'http://127.0.0.1:43123');
    assert.equal(config.storage.base_url, 'http://127.0.0.1:43123/static');
    assert.equal(config.files.base_url, 'http://127.0.0.1:43123/static');
  });

  it('does not accept remote or credential-bearing origins', () => {
    const remote = { storage: { base_url: 'http://localhost:5679/static' } };
    applyLocalRuntimeOrigin(remote, 'https://example.com');
    assert.equal(remote.storage.base_url, 'http://localhost:5679/static');
    applyLocalRuntimeOrigin(remote, 'http://user:pass@127.0.0.1:43123');
    assert.equal(remote.storage.base_url, 'http://localhost:5679/static');
  });
});
