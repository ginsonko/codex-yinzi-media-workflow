const path = require('node:path');
const {createRequire} = require('node:module');
const backendRequire = createRequire(path.join(__dirname,'../backend-node/package.json'));
async function main() {
  const Database = backendRequire('better-sqlite3');
  const db = new Database(':memory:');
  if (db.prepare('select 42 as value').get().value !== 42) throw new Error('SQLite returned an invalid result');
  db.close();
  const sharp = backendRequire('sharp');
  const png = await sharp({create:{width:2,height:2,channels:3,background:'#227766'}}).png().toBuffer();
  if ((await sharp(png).metadata()).width !== 2) throw new Error('Image processing failed');
  console.log('SQLite and image processing are ready (prebuilt native modules).');
}
main().catch(error => { console.error(error.message);process.exitCode=1; });
