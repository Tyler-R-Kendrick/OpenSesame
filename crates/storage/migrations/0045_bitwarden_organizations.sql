-- ADR 0148: organizations and collections for the Bitwarden-compatible
-- server. An organization's key reaches each member wrapped under that
-- member's public key; collection names and every organization cipher are
-- encrypted under the organization key. The server holds none of these keys.
CREATE TABLE IF NOT EXISTS bitwarden_organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    billing_email TEXT NOT NULL,
    plan_type INTEGER NOT NULL DEFAULT 0,
    seats INTEGER,
    public_key TEXT,
    private_key TEXT,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bitwarden_org_members (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES bitwarden_organizations(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    key TEXT,
    status INTEGER NOT NULL,
    member_type INTEGER NOT NULL,
    access_all INTEGER NOT NULL DEFAULT 0,
    permissions TEXT,
    reset_password_key TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL,
    UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS bitwarden_org_members_user ON bitwarden_org_members(user_id);
CREATE TABLE IF NOT EXISTS bitwarden_collections (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES bitwarden_organizations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    external_id TEXT,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bitwarden_collections_org ON bitwarden_collections(org_id);
CREATE TABLE IF NOT EXISTS bitwarden_collection_members (
    collection_id TEXT NOT NULL REFERENCES bitwarden_collections(id) ON DELETE CASCADE,
    member_id TEXT NOT NULL REFERENCES bitwarden_org_members(id) ON DELETE CASCADE,
    read_only INTEGER NOT NULL DEFAULT 0,
    hide_passwords INTEGER NOT NULL DEFAULT 0,
    manage INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (collection_id, member_id)
);

-- A cipher now belongs to an account or to an organization. SQLite cannot
-- relax a NOT NULL in place, so the table is rebuilt; attachments, whose
-- foreign key names it, are set aside first and put back after, and their
-- bytes in bitwarden_blobs are never touched (dropping a table drops its
-- triggers before its rows, so none fire).
CREATE TABLE bitwarden_attachments_kept AS SELECT * FROM bitwarden_attachments;
DROP TABLE bitwarden_attachments;
CREATE TABLE bitwarden_ciphers_next (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    organization_id TEXT REFERENCES bitwarden_organizations(id) ON DELETE CASCADE,
    folder_id TEXT,
    cipher_type INTEGER NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revision_at TEXT NOT NULL,
    deleted_at TEXT,
    archived_at TEXT,
    CHECK ((user_id IS NULL) <> (organization_id IS NULL))
);
INSERT INTO bitwarden_ciphers_next (id, user_id, organization_id, folder_id, cipher_type,
    favorite, data, created_at, revision_at, deleted_at, archived_at)
    SELECT id, user_id, NULL, folder_id, cipher_type, favorite, data, created_at, revision_at,
    deleted_at, archived_at FROM bitwarden_ciphers;
DROP TABLE bitwarden_ciphers;
ALTER TABLE bitwarden_ciphers_next RENAME TO bitwarden_ciphers;
CREATE INDEX IF NOT EXISTS bitwarden_ciphers_user ON bitwarden_ciphers(user_id);
CREATE INDEX IF NOT EXISTS bitwarden_ciphers_org ON bitwarden_ciphers(organization_id);
CREATE TABLE bitwarden_attachments (
    id TEXT PRIMARY KEY,
    cipher_id TEXT NOT NULL REFERENCES bitwarden_ciphers(id) ON DELETE CASCADE,
    user_id TEXT REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    key TEXT,
    size INTEGER NOT NULL,
    uploaded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
INSERT INTO bitwarden_attachments SELECT * FROM bitwarden_attachments_kept;
DROP TABLE bitwarden_attachments_kept;
CREATE INDEX IF NOT EXISTS bitwarden_attachments_cipher ON bitwarden_attachments(cipher_id);
CREATE INDEX IF NOT EXISTS bitwarden_attachments_user ON bitwarden_attachments(user_id);
CREATE TRIGGER IF NOT EXISTS bitwarden_attachment_bytes_go
AFTER DELETE ON bitwarden_attachments
BEGIN
    DELETE FROM bitwarden_blobs WHERE id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS bitwarden_collection_ciphers (
    collection_id TEXT NOT NULL REFERENCES bitwarden_collections(id) ON DELETE CASCADE,
    cipher_id TEXT NOT NULL REFERENCES bitwarden_ciphers(id) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, cipher_id)
);
CREATE INDEX IF NOT EXISTS bitwarden_collection_ciphers_cipher ON bitwarden_collection_ciphers(cipher_id);
-- An organization cipher's folder and favourite are each member's own.
CREATE TABLE IF NOT EXISTS bitwarden_cipher_marks (
    cipher_id TEXT NOT NULL REFERENCES bitwarden_ciphers(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES bitwarden_users(id) ON DELETE CASCADE,
    folder_id TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (cipher_id, user_id)
);
