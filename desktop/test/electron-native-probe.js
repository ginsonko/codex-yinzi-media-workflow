'use strict';

const { app } = require('electron');

app.whenReady().then(async () => {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('create table probe(value integer); insert into probe values (1)');
    const row = db.prepare('select value from probe').get();
    db.close();
    if (row.value !== 1) throw new Error('better-sqlite3 probe returned an unexpected row');

    const sharp = require('sharp');
    const buffer = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#14372d' },
    }).png().toBuffer();
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buffer.subarray(0, pngSignature.length).equals(pngSignature)) {
      throw new Error('sharp probe returned an invalid PNG signature');
    }
    const metadata = await sharp(buffer).metadata();
    if (metadata.format !== 'png' || metadata.width !== 32 || metadata.height !== 32) {
      throw new Error('sharp probe returned unexpected PNG metadata');
    }

    console.log(JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      modules: process.versions.modules,
      sqlite: 'ok',
      sharp: 'ok',
      png_bytes: buffer.length,
    }));
    app.quit();
  } catch (error) {
    console.error(error.stack || error.message || error);
    app.exit(1);
  }
});
