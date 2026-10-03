-- ADR 0159: one agent-hooks policy per organization — the document
-- `opensesame-agent-hooks` parses (`HookPolicy`, version 1), stored in its
-- canonical form with every default filled, so what the Host decides with is
-- exactly what an operator reads back. `version` is the compare-and-set
-- counter behind the policy route's ETag/If-Match: it starts at 1 on the
-- first write and rises by one on every replacement. An organization with no
-- row decides under the built-in default (every tool escalates, credentials
-- are redacted) and reports version 0.
--
-- organization_id carries no foreign key, like connections: an operator may
-- configure an organization the control plane has not materialized yet.
CREATE TABLE IF NOT EXISTS agent_hook_policies (
  organization_id TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);
