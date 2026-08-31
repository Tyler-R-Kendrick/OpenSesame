-- The step queue a local driver claims from (ADR 0078, ADR 0079 §4).
--
-- The executor issues one step and waits for its outcome, so the queue is one
-- step deep per run by design. That is not a limitation to work around: a
-- browser has one DOM, the ordering the executor enforces is sequential, and a
-- queue that could hold two steps for one page would be a queue that could
-- reorder them.
--
-- Conventions follow 0019: TEXT primary keys, RFC3339 TEXT timestamps, and no
-- foreign key on organization_id (see 0017's note); run_id does cascade, because
-- a step outliving its run has nowhere to go.
CREATE TABLE IF NOT EXISTS runner_steps (
  run_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  -- The StepRequest, as JSON. Carries a credential *reference* and a selector;
  -- crates/rotation-web's wire types have no field able to hold a value.
  request_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'claimed', 'settled')),
  -- The principal that claimed it. Only the run's owner may (ADR 0078 §8), and
  -- only the claimant may settle it.
  claimed_by TEXT,
  -- When the claim lapses and the step becomes claimable again. A driver that
  -- crashed releases by the clock rather than by a liveness check, the same
  -- shape backup.rs and the rotation policies use.
  claim_expires_at TEXT,
  -- The StepOutcome, as JSON. Set exactly when state = 'settled'.
  outcome_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, seq),
  CHECK (length(request_json) > 0),
  -- A claim names who holds it and when it lapses, or it is not a claim.
  CHECK (
    (state = 'pending' AND claimed_by IS NULL AND claim_expires_at IS NULL)
    OR
    (state IN ('claimed', 'settled') AND claimed_by IS NOT NULL
      AND claim_expires_at IS NOT NULL)
  ),
  -- An outcome exists exactly when the step is settled. A settled step with no
  -- outcome would be one the executor waits on forever.
  CHECK ((state = 'settled') = (outcome_json IS NOT NULL)),
  FOREIGN KEY (run_id) REFERENCES observation_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runner_steps_claimable
  ON runner_steps(organization_id, run_id, state, seq);
