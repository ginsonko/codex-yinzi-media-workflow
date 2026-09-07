const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
const repo = require('../src/services/productionRepository');
const graph = require('../src/services/productionGraph');
const { createProductionService } = require('../src/services/productionService');
const { createFallbackDirectorDocument } = require('../src/services/productionDirector');
const { getFfmpegPath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');

const log = { info() {}, warn() {}, error() {} };

function runFfmpeg(args) {
  const result = spawnSync(getFfmpegPath(), args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.slice(-2000));
}

function writeImage(filePath, hue) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=1:duration=1',
    '-vf', `hue=h=${hue}`,
    '-frames:v', '1', '-threads', '1', '-y', filePath,
  ]);
}

function writeClip(filePath, hue, frequency) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000:duration=6`,
    '-vf', `hue=h=${hue}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-shortest', '-movflags', '+faststart', '-y', filePath,
  ]);
}

function writePreview(filePath, hue) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  runFfmpeg([
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=6',
    '-vf', `hue=h=${hue}`,
    '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '700k',
    '-an', '-y', filePath,
  ]);
}

function relative(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function setupDatabase() {
  const db = new Database(':memory:');
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try { runMigrationsAndEnsure(db); } finally { console.log = originalLog; console.warn = originalWarn; }
  const now = new Date().toISOString();
  db.prepare('INSERT INTO dramas (id, title, created_at, updated_at, metadata) VALUES (1, ?, ?, ?, ?)').run('星尘温室', now, now, '{}');
  db.prepare('INSERT INTO episodes (id, drama_id, episode_number, title, created_at, updated_at) VALUES (1, 1, 1, ?, ?, ?)').run('第一集', now, now);
  return db;
}

function deterministicVideoCatalog() {
  const group = '特价视频分组(即梦)';
  return {
    pricing_version: 'production-e2e-fixture-v1',
    fetched_at: '2026-08-15T00:00:00.000Z',
    video: [{
      model: 'mg-seedance2.0 -480p mini',
      endpoint_types: ['openai-video'],
      groups: [group],
      prices: [{ group, billing_unit: 'per_second', effective_price: 0.2004 }],
    }],
  };
}

it('runs all 11 production stages with real local media, strict merge, manifest, and ZIP', {
  skip: !hasLocalFfmpeg() || !hasLocalFfprobe(),
  timeout: 180000,
}, async () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-e2e-'));
  const db = setupDatabase();
  try {
    const cfg = { storage: { local_path: storageDir, base_url: 'http://localhost/static' } };
    const imagePaths = Array.from({ length: 6 }, (_, index) => {
      const filePath = path.join(storageDir, 'mock', 'images', `image-${index + 1}.png`);
      writeImage(filePath, index * 45);
      return relative(storageDir, filePath);
    });
    const previewPaths = Array.from({ length: 3 }, (_, index) => {
      const filePath = path.join(storageDir, 'mock', 'previews', `shot-${index + 1}.webm`);
      writePreview(filePath, index * 90);
      return relative(storageDir, filePath);
    });
    const clipPaths = Array.from({ length: 3 }, (_, index) => {
      const filePath = path.join(storageDir, 'mock', 'videos', `shot-${index + 1}.mp4`);
      writeClip(filePath, index * 90, 440 + index * 110);
      return relative(storageDir, filePath);
    });

    const shots = [
      {
        number: 1, title: '进入星尘温室', duration: 6,
        action: '林夏推开气密门，走向中央培养台，蓝色花粉在她身后漂浮。',
        visual: '低机位广角，银白宇航服从画面左侧进入，透明穹顶和蓝色行星完整可见。',
        shot_type: '全景', camera_angle: '低机位', camera_movement: '沿中轴线缓慢推进', lighting: '冷蓝环境光和暖白面光',
        continuity_in: '气密门关闭，林夏双手空置。', continuity_out: '林夏停在培养台左侧，右手伸向种子舱。',
        character_names: ['林夏'], scene_name: '星尘温室', prop_names: ['发光种子'],
        image_prompt: '林夏进入星尘温室的电影分镜。', video_prompt: '低机位推进，林夏进入温室并走向培养台，花粉缓慢漂浮。',
      },
      {
        number: 2, title: '唤醒发光种子', duration: 6,
        action: '林夏抬起右手，发光种子从培养槽升起，在她掌心上方旋转。',
        visual: '中近景越肩构图，种子位于画面黄金分割点，温室结构保持上一镜方向。',
        shot_type: '中近景', camera_angle: '平视', camera_movement: '轻微环绕十五度', lighting: '种子蓝白辉光照亮面罩',
        continuity_in: '林夏在培养台左侧，右手伸向种子舱。', continuity_out: '种子悬浮在林夏右掌上方，警报灯由红转绿。',
        character_names: ['林夏'], scene_name: '星尘温室', prop_names: ['发光种子'],
        image_prompt: '林夏掌心上方悬浮发光种子的电影分镜。', video_prompt: '中近景环绕，种子升起并旋转，辉光扫过林夏面罩。',
      },
      {
        number: 3, title: '星桥在穹顶外展开', duration: 6,
        action: '林夏合拢双手保护种子，穹顶外的粒子汇成通向蓝色行星的光桥。',
        visual: '从人物侧后方拉远到英雄全景，林夏和光桥形成清晰剪影。',
        shot_type: '英雄全景', camera_angle: '略低机位', camera_movement: '平稳拉远并轻微升高', lighting: '光桥金白主光与行星冷蓝轮廓光',
        continuity_in: '种子悬浮在林夏右掌上方，警报灯转绿。', continuity_out: '林夏居中站立，种子稳定发光，光桥完整展开。',
        character_names: ['林夏'], scene_name: '星尘温室', prop_names: ['发光种子'],
        image_prompt: '林夏面对穹顶外光桥的英雄全景电影分镜。', video_prompt: '镜头拉远升高，粒子聚成光桥，林夏合拢双手保护种子。',
      },
    ];
    const screenplay = `# 星尘桥\n\n## 人物\n林夏，年轻宇航员，穿银白宇航服。\n\n## 场景\n月面基地的星尘温室。\n\n## 第一场\n警报响起，林夏进入透明穹顶温室，走向中央培养台。她唤醒最后一颗发光种子，蓝白辉光让警报由红转绿。穹顶外的星尘随之聚拢，形成通往蓝色行星的光桥。林夏保护种子并望向光桥，基地重新获得能源。`;
    const resources = {
      characters: [{
        name: '林夏', role: '主角', description: '年轻宇航员，动作果断克制',
        appearance: '短黑发，左眉小痣，银白宇航服左肩青绿色叶片徽章',
        identity_anchors: ['短黑发', '左眉小痣', '青绿色叶片徽章'],
        continuity_rules: '三幕均穿同一套银白宇航服', visual_prompt: '林夏角色正侧背三视图与面部特写',
      }],
      scenes: [{
        name: '星尘温室', location: '月面基地', time: '夜', description: '透明穹顶、中央培养台、穹顶外蓝色行星',
        spatial_anchors: ['中央培养台', '左侧气密门', '穹顶外蓝色行星'], visual_prompt: '星尘温室空间四视图',
      }],
      props: [{
        name: '发光种子', category: '关键道具', description: '指尖大小的蓝白晶体种子，表面有三道金色纹路',
        continuity_rules: '第二幕起保持蓝白发光', visual_prompt: '发光种子多角度产品设定图',
      }],
    };

    let directorIndex = 0;
    let refinementIndex = 1;
    let imageIndex = 0;
    let videoIndex = 0;
    let generationId = 1000;
    const imageResults = new Map();
    const videoResults = new Map();
    const videoRequests = [];
    const service = createProductionService(db, cfg, log, {
      generateText: async (_user, system) => {
        if (system.includes('输出中文纯文本剧本')) return screenplay;
        if (system.includes('{"characters"') && system.includes('"scenes"') && system.includes('"props"')) {
          return JSON.stringify(resources);
        }
        if (system.includes('{"shots"')) return JSON.stringify({ shots });
        if (/逐镜拍摄现场的连续性导演|continuity editor revising one rough shot/.test(system)) {
          const shot = {
            ...shots[refinementIndex],
            continuity_in: `${shots[refinementIndex - 1].continuity_out}（来自已批准前镜）`,
          };
          refinementIndex += 1;
          return JSON.stringify({ shot });
        }
        if (/3D 预演导演|3D previs director/.test(system)) return JSON.stringify(createFallbackDirectorDocument(shots[directorIndex++]));
        throw new Error(`unexpected text prompt: ${system.slice(0, 80)}`);
      },
      media: {
        fetchVideoCatalog: async () => deterministicVideoCatalog(),
        createImage: async (request) => {
          const id = ++generationId;
          imageResults.set(id, { id, task_id: `mock-image-${id}`, status: 'completed', local_path: imagePaths[imageIndex++], prompt: request.prompt });
          return { id, task_id: `mock-image-${id}` };
        },
        getImage: async (id) => imageResults.get(id),
        createVideo: async (request) => {
          const id = ++generationId;
          videoRequests.push(request);
          videoResults.set(id, { id, task_id: `mock-video-${id}`, provider_task_id: `provider-${id}`, status: 'completed', local_path: clipPaths[videoIndex++] });
          return { id, task_id: `mock-video-${id}` };
        },
        getVideo: async (id) => videoResults.get(id),
      },
    });
    const run = repo.createRun(db, {
      drama_id: 1,
      episode_id: 1,
      idempotency_key: 'real-local-e2e',
      review_owner: 'auto_accept',
      input: { source_type: 'idea', story: '宇航员在星尘温室唤醒种子，并见证通往蓝色行星的光桥展开。' },
      policy: {
        target_shots: 3,
        style: '电影感科幻写实',
        aspect_ratio: '16:9',
        image_model: 'gpt-image-2',
        video_model: 'mg-seedance2.0 -480p mini',
        video_resolution: '480p',
        keep_provider_audio: true,
      },
      budget: {
        max_video_attempts: 10,
        max_video_seconds: 60,
        max_shots: 3,
        max_text_revisions: 2,
        max_image_revisions: 2,
        max_director_revisions: 2,
        max_video_attempts_per_shot: 2,
      },
    }).run;

    const trace = [];
    for (let iteration = 0; iteration < 240; iteration += 1) {
      const current = repo.getRun(db, run.id);
      if (current.status === 'completed') break;
      const outcome = await service.advance(run.id, { lease_owner: `e2e-${iteration}` });
      trace.push({ stage: current.current_stage, state: outcome.state, reason: outcome.reason || null });
      if (outcome.state === 'client_action') {
        const shotIndex = Number(outcome.client_action.shot_id) - 1;
        await service.acceptClientResult(run.id, {
          action_id: outcome.client_action.action_id,
          token: outcome.client_action.token,
          media_path: previewPaths[shotIndex],
          frame_path: imagePaths[3 + shotIndex],
          frame_count: 150,
        });
      } else if (outcome.state === 'failed') {
        throw new Error(`pipeline failed at ${current.current_stage}: ${outcome.reason || repo.getRun(db, run.id).error_message}`);
      }
      if (['waiting_task', 'waiting_provider'].includes(outcome.state)) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    const completed = repo.getRun(db, run.id);
    assert.equal(completed.status, 'completed', JSON.stringify(trace.slice(-20), null, 2));
    assert.deepEqual(completed.usage, { video_attempts_reserved: 3, video_seconds_reserved: 18 });
    for (const stage of graph.STAGES) {
      assert.equal(repo.stageCompletion(db, run.id, stage.key).complete, true, `${stage.key} incomplete`);
      assert.equal(trace.some((item) => item.stage === stage.key), true, `${stage.key} missing from trace`);
    }
    const currentArtifacts = repo.listArtifacts(db, run.id, { current: true, page_size: 200 }).items;
    const count = (stage) => currentArtifacts.filter((item) => item.stage === stage).length;
    assert.equal(count('script'), 1);
    assert.equal(count('asset_text'), 3);
    assert.equal(count('asset_images'), 3);
    assert.equal(count('storyboard_plan'), 3);
    assert.equal(count('storyboard_images'), 3);
    assert.equal(count('director_plan'), 3);
    assert.equal(count('director_preview'), 3);
    assert.equal(count('reference_bundle'), 3);
    assert.equal(count('shot_video'), 3);
    assert.equal(count('final_edit'), 2);
    assert.equal(videoRequests.length, 3);
    assert.equal(videoRequests.every((request) => request.reference_image_urls.length === 4), true);
    // Ordinary editorial hard cuts carry only the current shot's approved
    // previs. A predecessor tail is reserved for an explicit strict take.
    assert.deepEqual(videoRequests.map((request) => request.reference_video_urls.length), [1, 1, 1]);
    const referenceBundles = currentArtifacts
      .filter((item) => item.stage === 'reference_bundle')
      .sort((left, right) => Number(left.scope_id) - Number(right.scope_id));
    assert.deepEqual(
      videoRequests.map((request) => request.reference_video_urls),
      referenceBundles.map((bundle) => bundle.content.videos.map((video) => video.path))
    );
    assert.equal(referenceBundles.every((bundle) => bundle.content.videos.every((video) => (
      video.path.endsWith('.mp4')
      && video.transport.video_codec === 'h264'
      && video.transport.pixel_format === 'yuv420p'
      && video.transport.r_frame_rate === '24/1'
      && video.transport.avg_frame_rate === '24/1'
    ))), true);
    assert.equal(referenceBundles.every((bundle) => (
      bundle.content.reference_video_budget.final_transport_total_seconds
      <= bundle.content.reference_video_budget.target_total_seconds
    )), true);
    assert.equal(videoRequests[0].bundle_artifact_id > 0, true);
    assert.equal(videoRequests[1].bundle_artifact_id > videoRequests[0].bundle_artifact_id, true);
    assert.equal(videoRequests[2].bundle_artifact_id > videoRequests[1].bundle_artifact_id, true);
    assert.equal(videoRequests.every((request) => request.duration === 6), true);
    assert.deepEqual(videoRequests.map((request) => request.transition_mode), ['opening', 'hard_cut', 'hard_cut']);
    assert.equal(videoRequests.every((request) => request.first_frame_url == null), true);

    const approvedShotVideos = currentArtifacts
      .filter((item) => item.stage === 'shot_video')
      .sort((left, right) => Number(left.scope_id) - Number(right.scope_id));
    const refinedPlans = currentArtifacts
      .filter((item) => item.stage === 'storyboard_plan')
      .sort((left, right) => Number(left.scope_id) - Number(right.scope_id));
    assert.equal(refinedPlans[0].revision, 1);
    assert.deepEqual(refinedPlans.map((item) => item.content.transition_mode), ['opening', 'hard_cut', 'hard_cut']);
    assert.equal(refinedPlans.slice(1).every((item) => item.content.cut_motivation && item.content.boundary_prompt), true);
    assert.match(videoRequests[1].prompt, /硬切/);
    assert.equal(refinedPlans[1].content.refined_from_video_artifact_id, approvedShotVideos[0].id);
    assert.equal(refinedPlans[2].content.refined_from_video_artifact_id, approvedShotVideos[1].id);
    assert.equal(repo.listUpstreamArtifactIds(db, refinedPlans[1].id).includes(approvedShotVideos[0].id), true);
    assert.equal(repo.listUpstreamArtifactIds(db, refinedPlans[2].id).includes(approvedShotVideos[1].id), true);
    const orderedActions = repo.listActions(db, run.id, { page_size: 200 }).items.sort((left, right) => left.id - right.id);
    const shot1VideoAction = orderedActions.find((item) => item.stage === 'shot_video' && item.scope_id === '1' && item.kind === 'video_generate');
    const shot2RefineAction = orderedActions.find((item) => item.stage === 'storyboard_plan' && item.scope_id === '2' && item.kind === 'storyboard_refine');
    const shot2ImageAction = orderedActions.find((item) => item.stage === 'storyboard_images' && item.scope_id === '2' && item.kind === 'image_generate');
    assert.ok(shot1VideoAction.id < shot2RefineAction.id);
    assert.ok(shot2RefineAction.id < shot2ImageAction.id);
    assert.ok(new Date(approvedShotVideos[0].approved_at) <= new Date(shot2RefineAction.created_at));
    assert.equal(approvedShotVideos[0].content.boundary_validation.mode, 'opening');
    assert.equal(approvedShotVideos.slice(1).every((item) => item.content.boundary_validation.mode === 'hard_cut'), true);

    const narrationSettings = currentArtifacts.find((item) => item.stage === 'final_edit' && item.content?.kind === 'narration_plan');
    assert.equal(narrationSettings.status, 'approved');
    const final = currentArtifacts.find((item) => item.stage === 'final_edit' && item.content?.kind === 'final_video');
    assert.equal(final.status, 'approved');
    assert.equal(final.content.validation.video_codec, 'h264');
    assert.equal(final.content.validation.audio_codec, 'aac');
    assert.ok(final.content.validation.duration >= 17.5 && final.content.validation.duration <= 19);
    assert.equal(fs.existsSync(path.join(storageDir, final.media_path.replace(/\//g, path.sep))), true);

    const exported = service.exportRun(run.id);
    assert.equal(fs.existsSync(exported.manifest_path), true);
    assert.equal(exported.manifest.files.filter((item) => item.stage === 'shot_video').length, 3);
    const zipped = service.zipRun(run.id);
    assert.equal(fs.existsSync(zipped.zip_path), true);
    assert.ok(fs.statSync(zipped.zip_path).size > 8192);
  } finally {
    db.close();
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
