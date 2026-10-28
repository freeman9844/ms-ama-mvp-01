CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
INSERT OR IGNORE INTO businesses VALUES ('shop-a', '합성 가게 A'), ('shop-b', '합성 가게 B');
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  actor_json TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  actor_id TEXT,
  kind TEXT NOT NULL,
  reference_id TEXT,
  code TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  version INTEGER NOT NULL,
  validation_status TEXT NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE(application_id, version)
);
CREATE TABLE IF NOT EXISTS dataset_consents (
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  consent_id TEXT NOT NULL REFERENCES consents(id),
  consent_version INTEGER NOT NULL,
  PRIMARY KEY(dataset_id, consent_id)
);
CREATE TABLE IF NOT EXISTS source_records (
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(dataset_id, source, resource_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS forecasts (
  dataset_id TEXT PRIMARY KEY REFERENCES datasets(id) ON DELETE CASCADE,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  consent_ids TEXT NOT NULL,
  model_id TEXT NOT NULL,
  role TEXT NOT NULL,
  state TEXT NOT NULL,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS tool_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES ai_sessions(id),
  tool TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
