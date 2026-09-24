# Audit tick 51 — a grant's resource scope was decorative

Date: 2026-08-08
Scanners: cargo-audit, cve-lite, semgrep, ast-grep, osv-scanner, gitleaks, cargo-deny, clippy, security battle test

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| High | `PolicyEngine::decide` checked `grant.actions` but never `grant.resources`, so a grant scoped to `repo:acme/catalog` authorized the same action against any resource the relationship check happened to allow. Half of every issued grant was unenforced. | `Grant::permits_resource` is now consulted for `connector_operation` requests — the invoke path the broker uses. Wildcards keep their separator (`repo:acme/*` cannot reach `repo:acme-private/…`), an exact name cannot reach a longer sibling, and an empty resource list covers nothing. |
| Medium | `authorize_authority_use` relabelled its request as a `connector_operation` with the placeholder id `"op"` before calling the engine. With the check above in place, that placeholder would have satisfied a grant's resource scope on the strength of a resource nobody named. | The request stays `connection`-scoped and the engine gained a matching relationship branch. On that path the target is the URL, already fenced by `EgressBinding::allows_url`. |

## Notes

- Three existing tests failed the moment the check was added, all because their
  fixtures requested resources their grants never named. They passed only because
  nothing looked. Two were corrected to use the granted resource, and a negative
  case was added alongside: same subject, same granted action, a resource outside
  the grant, denied with reason `grant_resource`.
- Follow-up, not fixed here: `authorize_authority_use` still overwrites the action
  with `grant.actions.first()`, so the grant's action list does not constrain an
  authority use either. Fixing it means grants must name `connection.fetch` /
  `connection.invoke`, which is a data-model change rather than an audit fix.
- Follow-up, still blocked: `start_task` accepts a self-declared capability list.
  Bounding it against issued grants needs a grant issuance path for ordinary
  principals — today only the dev bootstrap creates grants, so enforcing it now
  would refuse every real caller.

## Verification

- `cargo test -p opensesame-domain` — resource scope boundaries covered (new test)
- `cargo test -p opensesame-authz` — 15 passed, including the new denial case
- `cargo test --workspace` — 0 failures
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
- cargo-audit, cargo-deny, osv-scanner, semgrep, gitleaks, cve-lite, ast-grep — clean
