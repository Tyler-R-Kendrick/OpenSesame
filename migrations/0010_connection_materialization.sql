-- ADR 0049: whether a connection's owner allows minting a provider-natively
-- derived, short-lived, revocable token (e.g. a GitHub App installation token).
-- Default deny: existing rows and new connections get nothing until the owner
-- opts in, and the sealed stored credential never moves either way.
ALTER TABLE connections ADD COLUMN materialization TEXT NOT NULL DEFAULT 'deny';
