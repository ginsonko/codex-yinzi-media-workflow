CREATE TABLE IF NOT EXISTS model_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  service_type TEXT NOT NULL,
  model TEXT NOT NULL,
  group_name TEXT NOT NULL DEFAULT '',
  billing_unit TEXT NOT NULL,
  unit_price_microusd INTEGER,
  input_price_microusd INTEGER,
  output_price_microusd INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD',
  source TEXT NOT NULL DEFAULT 'manual',
  source_version TEXT,
  source_fetched_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, service_type, model, group_name, billing_unit)
);

CREATE INDEX IF NOT EXISTS idx_model_prices_lookup
  ON model_prices (provider, service_type, model, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  action_id INTEGER,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT '',
  service_type TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  billing_unit TEXT NOT NULL DEFAULT 'unknown',
  units REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'reserved',
  estimated_microusd INTEGER,
  reserved_microusd INTEGER NOT NULL DEFAULT 0,
  actual_microusd INTEGER,
  price_snapshot_json TEXT NOT NULL DEFAULT '{}',
  usage_snapshot_json TEXT NOT NULL DEFAULT '{}',
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_cost_ledger_run
  ON cost_ledger (run_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cost_ledger_action
  ON cost_ledger (action_id, created_at DESC);

CREATE TABLE IF NOT EXISTS config_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_type TEXT NOT NULL DEFAULT 'automatic',
  reason TEXT NOT NULL DEFAULT '',
  schema_version INTEGER NOT NULL,
  sections_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_config_snapshots_created
  ON config_snapshots (created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS config_import_previews (
  token TEXT PRIMARY KEY,
  bundle_json TEXT NOT NULL,
  bundle_hash TEXT NOT NULL,
  base_fingerprint TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_config_import_previews_expiry
  ON config_import_previews (expires_at, applied_at);
