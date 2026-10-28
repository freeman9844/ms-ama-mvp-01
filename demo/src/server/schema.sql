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
