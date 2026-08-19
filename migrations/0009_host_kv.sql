-- Host operator key/value (TaskBus NATS URL, etc.). Not secrets vault —
-- operator-plane config only. Values may be semi-public Tailnet URLs.
CREATE TABLE IF NOT EXISTS host_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
