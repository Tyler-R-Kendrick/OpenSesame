-- Web-login rotation targets, and the sealed observation log behind live
-- session preview (ADR 0076, ADR 0081).
--
-- Two jobs:
--   1. Widen rotation_policies.target_kind to admit 'web_login'.
--   2. Create the observation log: one run row per sandboxed rotation run, and
--      an append-only sealed event log the live viewer tails and the replay
--      overlay seeks in.
--
-- Conventions follow 0017_lifecycle_hooks.sql: TEXT primary keys, RFC3339 TEXT
-- timestamps, version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0) on mutable
-- rows, and no foreign key on organization_id (the scanner runs against
-- whatever organization the gateway is configured with; see 0017's note).

-- —— 1. web_login becomes a rotation target ————————————————————————
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- `ensure_rotation_schema()` in crates/connection-broker/src/store.rs performs
-- the same widening for pools that never ran the embedded migrations; both
-- entry points converge on this shape.
--
-- 0018 always runs first and leaves rotation_policies carrying the lease
-- columns, so the copy below moves every column. Re-CREATEing the pre-lease
-- shape here would be worse than redundant: on the one path where it did
-- anything it would silently drop `attempts` and `needs_attention`, which are
-- exactly the columns that keep a rotation that is not happening visible.
CREATE TABLE IF NOT EXISTS rotation_policies_widened (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('connection','store_path','web_login')),
    target_id TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    last_rotated_at TEXT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    lease_until TEXT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NULL,
    needs_attention INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO rotation_policies_widened
  (id, organization_id, target_kind, target_id, interval_seconds, last_rotated_at,
   enabled, lease_until, attempts, next_attempt_at, needs_attention, last_error,
   created_at, updated_at)
SELECT id, organization_id, target_kind, target_id, interval_seconds, last_rotated_at,
       enabled, lease_until, attempts, next_attempt_at, needs_attention, last_error,
       created_at, updated_at
FROM rotation_policies;

DROP TABLE rotation_policies;
ALTER TABLE rotation_policies_widened RENAME TO rotation_policies;

CREATE INDEX IF NOT EXISTS idx_rotation_policies_org
  ON rotation_policies(organization_id);
CREATE INDEX IF NOT EXISTS idx_rotation_policies_claimable
  ON rotation_policies(enabled, next_attempt_at, lease_until);

-- —— 2. the observation log ————————————————————————————————————————
--
-- One run, and the control lease projected onto columns so a second gateway
-- process cannot also grant it. `version` is the optimistic-concurrency guard:
-- a control transition writes only when the version it read is still current,
-- which is what makes "exactly one driver" hold across processes rather than
-- only within one.
CREATE TABLE IF NOT EXISTS observation_runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  -- The rotation job this run observes.
  job_id TEXT NOT NULL,
  -- The relying party. An origin, never an account.
  target_origin TEXT NOT NULL,
  -- Which rung of the ADR 0076 ladder is executing. 't3' has no model in the
  -- loop and therefore never writes to the thought lane.
  tier TEXT NOT NULL CHECK (tier IN ('t3','t4')),
  -- crates/session-observe ControlState / Quiescence, projected.
  control_state TEXT NOT NULL CHECK (control_state IN
    ('agent_driving','handoff_requested','awaiting_human','human_driving',
     'resume_requested','suspended')),
  quiescence TEXT NOT NULL DEFAULT 'quiescent' CHECK (quiescence IN ('quiescent','critical')),
  handoff_queued INTEGER NOT NULL DEFAULT 0 CHECK (handoff_queued IN (0,1)),
  -- Who is driving. NULL unless a human is.
  lease_holder TEXT,
  lease_expires_at TEXT,
  -- The principal the log is sealed to, and the xkeys recipient key id used.
  owner_principal_id TEXT NOT NULL,
  viewer_key_id TEXT NOT NULL,
  -- Next sequence number to hand out; the log is append-only and gapless.
  next_seq INTEGER NOT NULL DEFAULT 0 CHECK (next_seq >= 0),
  -- Value-blind hint for why the run parked. Never a page body.
  blocked_reason TEXT,
  -- ADR 0076 §5: retention is the observation window, not forever.
  expires_at TEXT NOT NULL,
  closed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(organization_id, id),
  CHECK (length(target_origin) > 0),
  CHECK (length(owner_principal_id) > 0),
  CHECK (length(viewer_key_id) > 0),
  -- A driver is recorded exactly when the state says one is driving. Neither
  -- half can exist without the other, so "who did this" is never unanswerable.
  CHECK ((control_state = 'human_driving') = (lease_holder IS NOT NULL)),
  -- A lease without an expiry is a lease that never times out, and ADR 0081 §7
  -- turns on expiry parking the run.
  CHECK ((lease_holder IS NULL) OR (lease_expires_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_observation_runs_org_time
  ON observation_runs(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_observation_runs_job
  ON observation_runs(job_id);
CREATE INDEX IF NOT EXISTS idx_observation_runs_expiry
  ON observation_runs(expires_at);

-- The log itself. Live tails it, replay seeks in it — one artifact, one
-- retention, one redaction path (ADR 0081 §1).
--
-- There is deliberately NO plaintext column. The runner seals each event to the
-- owner's viewer key before it reaches here, so the gateway relays a body it
-- cannot read; the courier property is the absence of a column, not a promise.
CREATE TABLE IF NOT EXISTS observation_events (
  run_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  lane TEXT NOT NULL CHECK (lane IN ('action','thought','frame')),
  -- Thought lane only: the action this rationale precedes.
  of_step INTEGER,
  -- Frame lane only: the layout generation the frame was composited under, the
  -- value crates/session-observe's admit_frame gated on.
  layout_epoch INTEGER,
  ciphertext BLOB NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK (length(ciphertext) > 0),
  -- The ObservationEvent enum's shape, enforced by the database: a thought
  -- always names its step, a frame always names its epoch, and neither can
  -- carry the other's field.
  CHECK ((lane = 'thought') = (of_step IS NOT NULL)),
  CHECK ((lane = 'frame') = (layout_epoch IS NOT NULL)),
  FOREIGN KEY (run_id) REFERENCES observation_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_observation_events_run_seq
  ON observation_events(run_id, seq);
