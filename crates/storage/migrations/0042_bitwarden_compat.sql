-- ADR 0141: the Bitwarden-compatible server surface. Everything a Bitwarden
-- client encrypts stays an opaque EncString here; the server holds no key that
-- opens a vault. `master_password_hash` is a self-describing PHC string from the
-- server's password-hash registry (Argon2id today), never the client hash.
CREATE TABLE IF NOT EXISTS bitwarden_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    master_password_hash TEXT NOT NULL,
    master_password_hint TEXT,
    kdf_type INTEGER NOT NULL,
    kdf_iterations INTEGER NOT NULL,
    kdf_memory INTEGER,
    kdf_parallelism INTEGER,
    user_key TEXT NOT NULL,
    user_key_id TEXT,
    public_key TEXT,
    private_key TEXT,
    security_stamp TEXT NOT NULL,
    culture TEXT NOT NULL DEFAULT 'en-US',
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bitwarden_devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    identifier TEXT NOT NULL,
    name TEXT NOT NULL,
    device_type INTEGER NOT NULL,
    refresh_token_hash TEXT UNIQUE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, identifier)
);
CREATE TABLE IF NOT EXISTS bitwarden_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bitwarden_folders_user ON bitwarden_folders(user_id);
CREATE TABLE IF NOT EXISTS bitwarden_ciphers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    folder_id TEXT,
    cipher_type INTEGER NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL,
    deleted_at TEXT,
    archived_at TEXT
);
CREATE INDEX IF NOT EXISTS bitwarden_ciphers_user ON bitwarden_ciphers(user_id);
