# opensesame-ceremony

The vocabulary for connector registration ceremonies on the Host / authority
plane: the work of having an account, being signed in as the right identity,
registering an app, installing it on the right organization and proving it
works. The crate encodes the tier ladder, typed capture slots that fail closed,
ADR 0082 §5's refusals as types, and an outcome that cannot be built without a
round-trip proof. It does no I/O and holds no credential value — a controller
that has the plaintext asks this crate whether it may seal it, and gets back a
digest that redeems nothing.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (`src/routes/ceremonies.rs`),
  [`apps/cli`](../../apps/cli) (`src/ceremony.rs`) and
  [`opensesame-rotation-web`](../rotation-web) (`CeremonyTransport` capture
  verbs).
- **Builds on:** no workspace crates — `serde`, `serde_json`, `thiserror`.
- A provider's own registration flow always wins for the part it covers.
  `tier::resolve` never sends registration to a browser when the provider
  publishes an endpoint for it (for GitHub, the App Manifest flow in
  `crates/gateway/src/routes/github_app.rs`).
- The agent names *which slot* and *where the value is*; it never receives the
  value, and a slot the recipe did not declare cannot be captured.
- Refusals are reachable only through `refusal::Guard::admit`, so a step that
  would break one cannot be issued.

## Surface

| Module | Main items |
|---|---|
| `tier` | `Tier` (`c0_provider_native`, `c1_deterministic`, `c2_agentic`, `c3_blocked`), `Phase` (`Preconditions`, `Registration`, `Installation`, `Verification`), `ProviderCapability`, `resolve(phase, capability)` |
| `capture` | `Slot`, `Shape`, `DeclaredSlots` (`declare`, `admit`, `outstanding`), `check_shape`, `CaptureDigest`, `CaptureRefusal`; limits `MIN_TOKEN_CHARS`, `MAX_TOKEN_CHARS`, `MAX_PEM_BYTES` |
| `refusal` | `Guard`, `Act`, `Refusal`, `Consent`, `Presence` (`Watching`, `Absent`) |
| `outcome` | `Completion` (needs a `RoundTrip`), `Incomplete`, `GrantedPermissions` |
| `catalog` | `Catalog`, `CatalogEntry` — compiled in from [`catalog.json`](catalog.json) |

`catalog.json` records per-provider capabilities, never tiers; a provider with
no entry resolves to C3 and keeps the copy-paste instructions it has today.
It is checked in rather than fetched, because asking a server which recipe to
use discloses which provider the user is onboarding.

## Develop

```bash
cargo +1.88.0 test -p opensesame-ceremony
```

`tests/catalog_pact.rs` fails if `catalog.json` names a provider missing from
[`crates/connection-broker/src/catalog.json`](../connection-broker/src/catalog.json).
`tests/github_ceremony.rs` walks the GitHub ceremony end to end.

## Related

- [ADR 0082](../../docs/adr/0082-agent-run-registration-ceremonies.md) —
  agent-run registration ceremonies
- [ADR 0076](../../docs/adr/0076-autonomous-web-login-rotation.md) — web-login
  rotation, whose tool boundary the capture verbs mirror
