const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const fail = message => Object.assign(new Error(message), {code:'IMAGE_LAYERS_INPUT'});
const blends = ['over','multiply','screen','overlay','darken','lighten','difference','exclusion','add','saturate'];
function numeric(value, fallback, min, max, integer = false) {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max || integer && !Number.isInteger(n)) throw fail(`图层数值应在 ${min}–${max} ${integer ? '整数' : ''}范围内`);
  return n;
}
async function executeNative({inputPath,outputPath,parameters:p = {},components,sources = [],report = () => {}}) {
  const sharp = createRequire(path.join(components['media.sharp'].directory,'package.json'))('sharp');
  const limits = {limitInputPixels:40000000};
  if (!Array.isArray(p.layers) || !p.layers.length || p.layers.length > 64) throw fail('请提供1–64个图层；超大合成可分组后继续');
  const list = sources.length ? sources : [{path:inputPath}];
  const read = index => {
    if (!Number.isInteger(index) || !list[index]) throw fail('图层或蒙版source需要指向有效的sources数字索引');
    return sharp(list[index].path,limits);
  };
  let canvas = await sharp(inputPath,limits).rotate().toColourspace('srgb').ensureAlpha().png().toBuffer();
  const before = await sharp(canvas).metadata(), receipts = [];
  for (const [index, layer] of p.layers.entries()) {
    if (!layer || typeof layer !== 'object') throw fail('图层需要结构化参数');
    const image = read(layer.source).rotate().toColourspace('srgb').ensureAlpha();
    const original = await image.metadata();
    // Metadata dimensions precede EXIF rotation; decode first for the visual canvas dimensions.
    const oriented = await image.raw().toBuffer({resolveWithObject:true});
    const defaultWidth = layer.height != null && layer.width == null ? Math.max(1,Math.round(Number(layer.height)*oriented.info.width/oriented.info.height)) : oriented.info.width;
    const defaultHeight = layer.width != null && layer.height == null ? Math.max(1,Math.round(Number(layer.width)*oriented.info.height/oriented.info.width)) : oriented.info.height;
    const width = numeric(layer.width,defaultWidth,1,20000,true), height = numeric(layer.height,defaultHeight,1,20000,true);
    if (width * height > 40000000) throw fail('单层超过4000万像素，请降低尺寸或分块');
    const fit = layer.fit ?? 'contain', blend = layer.blend ?? 'over', opacity = numeric(layer.opacity,1,0,1);
    if (!['contain','cover','fill'].includes(fit) || !blends.includes(blend)) throw fail('不支持该缩放或混合模式');
    const x = numeric(layer.x,0,-20000,20000,true), y = numeric(layer.y,0,-20000,20000,true);
    const imageData = await sharp(oriented.data,{raw:oriented.info}).resize(width,height,{fit,background:'#00000000'}).ensureAlpha().raw().toBuffer();
    let mask;
    const maskMode = layer.mask_mode ?? 'luminance';
    if (!['luminance','alpha'].includes(maskMode)) throw fail('蒙版模式需要为luminance或alpha');
    if (layer.mask_source != null) mask = await read(layer.mask_source).rotate().toColourspace('srgb').resize(width,height,{fit:'fill'}).ensureAlpha().raw().toBuffer();
    for (let i = 0; i < imageData.length; i += 4) {
      const coverage = !mask ? 1 : maskMode === 'alpha' ? mask[i+3]/255 : (0.2126*mask[i]+0.7152*mask[i+1]+0.0722*mask[i+2])/255 * mask[i+3]/255;
      imageData[i+3] = Math.round(imageData[i+3] * opacity * coverage);
    }
    const left = Math.max(0,x), top = Math.max(0,y), right = Math.min(before.width,x+width), bottom = Math.min(before.height,y+height);
    const visible = right > left && bottom > top;
    if (visible) {
      const clipped = await sharp(imageData,{raw:{width,height,channels:4}}).extract({left:left-x,top:top-y,width:right-left,height:bottom-top}).png().toBuffer();
      canvas = await sharp(canvas).composite([{input:clipped,left,top,blend}]).png().toBuffer();
    }
    receipts.push({index,source:layer.source,source_size:[original.width,original.height],x,y,width,height,fit,blend,opacity,mask_source:layer.mask_source??null,mask_mode:maskMode,visible});
    report({stage:'compositing_layers',message:`已合成 ${index+1}/${p.layers.length} 个图层`,completed:index+1,total:p.layers.length});
  }
  fs.mkdirSync(path.dirname(outputPath),{recursive:true});fs.writeFileSync(outputPath,canvas);
  const after = await sharp(outputPath).metadata();
  return {before:{width:before.width,height:before.height},after:{width:after.width,height:after.height,channels:after.channels},layers:receipts,
    quality_status:'review_required',quality_note:'图层与蒙版合成已完成；需要核对边缘、遮挡关系和构图。'};
}
module.exports = {id:'local.image.composite-layers',title:'多图层与蒙版合成',description:'按顺序叠加本地图片，控制位置、透明度、缩放、混合与亮度/Alpha蒙版，用于局部编辑和产品视觉合成。',
  kind:'image',component_id:'media.sharp',source:'https://sharp.pixelplumbing.com/api-composite/',defaults:{},inputs:['input_path','sources','parameters'],executeNative,
  parameter_schema:{type:'object',required:['layers'],properties:{layers:{type:'array',minItems:1,maxItems:64,title:'有序图层',items:{type:'object',required:['source'],properties:{
    source:{type:'integer',minimum:0},x:{type:'integer',minimum:-20000,maximum:20000},y:{type:'integer',minimum:-20000,maximum:20000},
    width:{type:'integer',minimum:1,maximum:20000},height:{type:'integer',minimum:1,maximum:20000},
    opacity:{type:'number',minimum:0,maximum:1},fit:{type:'string',enum:['contain','cover','fill']},blend:{type:'string',enum:blends},
    mask_source:{type:'integer',minimum:0},mask_mode:{type:'string',enum:['luminance','alpha']}
  }}}}}
};
