-- Coordination sessions: seats that hold no keys, and reach that says whether
-- it ends with the session (ADR 0079 §2, §7).
--
-- 0019 made presence and reach the same row: you were in a session because you
-- held a grant through it. That forces a key to be wrapped for everybody in the
-- room, including the people who only want to watch — and ADR 0079 §3's
-- revocation is re-keying, so a key wrapped by mistake cannot be taken back.
-- This migration separates the two.
--
-- Three shapes the schema enforces rather than merely stores:
--
-- 1. A seat carries no scope, no role, no vault and no key material. There is
--    no column here one could be put in, which is the structural half of
--    "an observer needs no vault keys".
-- 2. Every grant says why it exists. 'lifecycle_bound' reach was minted by the
--    session and is revoked when it closes; 'referenced' reach is a narrowed
--    pointer at something the holder already had, and closing must leave it
--    alone. The CHECK ties the source column to the kind so a reference that
--    points nowhere, or a minted grant that claims a source, cannot be stored.
-- 3. An admission names the seat it gave. 0019's CHECK required a grant id for
--    every admitted request, which made an observer admission unstorable; the
--    replacement below requires the mode instead, and requires the grant id
--    exactly when that mode is 'participant'. "Admitted, and we will work out
--    what that means later" is still unrepresentable.

CREATE TABLE IF NOT EXISTS session_memberships (
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    -- 'observer' is in the room holding nothing and is never the subject of a
    -- session_grants row; 'participant' may be granted reach. Raising and
    -- lowering are operator acts, not side effects of granting.
    mode TEXT NOT NULL CHECK (mode IN ('observer','participant')),
    -- The operator who seated them. Never the member themselves: a
    -- self-admitted seat would be a join request that skipped the deciding.
    admitted_by_principal_id TEXT NOT NULL,
    admitted_at TEXT NOT NULL,
    -- Ended rather than deleted, so the roster keeps a history.
    ended_at TEXT NULL,
    -- A principal is in a session once or not at all. A surrogate key would
    -- make "twice, in two modes" representable, which is the contradiction
    -- the mode exists to rule out.
    PRIMARY KEY (session_id, principal_id)
);

-- The question the authorization fence asks first: is this caller in the room,
-- and in what mode.
CREATE INDEX IF NOT EXISTS session_memberships_live_idx
    ON session_memberships (session_id, ended_at);

-- The question the client asks: which sessions am I in.
CREATE INDEX IF NOT EXISTS session_memberships_principal_idx
    ON session_memberships (organization_id, principal_id, ended_at);

-- Existing grants were all minted by their session, so the backfill default is
-- the honest one. NOT NULL with a constant default is the one ADD COLUMN form
-- SQLite performs without rewriting the table.
ALTER TABLE session_grants
    ADD COLUMN link TEXT NOT NULL DEFAULT 'lifecycle_bound'
        CHECK (link IN ('lifecycle_bound','referenced'));

ALTER TABLE session_grants
    ADD COLUMN source_grant_id TEXT NULL REFERENCES session_grants (id);

-- Find everything a closing session must revoke, and nothing it must not.
CREATE INDEX IF NOT EXISTS session_grants_link_idx
    ON session_grants (session_id, link, revoked_at);

-- Rebuilt rather than altered: SQLite cannot drop a CHECK in place, and 0019's
-- CHECK made an observer admission unstorable. The copy preserves every
-- decided row, mapping each existing admission to the participant mode it
-- necessarily was -- there were no observers before this migration.
CREATE TABLE session_join_requests_next (
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
    -- The seat admitting gave. Required exactly when admitted, forbidden
    -- otherwise, so a decision can never be read as an admission of unstated
    -- standing.
    admitted_mode TEXT NULL CHECK (admitted_mode IN ('observer','participant')),
    grant_id TEXT NULL REFERENCES session_grants (id) ON DELETE SET NULL,
    CHECK (
        (decision = 'admitted' AND admitted_mode IS NOT NULL)
        OR (decision <> 'admitted' AND admitted_mode IS NULL)
    ),
    -- Admission is a named seat: a participant admission carries the grant it
    -- minted, and an observer admission carries none. Neither may borrow the
    -- other's shape.
    CHECK (
        (admitted_mode = 'participant' AND grant_id IS NOT NULL)
        OR (admitted_mode IS NOT 'participant' AND grant_id IS NULL)
    ),
    CHECK (
        (decision = 'pending' AND decided_at IS NULL
            AND decided_by_principal_id IS NULL)
        OR (decision <> 'pending' AND decided_at IS NOT NULL
            AND decided_by_principal_id IS NOT NULL)
    ),
    UNIQUE (organization_id, id)
);

INSERT INTO session_join_requests_next (
    id, session_id, organization_id, requester_principal_id, note,
    requested_at, decision, decided_at, decided_by_principal_id,
    admitted_mode, grant_id
)
SELECT
    id, session_id, organization_id, requester_principal_id, note,
    requested_at, decision, decided_at, decided_by_principal_id,
    CASE WHEN decision = 'admitted' THEN 'participant' ELSE NULL END,
    grant_id
FROM session_join_requests;

DROP TABLE session_join_requests;

ALTER TABLE session_join_requests_next RENAME TO session_join_requests;

-- One pending request per principal per session: asking twice is the same ask,
-- and a queue an operator has to scroll is a queue an operator stops reading.
CREATE UNIQUE INDEX IF NOT EXISTS session_join_requests_pending_idx
    ON session_join_requests (session_id, requester_principal_id)
    WHERE decision = 'pending';

-- Everyone admitted before this migration was seated by being granted, so the
-- seats are reconstructed from the grants rather than left empty -- otherwise
-- an existing participant would read as a stranger the moment the fence starts
-- asking about seats. The operator is not seated: running a session is a role,
-- not a seat, and conflating them is how "manages the sharing" becomes "is in
-- the room with reach" (ADR 0079 §6).
INSERT OR IGNORE INTO session_memberships (
    session_id, organization_id, principal_id, mode,
    admitted_by_principal_id, admitted_at, ended_at
)
SELECT
    g.session_id,
    g.organization_id,
    g.subject_principal_id,
    'participant',
    g.granted_by_principal_id,
    MIN(g.granted_at),
    NULL
FROM session_grants g
GROUP BY g.session_id, g.organization_id, g.subject_principal_id;
