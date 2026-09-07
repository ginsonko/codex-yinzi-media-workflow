const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  normalizeWorkflowReferences,
  normalizeDirectorScene,
} = require('../src/services/storyboardService');
const { getStoryboardsForEpisode } = require('../src/services/episodeStoryboardService');

describe('storyboard workflow persistence', () => {
  it('normalizes, deduplicates, and bounds typed references to 4/3/1', () => {
    const result = normalizeWorkflowReferences({
      images: ['a.png', 'a.png', 'b.png', 'c.png', 'd.png', 'e.png'],
      videos: ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'],
      audios: ['a.mp3', 'b.mp3'],
    });
    assert.deepEqual(result.images.map((item) => item.path), ['a.png', 'b.png', 'c.png', 'd.png']);
    assert.deepEqual(result.videos.map((item) => item.path), ['a.mp4', 'b.mp4', 'c.mp4']);
    assert.deepEqual(result.audios.map((item) => item.path), ['a.mp3']);
  });

  it('accepts local_path/url records and strips untrusted extra fields', () => {
    const result = normalizeWorkflowReferences(JSON.stringify({
      images: [{ local_path: 'frame.png', label: 'Director frame', secret: 'drop-me' }],
      videos: [{ url: 'https://media.test/preview.mp4', source: 'director' }],
    }));
    assert.deepEqual(result.images[0], { path: 'frame.png', label: 'Director frame', source: 'upload' });
    assert.deepEqual(result.videos[0], { path: 'https://media.test/preview.mp4', label: '', source: 'director' });
    assert.deepEqual(result.audios, []);
  });

  it('serializes a bounded director scene document', () => {
    const json = normalizeDirectorScene({ version: 1, objects: [], timeline: { duration: 5, keyframes: [] } });
    assert.equal(JSON.parse(json).timeline.duration, 5);
    assert.equal(normalizeDirectorScene('not-json'), null);
    assert.throws(() => normalizeDirectorScene({ data: 'x'.repeat(1024 * 1024 + 1) }), /1 MB/);
  });

  it('keeps generated storyboard frame paths in the episode list', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE storyboards (
        id INTEGER PRIMARY KEY,
        episode_id INTEGER NOT NULL,
        scene_id INTEGER,
        storyboard_number INTEGER,
        image_url TEXT,
        local_path TEXT,
        first_frame_image_id INTEGER,
        last_frame_image_url TEXT,
        last_frame_local_path TEXT,
        last_frame_image_id INTEGER,
        deleted_at TEXT
      );
      CREATE TABLE scenes (id INTEGER PRIMARY KEY, deleted_at TEXT);
      INSERT INTO storyboards (
        id, episode_id, storyboard_number, image_url, local_path, first_frame_image_id,
        last_frame_image_url, last_frame_local_path, last_frame_image_id
      ) VALUES (
        3, 1, 3, '/static/storyboard.png', 'images/storyboard.png', 30,
        '/static/last.png', 'images/last.png', 31
      );
    `);
    try {
      const [item] = getStoryboardsForEpisode(db, 1);
      assert.equal(item.image_url, '/static/storyboard.png');
      assert.equal(item.local_path, 'images/storyboard.png');
      assert.equal(item.first_frame_image_id, 30);
      assert.equal(item.last_frame_image_url, '/static/last.png');
      assert.equal(item.last_frame_local_path, 'images/last.png');
      assert.equal(item.last_frame_image_id, 31);
    } finally {
      db.close();
    }
  });
});
