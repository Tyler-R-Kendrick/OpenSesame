-- ADR 0156: the append-only audit of every agent-hooks verdict the Host's
-- intercept route answers.
--
-- Until now each decision was an `agent_hooks.decision` outbox event. The
-- backup actor drains that outbox for every organization, so an agent-hooks
-- caller made it dead-letter events (no target) or commit a no-change
-- snapshot per pass (a target), and the outbox grew with agent traffic. An
-- audit trail is not a change feed: nothing needs to replay it, and no
-- snapshot contains it. It lives in its own table, written in the request
-- that produced the verdict and trimmed by a retention actor (default 90
-- days, `OPENSESAME_AGENT_HOOK_DECISION_RETENTION_DAYS`).
--
-- Value-blind exactly as the outbox payload was: the interception point, the
-- decision, whether it escalated, a reason that is a short machine
-- identifier, the policy version — and who asked. Never the tool name, the
-- target, a transform's value or a verdict's message (agent-hooks/0.1 §14).
--
-- `id` is the pagination cursor: it rises with every append, so "older than
-- this row" is a range on the primary key, stable while rows are appended.
-- organization_id carries no foreign key, like the policy table.
CREATE TABLE IF NOT EXISTS agent_hook_decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  organization_id TEXT NOT NULL,
  -- `operator` or the calling session's principal.
  caller TEXT NOT NULL,
  -- NULL when the context named none of the eight points (unreadable body).
  interception_point TEXT CHECK (interception_point IS NULL OR interception_point IN
    ('agent_startup', 'input', 'pre_model_call', 'post_model_call',
     'pre_tool_call', 'post_tool_call', 'output', 'agent_shutdown')),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'transform')),
  escalated INTEGER NOT NULL CHECK (escalated IN (0, 1)),
  reason TEXT,
  policy_version INTEGER NOT NULL CHECK (policy_version >= 0),
  created_at TEXT NOT NULL,
  CHECK (length(organization_id) > 0),
  CHECK (length(caller) > 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_hook_decisions_org
  ON agent_hook_decisions(organization_id, id);
CREATE INDEX IF NOT EXISTS idx_agent_hook_decisions_org_decision
  ON agent_hook_decisions(organization_id, decision, id);
CREATE INDEX IF NOT EXISTS idx_agent_hook_decisions_org_point
  ON agent_hook_decisions(organization_id, interception_point, id);
CREATE INDEX IF NOT EXISTS idx_agent_hook_decisions_retention
  ON agent_hook_decisions(created_at);

-- Append-only: a row is written once and removed only by retention. There is
-- no path that rewrites what a verdict was.
CREATE TRIGGER IF NOT EXISTS agent_hook_decisions_no_update
BEFORE UPDATE ON agent_hook_decisions
BEGIN
  SELECT RAISE(ABORT, 'agent_hook_decisions is append-only');
END;
