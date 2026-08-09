# Audit 2026-08-08 — three deferred authority bounds

Three findings that earlier ticks recorded as "needs a data-model change" turned
out to need less than that.

## 1. A grant's action list constrained nothing (tick 51)

`authorize_authority_use` overwrote the requested action with
`grant.actions.first()` before handing the request to the policy engine. The
engine's check is "is this action in the grant?", so the grant was being compared
against itself: a grant listing `repository.read` authorized a
`pull_request.create` all the same, and only the first action was ever exercised.

A use now names the action it exercises. The named action must appear in
`grant.actions`, and a use that names none is denied rather than assigned one —
a use with no action cannot be checked against a list of actions. Arguments moved
into an `AuthorityUse` struct, since the parameter list had grown past reading.

## 2. A task could be labelled with somebody else's organization (tick 69)

`start_task` took `organization_id` from the body and checked only that the caller
owned the `principal_id`. Invocation was already closed — `invoke_frozen` compares
the intent's organization against the grant's — but the task record and its audit
trail carried a label nobody verified.

The organization must now be one the caller holds authority in, which in this
deployment is the bootstrap organization; anything else is `403
organization_mismatch`. When the gateway gains a real membership store the same
check reads from it instead of from the bootstrap.

## 3. L2 took the placeholder and the credential from the request (tick 65)

`HostRuntime::invoke_l2_placeholder` read both `placeholder` and `material` from
request parameters. It was a demo path, so the "secret" was the caller's own
string and nothing leaked — but the shape was wrong, and the shape is what a real
L2 path would inherit.

The host now holds a `HostConnection` per connection reference: the projection it
issued and the credential it will write behind that projection's placeholder. A
request may name the connection, because that is what a reference is for, and it
must repeat the placeholder in order to place it — but a request that names
`material` is refused outright, a request naming a placeholder other than the
issued one is refused, and a connection this host holds nothing for cannot be
exercised at all.

## Not fixed here

- The gateway's HTTP surface has no test harness; these routes are covered only by
  module-level unit tests, so the organization fence is verified by construction
  and by `cargo clippy`/`cargo test`, not by a request. A harness is worth its own
  change.
- Task ceilings are still not bounded against issued grants; that still needs a
  grant issuance path for ordinary principals.

## Verification

- `cargo test --workspace` — green
- `cargo clippy --workspace --all-targets -- -D warnings` — clean
