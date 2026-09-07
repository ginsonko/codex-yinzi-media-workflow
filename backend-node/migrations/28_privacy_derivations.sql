CREATE TABLE IF NOT EXISTS privacy_derivations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_media_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL,
  derived_media_path TEXT NOT NULL,
  density REAL NOT NULL DEFAULT 0.18,
  seed INTEGER NOT NULL,
  face_region_json TEXT,
  detection_mode TEXT NOT NULL DEFAULT 'fallback_center_portrait',
  detection_confidence REAL NOT NULL DEFAULT 0.25,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_privacy_derivations_source ON privacy_derivations(source_media_path, deleted_at);
