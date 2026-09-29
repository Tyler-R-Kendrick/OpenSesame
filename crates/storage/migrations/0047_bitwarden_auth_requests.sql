-- ADR 0148 §8: "log in with device" for the Bitwarden-compatible server. A
-- new device asks; one of the account's signed-in devices approves by
-- wrapping the user key under the asking device's public key. The server
-- holds that wrap and the digest of the asking device's access code, and
-- can open neither.
CREATE TABLE IF NOT EXISTS bitwarden_auth_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    device_identifier TEXT NOT NULL,
    device_type INTEGER NOT NULL,
    access_code_digest TEXT NOT NULL,
    public_key TEXT NOT NULL,
    key TEXT,
    master_password_hash TEXT,
    approved INTEGER,
    response_device TEXT,
    created_at TEXT NOT NULL,
    response_at TEXT
);
CREATE INDEX IF NOT EXISTS bitwarden_auth_requests_user ON bitwarden_auth_requests(user_id);
