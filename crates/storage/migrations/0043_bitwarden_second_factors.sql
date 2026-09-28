-- ADR 0148: sign-in methods beside the master password for the
-- Bitwarden-compatible server. As on Bitwarden's own server, the server must
-- be able to check an authenticator code and show a person their API key and
-- recovery code again, so these are held as the server needs them; none of
-- them opens a vault.
ALTER TABLE bitwarden_users ADD COLUMN api_key TEXT;
ALTER TABLE bitwarden_users ADD COLUMN recovery_code TEXT;
CREATE TABLE IF NOT EXISTS bitwarden_two_factor (
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    provider INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    last_used_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, provider)
);
-- "Remember this device" for two-step login: a digest of the token the
-- device holds, the security stamp it was issued under, and when it lapses.
ALTER TABLE bitwarden_devices ADD COLUMN remember_hash TEXT;
ALTER TABLE bitwarden_devices ADD COLUMN remember_stamp TEXT;
ALTER TABLE bitwarden_devices ADD COLUMN remember_expires_at TEXT;
