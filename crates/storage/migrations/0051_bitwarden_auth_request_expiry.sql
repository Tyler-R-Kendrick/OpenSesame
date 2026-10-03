-- ADR 0148 §8: every request made sweeps the ones that ran out of time, by
-- when they were made. Without this the sweep reads the whole table.
CREATE INDEX IF NOT EXISTS bitwarden_auth_requests_created ON bitwarden_auth_requests(created_at);
