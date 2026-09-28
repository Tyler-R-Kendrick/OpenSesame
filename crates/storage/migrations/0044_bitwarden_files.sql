-- ADR 0148: attachments and Sends for the Bitwarden-compatible server. Every
-- file is ciphertext the client encrypted under a key the server never holds;
-- names, notes and texts are EncStrings. Bytes live in their own table so a
-- listing never reads them, and go when their owner goes.
CREATE TABLE IF NOT EXISTS bitwarden_blobs (
    id TEXT PRIMARY KEY,
    data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS bitwarden_attachments (
    id TEXT PRIMARY KEY,
    cipher_id TEXT NOT NULL REFERENCES bitwarden_ciphers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    key TEXT,
    size INTEGER NOT NULL,
    uploaded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bitwarden_attachments_cipher ON bitwarden_attachments(cipher_id);
CREATE INDEX IF NOT EXISTS bitwarden_attachments_user ON bitwarden_attachments(user_id);
CREATE TRIGGER IF NOT EXISTS bitwarden_attachment_bytes_go
AFTER DELETE ON bitwarden_attachments
BEGIN
    DELETE FROM bitwarden_blobs WHERE id = OLD.id;
END;
CREATE TABLE IF NOT EXISTS bitwarden_sends (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    send_type INTEGER NOT NULL,
    data TEXT NOT NULL,
    key TEXT NOT NULL,
    password_hash TEXT,
    max_access_count INTEGER,
    access_count INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    hide_email INTEGER NOT NULL DEFAULT 0,
    file_id TEXT,
    file_size INTEGER,
    uploaded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL,
    expiration_at TEXT,
    deletion_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bitwarden_sends_user ON bitwarden_sends(user_id);
CREATE INDEX IF NOT EXISTS bitwarden_sends_deletion ON bitwarden_sends(deletion_at);
CREATE TRIGGER IF NOT EXISTS bitwarden_send_bytes_go
AFTER DELETE ON bitwarden_sends
WHEN OLD.file_id IS NOT NULL
BEGIN
    DELETE FROM bitwarden_blobs WHERE id = OLD.file_id;
END;
