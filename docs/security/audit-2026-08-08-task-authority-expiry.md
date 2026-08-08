# Audit tick 39 — task authority expiry, fenced result buffers

Scanners (osv-scanner, gitleaks, cargo-deny, cve-lite, task-security-battle-test)
were clean on `main` (62db7ea). The findings come from reading the Trust Ratchet
engine in `crates/task-access`.

## 1. Task authority never expired

`TaskRun::maximum_expires_at` was only consulted when bounding a credential
renewal window. Nothing compared it against the clock, and `assert_capability` —
the enforcement gate used by `POST /v1/tasks/:id/freeze-intent` and
`Broker::invoke_frozen` — only checked status, state version and ceiling digest.
A run therefore kept authorizing work indefinitely past its deadline, which is
precisely the property ADR 0018 relies on to make task authority safer than a
standing grant.

Fix: `TaskRun::assert_not_expired(now)` (new `DomainError::TaskExpired`), called
from `assert_capability` and `renew_credential`. `assert_capability` now takes
`now`; both call sites pass the same instant they already use for freshness.

## 2. A superseded result buffer was released by a later commit

`ProtectedResultBuffer` is keyed by task run, but `commit_transition` released
whatever buffer it found. A proposal that carried a payload and demanded
mediation acknowledgements could be superseded by a second proposal with no
payload and no required acknowledgements; committing the second one released the
first one's payload, defeating the enforcement fence (ADR 0028). Release is now
bound to the committed transition's id **and** target state version.

## 3. Lost updates on non-CAS writes

`propose_restriction` and `terminate_task` persisted with `save_run`, so a
concurrent commit could be overwritten by a stale in-memory copy — restoring the
wider pre-restriction capability set. Both now use `save_run_cas` against the
version they validated.

Tests: `capability_assertion_expires_with_the_task` and
`superseded_result_buffer_stays_held_after_a_later_commit` in
`crates/task-access/src/tests.rs`. `cargo test --workspace`, clippy,
`cargo fmt --check`, `pnpm run test:task-access` and semgrep are clean.
