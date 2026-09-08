// Isolated image process: native library locks leave with the process.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { getOperation } = require('./localMediaOperations');
async function main() {
  const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const op = getOperation(job.module_id);
  if (!op || op.kind !== 'image') throw Error('未知图像操作');
  const sharp = createRequire(path.join(job.component_dir, 'package.json'))('sharp'); sharp.cache(false); sharp.concurrency(2);
  const before = await sharp(job.input_path, { limitInputPixels: 100000000 }).metadata();
  const pipeline=await op.apply(sharp(job.input_path, { failOn: 'error', limitInputPixels: 100000000 }), job.parameters || {});
  await pipeline.toFile(job.output_path);
  const output = sharp(job.output_path); const after = await output.metadata(); const stats = await output.stats();
  console.log(JSON.stringify({before:{width:before.width,height:before.height,format:before.format},after:{width:after.width,height:after.height,format:after.format,channels:after.channels,space:after.space},channels:stats.channels.map(c=>({min:c.min,max:c.max,mean:c.mean}))}));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
