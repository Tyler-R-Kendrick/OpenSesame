# Audit tick 63 — a grant covers what it was narrowed to

Scanners (cve-lite, semgrep, ast-grep, gitleaks, cargo-audit, cargo-deny, clippy,
task-security-battle-test) were clean. The reading was `crates/broker`'s frozen
invoke path and `crates/authz`'s decision function.

## The frozen invoke path ignored every narrowing field on the grant (fixed)

`Broker::invoke_frozen` compared the intent's organization to the grant's and
stopped there. `AuthzEngine::decide` then checked the grant's actions, resources,
audience, and required assurance. Nothing anywhere compared the grant's

- `beneficiary_principal_id`,
- `project_id`, `actor_id`, `actor_instance_id`, `client_id`, `connection_id`

against the intent. A grant issued to one principal, for one agent, one project
and one connection therefore authorized any intent in that organization whose
action, resource and audience happened to fit — which is precisely what those
fields exist to forbid (ADR 0027, one effective authority).

`assert_grant_covers_intent` now runs before authorization. `None` on the grant
means unscoped in that dimension; `Some` means the intent must name the same
thing. An intent that names nothing does not satisfy a grant that names
something — reading it the other way is how a scoped grant quietly became an
unscoped one.

## The intent named an actor that did not exist (fixed)

`POST /api/v1/tasks/intents` stamped every frozen intent with a fresh
`ActorId::new()`, no connection, and whatever project the task run carried
(always `None`). The receipt's actor was therefore meaningless, and no grant
narrowed to an actor or a connection could tell whether it covered the call.

Freezing now stamps the intent with the authority the invoke actually executes
under — the bootstrap actor, connection, and project — so the bindings above are
satisfied by naming the right thing rather than by naming nothing.

## Read and left alone

- The digest is recomputed and re-asserted before execution, execution reads only
  `canonical_arguments`, and the task state version, state digest, and ceiling
  digest are all re-checked at invoke.
- Idempotency returns the prior receipt rather than re-executing.
- The demo bootstrap grant remains the only grant available to this path, so
  bounding `start_task` ceilings against issued grants is still open — it needs a
  grant issuance path for ordinary principals.
