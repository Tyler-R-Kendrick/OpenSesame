-- ADR 0156: a hosted run's hook records belong to the run, and go with it.
--
-- 0050 created agent_hook_records with the run id as a bare column, so
-- nothing tied a record to an observation run: a record could name a run that
-- never existed, and the rows outlived a run that was removed by any path
-- other than the explicit purge. runner_steps (0025) has always cascaded from
-- its run; the audit of what a run was allowed to do now does too.
--
-- The foreign key is the composite (organization_id, run_id) onto the run's
-- UNIQUE(organization_id, id), so a record also cannot name another tenant's
-- run. SQLite cannot add a constraint to an existing table, so the table is
-- rebuilt: the new one is filled from the old, keeping only rows whose run
-- exists in the same organization (a row with no parent has nothing to
-- belong to and no reader), then swapped in under the old name.
CREATE TABLE agent_hook_records_v2 (
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
  PRIMARY KEY (run_id, sequence),
  FOREIGN KEY (organization_id, run_id)
    REFERENCES observation_runs(organization_id, id) ON DELETE CASCADE
);

INSERT INTO agent_hook_records_v2
  (run_id, organization_id, sequence, interception_point, decision, escalated,
   reason, decided_by, input_identity, enforced_identity, policy_version, recorded_at)
SELECT r.run_id, r.organization_id, r.sequence, r.interception_point, r.decision,
       r.escalated, r.reason, r.decided_by, r.input_identity, r.enforced_identity,
       r.policy_version, r.recorded_at
FROM agent_hook_records r
WHERE EXISTS (
  SELECT 1 FROM observation_runs o
  WHERE o.id = r.run_id AND o.organization_id = r.organization_id
);

DROP TABLE agent_hook_records;

ALTER TABLE agent_hook_records_v2 RENAME TO agent_hook_records;

CREATE INDEX IF NOT EXISTS idx_agent_hook_records_org
  ON agent_hook_records(organization_id, run_id);
