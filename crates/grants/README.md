# opensesame-grants

The grant compiler for the Host / authority plane: delegation that may only
attenuate its parent. Today it is one function, `delegate`, which links a child
grant to its parent (`parent_grant_id`, `delegation_depth + 1`) and runs
`Grant::validate_attenuation` from [`opensesame-domain`](../domain). A child
that widens any dimension — actions, resources, audiences, lifetime, budgets,
organization, depth — is refused.

## Where it fits

- **Used by:** no workspace crate or app. Its callers are the fuzz harness in
  [`tests/fuzz/cargo`](../../tests/fuzz/cargo) — `fuzz_grant_attenuation`
  (target `grant_attenuation`) calls `delegate` — and the Miri gate
  (`pnpm audit:miri`, [`scripts/audit/miri-gate.sh`](../../scripts/audit/miri-gate.sh)),
  which runs this crate's lib tests. The PR fuzz gate
  ([`scripts/fuzz/fuzz-pr-gate.sh`](../../scripts/fuzz/fuzz-pr-gate.sh)) runs
  the grant targets when `crates/grants/` changes. The attenuation rules
  themselves live in `opensesame-domain` (`grant_attenuation`), which the Host
  calls directly.
- **Builds on:** [`opensesame-domain`](../domain) (`Grant`, `DomainError`).
- Grant JSON carries no secret fields; a test pins that `access_token`,
  `private_key` and `refresh_token` never appear.

## Surface

| Item | What it is |
|---|---|
| `delegate(parent, child) -> Result<Grant, DomainError>` | Links and validates a child grant; errors when it does not attenuate the parent |
| `Grant`, `DomainError` | Re-exported from `opensesame-domain` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-grants
pnpm audit:miri
```

## Related

- [ADR 0044](../../docs/adr/0044-claimable-connection-delegation.md) —
  claimable connection delegation (cites `delegate`)
- [`crates/domain`](../domain) — `grant_attenuation`, `delegation_chain`,
  `validated_grant_chain`
