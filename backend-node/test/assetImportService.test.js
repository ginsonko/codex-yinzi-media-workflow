const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const service = require('../src/services/assetImportService');

let db; let sourceDir; let storageDir; let run;
const log = { info() {}, warn() {}, error() {} };
beforeEach(() => {
  db = new Database(':memory:'); const old = console.log; const oldWarn = console.warn; console.log = () => {}; console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = old; console.warn = oldWarn; }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id,title,created_at,updated_at) VALUES (1,?,?,?)').run('测试剧', now, now);
  db.prepare('INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES (1,1,1,?,?,?)').run('第一集', now, now);
  run = repo.createRun(db, { drama_id: 1, episode_id: 1, idempotency_key: `import-${Date.now()}-${Math.random()}`, input: { story: '导入测试' } }).run;
  sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-import-source-')); storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-import-storage-'));
  fs.writeFileSync(path.join(sourceDir, 'story.txt'), '第一场：少女走进温室。');
  fs.writeFileSync(path.join(sourceDir, 'hero.png'), Buffer.from('image-bytes'));
  fs.writeFileSync(path.join(sourceDir, 'clip.mp4'), Buffer.from('video-bytes'));
});
afterEach(() => { db.close(); fs.rmSync(sourceDir, { recursive: true, force: true }); fs.rmSync(storageDir, { recursive: true, force: true }); });

describe('asset import sessions', () => {
  it('scans mixed files into a persisted preview plan without writing production artifacts', async () => {
    const session = service.createSession(db, { source_label: '测试文件夹', target_run_id: run.id });
    const result = await service.scanSession(db, session.id, { files: [
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt'), candidate_stage: 'script' },
      { relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png'), detected_type: 'character', candidate_stage: 'asset_images', scope_id: 'hero' },
      { relative_path: 'clip.mp4', source_path: path.join(sourceDir, 'clip.mp4'), candidate_stage: 'shot_video', scope_id: '1' },
    ] }, {}, log);
    assert.equal(result.session.status, 'planned'); assert.equal(result.plan.summary.total, 3); assert.equal(result.plan.summary.ready, 3);
    assert.equal(result.plan.ai.used, false); assert.equal(service.listItems(db, session.id).length, 3);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', page_size: 100 }).items.length, 0);
    const recovered = service.getSession(db, session.id); assert.equal(recovered.status, 'planned'); assert.equal(recovered.plan.items[0].detected_type, 'text'); assert.equal(recovered.plan.items[0].candidate_stage, 'script');
  });

  it('gives local-only text imports a reviewable asset destination', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    const result = await service.scanSession(db, session.id, { files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') }] }, {}, log);
    assert.equal(result.plan.items[0].detected_type, 'text');
    assert.equal(result.plan.items[0].candidate_stage, 'asset_text');
    assert.equal(result.plan.items[0].usage_role, 'source_document');
    assert.equal(result.plan.items[0].status, 'ready');
  });
  it('keeps unknown and oversized files as partial/unknown instead of blocking the plan', async () => {
    const unknown = path.join(sourceDir, 'notes.xyz'); fs.writeFileSync(unknown, '???');
    const session = service.createSession(db, { target_run_id: run.id });
    const result = await service.scanSession(db, session.id, { options: { max_file_bytes: 1 }, files: [
      { relative_path: 'notes.xyz', source_path: unknown },
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') },
    ] }, {}, log);
    assert.equal(result.plan.items[0].detected_type, 'unknown'); assert.equal(result.plan.items[0].candidate_stage, null);
    assert.equal(result.plan.items[0].status, 'partial'); assert.equal(result.plan.items[1].status, 'partial');
    assert.equal(result.plan.items[0].metadata.probe_available, undefined);
  });
  it('applies only after explicit confirmation and rollback soft-deletes created artifacts', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    await service.scanSession(db, session.id, { files: [
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt'), candidate_stage: 'script' },
      { relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png'), candidate_stage: 'asset_images', scope_id: 'hero' },
    ] }, {}, log);
    assert.throws(() => service.applySession(db, { storage: { local_path: storageDir } }, session.id, {}), /confirm=true/);
    const applied = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true });
    assert.equal(applied.reused, false); assert.equal(applied.artifacts.length, 2); assert.equal(service.getSession(db, session.id).status, 'applied');
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', page_size: 100 }).items.length, 1);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'asset_images', page_size: 100 }).items.length, 1);
    const repeated = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true }); assert.equal(repeated.reused, true);
    const rolled = service.rollbackSession(db, { storage: { local_path: storageDir } }, session.id); assert.equal(rolled.rolled_back_artifacts.length, 2);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'script', page_size: 100 }).items.length, 0);
    assert.equal(repo.listArtifacts(db, run.id, { stage: 'asset_images', page_size: 100 }).items.length, 0);
    assert.equal(service.getSession(db, session.id).status, 'rolled_back');
  });

  it('returns the committed execution plan with resolved artifact bindings', async () => {
    const session = service.createSession(db, {
      target_run_id: run.id,
      options: {
        template_id: 'image-to-video',
        target_shots: 1,
        user_intent: '让上传图片中的猫娘动起来',
      },
    });
    const scanned = await service.scanSession(db, session.id, {
      options: {
        template_id: 'image-to-video',
        target_shots: 1,
        user_intent: '让上传图片中的猫娘动起来',
      },
      files: [{ relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png') }],
    }, {}, log);
    assert.equal(scanned.plan.execution_plan.subjects.length, 1);
    const applied = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true });
    assert.equal(applied.reused, false);
    assert.ok(applied.execution_plan);
    assert.equal(applied.execution_plan.subjects[0].source_artifact_id, applied.artifacts[0]);
    const persisted = service.getSession(db, session.id);
    assert.equal(persisted.snapshot.execution_plan.subjects[0].source_artifact_id, applied.artifacts[0]);
    const storedRun = repo.getRun(db, run.id);
    assert.equal(storedRun.input.execution_plan.subjects[0].source_artifact_id, applied.artifacts[0]);
    assert.equal(storedRun.policy.execution_plan.subjects[0].source_artifact_id, applied.artifacts[0]);
  });

  it('rebuilds the execution plan from the latest story at apply time instead of keeping an empty draft intent', async () => {
    const session = service.createSession(db, {
      target_run_id: run.id,
      options: { template_id: 'image-to-video', target_shots: 1, user_intent: '' },
    });
    await service.scanSession(db, session.id, {
      options: { template_id: 'image-to-video', target_shots: 1, user_intent: '' },
      files: [{ relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png') }],
    }, {}, log);
    const story = '让上传图片中的猫娘在温室里抬头，保持原图脸部、发型、服装和颜色一致。';
    const applied = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true, user_intent: story });
    const storedRun = repo.getRun(db, run.id);
    assert.equal(storedRun.input.story, story);
    assert.equal(storedRun.input.user_intent, story);
    assert.equal(storedRun.policy.user_intent, story);
    assert.equal(storedRun.input.execution_plan.user_intent, story);
    assert.equal(storedRun.policy.execution_plan.user_intent, story);
    assert.notEqual(storedRun.input.story, '导入素材：测试文件夹。请根据已导入的素材继续完善制作。');
    assert.equal(applied.execution_plan.user_intent, story);
  });

  it('stores an imported subject image in the stable character authority scope', async () => {
    const session = service.createSession(db, {
      target_run_id: run.id,
      options: {
        template_id: 'image-to-video',
        target_shots: 1,
        user_intent: '让上传图片中的猫娘动起来',
      },
    });
    await service.scanSession(db, session.id, {
      options: { template_id: 'image-to-video', target_shots: 1, user_intent: '让上传图片中的猫娘动起来' },
      files: [{ relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png') }],
    }, {}, log);
    const applied = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true });
    const artifact = repo.listArtifacts(db, run.id, { stage: 'asset_images', page_size: 20 }).items[0];
    assert.ok(artifact);
    assert.equal(artifact.scope_type, 'character');
    assert.equal(artifact.scope_id, 'character-1');
    assert.equal(artifact.content.authority, 'uploaded_asset');
    assert.equal(artifact.content.authority_subject_id, applied.execution_plan.subjects[0].id);
    assert.equal(applied.execution_plan.assets[0].artifact_id, artifact.id);
  });
  it('auto-binds an import to the current project when no production run exists', async () => {
    const session = service.createSession(db, { source_label: '当前项目素材', options: { target_drama_id: 1, auto_create_target: true } });
    await service.scanSession(db, session.id, { files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt'), candidate_stage: 'script' }] }, {}, log);
    const applied = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true });
    assert.equal(applied.target_drama_id, 1);
    assert.equal(applied.target_run_created, true);
    assert.ok(applied.target_run_id);
    assert.equal(repo.getRun(db, applied.target_run_id).drama_id, 1);
    assert.equal(service.getSession(db, session.id).target_run_id, applied.target_run_id);
    assert.equal(repo.listArtifacts(db, applied.target_run_id, { stage: 'script', page_size: 20 }).items.length, 1);
  });
  it('creates a draft project and run for a standalone import without a target', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n;
    const session = service.createSession(db, { source_label: '独立素材包' });
    await service.scanSession(db, session.id, { files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt'), candidate_stage: 'script' }] }, {}, log);
    const applied = service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true });
    assert.equal(applied.target_drama_created, true);
    assert.equal(applied.target_run_created, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dramas').get().n, before + 1);
    const run = repo.getRun(db, applied.target_run_id);
    assert.equal(run.status, 'running');
    assert.match(run.input.story, /第一场/);
  });
  it('keeps an imported video out of the final timeline until direct-clip confirmation', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    const scanned = await service.scanSession(db, session.id, { files: [{ relative_path: 'clip.mp4', source_path: path.join(sourceDir, 'clip.mp4'), candidate_stage: 'shot_video', scope_id: '1' }] }, {}, log);
    assert.equal(scanned.plan.items[0].metadata.direct_clip_candidate, true);
    service.applySession(db, { storage: { local_path: storageDir } }, session.id, { confirm: true });
    const artifact = repo.listArtifacts(db, run.id, { stage: 'shot_video', page_size: 20 }).items[0];
    assert.equal(artifact.content.direct_clip_candidate, true);
    assert.equal(artifact.content.included, false);
  });
  it('uses an injected classifier and does not log source text', async () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { classifier_model: 'gpt-5.6-sol' } });
    const seen = []; const result = await service.scanSession(db, session.id, { files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') }] }, {
      classify: async ({ file }) => { seen.push(file.relativePath); return { detected_type: file.ext === '.mp4' ? 'video' : 'script', candidate_stage: file.ext === '.mp4' ? 'shot_video' : 'script', usage_role: file.ext === '.mp4' ? 'reference_or_direct_clip' : 'source_document', direct_clip_candidate: file.ext === '.mp4', template_candidates: [{ id: 'novel-drama', confidence: 0.98 }], confidence: 0.98, evidence: { reason: '内容结构' } }; },
    }, log);
    assert.deepEqual(seen, ['story.txt']); assert.equal(result.plan.ai.used, true); assert.equal(result.plan.items[0].candidate_stage, 'script'); assert.equal(result.plan.items[0].confidence, 0.98); assert.equal(result.plan.items[0].usage_role, 'source_document'); assert.equal(result.plan.items[0].template_candidates[0].id, 'novel-drama');
  });

  it('builds the configured classifier from aiClient default config', async () => {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ai_service_configs
      (service_type,provider,api_protocol,name,base_url,api_key,model,default_model,endpoint,query_endpoint,priority,is_default,is_active,settings,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'text', 'openai', 'openai', '测试文本配置', 'https://example.test/v1', 'test-key',
      JSON.stringify(['gpt-5.6-sol']), 'gpt-5.6-sol', '/chat/completions', '', 0, 1, 1, null, now, now,
    );
    const aiClient = require('../src/services/aiClient');
    const originalGenerateText = aiClient.generateText;
    let seenPrompt = '';
    aiClient.generateText = async (_db, _log, _serviceType, userPrompt) => {
      seenPrompt = String(userPrompt || '');
      return JSON.stringify({
      detected_type: 'script', candidate_stage: 'script', candidate_scope_type: 'run', candidate_scope_id: '',
      usage_role: 'source_document', direct_clip_candidate: false, template_candidates: [], confidence: 0.93, evidence: '正文包含场景描述',
      });
    };
    try {
      const classify = service.createConfiguredClassifier(db, log, { enabled: true, model: 'gpt-5.6-sol' });
      assert.equal(typeof classify, 'function');
      const result = await classify({
        file: { file_name: 'story.txt', relativePath: 'story.txt', ext: '.txt', extension: '.txt', content: { text: '第一场：人物进入房间。' }, mediaMetadata: {} },
        session: { options: { template_id: 'image-to-video', target_shots: 2, user_intent: '让上传图片中的猫娘在雨夜屋顶跳舞' } },
      });
      assert.equal(result.detected_type, 'script');
      assert.equal(result.candidate_stage, 'script');
      assert.equal(result.evidence.source, 'multimodal_ai');
      assert.match(seenPrompt, /让上传图片中的猫娘在雨夜屋顶跳舞/);
      assert.match(seenPrompt, /当前模板：image-to-video/);
      assert.match(seenPrompt, /目标镜头数：2/);
      assert.match(seenPrompt, /图片中的\/上传图中的\/这张图里的主体/);
    } finally {
      aiClient.generateText = originalGenerateText;
    }
  });

  it('passes latest scan context to an injected classifier and preserves its role', async () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { template_id: 'image-to-video', user_intent: '旧意图' } });
    let seenSession = null;
    const result = await service.scanSession(db, session.id, {
      options: { template_id: 'image-to-video', target_shots: 3, target_shots_user_edited: true, user_intent: '让上传图中的猫娘动起来' },
      files: [{ relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png') }],
    }, {
      classify: async ({ session: current }) => {
        seenSession = current;
        return { detected_type: 'image', candidate_stage: 'asset_images', usage_role: 'primary_subject_reference', confidence: 0.99, evidence: { reason: '用户意图指向图片主体' } };
      },
    }, log);
    assert.equal(seenSession.options.target_shots, 3);
    assert.equal(seenSession.options.user_intent, '让上传图中的猫娘动起来');
    assert.equal(result.plan.execution_plan.subjects.length, 1);
    assert.equal(result.plan.execution_plan.assets[0].role, 'primary_subject_reference');
  });

  it('preserves a confirmed action-reference assignment when a later AI pass drifts to a subject', async () => {
    const session = service.createSession(db, {
      target_run_id: run.id,
      options: { template_id: 'dance-action', target_shots: 2, user_intent: '让角色跟随动作参考跳舞' },
    });
    const first = await service.scanSession(db, session.id, {
      options: { template_id: 'dance-action', target_shots: 2, user_intent: '让角色跟随动作参考跳舞' },
      files: [{ relative_path: 'action-reference.mp4', source_path: path.join(sourceDir, 'clip.mp4') }],
    }, {
      classify: async () => ({
        detected_type: 'video', candidate_stage: 'director_preview', usage_role: 'action_reference',
        candidate_scope_type: 'run', candidate_scope_id: '', direct_clip_candidate: false,
        confidence: 0.98, evidence: { reason: '读取到动作节拍和姿态' },
      }),
    }, log);
    assert.equal(first.plan.items[0].usage_role, 'action_reference');
    assert.equal(first.plan.execution_plan.assets[0].role, 'action_reference');

    const second = await service.scanSession(db, session.id, {
      reuse_staged_files: false,
      options: { template_id: 'dance-action', target_shots: 2, user_intent: '让角色跟随动作参考跳舞并加入故事' },
      files: [{ relative_path: 'action-reference.mp4', source_path: path.join(sourceDir, 'clip.mp4') }],
      classifier_enabled: true,
    }, {
      classify: async () => ({
        // Simulate the real failure: the second model pass mistakes the same
        // reference video for a primary subject. That suggestion must remain
        // visible as evidence, while the established role stays authoritative.
        detected_type: 'video', candidate_stage: 'asset_images', usage_role: 'primary_subject_reference',
        candidate_scope_type: 'resource', candidate_scope_id: 'character-1', direct_clip_candidate: true,
        confidence: 0.91, evidence: { reason: '错误地把视频首帧当作主体' },
      }),
    }, log);
    const item = second.plan.items[0];
    assert.equal(item.usage_role, 'action_reference');
    assert.equal(item.direct_clip_candidate, false);
    assert.equal(item.candidate_stage, 'director_preview');
    assert.equal(second.plan.execution_plan.assets[0].role, 'action_reference');
    assert.equal(second.plan.execution_plan.assets[0].direct_clip_candidate, false);
    assert.equal(item.metadata.assignment_preserved, true);
    assert.equal(item.metadata.assignment_source, 'previous_scan');
    assert.equal(item.metadata.assignment_suggestion.usage_role, 'primary_subject_reference');
    assert.equal(second.plan.execution_plan.shots.every((shot) => shot.source !== 'imported_clip'), true);
  });

  it('keeps a user-corrected reference-video role across subsequent reanalysis', async () => {
    const session = service.createSession(db, {
      target_run_id: run.id,
      options: { template_id: 'image-to-video', target_shots: 1, user_intent: '用参考视频指导画面运动' },
    });
    const first = await service.scanSession(db, session.id, {
      options: { template_id: 'image-to-video', target_shots: 1, user_intent: '用参考视频指导画面运动' },
      files: [{ relative_path: 'guide.mp4', source_path: path.join(sourceDir, 'clip.mp4') }],
    }, {
      classify: async () => ({ detected_type: 'video', candidate_stage: 'director_preview', usage_role: 'reference_video', direct_clip_candidate: false, confidence: 0.9 }),
    }, log);
    const edited = service.updatePlan(db, session.id, {
      expected_version: first.session.version,
      items: [{ id: first.items[0].id, usage_role: 'reference_video', candidate_stage: 'director_preview', candidate_scope_type: 'run', candidate_scope_id: '', direct_clip_candidate: false, include: true }],
    });
    const second = await service.scanSession(db, session.id, {
      options: { template_id: 'image-to-video', target_shots: 1, user_intent: '让图片中的角色根据这个视频完成动作' },
      files: [{ relative_path: 'guide.mp4', source_path: path.join(sourceDir, 'clip.mp4') }],
      classifier_enabled: true,
    }, {
      classify: async () => ({ detected_type: 'video', candidate_stage: 'shot_video', usage_role: 'direct_clip', direct_clip_candidate: true, confidence: 0.99 }),
    }, log);
    assert.equal(edited.plan.items[0].metadata.usage_role_source, 'user_confirmed');
    assert.equal(second.plan.items[0].usage_role, 'reference_video');
    assert.equal(second.plan.items[0].direct_clip_candidate, false);
    assert.equal(second.plan.items[0].metadata.assignment_source, 'user_confirmed');
    assert.equal(second.plan.execution_plan.assets[0].role, 'reference_video');
    assert.equal(second.plan.execution_plan.shots[0].source, 'generate');
  });

  it('does not carry an old assignment to a changed file with the same name', async () => {
    const session = service.createSession(db, {
      target_run_id: run.id,
      options: { template_id: 'dance-action', target_shots: 1, user_intent: '使用动作参考' },
    });
    const first = await service.scanSession(db, session.id, {
      options: { template_id: 'dance-action', target_shots: 1, user_intent: '使用动作参考' },
      files: [{ relative_path: 'guide.mp4', source_path: path.join(sourceDir, 'clip.mp4') }],
    }, { classify: async () => ({ detected_type: 'video', candidate_stage: 'director_preview', usage_role: 'action_reference', direct_clip_candidate: false, confidence: 0.9 }) }, log);
    const changedPath = path.join(sourceDir, 'changed-guide.mp4');
    fs.writeFileSync(changedPath, Buffer.concat([fs.readFileSync(path.join(sourceDir, 'clip.mp4')), Buffer.from('changed')]));
    const second = await service.scanSession(db, session.id, {
      options: { template_id: 'dance-action', target_shots: 1, user_intent: '使用动作参考' },
      files: [{ relative_path: 'guide.mp4', source_path: changedPath }],
      classifier_enabled: true,
    }, { classify: async () => ({ detected_type: 'video', candidate_stage: 'shot_video', usage_role: 'direct_clip', direct_clip_candidate: true, confidence: 0.9 }) }, log);
    assert.equal(first.plan.items[0].sha256 === second.plan.items[0].sha256, false);
    assert.equal(second.plan.items[0].usage_role, 'direct_clip');
    assert.equal(second.plan.items[0].metadata.assignment_preserved, undefined);
    try { fs.unlinkSync(changedPath); } catch (_) {}
  });

  it('uses an explicit story shot count before AI and template defaults', async () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { template_id: 'novel-drama', target_shots: 1 } });
    const result = await service.scanSession(db, session.id, {
      options: { template_id: 'novel-drama', target_shots: 1, user_intent: '把这一章改编成四个分镜，保持原作事实' },
      files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') }],
    }, { classify: async () => ({ detected_type: 'script', candidate_stage: 'script', usage_role: 'source_document', confidence: 0.96 }) }, log);
    assert.equal(result.session.options.target_shots, 4);
    assert.equal(result.plan.execution_plan.shots.length, 4);
    assert.equal(result.plan.recommended_settings.target_shots.source, 'user_intent');
    assert.equal(result.plan.recommended_settings.target_shots.applied, true);
  });

  it('uses a template default when the system still owns the shot count', async () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { template_id: 'novel-drama', target_shots: 1 } });
    const result = await service.scanSession(db, session.id, {
      options: { template_id: 'novel-drama', target_shots: 1, user_intent: '把这一章改编为短剧' },
      files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') }],
    }, {}, log);
    assert.equal(result.session.options.target_shots, 4);
    assert.equal(result.plan.execution_plan.shots.length, 4);
    assert.equal(result.plan.recommended_settings.target_shots.source, 'template_default');
  });

  it('never overrides a user-owned shot count with an AI recommendation', async () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { template_id: 'novel-drama', target_shots: 2, target_shots_user_edited: true } });
    const result = await service.scanSession(db, session.id, {
      options: { template_id: 'novel-drama', target_shots: 2, target_shots_user_edited: true, user_intent: '改编这一章' },
      files: [{ relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') }],
    }, { classify: async () => ({ detected_type: 'script', candidate_stage: 'script', usage_role: 'source_document', recommended_target_shots: 4, recommendation_confidence: 0.99, recommendation_reason: '叙事结构适合四镜', confidence: 0.98 }) }, log);
    assert.equal(result.session.options.target_shots, 2);
    assert.equal(result.plan.execution_plan.shots.length, 2);
    assert.equal(result.plan.recommended_settings.target_shots.source, 'user_setting');
  });

  it('keeps a safe current value when AI shot recommendations conflict', () => {
    const resolved = service.resolveManagedTargetShots({ target_shots: 3, template_id: 'free' }, { default_shots: 5 }, [
      { ai: { recommended_target_shots: 4, recommendation_confidence: 0.92 } },
      { ai: { recommended_target_shots: 6, recommendation_confidence: 0.91 } },
    ]);
    assert.equal(resolved.value, 3);
    assert.equal(resolved.source, 'conflicting_ai_suggestions');
  });

  it('does not confuse durations, prices, image counts, or chapter numbers with shot counts', () => {
    assert.equal(service.explicitTargetShots('视频 30 秒，5 张图片，每次 3.5 元，第 2 章'), null);
    assert.deepEqual(service.explicitTargetShots('请设计 12 个镜头'), service.explicitTargetShots('请设计十二镜'));
    assert.equal(service.explicitTargetShots('请设计十二镜').value, 12);
  });

  it('does not create a configured classifier when text config is missing', () => {
    assert.equal(service.createConfiguredClassifier(db, log, { enabled: true }), null);
  });

  it('records that configured multimodal analysis really saw an image and keeps the receipt in the plan', async () => {
    const session = service.createSession(db, { target_run_id: run.id, options: {
      template_id: 'image-to-video', user_intent: '让上传图片中的猫娘动起来', classifier_enabled: true,
    } });
    let visionCalls = 0;
    const result = await service.scanSession(db, session.id, {
      classifier_enabled: true,
      options: { template_id: 'image-to-video', user_intent: '让上传图片中的猫娘动起来' },
      files: [{ relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png') }],
    }, {
      classify: async ({ file }) => {
        visionCalls += 1;
        return { detected_type: 'image', candidate_stage: 'asset_images', usage_role: 'primary_subject_reference', confidence: 0.99,
          evidence: { source: 'multimodal_ai', reason: '观察到角色主体' },
          analysis_receipt: { requested: true, used: true, modality: 'image_or_video_frame', model: 'gpt-5.6-sol', completed_at: new Date().toISOString() } };
      },
    }, log);
    assert.equal(visionCalls, 1);
    assert.equal(result.plan.ai.used, true);
    assert.equal(result.plan.items[0].metadata.analysis_receipt.used, true);
    assert.equal(result.plan.execution_plan.assets[0].role, 'primary_subject_reference');
  });

  it('stages browser uploads behind opaque tokens and scans them without exposing host paths', async () => {
    const session = service.createSession(db, { source_label: '浏览器上传', target_run_id: run.id });
    const uploadTemp = path.join(sourceDir, 'browser-upload.tmp');
    fs.writeFileSync(uploadTemp, '来自浏览器的剧本');
    const staged = service.stageUploadedFiles(db, { storage: { local_path: storageDir } }, session.id, [
      { path: uploadTemp, originalname: 'nested/story.txt', mimetype: 'text/plain' },
    ], ['nested/story.txt']);
    assert.equal(staged.files.length, 1);
    assert.ok(staged.files[0].source_token);
    assert.equal(JSON.stringify(staged).includes(storageDir), false);
    const scanned = await service.scanSession(db, session.id, {
      files: [{ relative_path: staged.files[0].relative_path, source_token: staged.files[0].source_token, candidate_stage: 'script' }],
    }, {}, log);
    assert.equal(scanned.plan.items[0].status, 'ready');
    assert.equal(scanned.plan.items[0].candidate_stage, 'script');
    assert.equal(JSON.stringify(scanned).includes(storageDir), false);
    assert.equal(JSON.stringify(scanned).includes('source_path'), false);
  });

  it('reanalyses a restored browser session from its own staged files without another upload', async () => {
    const session = service.createSession(db, { source_label: '刷新恢复', target_run_id: run.id, options: { user_intent: '旧故事' } });
    const uploadTemp = path.join(sourceDir, 'restored-upload.tmp');
    fs.writeFileSync(uploadTemp, '刷新后仍应复用的素材正文');
    const staged = service.stageUploadedFiles(db, { storage: { local_path: storageDir } }, session.id, [
      { path: uploadTemp, originalname: 'notes/story.txt', mimetype: 'text/plain' },
    ], ['notes/story.txt']);
    await service.scanSession(db, session.id, {
      files: staged.files,
      options: { user_intent: '旧故事' },
    }, {}, log);
    let seenIntent = '';
    const rescanned = await service.scanSession(db, session.id, {
      files: [], reuse_staged_files: true, reuse_relative_paths: ['notes/story.txt'],
      options: { user_intent: '新故事', target_shots: 2, classifier_enabled: true },
      classifier_enabled: true,
    }, { classify: async ({ session: current }) => {
      seenIntent = current.options.user_intent;
      return { detected_type: 'script', candidate_stage: 'script', usage_role: 'source_document', confidence: 0.96, evidence: { reason: '正文' } };
    } }, log);
    assert.equal(seenIntent, '新故事');
    assert.equal(rescanned.plan.summary.total, 1);
    assert.equal(rescanned.plan.items[0].relative_path, 'notes/story.txt');
    assert.equal(rescanned.plan.execution_plan.user_intent, '新故事');
    assert.equal(Object.keys(service.getSession(db, session.id).options.staged_files).length, 1);
    assert.equal(JSON.stringify(rescanned).includes(storageDir), false);
  });

  it('merges a restored staged file with one newly uploaded file without duplicating either', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    const first = path.join(sourceDir, 'first-upload.tmp'); fs.writeFileSync(first, '第一份');
    const stagedFirst = service.stageUploadedFiles(db, { storage: { local_path: storageDir } }, session.id, [
      { path: first, originalname: 'first.txt', mimetype: 'text/plain' },
    ], ['first.txt']);
    const second = path.join(sourceDir, 'second-upload.tmp'); fs.writeFileSync(second, '第二份');
    const stagedSecond = service.stageUploadedFiles(db, { storage: { local_path: storageDir } }, session.id, [
      { path: second, originalname: 'second.txt', mimetype: 'text/plain' },
    ], ['second.txt']);
    const result = await service.scanSession(db, session.id, {
      reuse_staged_files: true, reuse_relative_paths: ['first.txt'], files: stagedSecond.files,
    }, {}, log);
    assert.deepEqual(result.plan.items.map((item) => item.relative_path).sort(), ['first.txt', 'second.txt']);
    assert.equal(result.plan.summary.total, 2);
    assert.equal(Object.keys(service.getSession(db, session.id).options.staged_files).length, 2);
    assert.ok(stagedFirst.files[0].source_token);
  });

  it('preserves the previous plan when every restored staged file has expired', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    const uploadTemp = path.join(sourceDir, 'expiring-upload.tmp'); fs.writeFileSync(uploadTemp, '原计划');
    const staged = service.stageUploadedFiles(db, { storage: { local_path: storageDir } }, session.id, [
      { path: uploadTemp, originalname: 'story.txt', mimetype: 'text/plain' },
    ], ['story.txt']);
    const first = await service.scanSession(db, session.id, { files: staged.files, options: { user_intent: '保留我' } }, {}, log);
    const stagedPath = service.getSession(db, session.id).options.staged_files[staged.files[0].source_token].source_path;
    fs.unlinkSync(stagedPath);
    await assert.rejects(() => service.scanSession(db, session.id, {
      reuse_staged_files: true, reuse_relative_paths: ['story.txt'], files: [], options: { user_intent: '不应覆盖' },
    }, {}, log), /原有整理计划仍保留/);
    assert.equal(service.getSession(db, session.id).plan.execution_plan.user_intent, first.plan.execution_plan.user_intent);
  });

  it('allows explicit per-item type/stage/include edits and rejects stale revisions', async () => {
    const session = service.createSession(db, { target_run_id: run.id });
    const scanned = await service.scanSession(db, session.id, { files: [
      { relative_path: 'story.txt', source_path: path.join(sourceDir, 'story.txt') },
      { relative_path: 'clip.mp4', source_path: path.join(sourceDir, 'clip.mp4') },
    ] }, {}, log);
    const story = scanned.items.find((item) => item.relative_path === 'story.txt');
    const clip = scanned.items.find((item) => item.relative_path === 'clip.mp4');
    const edited = service.updatePlan(db, session.id, { expected_version: scanned.session.version, items: [
      { id: story.id, detected_type: 'script', candidate_stage: 'script', candidate_scope_type: 'run', include: true },
      { id: clip.id, detected_type: 'video', candidate_stage: 'shot_video', candidate_scope_type: 'shot', candidate_scope_id: '2', include: false },
    ] });
    assert.equal(edited.plan.summary.ready, 1);
    assert.equal(edited.plan.summary.excluded, 1);
    assert.equal(edited.items.find((item) => item.id === clip.id).status, 'excluded');
    assert.equal(edited.plan.execution_plan.summary.imported_clip_count, 0);
    assert.equal(service.getSession(db, session.id).plan.execution_plan.summary.imported_clip_count, 0);
    assert.throws(() => service.updatePlan(db, session.id, { expected_version: scanned.session.version, items: [{ id: story.id, candidate_stage: 'asset_text' }] }), /版本/);
  });

  it('persists manual usage changes and rebuilds subject bindings from the edited plan', async () => {
    const session = service.createSession(db, {
      target_run_id: run.id,
      options: { template_id: 'image-to-video', target_shots: 1, user_intent: '让上传图片中的猫娘动起来' },
    });
    const scanned = await service.scanSession(db, session.id, {
      files: [{ relative_path: 'hero.png', source_path: path.join(sourceDir, 'hero.png') }],
    }, {}, log);
    const hero = scanned.items[0];
    const edited = service.updatePlan(db, session.id, {
      expected_version: scanned.session.version,
      items: [{ id: hero.id, detected_type: 'image', candidate_stage: 'asset_images', candidate_scope_type: 'resource', candidate_scope_id: 'hero', usage_role: 'primary_subject_reference', include: true }],
    });
    assert.equal(edited.plan.execution_plan.subjects.length, 1);
    assert.equal(edited.plan.execution_plan.assets[0].role, 'primary_subject_reference');
    const recovered = service.getSession(db, session.id);
    assert.equal(recovered.plan.execution_plan.assets[0].role, 'primary_subject_reference');
    assert.equal(recovered.plan.items[0].metadata.usage_role, 'primary_subject_reference');
  });

  it('cleans only expired browser staging and records an actionable expiry state', () => {
    const session = service.createSession(db, { target_run_id: run.id, options: { staging_ttl_hours: 1 } });
    const stagedRoot = path.join(storageDir, 'imports', '.staging', session.id);
    fs.mkdirSync(stagedRoot, { recursive: true });
    fs.writeFileSync(path.join(stagedRoot, 'opaque.txt'), 'temporary');
    db.prepare('UPDATE asset_import_sessions SET options_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ staged_root: stagedRoot, staged_files: { token: { source_path: path.join(stagedRoot, 'opaque.txt') } }, staging_ttl_hours: 1 }), new Date(Date.now() - 2 * 3600000).toISOString(), session.id);
    const result = service.cleanupExpiredStaging(db, { storage: { local_path: storageDir } }, log);
    assert.equal(result.cleaned, 1);
    assert.equal(fs.existsSync(stagedRoot), false);
    const expired = service.getSession(db, session.id);
    assert.equal(expired.error_code, 'ASSET_IMPORT_STAGING_EXPIRED');
    assert.match(expired.error_message, /重新上传/);
    assert.deepEqual(expired.options.staged_files, {});
  });

  it('keeps sampled frame bytes out of persisted media metadata', () => {
    const serialized = service.serializableMediaMetadata({
      probe_available: true,
      frames: [{ timestamp_seconds: 1.25, bytes: 10, sha256: 'abc', buffer: Buffer.from('secret') }],
    });
    assert.equal(serialized.frames, undefined);
    assert.deepEqual(serialized.sample_frames, [{ timestamp_seconds: 1.25, bytes: 10, sha256: 'abc' }]);
    assert.equal(JSON.stringify(serialized).includes('secret'), false);
  });
});
