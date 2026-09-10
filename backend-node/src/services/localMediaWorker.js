// Isolated image process: native library locks leave with the process.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { getOperation } = require('./localMediaOperations');
async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const op = getOperation(job.module_id);
  if (!op || (op.kind !== 'image' && !op.processFile)) throw Error('未知本地操作');
  const requireComponent = createRequire(path.join(job.component_dir, 'package.json'));
  if (op.processFile) {
    const requireComponents = Object.fromEntries(Object.entries(job.component_dirs || {}).map(([id, directory]) => [id, createRequire(path.join(directory, 'package.json'))]));
    const result = await op.processFile({inputPath:job.input_path,outputPath:job.output_path,parameters:job.parameters||{},requireComponent,requireComponents,componentDir:job.component_dir});
    console.log(JSON.stringify(result));
    return;
  }
  const sharp = requireComponent('sharp'); sharp.cache(false); sharp.concurrency(2);
  const imageOptions = { failOn: 'error', limitInputPixels: 100000000 };
  const original = await sharp(job.input_path, imageOptions).metadata();
  // Materialize orientation before user geometry: a second rotate in one Sharp pipeline overrides the first.
  const input = original.orientation > 1 && original.orientation <= 8
    ? await sharp(job.input_path, imageOptions).autoOrient().png().toBuffer()
    : job.input_path;
  const before = input === job.input_path ? original : await sharp(input, imageOptions).metadata();
  const pipeline=await op.apply(sharp(input, imageOptions), job.parameters || {});
  await pipeline.toFile(job.output_path);
  const output = sharp(job.output_path); const after = await output.metadata(); const stats = await output.stats();
  console.log(JSON.stringify({before:{width:before.width,height:before.height,format:original.format,orientation:original.orientation||1},after:{width:after.width,height:after.height,format:after.format,channels:after.channels,space:after.space},channels:stats.channels.map(c=>({min:c.min,max:c.max,mean:c.mean}))}));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
