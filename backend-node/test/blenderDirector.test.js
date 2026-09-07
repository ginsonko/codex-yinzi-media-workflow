const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CAPABILITY_SCHEMA,
  RENDER_PLAN_SCHEMA,
  SMOKE_PLAN_SCHEMA,
  candidateExecutables,
  detectBlender,
  parseVersion,
  prepareBlenderSmoke,
  prepareBlenderRender,
  runBlenderRender,
  probeOne,
} = require('../src/services/blenderDirector');
const { getModule } = require('../src/services/orchestrationModuleCatalog');

function scene() {
  return {
    version: 2,
    aspect_ratio: '16:9',
    active_camera_id: 'camera',
    objects: [
      { id: 'camera', kind: 'camera', props: { aim_mode: 'rotation' }, position: [4, -4, 3] },
      { id: 'floor', kind: 'plane', props: {} },
      { id: 'actor', kind: 'character', props: { profile_id: 'human.adult.female', motion: 'idle' } },
    ],
    timeline: { duration: 5, keyframes: [] },
  };
}

test('parses only an explicit Blender version prefix', () => {
  assert.deepEqual(parseVersion('Blender 4.5.2\nBuild: test'), { version: '4.5.2', raw: 'Blender 4.5.2' });
  assert.equal(parseVersion('some tool 4.5.2').version, null);
});

test('probes a healthy Blender command without running arbitrary shell code', () => {
  let observed;
  const result = probeOne('fake-blender', {
    timeoutMs: 500,
    spawnSync(executable, args, options) {
      observed = { executable, args, options };
      return { status: 0, stdout: 'Blender 4.3.1\n', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.version, '4.3.1');
  assert.deepEqual(observed.args, ['--version']);
  assert.equal(observed.options.shell, false);
});

test('normalizes probe failure and timeout into actionable capability states', () => {
  const missing = detectBlender({}, {
    candidates: ['missing-blender'],
    now: () => '2026-09-05T00:00:00.000Z',
    spawnSync: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
  });
  assert.equal(missing.schema, CAPABILITY_SCHEMA);
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.reasons[0], 'BLENDER_NOT_FOUND');
  assert.equal(missing.probe.attempts, 1);

  const failed = detectBlender({}, {
    candidates: ['failed-blender'],
    spawnSync: () => ({ status: 2, stdout: '', stderr: 'bad install' }),
  });
  assert.equal(failed.reasons[0], 'BLENDER_PROBE_FAILED');

  const timedOut = detectBlender({}, {
    candidates: ['hung-blender'],
    spawnSync: () => ({ signal: 'SIGTERM', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }),
  });
  assert.equal(timedOut.reasons[0], 'BLENDER_PROBE_TIMEOUT');
});

test('candidate override is bounded and does not scan arbitrary directories', () => {
  assert.deepEqual(candidateExecutables({}, { candidates: ['one', 'one', 'two'] }), ['one', 'two']);
});

test('publishes the smoke bridge as a discoverable, zero-side-effect orchestration module', () => {
  const contract = getModule('director.blender-smoke');
  assert.equal(contract.availability, 'bridge');
  assert.equal(contract.executor, 'local');
  assert.equal(contract.side_effects.filesystem_write, false);
  assert.equal(contract.side_effects.paid, false);
  assert.deepEqual(contract.outputs, ['blender_capability', 'smoke_plan']);
  const renderContract = getModule('director.blender-render');
  assert.equal(renderContract.availability, 'integrated');
  assert.equal(renderContract.side_effects.paid, false);
  assert.deepEqual(renderContract.outputs, ['blend_project', 'rendered_frames', 'glb_preview', 'reference_video', 'render_manifest']);
});

test('prepares a deterministic, no-side-effect smoke plan from the director scene contract', () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-director-plan-'));
  try {
    const result = prepareBlenderSmoke({ storage: { local_path: storageDir } }, {
      request_key: 'session-1:blender-smoke',
      scene: scene(),
    }, {
      candidates: ['fake-blender'],
      now: () => '2026-09-05T00:00:00.000Z',
      spawnSync: () => ({ status: 0, stdout: 'Blender 4.5.0\n', stderr: '' }),
    });
    assert.equal(result.plan_schema, SMOKE_PLAN_SCHEMA);
    assert.equal(result.status, 'ready_to_execute');
    assert.equal(result.executed, false);
    assert.equal(result.side_effects.process_started, false);
    assert.equal(result.side_effects.filesystem_write, false);
    assert.equal(result.side_effects.paid, false);
    assert.equal(result.profile.frames.length, 3);
    assert.equal(result.scene.object_count, 3);
    assert.match(result.command.flags.join(' '), /--disable-autoexec/);
    assert.match(result.command.script, /runtime\/blender\/smoke_scene\.py$/);
    assert.ok(result.artifacts.some((item) => item.key === 'blend'));
    assert.ok(result.artifacts.some((item) => item.key === 'mp4'));
    assert.equal(fs.readdirSync(storageDir).length, 0);

    const repeated = prepareBlenderSmoke({ storage: { local_path: storageDir } }, {
      request_key: 'session-1:blender-smoke', scene: scene(),
    }, {
      candidates: ['fake-blender'],
      now: () => '2026-09-05T00:00:00.000Z',
      spawnSync: () => ({ status: 0, stdout: 'Blender 4.5.0\n', stderr: '' }),
    });
    assert.equal(repeated.plan_id, result.plan_id);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('returns blocked smoke plan when Blender is unavailable and rejects credential-like keys', () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-director-blocked-'));
  try {
    const result = prepareBlenderSmoke({ storage: { local_path: storageDir } }, {
      request_key: 'session-2', scene: scene(),
    }, {
      candidates: ['missing-blender'],
      spawnSync: () => ({ error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
    });
    assert.equal(result.status, 'blocked');
    assert.equal(result.blocked_reason, 'BLENDER_NOT_FOUND');
    assert.equal(result.command, null);
    assert.throws(() => prepareBlenderSmoke({ storage: { local_path: storageDir } }, {
      request_key: 'sk-not-a-key', scene: scene(),
    }, { candidates: ['missing-blender'], spawnSync: () => ({}) }), /不能包含凭据/);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});

test('rejects missing or invalid scenes before capability probing', () => {
  assert.throws(() => prepareBlenderSmoke({}, { request_key: 'session-3' }, {
    spawnSync: () => { throw new Error('must not probe'); },
  }), /需要 scene/);
  assert.throws(() => prepareBlenderSmoke({}, {
    request_key: 'session-4',
    scene: { active_camera_id: 'missing', objects: [], timeline: { duration: 5, keyframes: [] } },
  }, { candidates: ['missing'], spawnSync: () => ({}) }), /导演台方案必须包含/);
});

test('prepares a bounded professional render plan and executes it idempotently', () => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-director-render-'));
  let calls = 0;
  let renderCalls = 0;
  try {
    const input = {
      request_key: 'session-5:shot-1',
      scene: {
        ...scene(),
        timeline: {
          duration: 5,
          keyframes: [
            { object_id: 'camera', time: 0, position: [4, -4, 3] },
            { object_id: 'camera', time: 5, position: [2, -2, 2.5] },
          ],
        },
      },
      max_preview_frames: 6,
      width: 320,
      height: 180,
    };
    const options = {
      candidates: ['fake-blender'],
      now: () => '2026-09-05T00:00:00.000Z',
      spawnSync: (_executable, args) => {
        calls += 1;
        if (args.includes('--python')) {
          renderCalls += 1;
          const outputIndex = args.indexOf('--output');
          const output = args[outputIndex + 1];
          fs.mkdirSync(output, { recursive: true });
          fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ schema: 'yinzi.blender-render-result/v1', status: 'succeeded', frames: ['frames/frame-0001.png'], blend: 'scene.blend', glb: 'scene.glb' }));
        }
        return { status: 0, stdout: 'Blender 5.2.1\\n', stderr: '' };
      },
    };
    const plan = prepareBlenderRender({ storage: { local_path: storageDir } }, input, options);
    assert.equal(plan.schema, RENDER_PLAN_SCHEMA);
    assert.equal(plan.status, 'ready_to_execute');
    assert.equal(plan.executed, false);
    assert.equal(plan.profile.frames.length, 6);
    assert.equal(plan.profile.resolution.width, 320);
    const result = runBlenderRender({ storage: { local_path: storageDir } }, input, { ...options, encodeVideo: false });
    assert.equal(result.executed, true);
    assert.equal(result.status, 'succeeded');
    assert.equal(result.side_effects.paid, false);
    const repeated = runBlenderRender({ storage: { local_path: storageDir } }, input, { ...options, encodeVideo: false });
    assert.equal(repeated.reused, true);
    assert.equal(renderCalls, 1);
  } finally {
    fs.rmSync(storageDir, { recursive: true, force: true });
  }
});
