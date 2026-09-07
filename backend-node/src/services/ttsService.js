/**
 * TTS 语音合成服务
 * 支持多种 TTS 接口：minimax、内置 Edge Neural 在线客户端、通用 HTTP
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');
const costLedger = require('./productionCostLedger');

function ttsUsageForPrice(price, text) {
  const characters = [...String(text || '')].length;
  if (price?.billing_unit === 'per_request') return { units: 1, characters };
  if (price?.billing_unit === 'per_1k_tokens') {
    return { units: 1, characters, input_tokens: Math.max(1, Math.ceil(characters / 2)), output_tokens: 0 };
  }
  return { units: characters, characters };
}

function reserveTtsCost(db, input = {}) {
  const context = input.cost_context;
  if (!db || !context?.run_id || !context?.idempotency_key) return null;
  const provider = String(input.provider || '').toLowerCase();
  const model = String(input.model || (provider === 'edge' ? 'edge-neural-local' : '')).trim();
  const price = provider === 'edge'
    ? { provider: 'edge', service_type: 'tts', model: model || 'edge-neural-local', group_name: 'local', billing_unit: 'per_character', unit_price_microusd: 0, currency: 'USD', source: 'local-zero-cost' }
    : costLedger.findPrice(db, { provider, service_type: 'tts', model, group_name: context.group_name || '' });
  const usage = ttsUsageForPrice(price, input.text);
  return costLedger.reserve(db, {
    run_id: context.run_id,
    action_id: context.action_id || null,
    idempotency_key: context.idempotency_key,
    provider,
    service_type: 'tts',
    model,
    group_name: context.group_name || '',
    billing_unit: price?.billing_unit || 'unknown',
    units: usage.units,
    usage,
    price,
    note: provider === 'edge' ? '内置 Edge Neural 在线语音，零 API 费用' : '最终剪辑逐段旁白 TTS',
  });
}

function isAmbiguousTtsFailure(error) {
  return /(timeout|timed out|超时|ECONNRESET|ECONNABORTED|EPIPE|socket|network|fetch failed|connection.*closed|aborted)/i.test(`${error?.code || ''} ${error?.message || ''}`);
}

function finishTtsCost(db, reservation, status, input = {}) {
  if (!db || !reservation?.entry?.idempotency_key) return null;
  return costLedger.transition(db, reservation.entry.idempotency_key, status, input);
}

/**
 * 使用 MiniMax T2A v2 合成语音
 */
async function synthesizeWithMinimax(text, voiceId, apiKey, groupId, model) {
  const body = JSON.stringify({
    model: model || 'speech-02-hd',
    text,
    stream: false,
    voice_setting: {
      voice_id: voiceId || 'female-shaonv',
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
    },
    audio_setting: {
      sample_rate: 32000,
      bitrate: 128000,
      format: 'mp3',
      channel: 1,
    },
  });
  const url = `https://api.minimax.chat/v1/t2a_v2?GroupId=${groupId}`;
  return new Promise((resolve, reject) => {
    const reqOpts = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const urlObj = new URL(url);
    const client = urlObj.protocol === 'https:' ? https : http;
    const req = client.request(urlObj, reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`MiniMax TTS HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
          return;
        }
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.base_resp?.status_code !== 0) {
          reject(new Error(`MiniMax TTS error: ${data.base_resp?.status_msg || 'unknown'}`));
          return;
        }
        const audioHex = data.data?.audio;
        if (!audioHex) { reject(new Error('MiniMax TTS 未返回音频')); return; }
        resolve(Buffer.from(audioHex, 'hex'));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 使用 OpenAI TTS API 合成语音（兼容所有 OpenAI 格式的代理）
 * POST {base_url}/audio/speech  body: { model, input, voice, response_format, speed }
 */
async function synthesizeWithOpenai(text, voice, apiKey, baseUrl, model, speed) {
  const url = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '') + '/audio/speech';
  const body = JSON.stringify({
    model: model || 'tts-1',
    input: text,
    voice: voice || 'alloy',
    response_format: 'mp3',
    speed: speed || 1.0,
  });
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
      },
    };
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`OpenAI TTS HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`));
          return;
        }
        resolve(buf);
      });
    });
    const timer = setTimeout(() => { req.destroy(); reject(new Error('OpenAI TTS 请求超时')); }, 120000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    req.write(body);
    req.end();
  });
}

async function synthesizeWithEdge(text, voice, speed, options = {}) {
  const voiceId = voice || 'zh-CN-XiaoyiNeural';
  if (!/^[A-Za-z]{2,3}-[A-Za-z]{2,4}-[A-Za-z0-9]+Neural$/.test(voiceId)) {
    throw new Error('Edge TTS 音色名称无效');
  }
  const rateNumber = Math.min(1.5, Math.max(0.75, Number(speed) || 1));
  const ratePercent = Math.round((rateNumber - 1) * 100);
  const rate = `${ratePercent >= 0 ? '+' : ''}${ratePercent}%`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-tts-'));
  const outputPath = path.join(tempDir, 'speech.mp3');
  try {
    const EdgeTTS = options.EdgeTTS || require('node-edge-tts').EdgeTTS;
    const client = new EdgeTTS({
      voice: voiceId,
      lang: voiceId.split('-').slice(0, 2).join('-'),
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      pitch: 'default',
      rate,
      volume: 'default',
      timeout: Number(options.timeoutMs) || 120000,
    });
    await client.ttsPromise(String(text), outputPath);
    if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 512) {
      throw new Error('Edge TTS 未生成有效 MP3 文件');
    }
    return fs.readFileSync(outputPath);
  } catch (error) {
    const message = String(error?.message || error || '未知错误');
    if (/timeout|timed out|ENOTFOUND|ECONN|network|socket|websocket/i.test(message)) {
      throw new Error(`Edge Neural 在线语音连接失败，请检查网络后重试：${message}`);
    }
    throw new Error(`Edge Neural 语音合成失败：${message}`);
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

function edgeTtsArgs(text, voiceId, rate) {
  return ['--voice', voiceId, '--rate', rate, '--text', String(text), '--write-media'];
}

/**
 * 合成 TTS 并保存到本地文件
 * @returns {{ local_path: string, audio_url: string }}
 */
async function synthesize(db, log, { text, storyboard_id, config, storage_base, voice_id, speed, cost_context }) {
  if (!text || !text.trim()) throw new Error('text 不能为空');
  const aiConfigService = require('./aiConfigService');
  const requestedConfig = config && typeof config === 'object' ? config : null;
  const requestedProvider = String(requestedConfig?.provider || '').toLowerCase();
  const activeConfigs = aiConfigService.listConfigs(db, 'tts').filter((item) => item.is_active);
  const persistedConfig = requestedProvider
    ? activeConfigs.find((item) => String(item.provider || '').toLowerCase() === requestedProvider)
    : activeConfigs.find((item) => item.is_default) || activeConfigs[0];
  const ttsConfig = requestedConfig
    ? { ...(persistedConfig || {}), ...requestedConfig }
    : persistedConfig;
  if (!ttsConfig) throw new Error('未配置 TTS 模型，请在「AI 配置」中添加 service_type=tts 的配置');

  const provider = (ttsConfig.provider || '').toLowerCase();
  let ttsSettings = {};
  try { ttsSettings = JSON.parse(ttsConfig.settings || '{}'); } catch (_) {}
  // 外部传入的 voice_id / speed 优先（海外化场景），否则取配置值
  const voiceId = voice_id || ttsConfig.voice_id || ttsSettings.voice_id || '';
  const groupId = ttsConfig.group_id || ttsSettings.group_id || '';
  const ttsModel = ttsConfig.default_model || (Array.isArray(ttsConfig.model) ? ttsConfig.model[0] : ttsConfig.model) || '';
  const finalSpeed = speed || ttsSettings.speed || 1.0;
  let audioBuffer;
  let costReservation = null;

  if (provider !== 'edge' && !ttsConfig.api_key) {
    throw new Error(`${provider || '当前'} TTS 缺少 API Key，请先完成语音配置`);
  }
  if (provider === 'minimax' && !groupId) {
    throw new Error('MiniMax TTS 缺少 Group ID，请先完成语音配置');
  }

  try {
    costReservation = reserveTtsCost(db, { cost_context, provider, model: ttsModel || (provider === 'edge' ? 'edge-neural-local' : ''), text });
    if (provider === 'edge') {
      audioBuffer = await synthesizeWithEdge(text, voiceId || 'zh-CN-XiaoyiNeural', finalSpeed, {
        timeoutMs: ttsConfig.timeout_ms || ttsSettings.timeout_ms,
      });
    } else if (provider === 'minimax') {
      audioBuffer = await synthesizeWithMinimax(text, voiceId || 'female-shaonv', ttsConfig.api_key, groupId, ttsModel || 'speech-02-hd');
    } else if (provider === 'openai' || ttsConfig.base_url) {
      audioBuffer = await synthesizeWithOpenai(text, voiceId || 'alloy', ttsConfig.api_key, ttsConfig.base_url, ttsModel || 'tts-1', finalSpeed);
    } else {
      throw new Error(`不支持的 TTS provider: ${provider}，目前支持 edge、openai、minimax`);
    }
    finishTtsCost(db, costReservation, 'settled', { usage: { characters: [...String(text)].length, generated_bytes: audioBuffer?.length || 0 } });
  } catch (error) {
    if (costReservation) {
      finishTtsCost(db, costReservation, provider === 'edge' || !isAmbiguousTtsFailure(error) ? 'released' : 'uncertain', { note: String(error.message || 'TTS 失败').slice(0, 500) });
    }
    throw error;
  }

  // 保存到本地
  const audioDir = path.join(storage_base, 'audio');
  if (!fs.existsSync(audioDir)) fs.mkdirSync(audioDir, { recursive: true });
  const filename = `tts_sb${storyboard_id || 'x'}_${randomUUID().slice(0, 8)}.mp3`;
  const filePath = path.join(audioDir, filename);
  fs.writeFileSync(filePath, audioBuffer);
  const localPath = `audio/${filename}`;
  log.info('[TTS] 合成完成', { storyboard_id, local_path: localPath, provider });
  try { const cs = require('./cloudService'); cs.reportUsage('tts', ttsModel || '', '', 0); } catch (_) {}
  return { local_path: localPath };
}

module.exports = { synthesize, synthesizeWithEdge, edgeTtsArgs, synthesizeWithOpenai, synthesizeWithMinimax, finishTtsCost, isAmbiguousTtsFailure, reserveTtsCost, ttsUsageForPrice };
