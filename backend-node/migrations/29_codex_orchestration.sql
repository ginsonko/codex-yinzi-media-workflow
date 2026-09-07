-- Codex-led, open-world orchestration. This is additive and does not change
-- the existing production workflow tables or their execution semantics.
CREATE TABLE IF NOT EXISTS orchestration_sessions (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT UNIQUE,
  title TEXT NOT NULL DEFAULT '',
  user_goal TEXT NOT NULL DEFAULT '',
  mode TEXT NOT NULL DEFAULT 'collaborate',
  status TEXT NOT NULL DEFAULT 'draft',
  source_context_json TEXT NOT NULL DEFAULT '{}',
  linked_drama_id INTEGER,
  linked_run_id TEXT,
  plan_revision INTEGER NOT NULL DEFAULT 0,
  plan_json TEXT NOT NULL DEFAULT '{}',
  budget_json TEXT NOT NULL DEFAULT '{}',
  usage_json TEXT NOT NULL DEFAULT '{}',
  checkpoint_json TEXT NOT NULL DEFAULT '{}',
  last_error_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_orchestration_sessions_status
  ON orchestration_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_orchestration_sessions_linked_run
  ON orchestration_sessions(linked_run_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS orchestration_nodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  node_key TEXT NOT NULL,
  module_id TEXT NOT NULL,
  module_version INTEGER NOT NULL DEFAULT 1,
  plan_revision INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'create',
  status TEXT NOT NULL DEFAULT 'pending',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  input_refs_json TEXT NOT NULL DEFAULT '[]',
  output_refs_json TEXT NOT NULL DEFAULT '[]',
  executor TEXT NOT NULL DEFAULT 'codex',
  progress_json TEXT NOT NULL DEFAULT '{}',
  request_hash TEXT,
  config_revision TEXT,
  cost_ledger_id INTEGER,
  decision_json TEXT NOT NULL DEFAULT '{}',
  error_json TEXT NOT NULL DEFAULT '{}',
  attempt INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE(session_id, node_key)
);

CREATE INDEX IF NOT EXISTS idx_orchestration_nodes_session
  ON orchestration_nodes(session_id, active, sort_order, created_at);
CREATE INDEX IF NOT EXISTS idx_orchestration_nodes_status
  ON orchestration_nodes(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS orchestration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id TEXT,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orchestration_events_session
  ON orchestration_events(session_id, id DESC);

CREATE TABLE IF NOT EXISTS orchestration_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'local',
  original_code TEXT,
  normalized_category TEXT,
  message TEXT NOT NULL DEFAULT '',
  attempted_json TEXT NOT NULL DEFAULT '[]',
  retryable TEXT NOT NULL DEFAULT 'unknown',
  fallback_available INTEGER NOT NULL DEFAULT 0,
  next_actions_json TEXT NOT NULL DEFAULT '[]',
  correlation_id TEXT,
  redactions_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE(node_id, attempt)
);

CREATE INDEX IF NOT EXISTS idx_orchestration_receipts_session
  ON orchestration_receipts(session_id, id DESC);
