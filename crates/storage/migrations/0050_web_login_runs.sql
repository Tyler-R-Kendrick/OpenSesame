-- The Host's web-login runner (ADR 0076, ADR 0081, ADR 0159): the recipes it
-- may replay, and the agent-hooks record of every run it hosts.
--
-- Conventions follow 0021: TEXT keys, RFC3339 TEXT timestamps, no foreign key
-- on organization_id.

-- —— 1. recipes a run may replay (T3) ————————————————————————————————
--
-- One recipe per organization and origin. `recipe_json` is the executor's
-- projection of docs/architecture/rotation-recipe-schema.md — the change URL
-- and the selectors `run_change_password` needs — and nothing else: no value,
-- no account, no session. A recipe is a statement about a site, identical for
-- every user of it.
--
-- `trust` is the schema's ladder. The runner replays only `canary_verified`
-- and `corpus`, and only before `expires_at`; a `candidate` (a teaching
-- session's unverified output) is a hypothesis and is never replayed
-- unattended.
CREATE TABLE IF NOT EXISTS web_login_recipes (
  organization_id TEXT NOT NULL,
  -- The relying party's origin, exactly as the rotation target names it.
  origin TEXT NOT NULL,
  recipe_id TEXT NOT NULL,
  trust TEXT NOT NULL CHECK (trust IN ('candidate', 'canary_verified', 'corpus')),
  recipe_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, origin),
  CHECK (length(origin) > 0),
  CHECK (length(recipe_id) > 0),
  CHECK (length(recipe_json) > 0)
);

-- —— 2. the agent-hooks record of a hosted run ———————————————————————
--
-- The payload-free §10.3 projection of each interception record, one row per
-- emission, in `sequence` order. Deliberately narrower than the SDK record:
-- no message (an interceptor may have filled it from what it read), no
-- transform value, and a `reason` kept only when it is a short machine
-- identifier. The identities are `sha256:` digests, never content.
--
-- run_id is the observation run (0021); the rows outlive its log's retention
-- no longer than the run row does.
CREATE TABLE IF NOT EXISTS agent_hook_records (
  run_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  interception_point TEXT NOT NULL CHECK (interception_point IN
    ('agent_startup', 'input', 'pre_model_call', 'post_model_call',
     'pre_tool_call', 'post_tool_call', 'output', 'agent_shutdown')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'transform')),
  escalated INTEGER NOT NULL CHECK (escalated IN (0, 1)),
  reason TEXT,
  decided_by INTEGER,
  input_identity TEXT,
  enforced_identity TEXT,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS idx_agent_hook_records_org
  ON agent_hook_records(organization_id, run_id);
