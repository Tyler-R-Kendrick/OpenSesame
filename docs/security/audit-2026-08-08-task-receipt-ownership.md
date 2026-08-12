# Audit tick 33 — authenticated ≠ authorized on task and receipt routes

Date: 2026-08-08
Scope: `apps/gateway/src/routes/{tasks,receipts}.rs`, `apps/gateway/src/middleware/auth.rs`

## Scanners

| Check | Result |
|-------|--------|
| gitleaks (working tree) | CLEAN |
| cargo-audit (379 crates) | CLEAN |
| cargo-deny (advisories/bans/licenses/sources) | ok |
| clippy `--workspace --all-targets --all-features` | CLEAN |
| Residual review | task + receipt routes had authentication but no ownership check |

## Findings fixed

### 1. Any session could mint task authority for any principal (high)

`POST /api/v1/tasks` read `principal_id`, `organization_id` and the whole
`capabilities` list from the request body and compiled the immutable ceiling
from them. Tick 23 added `require_session_or_operator`, so the route was
authenticated — but any authenticated session could start a task run *as another
principal* with a self-declared ceiling, which is precisely the authority
laundering ADR 0019 (immutable ceiling) and ADR 0027 (one effective authority)
exist to prevent.

### 2. Task runs were readable, freezable and cancellable across principals (high)

`GET /api/v1/tasks/{id}`, `GET /api/v1/tasks`, `POST /api/v1/tasks/intents` and
`POST /api/v1/tasks/{id}/terminate` looked runs up by id with no ownership
check. Consequences: enumerate every task run and its principal id; freeze an
intent that spends another principal's ceiling and get back an intent digest
bound to them; cancel anyone's task run (denial of service).

### 3. Receipts were readable by id by any session (medium — IDOR)

`GET /api/v1/receipts/{id}` and `POST /api/v1/receipts/{id}/verify` required a
session but not the *right* session. Receipts name the principal, connection,
operation, resource, delegation chain and result summary of an invocation, so
this was cross-principal disclosure of who did what to which resource. Raw
`sqlx` error strings were also returned verbatim on the failure path.

## Fix

Added a shared `Caller` in `middleware/auth.rs` resolved once per request:

- `Operator` — unfenced (the CLI already sends `Bearer operator:…` for all task
  commands, so no caller changes were needed).
- `Principal(id)` — a session, fenced to the principal it was approved as. A dev
  session whose subject is not a principal id resolves to the bootstrap
  principal, which is exactly the principal its invocations are stamped with.
- `Unbound` — authenticated but no resolvable principal; owns nothing.

Then:

- `start_task` rejects a body principal that the caller does not own
  (`403 principal_mismatch`).
- `get_task`, `terminate_task` and `freeze_intent` filter the loaded run through
  `caller.owns(&run.principal_id)` and answer `404` when unowned, so the routes
  are not existence oracles for other principals' runs.
- `list_tasks` returns only the caller's own runs.
- Receipt reads go through one `load_owned` helper (same 404 semantics), and DB
  errors are passed through `opensesame_redaction::redact_text`.

## Known gap (not this tick)

`start_task` still accepts an arbitrary capability list for the caller's *own*
principal — the ceiling is bounded by the caller's identity but not yet by a
stored grant. Bounding compiled ceilings against issued grants needs the grant
store on the task path and is tracked separately.

## Verification

- `cargo clippy --workspace --all-targets --all-features` — clean.
- `cargo test --workspace` — all green, including new `Caller` ownership cases.
- CLI task/intent commands unaffected (operator-token callers).
