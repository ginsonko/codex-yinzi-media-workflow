const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const { createOrchestrationService } = require('../src/services/orchestrationService');
const moduleCatalog = require('../src/services/orchestrationModuleCatalog');

let db; let service;

beforeEach(() => {
  db = new Database(':memory:');
  const oldLog = console.log; const oldWarn = console.warn;
  console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = oldLog; console.warn = oldWarn; }
  service = createOrchestrationService(db);
});
afterEach(() => db.close());

describe('Codex orchestration service', () => {
  it('exposes a low gate onboarding contract and idempotent redacted events', () => {
    const service = createOrchestrationService(db);
    const onboarding = service.onboarding();
    assert.equal(onboarding.schema, 'yinzi.codex-video-onboarding/v1');
    assert.equal(onboarding.open_world, true);
    assert.equal(onboarding.connected, true);
    assert.equal(Array.isArray(onboarding.next_steps), true);
    const created = service.createSession({ idempotency_key: 'onboarding-event-session', user_goal: '测试首用与事件' });
    const first = service.recordEvent(created.session.id, {
      event_type: 'fact.recorded', event_idempotency_key: 'fact-1', actor: 'codex', payload: { summary: '首用测试' },
    });
    const reused = service.recordEvent(created.session.id, {
      event_type: 'fact.recorded', event_idempotency_key: 'fact-1', actor: 'codex', payload: { summary: '不得覆盖' },
    });
    assert.equal(first.reused, false);
    assert.equal(reused.reused, true);
    assert.equal(reused.event.id, first.event.id);
    assert.throws(() => service.recordEvent(created.session.id, {
      event_type: 'secret.leak', event_idempotency_key: 'secret-1', payload: { api_key: 'sk-test-secret-value' },
    }), (error) => error.code === 'EVENT_SECRET_REJECTED');
  });

  it('exposes V1-V5 module contracts while keeping the catalog open-world', () => {
    const result = moduleCatalog.listModules();
    assert.equal(result.open_world, true);
    assert.deepEqual([...new Set(result.items.map((item) => item.version_track))], ['V1', 'V2', 'V3', 'V4', 'V5']);
    assert.equal(moduleCatalog.getModule('video.generate').side_effects.paid, true);
    assert.equal(moduleCatalog.getModule('research.request').side_effects.network, true);
  });

  it('creates idempotent sessions and never exposes secrets in events or source context', () => {
    const payload = {
      idempotency_key: 'ecommerce-batch-1',
      title: '电商单品测试',
      user_goal: '制作15秒竖屏投流素材，Authorization: Bearer abcdefghijklmnop',
      source_context: { folder: 'D:/商品A', api_key: 'sk-abcdefghijklmnop' },
    };
    const first = service.createSession(payload);
    const second = service.createSession(payload);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(second.session.id, first.session.id);
    const serialized = JSON.stringify(service.getBundle(first.session.id));
    assert.doesNotMatch(serialized, /sk-abcdefghijklmnop|abcdefghijklmno/);
    assert.match(serialized, /REDACTED|\*\*\*/);
  });

  it('persists a dynamic plan, accepts unknown modules and advances dependencies', () => {
    const session = service.createSession({ user_goal: '只有素材，让 Codex 自己设计', mode: 'collaborate' }).session;
    const planned = service.submitPlan(session.id, {
      confirm: true,
      plan: { summary: '先分类，再执行一个未来模块' },
      nodes: [
        { node_key: 'classify', module_id: 'asset.classify', phase: 'intake' },
        { node_key: 'future', module_id: 'future.video.magic', phase: 'create', depends_on: ['classify'] },
      ],
    });
    assert.equal(planned.session.plan_revision, 1);
    assert.equal(planned.nodes.find((node) => node.node_key === 'future').module_contract_status, 'unknown');
    service.startSession(session.id);
    let bundle = service.getBundle(session.id);
    assert.equal(bundle.nodes.find((node) => node.node_key === 'classify').status, 'ready');
    assert.equal(bundle.nodes.find((node) => node.node_key === 'future').status, 'pending');
    service.updateNode(session.id, 'classify', { status: 'running', progress: { state: 'local_started' } });
    service.updateNode(session.id, 'classify', { status: 'succeeded', output_refs: [{ type: 'asset_roles', id: 'roles-1' }] });
    bundle = service.getBundle(session.id);
    assert.equal(bundle.nodes.find((node) => node.node_key === 'future').status, 'ready');
  });

  it('records truthful failed receipts and retries the same logical node', () => {
    const session = service.createSession({ user_goal: '生成视频' }).session;
    service.submitPlan(session.id, { confirm: true, nodes: [{ node_key: 'video-1', module_id: 'video.generate' }] });
    service.startSession(session.id);
    service.updateNode(session.id, 'video-1', { status: 'running', request_hash: 'request-1' });
    const failed = service.updateNode(session.id, 'video-1', {
      status: 'failed',
      error: { code: 'UPSTREAM_ODD_CODE', message: '上游暂时失败', retryable: true },
      receipt: {
        status: 'failed', source: 'provider', original_code: 'UPSTREAM_ODD_CODE', normalized_category: 'provider_error',
        message: '上游暂时失败', attempted: ['Seedance 2.5-720'], retryable: 'true', fallback_available: true, next_actions: ['retry'],
      },
    });
    assert.equal(failed.receipt.original_code, 'UPSTREAM_ODD_CODE');
    assert.equal(failed.receipt.retryable, 'true');
    assert.equal(failed.bundle.session.status, 'failed');
    const retried = service.retryNode(session.id, failed.node.id);
    assert.equal(retried.node.id, failed.node.id);
    assert.equal(retried.node.node_key, 'video-1');
    assert.equal(retried.node.attempt, 2);
    assert.equal(retried.node.status, 'ready');
    assert.equal(service.getBundle(session.id).receipts.length, 1);
  });

  it('exposes explicit executor actions without inventing progress or requiring a retry reason', () => {
    const session = service.createSession({ user_goal: '执行并验收素材节点' }).session;
    service.submitPlan(session.id, { confirm: true, nodes: [{ node_key: 'scan', module_id: 'asset.scan' }] });
    service.startSession(session.id);
    const started = service.actOnNode(session.id, 'scan', 'start', { actor: 'codex' });
    assert.equal(started.node.status, 'running');
    assert.equal(started.node.progress.state, 'local_started');
    const completed = service.actOnNode(session.id, 'scan', 'complete', {
      actor: 'codex',
      output_refs: [{ type: 'asset_inventory', id: 'inventory-1', sha256: 'abc' }],
      message: '已完成有界扫描',
    });
    assert.equal(completed.node.status, 'succeeded');
    assert.equal(completed.node.progress.state, 'completed');
    assert.equal(completed.receipt.message, '已完成有界扫描');
    const reopened = service.actOnNode(session.id, 'scan', 'reopen', { actor: 'user' });
    assert.equal(reopened.node.status, 'ready');
    assert.equal(reopened.node.attempt, 2);
    const failed = service.actOnNode(session.id, 'scan', 'fail', { actor: 'codex', message: '文件暂时被占用', retryable: 'true' });
    assert.equal(failed.receipt.retryable, 'true');
    assert.equal(failed.node.progress.state, 'failed');
    const retried = service.actOnNode(session.id, 'scan', 'retry', { actor: 'user' });
    assert.equal(retried.node.attempt, 3);
    assert.equal(retried.node.status, 'ready');
  });

  it('keeps dependency readiness as a visible guard but permits explicit manual takeover', () => {
    const session = service.createSession({ user_goal: '人工接管等待节点' }).session;
    service.submitPlan(session.id, { confirm: true, nodes: [
      { node_key: 'first', module_id: 'asset.scan' },
      { node_key: 'second', module_id: 'asset.classify', depends_on: ['first'] },
    ] });
    service.startSession(session.id);
    assert.throws(() => service.actOnNode(session.id, 'second', 'start'), (error) => error.code === 'NODE_NOT_READY');
    const forced = service.actOnNode(session.id, 'second', 'start', { actor: 'user', force: true });
    assert.equal(forced.node.status, 'running');
  });

  it('distinguishes a wholly failed workflow from a partially usable result', () => {
    const failedOnly = service.createSession({ user_goal: '单节点失败' }).session;
    service.submitPlan(failedOnly.id, { confirm: true, nodes: [{ node_key: 'only', module_id: 'video.generate' }] });
    service.startSession(failedOnly.id);
    service.updateNode(failedOnly.id, 'only', { status: 'failed' });
    assert.equal(service.getBundle(failedOnly.id).session.status, 'failed');

    const mixed = service.createSession({ user_goal: '部分可用' }).session;
    service.submitPlan(mixed.id, { confirm: true, nodes: [{ node_key: 'good', module_id: 'video.import' }, { node_key: 'bad', module_id: 'video.generate' }] });
    service.startSession(mixed.id);
    service.updateNode(mixed.id, 'good', { status: 'succeeded' });
    service.updateNode(mixed.id, 'bad', { status: 'failed' });
    assert.equal(service.getBundle(mixed.id).session.status, 'partial');
  });

  it('revises plans without deleting immutable history and resumes from checkpoints', () => {
    const session = service.createSession({ user_goal: '混合剪辑', mode: 'auto' }).session;
    service.submitPlan(session.id, { nodes: [{ node_key: 'old', module_id: 'video.generate' }], plan: { summary: '旧计划' } });
    service.submitPlan(session.id, { expected_revision: 1, confirm: true, nodes: [{ node_key: 'clip', module_id: 'video.import' }], plan: { summary: '复用已有视频' } });
    const withInactive = service.getBundle(session.id, { include_inactive: true });
    assert.equal(withInactive.nodes.find((node) => node.node_key === 'old').active, false);
    assert.ok(withInactive.events.some((event) => event.event_type === 'plan.proposed'));
    assert.ok(withInactive.events.some((event) => event.event_type === 'plan.confirmed'));
    const saved = service.saveCheckpoint(session.id, { checkpoint: { summary: '已复用现成视频，下一步剪辑' } });
    assert.match(saved.session.checkpoint.summary, /下一步剪辑/);
    service.pauseSession(session.id);
    const resumed = service.resumeSession(session.id);
    assert.equal(resumed.session.status, 'running');
    assert.match(JSON.stringify(service.exportSession(session.id)), /session\.checkpoint_saved/);
  });

  it('does not revive a terminal workflow as running when resuming from a checkpoint', () => {
    const session = service.createSession({ user_goal: '检查终态真值' }).session;
    service.submitPlan(session.id, { confirm: true, nodes: [{ node_key: 'done', module_id: 'asset.scan' }] });
    service.startSession(session.id);
    service.updateNode(session.id, 'done', { status: 'succeeded' });
    assert.equal(service.getBundle(session.id).session.status, 'succeeded');
    service.pauseSession(session.id);
    const resumed = service.resumeSession(session.id);
    assert.equal(resumed.session.status, 'succeeded');
  });

  it('invalidates changed successful nodes and all downstream results while preserving immutable receipts', () => {
    const session = service.createSession({ user_goal: '先分析素材再生成分镜' }).session;
    service.submitPlan(session.id, { confirm: true, nodes: [
      { node_key: 'analyze', module_id: 'asset.classify', input_refs: [{ id: 'image-v1', role: 'subject' }] },
      { node_key: 'storyboard', module_id: 'storyboard.plan', depends_on: ['analyze'] },
    ] });
    service.startSession(session.id);
    service.actOnNode(session.id, 'analyze', 'start');
    service.actOnNode(session.id, 'analyze', 'complete', { output_refs: [{ type: 'analysis', id: 'analysis-v1' }] });
    service.actOnNode(session.id, 'storyboard', 'start');
    service.actOnNode(session.id, 'storyboard', 'complete', { output_refs: [{ type: 'storyboard', id: 'board-v1' }] });
    const before = service.getBundle(session.id);
    assert.equal(before.session.status, 'succeeded');
    assert.equal(before.receipts.length, 2);

    const revised = service.submitPlan(session.id, { expected_revision: 1, confirm: true, nodes: [
      { node_key: 'analyze', module_id: 'asset.classify', input_refs: [{ id: 'image-v2', role: 'subject' }] },
      { node_key: 'storyboard', module_id: 'storyboard.plan', depends_on: ['analyze'] },
    ] });
    const analyze = revised.nodes.find((node) => node.node_key === 'analyze');
    const storyboard = revised.nodes.find((node) => node.node_key === 'storyboard');
    assert.equal(revised.session.status, 'planned');
    assert.equal(analyze.status, 'pending');
    assert.equal(storyboard.status, 'pending');
    assert.equal(analyze.attempt, 2);
    assert.equal(storyboard.attempt, 2);
    assert.deepEqual(analyze.output_refs, []);
    assert.deepEqual(storyboard.output_refs, []);
    assert.equal(revised.receipts.length, 2);
    assert.equal(revised.events.filter((event) => event.event_type === 'node.invalidated_by_plan').length, 2);
  });

  it('preserves successful results for a semantic no-op plan revision', () => {
    const session = service.createSession({ user_goal: '仅调整顺序展示' }).session;
    service.submitPlan(session.id, { confirm: true, nodes: [{ node_key: 'scan', module_id: 'asset.scan', sort_order: 0 }] });
    service.startSession(session.id);
    service.actOnNode(session.id, 'scan', 'start');
    service.actOnNode(session.id, 'scan', 'complete', { output_refs: [{ type: 'inventory', id: 'inventory-v1' }] });
    const revised = service.submitPlan(session.id, { expected_revision: 1, confirm: true, nodes: [{ node_key: 'scan', module_id: 'asset.scan', sort_order: 9 }] });
    assert.equal(revised.session.status, 'succeeded');
    assert.equal(revised.nodes[0].status, 'succeeded');
    assert.equal(revised.nodes[0].attempt, 1);
    assert.equal(revised.nodes[0].output_refs[0].id, 'inventory-v1');
  });

  it('refuses missing/cyclic dependencies and semantic edits to running nodes', () => {
    const session = service.createSession({ user_goal: '保护正在运行的任务' }).session;
    assert.throws(() => service.submitPlan(session.id, { nodes: [{ node_key: 'broken', module_id: 'manual.override', depends_on: ['missing'] }] }), (error) => error.code === 'PLAN_DEPENDENCY_MISSING');
    assert.throws(() => service.submitPlan(session.id, { nodes: [
      { node_key: 'a', module_id: 'manual.override', depends_on: ['b'] },
      { node_key: 'b', module_id: 'manual.override', depends_on: ['a'] },
    ] }), (error) => error.code === 'PLAN_DEPENDENCY_CYCLE');
    service.submitPlan(session.id, { confirm: true, nodes: [{ node_key: 'active', module_id: 'video.generate' }] });
    service.startSession(session.id);
    service.actOnNode(session.id, 'active', 'start');
    assert.throws(() => service.submitPlan(session.id, { expected_revision: 1, nodes: [{ node_key: 'active', module_id: 'video.import' }] }), (error) => error.code === 'PLAN_RUNNING_NODE_CONFLICT');
    assert.throws(() => service.submitPlan(session.id, { expected_revision: 1, nodes: [{ node_key: 'other', module_id: 'manual.override' }] }), (error) => error.code === 'PLAN_RUNNING_NODE_CONFLICT');
  });

  it('persists versioned artifacts, user feedback and idempotent delivery selections', () => {
    const session = service.createSession({ user_goal: '展示成果并交付' }).session;
    service.submitPlan(session.id, { confirm: true, nodes: [{ node_key: 'render', module_id: 'image.generate' }] });
    service.startSession(session.id);
    const artifact = service.recordArtifact(session.id, {
      artifact_id: 'shot-01-render', type: 'image', mime_type: 'image/png', title: '镜头 01 预览',
      url: '/static/library/images/shot-01.png', bytes: 1024, width: 1280, height: 720,
      source_refs: [{ type: 'scene', id: 'scene-1' }], validation: { status: 'passed', readable: true },
    });
    assert.equal(artifact.reused, false);
    const duplicate = service.recordArtifact(session.id, { artifact_id: 'shot-01-render', type: 'image', title: '不应覆盖' });
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.artifact.title, '镜头 01 预览');
    const feedback = service.recordFeedback(session.id, { message: '第二个镜头节奏慢一点', scope: { type: 'shot', shot_id: 'shot-02' }, pause: true, idempotency_key: 'feedback-1', actor: 'user' });
    assert.equal(feedback.reused, false);
    assert.equal(feedback.feedback.message, '第二个镜头节奏慢一点');
    const feedbackAgain = service.recordFeedback(session.id, { message: '替换文字', idempotency_key: 'feedback-1' });
    assert.equal(feedbackAgain.reused, true);
    const delivery = service.deliverSession(session.id, { artifact_ids: ['shot-01-render'], format: 'preview', idempotency_key: 'delivery-1', actor: 'user' });
    assert.equal(delivery.reused, false);
    assert.equal(delivery.delivery.items.length, 1);
    const deliveryAgain = service.deliverSession(session.id, { artifact_ids: ['missing'], idempotency_key: 'delivery-1' });
    assert.equal(deliveryAgain.reused, true);
    const bundle = service.getBundle(session.id);
    assert.equal(bundle.artifacts.length, 1);
    assert.equal(bundle.feedback.length, 1);
    assert.equal(bundle.delivery.status, 'ready');
    assert.equal(bundle.session.status, 'paused');
  });

  it('completes only after true node results and preserves failed history on partial delivery', () => {
    const session=service.createSession({user_goal:'真实收口'}).session;
    service.submitPlan(session.id,{confirm:true,nodes:[{node_key:'old-attempt',module_id:'manual.override'},{node_key:'delivery',module_id:'deliver.export'}]});
    assert.throws(()=>service.completeSession(session.id),{code:'COMPLETION_UNFINISHED_NODES'});
    service.updateNode(session.id,'old-attempt',{status:'failed',receipt:{message:'保留失败审计'}});
    service.updateNode(session.id,'delivery',{status:'succeeded'});
    const result=service.completeSession(session.id,{summary:'可用作品已交付，保留旧失败记录'});
    assert.equal(result.bundle.session.status,'partial');assert.equal(result.bundle.nodes[0].status,'failed');
    assert.equal(service.completeSession(session.id).reused,true);
  });
  it('persists unattended preference, preserves quality, and honors explicit waiting and analysis intent', () => {
    const preferences = require('../src/services/creativePreferences');
    assert.equal(preferences.get(db).unattended_mode, false);
    preferences.set(db, { quality_profile: 'speed' });
    preferences.set(db, { unattended_mode: true });
    assert.deepEqual(preferences.get(db), { quality_profile: 'speed', unattended_mode: true });
    preferences.set(db, { quality_profile: 'balanced' });
    assert.equal(preferences.get(db).unattended_mode, true);
    assert.throws(() => preferences.set(db, { unattended_mode: 'false' }), { code: 'UNATTENDED_MODE_INVALID' });
    const created = service.beginWork({ idempotency_key: 'afk-create', user_goal: '做视频', intent: 'create' });
    assert.equal(created.creative_preferences.unattended_mode, true);
    const nodes = [{ node_key: 'work', module_id: 'manual.override' }];
    assert.equal(service.submitPlan(created.session.id, { nodes }).session.status, 'planned');
    assert.equal(service.submitPlan(created.session.id, { nodes, confirm: false }).session.status, 'waiting_confirmation');
    const analysis = service.beginWork({ idempotency_key: 'afk-analysis', user_goal: '只分析', intent: 'analyze' });
    assert.equal(service.submitPlan(analysis.session.id, { nodes }).session.status, 'waiting_confirmation');
    preferences.set(db, { unattended_mode: false });
    assert.equal(service.getBundle(created.session.id).creative_preferences.unattended_mode, false);
    assert.equal(service.submitPlan(created.session.id, { nodes }).session.status, 'waiting_confirmation');
  });
  it('captures quality preference for each session and exposes actionable planning guidance', () => {
    const preferences=require('../src/services/creativePreferences');
    const first=service.createSession({user_goal:'精致视频'}).session;
    assert.equal(service.getBundle(first.id).planning_guidance.id,'quality');
    preferences.set(db,{quality_profile:'speed'});
    assert.equal(service.createSession({user_goal:'快速预览'}).session.source_context.quality_profile,'speed');
    assert.equal(service.getBundle(first.id).planning_guidance.id,'quality');
    assert.throws(()=>preferences.set(db,{quality_profile:'bogus'}),{code:'QUALITY_PROFILE_INVALID'});
  });

});

describe('visible analysis lifecycle', () => {
  it('registers before planning, resumes without resetting, and closes analysis with a report without generation', () => {
    const created = service.beginWork({ idempotency_key:'visible-analysis', user_goal:'先分析视频，暂不生成', intent:'analyze' });
    const id = created.session.id;
    assert.equal(created.session.status, 'draft');
    assert.equal(created.session.source_context.activity.stage, 'analysis');
    service.reportActivity(id,{event_idempotency_key:'inspected',message:'已读取参考素材',next_action:'给出方案'});
    const reused=service.beginWork({idempotency_key:'visible-analysis',user_goal:'先分析视频，暂不生成',intent:'analyze'});
    assert.equal(reused.session.source_context.activity.message,'已读取参考素材');
    assert.throws(()=>service.reportActivity(id,{event_idempotency_key:'finish',message:'完成',state:'completed'}), /分析结论/);
    const end=service.reportActivity(id,{event_idempotency_key:'finish',message:'分析完成',state:'completed',analysis_report:{summary:'建议先跟踪遮罩，再合成替换',acceptance:['保持背景与音轨']}});
    assert.equal(end.session.status,'succeeded');
    const duplicate=service.reportActivity(id,{event_idempotency_key:'finish',message:'不会覆盖',state:'completed',analysis_report:'不同内容'});
    assert.equal(duplicate.session.source_context.activity.message,'分析完成');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM video_generations').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM image_generations').get().n,0);
  });
});

it('analysis completion preserves a failed analysis node rather than reporting success',()=>{
 const id=service.beginWork({idempotency_key:'analysis-failure',user_goal:'分析损坏素材',intent:'analyze'}).session.id;
 service.submitPlan(id,{confirm:true,nodes:[{node_key:'inspect',module_id:'manual.inspect',phase:'research',title:'读取素材'}]});
 service.updateNode(id,'inspect',{status:'failed',receipt:{status:'failed',message:'文件损坏',source:'local'}});
 const result=service.reportActivity(id,{event_idempotency_key:'finish-failed',state:'completed',message:'分析结束，素材需要修复',analysis_report:'输入文件损坏，无法完成镜头分析。'});
 assert.equal(result.session.status,'failed');
});
