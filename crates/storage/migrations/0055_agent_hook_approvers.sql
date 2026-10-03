-- ADR 0159: who an organization's escalated agent actions are put to.
--
-- The hook policy decides *whether* an action needs a person; this row says
-- *which* person. It is a sibling of `agent_hook_policies`, not a field of
-- the policy document: the policy is strictly parsed, shown to operators and
-- compared byte for byte against presets, and a handle to somebody's inbox
-- belongs to none of that. It has its own compare-and-set `version` (1 on the
-- first write, +1 on each one after; an organization with no row reports 0),
-- and its audit event commits in the same transaction as the row.
--
-- `approver_ref` is the approver's Identity-plane inbox handle (`inbox_…`,
-- from their own `GET /v1/authorization-requests/inbox-ref`). NULL means
-- "ask nobody": the row stays, so the version keeps rising and a stale
-- editor still loses, and every escalation of the organization is a denial
-- (agent-hooks/0.1 §9). The handle is never written to the outbox or a log;
-- the audit event carries its digest.
--
-- organization_id carries no foreign key, like the policy table.
CREATE TABLE IF NOT EXISTS agent_hook_approvers (
  organization_id TEXT PRIMARY KEY,
  approver_ref TEXT,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  CHECK (length(organization_id) > 0),
  CHECK (approver_ref IS NULL
    OR (approver_ref LIKE 'inbox\_%' ESCAPE '\' AND length(approver_ref) BETWEEN 8 AND 256))
);
