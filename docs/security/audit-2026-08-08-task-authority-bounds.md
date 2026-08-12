# Audit tick 69 — a number from the caller decided how long authority lives

Scanners clean (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit). Read
`apps/mcp-host` (tools, host API fences, task context) and the Host API task routes it
drives in `apps/gateway/src/routes/tasks.rs`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `start_task` took `ttl_seconds` from the request body and handed it straight to `chrono::Duration::seconds`. Nothing bounded it, so a task's authority could be asked to live for centuries — and at the extremes of `i64`, chrono answers an out-of-range second count by panicking, so the request took the handler down instead of being refused. | `bounded_ttl` refuses anything outside 1..=86400 before a duration is built. A test pins that chrono really does panic on `i64::MAX`, which is why the check comes first. |
| Medium | The capability ceiling was built from an unbounded array. A ceiling is meant to be the short list of what a task needs, and it is digested and carried on every intent it authorizes. | At most 64 capabilities, at least one. |
| Medium | `task_status` fed its response into `updateTaskFromResponse`, which adopted whatever task it described. The tool takes a `task_run_id` from the model, so reading another task made it the active one — a look became a move. | Adoption is now explicit: `task_start` adopts, `task_status` only refreshes the task already active. |
| Low | `operator_invoke_l1` left the spent intent in the task context. The server consumes a digest once, so a second call could only be refused, but the context went on describing authority that no longer existed. | `clearFrozenIntent` after the invoke. |

The MCP tool schema now mirrors the Host API's bounds (≤64 capabilities, ≤86400s), so
a model gets a clear local refusal rather than a 400 from the far end.

## Not fixed

~~`start_task` still takes `organization_id` from the body~~ — closed in
`audit-2026-08-08-authority-bounds.md`: the organization must be one the caller holds
authority in (the bootstrap organization in this deployment), or the call is `403
organization_mismatch`.

Task ceilings are still not bounded against issued grants; that needs a grant issuance
path for ordinary principals.
