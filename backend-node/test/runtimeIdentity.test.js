const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildRuntimeIdentity, clearRuntimeIdentityCache, computeSourceRevision, computeDatabaseFingerprint } = require('../src/services/runtimeIdentity');

describe('runtime identity contract', () => {
  it('returns a bounded, non-secret identity for the current runtime', () => {
    clearRuntimeIdentityCache();
    const identity = buildRuntimeIdentity({ app: { version: '0.1.4' }, database: { path: ':memory:' } });
    assert.equal(identity.schema, 'yinzi.workflow-runtime-identity/v1');
    assert.equal(identity.orchestration_router, true);
    assert.match(identity.runtime_id, /^yinzi-[a-f0-9]{12}$/);
    assert.match(identity.source_revision, /^[a-f0-9]{16}$/);
    assert.match(identity.database.fingerprint, /^(unknown|[a-f0-9]{16})$/);
    assert.doesNotMatch(JSON.stringify(identity), /sk-|Bearer|api_key|password/i);
    assert.equal(Object.prototype.hasOwnProperty.call(identity.database, 'path'), false);
  });

  it('marks canonical only when explicitly declared', () => {
    clearRuntimeIdentityCache();
    assert.equal(buildRuntimeIdentity({ app: {}, database: {} }, { canonical: false }).canonical, false);
    clearRuntimeIdentityCache();
    assert.equal(buildRuntimeIdentity({ app: {}, database: {} }, { canonical: true }).canonical, true);
  });

  it('derives source revision from bytes rather than mtimes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-source-'));
    const source = path.join(dir, 'source.js');
    fs.writeFileSync(source, 'same bytes');
    const before = fs.statSync(source).mtimeMs;
    const first = computeSourceRevision([source]);
    fs.utimesSync(source, new Date(), new Date(before + 60000));
    const second = computeSourceRevision([source]);
    assert.equal(second, first);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps database fingerprint stable across normal database writes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-runtime-'));
    const database = path.join(dir, 'workflow.sqlite');
    fs.writeFileSync(database, 'first');
    clearRuntimeIdentityCache();
    const first = computeDatabaseFingerprint(database);
    fs.writeFileSync(database, 'a larger normal sqlite placeholder');
    const second = computeDatabaseFingerprint(database);
    assert.equal(second, first);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
