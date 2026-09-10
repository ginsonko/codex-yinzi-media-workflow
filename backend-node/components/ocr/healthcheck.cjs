const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const { default: Ocr } = await import('@gutenye/ocr-node');
  const sharp = require('sharp');
  sharp.concurrency(2);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yinzi-ocr-probe-'));
  try {
    const input = path.join(directory, 'blank.png');
    await sharp({create:{width:64,height:64,channels:3,background:'white'}}).png().toFile(input);
    const ocr = await Ocr.create({onnxOptions:{executionProviders:['cpu'],intraOpNumThreads:2,interOpNumThreads:1}});
    const lines = await ocr.detect(input);
    if (!Array.isArray(lines)) throw Error('OCR returned an invalid result');
    console.log(JSON.stringify({engine:'guten-ocr',device:'cpu',blank_line_count:lines.length}));
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
main().catch(error => {console.error(error.message);process.exitCode=1;});
