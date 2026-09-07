const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const { createFinalEditService } = require('../src/services/productionFinalEditService');
const { createProductionService } = require('../src/services/productionService');
const narrationPlan = require('../src/services/productionNarrationPlan');

let db;
let storageDir;
let cfg;
const log = { info() {}, warn() {}, error() {} };

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function makeRun(reviewOwner = 'human') {
  return repo.createRun(db, {
    drama_id: 1, episode_id: 1, idempotency_key: 'final-run', review_owner: reviewOwner,
    input: { story: '测试故事' }, policy: { aspect_ratio: '16:9' },
    budget: { max_video_attempts: 10, max_video_seconds: 60, max_shots: 3 },
  }).run;
}

function approved(run, stage, scope, id, title, content, mediaPath = null, dependencies = []) {
  return repo.createArtifact(db, {
    run_id: run.id, stage, scope_type: scope, scope_id: id, title,
    content: { included: true, ...content }, status: 'approved', media_path: mediaPath,
    content_hash: mediaPath ? 'c'.repeat(64) : undefined, depends_on: dependencies,
  });
}

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-export-test-'));
  cfg = { storage: { local_path: storageDir, base_url: 'http://localhost/static' } };
  db = new Database(':memory:');
  migrateQuietly();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at, metadata) VALUES (1, ?, ?, ?, ?)').run('最终测试', now, now, '{}');
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
});

afterEach(() => {
  db.close();
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('production final edit and export', () => {
  it('reconciles one strict merge action into a reviewable final artifact', async () => {
    const run = makeRun();
    const plan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', { duration: 5, video_prompt: '推进' });
    approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: plan.id,
      validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [plan.id]);
    let mergeStatus = 'processing';
    let creates = 0;
    const mergeService = {
      create() { creates += 1; return { merge_id: 51, task_id: 'merge-task-51' }; },
      processVideoMerge() {},
      getById() { return { id: 51, status: mergeStatus, merged_url: 'videos/final.mp4' }; },
    };
    const service = createFinalEditService(db, cfg, log, {
      mergeService,
      validateVideo: async () => ({
        relative_path: 'videos/final.mp4', absolute_path: path.join(storageDir, 'videos', 'final.mp4'),
        bytes: 2000000, sha256: 'd'.repeat(64), signature: 'mp4', duration: 5,
        width: 1280, height: 720, video_codec: 'h264', audio_codec: 'aac', nonblank: true,
      }),
    });
    assert.equal((await service.ensureFinalEdit(run)).state, 'waiting_provider');
    assert.equal((await service.ensureFinalEdit(repo.getRun(db, run.id))).state, 'waiting_provider');
    assert.equal(creates, 1);
    mergeStatus = 'completed';
    const result = await service.ensureFinalEdit(repo.getRun(db, run.id));
    assert.equal(result.state, 'progressed');
    assert.equal(result.artifact.status, 'draft');
    assert.equal(result.artifact.content.validation.video_codec, 'h264');
    assert.equal(creates, 1);
  });

  it('requires explicit feedback after a failed merge before creating a new attempt', async () => {
    const run = makeRun();
    const plan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', { duration: 5, video_prompt: '推进' });
    approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: plan.id,
      validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [plan.id]);
    repo.updateRun(db, run.id, { current_stage: 'final_edit', status: 'running' });
    let nextMergeId = 70;
    const statuses = new Map();
    const mergeService = {
      create() {
        const mergeId = nextMergeId++;
        statuses.set(mergeId, 'processing');
        return { merge_id: mergeId, task_id: `merge-task-${mergeId}` };
      },
      processVideoMerge() {},
      getById(_db, mergeId) {
        return { id: mergeId, status: statuses.get(mergeId), error_msg: '输入片段损坏' };
      },
    };
    const finalEdit = createFinalEditService(db, cfg, log, { mergeService });
    const first = await finalEdit.ensureFinalEdit(run);
    statuses.set(first.merge_id, 'failed');
    const failed = await finalEdit.ensureFinalEdit(repo.getRun(db, run.id));
    assert.equal(failed.state, 'failed');
    assert.equal(repo.getRun(db, run.id).status, 'failed');
    const failedAction = repo.getLatestAction(db, run.id, {
      stage: 'final_edit', scope_type: 'run', scope_id: '', kind: 'strict_merge',
    });
    assert.equal(failedAction.status, 'failed');

    const workflow = createProductionService(db, cfg, log);
    workflow.authorizeRetry(run.id, { action_id: failedAction.id });
    const retried = await finalEdit.ensureFinalEdit(repo.getRun(db, run.id));
    assert.equal(retried.state, 'waiting_provider');
    assert.notEqual(retried.merge_id, first.merge_id);
    assert.equal(repo.getAction(db, failedAction.id).status, 'cancelled');
    assert.equal(repo.getLatestAction(db, run.id, {
      stage: 'final_edit', scope_type: 'run', scope_id: '', kind: 'strict_merge',
    }).attempt, 2);
  });

  it('blocks human merge until narration is confirmed and passes the confirmed settings to FFmpeg', async () => {
    const run = makeRun();
    const planOne = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 3, narration: '夜色降临。', video_prompt: '建立夜景。',
    });
    const planTwo = approved(run, 'storyboard_plan', 'shot', '2', '镜头二', {
      number: 2, duration: 4, narration: '她走进雨后的街巷。', video_prompt: '进入街巷。',
    });
    const videoOne = approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: planOne.id, validation: { duration: 3 },
    }, 'videos/shot-1.mp4', [planOne.id]);
    const videoTwo = approved(run, 'shot_video', 'shot', '2', '镜头二', {
      source_artifact_id: planTwo.id, validation: { duration: 4 },
    }, 'videos/shot-2.mp4', [planTwo.id]);
    const requests = [];
    const mergeService = {
      create(_db, _log, request) { requests.push(request); return { merge_id: 81, task_id: 'merge-task-81' }; },
      processVideoMerge() {},
      getById() { return { id: 81, status: 'processing' }; },
    };
    const finalEdit = createFinalEditService(db, cfg, log, { mergeService });
    repo.updateRun(db, run.id, { current_stage: 'final_edit', status: 'running' });
    const first = await finalEdit.ensureFinalEdit(repo.getRun(db, run.id));
    assert.equal(first.state, 'progressed');
    assert.equal(first.artifact.status, 'draft');
    assert.equal(first.artifact.content.narration_enabled, true);
    assert.equal(repo.getRun(db, run.id).status, 'waiting_review');
    assert.equal(repo.getRun(db, run.id).waiting_reason, 'narration_confirmation');

    const workflow = createProductionService(db, cfg, log, { finalEdit: { mergeService } });
    const edited = workflow.updateArtifact(first.artifact.id, {
      content: { ...first.artifact.content, narration_volume: 1.15, subtitle_mode: 'sidecar' },
    });
    assert.equal(edited.revision, 2);
    await workflow.reviewArtifact(edited.id, { decision: 'approved', reason: '旁白设置确认' });
    const waiting = await finalEdit.ensureFinalEdit(repo.getRun(db, run.id));
    assert.equal(waiting.state, 'waiting_provider');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].merge_options.narration_enabled, true);
    assert.equal(requests[0].merge_options.narration_voice_id, 'zh-CN-XiaoyiNeural');
    assert.equal(requests[0].merge_options.subtitle_mode, 'sidecar');
    assert.equal(requests[0].scenes[0].narration, '夜色降临。');
    assert.equal(requests[0].scenes[1].narration, '她走进雨后的街巷。');
    assert.equal(repo.getArtifact(db, videoOne.id).status, 'approved');
    assert.equal(repo.getArtifact(db, videoTwo.id).status, 'approved');
  });

  it('keeps an unattended narration plan running and reaches one idempotent strict merge without human confirmation', async () => {
    const run = makeRun('auto_accept');
    const shotPlan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, narration: '她沿着雨后的街道继续前行。', video_prompt: '稳定跟拍。',
    });
    approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: shotPlan.id, validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [shotPlan.id]);
    repo.updateRun(db, run.id, {
      current_stage: 'final_edit', status: 'running', next_stage_strategy: 'auto_generate',
    });

    let creates = 0;
    const mergeService = {
      create() { creates += 1; return { merge_id: 181, task_id: 'merge-task-181' }; },
      processVideoMerge() {},
      getById() { return { id: 181, status: 'processing' }; },
    };
    const workflow = createProductionService(db, cfg, log, { finalEdit: { mergeService } });

    const planned = await workflow.advance(run.id, { lease_owner: 'auto-narration-plan' });
    assert.equal(planned.state, 'progressed');
    assert.equal(planned.reason, 'narration_plan_created');
    assert.equal(planned.artifact.status, 'draft');
    assert.equal(repo.getRun(db, run.id).status, 'running');
    assert.equal(repo.getRun(db, run.id).waiting_reason, null);
    assert.equal(creates, 0);

    const merged = await workflow.advance(run.id, { lease_owner: 'auto-narration-merge' });
    assert.equal(merged.state, 'waiting_provider');
    assert.equal(repo.getArtifact(db, planned.artifact.id).status, 'approved');
    assert.equal(creates, 1);

    const repeated = await workflow.advance(run.id, { lease_owner: 'auto-narration-repeat' });
    assert.equal(repeated.state, 'waiting_provider');
    assert.equal(creates, 1);
    assert.equal(repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.kind === 'strict_merge').length, 1);
  });

  it('auto-approves a revised narration plan and creates exactly one new strict merge for the outdated final', async () => {
    const run = makeRun('auto_accept');
    const shotPlan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, narration: '旧旁白。', video_prompt: '稳定推进。',
    });
    const shotVideo = approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: shotPlan.id, validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [shotPlan.id]);
    const oldPlanContent = narrationPlan.normalizeNarrationPlan({}, [shotPlan], [shotVideo]);
    const oldPlan = approved(run, 'final_edit', 'narration', 'settings', '旧旁白设置', oldPlanContent);
    repo.createArtifact(db, {
      run_id: run.id, stage: 'final_edit', scope_type: 'run', scope_id: '', title: '旧成片',
      content: {
        kind: 'final_video', included: true,
        narration_plan_artifact_id: oldPlan.id,
        narration_confirmation_fingerprint: oldPlanContent.confirmation_fingerprint,
        source_shot_artifact_ids: [shotVideo.id],
      },
      status: 'rejected', media_path: 'videos/old-final.mp4', mime_type: 'video/mp4',
    });
    const oldAction = repo.reserveAction(db, {
      run_id: run.id, action_key: 'old-final-merge', stage: 'final_edit',
      scope_type: 'run', scope_id: '', kind: 'strict_merge', attempt: 1,
      request: {
        narration_plan_artifact_id: oldPlan.id,
        narration_confirmation_fingerprint: oldPlanContent.confirmation_fingerprint,
        scene_ids: [shotVideo.id],
      },
    }).action;
    repo.updateAction(db, oldAction.id, { status: 'completed', result: { historical: true } });

    const revisedContent = narrationPlan.normalizeNarrationPlan({
      ...oldPlanContent,
      segments: [{ ...oldPlanContent.segments[0], narration: '修订后的旁白。' }],
    }, [shotPlan], [shotVideo]);
    const revisedPlan = repo.editArtifact(db, oldPlan.id, {
      content: revisedContent,
      depends_on: [shotPlan.id, shotVideo.id],
    });
    repo.updateRun(db, run.id, {
      current_stage: 'final_edit', status: 'running', next_stage_strategy: 'auto_generate',
    });

    let creates = 0;
    const mergeService = {
      create() { creates += 1; return { merge_id: 201, task_id: 'merge-task-201' }; },
      processVideoMerge() {},
      getById() { return { id: 201, status: 'processing' }; },
    };
    const workflow = createProductionService(db, cfg, log, { finalEdit: { mergeService } });
    const first = await workflow.advance(run.id, { lease_owner: 'auto-final-edit-1' });
    assert.equal(first.state, 'waiting_provider');
    assert.equal(repo.getArtifact(db, revisedPlan.id).status, 'approved');
    assert.equal(creates, 1);
    const strictMerges = repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.kind === 'strict_merge');
    assert.equal(strictMerges.length, 2);
    const currentAction = strictMerges.find((item) => item.id !== oldAction.id);
    assert.equal(currentAction.request.narration_plan_artifact_id, revisedPlan.id);
    assert.equal(currentAction.request.narration_confirmation_fingerprint, revisedContent.confirmation_fingerprint);

    const repeated = await workflow.advance(run.id, { lease_owner: 'auto-final-edit-2' });
    assert.equal(repeated.state, 'waiting_provider');
    assert.equal(creates, 1);
    assert.equal(repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.kind === 'strict_merge').length, 2);
  });

  it('waits after a matching final is rejected and rebuilds only through the explicit idempotent command', async () => {
    const run = makeRun();
    const shotPlan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, narration: '保持本镜旁白。', video_prompt: '稳定推进。',
    });
    const shotVideo = approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: shotPlan.id, validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [shotPlan.id]);
    const planContent = narrationPlan.normalizeNarrationPlan({ narration_enabled: false }, [shotPlan], [shotVideo]);
    const plan = approved(run, 'final_edit', 'narration', 'settings', '旁白设置', planContent);
    repo.createArtifact(db, {
      run_id: run.id, stage: 'final_edit', scope_type: 'run', scope_id: '', title: '已打回成片',
      content: {
        kind: 'final_video', included: true,
        narration_plan_artifact_id: plan.id,
        narration_confirmation_fingerprint: planContent.confirmation_fingerprint,
        source_shot_artifact_ids: [shotVideo.id],
      },
      status: 'rejected', media_path: 'videos/rejected-final.mp4', mime_type: 'video/mp4',
    });
    repo.updateRun(db, run.id, { current_stage: 'final_edit', status: 'waiting_review' });

    let creates = 0;
    let mergeStatus = 'processing';
    const mergeService = {
      create() { creates += 1; return { merge_id: 211, task_id: 'merge-task-211' }; },
      processVideoMerge() {},
      getById() { return { id: 211, status: mergeStatus, merged_url: 'videos/rebuilt-final.mp4' }; },
    };
    const workflow = createProductionService(db, cfg, log, {
      finalEdit: {
        mergeService,
        validateVideo: async () => ({
          relative_path: 'videos/rebuilt-final.mp4', bytes: 1000, sha256: 'e'.repeat(64),
          signature: 'mp4', duration: 5, width: 1280, height: 720, video_codec: 'h264',
          audio_codec: 'aac', nonblank: true,
        }),
      },
    });
    const passive = await workflow.advance(run.id, { lease_owner: 'passive-final-edit' });
    assert.equal(passive.state, 'waiting_review');
    assert.equal(passive.reason, 'final_revision_required');
    assert.equal(creates, 0);

    const first = await workflow.rebuildFinalEdit(run.id, {
      lease_owner: 'explicit-final-edit-1', reason: '旁白不变，重新执行本地剪辑',
    });
    const repeated = await workflow.rebuildFinalEdit(run.id, {
      lease_owner: 'explicit-final-edit-2', reason: '重复点击不应重复建单',
    });
    assert.equal(first.state, 'waiting_provider');
    assert.equal(repeated.state, 'waiting_provider');
    assert.equal(creates, 1);
    assert.equal(repo.listActions(db, run.id, { page_size: 200 }).items
      .filter((item) => item.kind === 'strict_merge').length, 1);
    const rebuildAction = repo.listActions(db, run.id, { page_size: 200 }).items
      .find((item) => item.kind === 'strict_merge');
    assert.equal(rebuildAction.request.force_rebuild, true);
    assert.equal(rebuildAction.request.revision_reason, '旁白不变，重新执行本地剪辑');

    mergeStatus = 'completed';
    const reconciled = await workflow.advance(run.id, { lease_owner: 'poll-final-edit' });
    assert.equal(reconciled.state, 'progressed');
    assert.equal(reconciled.artifact.status, 'draft');
    assert.equal(reconciled.artifact.content.narration_plan_artifact_id, plan.id);
    assert.deepEqual(reconciled.artifact.content.revision_receipt, {
      force_rebuild: true,
      reason: '旁白不变，重新执行本地剪辑',
      strict_merge_action_id: rebuildAction.id,
    });
    assert.equal(repo.getAction(db, rebuildAction.id).result.revision_reason, '旁白不变，重新执行本地剪辑');
    assert.equal(creates, 1);
  });

  it('turns final voice-sync rejection into a revised narration plan with the full review brief', async () => {
    let run = makeRun('ai');
    const shotPlan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, narration: '她抬头看见晨光。', video_prompt: '稳定中景。',
    });
    const shotVideo = approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: shotPlan.id, validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [shotPlan.id]);
    const planContent = narrationPlan.normalizeNarrationPlan({}, [shotPlan], [shotVideo]);
    const plan = approved(run, 'final_edit', 'narration', 'settings', '旁白设置', planContent);
    const final = repo.createArtifact(db, {
      run_id: run.id, stage: 'final_edit', scope_type: 'run', scope_id: '', title: '待审成片',
      content: {
        kind: 'final_video', included: true, source_shot_artifact_ids: [shotVideo.id],
        narration_plan_artifact_id: plan.id,
        narration_confirmation_fingerprint: planContent.confirmation_fingerprint,
        validation: { duration: 5 },
      },
      status: 'draft', media_path: 'videos/final-voice-sync.mp4', mime_type: 'video/mp4',
      depends_on: [plan.id, shotVideo.id],
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'final_edit', status: 'running',
      review_profile: { model: 'vision-review-model', version: 'final-review-v1' },
    });
    const rewriteCalls = [];
    const workflow = createProductionService(db, cfg, log, {
      validateVideo: async () => ({ duration: 5, video_codec: 'h264', audio_codec: 'aac', nonblank: true }),
      prepareReviewEvidence: async () => ({
        imageSource: { localAbsPath: 'C:\\review\\final-sheet.jpg' },
        receipt: { kind: 'video_first_middle_last_sheet', sampled_at_seconds: [0.4, 2.5, 4.6] },
        cleanup() {},
      }),
      generateTextWithVision: async () => JSON.stringify({
        decision: 'rejected', reason: '旁白比画面慢一整拍，字幕进入下一章节后才出现',
        confidence: 0.97, severity: 'major',
        blocking_issues: ['把本镜旁白压缩到镜头结束前完成，并将字幕锁定到本镜时间窗'],
        improvement_notes: ['背景原声可再降低少量音量'], requires_human_authority: false,
        scores: { continuity: 35, production_ready: 30 },
      }),
      generateText: async (user, system, options) => {
        rewriteCalls.push({ user, system, options });
        return JSON.stringify({ ...planContent, speed: 1.12, provider_audio_volume: 0.55 });
      },
    });

    const result = await workflow.applyReviewPolicy(run, [final]);
    assert.equal(result.state, 'progressed');
    assert.equal(result.reason, 'final_narration_plan_revised');
    const revisedPlan = repo.listArtifacts(db, run.id, {
      stage: 'final_edit', scope_type: 'narration', scope_id: 'settings', current: true,
    }).items[0];
    assert.equal(revisedPlan.revision, 2);
    assert.equal(revisedPlan.status, 'draft');
    assert.equal(revisedPlan.content.speed, 1.12);
    assert.equal(repo.getArtifact(db, final.id).status, 'invalidated');
    assert.equal(rewriteCalls.length, 1);
    assert.match(rewriteCalls[0].user, /旁白比画面慢一整拍/);
    assert.match(rewriteCalls[0].user, /把本镜旁白压缩到镜头结束前完成/);
    assert.match(rewriteCalls[0].user, /背景原声可再降低少量音量/);
    const rewriteAction = repo.listActions(db, run.id, { page_size: 100 }).items
      .find((item) => item.kind === 'ai_rewrite');
    assert.match(rewriteAction.request.instruction, /不得升级成新门槛/);
  });

  it('escalates an ambiguous final rejection only when the revision planner proves human authority is required', async () => {
    let run = makeRun('ai');
    const shotPlan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, narration: '', video_prompt: '稳定中景。',
    });
    const shotVideo = approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: shotPlan.id, validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [shotPlan.id]);
    const planContent = narrationPlan.normalizeNarrationPlan({ narration_enabled: false }, [shotPlan], [shotVideo]);
    const plan = approved(run, 'final_edit', 'narration', 'settings', '原声设置', planContent);
    const final = repo.createArtifact(db, {
      run_id: run.id, stage: 'final_edit', scope_type: 'run', scope_id: '', title: '待核权成片',
      content: {
        kind: 'final_video', included: true, source_shot_artifact_ids: [shotVideo.id],
        narration_plan_artifact_id: plan.id,
        narration_confirmation_fingerprint: planContent.confirmation_fingerprint,
      },
      status: 'draft', media_path: 'videos/final-rights.mp4', mime_type: 'video/mp4',
      depends_on: [plan.id, shotVideo.id],
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'final_edit', status: 'running',
      review_profile: { model: 'vision-review-model', version: 'final-review-v1' },
    });
    const workflow = createProductionService(db, cfg, log, {
      validateVideo: async () => ({ duration: 5, video_codec: 'h264', audio_codec: 'aac', nonblank: true }),
      prepareReviewEvidence: async () => ({
        imageSource: { localAbsPath: 'C:\\review\\rights-sheet.jpg' },
        receipt: { kind: 'video_first_middle_last_sheet', sampled_at_seconds: [0.4, 2.5, 4.6] },
        cleanup() {},
      }),
      generateTextWithVision: async () => JSON.stringify({
        decision: 'rejected', reason: '成片出现真实品牌授权标识，项目没有提供授权状态',
        confidence: 0.95, severity: 'critical',
        blocking_issues: ['必须确认该真实品牌标识是否获得发布授权'],
        improvement_notes: [], requires_human_authority: false,
        scores: { production_ready: 20 },
      }),
      generateText: async (_user, _system, options) => {
        assert.equal(options.scene_key, 'production_final_edit_revision');
        return JSON.stringify({
          action: 'needs_human', shot_id: '', reason: '授权状态是不可从素材推断的外部事实',
          instruction: '请确认品牌授权，或明确允许移除该标识', requires_human_authority: true,
        });
      },
    });

    const result = await workflow.applyReviewPolicy(run, [final]);
    assert.equal(result.state, 'waiting_review');
    assert.equal(result.reason, 'human_authority_required');
    assert.equal(result.run.error_code, 'HUMAN_AUTHORITY_REQUIRED');
    assert.equal(result.run.runtime.autonomy.intervention.reason, 'human_authority_required');
    const object = Object.values(result.run.runtime.autonomy.objects)[0];
    assert.equal(object.consecutive_review_failures, 1);
    assert.equal(repo.listActions(db, run.id, { page_size: 100 }).items
      .filter((item) => item.kind === 'ai_rewrite').length, 0);
  });

  it('keeps an outdated final as history but blocks edits, AI rewrite, review, and export', async () => {
    const run = makeRun();
    const shotPlan = approved(run, 'storyboard_plan', 'shot', '1', '镜头一', {
      number: 1, duration: 5, narration: '当前旁白。', video_prompt: '稳定推进。',
    });
    const shotVideo = approved(run, 'shot_video', 'shot', '1', '镜头一', {
      source_artifact_id: shotPlan.id, validation: { duration: 5 },
    }, 'videos/shot-1.mp4', [shotPlan.id]);
    const currentPlanContent = narrationPlan.normalizeNarrationPlan({}, [shotPlan], [shotVideo]);
    approved(run, 'final_edit', 'narration', 'settings', '当前旁白设置', currentPlanContent);
    const oldFinal = approved(run, 'final_edit', 'run', '', '历史成片', {
      kind: 'final_video',
      narration_plan_artifact_id: 17,
      narration_confirmation_fingerprint: 'historical-plan',
      source_shot_artifact_ids: [shotVideo.id],
      validation: { duration: 5 },
    }, 'videos/historical-final.mp4');
    repo.updateRun(db, run.id, { current_stage: 'final_edit', status: 'completed' });
    const workflow = createProductionService(db, cfg, log, {
      generateText: async () => { throw new Error('AI must not be called'); },
    });

    assert.throws(() => workflow.updateArtifact(oldFinal.id, {
      content: { ...oldFinal.content, note: 'pretend media rewrite' },
    }), /最终成片不能通过改写文本/);
    await assert.rejects(() => workflow.suggestArtifact(oldFinal.id, { instruction: '重写' }), /最终成片不能通过改写文本/);
    await assert.rejects(() => workflow.reviewArtifact(oldFinal.id, {
      decision: 'rejected', reason: '尝试重新打回旧成片',
    }), /旧旁白或旧镜头/);
    assert.throws(() => workflow.exportRun(run.id), /缺少已确认的最终成片/);
    assert.equal(repo.getArtifact(db, oldFinal.id).media_path, 'videos/historical-final.mp4');
  });

  it('creates a stable manifest and ZIP with approved artifacts after completion', () => {
    const run = makeRun();
    const mediaDir = path.join(storageDir, 'videos');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'final.mp4'), Buffer.alloc(12000, 7));
    const script = approved(run, 'script', 'run', '', '剧本', { text: '第一场：测试。' });
    approved(run, 'director_plan', 'shot', '1', '历史导演台方案', {
      document: { objects: [], active_camera_id: 'camera-main', timeline: { duration: 5, keyframes: [] } },
    });
    const final = approved(run, 'final_edit', 'run', '', '最终成片', {
      source_shot_artifact_ids: [], validation: { duration: 5 },
    }, 'videos/final.mp4', [script.id]);
    repo.updateRun(db, run.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      policy: { ...run.policy, director_mode: 'off' },
    });
    const service = createFinalEditService(db, cfg, log);
    const exported = service.materializeExport(run.id);
    assert.equal(fs.existsSync(exported.manifest_path), true);
    assert.equal(exported.manifest.manifest_version, 3);
    assert.equal(exported.manifest.final_video, final.media_path);
    const scriptFile = exported.manifest.files.find((file) => file.stage === 'script');
    const finalFile = exported.manifest.files.find((file) => file.stage === 'final_edit');
    assert.ok(scriptFile);
    assert.ok(finalFile);
    assert.equal(exported.manifest.files.some((file) => file.stage === 'director_plan'), false);
    assert.deepEqual(exported.manifest.export_omissions, {
      director_artifacts_omitted: true,
      omitted_stages: ['director_plan', 'director_preview'],
    });
    assert.equal(scriptFile.sha256, sha256(path.join(exported.directory, scriptFile.path)));
    assert.equal(scriptFile.bytes, fs.statSync(path.join(exported.directory, scriptFile.path)).size);
    assert.equal(scriptFile.artifact_content_hash, script.content_hash);
    assert.equal(finalFile.sha256, sha256(path.join(exported.directory, finalFile.path)));
    assert.equal(finalFile.artifact_content_hash, final.content_hash);
    assert.equal(exported.manifest.run_file.sha256, sha256(path.join(exported.directory, 'run.json')));
    assert.equal(exported.manifest.run_file.bytes, fs.statSync(path.join(exported.directory, 'run.json')).size);
    const zipped = service.createZip(run.id);
    assert.equal(fs.existsSync(zipped.zip_path), true);
    assert.ok(fs.statSync(zipped.zip_path).size > 1000);
  });

  it('exports every page, redacts action tokens, deduplicates media, and replaces stale output', () => {
    const run = makeRun();
    const mediaDir = path.join(storageDir, 'videos');
    fs.mkdirSync(mediaDir, { recursive: true });
    fs.writeFileSync(path.join(mediaDir, 'final.mp4'), Buffer.alloc(12000, 9));
    const script = approved(run, 'script', 'run', '', '剧本', { text: '第一场：完整测试剧本内容，用于分页导出。' });
    for (let index = 1; index <= 205; index += 1) {
      approved(run, 'asset_text', 'prop', `prop-${index}`, `道具 ${index}`, { name: `道具 ${index}`, description: '测试', visual_prompt: '测试' });
    }
    const duplicateMedia = approved(run, 'shot_video', 'shot', '1', '镜头一', {
      validation: { duration: 5 },
    }, 'videos/final.mp4');
    const final = approved(run, 'final_edit', 'run', '', '最终成片', {
      source_shot_artifact_ids: [duplicateMedia.id], validation: { duration: 5 },
    }, 'videos/final.mp4', [duplicateMedia.id]);
    for (let index = 0; index < 105; index += 1) {
      repo.addReview(db, {
        run_id: run.id, artifact_id: script.id, reviewer_type: 'deterministic',
        decision: 'approved', reason: `分页审批 ${index + 1}`,
      });
    }
    repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'export-redaction-action',
      stage: 'director_preview',
      scope_type: 'shot',
      scope_id: '1',
      kind: 'client_capture',
      request: { client_token: 'must-not-export', nested: { api_key: 'also-secret' } },
    });
    repo.updateRun(db, run.id, { status: 'completed', completed_at: new Date().toISOString() });

    const service = createFinalEditService(db, cfg, log);
    const first = service.materializeExport(run.id);
    assert.ok(first.manifest.files.length > 205);
    assert.ok(first.manifest.reviews.length > 100);
    assert.ok(first.manifest.events.length > 200);
    const action = first.manifest.actions.find((item) => item.action_key === 'export-redaction-action');
    assert.equal(action.request.client_token, '[REDACTED]');
    assert.equal(action.request.nested.api_key, '[REDACTED]');
    const duplicateFiles = first.manifest.files.filter((item) => [duplicateMedia.id, final.id].includes(item.artifact_id));
    assert.equal(duplicateFiles.length, 2);
    assert.equal(duplicateFiles[0].path, duplicateFiles[1].path);

    const stalePath = path.join(first.directory, 'stale.txt');
    fs.writeFileSync(stalePath, 'stale');
    const second = service.materializeExport(run.id);
    assert.equal(fs.existsSync(stalePath), false);
    assert.equal(fs.existsSync(second.manifest_path), true);
  });
});
