const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const { createProductionService } = require('../src/services/productionService');
const { createProductionMediaService } = require('../src/services/productionMediaService');

// In-memory persistence and injected media adapters only. No HTTP, real keys,
// production data, filesystem media, or provider requests are used here.
let db;
const cfg = { storage: { local_path: './test-storage-unused', base_url: 'http://localhost/static' } };
const log = { info() {}, warn() {}, error() {} };
beforeEach(() => {
  db = new Database(':memory:');
  const originalLog = console.log; const originalWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,?,?,?)').run('Acceptance', now, now);
  db.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (1,1,1,?,?,?)').run('Acceptance', now, now);
});
afterEach(() => db.close());
function run(policy = {}, budget = {}) {
  return repo.createRun(db, {
    drama_id: 1, episode_id: 1, idempotency_key: 'gate-acceptance', review_owner: 'human',
    input: { story: 'Keep the same subject and setting.' },
    policy: { image_model: 'gpt-image-2', video_provider: 'yinzi', video_routing_mode: 'fixed', video_model: 'fixture-video', director_mode: 'off', aspect_ratio: '16:9', ...policy },
    budget: { max_video_attempts: 1, max_video_seconds: 5, max_video_attempts_per_shot: 1, max_shots: 5, max_image_revisions: 1, ...budget },
  }).run;
}
function source(run, stage = 'asset_text') {
  const shot = stage === 'storyboard_plan';
  return repo.createArtifact(db, {
    run_id: run.id, stage, scope_type: shot ? 'shot' : 'character', scope_id: '1', title: 'Subject', status: 'approved',
    content: shot
      ? { included: true, number: 1, duration: 5, video_prompt: 'Walk through the garden.', visual: 'A stable garden.', action: 'Walk.', transition_mode: 'opening', previs_mode: 'skip', character_names: [], prop_names: [] }
      : { included: true, name: 'Subject', description: 'adult traveler', visual_prompt: 'identity sheet' },
  });
}
function retry(run, action) {
  return createProductionService(db, cfg, log).authorizeRetry(run.id, { action_id: action.id });
}
function imageReceipt() { return { relative_path: 'images/fixture.png', width: 1536, height: 1024, format: 'png', nonblank: true, sha256: 'a'.repeat(64) }; }
function catalog() { return { video: [{ model: 'fixture-video', endpoint_types: ['openai-video'], prices: [], capabilities: null, capability_source: 'unknown', contract_status: 'missing' }] }; }

test('video count and seconds are advisory while reservation remains idempotent', () => {
  const current = run();
  const first = repo.reserveAction(db, { run_id: current.id, action_key: 'first', stage: 'shot_video', kind: 'video_generate', reserved_video_seconds: 5 }).action;
  repo.updateAction(db, first.id, { status: 'ambiguous' });
  retry(current, first);
  const second = repo.reserveAction(db, { run_id: current.id, action_key: 'second', stage: 'shot_video', kind: 'video_generate', reserved_video_seconds: 7 }).action;
  assert.deepEqual(second.request.usage_budget_diagnostics.warnings, ['video_attempts_above_reference', 'video_seconds_above_reference']);
  assert.equal(repo.reserveAction(db, { run_id: current.id, action_key: 'second', stage: 'shot_video', kind: 'video_generate', reserved_video_seconds: 7 }).reused, true);
  assert.deepEqual(repo.getRun(db, current.id).usage, { video_attempts_reserved: 2, video_seconds_reserved: 12 });
});

test('explicit image retry reaches create after automatic revision limit', async () => {
  const current = run(); const input = source(current);
  let old;
  for (let attempt = 1; attempt <= 2; attempt++) {
    old = repo.reserveAction(db, { run_id: current.id, action_key: `image-${attempt}`, stage: 'asset_images', kind: 'image_generate', scope_type: 'character', scope_id: '1', attempt, request: { source_artifact_id: input.id } }).action;
    repo.updateAction(db, old.id, { status: 'failed' });
  }
  retry(current, old);
  let creates = 0;
  const service = createProductionMediaService(db, cfg, log, {
    createImage: async () => { creates++; return { id: 55, task_id: 'fixture-55' }; },
  });
  const result = await service.ensureImageStage(repo.getRun(db, current.id), 'asset_images');
  assert.equal(creates, 1);
  assert.equal(result.state, 'waiting_task');
  assert.equal(result.action.attempt, 3);
});

test('image completion arriving during validation stays historical after retry', async () => {
  const current = run(); source(current);
  let release; let entered;
  const enteredValidation = new Promise(resolve => { entered = resolve; });
  const heldValidation = new Promise(resolve => { release = resolve; });
  const service = createProductionMediaService(db, cfg, log, {
    createImage: async () => ({ id: 55, task_id: 'fixture-55' }),
    getImage: async () => ({ id: 55, task_id: 'fixture-55', status: 'completed', local_path: 'images/fixture.png' }),
    validateImage: async () => { entered(); await heldValidation; return imageReceipt(); },
  });
  const started = await service.ensureImageStage(repo.getRun(db, current.id), 'asset_images');
  const finishing = service.ensureImageStage(repo.getRun(db, current.id), 'asset_images');
  await enteredValidation;
  retry(current, started.action);
  release();
  const late = await finishing;
  const old = repo.getAction(db, started.action.id);
  assert.equal(late.reason, 'retry_pending');
  assert.equal(old.status, 'cancelled');
  assert.equal(old.result.late_status, 'completed');
  assert.equal(old.result.receipt.relative_path, 'images/fixture.png');
  assert.equal(repo.listArtifacts(db, current.id, { stage: 'asset_images' }).items.length, 0);
  assert.equal(repo.getRun(db, current.id).status, 'running');
});

test('image submission receipt arriving after retry cannot restore waiting state', async () => {
  const current = run(); source(current);
  let release; let entered;
  const enteredCreate = new Promise(resolve => { entered = resolve; });
  const heldCreate = new Promise(resolve => { release = resolve; });
  const service = createProductionMediaService(db, cfg, log, {
    createImage: async () => { entered(); await heldCreate; return { id: 55, task_id: 'fixture-55' }; },
  });
  const creating = service.ensureImageStage(repo.getRun(db, current.id), 'asset_images');
  await enteredCreate;
  const old = repo.getLatestAction(db, current.id, { stage: 'asset_images', kind: 'image_generate' });
  retry(current, old);
  release();
  const result = await creating;
  assert.equal(result.reason, 'retry_pending');
  assert.equal(repo.getAction(db, old.id).generation_id, 55);
  assert.equal(repo.getAction(db, old.id).status, 'cancelled');
  assert.equal(repo.getRun(db, current.id).status, 'running');
});

test('explicit video retry submits current draft bundle and saved feedback without extra planning or approval', async () => {
  const current = run(); const shot = source(current, 'storyboard_plan');
  const old = repo.reserveAction(db, { run_id: current.id, action_key: 'old-video', stage: 'shot_video', scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1, reserved_video_seconds: 5, request: { source_artifact_id: shot.id, model: 'fixture-video' } }).action;
  repo.updateAction(db, old.id, { status: 'completed', generation_id: 4 });
  const oldOutput = repo.createArtifact(db, { run_id: current.id, stage: 'shot_video', scope_type: 'shot', scope_id: '1', title: 'Old output', media_path: 'videos/old.mp4', source_action_id: old.id, content: { source_artifact_id: shot.id, included: true }, status: 'draft', depends_on: [shot.id] });
  repo.reviewArtifact(db, oldOutput.id, { reviewer_type: 'human', decision: 'rejected', reason: 'Keep the same face throughout.' });
  retry(current, old);
  let creates = 0; let promptPlans = 0; let request;
  const service = createProductionMediaService(db, cfg, log, {
    fetchVideoCatalog: async () => catalog(),
    generateText: async () => { promptPlans++; throw new Error('Text model is not configured'); },
    createVideo: async value => { request = value; creates++; return { id: 56, task_id: 'fixture-56', model: value.model }; },
    getVideo: async () => ({ id: 56, task_id: 'fixture-56', model: 'fixture-video', status: 'completed', local_path: 'videos/fixture.mp4' }),
    validateVideo: async () => ({ relative_path: 'videos/fixture.mp4', duration: 5, width: 1536, height: 1024, nonblank: true, sha256: 'b'.repeat(64) }),
  });
  const created = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(created.state, 'waiting_provider');
  assert.equal(creates, 1);
  assert.equal(promptPlans, 0);
  assert.equal(request.explicit_retry, true);
  assert.match(request.prompt, /Keep the same face throughout/);
  assert.equal(repo.getArtifact(db, request.bundle_artifact_id).status, 'draft');
  assert.equal(repo.getArtifact(db, oldOutput.id).status, 'invalidated');
  const completed = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(completed.state, 'progressed');
  assert.equal(completed.artifact.source_generation_id, 56);
  assert.equal(repo.getAction(db, old.id).status, 'cancelled');
  assert.equal(creates, 1);
});

test('completed multi-segment video retries as a distinct parent and keeps the old merge historical', async () => {
  const current = run({ video_model: 'Seedance 2.5-720', video_group: '限时特价即梦分组' });
  let shot = source(current, 'storyboard_plan');
  shot = repo.editArtifact(db, shot.id, { content: { ...shot.content, duration: 60 } });
  repo.reviewArtifact(db, shot.id, { reviewer_type: 'human', decision: 'approved', reason: 'Fixture source' });
  let creates = 0; let mergeCalls = 0;
  const generations = new Map();
  const service = createProductionMediaService(db, cfg, log, {
    fetchVideoCatalog: async () => ({ video: [{ model: 'Seedance 2.5-720', endpoint_types: ['openai-video'], groups: ['限时特价即梦分组'], capabilities: null, catalog_verified: true, capability_source: 'unknown', contract_status: 'missing', prices: [{ group: '限时特价即梦分组', billing_unit: 'per_request', effective_price: 3.5 }] }] }),
    createVideo: async value => { const id = ++creates; generations.set(id, { id, task_id: `fixture-${id}`, model: value.model, status: 'completed', local_path: `videos/segment-${id}.mp4` }); return { id, task_id: `fixture-${id}`, model: value.model }; },
    getVideo: async id => generations.get(id),
    validateVideo: async (mediaPath, options) => ({ relative_path: mediaPath, duration: Number(options.expected_duration), width: 1536, height: 864, sha256: 'b'.repeat(64) }),
    extractContinuityFrame: async () => ({ path: 'images/fixture-tail.png' }),
    mergeVideoSegments: async () => ({ relative_path: `videos/merged-${++mergeCalls}.mp4` }),
  });
  const bundled = await service.ensureReferenceBundles(repo.getRun(db, current.id));
  repo.reviewArtifact(db, bundled.artifact.id, { reviewer_type: 'human', decision: 'approved', reason: 'Fixture bundle' });
  await service.ensureShotVideos(repo.getRun(db, current.id));
  await service.ensureShotVideos(repo.getRun(db, current.id));
  const completed = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(completed.reason, 'fixed_duration_execution_converged');
  assert.equal(creates, 2);
  retry(current, completed.action);
  const regenerated = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(regenerated.state, 'waiting_provider');
  assert.equal(creates, 3);
  assert.notEqual(regenerated.action.parent_action_id, completed.action.id);
  assert.equal(repo.getArtifact(db, completed.artifact.id).status, 'invalidated');
  await service.ensureShotVideos(repo.getRun(db, current.id));
  const second = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(second.reason, 'fixed_duration_execution_converged');
  assert.equal(creates, 4);
  assert.equal(mergeCalls, 2);
  assert.notEqual(second.artifact.id, completed.artifact.id);
  assert.equal(repo.getAction(db, completed.action.id).status, 'cancelled');
  const lastChild = repo.getLatestAction(db, current.id, { stage: 'shot_video', scope_type: 'shot', scope_id: '1', kind: 'video_generate' });
  retry(current, lastChild);
  assert.equal(repo.getArtifact(db, second.artifact.id).status, 'invalidated');
  const segmentRetry = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(segmentRetry.state, 'waiting_provider');
  assert.equal(creates, 5);
  const remerged = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(remerged.reason, 'fixed_duration_execution_converged');
  assert.equal(mergeCalls, 3);
  assert.notEqual(remerged.artifact.id, second.artifact.id);
  assert.equal(remerged.artifact.content.fixed_duration_execution.child_action_ids.includes(lastChild.id), false);
  const firstChild = repo.getAction(db, remerged.artifact.content.fixed_duration_execution.child_action_ids[0]);
  const dependentChild = repo.getAction(db, remerged.artifact.content.fixed_duration_execution.child_action_ids[1]);
  const firstRetry = retry(current, firstChild);
  assert.equal(firstRetry.reused, false, 'another segment must not be mistaken for a newer attempt of this segment');
  assert.equal(repo.getAction(db, dependentChild.id).result.retry_of_upstream_action_id, firstChild.id);
  assert.equal(repo.getArtifact(db, remerged.artifact.id).status, 'invalidated');
  await service.ensureShotVideos(repo.getRun(db, current.id));
  await service.ensureShotVideos(repo.getRun(db, current.id));
  const rebuilt = await service.ensureShotVideos(repo.getRun(db, current.id));
  assert.equal(rebuilt.reason, 'fixed_duration_execution_converged');
  assert.equal(creates, 7);
  assert.equal(mergeCalls, 4);
  for (const id of rebuilt.artifact.content.fixed_duration_execution.child_action_ids) {
    assert.notEqual(id, firstChild.id);
    assert.notEqual(id, dependentChild.id);
  }
});
