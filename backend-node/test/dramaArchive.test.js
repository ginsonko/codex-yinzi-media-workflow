const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const dramaService = require('../src/services/dramaService');
const { ensureColumns } = require('../src/db/migrate');

const log = {
  info() {},
  warn() {},
  error() {},
};

function createDb({ includeArchiveColumn = true } = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dramas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      description TEXT,
      genre TEXT,
      style TEXT DEFAULT 'realistic',
      tags TEXT,
      thumbnail TEXT,
      total_episodes INTEGER DEFAULT 1,
      total_duration INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT,
      ${includeArchiveColumn ? 'archived_at TEXT,' : ''}
      deleted_at TEXT
    );
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drama_id INTEGER,
      episode_number INTEGER DEFAULT 0,
      title TEXT,
      script_content TEXT,
      description TEXT,
      duration INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft',
      video_url TEXT,
      thumbnail TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE storyboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      episode_id INTEGER,
      storyboard_number INTEGER DEFAULT 0,
      duration REAL DEFAULT 0,
      deleted_at TEXT
    );
    CREATE TABLE storyboard_props (
      storyboard_id INTEGER,
      prop_id INTEGER
    );
  `);
  return db;
}

function insertDrama(db, title, updatedAt, archivedAt = null) {
  return db.prepare(`
    INSERT INTO dramas (title, description, status, created_at, updated_at, archived_at)
    VALUES (?, ?, 'draft', ?, ?, ?)
  `).run(title, `${title} description`, updatedAt, updatedAt, archivedAt).lastInsertRowid;
}

test('ensureColumns upgrades an older dramas table with archived_at', () => {
  const db = createDb({ includeArchiveColumn: false });
  try {
    ensureColumns(db, 'dramas', [{ name: 'archived_at', type: 'TEXT' }]);
    const columns = db.prepare('PRAGMA table_info(dramas)').all().map((row) => row.name);
    assert.ok(columns.includes('archived_at'));
  } finally {
    db.close();
  }
});

test('listDramas defaults to active projects and supports archived/all filters', () => {
  const db = createDb();
  try {
    insertDrama(db, 'Active alpha', '2026-08-10T10:00:00.000Z');
    insertDrama(db, 'Archived beta', '2026-08-11T10:00:00.000Z', '2026-08-11T11:00:00.000Z');

    const active = dramaService.listDramas(db, { page: 1, page_size: 12 });
    assert.equal(active.total, 1);
    assert.equal(active.dramas[0].title, 'Active alpha');
    assert.equal(active.dramas[0].archived_at, null);

    const archived = dramaService.listDramas(db, { archive_state: 'archived' });
    assert.equal(archived.total, 1);
    assert.equal(archived.dramas[0].title, 'Archived beta');
    assert.equal(archived.dramas[0].archived_at, '2026-08-11T11:00:00.000Z');

    const all = dramaService.listDramas(db, { archive_state: 'all' });
    assert.equal(all.total, 2);
    assert.deepEqual(all.dramas.map((item) => item.title), ['Archived beta', 'Active alpha']);

    const invalid = dramaService.listDramas(db, { archive_state: 'unknown' });
    assert.equal(invalid.total, 1);
    assert.equal(invalid.dramas[0].title, 'Active alpha');

    const searched = dramaService.listDramas(db, { archive_state: 'all', keyword: 'beta' });
    assert.equal(searched.total, 1);
    assert.equal(searched.dramas[0].title, 'Archived beta');

    const firstPage = dramaService.listDramas(db, { archive_state: 'all', page: 1, page_size: 1 });
    const secondPage = dramaService.listDramas(db, { archive_state: 'all', page: 2, page_size: 1 });
    assert.equal(firstPage.total, 2);
    assert.equal(firstPage.pageSize, 1);
    assert.equal(firstPage.dramas[0].title, 'Archived beta');
    assert.equal(secondPage.dramas[0].title, 'Active alpha');
  } finally {
    db.close();
  }
});

test('archive and restore preserve the production status and remain idempotent', () => {
  const db = createDb();
  try {
    const id = insertDrama(db, 'Project', '2026-08-10T10:00:00.000Z');
    const archived = dramaService.updateDrama(db, log, id, { archived: true });
    assert.ok(archived.archived_at);
    assert.equal(archived.status, 'draft');

    const archivedAgain = dramaService.updateDrama(db, log, id, { archived: true });
    assert.equal(archivedAgain.archived_at, archived.archived_at);

    const restored = dramaService.updateDrama(db, log, id, { archived: false });
    assert.equal(restored.archived_at, null);
    assert.equal(restored.status, 'draft');

    const active = dramaService.listDramas(db, { keyword: 'Project' });
    assert.equal(active.total, 1);
  } finally {
    db.close();
  }
});
