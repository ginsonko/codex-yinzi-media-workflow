/**
 * 整集合并后的后处理：对白 TTS 轨、解说旁白轨+SRT、右下角文字水印（可组合）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getFfmpegPath, getFfprobePath } = require('../utils/ffmpegPath');

function ffprobeDurationSec(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  if (r.status !== 0) return null;
  const d = parseFloat(String(r.stdout || '').trim());
  return Number.isFinite(d) && d > 0 ? d : null;
}

function formatSrtTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const z = Math.floor(ms % 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)},${String(z).padStart(3, '0')}`;
}

function buildAtempoChain(factor) {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (Math.abs(factor - 1) < 0.002) return null;
  const parts = [];
  let f = factor;
  while (f > 2.001) {
    parts.push('atempo=2');
    f /= 2;
  }
  while (f < 0.499) {
    parts.push('atempo=0.5');
    f /= 0.5;
  }
  parts.push(`atempo=${Math.min(2, Math.max(0.5, f))}`);
  return parts.join(',');
}

function escapeFfmpegPath(absPath) {
  let s = path.resolve(absPath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) s = s.replace(/^([A-Za-z]):/, '$1\\:');
  return s.replace(/'/g, "\\'");
}

function runFfmpeg(args, log, tag) {
  const bin = getFfmpegPath();
  // Post-processing must never wait on an inherited console or an unbounded
  // filter graph; a hung local encoder otherwise leaves a run looking idle.
  const r = spawnSync(bin, ['-nostdin', ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
    killSignal: 'SIGTERM',
  });
  if (r.error) {
    log.warn('merged post: ffmpeg spawn', {
      tag,
      error: r.error.code === 'ETIMEDOUT' ? 'ffmpeg 超时（超过 120 秒）' : r.error.message,
    });
    return false;
  }
  if (r.status !== 0) {
    log.warn('merged post: ffmpeg failed', { tag, stderr: r.stderr?.slice(-1000) });
    return false;
  }
  return true;
}

function writeSilenceMp3(slotSec, outPath, log) {
  return runFfmpeg(
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '6', outPath],
    log,
    'silence'
  );
}

function fitAudioToSlot(inputPath, slotSec, outPath, log) {
  const d = ffprobeDurationSec(inputPath);
  if (d == null || d <= 0.01) return false;
  const eps = 0.06;
  if (d > slotSec + eps) {
    const factor = d / slotSec;
    const chain = buildAtempoChain(factor);
    const af = chain || 'anull';
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', af, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_speed'
    );
  }
  if (d < slotSec - eps) {
    const pad = slotSec - d;
    return runFfmpeg(
      ['-y', '-i', inputPath, '-af', `apad=pad_dur=${pad}`, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_pad'
    );
  }
  try {
    fs.copyFileSync(inputPath, outPath);
    return true;
  } catch (_) {
    return runFfmpeg(
      ['-y', '-i', inputPath, '-t', String(slotSec), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'fit_copy'
    );
  }
}

function concatMp3List(segmentPaths, outPath, log) {
  const listFile = path.join(path.dirname(outPath), `mix_concat_${Date.now()}.txt`);
  try {
    const lines = segmentPaths.map((p) => {
      const normalized = path.resolve(p).replace(/\\/g, '/');
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    });
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');
    return runFfmpeg(
      ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'concat_mix'
    );
  } finally {
    try {
      if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
    } catch (_) {}
  }
}

function alignAudioToVideoDuration(inMp3, videoDur, outPath, log) {
  const n = ffprobeDurationSec(inMp3);
  if (n == null || !Number.isFinite(videoDur) || videoDur <= 0.1) return false;
  const eps = 0.08;
  if (n > videoDur + eps) {
    const factor = n / videoDur;
    const chain = buildAtempoChain(factor);
    if (!chain) {
      try {
        fs.copyFileSync(inMp3, outPath);
        return true;
      } catch (_) {
        return false;
      }
    }
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', chain, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_speed'
    );
  }
  if (n < videoDur - eps) {
    const pad = videoDur - n;
    return runFfmpeg(
      ['-y', '-i', inMp3, '-af', `apad=pad_dur=${pad}`, '-t', String(videoDur), '-c:a', 'libmp3lame', '-q:a', '4', outPath],
      log,
      'align_pad'
    );
  }
  try {
    fs.copyFileSync(inMp3, outPath);
    return true;
  } catch (_) {
    return false;
  }
}

function amixTwoTracks(pathA, pathB, slotSec, outPath, log) {
  return runFfmpeg(
    [
      '-y', '-i', pathA, '-i', pathB,
      '-filter_complex', `[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=2[aout]`,
      '-map', '[aout]',
      '-t', String(slotSec),
      '-c:a', 'libmp3lame', '-q:a', '4',
      outPath,
    ],
    log,
    'amix_seg'
  );
}

function narrationShotBounds(scenes) {
  // Keep editorial cuts on an integer-millisecond grid. Floating-point second
  // accumulation can otherwise move later SRT cues one millisecond before a cut.
  let sceneStartMs = 0;
  return scenes.map((scene, sceneIndex) => {
    const sceneDurationMs = Math.max(200, Math.round((Number(scene.duration) || 5) * 1000));
    const row = {
      scene,
      sceneIndex,
      start: sceneStartMs / 1000,
      end: (sceneStartMs + sceneDurationMs) / 1000,
      duration: sceneDurationMs / 1000,
    };
    sceneStartMs += sceneDurationMs;
    return row;
  });
}

function mergeDuckingIntervals(intervals, videoDur) {
  const bounded = (intervals || []).map((item) => ({
    start: Math.max(0, Number(item.start) - 0.08),
    end: Math.min(videoDur, Number(item.end) + 0.25),
  })).filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
    .sort((left, right) => left.start - right.start);
  const merged = [];
  for (const item of bounded) {
    const previous = merged[merged.length - 1];
    if (previous && item.start <= previous.end + 0.02) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  return merged;
}

function addTimelineDuckingFilters(filters, inputLabel, intervals, videoDur) {
  const merged = mergeDuckingIntervals(intervals, videoDur);
  let current = inputLabel;
  merged.forEach((item, index) => {
    const next = `provider_duck_${index}`;
    filters.push(
      `[${current}]volume=0.32:enable='between(t,${item.start.toFixed(3)},${item.end.toFixed(3)})'[${next}]`
    );
    current = next;
  });
  return current;
}

function speedAudio(inputPath, factor, outputPath, log) {
  const chain = buildAtempoChain(factor);
  if (!chain) {
    fs.copyFileSync(inputPath, outputPath);
    return true;
  }
  return runFfmpeg(
    ['-y', '-i', inputPath, '-af', chain, '-c:a', 'libmp3lame', '-q:a', '3', outputPath],
    log,
    'narration_speed'
  );
}

function createNarrationTimeline(inputs, schedule, videoDur, outPath, log) {
  const args = ['-y'];
  for (const input of inputs) args.push('-i', input);
  const filters = schedule.map((item, index) => (
    `[${index}:a]atrim=duration=${item.slot_duration.toFixed(3)},asetpts=PTS-STARTPTS,adelay=${Math.round(item.start * 1000)}:all=1[a${index}]`
  ));
  const labels = schedule.map((_item, index) => `[a${index}]`).join('');
  filters.push(`${labels}amix=inputs=${schedule.length}:duration=longest:dropout_transition=0,apad=whole_dur=${videoDur},atrim=duration=${videoDur}[narration]`);
  args.push(
    '-filter_complex', filters.join(';'),
    '-map', '[narration]',
    '-t', String(videoDur),
    '-c:a', 'libmp3lame', '-q:a', '3',
    outPath
  );
  return runFfmpeg(args, log, 'narration_timeline');
}

function narrationTtsInput(mergeOpts, scene, index, text, storageRoot) {
  const provider = mergeOpts.narration_voice_provider || 'edge';
  const voiceId = mergeOpts.narration_voice_id || 'zh-CN-XiaoyiNeural';
  return {
    text,
    storyboard_id: null,
    storage_base: storageRoot,
    config: {
      provider,
      voice_id: voiceId,
      ...(mergeOpts.narration_tts_model ? { default_model: mergeOpts.narration_tts_model } : {}),
    },
    voice_id: voiceId,
    speed: Number(mergeOpts.narration_speed) || 1,
    cost_context: mergeOpts.cost_run_id ? {
      run_id: mergeOpts.cost_run_id,
      action_id: mergeOpts.cost_action_id || null,
      group_name: mergeOpts.narration_cost_group || '',
      idempotency_key: `production:${mergeOpts.cost_run_id}:tts:${mergeOpts.cost_action_id || 'merge'}:${scene?.scene_id || index + 1}:${index}`,
    } : null,
  };
}

async function buildDirectNarrationTrack(db, log, options) {
  const { scenes, storageRoot, tempRoot, videoDur, mergeOpts, outputBase } = options;
  const ttsService = options.ttsService || require('./ttsService');
  const rawFiles = [];
  const bounds = narrationShotBounds(scenes);
  for (let index = 0; index < scenes.length; index++) {
    const text = String(scenes[index].narration || '').trim();
    if (!text) continue;
    const synth = await ttsService.synthesize(
      db,
      log,
      narrationTtsInput(mergeOpts, scenes[index], index, text, storageRoot),
    );
    const source = path.join(storageRoot, String(synth.local_path).replace(/\//g, path.sep));
    if (!fs.existsSync(source)) throw new Error(`镜头 ${scenes[index].scene_id || index + 1} 的旁白文件不存在`);
    const raw = path.join(tempRoot, `narration_raw_${index}.mp3`);
    fs.copyFileSync(source, raw);
    const duration = ffprobeDurationSec(raw);
    if (!duration) throw new Error(`镜头 ${scenes[index].scene_id || index + 1} 的旁白时长无法读取`);
    rawFiles.push({
      source: raw,
      duration,
      scene: scenes[index],
      sceneIndex: index,
      text,
      bounds: bounds[index],
    });
  }
  if (!rawFiles.length) throw new Error('已启用旁白，但没有可合成的旁白文本');

  const maxSpeedRatio = Math.min(1.35, Math.max(1, Number(mergeOpts.max_narration_speed_ratio) || 1.2));
  const timelineFiles = [];
  const finalSchedule = [];
  const speedFactors = [];
  for (let index = 0; index < rawFiles.length; index++) {
    const rawFile = rawFiles[index];
    const slotDuration = rawFile.bounds.duration;
    const requiredFactor = Math.max(1, rawFile.duration / slotDuration);
    if (requiredFactor > maxSpeedRatio + 0.002) {
      const shotId = rawFile.scene.scene_id || rawFile.sceneIndex + 1;
      throw new Error(
        `镜头 ${shotId} 的旁白不能在本镜头内读完：语音 ${rawFile.duration.toFixed(2)} 秒，画面 ${slotDuration.toFixed(2)} 秒，需加速 ${requiredFactor.toFixed(2)} 倍，允许上限 ${maxSpeedRatio.toFixed(2)} 倍；请精简这一镜旁白或延长镜头`
      );
    }
    const output = path.join(tempRoot, `narration_timeline_input_${index}.mp3`);
    if (!speedAudio(rawFile.source, requiredFactor, output, log)) throw new Error(`旁白加速失败 #${index + 1}`);
    const actualDuration = ffprobeDurationSec(output);
    if (!actualDuration) throw new Error(`镜头 ${rawFile.scene.scene_id || rawFile.sceneIndex + 1} 的旁白加速后时长无法读取`);
    timelineFiles.push(output);
    speedFactors.push(requiredFactor);
    finalSchedule.push({
      scene: rawFile.scene,
      text: rawFile.text,
      start: rawFile.bounds.start,
      end: Math.min(rawFile.bounds.end, rawFile.bounds.start + actualDuration),
      duration: Math.min(actualDuration, slotDuration),
      slot_start: rawFile.bounds.start,
      slot_end: rawFile.bounds.end,
      slot_duration: slotDuration,
      speed_factor: requiredFactor,
    });
  }

  const narrationPath = `${outputBase}_narration.mp3`;
  if (!createNarrationTimeline(timelineFiles, finalSchedule, videoDur, narrationPath, log)) {
    throw new Error('旁白逐镜锁定时间轴生成失败');
  }
  const subtitleMode = ['off', 'sidecar', 'burn'].includes(mergeOpts.subtitle_mode)
    ? mergeOpts.subtitle_mode
    : 'burn';
  let srtPath = null;
  if (subtitleMode !== 'off') {
    srtPath = `${outputBase}_narration.srt`;
    const lines = [];
    finalSchedule.forEach((item, index) => {
      lines.push(
        String(index + 1),
        `${formatSrtTimestamp(item.start * 1000)} --> ${formatSrtTimestamp(item.end * 1000)}`,
        item.text,
        ''
      );
    });
    fs.writeFileSync(srtPath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
  }
  return {
    narrationPath,
    srtPath,
    schedule: finalSchedule,
    speedFactor: Math.max(1, ...speedFactors),
    speedFactors,
    timingMode: 'shot_locked',
  };
}

function getDrawtextFontOption() {
  const candidates = [];
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    candidates.push(
      path.join(root, 'Fonts', 'msyh.ttc'),
      path.join(root, 'Fonts', 'msyhbd.ttc'),
      path.join(root, 'Fonts', 'simhei.ttf')
    );
  }
  candidates.push('/System/Library/Fonts/PingFang.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      return `:fontfile='${escapeFfmpegPath(p)}'`;
    }
  }
  return '';
}

/**
 * @param {object} mergeOpts — burn_dialogue_audio, burn_narration_subtitles, watermark_text
 */
async function runMergedEpisodePostProcess(db, log, opts) {
  const { mergedAbsPath, storageRoot, scenes, episodeId, mergeOpts = {}, ttsService: injectedTtsService } = opts;
  const wantDial = !!mergeOpts.burn_dialogue_audio;
  const wantNarr = mergeOpts.narration_enabled == null
    ? !!mergeOpts.burn_narration_subtitles
    : !!mergeOpts.narration_enabled;
  const directNarration = wantNarr && scenes.some((scene) => Object.prototype.hasOwnProperty.call(scene, 'narration'));
  const watermarkText = (mergeOpts.watermark_text && String(mergeOpts.watermark_text).trim())
    ? String(mergeOpts.watermark_text).trim().slice(0, 200)
    : '';

  if (!mergedAbsPath || !fs.existsSync(mergedAbsPath) || !Array.isArray(scenes) || scenes.length === 0) {
    return { ok: false, error: '无效合成参数' };
  }

  const needAudio = wantDial || wantNarr;
  if (!needAudio && !watermarkText) {
    return { ok: false, error: 'NO_POST_OPTS' };
  }

  const videoDur = ffprobeDurationSec(mergedAbsPath);
  if (videoDur == null) {
    return { ok: false, error: '无法读取合成视频时长' };
  }

  const tempRoot = path.join(require('os').tmpdir(), 'drama-merged-post', String(episodeId || 0), String(Date.now()));
  fs.mkdirSync(tempRoot, { recursive: true });
  const ttsService = injectedTtsService || require('./ttsService');

  try {
    let alignedAudioPath = null;
    let srtPath = null;
    let srtLines = [];
    let narrationReceipt = null;
    let narrationIntervals = [];
    const baseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
    const outAbs = path.join(path.dirname(mergedAbsPath), `${baseName}_post.mp4`);
    const outputBase = outAbs.replace(/\.mp4$/i, '');

    if (directNarration) {
      narrationReceipt = await buildDirectNarrationTrack(db, log, {
        scenes, storageRoot, tempRoot, videoDur, mergeOpts, outputBase, ttsService: injectedTtsService,
      });
      alignedAudioPath = narrationReceipt.narrationPath;
      srtPath = narrationReceipt.srtPath;
      narrationIntervals = narrationReceipt.schedule.map((item) => ({ start: item.start, end: item.end }));
    } else if (needAudio) {
      let tMs = 0;
      let srtIdx = 1;
      const segmentFiles = [];

      for (let i = 0; i < scenes.length; i++) {
        const sc = scenes[i];
        const sbId = Number(sc.scene_id);
        const slotSec = Math.max(0.2, Number(sc.duration) || 5);
        const row = db.prepare(
          'SELECT dialogue, narration, audio_local_path, narration_audio_local_path FROM storyboards WHERE id = ? AND deleted_at IS NULL'
        ).get(sbId);

        const narrText = (row?.narration && String(row.narration).trim()) ? String(row.narration).trim() : '';
        if (wantNarr && narrText) {
          const durMs = Math.round(slotSec * 1000);
          srtLines.push(String(srtIdx++), `${formatSrtTimestamp(tMs)} --> ${formatSrtTimestamp(tMs + durMs)}`, narrText, '');
          narrationIntervals.push({ start: tMs / 1000, end: (tMs + durMs) / 1000 });
        }
        tMs += Math.round(slotSec * 1000);

        const diaFit = path.join(tempRoot, `dia_fit_${i}.mp3`);
        const narrFit = path.join(tempRoot, `narr_fit_${i}.mp3`);
        const segOut = path.join(tempRoot, `seg_mix_${i}.mp3`);

        if (wantDial) {
          const rel = row?.audio_local_path && String(row.audio_local_path).trim();
          const srcAbs = rel ? path.join(storageRoot, rel.replace(/\//g, path.sep)) : null;
          if (srcAbs && fs.existsSync(srcAbs)) {
            if (!fitAudioToSlot(srcAbs, slotSec, diaFit, log)) {
              return { ok: false, error: `对白配音时长对齐失败 #${i}` };
            }
          } else if (!writeSilenceMp3(slotSec, diaFit, log)) {
            return { ok: false, error: `对白静音片段失败 #${i}` };
          }
        }

        if (wantNarr) {
          if (!narrText) {
            if (!writeSilenceMp3(slotSec, narrFit, log)) {
              return { ok: false, error: `旁白静音片段失败 #${i}` };
            }
          } else {
            const segRaw = path.join(tempRoot, `narr_raw_${i}.mp3`);
            let synth;
            try {
              synth = await ttsService.synthesize(
                db,
                log,
                narrationTtsInput(mergeOpts, sc, i, narrText, storageRoot),
              );
            } catch (e) {
              log.warn('merged post: narration TTS failed', { segment: i, error: e.message });
              return { ok: false, error: `解说旁白 TTS 失败：${e.message}` };
            }
            const narrAbs = path.join(storageRoot, synth.local_path.replace(/\//g, path.sep));
            if (!fs.existsSync(narrAbs)) {
              return { ok: false, error: `旁白 TTS 文件不存在` };
            }
            try {
              fs.copyFileSync(narrAbs, segRaw);
            } catch (_) {
              return { ok: false, error: '复制旁白 TTS 失败' };
            }
            if (!fitAudioToSlot(segRaw, slotSec, narrFit, log)) {
              return { ok: false, error: `旁白时长对齐失败 #${i}` };
            }
          }
        }

        if (wantDial && wantNarr) {
          if (!amixTwoTracks(diaFit, narrFit, slotSec, segOut, log)) {
            return { ok: false, error: `对白与旁白混音失败 #${i}` };
          }
        } else if (wantDial) {
          try {
            fs.copyFileSync(diaFit, segOut);
          } catch (_) {
            return { ok: false, error: `对白片段复制失败 #${i}` };
          }
        } else if (wantNarr) {
          try {
            fs.copyFileSync(narrFit, segOut);
          } catch (_) {
            return { ok: false, error: `旁白片段复制失败 #${i}` };
          }
        }

        segmentFiles.push(segOut);
      }

      const concatOut = path.join(tempRoot, 'full_mix.mp3');
      if (!concatMp3List(segmentFiles, concatOut, log)) {
        return { ok: false, error: '音轨拼接失败' };
      }

      alignedAudioPath = path.join(tempRoot, 'aligned_mix.mp3');
      if (!alignAudioToVideoDuration(concatOut, videoDur, alignedAudioPath, log)) {
        return { ok: false, error: '音轨与视频总时长对齐失败' };
      }

      if (wantNarr && srtLines.length > 0) {
        const baseName = path.basename(mergedAbsPath, path.extname(mergedAbsPath));
        srtPath = path.join(path.dirname(mergedAbsPath), `${baseName}_narration.srt`);
        fs.writeFileSync(srtPath, `\uFEFF${srtLines.join('\n')}\n`, 'utf8');
      }
    }

    const shouldBurnSubtitles = mergeOpts.subtitle_mode == null
      ? true
      : mergeOpts.subtitle_mode === 'burn';
    const hasSubs = shouldBurnSubtitles && !!(srtPath && fs.existsSync(srtPath));
    const hasWm = !!watermarkText;

    const vfParts = [];
    if (hasSubs) {
      const subEsc = escapeFfmpegPath(srtPath);
      vfParts.push(`subtitles='${subEsc}':charenc=UTF-8`);
    }
    if (hasWm) {
      const wmFile = path.join(tempRoot, 'watermark.txt');
      fs.writeFileSync(wmFile, watermarkText, 'utf8');
      const wmEsc = escapeFfmpegPath(wmFile);
      const fontOpt = getDrawtextFontOption();
      vfParts.push(
        `drawtext=textfile='${wmEsc}':reload=1${fontOpt}:x=w-tw-16:y=h-th-16:fontsize=22:fontcolor=white@0.82:borderw=2:bordercolor=black@0.55`
      );
    }
    let filterComplex = '';
    if (vfParts.length === 1) {
      filterComplex = `[0:v]${vfParts[0]}[vout]`;
    } else if (vfParts.length === 2) {
      filterComplex = `[0:v]${vfParts[0]}[vx];[vx]${vfParts[1]}[vout]`;
    }

    if (needAudio) {
      if (!alignedAudioPath || !fs.existsSync(alignedAudioPath)) {
        return { ok: false, error: '内部错误：缺少对齐音轨' };
      }
      const useDucking = mergeOpts.narration_ducking !== false && wantNarr && narrationIntervals.length > 0;
      const args = [
        '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-i', mergedAbsPath, '-i', alignedAudioPath,
      ];
      const filters = filterComplex ? [filterComplex] : [];
      const hasProviderAudio = ffprobeHasAudio(mergedAbsPath);
      const keepProviderAudio = mergeOpts.keep_provider_audio !== false && hasProviderAudio;
      const providerVolume = Math.min(1.5, Math.max(0, Number(mergeOpts.provider_audio_volume) || 1));
      const narrationVolume = Math.min(2, Math.max(0, Number(mergeOpts.narration_volume) || 1));
      if (keepProviderAudio) {
        filters.push(`[0:a]volume=${providerVolume}[provider_base]`);
        const providerLabel = useDucking
          ? addTimelineDuckingFilters(filters, 'provider_base', narrationIntervals, videoDur)
          : 'provider_base';
        filters.push(`[1:a]volume=${narrationVolume}[narration_gain]`);
        if (useDucking) {
          filters.push(`[narration_gain][${providerLabel}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=duration=${videoDur}[aout]`);
        } else {
          filters.push(`[narration_gain][${providerLabel}]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,atrim=duration=${videoDur}[aout]`);
        }
      } else {
        filters.push(`[1:a]volume=${narrationVolume},atrim=duration=${videoDur}[aout]`);
      }
      args.push('-filter_complex', filters.join(';'));
      args.push('-map', filterComplex ? '[vout]' : '0:v', '-map', '[aout]');
      args.push(
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-threads', '1',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-t', String(videoDur), outAbs
      );
      if (!runFfmpeg(args, log, 'mux_av')) {
        return { ok: false, error: '烧录字幕/水印或混音失败（请确认 ffmpeg 含 libx264）' };
      }
    } else {
      if (!filterComplex) {
        return { ok: false, error: '内部错误：仅水印但无滤镜链' };
      }
      const args = [
        '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
        '-i', mergedAbsPath, '-filter_complex', filterComplex, '-map', '[vout]',
      ];
      if (ffprobeHasAudio(mergedAbsPath)) {
        args.push('-map', '0:a', '-c:a', 'copy');
      } else {
        args.push('-an');
      }
      args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-threads', '1', '-movflags', '+faststart', outAbs);
      if (!runFfmpeg(args, log, 'watermark_only')) {
        return { ok: false, error: '水印烧录失败' };
      }
    }

    if (!fs.existsSync(outAbs)) {
      return { ok: false, error: '输出文件未生成' };
    }

    const relFromRoot = path.relative(storageRoot, outAbs).replace(/\\/g, '/');

    try {
      if (fs.existsSync(mergedAbsPath) && outAbs !== mergedAbsPath) {
        fs.unlinkSync(mergedAbsPath);
      }
    } catch (e) {
      log.warn('merged post: could not remove intermediate', { error: e.message });
    }

    const narrationRelativePath = narrationReceipt?.narrationPath
      ? path.relative(storageRoot, narrationReceipt.narrationPath).replace(/\\/g, '/')
      : null;
    const subtitleRelativePath = narrationReceipt?.srtPath
      ? path.relative(storageRoot, narrationReceipt.srtPath).replace(/\\/g, '/')
      : null;
    log.info('merged post: done', {
      episode_id: episodeId,
      video: relFromRoot,
      narration_audio: narrationRelativePath,
      subtitles: subtitleRelativePath,
    });
    return {
      ok: true,
      relativePath: relFromRoot,
      narrationRelativePath,
      subtitleRelativePath,
      narration_speed_factor: narrationReceipt?.speedFactor || 1,
      narration_speed_factors: narrationReceipt?.speedFactors || [],
      narration_timing_mode: narrationReceipt?.timingMode || null,
      narration_schedule: narrationReceipt?.schedule || [],
    };
  } catch (e) {
    log.warn('merged post: exception', { error: e.message });
    return { ok: false, error: e.message || String(e) };
  } finally {
    try {
      for (const p of fs.readdirSync(tempRoot)) {
        try {
          fs.unlinkSync(path.join(tempRoot, p));
        } catch (_) {}
      }
      fs.rmdirSync(tempRoot);
    } catch (_) {}
  }
}

function ffprobeHasAudio(filePath) {
  const probe = getFfprobePath();
  const r = spawnSync(
    probe,
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', filePath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  );
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

module.exports = {
  runMergedEpisodePostProcess,
  ffprobeDurationSec,
  narrationTtsInput,
};
