const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runMergedEpisodePostProcess, ffprobeDurationSec, narrationTtsInput } = require('../src/services/mergedEpisodePostProcess');
const { getFfmpegPath, getFfprobePath, hasLocalFfmpeg, hasLocalFfprobe } = require('../src/utils/ffmpegPath');

let storageDir;
const log = { info() {}, warn() {}, error() {} };

function ffmpeg(args) {
  const result = spawnSync(getFfmpegPath(), ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

beforeEach(() => {
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-narration-mix-'));
});

afterEach(() => {
  fs.rmSync(storageDir, { recursive: true, force: true });
});

describe('final narration post-process', () => {
  it('builds the same model, voice and idempotent cost context for every narration branch', () => {
    const input = narrationTtsInput({
      narration_voice_provider: 'openai',
      narration_voice_id: 'alloy',
      narration_tts_model: 'tts-pro',
      narration_speed: 1.1,
      cost_run_id: 'run-1',
      cost_action_id: 42,
      narration_cost_group: 'standard',
    }, { scene_id: 7 }, 2, '测试旁白', storageDir);
    assert.deepEqual(input.config, { provider: 'openai', voice_id: 'alloy', default_model: 'tts-pro' });
    assert.equal(input.voice_id, 'alloy');
    assert.equal(input.speed, 1.1);
    assert.deepEqual(input.cost_context, {
      run_id: 'run-1', action_id: 42, group_name: 'standard',
      idempotency_key: 'production:run-1:tts:42:7:2',
    });
  });

  it('keeps provider audio, locks narration to shot cuts, and exports MP3/SRT', {
    skip: !hasLocalFfmpeg() || !hasLocalFfprobe(),
  }, async () => {
    const outputDir = path.join(storageDir, 'videos');
    const audioDir = path.join(storageDir, 'audio');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(audioDir, { recursive: true });
    const merged = path.join(outputDir, 'merged.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=0x244b5a:s=640x360:d=4:r=30',
      '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', merged,
    ]);
    const rawDuration = ffprobeDurationSec(merged);
    assert.ok(Math.abs(rawDuration - 4) < 0.2, `raw duration=${rawDuration}`);
    let synthCount = 0;
    const ttsService = {
      async synthesize(_db, _log, input) {
        synthCount += 1;
        const relative = `audio/narration-${synthCount}.mp3`;
        ffmpeg([
          '-f', 'lavfi', '-i', `sine=frequency=${synthCount === 1 ? 660 : 880}:duration=${synthCount === 1 ? 2.2 : 0.8}:sample_rate=48000`,
          '-c:a', 'libmp3lame', '-q:a', '3', '-y', path.join(storageDir, relative.replace(/\//g, path.sep)),
        ]);
        assert.equal(input.config.provider, 'edge');
        assert.equal(input.voice_id, 'zh-CN-XiaoyiNeural');
        assert.equal(input.config.default_model, 'edge-neural-local');
        assert.match(input.cost_context.idempotency_key, /^production:run-test:tts:88:/);
        return { local_path: relative };
      },
    };
    const result = await runMergedEpisodePostProcess(null, log, {
      mergedAbsPath: merged,
      storageRoot: storageDir,
      episodeId: 1,
      scenes: [
        { scene_id: 1, duration: 2.005, narration: '第一段旁白。' },
        { scene_id: 2, duration: 1.995, narration: '第二段旁白。' },
      ],
      mergeOpts: {
        narration_enabled: true,
        narration_voice_provider: 'edge',
        narration_voice_id: 'zh-CN-XiaoyiNeural',
        subtitle_mode: 'sidecar',
        keep_provider_audio: true,
        narration_ducking: true,
        provider_audio_volume: 0.9,
        narration_volume: 1,
        max_narration_speed_ratio: 1.2,
        narration_tts_model: 'edge-neural-local',
        cost_run_id: 'run-test',
        cost_action_id: 88,
      },
      ttsService,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(synthCount, 2);
    const finalVideo = path.join(storageDir, result.relativePath.replace(/\//g, path.sep));
    const narrationAudio = path.join(storageDir, result.narrationRelativePath.replace(/\//g, path.sep));
    const subtitles = path.join(storageDir, result.subtitleRelativePath.replace(/\//g, path.sep));
    assert.equal(fs.existsSync(finalVideo), true);
    assert.equal(fs.existsSync(narrationAudio), true);
    assert.equal(fs.existsSync(subtitles), true);
    const finalDuration = ffprobeDurationSec(finalVideo);
    const narrationDuration = ffprobeDurationSec(narrationAudio);
    assert.ok(Math.abs(narrationDuration - 4) < 0.2, `narration duration=${narrationDuration}`);
    assert.ok(Math.abs(finalDuration - 4) < 0.2, `final duration=${finalDuration}`);
    const srt = fs.readFileSync(subtitles, 'utf8');
    assert.match(srt, /00:00:00,000/);
    assert.match(srt, /00:00:02,005/);
    assert.match(srt, /第一段旁白/);
    const cues = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})/g)]
      .map((match) => ({
        start: (((Number(match[1]) * 60 + Number(match[2])) * 60 + Number(match[3])) * 1000) + Number(match[4]),
        end: (((Number(match[5]) * 60 + Number(match[6])) * 60 + Number(match[7])) * 1000) + Number(match[8]),
      }));
    assert.equal(cues.length, 2);
    assert.ok(cues[0].end <= 2005, `first narration crossed cut: ${cues[0].end}ms`);
    assert.equal(cues[1].start, 2005);
    const probe = spawnSync(getFfprobePath(), [
      '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', finalVideo,
    ], { encoding: 'utf8' });
    assert.equal(String(probe.stdout).trim(), 'aac');
  });

  it('reports the exact shot when narration cannot fit within the configured speed limit', {
    skip: !hasLocalFfmpeg() || !hasLocalFfprobe(),
  }, async () => {
    const outputDir = path.join(storageDir, 'videos');
    const audioDir = path.join(storageDir, 'audio');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.mkdirSync(audioDir, { recursive: true });
    const merged = path.join(outputDir, 'merged.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'color=c=0x244b5a:s=640x360:d=1:r=30',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', merged,
    ]);
    const ttsService = {
      async synthesize() {
        const relative = 'audio/overlong.mp3';
        ffmpeg([
          '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2:sample_rate=48000',
          '-c:a', 'libmp3lame', '-q:a', '3', '-y', path.join(storageDir, relative.replace(/\//g, path.sep)),
        ]);
        return { local_path: relative };
      },
    };

    const result = await runMergedEpisodePostProcess(null, log, {
      mergedAbsPath: merged,
      storageRoot: storageDir,
      episodeId: 1,
      scenes: [{ scene_id: 7, duration: 1, narration: '这一镜旁白明显过长。' }],
      mergeOpts: {
        narration_enabled: true,
        narration_voice_provider: 'edge',
        narration_voice_id: 'zh-CN-XiaoyiNeural',
        subtitle_mode: 'sidecar',
        keep_provider_audio: false,
        max_narration_speed_ratio: 1.2,
      },
      ttsService,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /镜头 7 的旁白不能在本镜头内读完：语音 .* 秒，画面 1\.00 秒，需加速 .* 倍，允许上限 1\.20 倍/);
  });
});
