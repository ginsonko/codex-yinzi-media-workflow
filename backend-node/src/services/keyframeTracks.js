'use strict';

const EASINGS = Object.freeze(['linear', 'hold', 'ease-in', 'ease-out', 'ease-in-out']);
const PROPERTY_RANGES = Object.freeze({
  x: [-20000, 20000], y: [-20000, 20000],
  scale_x: [0.01, 20], scale_y: [0.01, 20],
  rotation: [-36000, 36000], opacity: [0, 1],
});
const MAX_KEYFRAMES = 100;
const fail = message => Object.assign(new Error(message), { code: 'KEYFRAME_TRACK_INVALID' });

function finite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(`${label} must be a finite number`);
  return value;
}

function normalizeTrack(frames, { name = 'track', duration, range = [-Infinity, Infinity] } = {}) {
  if (!Array.isArray(frames) || !frames.length || frames.length > MAX_KEYFRAMES) {
    throw fail(`${name} must contain 1-${MAX_KEYFRAMES} keyframes`);
  }
  let previous = -Infinity;
  return frames.map((frame, index) => {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw fail(`${name}[${index}] is invalid`);
    const time = finite(frame.time, `${name}[${index}].time`);
    const value = finite(frame.value, `${name}[${index}].value`);
    const easing = frame.easing ?? 'linear';
    if (time < 0 || time <= previous || (duration != null && time > duration)) throw fail(`${name} times must increase within the layer duration`);
    if (value < range[0] || value > range[1]) throw fail(`${name} value must be between ${range.join(' and ')}`);
    if (!EASINGS.includes(easing)) throw fail(`${name} has unsupported easing: ${easing}`);
    previous = time;
    return { time, value, easing };
  });
}

function normalizeAnimation(animation, duration) {
  if (animation == null) return {};
  if (typeof animation !== 'object' || Array.isArray(animation)) throw fail('animation must be an object of property tracks');
  const result = {};
  for (const [name, frames] of Object.entries(animation)) {
    if (!Object.hasOwn(PROPERTY_RANGES, name)) throw fail(`Unsupported animation property: ${name}`);
    result[name] = normalizeTrack(frames, { name, duration, range: PROPERTY_RANGES[name] });
  }
  return result;
}

function ease(easing, t) {
  if (easing === 'hold') return 0;
  if (easing === 'ease-in') return t * t;
  if (easing === 'ease-out') return 1 - (1 - t) ** 2;
  if (easing === 'ease-in-out') return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  return t;
}

function valueAt(frames, time) {
  finite(time, 'sample time');
  if (time <= frames[0].time) return frames[0].value;
  for (let i = 1; i < frames.length; i++) {
    if (time < frames[i].time) {
      const a = frames[i - 1], b = frames[i];
      return a.value + (b.value - a.value) * ease(a.easing, (time - a.time) / (b.time - a.time));
    }
  }
  return frames.at(-1).value;
}

// Only internal clocks and normalized numeric values enter filter expressions.
function expression(frames, clock = 't', offset = 0, fps = 24) {
  if (!['t', 'T', 'n'].includes(clock)) throw fail('Unsupported keyframe clock');
  finite(offset, 'clock offset'); finite(fps, 'fps');
  if (fps <= 0) throw fail('fps must be positive');
  const time = clock === 'n' ? `(n/${fps})` : `(${clock}-(${offset}))`;
  const segment = i => {
    const a = frames[i], b = frames[i + 1];
    if (!b || a.easing === 'hold' || a.value === b.value) return String(a.value);
    const t = `((${time}-${a.time})/${b.time - a.time})`;
    const eased = a.easing === 'ease-in' ? `pow(${t},2)`
      : a.easing === 'ease-out' ? `(1-pow(1-${t},2))`
        : a.easing === 'ease-in-out' ? `if(lt(${t},0.5),2*pow(${t},2),1-pow(-2*${t}+2,2)/2)` : t;
    return `(${a.value}+(${b.value - a.value})*(${eased}))`;
  };
  const tree = (lo, hi) => {
    if (lo === hi) return segment(lo);
    const mid = Math.floor((lo + hi) / 2);
    return `if(lt(${time},${frames[mid + 1].time}),${tree(lo, mid)},${tree(mid + 1, hi)})`;
  };
  return `if(lt(${time},${frames[0].time}),${frames[0].value},${tree(0, frames.length - 1)})`;
}

const animationSchema = {
  type: 'object', additionalProperties: false,
  description: 'Independent property tracks. Time is seconds relative to layer start; easing applies to the outgoing segment. Scale and rotation use the layer center.',
  properties: Object.fromEntries(Object.entries(PROPERTY_RANGES).map(([name, range]) => [name, {
    type: 'array', minItems: 1, maxItems: MAX_KEYFRAMES,
    items: { type: 'object', required: ['time', 'value'], properties: {
      time: { type: 'number', minimum: 0 },
      value: { type: 'number', minimum: range[0], maximum: range[1] },
      easing: { type: 'string', enum: EASINGS, default: 'linear' },
    } },
  }])),
};

module.exports = { normalizeTrack, normalizeAnimation, valueAt, expression, animationSchema, EASINGS, PROPERTY_RANGES };