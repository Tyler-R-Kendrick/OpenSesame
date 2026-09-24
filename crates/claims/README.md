# opensesame-claims

Claim-token and user-code generation, their digests, and the claim-session
state transition for the Host / authority plane. The Host stores digests, never
the codes themselves: high-entropy secrets (claim tokens, device codes, session
ids) get a bare SHA-256, and low-entropy ones (an 8-letter user code, about
2^35 possibilities) get an HMAC keyed by a server-held pepper and bound to a
purpose and a context, so one recovered code says nothing about another.

## Where it fits

- **Used by:** [`crates/gateway`](../../crates/gateway) (device and browser-pairing
  routes, agent and browser grant middleware, session and agent routes),
  [`opensesame-connection-broker`](../connection-broker) (`delegation.rs`), and
  the fuzz harness in [`tests/fuzz/cargo`](../../tests/fuzz/cargo)
  (`claim_replay`).
- **Builds on:** [`opensesame-domain`](../domain) (`ClaimSession`,
  `ClaimState`, `DomainError`).
- Digest comparison is constant-time (`hash_eq`).
- `hash_low_entropy` separates domains with a fixed purpose prefix
  (`opensesame:low-entropy:v1`) and length-prefixes each part.

## Surface

| Function | What it does |
|---|---|
| `hash_secret(secret)` | `sha256:<hex>` for a high-entropy secret |
| `hash_low_entropy(pepper, context, secret)` | `hmac-sha256:<hex>` for a low-entropy secret |
| `hash_eq(a, b)` | Constant-time equality of two digests |
| `generate_claim_token()` | 32 random bytes, base64url without padding |
| `generate_user_code()` | `XXXX-XXXX` from a 20-consonant alphabet |
| `assert_claim_token(session, presented)` | Refuses a claim that is not pending, has expired, or does not match |
| `complete_claim(session, principal, now)` | `Pending` → `Claimed`, recording who and when |

## Develop

```bash
cargo +1.88.0 test -p opensesame-claims
pnpm audit:miri      # runs this crate's lib tests under Miri, among others
```

The gateway reads the pepper from `OPENSESAME_CLAIM_PEPPER` (declared in
[`.env.schema`](../../.env.schema) as `@required @sensitive`, no runtime
fallback).

## Related

- [ADR 0009](../../docs/adr/0009-claims-vs-device-auth.md) — claims are separate
  from device authorization
- [ADR 0044](../../docs/adr/0044-claimable-connection-delegation.md) —
  claimable connection delegation (peppered, purpose-separated claim tokens)
- [`docs/architecture/claims.md`](../../docs/architecture/claims.md) — claim
  sessions and token form
