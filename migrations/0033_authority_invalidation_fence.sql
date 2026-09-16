-- Durable root/ancestor invalidation fencing for delegated authority
-- (ADR 0121).
--
-- Revoking a grant has to stop every descendant immediately. Pushing the
-- revocation down the tree cannot do that: between the owner's revoke and the
-- walk reaching a child there is a window in which the child is still
-- honoured, and that window is authority outliving the thing it narrowed.
--
-- These two tables invert the direction. A revoke writes ONE row in
-- `grant_invalidations`; an authorization reads the grant's stored lineage and
-- asks whether any id in it carries such a row. Nothing is pushed, so there
-- is nothing to be behind on.
--
-- LINEARIZATION POINT
-- ===================
-- The single point at which a revocation takes effect is the COMMIT of the
-- transaction that inserts the `grant_invalidations` row. Before that commit
-- every concurrent authorization is permitted to allow; from that commit
-- onward every authorization — including one already in flight that has not
-- yet read the fence — denies. Nothing else is load-bearing: the `revoked_at`
-- columns on `grants` and `connection_delegations` are updated in the same
-- transaction, but they are bookkeeping for listings and receipts. If they
-- were somehow stale the fence would still deny, which is why the cascade may
-- lag without ever widening authority.
--
-- The guarantee is scoped honestly. This is one SQLite database with one
-- writer at a time, so the total order of `sequence` and the linearizability
-- of the fence hold for THIS host. That is not a distributed consensus
-- protocol and must not be described as one: a multi-host deployment sharing
-- authority state needs a store that actually provides consensus, and no
-- quorum may be inferred from these tables. See ADR 0121 § Scope.

-- One row per grant, written in the same transaction as the grant itself.
-- `ancestor_path` is the materialized chain, root first and the grant itself
-- last, delimited and terminated with '/': '/grant:<root>/grant:<child>/'.
-- Both ends are closed so a range scan cannot stop mid-id, which is what lets
-- a subtree be addressed as a half-open range instead of a recursive walk.
--
-- A grant with no row here is NOT treated as a root. Its ancestry is unknown,
-- and an unknown ancestry fails closed (opensesame-lifecycle's
-- `Uncertainty::LineageMissing`).
CREATE TABLE IF NOT EXISTS grant_lineage (
  grant_id        TEXT PRIMARY KEY,       -- grants.id spelling: 'grant:<uuid>'
  root_grant_id   TEXT NOT NULL,          -- ancestor_path's first segment
  parent_grant_id TEXT,                   -- NULL only for a root
  depth           INTEGER NOT NULL,       -- 0 for a root; bounded by MAX_FENCE_DEPTH
  ancestor_path   TEXT NOT NULL,          -- '/root/.../self/'
  recorded_at     TEXT NOT NULL
);

-- The cascade's index: `ancestor_path >= :low AND ancestor_path < :high`
-- reaches a whole subtree as one indexed range scan.
CREATE INDEX IF NOT EXISTS idx_grant_lineage_path
  ON grant_lineage(ancestor_path);
CREATE INDEX IF NOT EXISTS idx_grant_lineage_root
  ON grant_lineage(root_grant_id);

-- One row per revoked grant. Descendants are deliberately NOT enumerated
-- here: a root revocation is a single insert regardless of how many grants
-- hang below it, which is what makes revocation O(1) and immediate.
CREATE TABLE IF NOT EXISTS grant_invalidations (
  grant_id       TEXT PRIMARY KEY,        -- the grant named by the revoke
  sequence       INTEGER NOT NULL UNIQUE, -- total order; MAX+1 inside the write txn
  reason         TEXT NOT NULL,           -- value-blind: which road revoked it
  invalidated_at TEXT NOT NULL
);

-- Readers take the sequence high-water mark to report the freshness of an
-- answer, so it is worth an index of its own.
CREATE INDEX IF NOT EXISTS idx_grant_invalidations_sequence
  ON grant_invalidations(sequence);

-- ——— Backfill ————————————————————————————————————————————————————————
-- Fail-closed means an existing deployment must arrive with its lineage
-- already recorded, or every live delegation would deny on the first request
-- after upgrade. Both statements below are part of this migration's
-- transaction, so the fence is complete the moment it exists.
--
-- Note the two id spellings. `grants.id` holds `GrantId::to_string()`
-- ('grant:<uuid>'), while `body_json.parent_grant_id` is the serde form (a
-- bare uuid, because the newtype is #[serde(transparent)]). The join
-- reconstructs the column spelling rather than stripping it, so a row whose
-- parent is absent simply is not reached — and a grant with no lineage row
-- fails closed, which is the correct answer for an ancestry we cannot prove.
INSERT OR IGNORE INTO grant_lineage
  (grant_id, root_grant_id, parent_grant_id, depth, ancestor_path, recorded_at)
WITH RECURSIVE tree(grant_id, root_grant_id, parent_grant_id, depth, ancestor_path, recorded_at) AS (
  SELECT id, id, NULL, 0, '/' || id || '/', created_at
    FROM grants
   WHERE json_extract(body_json, '$.parent_grant_id') IS NULL
  UNION ALL
  SELECT g.id,
         t.root_grant_id,
         t.grant_id,
         t.depth + 1,
         t.ancestor_path || g.id || '/',
         g.created_at
    FROM grants g
    JOIN tree t
      ON t.grant_id = 'grant:' || json_extract(g.body_json, '$.parent_grant_id')
   WHERE t.depth + 1 < 16  -- MAX_FENCE_DEPTH; a deeper chain is refused, not truncated
)
SELECT grant_id, root_grant_id, parent_grant_id, depth, ancestor_path, recorded_at
  FROM tree;

-- Every grant already revoked becomes a fence row, so the fence never reports
-- a dead grant as clear. `revoked_at` the column wins over the one inside
-- body_json: `revoke_grant` writes the column without rewriting the body.
INSERT OR IGNORE INTO grant_invalidations
  (grant_id, sequence, reason, invalidated_at)
SELECT id,
       ROW_NUMBER() OVER (ORDER BY COALESCE(revoked_at, created_at), id),
       'backfill:pre-fence-revocation',
       COALESCE(revoked_at, json_extract(body_json, '$.revoked_at'), created_at)
  FROM grants
 WHERE revoked_at IS NOT NULL
    OR json_extract(body_json, '$.revoked_at') IS NOT NULL;
