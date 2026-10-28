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
INSERT OR IGNORE INTO settings VALUES ('generation', '1');
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  dataset_id TEXT,
  dataset_version INTEGER NOT NULL DEFAULT 0,
  assessment_id TEXT,
  assessment_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  application_id TEXT REFERENCES applications(id),
  business_id TEXT NOT NULL REFERENCES businesses(id),
  consent_ids TEXT NOT NULL,
  generation INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  lease_until_ms INTEGER NOT NULL DEFAULT 0,
  retry_at_ms INTEGER NOT NULL DEFAULT 0,
  result_id TEXT,
  error_code TEXT,
  reference_id TEXT
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_id TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  PRIMARY KEY(actor_id, route, key)
);
CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  model_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  UNIQUE(application_id, version)
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  actor_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  dataset_version INTEGER NOT NULL,
  assessment_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loans (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL UNIQUE REFERENCES applications(id),
  business_id TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repayment_schedules (
  id TEXT PRIMARY KEY,
  loan_id TEXT NOT NULL REFERENCES loans(id),
  due_at TEXT NOT NULL,
  amount_krw INTEGER NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS demo_events (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  state TEXT NOT NULL,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  code TEXT NOT NULL,
  state TEXT NOT NULL,
  minimum_krw INTEGER NOT NULL,
  explanation_status TEXT NOT NULL,
  explanation TEXT,
  error_code TEXT,
  UNIQUE(application_id, fingerprint, code)
);
CREATE TABLE IF NOT EXISTS support_requests (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL REFERENCES applications(id),
  business_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  route TEXT,
  status TEXT NOT NULL,
  explanation TEXT,
  error_code TEXT
);
CREATE TABLE IF NOT EXISTS support_reviews (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES support_requests(id),
  actor_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mock_messages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES support_requests(id),
  application_id TEXT NOT NULL REFERENCES applications(id),
  template TEXT NOT NULL,
  text TEXT NOT NULL,
  business_date TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  UNIQUE(request_id, template)
);
CREATE UNIQUE INDEX IF NOT EXISTS message_daily_limit
  ON mock_messages(application_id,business_date) WHERE state='SENT';
