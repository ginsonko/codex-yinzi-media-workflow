const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const { createProductionService } = require('../src/services/productionService');
const { createProductionMediaService } = require('../src/services/productionMediaService');
const automationPreferences = require('../src/services/productionAutomationPreferences');
const aiConfigService = require('../src/services/aiConfigService');
const director = require('../src/services/productionDirector');

let db;
const log = { info() {}, warn() {}, error() {} };
const healthyShortCapability = {
  provider_contract: 'aizzz-video-v1',
  duration_mode: 'free', duration_min: 5, duration_max: 15,
  auto_duration_min: 5, auto_duration_max: 15,
  max_images: 9, max_videos: 0, max_audios: 3, max_total_references: 12,
  resolution: '480p', quality_tier: 'fast', automatic_eligible: true,
  route_profiles: ['short_image_guided'],
  roles: { image: ['reference'], video: [], audio: ['reference'] },
};

function migrateQuietly() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
}

function createRun(reviewOwner = 'human') {
  return repo.createRun(db, {
    drama_id: 1,
    episode_id: 1,
    idempotency_key: `run-${reviewOwner}`,
    review_owner: reviewOwner,
    input: { story: '宇航员林夏在星尘花园寻找一颗会发光的种子。' },
    policy: { target_shots: 3, style: '电影感科幻写实' },
    budget: { max_video_attempts: 10, max_video_seconds: 60, max_shots: 5 },
  }).run;
}

function scriptedAdapter(responses, calls) {
  return async (user, system, options) => {
    calls.push({ user, system, options });
    if (!responses.length) throw new Error('unexpected AI call');
    return responses.shift();
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  migrateQuietly();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at) VALUES (1, ?, ?, ?)').run('星尘花园', now, now);
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
});

afterEach(() => db.close());

describe('production executor text stages', () => {
  it('uses one bounded non-stream JSON request for storyboard planning', async () => {
    let run = createRun('auto_accept');
    run = repo.updateRun(db, run.id, {
      current_stage: 'storyboard_plan',
      status: 'running',
      next_stage_strategy: 'auto_generate',
      policy: {
        ...run.policy,
        template_id: 'image-to-video',
        target_shots: 1,
        video_duration_min: 5,
        video_duration_max: 30,
        video_model: 'seedance-2.5-720p',
      },
    });
    repo.createArtifact(db, {
      run_id: run.id, stage: 'script', scope_type: 'run', scope_id: '', title: '猫娘短片',
      content: { text: '用户上传的猫娘在花园中起舞。', included: true }, status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'character', scope_id: 'character-1', title: '猫娘',
      content: {
        name: '猫娘', description: '棕色长发、猫耳和猫尾', visual_prompt: '同一主体四视图',
        source_artifact_id: 182, authority: 'uploaded_asset', must_preserve_identity: true, included: true,
      }, status: 'approved',
    });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: async (user, system, options) => {
        calls.push({ user, system, options });
        return JSON.stringify({ shots: [{
          number: 1, title: '猫娘起舞', duration: 8, creative_duration_seconds: 8,
          provider_duration_seconds: 30, final_edit_duration_seconds: 8,
          action: '猫娘抬手起舞', visual: '花园中景', dialogue: '', narration: '',
          shot_type: 'medium', camera_angle: 'eye-level', camera_movement: 'slow push-in',
          lighting: '柔和日光', continuity_in: 'opening', continuity_out: '动作完成',
          transition_mode: 'opening', cut_motivation: 'opening', cut_in: '开场', cut_out: '动作完成',
          continuous_take_id: 'take-1', boundary_prompt: '开场', character_names: ['猫娘'],
          scene_name: '', prop_names: [], image_prompt: '猫娘在花园中起舞',
          video_prompt: '猫娘在花园中完成一段完整舞蹈动作', route_profile: 'long_previs_guided',
          previs_mode: 'skip', duration_plan: { creative_seconds: 8, provider_seconds: 30, final_edit_seconds: 8 },
        }] });
      },
    });
    const result = await service.advance(run.id, { lease_owner: 'storyboard-non-stream-test' });
    assert.equal(result.state, 'approved');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.stream, false);
    assert.equal(calls[0].options.timeout_ms, 180000);
    const action = repo.getLatestAction(db, run.id, {
      stage: 'storyboard_plan', scope_type: 'collection', scope_id: '',
    });
    assert.equal(action.request.stream, false);
    assert.equal(action.request.timeout_ms, 180000);
  });

  it('preflights the run-selected video URL and Key instead of the global default', () => {
    const defaultConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Old default video',
      base_url: 'https://old.example/v1', api_key: 'old-key', model: ['old-video'],
      default_model: 'old-video', is_default: true,
    });
    const selectedConfig = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Selected video',
      base_url: 'https://selected.example/v1', api_key: 'selected-key', model: ['selected-video'],
      default_model: 'selected-video', is_default: false,
    });
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, video_config_id: selectedConfig.id, video_model: '', video_routing_mode: 'auto' },
    });
    const service = createProductionService(db, {}, log, {});
    const preflight = service.preflight(run.id, { browser: { webgl: true, media_recorder: true } });
    const videoCheck = preflight.checks.find((item) => item.key === 'video_model');
    assert.equal(defaultConfig.is_default, true);
    assert.equal(videoCheck.ok, true);
    assert.match(String(videoCheck.detail), /selected-video/);
    assert.doesNotMatch(String(videoCheck.detail), /old-video/);
  });

  it('keeps an unregistered fixed video model advisory instead of blocking preflight', () => {
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Opaque upstream video',
      base_url: 'https://selected.example/v1', api_key: 'selected-key', model: ['seedance-2.5-720p-nv'],
      default_model: 'seedance-2.5-720p-nv', is_default: true,
    });
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_config_id: config.id,
        video_routing_mode: 'fixed',
        video_model: 'seedance-2.5-720p-nv',
      },
    });
    const service = createProductionService(db, {}, log, {});
    const preflight = service.preflight(run.id, { browser: { webgl: true, media_recorder: true } });
    const contractCheck = preflight.checks.find((item) => item.key === 'provider_contract');
    assert.equal(contractCheck.ok, true);
    assert.equal(contractCheck.blocking, false);
    assert.equal(contractCheck.advisory, true);
    assert.match(contractCheck.detail, /仍可提交/);
    assert.equal(preflight.issues.some((item) => item.key === 'provider_contract'), false);
  });

  it('defers strict first-frame capability selection to automatic routing', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, video_routing_mode: 'auto', video_model: '' },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '2',
      title: '严格续拍镜头',
      content: {
        included: true,
        number: 2,
        duration: 5,
        route_profile: 'short_image_guided',
        transition_mode: 'strict_continuation',
        continuous_take_id: 'take-1',
        cut_in: '沿用上一镜最终画面',
        cut_out: '角色完成抬手动作',
        boundary_prompt: '第一帧严格使用上一镜末帧',
        action: '角色继续抬手',
        visual: '同一机位近景',
        video_prompt: '从上一镜末帧继续动作',
      },
    });
    const service = createProductionService(db, {}, log, {});
    const approved = await service.reviewArtifact(shot.id, {
      reviewer_type: 'human', decision: 'approved', reason: '用户确认严格续拍',
    });
    assert.equal(approved.artifact.status, 'approved');
  });

  it('generates a screenplay once and waits for human review without mutating approval', async () => {
    const run = createRun('human');
    repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([
        '# 星尘花园\n\n## 人物\n林夏：年轻宇航员。\n\n## 第一场\n林夏走进温室，发现星尘像雪一样漂浮。她伸手接住一颗发光种子，却听见远处传来低沉警报。她必须在氧气耗尽前把种子带回基地。',
      ], calls),
    });
    const first = await service.advance(run.id, { lease_owner: 'test' });
    assert.equal(first.state, 'waiting_review');
    const script = repo.listArtifacts(db, run.id, { stage: 'script', current: true }).items[0];
    assert.equal(script.status, 'draft');
    assert.match(script.content.text, /低沉警报/);
    assert.equal(calls[0].options.silence_timeout_ms, 180000);
    const second = await service.advance(run.id, { lease_owner: 'test' });
    assert.equal(second.state, 'waiting_review');
    assert.equal(calls.length, 1);
  });

  it('uses straight-through review on valid text while preserving deterministic gates', async () => {
    const run = createRun('auto_accept');
    repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([
        '# 星尘花园\n\n## 人物\n林夏：宇航员。\n\n## 第一场\n警报响起，林夏穿过透明温室。她在漂浮的花粉中找到发光种子，并把它装进密封容器。温室灯光由红转绿，基地重新获得能源。',
        JSON.stringify({
          characters: [{ name: '林夏', role: '主角', description: '年轻宇航员', appearance: '银白宇航服，短黑发', identity_anchors: ['短黑发', '左眉小痣'], visual_prompt: '林夏角色四视图' }],
          scenes: [{ name: '星尘温室', location: '月面基地温室', time: '夜', description: '透明穹顶与漂浮花粉', spatial_anchors: ['中央培养台'], visual_prompt: '星尘温室四视图' }],
          props: [{ name: '发光种子', category: '关键道具', description: '蓝白发光晶体种子', visual_prompt: '发光种子产品图' }],
        }),
      ], calls),
    });

    assert.equal((await service.advance(run.id, { lease_owner: 'a' })).state, 'approved');
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', current: true }).items[0].status, 'approved');
    assert.equal((await service.advance(run.id, { lease_owner: 'a' })).state, 'progressed');
    assert.equal(repo.getRun(db, run.id).current_stage, 'asset_text');
    assert.equal((await service.advance(run.id, { lease_owner: 'a' })).state, 'approved');
    const assets = repo.listArtifacts(db, run.id, { stage: 'asset_text', current: true }).items;
    assert.equal(assets.length, 3);
    assert.equal(assets.every((item) => item.status === 'approved'), true);
    assert.equal(calls.length, 2);
  });

  it('approves low-confidence work when the AI found no blocking issue', async () => {
    const run = createRun('ai');
    repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([
        '# 星尘花园\n\n## 人物\n林夏：宇航员。\n\n## 第一场\n林夏进入月面温室寻找种子。警报倒计时开始，她穿过漂浮花粉，找到发光种子并放入容器，最终恢复基地能源供应。',
        JSON.stringify({
          decision: 'needs_human', reason: '审美仍有不确定性', confidence: 0.2,
          severity: 'minor', blocking_issues: [], improvement_notes: ['对白还可以更精炼'],
          requires_human_authority: false, scores: { clarity: 60 },
        }),
      ], calls),
    });
    const result = await service.advance(run.id, { lease_owner: 'review-test' });
    assert.equal(result.state, 'approved');
    assert.equal(repo.getRun(db, run.id).status, 'running');
    const script = repo.listArtifacts(db, run.id, { stage: 'script', current: true }).items[0];
    assert.equal(script.status, 'approved');
    assert.equal(script.revision, 1);
    assert.equal(repo.getRun(db, run.id).runtime.autonomy.objects['script:run:'], undefined);
    assert.equal(calls.length, 2);
  });

  it('escalates only after the same AI-reviewed object reaches its configured consecutive limit', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, { budget: { ...run.budget, max_text_revisions: 2 } });
    repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([
        '# 星尘花园\n\n第一场：月面基地警报响起，林夏穿过透明温室，在漂浮花粉和失灵机械臂之间寻找最后一颗发光种子。她听见氧气倒计时，却缺少明确路线，只能沿中央培养台继续前进。远处舱门开始关闭，她必须在基地能源耗尽前做出选择。',
        JSON.stringify({
          decision: 'rejected', reason: '动作链不够明确', confidence: 0.9,
          severity: 'major', blocking_issues: ['缺少绕过机械臂的可执行动作'],
          requires_human_authority: false, scores: { clarity: 40 },
        }),
        JSON.stringify({ text: '第一场：林夏沿中央平台寻找发光种子。警报持续倒计时，失灵机械臂封住两侧通道，她尝试从平台下方绕行，却仍没有明确解决机械臂的方法。舱门正在关闭，她必须尽快把种子送进密封容器并恢复基地供能。', title: '星尘花园', required_fields: ['text'] }),
        JSON.stringify({
          decision: 'rejected', reason: '仍然缺少可执行阻力', confidence: 0.95,
          severity: 'major', blocking_issues: ['没有说明如何解决机械臂封锁'],
          requires_human_authority: false, scores: { clarity: 35 },
        }),
      ], calls),
    });

    assert.equal((await service.advance(run.id, { lease_owner: 'limit-test' })).state, 'progressed');
    const stopped = await service.advance(run.id, { lease_owner: 'limit-test' });
    assert.equal(stopped.state, 'waiting_review');
    assert.equal(stopped.reason, 'automation_limit_reached');
    const saved = repo.getRun(db, run.id);
    assert.equal(saved.runtime.autonomy.intervention.object_key, 'script:run:');
    assert.equal(saved.runtime.autonomy.objects['script:run:'].consecutive_review_failures, 2);
    assert.equal(calls.length, 4);

    const blockedScript = repo.listArtifacts(db, run.id, { stage: 'script', current: true }).items[0];
    repo.updateRun(db, run.id, { review_owner: 'human' });
    await service.reviewArtifact(blockedScript.id, {
      reviewer_type: 'human', decision: 'approved', reason: '人工检查后确认当前修订可用',
    });
    const resolved = repo.getRun(db, run.id);
    assert.equal(resolved.runtime.autonomy.intervention, undefined);
    assert.equal(resolved.runtime.autonomy.objects['script:run:'], undefined);
    assert.equal(resolved.status, 'running');
  });

  it('stops immediately only when the review truly requires human authority', async () => {
    const run = createRun('ai');
    repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([
        '# 星尘花园\n\n## 人物\n林夏：年轻宇航员，负责月面温室的能源维护。\n\n## 第一场\n林夏进入透明穹顶温室，沿中央培养台避开失灵机械臂，找到最后一颗发光种子。她把种子放入密封能源舱，警报解除，穹顶灯光由红转绿。制作方随后要求启动超出当前金额上限的额外高价渲染流程。',
        JSON.stringify({
          decision: 'needs_human', reason: '需要用户授权提高任务金额上限', confidence: 0.98,
          severity: 'critical', blocking_issues: ['当前金额上限不足'],
          improvement_notes: [], requires_human_authority: true, scores: { clarity: 95 },
        }),
      ], calls),
    });

    const stopped = await service.advance(run.id, { lease_owner: 'authority-test' });
    assert.equal(stopped.state, 'waiting_review');
    assert.equal(stopped.reason, 'human_authority_required');
    const saved = repo.getRun(db, run.id);
    assert.equal(saved.runtime.autonomy.intervention.reason, 'human_authority_required');
    assert.match(saved.runtime.autonomy.intervention.summary.reason, /授权提高任务金额上限/);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', current: true }).items[0].revision, 1);
    assert.equal(calls.length, 2);
  });

  it('clears a legacy source-change intervention instead of surfacing a stale 3/3 gate', async () => {
    const run = createRun('auto_accept');
    repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' });
    const key = 'script:run:';
    const runtime = {
      ...(run.runtime || {}),
      autonomy: {
        objects: {
          [key]: {
            stage: 'script', scope_type: 'run', scope_id: '',
            consecutive_generation_failures: 3, escalated: true,
            attempts: [
              { error_code: 'SOURCE_CHANGED_WHILE_ACTION_ACTIVE', reason: 'source_changed_while_action_active' },
              { error_code: 'SOURCE_CHANGED_WHILE_ACTION_ACTIVE', reason: 'source_changed_while_action_active' },
              { error_code: 'SOURCE_CHANGED_WHILE_ACTION_ACTIVE', reason: 'source_changed_while_action_active' },
            ],
          },
        },
        intervention: {
          object_key: key, stage: 'script', scope_type: 'run', scope_id: '',
          reason: 'automation_limit_reached', summary: { reason: '同一对象已连续达到自动处理上限' },
        },
      },
    };
    repo.updateRun(db, run.id, {
      runtime,
      status: 'waiting_review', waiting_reason: 'automation_limit_reached',
      error_code: 'AUTOMATION_LIMIT_REACHED', error_message: '同一对象已连续达到自动处理上限',
    });
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([
        '# 自愈测试\n\n## 人物\n林夏：负责月面温室能源维护的宇航员，冷静、谨慎，始终携带一枚密封能源容器。\n\n## 场景\n月面基地温室：透明穹顶、中央培养台、红色警报灯和一扇通往基地的气密门。\n\n## 第一场\n红色警报灯亮起，林夏进入温室，沿中央培养台寻找最后一颗发光种子。她避开失灵的机械臂，把种子放入密封能源容器，再返回气密门。警报灯由红转绿，基地恢复供能。',
      ], []),
    });
    const result = await service.advance(run.id, { lease_owner: 'legacy-gate-test' });
    assert.notEqual(result.reason, 'automation_limit_reached');
    const saved = repo.getRun(db, run.id);
    assert.equal(saved.runtime.autonomy.intervention, undefined);
    assert.equal(saved.runtime.autonomy.objects[key], undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM production_events WHERE run_id = ? AND event_type = 'automation.legacy_convergence_intervention_cleared'").get(run.id).n, 1);
  });

  it('keeps a pending stage handler in scheduler wait without accumulating automatic failures', async () => {
    let run = createRun('auto_accept');
    const objectKey = 'reference_bundle:shot:1';
    run = repo.updateRun(db, run.id, {
      current_stage: 'reference_bundle',
      current_scope_type: 'shot',
      current_scope_id: '1',
      status: 'running',
      waiting_reason: null,
      error_code: 'STAGE_HANDLER_PENDING',
      error_message: 'stage_handler_pending',
      runtime: {
        ...(run.runtime || {}),
        autonomy: {
          objects: {
            [objectKey]: {
              stage: 'reference_bundle', scope_type: 'shot', scope_id: '1',
              consecutive_generation_failures: 2,
              last_failure: { error_code: 'STAGE_HANDLER_PENDING', reason: 'stage_handler_pending' },
            },
          },
        },
      },
    });
    const service = createProductionService(db, {}, log, {});

    const first = await service.advance(run.id, { lease_owner: 'pending-stage-test' });
    assert.equal(first.state, 'waiting_task', JSON.stringify({
      state: first.state,
      reason: first.reason,
      intervention: first.intervention || null,
      run_status: first.run?.status || null,
      waiting_reason: first.run?.waiting_reason || null,
    }));
    assert.equal(first.reason, 'stage_handler_pending');
    let saved = repo.getRun(db, run.id);
    assert.equal(saved.status, 'running');
    assert.equal(saved.waiting_reason, null);
    assert.equal(saved.error_code, null);
    assert.equal(saved.error_message, null);
    assert.equal(saved.runtime.autonomy.objects[objectKey], undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM production_events WHERE run_id = ? AND event_type = 'automation.wait_state_cleared'").get(run.id).n, 1);

    const second = await service.advance(run.id, { lease_owner: 'pending-stage-test' });
    assert.equal(second.state, 'waiting_task');
    saved = repo.getRun(db, run.id);
    assert.equal(saved.runtime.autonomy.objects[objectKey], undefined);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM production_events WHERE run_id = ? AND event_type = 'automation.wait_state_cleared'").get(run.id).n, 1);
  });

  it('rewrites an AI-rejected text artifact once and reviews the new revision', async () => {
    const run = createRun('ai');
    repo.transitionRun(db, run.id, { next_stage_strategy: 'auto_generate' });
    const calls = [];
    const revisedText = '第一场：林夏进入月面温室，确认氧气倒计时。她沿着中央培养台找到发光种子，放入密封舱，恢复基地供能。';
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([
        '# 星尘花园\n\n第一场：月面基地警报响起，林夏穿过透明温室，在漂浮花粉和失灵机械臂之间寻找最后一颗发光种子。她听见氧气倒计时，却缺少明确路线，只能沿中央培养台继续前进。远处舱门开始关闭，她必须在基地能源耗尽前做出选择。',
        JSON.stringify({ decision: 'rejected', reason: '缺少明确阻力和可执行动作', confidence: 0.92, scores: { clarity: 45 } }),
        JSON.stringify({ text: revisedText, title: '星尘花园', required_fields: ['text'] }),
        JSON.stringify({ decision: 'approved', reason: '动作与阻力明确', confidence: 0.91, scores: { clarity: 90 } }),
      ], calls),
    });

    const revised = await service.advance(run.id, { lease_owner: 'rewrite-test' });
    assert.equal(revised.state, 'progressed');
    let script = repo.listArtifacts(db, run.id, { stage: 'script', current: true }).items[0];
    assert.equal(script.revision, 2);
    assert.equal(script.status, 'draft');
    assert.equal(script.content.text, revisedText);
    const approved = await service.advance(run.id, { lease_owner: 'rewrite-test' });
    assert.equal(approved.state, 'progressed');
    assert.equal(repo.getRun(db, run.id).current_stage, 'asset_text');
    script = repo.listArtifacts(db, run.id, { stage: 'script', current: true }).items[0];
    assert.equal(script.status, 'approved');
    assert.equal(repo.listActions(db, run.id, { page_size: 200 }).items.filter((item) => item.kind === 'ai_rewrite').length, 1);
    assert.equal(calls.length, 4);
  });

  it('routes image and video reviews through vision and persists their evidence receipts', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_images',
      status: 'running',
      review_profile: { model: 'vision-review-model', version: 'vision-v1' },
    });
    const image = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_images',
      scope_type: 'character',
      scope_id: 'character-vision',
      title: '林夏角色设定图',
      content: { included: true },
      status: 'draft',
      media_path: 'images/linxia.png',
      mime_type: 'image/png',
      content_hash: 'image-hash',
    });
    const video = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: 'shot-vision',
      title: '镜头首中尾检查',
      content: { included: true, validation: { duration: 5 } },
      status: 'draft',
      media_path: 'videos/shot.mp4',
      mime_type: 'video/mp4',
      content_hash: 'video-hash',
    });
    const visualCalls = [];
    const cleaned = [];
    const service = createProductionService(db, {}, log, {
      validateImage: async () => ({ relative_path: 'images/linxia.png', width: 1536, height: 1024, nonblank: true }),
      validateVideo: async () => ({ relative_path: 'videos/shot.mp4', duration: 5, video_codec: 'h264', audio_codec: 'aac' }),
      prepareReviewEvidence: async (artifact) => ({
        imageSource: { localAbsPath: artifact.stage === 'asset_images' ? 'C:\\review\\image.png' : 'C:\\review\\sheet.jpg' },
        receipt: artifact.stage === 'asset_images'
          ? { kind: 'source_image', media_sha256: 'image-hash', relative_path: 'images/linxia.png' }
          : { kind: 'video_first_middle_last_sheet', media_sha256: 'video-hash', relative_path: 'videos/shot.mp4', sampled_at_seconds: [0.4, 2.5, 4.6] },
        cleanup: () => cleaned.push(artifact.id),
      }),
      generateTextWithVision: async (user, system, imageSource, options) => {
        visualCalls.push({ user, system, imageSource, options });
        return JSON.stringify({ decision: 'approved', reason: '画面符合当前对象约束', confidence: 0.94, scores: { clarity: 92, continuity: 91 } });
      },
    });

    assert.equal((await service.applyReviewPolicy(run, [image])).state, 'approved');
    assert.equal((await service.applyReviewPolicy(repo.getRun(db, run.id), [video])).state, 'approved');
    assert.equal(visualCalls.length, 2);
    assert.match(visualCalls[0].user, /当前待审原图/);
    assert.match(visualCalls[1].user, /首段、中段、尾段/);
    assert.equal(visualCalls.every((call) => call.options.model === 'vision-review-model'), true);
    assert.deepEqual(cleaned, [image.id, video.id]);
    const imageAction = repo.getLatestAction(db, run.id, {
      stage: 'asset_images', scope_type: 'character', scope_id: 'character-vision', kind: 'ai_review',
    });
    const videoAction = repo.getLatestAction(db, run.id, {
      stage: 'shot_video', scope_type: 'shot', scope_id: 'shot-vision', kind: 'ai_review',
    });
    assert.equal(imageAction.result.visual_evidence.kind, 'source_image');
    assert.deepEqual(videoAction.result.visual_evidence.sampled_at_seconds, [0.4, 2.5, 4.6]);
  });

  it('revises director JSON before recording a rejected previs again', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'director_preview', current_scope_type: 'shot', current_scope_id: '1',
      status: 'running', review_profile: { model: 'vision-review-model', version: 'director-review-v1' },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', title: '镜头一',
      content: { number: 1, duration: 6, scene_name: '月面温室', character_names: ['林夏'], prop_names: [], included: true },
      status: 'approved',
    });
    const originalDocument = director.createFallbackDirectorDocument(shot.content, '16:9');
    const plan = repo.createArtifact(db, {
      run_id: run.id, stage: 'director_plan', scope_type: 'shot', scope_id: '1', title: '镜头一导演方案',
      content: { source_artifact_id: shot.id, source_revision: shot.revision, document: originalDocument, included: true },
      status: 'approved', depends_on: [shot.id],
    });
    const preview = repo.createArtifact(db, {
      run_id: run.id, stage: 'director_preview', scope_type: 'shot', scope_id: '1', title: '镜头一预演',
      content: { source_artifact_id: plan.id, expected_duration: 6, included: true },
      status: 'draft', media_path: 'director/shot-1.webm', mime_type: 'video/webm', depends_on: [plan.id],
    });
    const revisedDocument = structuredClone(originalDocument);
    revisedDocument.objects.find((item) => item.id === 'camera-1').position = [4.2, 2.7, 6.1];
    revisedDocument.timeline.keyframes.find((item) => item.object_id === 'camera-1').position = [4.2, 2.7, 6.1];
    const textCalls = [];
    const service = createProductionService(db, {}, log, {
      validateVideo: async () => ({ relative_path: preview.media_path, duration: 6, video_codec: 'vp9' }),
      prepareReviewEvidence: async () => ({
        imageSource: { localAbsPath: 'C:\\review\\director-sheet.jpg' },
        receipt: { kind: 'video_first_middle_last_sheet', media_sha256: 'preview-hash', sampled_at_seconds: [0.5, 3, 5.5] },
        cleanup() {},
      }),
      generateTextWithVision: async () => JSON.stringify({
        decision: 'rejected', reason: '人物在中段走出画面，结尾构图丢失主体', confidence: 0.96,
        severity: 'major', blocking_issues: ['调整摄像机跟随关键帧，确保人物全程留在安全框内'],
        improvement_notes: ['结尾可略微推近'], requires_human_authority: false,
        scores: { continuity: 35, production_ready: 40 },
      }),
      generateText: async (user, system, options) => {
        textCalls.push({ user, system, options });
        return JSON.stringify({ ...plan.content, document: revisedDocument });
      },
    });

    const result = await service.applyReviewPolicy(run, [preview]);
    assert.equal(result.state, 'progressed');
    assert.equal(result.reason, 'director_plan_revised_from_preview');
    const latestPlan = repo.listArtifacts(db, run.id, {
      stage: 'director_plan', scope_type: 'shot', scope_id: '1', current: true,
    }).items[0];
    assert.equal(latestPlan.revision, 2);
    assert.equal(latestPlan.status, 'draft');
    assert.equal(latestPlan.content.revision_source_preview_id, preview.id);
    assert.equal(latestPlan.content.document.objects.find((item) => item.id === 'camera-1').position[0], 4.2);
    assert.match(textCalls[0].user, /必须先修改导演台 JSON/);
    assert.match(textCalls[0].user, /人物在中段走出画面/);
    assert.equal(repo.listActions(db, run.id, { page_size: 50 }).items
      .filter((item) => item.stage === 'director_preview' && item.kind === 'client_capture').length, 0);
    assert.equal(repo.getRun(db, run.id).current_stage, 'director_plan');
  });

  it('bounds independent asset reviews and persists actions and decisions in source order', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_text', status: 'running',
      review_profile: { model: 'review-model', version: 'review-v2' },
    });
    automationPreferences.set(db, { review_concurrency: 2 });
    const assets = Array.from({ length: 5 }, (_, index) => repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_text',
      scope_type: 'character',
      scope_id: `asset-${index + 1}`,
      title: `Asset ${index + 1}`,
      content: { included: true, description: `Character ${index + 1}` },
      status: 'draft',
    }));
    let active = 0;
    let maximum = 0;
    const completed = [];
    const service = createProductionService(db, {}, log, {
      generateText: async (user) => {
        const number = Number(user.match(/Asset (\d+)/)?.[1] || 0);
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, number % 2 ? 24 : 4));
        completed.push(number);
        active -= 1;
        return JSON.stringify({
          decision: 'approved', reason: `Asset ${number} can proceed`, confidence: 0.9,
          severity: 'minor', blocking_issues: [], improvement_notes: [],
          requires_human_authority: false, scores: { production_ready: 90 },
        });
      },
    });

    const result = await service.applyReviewPolicy(run, assets);
    assert.equal(result.state, 'approved');
    assert.equal(maximum, 2);
    assert.notDeepEqual(completed, [1, 2, 3, 4, 5]);
    const actions = repo.listActions(db, run.id, { page_size: 50 }).items
      .filter((item) => item.kind === 'ai_review' && item.stage === 'asset_text')
      .sort((left, right) => left.id - right.id);
    assert.deepEqual(actions.map((item) => item.request.artifact_id), assets.map((item) => item.id));
    const assetIds = new Set(assets.map((item) => item.id));
    const reviews = repo.listReviews(db, run.id, { page_size: 50 }).items
      .filter((item) => assetIds.has(item.artifact_id))
      .sort((left, right) => left.id - right.id);
    assert.deepEqual(reviews.map((item) => item.artifact_id), assets.map((item) => item.id));
    assert.equal(assets.every((item) => repo.getArtifact(db, item.id).status === 'approved'), true);
  });

  it('keeps successful asset reviews when one evidence preparation fails', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_images', status: 'running',
      review_profile: { model: 'vision-review-model', version: 'review-v2' },
    });
    automationPreferences.set(db, { review_concurrency: 3 });
    const assets = Array.from({ length: 3 }, (_, index) => repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_images',
      scope_type: 'character',
      scope_id: `image-${index + 1}`,
      title: `Image ${index + 1}`,
      content: { included: true },
      status: 'draft',
      media_path: `images/image-${index + 1}.png`,
      mime_type: 'image/png',
      content_hash: `hash-${index + 1}`,
    }));
    const reviewed = [];
    const cleaned = [];
    const service = createProductionService(db, {}, log, {
      validateImage: async () => ({ width: 1024, height: 1024, nonblank: true }),
      prepareReviewEvidence: async (artifact) => {
        if (artifact.id === assets[1].id) {
          const error = new Error('temporary evidence extraction failure');
          error.code = 'REVIEW_EVIDENCE_FAILED';
          throw error;
        }
        return {
          imageSource: { localAbsPath: `C:\\review\\${artifact.id}.png` },
          receipt: { kind: 'source_image', media_sha256: artifact.content_hash, relative_path: artifact.media_path },
          cleanup: () => cleaned.push(artifact.id),
        };
      },
      generateTextWithVision: async (user) => {
        const number = Number(user.match(/Image (\d+)/)?.[1] || 0);
        reviewed.push(number);
        return JSON.stringify({
          decision: 'approved', reason: 'visual asset can proceed', confidence: 0.92,
          severity: 'minor', blocking_issues: [], improvement_notes: [],
          requires_human_authority: false, scores: { production_ready: 92 },
        });
      },
      generateText: async (_user, _system, options) => {
        assert.equal(options.scene_key, 'production_automation_diagnosis');
        return JSON.stringify({
          action: 'retry_same_model', root_cause: 'temporary local evidence extraction failure',
          correction: 'retry evidence extraction for this asset', model_requirements: '',
        });
      },
    });

    const result = await service.applyReviewPolicy(run, assets);
    assert.equal(result.state, 'progressed');
    assert.deepEqual(reviewed.sort(), [1, 3]);
    assert.deepEqual(cleaned.sort((a, b) => a - b), [assets[0].id, assets[2].id]);
    assert.equal(repo.getArtifact(db, assets[0].id).status, 'approved');
    assert.equal(repo.getArtifact(db, assets[1].id).status, 'draft');
    assert.equal(repo.getArtifact(db, assets[2].id).status, 'approved');
    const actions = repo.listActions(db, run.id, { page_size: 50 }).items;
    assert.equal(actions.filter((item) => item.kind === 'ai_review' && item.status === 'completed').length, 2);
  });

  it('regenerates every independently rejected asset image and carries each AI reason forward', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_images', status: 'running',
      policy: { ...run.policy, image_concurrency: 2 },
      review_profile: { model: 'vision-review-model', version: 'review-v3' },
    });
    automationPreferences.set(db, { review_concurrency: 2 });
    const definitions = [
      {
        scope_type: 'prop', scope_id: 'prop-1', title: '银白长剑',
        content: { name: '银白长剑', description: '同一柄银白长剑与剑鞘', visual_prompt: '同一件道具四视图', included: true },
        reason: '画面是双人战斗剧情，不是同一柄长剑的正面、侧面、背面、细节四视图',
        issue: '必须移除人物、血迹和剧情动作，只展示同一件道具的四个角度',
      },
      {
        scope_type: 'scene', scope_id: 'scene-1', title: '断崖古台',
        content: { name: '断崖古台', description: '夜晚断崖石台', visual_prompt: '同一地点空间四视图', included: true },
        reason: '当前只有单张场景图，缺少同一地点的四个空间视角',
        issue: '必须生成全景、主方向、反方向和关键区域，空间锚点保持一致',
      },
    ];
    const images = definitions.map((definition) => {
      const source = repo.createArtifact(db, {
        run_id: run.id, stage: 'asset_text', scope_type: definition.scope_type, scope_id: definition.scope_id,
        title: definition.title, content: definition.content, status: 'approved',
      });
      return repo.createArtifact(db, {
        run_id: run.id, stage: 'asset_images', scope_type: definition.scope_type, scope_id: definition.scope_id,
        title: definition.title, content: { source_artifact_id: source.id, included: true }, status: 'draft',
        media_path: `images/${definition.scope_id}.png`, mime_type: 'image/png', depends_on: [source.id],
      });
    });
    const imageRequests = [];
    const service = createProductionService(db, {}, log, {
      validateImage: async (mediaPath) => ({
        relative_path: mediaPath, width: 1536, height: 1024, format: 'png', nonblank: true,
      }),
      prepareReviewEvidence: async (artifact) => ({
        imageSource: { localAbsPath: `C:\\review\\${artifact.id}.png` },
        receipt: { kind: 'source_image', media_sha256: `hash-${artifact.id}`, relative_path: artifact.media_path },
        cleanup() {},
      }),
      generateTextWithVision: async (user) => {
        const definition = definitions.find((item) => user.includes(item.title));
        return JSON.stringify({
          decision: 'rejected', reason: definition.reason, confidence: 0.96, severity: 'major',
          blocking_issues: [definition.issue], improvement_notes: ['保持未被批评的材质与夜景风格'],
          requires_human_authority: false, scores: { production_ready: 35 },
        });
      },
      media: {
        createImage: async (request) => {
          imageRequests.push(request);
          return { id: 700 + imageRequests.length, task_id: `retry-image-${imageRequests.length}` };
        },
      },
    });

    const result = await service.applyReviewPolicy(run, images);
    assert.equal(result.state, 'waiting_task');
    assert.equal(imageRequests.length, 2);
    for (const definition of definitions) {
      const request = imageRequests.find((item) => item.prompt.includes(definition.title));
      assert.ok(request, `missing retry request for ${definition.title}`);
      assert.match(request.prompt, new RegExp(definition.reason.slice(0, 12)));
      assert.match(request.prompt, new RegExp(definition.issue.slice(0, 12)));
      const review = repo.listReviews(db, run.id, {
        stage: 'asset_images', scope_type: definition.scope_type, scope_id: definition.scope_id, page_size: 1,
      }).items[0];
      assert.deepEqual(review.evidence.review_verdict.blocking_issues, [definition.issue]);
    }
    const retryActions = repo.listActions(db, run.id, { page_size: 100 }).items
      .filter((item) => item.kind === 'image_generate' && item.status === 'waiting');
    assert.equal(retryActions.length, 2);
  });

  it('keeps a rejected asset regenerating when another parallel AI review times out', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_images', status: 'running',
      policy: { ...run.policy, image_concurrency: 2 },
      review_profile: { model: 'vision-review-model', version: 'parallel-failure-v1' },
    });
    automationPreferences.set(db, { review_concurrency: 2 });
    const sources = ['timeout', 'rejected'].map((scopeId, index) => repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'prop', scope_id: scopeId,
      title: index === 0 ? '超时道具' : '待返工道具',
      content: {
        name: index === 0 ? '超时道具' : '待返工道具', description: '同一件关键道具',
        visual_prompt: '同一件道具四角度设定板', included: true,
      },
      status: 'approved',
    }));
    const images = sources.map((source) => repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: source.scope_type, scope_id: source.scope_id,
      title: source.title, content: { source_artifact_id: source.id, included: true },
      status: 'draft', media_path: `images/${source.scope_id}.png`, mime_type: 'image/png', depends_on: [source.id],
    }));
    const imageRequests = [];
    const diagnosisCalls = [];
    const service = createProductionService(db, {}, log, {
      validateImage: async (mediaPath) => ({ relative_path: mediaPath, width: 1536, height: 1024, nonblank: true }),
      prepareReviewEvidence: async (artifact) => ({
        imageSource: { localAbsPath: `C:\\review\\${artifact.id}.png` },
        receipt: { kind: 'source_image', media_sha256: `hash-${artifact.id}` },
        cleanup() {},
      }),
      generateTextWithVision: async (user) => {
        if (user.includes('超时道具')) {
          const error = new Error('AI generation silence timeout after 120000ms');
          error.code = 'AI_SILENCE_TIMEOUT';
          throw error;
        }
        return JSON.stringify({
          decision: 'rejected', reason: '当前画面是剧情动作，不是同一件道具的四角度设定板',
          confidence: 0.95, severity: 'major',
          blocking_issues: ['移除人物与剧情场景，生成同一件道具恰好四个角度'],
          improvement_notes: [], requires_human_authority: false,
          scores: { production_ready: 30 },
        });
      },
      generateText: async (_user, _system, options) => {
        diagnosisCalls.push(options);
        return JSON.stringify({
          action: 'retry_same_model', root_cause: '视觉审核暂时超时',
          correction: '保持当前对象并重新执行一次视觉审核', model_requirements: '',
        });
      },
      media: {
        createImage: async (request) => {
          imageRequests.push(request);
          return { id: 810, task_id: 'retry-after-peer-timeout' };
        },
      },
    });

    const result = await service.applyReviewPolicy(run, images);
    assert.ok(['progressed', 'waiting_task'].includes(result.state), result.state);
    assert.equal(imageRequests.length, 1);
    assert.equal(imageRequests[0].source_artifact_id, sources[1].id);
    assert.match(imageRequests[0].prompt, /当前画面是剧情动作/);
    assert.match(imageRequests[0].prompt, /移除人物与剧情场景/);
    assert.equal(repo.getArtifact(db, images[0].id).status, 'draft');
    assert.equal(repo.getArtifact(db, images[1].id).status, 'rejected');
    assert.equal(diagnosisCalls.length, 1);
    const reviewActions = repo.listActions(db, run.id, { page_size: 100 }).items
      .filter((item) => item.kind === 'ai_review');
    assert.equal(reviewActions.some((item) => item.status === 'failed'), false);
    assert.equal(reviewActions.some((item) => item.status === 'cancelled'), true);
    assert.equal(repo.listActions(db, run.id, { page_size: 100 }).items
      .filter((item) => item.kind === 'image_generate' && item.status === 'waiting').length, 1);
  });

  it('recovers one persisted rejected asset after restart and a competing runner cannot duplicate it', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_images', status: 'running', next_stage_strategy: 'auto_generate',
      policy: { ...run.policy, image_concurrency: 2 },
    });
    const source = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_text', scope_type: 'scene', scope_id: 'restart-scene',
      title: '重启恢复场景',
      content: {
        name: '重启恢复场景', description: '同一室内空间', visual_prompt: '同一地点四个空间方向', included: true,
      },
      status: 'approved',
    });
    const rejected = repo.createArtifact(db, {
      run_id: run.id, stage: 'asset_images', scope_type: 'scene', scope_id: source.scope_id,
      title: source.title, content: { source_artifact_id: source.id, included: true },
      status: 'draft', media_path: 'images/restart-scene.png', mime_type: 'image/png', depends_on: [source.id],
    });
    repo.reviewArtifact(db, rejected.id, {
      reviewer_type: 'ai', decision: 'rejected', reason: '四格不是同一地点，空间锚点发生变化',
      evidence: {
        review_verdict: {
          reason: '四格不是同一地点，空间锚点发生变化', severity: 'major',
          blocking_issues: ['四格必须共享门、窗、桌椅与墙体的同一空间拓扑'], improvement_notes: [],
        },
      },
    });
    repo.updateRun(db, run.id, { status: 'running', waiting_reason: null, error_code: null, error_message: null });

    let createCalls = 0;
    let releaseCreate;
    const createImage = async () => {
      createCalls += 1;
      return new Promise((resolve) => { releaseCreate = () => resolve({ id: 901, task_id: 'restart-retry' }); });
    };
    const firstService = createProductionService(db, {}, log, { media: { createImage } });
    const secondService = createProductionService(db, {}, log, { media: { createImage } });
    const firstPromise = firstService.advance(run.id, { lease_owner: 'restart-runner-a' });
    await new Promise((resolve) => setImmediate(resolve));
    const competing = await secondService.advance(run.id, { lease_owner: 'restart-runner-b' });
    assert.equal(competing.state, 'waiting_task');
    assert.equal(competing.reason, 'busy');
    releaseCreate();
    const recovered = await firstPromise;
    assert.equal(recovered.state, 'waiting_task');
    assert.equal(createCalls, 1);
    const generated = repo.listActions(db, run.id, { page_size: 100 }).items
      .filter((item) => item.kind === 'image_generate');
    assert.equal(generated.length, 1);
    assert.equal(generated[0].status, 'waiting');
    assert.match(generated[0].request.prompt, /四格不是同一地点/);
    assert.match(generated[0].request.prompt, /同一空间拓扑/);
  });

  it('keeps storyboard and shot-video reviews serial even when review concurrency is higher', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'storyboard_plan', status: 'running',
      review_profile: { model: 'review-model', version: 'review-v2' },
    });
    automationPreferences.set(db, { review_concurrency: 8 });
    const shots = [1, 2, 3].map((number) => repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: String(number),
      title: `Shot ${number}`,
      content: {
        included: true, number, duration: 5,
        route_profile: 'long_previs_guided', transition_mode: number === 1 ? 'opening' : 'hard_cut',
        cut_motivation: number === 1 ? '' : 'new camera angle',
        cut_in: `shot ${number} entry`, cut_out: `shot ${number} exit`, boundary_prompt: `shot ${number} boundary`,
      },
      status: 'draft',
    }));
    let activeText = 0;
    let maximumText = 0;
    const service = createProductionService(db, {}, log, {
      generateText: async () => {
        activeText += 1;
        maximumText = Math.max(maximumText, activeText);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeText -= 1;
        return JSON.stringify({
          decision: 'approved', reason: 'shot can proceed', confidence: 0.9,
          severity: 'minor', blocking_issues: [], improvement_notes: [],
          requires_human_authority: false, scores: { production_ready: 90 },
        });
      },
    });
    assert.equal((await service.applyReviewPolicy(run, shots)).state, 'approved');
    assert.equal(maximumText, 1);

    run = repo.updateRun(db, run.id, { current_stage: 'shot_video', status: 'running' });
    const videos = [1, 2, 3].map((number) => repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: String(number),
      title: `Video ${number}`,
      content: { included: true, validation: { duration: 5 } },
      status: 'draft',
      media_path: `videos/video-${number}.mp4`,
      mime_type: 'video/mp4',
      content_hash: `video-hash-${number}`,
    }));
    let activeVision = 0;
    let maximumVision = 0;
    const videoService = createProductionService(db, {}, log, {
      validateVideo: async () => ({ duration: 5, video_codec: 'h264', audio_codec: 'aac' }),
      prepareReviewEvidence: async (artifact) => ({
        imageSource: { localAbsPath: `C:\\review\\${artifact.id}.jpg` },
        receipt: { kind: 'video_first_middle_last_sheet', sampled_at_seconds: [0.5, 2.5, 4.5] },
      }),
      generateTextWithVision: async () => {
        activeVision += 1;
        maximumVision = Math.max(maximumVision, activeVision);
        await new Promise((resolve) => setTimeout(resolve, 5));
        activeVision -= 1;
        return JSON.stringify({
          decision: 'approved', reason: 'video can proceed', confidence: 0.9,
          severity: 'minor', blocking_issues: [], improvement_notes: [],
          requires_human_authority: false, scores: { production_ready: 90 },
        });
      },
    });
    assert.equal((await videoService.applyReviewPolicy(run, videos)).state, 'approved');
    assert.equal(maximumVision, 1);
  });

  it('diagnoses a definite generation failure and authorizes one bounded retry', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_images', current_scope_type: 'character', current_scope_id: 'character-1',
      status: 'failed', waiting_reason: 'image_generation_failed',
      error_code: 'IMAGE_GENERATION_FAILED', error_message: 'temporary provider outage',
    });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'auto-image-failure', stage: 'asset_images',
      scope_type: 'character', scope_id: 'character-1', kind: 'image_generate', attempt: 1,
      request: { model: 'image-model-a' },
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed', error_code: 'IMAGE_GENERATION_FAILED', error_message: 'temporary provider outage',
    });
    const diagnosisCalls = [];
    const service = createProductionService(db, {}, log, {
      generateText: async (user, system, options) => {
        diagnosisCalls.push({ user, system, options });
        return JSON.stringify({
          action: 'revise_prompt',
          root_cause: '上游短时失败，同时提示词包含不稳定修饰',
          correction: '保留角色锚点，缩短环境修饰后重试一次',
          model_requirements: '保持当前图片能力',
        });
      },
    });

    const recovered = await service.advance(run.id, { lease_owner: 'auto-image-recovery' });
    assert.equal(recovered.state, 'progressed');
    assert.equal(recovered.reason, 'automatic_recovery_scheduled');
    assert.equal(diagnosisCalls.length, 1);
    const action = repo.getAction(db, failed.id);
    assert.equal(action.status, 'cancelled');
    assert.equal(action.result.retry_authorized, true);
    assert.equal(action.result.retry_authorized_by, 'production_autonomy');
    assert.match(action.result.retry_reason, /缩短环境修饰/);
    assert.equal(repo.getRun(db, run.id).status, 'running');
    assert.equal(repo.getRun(db, run.id).runtime.autonomy.objects['asset_images:character:character-1'].consecutive_generation_failures, 1);
  });

  it('stops an ambiguous external creation result without diagnosis or resubmission', async () => {
    let run = createRun('auto_accept');
    run = repo.updateRun(db, run.id, {
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'failed', waiting_reason: 'ambiguous_video_create',
      error_code: 'VIDEO_CREATE_AMBIGUOUS', error_message: 'provider result unknown',
    });
    const ambiguous = repo.reserveAction(db, {
      run_id: run.id, action_key: 'auto-video-ambiguous', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'video-model-a' },
    }).action;
    repo.updateAction(db, ambiguous.id, {
      status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS', error_message: 'provider result unknown',
    });
    let diagnosisCalls = 0;
    const service = createProductionService(db, {}, log, {
      generateText: async () => { diagnosisCalls += 1; return '{}'; },
    });

    const stopped = await service.advance(run.id, { lease_owner: 'ambiguous-stop' });
    assert.equal(stopped.state, 'waiting_review');
    assert.equal(stopped.reason, 'ambiguous_external_task');
    assert.equal(diagnosisCalls, 0);
    assert.equal(repo.getAction(db, ambiguous.id).status, 'ambiguous');
    assert.equal(repo.getRun(db, run.id).runtime.autonomy.intervention.reason, 'ambiguous_external_task');

    const reconciled = service.authorizeRetry(run.id, {
      action_id: ambiguous.id,
      reason: '已等待并核对上游，确认没有任务号、媒体文件或扣费记录',
      ambiguous_resolution: 'no_result_after_wait',
    });
    assert.equal(reconciled.action.status, 'cancelled');
    assert.equal(reconciled.summary.run.runtime.autonomy.intervention, undefined);
    assert.equal(reconciled.summary.run.runtime.autonomy.objects['shot_video:shot:1'], undefined);
  });

  it('recovers a stale local video-config binding failure without model switching or AI diagnosis', async () => {
    const config = aiConfigService.createConfig(db, log, {
      service_type: 'video', provider: 'yinzi', name: 'Bound video config',
      base_url: 'https://api.yinziapi.top/v1', api_key: 'test-video-key',
      model: ['old-catalog-model'], default_model: 'old-catalog-model', is_default: true,
    });
    let run = createRun('auto_accept');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed',
        video_model: 'seedance2.0 720p-pro-nv-nsp',
      },
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'failed', waiting_reason: 'resource_unavailable',
      error_code: 'VIDEO_GENERATION_FAILED', error_message: '未配置视频模型',
    });
    const now = new Date().toISOString();
    const generation = db.prepare(
      `INSERT INTO video_generations (
        drama_id, provider, model, status, generation_status, download_status,
        video_config_id, provider_config_snapshot_json, created_at, updated_at
      ) VALUES (1, 'yinzi', ?, 'failed', 'failed', 'pending', ?, ?, ?, ?)`
    ).run(
      'seedance2.0 720p-pro-nv-nsp',
      config.id,
      JSON.stringify({ config_id: config.id, provider: 'yinzi', model: 'seedance2.0 720p-pro-nv-nsp' }),
      now,
      now,
    );
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'stale-video-config-binding', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: {
        model: 'seedance2.0 720p-pro-nv-nsp',
        video_config_id: null,
      },
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed', generation_id: Number(generation.lastInsertRowid),
      error_code: 'VIDEO_GENERATION_FAILED', error_message: '未配置视频模型',
    });
    let diagnosisCalls = 0;
    const service = createProductionService(db, {}, log, {
      generateText: async () => { diagnosisCalls += 1; throw new Error('diagnosis must not run'); },
    });

    const recovered = await service.advance(run.id, { lease_owner: 'binding-recovery' });
    assert.equal(recovered.state, 'progressed');
    assert.equal(recovered.reason, 'video_config_binding_recovered');
    assert.equal(recovered.paid_submission, false);
    assert.equal(diagnosisCalls, 0);
    const action = repo.getAction(db, failed.id);
    assert.equal(action.status, 'cancelled');
    assert.equal(action.result.retry_authorized, true);
    assert.equal(action.result.stale_config_binding_recovered, true);
    const saved = repo.getRun(db, run.id);
    assert.equal(saved.status, 'running');
    assert.equal(saved.error_code, null);
    assert.equal(saved.policy.video_config_id, config.id);
    assert.equal(saved.policy.video_model, 'seedance2.0 720p-pro-nv-nsp');
  });

  it('switches to a compatible ordinary video model after a definite provider failure', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed',
        video_model: 'cc-seedance2.0 480p-fast-nsp',
        video_group: '特价视频分组(即梦)',
        video_quality: 'balanced',
        director_mode: 'off',
        allow_auto_model_switch: true,
      },
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'failed', waiting_reason: 'video_generation_failed',
      error_code: 'VIDEO_GENERATION_FAILED', error_message: 'temporary provider outage',
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', title: '镜头 1',
      content: {
        included: true, number: 1, duration: 5, route_profile: 'short_image_guided', previs_mode: 'skip',
        transition_mode: 'opening', cut_in: '建立开场', cut_out: '动作结束', boundary_prompt: '独立开场镜头',
        action: '林夏抬头看向温室灯光', visual: '稳定中近景', video_prompt: '五秒稳定中近景，动作结束后保持',
      },
      status: 'approved',
    });
    const storyboard = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '1', title: '镜头 1 分镜图',
      content: { included: true, source_artifact_id: shot.id }, status: 'approved',
      media_path: 'images/shot-1.png', mime_type: 'image/png', depends_on: [shot.id],
    });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'auto-video-failure', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'cc-seedance2.0 480p-fast-nsp' },
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed', error_code: 'VIDEO_GENERATION_FAILED', error_message: 'temporary provider outage',
    });
    const catalog = {
      pricing_version: 'automatic-switch-fixture',
      fetched_at: '2026-08-12T00:00:00.000Z',
      video: ['cc-seedance2.0 480p-fast-nsp', 'cc-seedance2.0 480p-nsp'].map((model, index) => ({
        model,
        endpoint_types: ['openai-video'],
        groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: index ? 0.5148 : 0.4656 }],
        capabilities: { ...healthyShortCapability, quality_tier: index ? 'balanced' : 'fast' },
        credential_verified: true, availability_scope: 'credential', scope_verified: true,
      })),
    };
    const service = createProductionService(db, {}, log, {
      generateText: async () => JSON.stringify({
        action: 'switch_model', root_cause: '当前模型临时不可用',
        correction: '切换到同组普通兼容模型后重试', model_requirements: '5 秒，图片参考',
      }),
      media: { fetchVideoCatalog: async () => catalog },
    });

    const switched = await service.advance(run.id, { lease_owner: 'auto-model-switch' });
    assert.equal(switched.state, 'progressed');
    assert.equal(switched.reason, 'automatic_model_switched');
    assert.equal(switched.effects.paid_submission, false);
    assert.equal(repo.getAction(db, failed.id).status, 'cancelled');
    const saved = repo.getRun(db, run.id);
    assert.equal(saved.policy.video_model_overrides['1'], 'cc-seedance2.0 480p-nsp');
    assert.equal(saved.current_stage, 'reference_bundle');
    const bundle = repo.listArtifacts(db, run.id, { stage: 'reference_bundle', current: true }).items[0];
    assert.equal(bundle.content.routing_receipt.model, 'cc-seedance2.0 480p-nsp');
    assert.equal(bundle.content.images[0].artifact_id, storyboard.id);
  });

  it('uses the user-authorized moderation fallback even when diagnosis asks to stop', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed',
        video_model: 'cc-seedance2.0 480p-fast-nsp',
        video_group: '特价视频分组(即梦)',
        video_quality: 'balanced',
        director_mode: 'off',
        allow_auto_model_switch: true,
      },
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'failed', waiting_reason: 'video_generation_failed',
      error_code: 'VIDEO_GENERATION_FAILED', error_message: '400 content moderation rejected by safety policy',
    });
    automationPreferences.set(db, {
      moderation_fallback_enabled: true,
      moderation_fallback_model: '破甲seedance 720p-fast',
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', title: '镜头 1',
      content: {
        included: true, number: 1, duration: 5, route_profile: 'short_image_guided', previs_mode: 'skip',
        transition_mode: 'opening', cut_in: '建立开场', cut_out: '动作结束', boundary_prompt: '独立开场镜头',
        action: '林夏抬头看向温室灯光', visual: '稳定中近景', video_prompt: '五秒稳定中近景，动作结束后保持',
      },
      status: 'approved',
    });
    const storyboard = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '1', title: '镜头 1 分镜图',
      content: { included: true, source_artifact_id: shot.id }, status: 'approved',
      media_path: 'images/shot-1.png', mime_type: 'image/png', depends_on: [shot.id],
    });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'moderation-video-failure', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate', attempt: 1,
      request: { model: 'cc-seedance2.0 480p-fast-nsp' },
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed', error_code: 'VIDEO_GENERATION_FAILED',
      error_message: '400 content moderation rejected by safety policy',
    });
    const catalog = {
      pricing_version: 'moderation-fallback-fixture', fetched_at: '2026-08-13T00:00:00.000Z',
      video: [
        ['cc-seedance2.0 480p-fast-nsp', 0.4656],
        ['破甲seedance 720p-fast', 2.1528],
      ].map(([model, effectivePrice]) => ({
        model, endpoint_types: ['openai-video'], groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: effectivePrice }],
      })),
    };
    const service = createProductionService(db, {}, log, {
      generateText: async () => JSON.stringify({
        action: 'stop', root_cause: '当前内容被普通模型安全策略拦截',
        correction: '保留剧情语义并改用已授权的内容审核兜底模型', model_requirements: '5 秒，图片参考',
      }),
      media: { fetchVideoCatalog: async () => catalog },
    });

    const switched = await service.advance(run.id, { lease_owner: 'moderation-fallback' });
    assert.equal(switched.state, 'progressed');
    assert.equal(switched.reason, 'automatic_moderation_fallback_switched');
    assert.equal(switched.effects.paid_submission, false);
    assert.equal(switched.switch_receipt.trigger_category, 'content_moderation_failure');
    assert.equal(switched.switch_receipt.designated_fallback_used, true);
    assert.equal(switched.switch_receipt.expensive_model_authorized, true);
    const savedAction = repo.getAction(db, failed.id);
    assert.equal(savedAction.status, 'cancelled');
    assert.equal(savedAction.result.automatic_diagnosis.requested_action, 'stop');
    assert.equal(savedAction.result.automatic_diagnosis.stop_deferred_until_limit, true);
    assert.equal(savedAction.result.automatic_model_switch.selected_model, '破甲seedance 720p-fast');
    const saved = repo.getRun(db, run.id);
    assert.equal(saved.policy.video_model_overrides['1'], '破甲seedance 720p-fast');
    const bundle = repo.listArtifacts(db, run.id, { stage: 'reference_bundle', current: true }).items[0];
    assert.equal(bundle.content.routing_receipt.model, '破甲seedance 720p-fast');
    assert.equal(bundle.content.images[0].artifact_id, storyboard.id);
  });

  it('keeps moderation fallback off by default and chooses an ordinary compatible model', async () => {
    let run = createRun('ai');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed', video_model: 'cc-seedance2.0 480p-fast-nsp',
        video_group: '特价视频分组(即梦)', director_mode: 'off', allow_auto_model_switch: true,
      },
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'failed', error_code: 'VIDEO_GENERATION_FAILED', error_message: 'moderation rejected',
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', title: '镜头 1',
      content: {
        included: true, number: 1, duration: 5, route_profile: 'short_image_guided', previs_mode: 'skip',
        transition_mode: 'opening', cut_in: '开场', cut_out: '结束', boundary_prompt: '独立镜头',
      }, status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '1', title: '分镜图',
      content: { included: true, source_artifact_id: shot.id }, status: 'approved', media_path: 'images/shot.png',
    });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'moderation-default-off', stage: 'shot_video', scope_type: 'shot', scope_id: '1',
      kind: 'video_generate', request: { model: 'cc-seedance2.0 480p-fast-nsp' },
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed', error_code: 'VIDEO_GENERATION_FAILED', error_message: 'moderation rejected',
    });
    const catalog = {
      pricing_version: 'moderation-default-off', fetched_at: '2026-08-13T00:00:00.000Z',
      video: [
        ['cc-seedance2.0 480p-fast-nsp', 0.4656],
        ['cc-seedance2.0 480p-nsp', 0.5148],
        ['破甲seedance 720p-fast', 2.1528],
      ].map(([model, effectivePrice]) => ({
        model, endpoint_types: ['openai-video'], groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: effectivePrice }],
      })),
    };
    const service = createProductionService(db, {}, log, {
      generateText: async () => JSON.stringify({
        action: 'stop', root_cause: 'moderation', correction: 'use another compatible model', model_requirements: '',
      }),
      media: { fetchVideoCatalog: async () => catalog },
    });
    const switched = await service.advance(run.id, { lease_owner: 'moderation-default-off' });
    assert.equal(switched.reason, 'automatic_model_switched');
    assert.equal(repo.getRun(db, run.id).policy.video_model_overrides['1'], 'cc-seedance2.0 480p-nsp');
    assert.equal(repo.getAction(db, failed.id).result.automatic_model_switch.designated_fallback_used, false);
  });

  it('binds a manually uploaded resource image to its exact approved source', async () => {
    const run = createRun('human');
    const source = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_text',
      scope_type: 'character',
      scope_id: 'character-1',
      title: '林夏',
      content: { name: '林夏', description: '宇航员', visual_prompt: '角色四视图', included: true },
      status: 'approved',
    });
    repo.updateRun(db, run.id, { current_stage: 'asset_images', status: 'waiting_review' });
    const receipt = {
      relative_path: 'images/linxia.png', bytes: 120000, sha256: 'a'.repeat(64),
      width: 1536, height: 1024, format: 'png', nonblank: true,
    };
    const service = createProductionService(db, {}, log, {
      validateImage: async () => receipt,
    });
    await assert.rejects(() => service.addManualArtifact(run.id, {
      stage: 'asset_images', media_path: 'images/linxia.png', content: { included: true },
    }), /上游对象/);
    const image = await service.addManualArtifact(run.id, {
      stage: 'asset_images', source_artifact_id: source.id,
      title: '林夏手动四视图', media_path: 'images/linxia.png', mime_type: 'image/png',
      content: { included: true },
    });
    assert.equal(image.scope_type, source.scope_type);
    assert.equal(image.scope_id, source.scope_id);
    assert.equal(image.content.source_artifact_id, source.id);
    assert.equal(image.media_path, receipt.relative_path);
    const dependency = db.prepare('SELECT * FROM production_artifact_dependencies WHERE artifact_id = ?').get(image.id);
    assert.equal(dependency.depends_on_artifact_id, source.id);
    const reviewed = await service.reviewArtifact(image.id, { reviewer_type: 'human', decision: 'approved', reason: '用户确认' });
    assert.equal(reviewed.artifact.status, 'approved');
  });

  it('keeps filling asset-image slots while completed drafts wait for human review', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      current_stage: 'asset_images',
      status: 'running',
      policy: { ...run.policy, image_concurrency: 2 },
    });
    const firstSource = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_text',
      scope_type: 'character',
      scope_id: 'character-1',
      title: 'Hero',
      content: { name: 'Hero', description: 'adult heroine', visual_prompt: 'identity sheet', included: true },
      status: 'approved',
    });
    const secondSource = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_text',
      scope_type: 'scene',
      scope_id: 'scene-1',
      title: 'Courtyard',
      content: { name: 'Courtyard', description: 'empty courtyard', visual_prompt: 'scene sheet', included: true },
      status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'asset_images',
      scope_type: firstSource.scope_type,
      scope_id: firstSource.scope_id,
      title: firstSource.title,
      content: { source_artifact_id: firstSource.id, included: true },
      status: 'draft',
      media_path: 'images/hero.png',
      depends_on: [firstSource.id],
    });
    let createCalls = 0;
    const service = createProductionService(db, {}, log, {
      media: {
        createImage: async () => {
          createCalls += 1;
          return { id: 501, task_id: 'image-task-501' };
        },
      },
    });

    const result = await service.advance(run.id, { lease_owner: 'parallel-draft-test' });
    assert.equal(result.state, 'waiting_task');
    assert.equal(createCalls, 1);
    assert.equal(result.action.scope_id, secondSource.scope_id);
    assert.equal(repo.getRun(db, run.id).waiting_reason, 'image_generation');
  });

  it('requires explicit feedback for failures and explicit reconciliation for ambiguity', () => {
    const run = createRun('human');
    repo.updateRun(db, run.id, { current_stage: 'asset_images', status: 'waiting_review' });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'failed-image', stage: 'asset_images',
      scope_type: 'character', scope_id: 'character-1', kind: 'image_generate', request: {},
    }).action;
    repo.updateAction(db, failed.id, { status: 'failed', error_code: 'UPSTREAM_FAILED', error_message: '审核失败' });
    const service = createProductionService(db, {}, log);
    const authorized = service.authorizeRetry(run.id, { action_id: failed.id });
    assert.equal(authorized.action.status, 'cancelled');
    assert.equal(authorized.action.result.retry_authorized, true);
    assert.equal(authorized.action.result.retry_reason, '用户请求重试当前失败任务');
    assert.equal(repo.getRun(db, run.id).status, 'running');

    const ambiguous = repo.reserveAction(db, {
      run_id: run.id, action_key: 'ambiguous-image', stage: 'asset_images',
      scope_type: 'scene', scope_id: 'scene-1', kind: 'image_generate', request: {},
    }).action;
    repo.updateAction(db, ambiguous.id, { status: 'ambiguous', error_code: 'AMBIGUOUS_ACTION' });
    assert.throws(
      () => service.authorizeRetry(run.id, { action_id: ambiguous.id, reason: '重试' }),
      /必须先核对上游任务/
    );
    const reconciled = service.authorizeRetry(run.id, {
      action_id: ambiguous.id,
      reason: '等待九小时仍无上游任务号、图片地址或本地文件',
      ambiguous_resolution: 'no_result_after_wait',
    });
    assert.equal(reconciled.action.status, 'cancelled');
    assert.equal(reconciled.action.result.retry_authorized, true);
    assert.equal(reconciled.action.result.ambiguous_reconciled, true);
    assert.equal(reconciled.action.result.ambiguous_resolution, 'no_result_after_wait');
    const event = db.prepare("SELECT payload_json FROM production_events WHERE run_id = ? AND event_type = 'action.ambiguous_reconciled' ORDER BY id DESC LIMIT 1").get(run.id);
    assert.equal(JSON.parse(event.payload_json).action_id, ambiguous.id);
  });

  it('separates ambiguous checking, unlock, and retry start without a provider submission', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'waiting_review', waiting_reason: 'ambiguous_video_create',
    });
    const action = repo.reserveAction(db, {
      run_id: run.id, action_key: 'ambiguous-three-step', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { model: 'Seedance 2.5-720' }, reserved_video_seconds: 30,
    }).action;
    repo.updateAction(db, action.id, { status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS' });
    let providerCreates = 0;
    const service = createProductionService(db, {}, log, {
      media: { createVideo: async () => { providerCreates += 1; return { task_id: 'must-not-run' }; } },
    });

    const checked = await service.reconcileAction(run.id, action.id, { mode: 'check_existing' });
    assert.equal(checked.status, 'still_ambiguous');
    assert.equal(checked.action.result.ambiguous_last_check_outcome, 'still_ambiguous');
    assert.equal(checked.summary.run.status, 'waiting_review');
    assert.equal(checked.summary.run.waiting_reason, 'ambiguous_video_create');
    assert.equal(providerCreates, 0);
    await assert.rejects(
      service.reconcileAction(run.id, action.id, { mode: 'start_retry' }),
      (error) => error.code === 'AMBIGUOUS_RETRY_NOT_AUTHORIZED',
    );

    const unlocked = await service.reconcileAction(run.id, action.id, {
      mode: 'confirm_not_created', confirmed: true,
    });
    assert.equal(unlocked.status, 'confirmed_not_created');
    assert.equal(unlocked.summary.run.status, 'waiting_review');
    assert.equal(unlocked.summary.run.waiting_reason, 'ambiguous_retry_ready');
    assert.equal(unlocked.summary.recovery_action.id, action.id);
    assert.equal(providerCreates, 0);
    const held = await service.advance(run.id, { lease_owner: 'ambiguous-retry-hold-test' });
    assert.equal(held.state, 'waiting_review');
    assert.equal(held.reason, 'ambiguous_retry_ready');
    assert.equal(providerCreates, 0);

    const started = await service.reconcileAction(run.id, action.id, { mode: 'start_retry' });
    const repeated = await service.reconcileAction(run.id, action.id, { mode: 'start_retry' });
    assert.equal(started.status, 'retry_started');
    assert.equal(started.reused, false);
    assert.equal(repeated.reused, true);
    assert.equal(repo.getRun(db, run.id).status, 'running');
    assert.equal(repo.getRunSummary(db, run.id).recovery_action, null);
    assert.equal(providerCreates, 0);

    const staleConfirm = await service.reconcileAction(run.id, action.id, {
      mode: 'confirm_not_created', confirmed: true, reason: '另一个旧页面重复确认',
    });
    assert.equal(staleConfirm.status, 'retry_started');
    assert.equal(repo.getRun(db, run.id).status, 'running');
    assert.equal(providerCreates, 0);
  });

  it('converges a running run with an ambiguous current video action before polling can spin', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      current_stage: 'shot_video', current_scope_type: 'shot', current_scope_id: '1',
      status: 'running', waiting_reason: null,
    });
    const action = repo.reserveAction(db, {
      run_id: run.id, action_key: 'ambiguous-running-convergence', stage: 'shot_video',
      scope_type: 'shot', scope_id: '1', kind: 'video_generate',
      request: { model: 'Seedance 2.5-720' }, reserved_video_seconds: 30,
    }).action;
    repo.updateAction(db, action.id, {
      status: 'ambiguous', error_code: 'VIDEO_CREATE_AMBIGUOUS',
      error_message: 'provider result unknown',
    });
    let providerCalls = 0;
    const service = createProductionService(db, {}, log, {
      media: { ensureShotVideos: async () => { providerCalls += 1; return { state: 'progressed' }; } },
    });

    const result = await service.advance(run.id, { lease_owner: 'ambiguous-running-convergence-test' });
    assert.equal(result.state, 'waiting_review');
    assert.equal(result.reason, 'ambiguous_video_create');
    assert.equal(result.action.id, action.id);
    assert.equal(providerCalls, 0);
    const converged = repo.getRun(db, run.id);
    assert.equal(converged.status, 'waiting_review');
    assert.equal(converged.waiting_reason, 'ambiguous_video_create');
    assert.equal(repo.listActions(db, run.id, { kind: 'video_generate' }).items.length, 1);
  });

  it('switches the current shot model locally, rebuilds its bundle, and preserves budget and failure history', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'auto',
        video_group: '特价视频分组(即梦)',
        video_quality: 'balanced',
        director_mode: 'off',
      },
      budget: { ...run.budget, max_video_attempts_per_shot: 2 },
      usage: { video_attempts_reserved: 7, video_seconds_reserved: 38 },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '5',
      title: 'Reaction shot',
      content: {
        included: true,
        number: 5,
        duration: 5,
        action: 'The heroine completes a restrained reaction.',
        visual: 'Stable close-up.',
        video_prompt: 'Complete the reaction and hold the final state.',
        previs_mode: 'skip',
        transition_mode: 'hard_cut',
      },
      status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_images',
      scope_type: 'shot',
      scope_id: '5',
      title: 'Reaction frame',
      content: { included: true, source_artifact_id: shot.id },
      status: 'approved',
      media_path: 'images/reaction.png',
      depends_on: [shot.id],
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'reference_bundle',
      current_scope_type: 'shot',
      current_scope_id: '5',
      status: 'running',
    });
    const catalog = {
      pricing_version: 'routing-switch-fixture',
      fetched_at: '2026-08-09T00:00:00.000Z',
      video: ['cc-seedance2.0 480p-fast-nsp', 'cc-seedance2.0 480p-nsp'].map((model, index) => ({
        model,
        endpoint_types: ['openai-video'],
        groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: index ? 0.5148 : 0.4656 }],
        capabilities: { ...healthyShortCapability, quality_tier: index ? 'balanced' : 'fast' },
        credential_verified: true, availability_scope: 'credential', scope_verified: true,
      })),
    };
    const service = createProductionService(db, {}, log, {
      media: { fetchVideoCatalog: async () => catalog },
    });
    const prepared = await service.advance(run.id, { lease_owner: 'route-switch-prepare' });
    assert.equal(prepared.state, 'progressed');
    repo.reviewArtifact(db, prepared.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: '旧模型参考包已确认',
    });
    const oldBundle = repo.getArtifact(db, prepared.artifact.id);
    const first = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot-5-old-attempt-1', stage: 'shot_video',
      scope_type: 'shot', scope_id: '5', kind: 'video_generate', attempt: 1,
      request: { model: 'cc-seedance2.0 480p-fast-nsp', bundle_artifact_id: oldBundle.id },
    }).action;
    repo.updateAction(db, first.id, { status: 'cancelled', result: { duration_contract_repaired: true } });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'shot-5-old-attempt-2', stage: 'shot_video',
      scope_type: 'shot', scope_id: '5', kind: 'video_generate', attempt: 2,
      request: { model: 'cc-seedance2.0 480p-fast-nsp', bundle_artifact_id: oldBundle.id },
    }).action;
    repo.updateAction(db, failed.id, { status: 'failed', error_code: 'UPSTREAM_UNAVAILABLE', error_message: 'temporary outage' });
    run = repo.updateRun(db, run.id, { status: 'waiting_review', waiting_reason: 'video_generation_failed' });
    const beforeUsage = structuredClone(run.usage);

    const switched = await service.updateVideoRouting(run.id, {
      scope: 'shot',
      shot_id: '5',
      mode: 'fixed',
      model: 'cc-seedance2.0 480p-nsp',
      authorize_retry: true,
      expected_version: run.version,
    });
    assert.equal(switched.effects.paid_submission, false);
    assert.equal(switched.effects.reference_bundle_refreshed, true);
    assert.equal(switched.effects.retry_authorized, true);
    assert.deepEqual(switched.summary.run.usage, beforeUsage);
    assert.equal(switched.summary.run.current_stage, 'reference_bundle');
    assert.equal(switched.summary.run.policy.video_model_overrides['5'], 'cc-seedance2.0 480p-nsp');
    const newBundle = repo.getArtifact(db, switched.effects.reference_bundle_artifact_id);
    assert.equal(newBundle.status, 'draft');
    assert.equal(newBundle.content.routing_receipt.model, 'cc-seedance2.0 480p-nsp');
    assert.notEqual(newBundle.content.routing_material_signature, oldBundle.content.routing_material_signature);
    assert.equal(repo.getArtifact(db, oldBundle.id).status, 'approved');
    assert.equal(repo.getAction(db, failed.id).status, 'cancelled');
    assert.equal(repo.getAction(db, failed.id).result.retry_authorized, true);
    assert.equal(repo.getAction(db, failed.id).result.retry_reason, '用户请求切换当前视频配置并重试');
  });

  it('supersedes a failed old-model action on a project route change without an extra retry gate', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed',
        video_group: '特价视频分组(即梦)',
        video_model: 'cc-seedance2.0 480p-fast-nsp',
        director_mode: 'off',
      },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '5',
      title: 'Project route replacement shot',
      content: {
        included: true,
        number: 5,
        duration: 5,
        action: 'The heroine turns toward the skyline and holds.',
        visual: 'Stable medium close-up.',
        video_prompt: 'Turn once, then hold the final pose.',
        previs_mode: 'skip',
        transition_mode: 'hard_cut',
      },
      status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_images',
      scope_type: 'shot',
      scope_id: '5',
      title: 'Approved storyboard frame',
      content: { included: true, source_artifact_id: shot.id },
      status: 'approved',
      media_path: 'images/project-route-frame.png',
      depends_on: [shot.id],
    });
    const edgeShots = ['6', '7', '8'].map((scopeId) => repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: scopeId,
      title: `Route edge shot ${scopeId}`,
      content: {
        included: true,
        number: Number(scopeId),
        duration: 5,
        action: 'Hold one stable pose.',
        visual: 'Stable medium shot.',
        video_prompt: 'Hold one stable pose for the full shot.',
        previs_mode: 'skip',
        transition_mode: 'hard_cut',
      },
      status: 'approved',
    }));
    run = repo.updateRun(db, run.id, {
      current_stage: 'reference_bundle',
      current_scope_type: 'shot',
      current_scope_id: '5',
      status: 'running',
    });
    const catalog = {
      pricing_version: 'project-route-switch-fixture',
      fetched_at: '2026-08-15T00:00:00.000Z',
      video: ['cc-seedance2.0 480p-fast-nsp', 'cc-seedance2.0 480p-nsp'].map((model, index) => ({
        model,
        endpoint_types: ['openai-video'],
        groups: ['特价视频分组(即梦)'],
        prices: [{
          group: '特价视频分组(即梦)',
          billing_unit: 'per_second',
          effective_price: index ? 0.5148 : 0.4656,
        }],
      })),
    };
    const service = createProductionService(db, {}, log, {
      media: { fetchVideoCatalog: async () => catalog },
    });
    const prepared = await service.advance(run.id, { lease_owner: 'project-route-prepare' });
    assert.equal(prepared.state, 'progressed');
    repo.reviewArtifact(db, prepared.artifact.id, {
      reviewer_type: 'human', decision: 'approved', reason: '旧模型参考包已确认',
    });
    const oldBundle = repo.getArtifact(db, prepared.artifact.id);
    const failed = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot-5-project-old-model-a1',
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '5',
      kind: 'video_generate',
      attempt: 1,
      request: {
        source_artifact_id: shot.id,
        model: 'cc-seedance2.0 480p-fast-nsp',
        bundle_artifact_id: oldBundle.id,
        routing_receipt: oldBundle.content.routing_receipt,
        routing_material_signature: oldBundle.content.routing_material_signature,
      },
      reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed',
      error_code: 'UPSTREAM_MODEL_UNAVAILABLE',
      error_message: 'The upstream model has been removed.',
    });
    const reserved = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot-6-project-old-model-a1',
      stage: 'shot_video', scope_type: 'shot', scope_id: '6', kind: 'video_generate', attempt: 1,
      request: {
        source_artifact_id: edgeShots[0].id,
        model: 'cc-seedance2.0 480p-fast-nsp',
        routing_receipt: oldBundle.content.routing_receipt,
        routing_material_signature: oldBundle.content.routing_material_signature,
      },
      reserved_video_seconds: 5,
      cost: {
        provider: 'yinzi', service_type: 'video', model: 'cc-seedance2.0 480p-fast-nsp',
        group_name: '特价视频分组(即梦)', billing_unit: 'per_second', units: 5,
        usage: { units: 5, duration_seconds: 5 }, estimated_microusd: 500000,
      },
    }).action;
    const submitted = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot-7-project-old-model-a1',
      stage: 'shot_video', scope_type: 'shot', scope_id: '7', kind: 'video_generate', attempt: 1,
      request: {
        source_artifact_id: edgeShots[1].id,
        model: 'cc-seedance2.0 480p-fast-nsp',
        routing_receipt: oldBundle.content.routing_receipt,
        routing_material_signature: oldBundle.content.routing_material_signature,
      },
      reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, submitted.id, { status: 'submitted' });
    const waiting = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'shot-8-project-old-model-a1',
      stage: 'shot_video', scope_type: 'shot', scope_id: '8', kind: 'video_generate', attempt: 1,
      request: {
        source_artifact_id: edgeShots[2].id,
        model: 'cc-seedance2.0 480p-fast-nsp',
        routing_receipt: oldBundle.content.routing_receipt,
        routing_material_signature: oldBundle.content.routing_material_signature,
      },
      reserved_video_seconds: 5,
    }).action;
    repo.updateAction(db, waiting.id, {
      status: 'waiting', task_id: 'old-task-8', generation_id: 8808,
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'shot_video',
      current_scope_type: 'shot',
      current_scope_id: '5',
      status: 'waiting_review',
      waiting_reason: 'video_generation_failed',
      error_code: 'UPSTREAM_MODEL_UNAVAILABLE',
      error_message: 'The upstream model has been removed.',
    });

    const switched = await service.updateVideoRouting(run.id, {
      scope: 'run',
      mode: 'fixed',
      model: 'cc-seedance2.0 480p-nsp',
      expected_version: run.version,
    });
    const oldAction = repo.getAction(db, failed.id);
    assert.equal(oldAction.status, 'cancelled');
    assert.equal(oldAction.result.superseded_by_route_change, true);
    assert.equal(oldAction.result.retry_authorized, true);
    assert.equal(switched.effects.retry_authorized, true);
    assert.deepEqual(switched.effects.superseded_action_ids, [failed.id, reserved.id, submitted.id, waiting.id]);
    assert.deepEqual(switched.effects.ambiguous_action_ids, [submitted.id]);
    assert.deepEqual(switched.effects.in_flight_action_ids, [waiting.id]);
    assert.equal(repo.getAction(db, reserved.id).status, 'cancelled');
    assert.equal(repo.getAction(db, reserved.id).result.superseded_before_submission, true);
    assert.equal(repo.getAction(db, submitted.id).status, 'ambiguous');
    assert.equal(repo.getAction(db, waiting.id).status, 'waiting');
    assert.equal(repo.getAction(db, waiting.id).result.superseded_by_route_change, true);
    assert.equal(
      db.prepare('SELECT status FROM cost_ledger WHERE action_id = ?').get(reserved.id).status,
      'released'
    );
    const newBundle = repo.getArtifact(db, switched.effects.reference_bundle_artifact_id);
    assert.equal(newBundle.content.routing_receipt.model, 'cc-seedance2.0 480p-nsp');
    assert.notEqual(newBundle.content.routing_material_signature, oldBundle.content.routing_material_signature);
    repo.reviewArtifact(db, newBundle.id, {
      reviewer_type: 'human', decision: 'approved', reason: '新模型参考包已确认',
    });

    const dispatched = [];
    const media = createProductionMediaService(db, {}, log, {
      fetchVideoCatalog: async () => catalog,
      createVideo: async (request) => {
        dispatched.push(request);
        return { id: 9901, task_id: 'new-model-task', model: request.model };
      },
    });
    const submission = await media.ensureShotVideos(repo.getRun(db, run.id));
    assert.equal(submission.state, 'waiting_provider');
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].model, 'cc-seedance2.0 480p-nsp');
    assert.equal(submission.action.request.model, 'cc-seedance2.0 480p-nsp');
    assert.equal(
      submission.action.request.routing_material_signature,
      newBundle.content.routing_material_signature
    );
  });

  it('lets the current long shot skip 3D from the routing dialog and rebuilds a zero-video bundle', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'auto',
        video_group: '特价视频分组(即梦)',
        video_quality: 'balanced',
        director_mode: 'auto',
      },
      usage: { video_attempts_reserved: 9, video_seconds_reserved: 48 },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '6',
      title: 'Twelve second continuous shot',
      content: {
        included: true,
        number: 6,
        duration: 12,
        route_profile: 'long_previs_guided',
        previs_mode: 'auto',
        transition_mode: 'hard_cut',
        action: 'Complete one continuous action in the same camera setup.',
        visual: 'Locked high-angle wide shot.',
        video_prompt: 'Complete the action and settle before the cut.',
      },
      status: 'approved',
    });
    const frame = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_images',
      scope_type: 'shot',
      scope_id: '6',
      title: 'Approved storyboard frame',
      content: { included: true, source_artifact_id: shot.id },
      status: 'approved',
      media_path: 'images/shot-6.png',
      depends_on: [shot.id],
    });
    const directorPlan = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'director_plan',
      scope_type: 'shot',
      scope_id: '6',
      title: 'Historical director plan',
      content: { included: true, source_artifact_id: shot.id },
      status: 'approved',
      depends_on: [shot.id],
    });
    const directorPreview = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'director_preview',
      scope_type: 'shot',
      scope_id: '6',
      title: 'Historical director preview',
      content: { included: true, source_artifact_id: directorPlan.id, validation: { duration: 12 } },
      status: 'approved',
      media_path: 'previews/shot-6.webm',
      depends_on: [directorPlan.id],
    });
    const oldBundle = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'reference_bundle',
      scope_type: 'shot',
      scope_id: '6',
      title: 'Old preview-required bundle',
      content: {
        included: true,
        source_artifact_id: shot.id,
        images: [{ path: frame.media_path, artifact_id: frame.id, source: 'storyboard', role: 'reference' }],
        videos: [{ path: directorPreview.media_path, artifact_id: directorPreview.id, source: 'director' }],
        audios: [],
        routing_receipt: {
          profile: 'long_previs_guided', model: 'mg-seedance2.0 -480p mini',
          planned_duration: 12, duration: 12, previs_mode: 'auto',
          uses_reference_video: true, requires_director_preview: true,
          limits: { images: 4, videos: 3, audios: 1 }, material_signature: 'old-preview-route',
        },
        routing_material_signature: 'old-preview-route',
        transition_mode: 'hard_cut',
        previs_mode: 'auto',
        uses_reference_video: true,
        requires_director_preview: true,
        limits: { images: 4, videos: 3, audios: 1 },
      },
      status: 'approved',
      depends_on: [shot.id, frame.id, directorPreview.id],
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'reference_bundle',
      current_scope_type: 'shot',
      current_scope_id: '6',
      status: 'waiting_review',
    });
    const beforeUsage = structuredClone(run.usage);
    const catalog = {
      pricing_version: 'previs-skip-fixture',
      fetched_at: '2026-08-10T00:00:00.000Z',
      video: [{
        model: 'mg-seedance2.0 -480p mini',
        endpoint_types: ['openai-video'],
        groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.2004 }],
      }],
    };
    const service = createProductionService(db, {}, log, {
      media: { fetchVideoCatalog: async () => catalog },
    });

    await assert.rejects(
      service.updateVideoRouting(run.id, {
        scope: 'shot', shot_id: '6', mode: 'inherit', previs_mode: 'omit', expected_version: run.version,
      }),
      (error) => error.code === 'VIDEO_PREVIS_MODE_INVALID'
    );
    assert.equal(repo.getRun(db, run.id).policy.video_previs_overrides, undefined);
    assert.deepEqual(repo.getRun(db, run.id).usage, beforeUsage);

    const skipped = await service.updateVideoRouting(run.id, {
      scope: 'shot',
      shot_id: '6',
      mode: 'inherit',
      previs_mode: 'skip',
      expected_version: run.version,
    });

    assert.equal(skipped.effects.paid_submission, false);
    assert.equal(skipped.effects.reference_bundle_refreshed, true);
    assert.deepEqual(skipped.summary.run.usage, beforeUsage);
    assert.equal(skipped.summary.run.current_stage, 'reference_bundle');
    assert.equal(skipped.summary.run.policy.video_previs_overrides['6'], 'skip');
    assert.equal(skipped.routing.shot.previs_mode_override, 'skip');
    assert.equal(skipped.routing.effective_route.previs_mode, 'skip');
    assert.equal(skipped.routing.effective_route.requires_director_preview, false);
    assert.equal(skipped.routing.effective_route.uses_reference_video, false);
    assert.equal(repo.getArtifact(db, shot.id).status, 'approved');
    assert.equal(repo.getArtifact(db, shot.id).content.previs_mode, 'auto');

    const bundle = repo.getArtifact(db, skipped.effects.reference_bundle_artifact_id);
    assert.notEqual(bundle.id, oldBundle.id);
    assert.equal(bundle.status, 'draft');
    assert.equal(bundle.content.previs_mode, 'skip');
    assert.equal(bundle.content.requires_director_preview, false);
    assert.equal(bundle.content.uses_reference_video, false);
    assert.equal(bundle.content.limits.videos, 0);
    assert.deepEqual(bundle.content.videos, []);
    assert.equal(repo.listUpstreamArtifactIds(db, bundle.id).includes(directorPlan.id), false);
    assert.equal(repo.listUpstreamArtifactIds(db, bundle.id).includes(directorPreview.id), false);
    await assert.doesNotReject(service.validateArtifactForApproval(bundle));
  });

  it('recovers a failed director stage by skipping only previs while preserving the shot and budget', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'auto', video_group: '特价视频分组(即梦)',
        video_quality: 'balanced', director_mode: 'auto',
      },
      usage: { video_attempts_reserved: 4, video_seconds_reserved: 30 },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '6', title: 'Long uploaded-subject shot',
      content: {
        included: true, number: 6, duration: 12, route_profile: 'long_previs_guided', previs_mode: 'auto',
        transition_mode: 'hard_cut', action: 'Uploaded heroine completes a dance.', visual: 'Stable full shot.',
        video_prompt: 'Keep the uploaded heroine identity and complete the dance.',
      }, status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '6', title: 'Approved storyboard frame',
      content: { included: true, source_artifact_id: shot.id }, status: 'approved',
      media_path: 'images/shot-6.png', depends_on: [shot.id],
    });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'director-external-id-failure', stage: 'director_plan',
      scope_type: 'shot', scope_id: '6', kind: 'text_generate', attempt: 1,
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed', error_code: 'AI_GENERATION_FAILED',
      error_message: '未知导演台素材：asset-external-reference',
    });
    const capture = repo.reserveAction(db, {
      run_id: run.id, action_key: 'director-capture-pending', stage: 'director_preview',
      scope_type: 'shot', scope_id: '6', kind: 'client_capture', attempt: 1,
    }).action;
    repo.updateAction(db, capture.id, { status: 'waiting' });
    run = repo.updateRun(db, run.id, {
      current_stage: 'director_plan', current_scope_type: 'shot', current_scope_id: '6',
      status: 'failed', error_code: 'ADVANCE_FAILED', error_message: '未知导演台素材：asset-external-reference',
    });
    const beforeUsage = structuredClone(run.usage);
    const beforeVideoActions = repo.listActions(db, run.id, { stage: 'shot_video', kind: 'video_generate', page_size: 100 }).items.length;
    const catalog = {
      pricing_version: 'director-skip-recovery-fixture', fetched_at: '2026-09-01T00:00:00.000Z',
      video: [{
        model: 'mg-seedance2.0 -480p mini', endpoint_types: ['openai-video'], groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.2004 }],
      }],
    };
    const service = createProductionService(db, {}, log, { media: { fetchVideoCatalog: async () => catalog } });
    const skipped = await service.skipDirectorForShot(run.id, '6', {
      expected_version: run.version, reason: 'director failed; preserve the shot',
    });

    assert.equal(skipped.effects.paid_submission, false);
    assert.equal(skipped.effects.shot_preserved, true);
    assert.deepEqual(skipped.summary.run.usage, beforeUsage);
    assert.equal(skipped.summary.run.current_stage, 'reference_bundle');
    assert.equal(skipped.summary.run.status, 'waiting_review');
    assert.equal(skipped.summary.run.error_message, null);
    assert.equal(skipped.summary.run.policy.video_previs_overrides['6'], 'skip');
    assert.equal(repo.getArtifact(db, shot.id).status, 'approved');
    assert.equal(repo.getArtifact(db, shot.id).content.included, true);
    assert.equal(repo.getAction(db, capture.id).status, 'cancelled');
    const bundle = repo.getArtifact(db, skipped.effects.reference_bundle_artifact_id);
    assert.equal(bundle.content.requires_director_preview, false);
    assert.equal(bundle.content.uses_reference_video, false);
    assert.deepEqual(bundle.content.videos, []);
    assert.equal(repo.listActions(db, run.id, { stage: 'shot_video', kind: 'video_generate', page_size: 100 }).items.length, beforeVideoActions);

    const steadyVersion = skipped.summary.run.version;
    const repeated = await service.skipDirectorForShot(run.id, '6', { expected_version: steadyVersion });
    assert.equal(repeated.effects.reused, true);
    assert.equal(repeated.effects.reference_bundle_artifact_id, bundle.id);
    assert.equal(repeated.summary.run.version, steadyVersion);
    assert.deepEqual(repeated.summary.run.usage, beforeUsage);
    assert.equal(repo.listActions(db, run.id, { stage: 'shot_video', kind: 'video_generate', page_size: 100 }).items.length, beforeVideoActions);
  });

  it('can disable the project director from a failed stage and continue without a paid submission', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: { ...run.policy, director_mode: 'auto', video_routing_mode: 'auto' },
      usage: { video_attempts_reserved: 2, video_seconds_reserved: 15 },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '2', title: 'Director opt-out shot',
      content: { included: true, number: 2, duration: 8, route_profile: 'long_previs_guided', previs_mode: 'auto', transition_mode: 'hard_cut' },
      status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_images', scope_type: 'shot', scope_id: '2', title: 'Frame',
      content: { included: true, source_artifact_id: shot.id }, status: 'approved', media_path: 'images/shot-2.png', depends_on: [shot.id],
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'director_plan', current_scope_type: 'shot', current_scope_id: '2',
      status: 'failed', error_code: 'ADVANCE_FAILED', error_message: 'director failed',
    });
    const beforeUsage = structuredClone(run.usage);
    const catalog = {
      pricing_version: 'director-disable-recovery-fixture', fetched_at: '2026-09-01T00:00:00.000Z',
      video: [{
        model: 'mg-seedance2.0 -480p mini', endpoint_types: ['openai-video'], groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.2004 }],
      }],
    };
    const service = createProductionService(db, {}, log, { media: { fetchVideoCatalog: async () => catalog } });
    const result = await service.disableDirectorAndContinue(run.id, { expected_version: run.version });
    assert.equal(result.effects.paid_submission, false);
    assert.equal(result.effects.shot_preserved, true);
    assert.equal(result.summary.run.policy.director_mode, 'off');
    assert.equal(result.summary.run.current_stage, 'reference_bundle');
    assert.equal(result.summary.run.status, 'waiting_review');
    assert.equal(result.summary.run.error_message, null);
    assert.deepEqual(result.summary.run.usage, beforeUsage);
    assert.equal(repo.getArtifact(db, shot.id).content.included, true);
    const bundle = repo.getArtifact(db, result.effects.reference_bundle_artifact_id);
    assert.deepEqual(bundle.content.videos, []);
    assert.equal(repo.listActions(db, run.id, { stage: 'shot_video', kind: 'video_generate', page_size: 100 }).items.length, 0);
  });

  it('keeps routing editable on the latest rejected storyboard without entering production', async () => {
    let run = createRun('human');
    const approved = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '7',
      title: 'Approved rough shot seven',
      content: {
        included: true,
        number: 7,
        duration: 8,
        route_profile: 'long_previs_guided',
        previs_mode: 'auto',
        transition_mode: 'hard_cut',
        action: 'The subject completes a continuous movement.',
        visual: 'Stable wide shot.',
        video_prompt: 'Keep the continuous movement readable for eight seconds.',
      },
      status: 'approved',
    });
    const rejected = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '7',
      title: 'Rejected revision of shot seven',
      parent_artifact_id: approved.id,
      content: {
        ...approved.content,
        visual: 'Revision awaiting a clearer composition.',
      },
    });
    repo.reviewArtifact(db, rejected.id, {
      reviewer_type: 'human',
      decision: 'rejected',
      reason: 'Composition needs another revision.',
    });
    run = repo.getRun(db, run.id);
    run = repo.updateRun(db, run.id, {
      current_stage: 'storyboard_plan',
      current_scope_type: 'shot',
      current_scope_id: '7',
      status: 'waiting_review',
      waiting_reason: 'revision_required',
      policy: {
        ...run.policy,
        video_previs_overrides: { 7: 'skip' },
      },
    });
    const beforeUsage = structuredClone(run.usage);
    const beforeArtifacts = repo.listArtifacts(db, run.id, { page_size: 200 }).items.map((item) => item.id);
    const beforeActions = repo.listActions(db, run.id, { page_size: 200 }).items.map((item) => item.id);
    const catalog = {
      pricing_version: 'rejected-routing-fixture',
      fetched_at: '2026-08-10T00:00:00.000Z',
      video: [{
        model: 'mg-seedance2.0 -480p mini',
        endpoint_types: ['openai-video'],
        groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.2004 }],
      }],
    };
    const service = createProductionService(db, {}, log, {
      media: { fetchVideoCatalog: async () => catalog },
    });

    const routing = await service.getVideoRouting(run.id, { shot_id: '7' });
    assert.equal(routing.shot_status, 'rejected');
    assert.equal(routing.route_edit_deferred, true);
    assert.equal(routing.shot.previs_mode_override, 'skip');
    assert.equal(routing.effective_route.previs_mode, 'skip');
    assert.equal(routing.effective_route.requires_director_preview, false);
    assert.equal(routing.effective_route.limits.videos, 0);

    const saved = await service.updateVideoRouting(run.id, {
      scope: 'shot',
      shot_id: '7',
      mode: 'inherit',
      previs_mode: 'skip',
      expected_version: run.version,
    });
    assert.equal(saved.effects.route_edit_deferred, true);
    assert.equal(saved.effects.reference_bundle_refreshed, false);
    assert.equal(saved.effects.reference_bundle_artifact_id, null);
    assert.equal(saved.summary.run.current_stage, 'storyboard_plan');
    assert.equal(saved.summary.run.current_scope_id, '7');
    assert.equal(saved.summary.run.status, 'waiting_review');
    assert.equal(saved.summary.run.waiting_reason, 'revision_required');
    assert.deepEqual(saved.summary.run.usage, beforeUsage);
    assert.deepEqual(repo.listArtifacts(db, run.id, { page_size: 200 }).items.map((item) => item.id), beforeArtifacts);
    assert.deepEqual(repo.listActions(db, run.id, { page_size: 200 }).items.map((item) => item.id), beforeActions);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'reference_bundle', page_size: 200 }).items.length, 0);

    const steady = await service.advance(run.id, { lease_owner: 'rejected-revision-steady' });
    assert.equal(steady.state, 'waiting_review');
    assert.equal(steady.reason, 'revision_required');
    assert.equal(steady.artifacts[0].id, rejected.id);
    assert.equal(steady.run.status, 'waiting_review');
    assert.equal(steady.run.error_code, null);

    repo.updateRun(db, run.id, {
      status: 'failed',
      waiting_reason: 'revision_required',
      error_code: 'ADVANCE_FAILED',
      error_message: 'Shot 7 has no approved rough plan to refine',
    });
    const healed = await service.advance(run.id, { lease_owner: 'rejected-revision-heal' });
    assert.equal(healed.state, 'waiting_review');
    assert.equal(healed.reason, 'revision_required');
    assert.equal(healed.run.status, 'waiting_review');
    assert.equal(healed.run.error_code, null);
    assert.equal(healed.run.error_message, null);
    assert.deepEqual(repo.listArtifacts(db, run.id, { page_size: 200 }).items.map((item) => item.id), beforeArtifacts);
    assert.deepEqual(repo.listActions(db, run.id, { page_size: 200 }).items.map((item) => item.id), beforeActions);
  });

  it('keeps a disappeared configured model usable while returning replacement options', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      policy: {
        ...run.policy,
        video_routing_mode: 'fixed',
        video_model: 'removed-upstream-model',
        video_group: '特价视频分组(即梦)',
        director_mode: 'off',
      },
      current_stage: 'reference_bundle',
      current_scope_type: 'shot',
      current_scope_id: '5',
    });
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '5',
      title: 'Replacement route shot',
      content: {
        included: true,
        number: 5,
        duration: 5,
        action: 'The heroine looks toward the city lights.',
        visual: 'Stable medium close-up.',
        video_prompt: 'Hold a stable medium close-up for five seconds.',
        previs_mode: 'skip',
        transition_mode: 'hard_cut',
      },
      status: 'approved',
    });
    const catalog = {
      pricing_version: 'replacement-options-fixture',
      fetched_at: '2026-08-09T00:00:00.000Z',
      video: [{
        model: 'cc-seedance2.0 480p-nsp',
        endpoint_types: ['openai-video'],
        groups: ['特价视频分组(即梦)'],
        prices: [{ group: '特价视频分组(即梦)', billing_unit: 'per_second', effective_price: 0.5148 }],
      }],
    };
    const service = createProductionService(db, {}, log, {
      media: { fetchVideoCatalog: async () => catalog },
    });

    const routing = await service.getVideoRouting(run.id, { shot_id: '5' });
    assert.equal(routing.effective_route.model, 'removed-upstream-model');
    assert.equal(routing.effective_route.catalog_verified, false);
    assert.equal(routing.effective_route.contract_status, 'missing');
    assert.ok(routing.effective_route.contract_warnings.includes('model_not_in_catalog'));
    assert.equal(routing.effective_route_error, null);
    assert.equal(routing.catalog.options.some((item) => item.model === 'cc-seedance2.0 480p-nsp' && item.selectable), true);
    assert.equal(routing.run_version, run.version);
  });

  it('returns field assistance as an unsaved candidate only', async () => {
    const run = createRun('human');
    const service = createProductionService(db, {}, log, {
      generateText: async () => '银白宇航服左肩有一枚青绿色叶片徽章，短黑发，左眉上方有小痣。',
    });
    const result = await service.assist({
      run_id: run.id,
      field_key: 'appearance',
      current_value: '银白宇航服',
      instruction: '增加三个稳定辨识点',
    });
    assert.match(result.value, /叶片徽章/);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'asset_text', current: true }).items.length, 0);
  });

  it('transitions human review one shot at a time and blocks an unrefined next rough shot', () => {
    const run = createRun('human');
    const shots = [1, 2].map((number) => repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: String(number),
      title: `Shot ${number}`,
      content: {
        number,
        title: `Shot ${number}`,
        duration: 5,
        route_profile: 'long_previs_guided',
        action: `Action ${number}`,
        visual: `Visual ${number}`,
        video_prompt: `Provider prompt ${number}`,
        included: true,
      },
      status: 'approved',
    }));
    repo.updateRun(db, run.id, {
      current_stage: 'storyboard_plan',
      current_scope_type: null,
      current_scope_id: null,
      status: 'waiting_review',
    });
    const service = createProductionService(db, {}, log);
    const first = service.transition(run.id, { next_stage_strategy: 'auto_generate' });
    assert.equal(first.run.current_stage, 'storyboard_images');
    assert.equal(first.run.current_scope_id, '1');

    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_images',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Shot 1 frame',
      content: { source_artifact_id: shots[0].id, included: true },
      status: 'approved',
      media_path: 'images/shot-1.png',
    });
    const director = service.transition(run.id, { next_stage_strategy: 'auto_generate' });
    assert.equal(director.run.current_stage, 'director_plan');
    assert.equal(director.run.current_scope_id, '1');

    repo.updateRun(db, run.id, {
      current_stage: 'shot_video',
      current_scope_type: 'shot',
      current_scope_id: '1',
      status: 'waiting_review',
    });
    const shotVideo = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'shot_video',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Shot 1 video',
      content: { source_artifact_id: shots[0].id, included: true },
      status: 'approved',
      media_path: 'videos/shot-1.mp4',
    });
    const next = service.transition(run.id, { next_stage_strategy: 'auto_generate' });
    assert.equal(next.run.current_stage, 'storyboard_plan');
    assert.equal(next.run.current_scope_id, '2');
    const summary = repo.getRunSummary(db, run.id);
    assert.equal(summary.unresolved.complete, false);
    assert.equal(summary.unresolved.unresolved[0].reason, 'shot_plan_not_refined');
    assert.throws(
      () => service.transition(run.id, { next_stage_strategy: 'auto_generate' }),
      /未处理内容/
    );
    assert.equal(repo.getArtifact(db, shotVideo.id).status, 'approved');
  });

  it('locally recovers a truncated sequential refinement once and preserves the failed action', () => {
    const run = createRun('human');
    const first = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '1', title: '深潭',
      content: {
        number: 1, title: '深潭', duration: 5, action: '取回信物并完成动作。',
        visual: '深潭水下广角。', video_prompt: '完成取物动作。', transition_mode: 'opening',
        cut_out: '信物已经收好，动作完整结束。', included: true,
      }, status: 'approved',
    });
    const rough = repo.createArtifact(db, {
      run_id: run.id, stage: 'storyboard_plan', scope_type: 'shot', scope_id: '2', title: '雨后集市',
      content: {
        number: 2, title: '雨后集市', duration: 4, action: '少女停在摊位前抬眼。',
        visual: '雨后集市独立中景。', video_prompt: '停下并抬眼。', transition_mode: 'hard_cut',
        cut_in: '新机位建立集市场景。', cut_out: '视线稳定落向画外。',
        cut_motivation: '切到新的地点和信息。', included: true,
      }, status: 'approved',
    });
    const video = repo.createArtifact(db, {
      run_id: run.id, stage: 'shot_video', scope_type: 'shot', scope_id: '1', title: '深潭成片',
      content: { source_artifact_id: first.id, validation: { duration: 5 }, included: true },
      status: 'approved', media_path: 'videos/shot-1.mp4', depends_on: [first.id],
    });
    repo.updateRun(db, run.id, {
      current_stage: 'storyboard_plan', current_scope_type: 'shot', current_scope_id: '2',
      status: 'failed', runtime: { shot_pipeline: { mode: 'sequential', current_shot_id: '2' } },
    });
    const failed = repo.reserveAction(db, {
      run_id: run.id, action_key: 'storyboard-refine-truncated', stage: 'storyboard_plan',
      scope_type: 'shot', scope_id: '2', kind: 'storyboard_refine', request: {},
    }).action;
    repo.updateAction(db, failed.id, {
      status: 'failed', error_code: 'AI_GENERATION_FAILED',
      error_message: '分镜结果为空或缺少动作/构图',
    });
    const service = createProductionService(db, {}, log);
    const recovered = service.recoverScopedShotRevision(run.id, { action_id: failed.id });
    assert.equal(recovered.state, 'waiting_review');
    assert.equal(recovered.reused, false);
    assert.equal(recovered.artifact.status, 'draft');
    assert.equal(recovered.artifact.content.rough_source_artifact_id, rough.id);
    assert.equal(recovered.artifact.content.refined_from_video_artifact_id, video.id);
    assert.equal(recovered.artifact.content.transition_mode, 'hard_cut');
    assert.match(recovered.artifact.content.boundary_prompt, /不使用上一段视频尾帧/);
    assert.equal(repo.getAction(db, failed.id).status, 'failed');
    assert.equal(repo.getRun(db, run.id).status, 'waiting_review');
    const repeated = service.recoverScopedShotRevision(run.id, { action_id: failed.id });
    assert.equal(repeated.reused, true);
    assert.equal(repeated.artifact.id, recovered.artifact.id);
    assert.equal(repo.listArtifacts(db, run.id, {
      stage: 'storyboard_plan', scope_type: 'shot', scope_id: '2', page_size: 20,
    }).items.length, 2);
  });

  it('skips both director stages for a two-second image-guided shot without creating a capture action', async () => {
    const run = createRun('human');
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Two-second reaction',
      content: {
        number: 1,
        title: 'Two-second reaction',
        duration: 2,
        route_profile: 'short_image_guided',
        previs_mode: 'auto',
        transition_mode: 'opening',
        action: 'The heroine lifts her eyes once, then holds still.',
        visual: 'Tight expression close-up from a stable camera.',
        video_prompt: 'A complete two-second reaction beat.',
        included: true,
      },
      status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_images',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Reaction frame',
      content: { source_artifact_id: shot.id, included: true },
      status: 'approved',
      media_path: 'images/reaction.png',
    });
    repo.updateRun(db, run.id, {
      current_stage: 'storyboard_images',
      current_scope_type: 'shot',
      current_scope_id: '1',
      status: 'waiting_review',
      runtime: { shot_pipeline: { mode: 'sequential', current_shot_id: '1' } },
    });

    const service = createProductionService(db, {}, log);
    const transitioned = service.transition(run.id, { next_stage_strategy: 'auto_generate' });
    assert.equal(transitioned.run.current_stage, 'reference_bundle');
    assert.equal(transitioned.run.current_scope_id, '1');
    const skipped = db.prepare(`
      SELECT stage, payload_json
      FROM production_events
      WHERE run_id = ? AND event_type = 'stage.skipped'
      ORDER BY id
    `).all(run.id);
    assert.deepEqual(skipped.map((item) => item.stage), ['director_plan', 'director_preview']);
    assert.ok(skipped.every((item) => {
      const payload = JSON.parse(item.payload_json);
      return payload.planned_duration === 2
        && payload.duration === 2
        && payload.duration_adjusted === false;
    }));
    assert.equal(
      repo.listActions(db, run.id, { page_size: 200 }).items.filter((item) => item.kind === 'client_capture').length,
      0
    );
    const manualBundle = await service.addManualArtifact(run.id, {
      stage: 'reference_bundle',
      source_artifact_id: shot.id,
      title: 'Manual image-only reference bundle',
      content: { included: true },
    });
    assert.equal(manualBundle.content.limits, null);
    assert.equal(manualBundle.content.soft_limits, true);
    assert.equal(manualBundle.content.media_constraints.contract_status, 'unknown');
    assert.equal(manualBundle.content.uses_reference_video, false);
  });

  it('makes project-level director opt-out authoritative across preflight, stages, and stale capture actions', async () => {
    let run = createRun('human');
    run = repo.updateRun(db, run.id, {
      // This is the value emitted by the current UI. Older runs use `off`;
      // both must have identical stage and preflight semantics.
      policy: { ...run.policy, director_mode: 'disabled' },
    });
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Long shot without director',
      content: {
        number: 1,
        title: 'Long shot without director',
        duration: 8,
        route_profile: 'long_previs_guided',
        previs_mode: 'force',
        transition_mode: 'opening',
        action: 'Complete one continuous walk.',
        visual: 'A stable wide composition.',
        video_prompt: 'Complete the walk within this clip.',
        included: true,
      },
      status: 'approved',
    });
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_images',
      scope_type: 'shot',
      scope_id: '1',
      title: 'Approved frame',
      content: { source_artifact_id: shot.id, included: true },
      status: 'approved',
      media_path: 'images/no-director.png',
    });
    run = repo.updateRun(db, run.id, {
      current_stage: 'storyboard_images',
      current_scope_type: 'shot',
      current_scope_id: '1',
      status: 'waiting_review',
    });
    const service = createProductionService(db, {}, log);
    const transitioned = service.transition(run.id, { next_stage_strategy: 'auto_generate' });
    assert.equal(transitioned.run.current_stage, 'reference_bundle');
    const skippedStages = db.prepare(`
      SELECT stage FROM production_events
      WHERE run_id = ? AND event_type = 'stage.skipped'
      ORDER BY id
    `).all(run.id).map((item) => item.stage);
    assert.deepEqual(skippedStages, ['director_plan', 'director_preview']);

    const preflight = service.preflight(run.id, { browser: { webgl: false, media_recorder: false } });
    assert.equal(preflight.checks.find((item) => item.key === 'webgl').ok, true);
    assert.equal(preflight.checks.find((item) => item.key === 'media_recorder').ok, true);

    run = repo.updateRun(db, run.id, {
      current_stage: 'director_plan',
      current_scope_type: 'shot',
      current_scope_id: '1',
      status: 'waiting_review',
    });
    await assert.rejects(
      service.addManualArtifact(run.id, {
        stage: 'director_plan',
        source_artifact_id: shot.id,
        content: { scene_summary: 'Must not be accepted' },
      }),
      (error) => error.code === 'DIRECTOR_DISABLED'
    );

    const capture = repo.reserveAction(db, {
      run_id: run.id,
      action_key: 'stale-director-capture',
      stage: 'director_preview',
      scope_type: 'shot',
      scope_id: '1',
      kind: 'client_capture',
      attempt: 1,
      request: { client_token: 'stale-token', source_artifact_id: 999, expected_duration: 8 },
    }).action;
    repo.updateAction(db, capture.id, { status: 'waiting' });
    run = repo.updateRun(db, run.id, {
      current_stage: 'director_preview',
      status: 'waiting_client',
      runtime: { ...run.runtime, client_action_id: capture.id },
    });
    const advanced = await service.advance(run.id);
    assert.equal(advanced.run.current_stage, 'reference_bundle');
    assert.equal(repo.getAction(db, capture.id).status, 'cancelled');
    assert.equal(repo.getAction(db, capture.id).result.cancelled_reason, 'director_disabled_for_run');
    assert.equal(repo.getRun(db, run.id).runtime.client_action_id, null);
    await assert.rejects(
      service.acceptClientResult(run.id, {
        action_id: capture.id,
        token: 'stale-token',
        media_path: 'previews/stale.webm',
      }),
      (error) => error.code === 'DIRECTOR_DISABLED'
    );
  });

  it('repairs one invalid director JSON response without creating a second action', async () => {
    const run = createRun('human');
    const shot = repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '3',
      title: 'Seal',
      content: {
        number: 3,
        duration: 5,
        action: 'Seal the dog spirit',
        visual: 'front-side low angle',
        camera_movement: 'fixed camera',
        character_names: ['Lan Yin'],
        scene_name: 'Night street',
        prop_names: ['peachwood-sword'],
        included: true,
      },
      status: 'approved',
    });
    repo.updateRun(db, run.id, {
      current_stage: 'director_plan', current_scope_type: 'shot', current_scope_id: '3', status: 'running',
    });
    const invalid = JSON.stringify({
      active_camera_id: 'camera-1',
      objects: [
        { id: 'camera-1', kind: 'camera', props: { aim_mode: 'rotation' } },
        { id: 'actor', kind: 'character', props: { profile_id: 'human.adult.female' } },
        {
          id: 'peachwood-sword', kind: 'procedural',
          props: {
            attach_to: 'actor', attach_anchor: 'right_hand', recipe: { nodes: [{ shape: 'box' }] },
          },
        },
      ],
      timeline: { duration: 5, keyframes: [{ object_id: 'peachwood-sword', time: 0, position: [1, 2, 3] }] },
    });
    const valid = JSON.stringify({
      version: 2,
      active_camera_id: 'camera-1',
      objects: [
        { id: 'camera-1', kind: 'camera', props: { aim_mode: 'rotation' } },
        { id: 'actor', kind: 'character', props: { profile_id: 'human.adult.female' } },
        {
          id: 'peachwood-sword', kind: 'procedural',
          props: {
            attach_to: 'actor', attach_anchor: 'right_hand', recipe: { nodes: [{ shape: 'box' }] },
          },
        },
      ],
      timeline: { duration: 5, keyframes: [{ object_id: 'peachwood-sword', time: 0, local_rotation: [0, 0.4, 0] }] },
    });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([invalid, valid], calls),
    });
    const result = await service.advance(run.id, { lease_owner: 'director-repair' });
    assert.equal(result.state, 'progressed');
    assert.equal(calls.length, 2);
    assert.match(calls[1].system, /world keyframes/);
    const action = repo.listActions(db, run.id, { page_size: 200 }).items
      .find((item) => item.stage === 'director_plan');
    assert.equal(action.status, 'completed');
    assert.equal(action.result.normalization_repair_attempts, 1);
    const artifact = repo.listArtifacts(db, run.id, { stage: 'director_plan', current: true }).items[0];
    assert.equal(artifact.status, 'draft');
    const swordFrame = artifact.content.document.timeline.keyframes.find((frame) => frame.object_id === 'peachwood-sword');
    assert.deepEqual(swordFrame.local_rotation, [0, 0.4, 0]);
    assert.equal(Object.hasOwn(swordFrame, 'position'), false);
    assert.equal(Number(artifact.content.source_artifact_id), Number(shot.id));
  });

  it('keeps a director action failed after two invalid JSON responses', async () => {
    const run = createRun('human');
    repo.createArtifact(db, {
      run_id: run.id,
      stage: 'storyboard_plan',
      scope_type: 'shot',
      scope_id: '3',
      title: 'Seal',
      content: { number: 3, duration: 5, action: 'Seal', visual: 'front', included: true },
      status: 'approved',
    });
    repo.updateRun(db, run.id, {
      current_stage: 'director_plan', current_scope_type: 'shot', current_scope_id: '3', status: 'running',
    });
    const invalid = JSON.stringify({
      active_camera_id: 'camera-1',
      objects: [
        { id: 'camera-1', kind: 'camera', props: {} },
        { id: 'actor', kind: 'character', props: { profile_id: 'human.adult.female' } },
        { id: 'sword', kind: 'procedural', props: { attach_to: 'actor', recipe: { nodes: [{ shape: 'box' }] } } },
      ],
      timeline: { duration: 5, keyframes: [{ object_id: 'sword', time: 0, position: [1, 2, 3] }] },
    });
    const calls = [];
    const service = createProductionService(db, {}, log, {
      generateText: scriptedAdapter([invalid, invalid], calls),
    });
    await assert.rejects(() => service.advance(run.id, { lease_owner: 'director-repair-fail' }), /world keyframes/);
    assert.equal(calls.length, 2);
    const action = repo.listActions(db, run.id, { page_size: 200 }).items
      .find((item) => item.stage === 'director_plan');
    assert.equal(action.status, 'failed');
    assert.equal(repo.getRun(db, run.id).status, 'failed');
  });
});
