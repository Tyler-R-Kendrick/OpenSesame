-- ADR 0148 §9: organization policies for the Bitwarden-compatible server.
-- Clients enforce most of them from what a sync carries; the server enforces
-- the few that guard what it stores (two-step login, single organization,
-- personal ownership, Sends).
CREATE TABLE IF NOT EXISTS bitwarden_org_policies (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES bitwarden_organizations(id) ON DELETE CASCADE,
    policy_type INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    data TEXT,
    revision_at TEXT NOT NULL,
    UNIQUE (org_id, policy_type)
);
