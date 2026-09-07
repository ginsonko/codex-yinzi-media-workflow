-- Privacy derivation modes are additive and keep the original source immutable.
ALTER TABLE privacy_derivations ADD COLUMN mode TEXT NOT NULL DEFAULT 'line_grayscale';
ALTER TABLE privacy_derivations ADD COLUMN grid_json TEXT;
ALTER TABLE privacy_derivations ADD COLUMN parent_derivation_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_privacy_derivations_parent ON privacy_derivations(parent_derivation_id, deleted_at);
