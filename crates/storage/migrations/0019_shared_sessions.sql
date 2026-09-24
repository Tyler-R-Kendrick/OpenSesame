-- Shared sessions, participants, and scoped grants (ADR 0079).
--
-- Conventions follow 0017_lifecycle_hooks.sql: TEXT primary keys, RFC3339 TEXT
-- timestamps, and no foreign key on organization_id (the gateway runs against
-- whatever organization it is configured with, which may have no organizations
-- row -- see that migration's note).
--
-- Three shapes the schema enforces rather than merely stores, because each one
-- is a security property the domain types already hold and the database should
-- not be able to contradict:
--
-- 1. `expires_at` is NOT NULL. There is no standing session grant: revocation
--    is re-keying rather than a switch, so a grant that never lapses is a key
--    handed out permanently. `SessionGrant` carries a timestamp rather than an
--    Option for the same reason, and neither layer can express one.
--    The seven-day ceiling itself lives in `MAX_GRANT_LIFETIME` and is not
--    repeated here: it cannot be written portably against RFC3339 TEXT
--    timestamps, and a hand-maintained copy that drifted from the constant
--    would be worse than no copy at all.
-- 2. A row-scoped grant names its rows in `session_grant_items`, one row per
--    item, rather than a JSON array. That makes "who can reach this item"
--    an index lookup instead of a scan, and lets the primary key refuse the
--    same item twice in one grant.
-- 3. A join request records the grant that admitting minted. Admission IS a
--    grant (there is no "in the room with nothing"), so `grant_id` is required
--    exactly when the decision is 'admitted' and forbidden otherwise.

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NULL,
    -- Who runs it. Only an operator grants, revokes, admits or refuses.
    operator_principal_id TEXT NOT NULL,
    -- Shown on a discovery record for a public session. Never its contents:
    -- not the roster, not the items, not their count.
    display_name TEXT NOT NULL,
    -- 'private' is reachable by invitation only and is not discoverable at
    -- all; 'public' accepts join requests from principals with no standing.
    visibility TEXT NOT NULL CHECK (visibility IN ('private','public')),
    created_at TEXT NOT NULL,
    closed_at TEXT NULL,
    UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS sessions_org_open_idx
    ON sessions (organization_id, closed_at);

CREATE TABLE IF NOT EXISTS session_grants (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    -- Who holds it.
    subject_principal_id TEXT NOT NULL,
    -- Who gave it. Distinct columns because they are one transposition apart
    -- and transposing them hands the operator's reach to the wrong party.
    granted_by_principal_id TEXT NOT NULL,
    -- 'collection' reaches every item in the vault, including ones added
    -- later; 'rows' reaches exactly what session_grant_items names.
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('collection','rows')),
    vault_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('read','write')),
    granted_at TEXT NOT NULL,
    -- Never null: see note 1 above.
    expires_at TEXT NOT NULL CHECK (expires_at > granted_at),
    revoked_at TEXT NULL,
    UNIQUE (organization_id, id)
);

-- The question the authorization fence asks most often: what does this
-- principal hold in this session, right now.
CREATE INDEX IF NOT EXISTS session_grants_subject_idx
    ON session_grants (session_id, subject_principal_id, revoked_at);

-- The question the lifecycle scanner asks: what is about to lapse.
CREATE INDEX IF NOT EXISTS session_grants_expiry_idx
    ON session_grants (organization_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS session_grant_items (
    grant_id TEXT NOT NULL REFERENCES session_grants (id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    PRIMARY KEY (grant_id, item_id)
);

-- Reverse lookup: every grant that names one item, for revocation and for
-- deciding what has to be re-keyed when one is withdrawn.
CREATE INDEX IF NOT EXISTS session_grant_items_item_idx
    ON session_grant_items (item_id);

CREATE TABLE IF NOT EXISTS session_join_requests (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    requester_principal_id TEXT NOT NULL,
    -- The requester's own words, bounded by the domain at 280 characters.
    -- Untrusted text from somebody with no standing in the session; whatever
    -- renders it escapes it.
    note TEXT NULL,
    requested_at TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending'
        CHECK (decision IN ('pending','admitted','refused')),
    decided_at TEXT NULL,
    decided_by_principal_id TEXT NULL,
    -- Required exactly when admitted, forbidden otherwise: admission is a
    -- grant, so the two cannot drift apart (note 3 above).
    grant_id TEXT NULL REFERENCES session_grants (id) ON DELETE SET NULL,
    CHECK (
        (decision = 'admitted' AND grant_id IS NOT NULL)
        OR (decision <> 'admitted' AND grant_id IS NULL)
    ),
    -- A decided request carries who decided and when; a pending one carries
    -- neither. A second approval mints a new request rather than rewriting
    -- this one, so the audit trail cannot be edited in place.
    CHECK (
        (decision = 'pending' AND decided_at IS NULL
            AND decided_by_principal_id IS NULL)
        OR (decision <> 'pending' AND decided_at IS NOT NULL
            AND decided_by_principal_id IS NOT NULL)
    ),
    UNIQUE (organization_id, id)
);

-- One pending request per principal per session: asking twice is the same ask,
-- and a queue an operator has to scroll is a queue an operator stops reading.
CREATE UNIQUE INDEX IF NOT EXISTS session_join_requests_pending_idx
    ON session_join_requests (session_id, requester_principal_id)
    WHERE decision = 'pending';
