const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { findSceneContinuityReference } = require('../src/services/sceneService');

describe('scene continuity reference selection', () => {
  it('uses the earliest completed sibling scene as the project anchor', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE scenes (
      id INTEGER PRIMARY KEY, drama_id INTEGER, local_path TEXT, image_url TEXT, deleted_at TEXT
    )`);
    const insert = db.prepare('INSERT INTO scenes (id, drama_id, local_path, image_url, deleted_at) VALUES (?, ?, ?, ?, ?)');
    insert.run(1, 7, 'projects/7/scenes/master.png', null, null);
    insert.run(2, 7, null, null, null);
    insert.run(3, 7, 'projects/7/scenes/detail.png', null, null);
    insert.run(4, 8, 'projects/8/scenes/other.png', null, null);
    assert.equal(findSceneContinuityReference(db, 7, 2), 'projects/7/scenes/master.png');
    assert.equal(findSceneContinuityReference(db, 7, 1), 'projects/7/scenes/detail.png');
    db.close();
  });

  it('returns null when no completed sibling scene exists', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE scenes (id INTEGER PRIMARY KEY, drama_id INTEGER, local_path TEXT, image_url TEXT, deleted_at TEXT)');
    db.prepare('INSERT INTO scenes (id, drama_id) VALUES (?, ?)').run(1, 7);
    assert.equal(findSceneContinuityReference(db, 7, 1), null);
    db.close();
  });
});
