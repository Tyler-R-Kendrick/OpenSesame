# Audit — frozen intent custody and ceiling storage (2026-08-08)

Tick 56. Scope: `crates/task-access` (engine, SQLite store, Postgres store) and
the task routes in `apps/gateway/src/routes/tasks.rs`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `invoke_task` removed the frozen intent from the pending map *before* checking who owned it. Anyone who learned a digest could spend another principal's intent, take a 404 for it, and leave the owner with nothing to invoke — the intent was already gone. | `claim_frozen_intent` settles ownership under the same lock and only then removes. Absent and not-owned return the same answer, so the endpoint still says nothing about other principals' work. |
| Low | The Postgres `task_runs` upsert set `capability_ceiling = EXCLUDED.capability_ceiling`, so a non-CAS `save_run` could widen the ceiling of a live run. The SQLite store already left the column alone; the two backends disagreed, and Postgres was the looser one. | The ceiling and its digest are excluded from the conflict update, matching SQLite and ADR 0019. |
| Low | `save_ceiling_digest` was a blind overwrite in all three stores, so the immutable ceiling was immutable only because the read path noticed. | Write-once in the in-memory, SQLite and Postgres stores: the same digest is accepted again, a different one is `CeilingImmutable`. |
| Low | The Postgres store inserted an empty `ceiling_digest` and relied on a second call to fill it, so a crash between the two left a row that failed every later ceiling check. | The digest is derived on insert, as SQLite already did. |

## Notes

- `save_run` is only reached from `start_task`; every later write goes through
  `save_run_cas`, which never touched the ceiling. Excluding the ceiling from the
  upsert therefore removes a capability nothing legitimately used.
- The engine's read-path check (`assert_ceiling_unchanged`) is unchanged and
  still runs before every capability assertion and transition. These fixes mean
  it is no longer the only thing standing between a stray writer and a wider
  ceiling.
- Cross-tenant reads were checked and are fenced: `list_tasks`, `get_task`,
  `freeze_intent` and `terminate_task` all filter on `caller.owns`.

## Gates

`cargo test --workspace` (70 suites), `cargo clippy --workspace --all-targets --
-D warnings`, `pnpm test`, `pnpm run typecheck`, task-security-battle-test,
cargo-audit, cargo-deny, semgrep, ast-grep, osv-scanner, gitleaks, cve-lite —
all clean.
