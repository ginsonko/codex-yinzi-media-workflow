'use strict';

const { expression } = require('./keyframeTracks');

function animationCanvas(layer) {
  const tracks = layer.animation;
  if (!tracks.scale_x && !tracks.scale_y && !tracks.rotation) return null;
  const maxValue = track => track ? Math.max(...track.map(k => k.value)) : 1;
  const width = Math.max(2, Math.ceil(layer.width * maxValue(tracks.scale_x)));
  const height = Math.max(2, Math.ceil(layer.height * maxValue(tracks.scale_y)));
  const side = Math.ceil(Math.hypot(width, height));
  const canvas = tracks.rotation ? { width: side, height: side } : { width, height };
  if (canvas.width > 8192 || canvas.height > 8192) {
    throw Object.assign(new Error('Animated layer exceeds the 8192 pixel working canvas; reduce layer dimensions or scale'), { code: 'KEYFRAME_TRACK_INVALID' });
  }
  return canvas;
}

function buildLayerAnimation(layer, index, fps, inputLabel) {
  const tracks = layer.animation, filters = [];
  let label = inputLabel;
  const append = (filter, suffix) => {
    const next = `[layer_anim_${index}_${suffix}]`;
    filters.push(`${label}${filter}${next}`); label = next;
  };
  if (tracks.opacity) {
    const alpha = expression(tracks.opacity, 'T', layer.start, fps);
    append(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${alpha})',format=rgba`, 'alpha');
  }
  const canvas = animationCanvas(layer);
  if (canvas) {
    const sx = tracks.scale_x ? expression(tracks.scale_x, 'n', 0, fps) : '1';
    const sy = tracks.scale_y ? expression(tracks.scale_y, 'n', 0, fps) : '1';
    append(`scale=w='max(2,round(${layer.width}*(${sx})))':h='max(2,round(${layer.height}*(${sy})))':eval=frame,format=rgba,pad=w=${canvas.width}:h=${canvas.height}:x=(ow-iw)/2:y=(oh-ih)/2:color=0x00000000:eval=frame`, 'scale');
    if (tracks.rotation) {
      const angle = expression(tracks.rotation, 't', layer.start, fps);
      append(`rotate=angle='(${angle})*PI/180':ow=${canvas.width}:oh=${canvas.height}:c=0x00000000:bilinear=1,format=rgba`, 'rotate');
    }
  }
  const x = tracks.x ? expression(tracks.x, 't', layer.start, fps) : String(layer.x);
  const y = tracks.y ? expression(tracks.y, 't', layer.start, fps) : String(layer.y);
  return {
    filters, label, canvas,
    x: canvas ? `(${x})+(${layer.width}-overlay_w)/2` : x,
    y: canvas ? `(${y})+(${layer.height}-overlay_h)/2` : y,
  };
}

module.exports = { animationCanvas, buildLayerAnimation };
