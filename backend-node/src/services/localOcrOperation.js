const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

async function recognize({inputPath, requireComponent}) {
  const sharp = requireComponent('sharp');
  sharp.cache(false);
  sharp.concurrency(2);
  const before = await sharp(inputPath,{failOn:'error',limitInputPixels:40000000}).metadata();
  const { default: Ocr } = await import(pathToFileURL(requireComponent.resolve('@gutenye/ocr-node')).href);
  const ocr = await Ocr.create({onnxOptions:{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1}});
  const lines = await ocr.detect(inputPath);
  if (!Array.isArray(lines) || !lines.every(line => line && typeof line.text === 'string')) {
    throw Object.assign(Error('文字识别返回格式无效'),{code:'OCR_INVALID_RESULT'});
  }
  const text = lines.map(line => line.text).join('\n').trim();
  if (!text) throw Object.assign(Error('这张图片未识别到文字，原素材已保留；可使用更清晰的文字区域继续'),{code:'OCR_NO_TEXT'});
  return {
    before:{width:before.width,height:before.height,format:before.format},
    after:{format:'txt',line_count:lines.length,character_count:text.length},
    text_preview:text.slice(0,1200),
    lines:lines.map(line => ({...line,confidence:Number.isFinite(line.mean)?line.mean:Number.isFinite(line.score)?line.score:null})),
    quality_status:'review_required',
    quality_note:'已实际提取文字；人名、数字和模糊字符需要对照原图检查。',
  };
}

async function processFile(options) {
  const result = await recognize(options);
  fs.writeFileSync(options.outputPath, result.lines.map(line => line.text).join('\n').trim() + '\n', 'utf8');
  return result;
}

module.exports = {
  id:'local.image.ocr', title:'提取图片中的文字', kind:'document',
  component_id:'vision.ocr', output_extension:'txt', processFile, defaults:{},
  source:'https://github.com/gutenye/ocr', recognize,
};
