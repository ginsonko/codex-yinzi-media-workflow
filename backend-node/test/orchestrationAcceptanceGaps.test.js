const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createOrchestrationService } = require('../src/services/orchestrationService');
test('library searches across sessions with type, pagination and parameterized input', () => {
  const db = new Database(':memory:'); const service = createOrchestrationService(db);
  try {
    const a = service.createSession({ idempotency_key: 'a', user_goal: 'A', title: '宣传项目' }).session.id;
    const b = service.createSession({ idempotency_key: 'b', user_goal: 'B', title: '教程项目' }).session.id;
    service.recordArtifact(a, { artifact_id: 'a-img', type: 'image', title: '宣传图' });
    service.recordArtifact(b, { artifact_id: 'b-img', type: 'image', title: '截图' });
    service.recordArtifact(b, { artifact_id: 'b-vid', type: 'video', title: '教程' });
    const images = service.searchArtifacts({ type: 'image', page_size: 1 });
    assert.equal(images.pagination.total, 2); assert.equal(images.items.length, 1);
    assert.notEqual(service.searchArtifacts({ type: 'image', page_size: 1, page: 2 }).items[0].id, images.items[0].id);
    assert.equal(service.searchArtifacts({ q: '教程项目' }).pagination.total, 2);
    assert.equal(service.searchArtifacts({ q: "' OR 1=1 --" }).pagination.total, 0);
  } finally { db.close(); }
});
test('pause rejects new paid reservations and node starts but permits same-request reconciliation', () => {
  const db = new Database(':memory:'); const service = createOrchestrationService(db);
  try {
    const id = service.createSession({ idempotency_key: 'pause', user_goal: 'pause' }).session.id;
    service.submitPlan(id, { nodes: ['a','b','c'].map(node_key => ({ node_key, module_id: 'image.generate' })) });
    service.startSession(id);
    service.reserveExternalRequest(id, 'a', { request_hash: 'same' });
    service.pauseSession(id);
    assert.equal(service.reserveExternalRequest(id, 'a', { request_hash: 'same' }).reserved, false);
    assert.throws(() => service.reserveExternalRequest(id, 'b', { request_hash: 'new' }), e => e.code === 'SESSION_PAUSED');
    assert.throws(() => service.actOnNode(id, 'c', 'start'), e => e.code === 'SESSION_PAUSED');
    service.updateNode(id, 'a', { status: 'succeeded' });
    assert.equal(service.getBundle(id).session.status, 'paused');
    service.resumeSession(id);
    assert.equal(service.reserveExternalRequest(id, 'b', { request_hash: 'new' }).reserved, true);
  } finally { db.close(); }
});
