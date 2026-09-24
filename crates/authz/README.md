# opensesame-authz

The Host / authority plane's policy decision point: relationship checks plus
contextual constraints, behind an AuthZEN-shaped request and decision. The
decision path is typed end to end — a closed condition algebra, requirements
that only verified evidence can satisfy, one deny-overrides combining rule,
typed refusals, and an explanation projected from them. The same crate holds the
enforcement fence on the grant path, issuance preflight, NATS auth-callout
admission helpers and the Host duress deny ceilings.

## Where it fits

- **Used by:** [`opensesame-broker`](../broker) (authorizes every invoke),
  [`opensesame-host-core`](../host-core) (re-exported as `host_core::authz`),
  [`opensesame-nats-callout`](../nats-callout) (`CalloutPermissions`),
  [`apps/gateway`](../../apps/gateway) (intents, relay, NATS callout, issuance
  preflight routes), and the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) (`nats_callout_eval`).
- **Builds on:** [`opensesame-domain`](../domain) (grants, validated grant
  chains) and [`opensesame-enforcement`](../enforcement) (what a platform can
  hold).
- Deny-overrides with a closed world: any deny denies, any indeterminate layer
  denies, and no applicable rule denies. "No rule matched" is never "allowed".
- A requirement is not evidence: `required_assurance: "mfa"` on a grant is
  satisfied only by the trusted verifier's record, never by a request asserting
  it.
- A non-null `parent_grant_id` is not proof of delegation; only a
  `ValidatedGrantChain` bound to the exact grant and connection is.
- An explanation never carries the request's `context` or `subject.properties`.
- Agents exercise authority through `ConnectionRef` + Intent, never a
  `SecretRef` (`authority_use`).

## Surface

Every module is re-exported at the crate root except `duress`.

| Module | What it holds |
|---|---|
| `engine` | `PolicyEngine::decide`, `RelationshipStore` (in-process tuples), `verified_evidence` |
| `authzen` | `AuthZenRequest`, `AuthZenSubject`, `AuthZenAction`, `AuthZenResource`, `AuthZenDecision`, `AuthZenObligation` |
| `evaluate` | The fail-closed pipeline; each layer returns a `LayerOutcome` |
| `condition`, `condition_set` | The closed `Condition` algebra: narrowing and meet; one condition per dimension |
| `evidence` | Verified evidence versus asserted properties |
| `combine` | The combining rule and layer ranking |
| `error`, `explain` | `DenyReason`, `PolicyFault`, and the sanitized explanation |
| `enforcement_gate` | Projects a `Grant` onto `opensesame_enforcement::GrantTerms` and refuses rather than degrades |
| `issuance` | Issuance preflight: catalog lookup; an unknown platform is a refusal |
| `authority_use` | Custodian-style authority exercise |
| `callout` | NATS auth-callout allow/deny and pub/sub permission lists |
| `duress` | Deny ceilings for authorize / mint / renew / invoke / sign / key-release under an active Host hold |
| `model` | `policy_version_digest` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-authz
```

Integration suites are `tests/policy_*.rs`; contract tests sit beside their
modules (`*_contract.rs`) to keep each under the 400-line budget.

## Related

- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) — generalized hierarchical authority
- [ADR 0046](../../docs/adr/0046-relayed-execution-and-authorization-inbox.md) — relayed execution
- [ADR 0042](../../docs/adr/0042-nats-taskbus-auth-callout-and-xkeys.md) — NATS auth callout
- [ADR 0130](../../docs/adr/0130-duress-profiles-trust-boundaries.md) — duress trust boundaries
- [`spec/openfga/`](../../spec/openfga) — the OpenFGA model;
  [`opensesame-provider-openfga`](../provider-openfga) is the remote client
