import { SHOT_IR_SCHEMA_VERSION } from './schema.mjs';

// This parser only groups text and recognizes explicit field labels. Creative
// interpretation belongs to the Agent editing the returned IR, not regex guesses.
export function parseTextToShotIR(text, options = {}) {
  const raw = typeof text === 'string' ? text : '';
  const segments = raw.trim() ? raw.trim().split(/\n+(?=(?:镜头|分镜|Shot)\s*\d+\s*[:：])/i) : [];
  const shots = segments.map((segment, i) => {
    const content = segment.replace(/^(?:镜头|分镜|Shot)\s*\d+\s*[:：]\s*/i, '');
    const shot = {shot_id:i + 1, raw_text:segment, subject:'', action:'', time:null, camera:null, audio:null, style:null, negative:null, references:[], custom_extensions:{}};
    const narrative = [];
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*(主体|画面|subject|动作|action|风格|style|负面约束|负面提示|负面|negative|约束|音效|旁白|配音|台词|声音|audio|运镜|camera|时长|duration)\s*[:：]\s*(.*)$/i);
      if (!match) { narrative.push(line); continue; }
      const key = match[1].toLowerCase(), value = match[2];
      if (/^(主体|画面|subject)$/.test(key)) narrative.push(value);
      else if (/^(动作|action)$/.test(key)) shot.action += (shot.action ? '\n' : '') + value;
      else if (/^(风格|style)$/.test(key)) shot.style = [shot.style, value].filter(Boolean).join('\n');
      else if (/^(负面|约束|negative)/.test(key)) shot.negative = [shot.negative, value].filter(Boolean).join('\n');
      else if (/^(运镜|camera)$/.test(key)) shot.camera = {description:[shot.camera?.description, value].filter(Boolean).join('\n')};
      else if (/^(时长|duration)$/.test(key)) {
        const duration = value.match(/^(\d+(?:\.\d+)?)\s*(?:秒|s|seconds)?\s*$/i);
        if (duration) shot.time = {duration:Number(duration[1])};
        else narrative.push(line); // Mixed timing/prose must never lose the prose.
      } else shot.audio = {description:[shot.audio?.description, value].filter(Boolean).join('\n')};
    }
    shot.subject = narrative.join('\n').trim();
    const refs = new Map();
    for (const match of content.matchAll(/(?:@|\[|(?<![\p{L}\p{N}_]))(图片|图|视频|音频|image|video|audio|ref)\s*(\d+)/giu)) {
      const kind = match[1].toLowerCase();
      const type = ['视频','video'].includes(kind) ? 'video' : ['音频','audio'].includes(kind) ? 'audio' : 'image';
      const index = Number(match[2]);
      refs.set(`${type}:${index}`, {type,index});
    }
    shot.references = [...refs.values()];
    return shot;
  });
  return {version:SHOT_IR_SCHEMA_VERSION, metadata:{source:options.source || 'explicit_fields_parser', original_text:raw}, shots};
}
