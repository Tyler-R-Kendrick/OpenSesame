-- 0035 rebuilt session_join_requests with:
--   (admitted_mode = 'participant' AND grant_id IS NOT NULL)
--   OR (admitted_mode IS NOT 'participant' AND grant_id IS NULL)
-- Under SQLite CHECK rules, an unknown (NULL) result passes. For a refusal
-- (admitted_mode NULL, grant_id set) the first clause is NULL and the second
-- is FALSE, so NULL OR FALSE → NULL → the row is accepted. Rebuild with an
-- explicit boolean equality so refusal/observer cannot carry a grant.

CREATE TABLE session_join_requests_next (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    requester_principal_id TEXT NOT NULL,
    note TEXT NULL,
    requested_at TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending'
        CHECK (decision IN ('pending','admitted','refused')),
    decided_at TEXT NULL,
    decided_by_principal_id TEXT NULL,
    admitted_mode TEXT NULL CHECK (admitted_mode IN ('observer','participant')),
    grant_id TEXT NULL REFERENCES session_grants (id) ON DELETE SET NULL,
    CHECK (
        (decision = 'admitted' AND admitted_mode IS NOT NULL)
        OR (decision <> 'admitted' AND admitted_mode IS NULL)
    ),
    -- Participant admissions mint a grant; every other shape forbids one.
    -- CASE avoids SQLite CHECK's "NULL means pass" trap that let refusals
    -- keep a grant_id under the 0035 `IS NOT` formulation.
    CHECK (
        CASE
            WHEN admitted_mode = 'participant' THEN grant_id IS NOT NULL
            ELSE grant_id IS NULL
        END
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
    admitted_mode, grant_id
FROM session_join_requests;

DROP TABLE session_join_requests;

ALTER TABLE session_join_requests_next RENAME TO session_join_requests;

CREATE UNIQUE INDEX IF NOT EXISTS session_join_requests_pending_idx
    ON session_join_requests (session_id, requester_principal_id)
    WHERE decision = 'pending';
