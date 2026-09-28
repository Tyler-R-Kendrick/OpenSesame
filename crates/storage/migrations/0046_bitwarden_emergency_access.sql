-- ADR 0148 §6: emergency access and per-account settings for the
-- Bitwarden-compatible server. An emergency contact's key is the grantor's
-- user key wrapped under the contact's public key by the grantor's own
-- device; the server holds it and cannot open it.
CREATE TABLE IF NOT EXISTS bitwarden_emergency_access (
    id TEXT PRIMARY KEY,
    grantor_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    grantee_id TEXT REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    key_encrypted TEXT,
    access_type INTEGER NOT NULL,
    status INTEGER NOT NULL,
    wait_time_days INTEGER NOT NULL,
    recovery_initiated_at TEXT,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL,
    UNIQUE (grantor_id, email)
);
CREATE INDEX IF NOT EXISTS bitwarden_emergency_access_grantee ON bitwarden_emergency_access(grantee_id);
CREATE INDEX IF NOT EXISTS bitwarden_emergency_access_email ON bitwarden_emergency_access(email);
-- What an account sets for itself beyond its keys: its avatar colour and
-- its equivalent domains (JSON the client sends).
CREATE TABLE IF NOT EXISTS bitwarden_account_settings (
    user_id TEXT PRIMARY KEY REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    avatar_color TEXT,
    equivalent_domains TEXT,
    excluded_global_domains TEXT
);
