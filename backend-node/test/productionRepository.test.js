const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');

let db;

function withoutMigrationLogs(fn) {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { return fn(); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function makeRun(overrides = {}) {
  return repo.createRun(db, {
    drama_id: 1,
    episode_id: 1,
    idempotency_key: 'test-run',
    review_owner: 'human',
    input: { source_type: 'idea', story: '一位宇航员在星尘花园寻找失落的种子。' },
    budget: { max_video_attempts: 2, max_video_seconds: 10 },
    ...overrides,
  }).run;
}

beforeEach(() => {
  db = new Database(':memory:');
  withoutMigrationLogs(() => runMigrationsAndEnsure(db));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('测试项目', now, now);
  db.prepare(
    'INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)'
  ).run('第一集', now, now);
});

afterEach(() => db.close());

describe('production workflow repository', () => {
  it('creates one resumable run for an idempotency key and snapshots the user story', () => {
    const first = makeRun();
    const second = makeRun();
    assert.equal(first.id, second.id);
    assert.equal(first.current_stage, 'story_input');
    assert.equal(first.runtime.shot_pipeline.mode, 'sequential');
    const artifacts = repo.listArtifacts(db, first.id, { current: true }).items;
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].status, 'approved');
    assert.match(artifacts[0].content.story, /星尘花园/);
    assert.equal(repo.listEvents(db, first.id).items.some((event) => event.event_type === 'run.created'), true);
    const legacy = makeRun({
      idempotency_key: 'legacy-stage-major-run',
      runtime: { shot_pipeline: { mode: 'stage_major' } },
    });
    assert.equal(legacy.runtime.shot_pipeline.mode, 'stage_major');
  });

  it('freezes the task aspect ratio while allowing other policy settings to change', () => {
    const run = makeRun({ idempotency_key: 'frozen-aspect-run', policy: { aspect_ratio: '9:16' } });
    const updated = repo.updateRun(db, run.id, {
      policy: { ...run.policy, image_concurrency: 6, aspect_ratio: '9：16' },
    });
    assert.equal(updated.policy.aspect_ratio, '9:16');
    assert.equal(updated.policy.image_concurrency, 6);
    assert.throws(
      () => repo.updateRun(db, run.id, { policy: { ...updated.policy, aspect_ratio: '16:9' } }),
      (error) => error.code === 'PRODUCTION_ASPECT_RATIO_LOCKED'
        && error.details.frozen_aspect_ratio === '9:16'
        && error.details.requested_aspect_ratio === '16:9',
    );
    assert.equal(repo.getRun(db, run.id).policy.aspect_ratio, '9:16');
  });

  it('atomically resolves the active intervention when a human re-enables autonomy', () => {
    let run = makeRun({ idempotency_key: 'resolve-intervention' });
    run = repo.updateRun(db, run.id, {
      status: 'waiting_review',
      waiting_reason: 'automation_limit_reached',
      error_code: 'AUTOMATION_LIMIT_REACHED',
      error_message: '连续失败',
      runtime: {
        autonomy: {
          objects: {
            'shot_video:shot:3': { escalated: true, consecutive_generation_failures: 2 },
          },
          intervention: {
            object_key: 'shot_video:shot:3', stage: 'shot_video', scope_type: 'shot', scope_id: '3',
            reason: 'automation_limit_reached',
          },
        },
      },
    });
    const resolved = repo.updateRunControl(db, run.id, { review_owner: 'ai' }, run.version);
    assert.equal(resolved.review_owner, 'ai');
    assert.equal(resolved.status, 'running');
    assert.equal(resolved.waiting_reason, null);
    assert.equal(resolved.error_code, null);
    assert.equal(resolved.runtime.autonomy.intervention, undefined);
    assert.equal(resolved.runtime.autonomy.objects['shot_video:shot:3'], undefined);
    const events = repo.listEvents(db, run.id, { page_size: 100 }).items.map((item) => item.event_type);
    assert.ok(events.includes('automation.intervention_resolved'));
    assert.ok(events.includes('run.review_owner_changed'));
  });

  it('explicitly resolves a stale intervention while keeping the current autonomous owner', () => {
    let run = makeRun({ idempotency_key: 'resolve-same-owner', review_owner: 'ai' });
    run = repo.updateRun(db, run.id, {
      status: 'waiting_review',
      waiting_reason: 'automation_limit_reached',
      runtime: {
        autonomy: {
          objects: { 'script:run:': { escalated: true, consecutive_review_failures: 3 } },
          intervention: { object_key: 'script:run:', stage: 'script', reason: 'automation_limit_reached' },
        },
      },
    });
    const resolved = repo.updateRunControl(db, run.id, {
      review_owner: 'ai', resolve_intervention: true,
    }, run.version);
    assert.equal(resolved.review_owner, 'ai');
    assert.equal(resolved.status, 'running');
    assert.equal(resolved.runtime.autonomy.intervention, undefined);
    assert.equal(resolved.runtime.autonomy.objects['script:run:'], undefined);
    const resolvedEvent = repo.listEvents(db, run.id, { page_size: 100 }).items
      .find((item) => item.event_type === 'automation.intervention_resolved');
    assert.equal(resolvedEvent.payload.resolved_by, 'human_confirmed_resolution');
    assert.equal(repo.listEvents(db, run.id, { page_size: 100 }).items
      .some((item) => item.event_type === 'run.review_owner_changed'), false);
  });

  it('keeps an intervention when unrelated settings change and rolls back a stale owner switch', () => {
    let run = makeRun({ idempotency_key: 'keep-intervention' });
    run = repo.updateRun(db, run.id, {
      runtime: { autonomy: { intervention: { object_key: 'script:run:', reason: 'automation_limit_reached' } } },
    });
    const settingsOnly = repo.updateRunControl(db, run.id, { manual_next_default: true }, run.version);
    assert.ok(settingsOnly.runtime.autonomy.intervention);
    assert.throws(
      () => repo.updateRunControl(db, run.id, { review_owner: 'ai' }, run.version),
      (error) => error.code === 'VERSION_CONFLICT',
    );
    const current = repo.getRun(db, run.id);
    assert.equal(current.review_owner, 'human');
    assert.ok(current.runtime.autonomy.intervention);
  });

  it('lists reusable approved media for the same drama with provenance and path deduplication', () => {
    const first = makeRun({ idempotency_key: 'reuse-first' });
    const second = makeRun({ idempotency_key: 'reuse-second' });
    repo.createArtifact(db, {
      run_id: first.id, stage: 'director_preview', scope_type: 'shot', scope_id: '1',
      title: 'Shot 1 previs', content: { included: true }, status: 'approved',
      media_path: 'previews/shot-1.webm', mime_type: 'video/webm',
    });
    repo.createArtifact(db, {
      run_id: second.id, stage: 'asset_images', scope_type: 'character', scope_id: 'hero',
      title: 'Hero identity', content: { included: true }, status: 'approved',
      media_path: 'images/hero.png', mime_type: 'image/png',
    });
    repo.createArtifact(db, {
      run_id: second.id, stage: 'shot_video', scope_type: 'shot', scope_id: '1',
      title: 'Duplicate previs path', content: { included: true }, status: 'approved',
      media_path: 'previews/shot-1.webm', mime_type: 'video/webm',
    });
    const result = repo.listReusableMedia(db, second.id, { limit: 20 });
    assert.equal(result.items.length, 2);
    assert.deepEqual(result.items.map((item) => item.media_path).sort(), ['images/hero.png', 'previews/shot-1.webm']);
    const previs = result.items.find((item) => item.media_path === 'previews/shot-1.webm');
    assert.equal(previs.stage, 'shot_video');
    assert.equal(previs.media_type, 'video');
    assert.equal(previs.drama_id, 1);
    assert.equal(repo.listReusableMedia(db, second.id, { media_type: 'image' }).items.length, 1);
  });

  it('lists global production media with current revisions, kind filters, pagination and latest finals per drama', () => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (2, ?, ?, ?)').run('第二项目', now, now);
    db.prepare(
      'INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (2, 2, 1, ?, ?, ?)'
    ).run('第二集', now, now);
    const first = makeRun({ idempotency_key: 'global-media-first' });
    const second = makeRun({
      drama_id: 2,
      episode_id: 2,
      idempotency_key: 'global-media-second',
      input: { story: '第二个项目的故事。' },
    });
    const oldFinal = repo.createArtifact(db, {
      run_id: first.id, stage: 'final_edit', scope_type: 'run', scope_id: '',
      title: '旧成片', content: { included: true, kind: 'final_video' }, status: 'approved',
      media_path: 'videos/old-final.mp4', mime_type: 'video/mp4',
    });
    repo.createArtifact(db, {
      run_id: first.id, stage: 'final_edit', scope_type: 'run', scope_id: '',
      title: '被打回的新修订', content: { included: true, kind: 'final_video' }, status: 'rejected',
      media_path: 'videos/rejected-final.mp4', mime_type: 'video/mp4',
      parent_artifact_id: oldFinal.id,
    });
    repo.createArtifact(db, {
      run_id: first.id, stage: 'final_edit', scope_type: 'narration', scope_id: 'settings',
      title: '旁白', content: { included: true, kind: 'narration_audio' }, status: 'approved',
      media_path: 'audio/narration.mp3', mime_type: 'audio/mpeg',
    });
    repo.createArtifact(db, {
      run_id: second.id, stage: 'final_edit', scope_type: 'run', scope_id: '',
      title: '第二项目成片', content: { included: true, kind: 'final_video' }, status: 'approved',
      media_path: 'videos/second-final.mp4', mime_type: 'video/mp4',
    });

    const finals = repo.listProductionMedia(db, {
      stage: 'final_edit', kind: 'final_video', media_type: 'video', page_size: 1,
    });
    assert.equal(finals.pagination.total, 1);
    assert.equal(finals.items[0].drama_title, '第二项目');
    assert.equal(finals.items[0].kind, 'final_video');

    const audio = repo.listProductionMedia(db, { media_type: 'audio' });
    assert.equal(audio.pagination.total, 1);
    assert.equal(audio.items[0].kind, 'narration_audio');

    const historicalFinals = repo.listProductionMedia(db, {
      stage: 'final_edit', kind: 'final_video', media_type: 'video', current: false,
      latest_per_drama: true,
    });
    assert.equal(historicalFinals.pagination.total, 2);
    assert.deepEqual(historicalFinals.items.map((item) => item.drama_id).sort(), [1, 2]);
  });

  it('allows an approved artifact to be reopened and rejects its downstream branch', () => {
    const run = makeRun({ idempotency_key: 'reopen-approved' });
    const image = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'character', scope_id: 'hero',
      title: 'Hero identity', content: { included: true }, status: 'approved', media_path: 'images/hero.png',
    });
    const downstream = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '1',
      title: 'Shot frame', content: { included: true }, status: 'approved', media_path: 'images/shot.png',
      depends_on: [image.id],
    });
    const reopened = repo.reviewArtifact(db, image.id, {
      reviewer_type: 'human', decision: 'rejected', reason: '角色姿态需要重做',
    });
    assert.equal(reopened.artifact.status, 'rejected');
    assert.equal(repo.getArtifact(db, downstream.id).status, 'invalidated');
    assert.equal(repo.listReviews(db, run.id, { artifact_id: image.id }).items.at(-1).decision, 'rejected');
  });

  it('filters review history by the requested stage and object scope', () => {
    const run = makeRun({ idempotency_key: 'review-scope-filter' });
    const assetText = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'prop', scope_id: 'prop-1',
      title: '银白长剑文字设定', content: { description: '同一柄银白长剑' }, status: 'draft',
    });
    const propImage = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'prop', scope_id: 'prop-1',
      title: '银白长剑设定图', content: { included: true }, status: 'draft', media_path: 'images/sword.png',
    });
    const sceneImage = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'scene', scope_id: 'scene-1',
      title: '断崖古台设定图', content: { included: true }, status: 'draft', media_path: 'images/cliff.png',
    });
    repo.reviewArtifact(db, assetText.id, { reviewer_type: 'ai', decision: 'rejected', reason: '文字锚点不够具体' });
    repo.reviewArtifact(db, propImage.id, { reviewer_type: 'ai', decision: 'rejected', reason: '不是道具四视图' });
    repo.reviewArtifact(db, sceneImage.id, { reviewer_type: 'ai', decision: 'rejected', reason: '不是同一场景四视图' });

    const scoped = repo.listReviews(db, run.id, {
      stage: 'asset_images', scope_type: 'prop', scope_id: 'prop-1', decision: 'rejected', page_size: 20,
    });
    assert.equal(scoped.pagination.total, 1);
    assert.equal(scoped.items[0].artifact_id, propImage.id);
    assert.equal(scoped.items[0].reason, '不是道具四视图');
  });

  it('keeps revisions and invalidates only dependent downstream artifacts', () => {
    const run = makeRun();
    const scriptV1 = repo.createArtifact(db, {
      run_id: run.id, stage: 'script', scope_type: 'run', scope_id: '',
      title: '剧本', content: { text: '第一版', included: true }, status: 'draft',
    });
    repo.reviewArtifact(db, scriptV1.id, { reviewer_type: 'human', decision: 'approved' });
    const character = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'character', scope_id: 'hero',
      title: '主角', content: { name: '林夏', description: '宇航员', included: true },
      status: 'approved', depends_on: [scriptV1.id],
    });
    const unrelated = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'prop', scope_id: 'seed',
      title: '种子', content: { name: '星尘种子', included: true }, status: 'approved',
    });
    const scriptV2 = repo.editArtifact(db, scriptV1.id, { content: { text: '第二版', included: true } });
    repo.reviewArtifact(db, scriptV2.id, { reviewer_type: 'human', decision: 'approved' });
    assert.equal(repo.getArtifact(db, scriptV1.id).status, 'superseded');
    assert.equal(repo.getArtifact(db, character.id).status, 'invalidated');
    assert.equal(repo.getArtifact(db, unrelated.id).status, 'approved');
  });

  it('preserves an approved replacement while invalidating the old branch and premature descendants', () => {
    const run = makeRun();
    const original = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'character', scope_id: 'hero',
      title: '主角', content: { included: true }, status: 'approved', media_path: 'images/hero-v1.png',
    });
    const staleStoryboard = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '1',
      title: '旧分镜', content: { included: true }, status: 'approved',
      media_path: 'images/shot-v1.png', depends_on: [original.id],
    });
    const replacement = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'character', scope_id: 'hero',
      title: '主角', content: { included: true }, status: 'draft', media_path: 'images/hero-v2.png',
      parent_artifact_id: original.id, depends_on: [original.id],
    });
    const prematureDescendant = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '2',
      title: '提前生成的分镜', content: { included: true }, status: 'draft',
      media_path: 'images/shot-v2.png', depends_on: [replacement.id],
    });

    const approved = repo.reviewArtifact(db, replacement.id, {
      reviewer_type: 'human', decision: 'approved', reason: '替代图通过',
    });

    assert.equal(approved.artifact.status, 'approved');
    assert.equal(repo.getArtifact(db, original.id).status, 'superseded');
    assert.equal(repo.getArtifact(db, staleStoryboard.id).status, 'invalidated');
    assert.equal(repo.getArtifact(db, prematureDescendant.id).status, 'invalidated');
  });

  it('requires all included artifacts to be approved while allowing reversible exclusion', () => {
    const run = makeRun();
    const a = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'character', scope_id: 'a',
      title: '角色 A', content: { included: true, name: 'A' }, status: 'approved',
    });
    const b = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'prop', scope_id: 'b',
      title: '道具 B', content: { included: true, name: 'B' }, status: 'draft',
    });
    assert.equal(repo.stageCompletion(db, run.id, 'asset_text').complete, false);
    const excluded = repo.excludeArtifact(db, b.id, { reason: '剧情不再需要' }).artifact;
    assert.equal(excluded.content.included, false);
    assert.equal(repo.stageCompletion(db, run.id, 'asset_text').complete, true);
    const restored = repo.restoreArtifact(db, excluded.id);
    assert.equal(restored.content.included, true);
    assert.equal(restored.status, 'draft');
    assert.equal(repo.stageCompletion(db, run.id, 'asset_text').complete, false);
    assert.equal(repo.getArtifact(db, a.id).status, 'approved');
  });

  it('treats narration settings as non-media while still requiring a final video', () => {
    const run = makeRun({ idempotency_key: 'final-edit-narration-completion' });
    repo.createArtifact(db, {
      run_id: run.id, stage: 'final_edit', scope_type: 'narration', scope_id: 'settings',
      title: '旁白、字幕与原声设置', content: { kind: 'narration_plan', included: true }, status: 'approved',
    });
    const beforeMerge = repo.stageCompletion(db, run.id, 'final_edit');
    assert.equal(beforeMerge.complete, false);
    assert.deepEqual(beforeMerge.unresolved.map((item) => item.reason), ['missing_final_video']);

    repo.createArtifact(db, {
      run_id: run.id, stage: 'final_edit', scope_type: 'run', scope_id: '',
      title: '最终剪辑成片', content: { kind: 'final_video', included: true }, status: 'approved',
      media_path: 'videos/final.mp4', mime_type: 'video/mp4',
    });
    assert.equal(repo.stageCompletion(db, run.id, 'final_edit').complete, true);
  });

  it('keeps an empty series selection valid but rejects stale explicit asset references before creating a run', () => {
    const group = require('../src/services/seriesGroupService').createGroup(db, { name: '续集校验' });
    const empty = repo.createRun(db, {
      drama_id: 1, episode_id: 1, idempotency_key: 'series-empty-selection',
      input: { story: '没有选择复用资产的续集' },
      policy: { series_group_id: group.id, series_asset_refs: [] },
    }).run;
    assert.equal(empty.policy.series_group_id, group.id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM series_group_episodes WHERE series_group_id = ?').get(group.id).n, 1);
    assert.throws(() => repo.createRun(db, {
      drama_id: 1, episode_id: 1, idempotency_key: 'series-stale-asset',
      input: { story: '引用不存在资产' },
      policy: { series_group_id: group.id, series_asset_refs: [{ series_asset_id: 999 }] },
    }), (error) => error.code === 'SERIES_ASSET_NOT_FOUND');
    assert.equal(repo.listRuns(db, { drama_id: 1 }).items.some((run) => run.idempotency_key === 'series-stale-asset'), false);
  });

  it('rejects an explicit version from another asset instead of silently using the current version', () => {
    const series = require('../src/services/seriesGroupService');
    const group = series.createGroup(db, { name: '版本校验' });
    const asset = series.upsertAsset(db, group.id, { asset_key: 'hero', asset_type: 'character', content: { name: 'A' } }).assets[0];
    assert.throws(() => repo.createRun(db, {
      drama_id: 1, episode_id: 1, idempotency_key: 'series-wrong-version',
      input: { story: '引用错误版本' },
      policy: { series_group_id: group.id, series_asset_refs: [{ series_asset_id: asset.id, series_asset_version_id: 9876 }] },
    }), (error) => error.code === 'SERIES_ASSET_VERSION_NOT_FOUND');
  });

  it('serializes executor ownership with expiring leases', () => {
    const run = makeRun();
    assert.equal(repo.claimLease(db, run.id, 'tab-a', 30000).claimed, true);
    const busy = repo.claimLease(db, run.id, 'tab-b', 30000);
    assert.equal(busy.claimed, false);
    assert.equal(busy.reason, 'busy');
    assert.equal(repo.releaseLease(db, run.id, 'tab-b'), false);
    assert.equal(repo.releaseLease(db, run.id, 'tab-a'), true);
    assert.equal(repo.claimLease(db, run.id, 'tab-b', 30000).claimed, true);
  });

  it('reserves paid budget before submission and reuses a durable action key', () => {
    const run = makeRun();
    const first = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:video:r1:a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { prompt: '镜头 1' }, reserved_video_seconds: 5,
    });
    assert.equal(first.reused, false);
    const duplicate = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:video:r1:a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { prompt: '不会覆盖' }, reserved_video_seconds: 5,
    });
    assert.equal(duplicate.reused, true);
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 1, video_seconds_reserved: 5 });
    repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:2:video:r1:a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '2', kind: 'video_generate', request: {}, reserved_video_seconds: 5,
    });
    assert.throws(() => repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:3:video:r1:a1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '3', kind: 'video_generate', request: {}, reserved_video_seconds: 5,
    }), /超过预算/);
  });

  it('releases a definitively rejected video reservation exactly once after local waiting state', () => {
    const run = makeRun({ idempotency_key: 'rejected-video-release' });
    const action = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot:1:rejected:a1',
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      kind: 'video_generate',
      request: { model: 'seedance-test' },
      reserved_video_seconds: 5,
      cost: {
        provider: 'yinzi', service_type: 'video', model: 'seedance-test',
        billing_unit: 'per_second', units: 5, estimated_microusd: 500000,
      },
    }).action;
    repo.updateAction(db, action.id, {
      status: 'waiting', task_id: 'local-task', generation_id: 91,
    });

    const released = repo.releaseUnacceptedVideoAction(db, action.id, {
      submission_status: 'rejected',
      error_code: 'VIDEO_SUBMISSION_REJECTED',
      error_message: 'HTTP 400 unsupported_media_reference',
      result: { submission_http_status: 400 },
    });
    assert.equal(released.status, 'failed');
    assert.equal(released.result.reservation_released, true);
    assert.equal(released.result.submission_status, 'rejected');
    assert.deepEqual(repo.getRun(db, run.id).usage, {
      video_attempts_reserved: 0,
      video_seconds_reserved: 0,
    });
    assert.equal(db.prepare('SELECT status FROM cost_ledger WHERE action_id = ?').get(action.id).status, 'released');

    const repeated = repo.releaseUnacceptedVideoAction(db, action.id, {
      submission_status: 'rejected',
      error_message: 'same rejection observed again',
    });
    assert.equal(repeated.result.reservation_released, true);
    assert.deepEqual(repo.getRun(db, run.id).usage, {
      video_attempts_reserved: 0,
      video_seconds_reserved: 0,
    });
  });

  it('reconciles ambiguous video usage once while keeping its cost uncertain', () => {
    const run = makeRun({ idempotency_key: 'ambiguous-video-reconcile' });
    const action = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot:1:ambiguous:a1',
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      kind: 'video_generate',
      request: { model: 'seedance-test' },
      reserved_video_seconds: 5,
      cost: {
        provider: 'yinzi', service_type: 'video', model: 'seedance-test',
        billing_unit: 'per_request', units: 1, estimated_microusd: 3500000,
      },
    }).action;
    repo.updateAction(db, action.id, { status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS' });
    db.prepare("UPDATE cost_ledger SET status = 'uncertain' WHERE action_id = ?").run(action.id);

    const first = repo.reconcileAmbiguousAction(db, action.id, {
      resolution: 'confirmed_not_created_by_user', retry_authorized: true, retry_reason: '已核对上游任务记录',
    });
    const second = repo.reconcileAmbiguousAction(db, action.id, {
      resolution: 'confirmed_not_created_by_user', retry_authorized: true, retry_reason: '重复点击',
    });
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.deepEqual(repo.getRun(db, run.id).usage, { video_attempts_reserved: 0, video_seconds_reserved: 0 });
    assert.equal(db.prepare('SELECT status FROM cost_ledger WHERE action_id = ?').get(action.id).status, 'uncertain');
    assert.throws(
      () => repo.reconcileAmbiguousAction(db, action.id, { resolution: 'different_conclusion' }),
      (error) => error.code === 'AMBIGUOUS_RESOLUTION_CONFLICT',
    );
  });

  it('persists an unlocked ambiguity recovery card until a retry is explicitly started', () => {
    let run = makeRun({ idempotency_key: 'ambiguous-recovery-summary' });
    run = repo.updateRun(db, run.id, {
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'waiting_review', waiting_reason: 'ambiguous_video_create',
    });
    const action = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:ambiguous:summary', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { model: 'Seedance 2.5-720' }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, action.id, { status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS' });
    assert.equal(repo.getRunSummary(db, run.id).recovery_action.id, action.id);

    repo.reconcileAmbiguousAction(db, action.id, {
      resolution: 'confirmed_not_created_by_user', retry_authorized: true, retry_reason: '已核对上游记录',
    });
    let summary = repo.getRunSummary(db, run.id);
    assert.equal(summary.current_action, null);
    assert.equal(summary.recovery_action.id, action.id);
    assert.equal(summary.recovery_action.status, 'cancelled');

    const started = repo.requestAmbiguousRetryStart(db, action.id, { reason: '用户明确创建' });
    const repeated = repo.requestAmbiguousRetryStart(db, action.id, { reason: '重复点击' });
    assert.equal(started.reused, false);
    assert.equal(repeated.reused, true);
    assert.ok(started.action.result.retry_start_requested_at);
    summary = repo.getRunSummary(db, run.id);
    assert.equal(summary.recovery_action, null);
  });

  it('does not resurrect an old ambiguity card after a newer provider action exists', () => {
    let run = makeRun({ idempotency_key: 'ambiguous-recovery-newer-action' });
    run = repo.updateRun(db, run.id, {
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
    });
    const old = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:old-ambiguous', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', request: {}, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, old.id, { status: 'ambiguous' });
    repo.reconcileAmbiguousAction(db, old.id, {
      resolution: 'confirmed_not_created_by_user', retry_authorized: true, retry_reason: '已核对',
    });
    const newer = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:new-attempt', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', request: {}, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, newer.id, { status: 'waiting', provider_id: 'new-task-id' });
    const summary = repo.getRunSummary(db, run.id);
    assert.equal(summary.current_action.id, newer.id);
    assert.equal(summary.recovery_action, null);
    const started = repo.requestAmbiguousRetryStart(db, old.id);
    assert.equal(started.reused, true);
    assert.equal(started.newer_action.id, newer.id);
  });

  it('returns the latest scoped provider action separately from paginated history', () => {
    const run = makeRun({ idempotency_key: 'current-provider-action' });
    repo.updateRun(db, run.id, {
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
    });
    const first = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:model-a', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { model: 'model-a' }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, first.id, { status: 'failed', error_message: 'model A unavailable' });
    const second = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:model-b', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { model: 'model-b' }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, second.id, { status: 'completed', result: { dispatch_receipt: { dispatched_model: 'model-b' } } });

    const summary = repo.getRunSummary(db, run.id);
    assert.equal(summary.current_action.id, second.id);
    assert.equal(summary.current_action.request.model, 'model-b');
    assert.equal(summary.current_action.status, 'completed');
  });

  it('keeps a superseded provider action in history without presenting it as current', () => {
    const run = makeRun({ idempotency_key: 'superseded-provider-action' });
    repo.updateRun(db, run.id, {
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
    });
    const action = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot:1:old-model', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { model: 'old-model' }, reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, action.id, {
      status: 'cancelled',
      result: { superseded_by_route_change: true, replacement_model: 'new-model' },
    });

    const summary = repo.getRunSummary(db, run.id);
    assert.equal(summary.current_action, null);
    assert.equal(summary.actions.some((item) => item.id === action.id && item.status === 'cancelled'), true);
  });

  it('moves to the next canonical stage only after completion and records manual-next intent', () => {
    const run = makeRun();
    const result = repo.transitionRun(db, run.id, { next_stage_strategy: 'manual_add' });
    assert.equal(result.run.current_stage, 'script');
    assert.equal(result.run.status, 'waiting_review');
    assert.equal(result.run.waiting_reason, 'manual_content_required');
    assert.equal(result.run.next_stage_strategy, 'manual_add');
    assert.throws(() => repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' }), /未处理内容/);
  });
});

describe('bounded fallback budget repository', () => {
  it('reserves idempotently, consumes children within the cap, and releases unused capacity', () => {
    const run = makeRun({
      idempotency_key: 'fallback-budget-idempotent',
      budget: { max_cost_usd: 10 },
    });
    const amount = 9500000;
    const first = repo.reserveFallbackBudget(db, run.id, {
      reservation_key: 'shot:1:seedance-fallback', amount_microusd: amount,
    });
    const duplicate = repo.reserveFallbackBudget(db, run.id, {
      reservation_key: 'shot:1:seedance-fallback', amount_microusd: amount,
    });
    assert.equal(first.reused, false);
    assert.equal(duplicate.reused, true);
    assert.equal(duplicate.reservation.amount_microusd, amount);
    assert.equal(repo.getRun(db, run.id).runtime.fallback_reserved_microusd, amount);
    assert.equal(repo.consumeFallbackBudget(db, run.id, 'shot:1:seedance-fallback', 3000000).remaining_microusd, 6500000);
    assert.throws(
      () => repo.consumeFallbackBudget(db, run.id, 'shot:1:seedance-fallback', 7000000),
      (error) => error.code === 'COST_FALLBACK_SEGMENT_BUDGET_EXHAUSTED',
    );
    const released = repo.releaseFallbackBudget(db, run.id, 'shot:1:seedance-fallback', 'test_converged');
    assert.equal(released.released_microusd, 6500000);
    assert.equal(repo.getRun(db, run.id).runtime.fallback_reserved_microusd, 0);
    assert.equal(repo.releaseFallbackBudget(db, run.id, 'shot:1:seedance-fallback').released_microusd, 0);
  });

  it('does not reserve a fallback chain when its worst case exceeds the run cap', () => {
    const run = makeRun({
      idempotency_key: 'fallback-budget-exhausted',
      budget: { max_cost_usd: 9 },
    });
    assert.throws(
      () => repo.reserveFallbackBudget(db, run.id, {
        reservation_key: 'shot:1:seedance-fallback', amount_microusd: 9500000,
      }),
      (error) => error.code === 'COST_FALLBACK_BUDGET_EXHAUSTED',
    );
    assert.equal(repo.getRun(db, run.id).runtime.fallback_reserved_microusd, undefined);
    assert.equal(repo.listActions(db, run.id).items.length, 0);
  });
});
