'use strict';
// Dedicated child: its entire FFmpeg process tree can be stopped by the owner.
process.once('message', async data => {
  const Database = require('better-sqlite3');
  const db = new Database(data.database);
  db.pragma('busy_timeout = 5000');
  let receipt;
  try {
    await require('../videoMergeService').processVideoMerge(db, { info() {}, warn() {}, error() {} }, data.merge_id, data.storage?.base_url, data.storage?.local_path);
    receipt = { ok: true };
  } catch (error) { receipt = { ok: false, error: error.message }; }
  finally { db.close(); }
  process.send(receipt, () => process.disconnect());
});
