# opensesame-dns-enforcement

DNS-layer enforcement against [Blocky](https://github.com/0xERR0R/blocky),
pinned at `v0.35.0`, with a truthful account of what that covers. A resolver
that refuses to answer for a name is a real enforcement point — it sits outside
the subject — and a narrow one; most of this crate keeps the second fact as
visible as the first. It builds per-unit isolated domain filtering, allowances
that only narrow, and list reconciliation the caller drives. Every claim about
Blocky's behaviour was measured against the pinned build.

## Where it fits

- **Used by:** no workspace crate or app yet. It is exercised by its own unit
  and protocol tests and by the general-authority gate
  (`pnpm test:authority-fabric`,
  [`scripts/test/authority-fabric-gate.mjs`](../../scripts/test/authority-fabric-gate.mjs)),
  whose scenario registry in `scripts/lib/authority-fabric-scenarios-*.mjs`
  runs its `coverage`, `blocky::request` and `topology` unit tests and
  `tests/family_blocky.rs`.
- **Builds on:** no other `OpenSesame` crate — `reqwest`, `url`, `chrono`,
  `serde`, `thiserror`.
- **An allowance is a list entry, never a disable.** A Blocky disable with no
  `groups` turns off every group indefinitely, so nothing here maps an
  allowance onto a disable, and `DisableGroups` cannot be built empty.
- **Client identities isolate, list groups do not.** `topology` refuses a
  configuration that binds one client to more than one enforcement unit.
- **Nothing in Blocky expires a list entry.** `lifetime` names who holds each
  deadline; the crate runs no timer, and reconciliation is a pure function.
- Unreachable Blocky is `Refusal::CapabilityUnavailable`; reachable but not
  blocking is `Refusal::NotEnforcing`. Neither is reported as success.

## Surface

| Module | What it holds |
|---|---|
| `scope` | `DomainRule` — which names an allowance may name, and how one narrows another |
| `topology` | `Topology`, `UnitId`, `ClientId` and the isolation audit |
| `lifetime` | `Allowance`, `ExpiryHolder`, `ReconciledLists` |
| `coverage` | `Coverage`, `Claim`, `Uncovered` — what DNS enforcement covers and the claims it refuses |
| `blocky` | The pinned protocol as pure request specs and parsers: `PINNED_VERSION`, `DisableGroups`, `BlockingStatus`, `QueryOutcome`, `Resolution` |
| `transport` | `BlockyEndpoint` (`preflight`, `apply_allowlist` via temp file and rename) |
| `refusal` | `Refusal` |

## Develop

```bash
cargo +1.88.0 test -p opensesame-dns-enforcement --lib

# Against a disposable local Blocky (needs Go; builds the pinned release):
eval "$(crates/dns-enforcement/harness/blocky-env.sh up)"
cargo +1.88.0 test -p opensesame-dns-enforcement -- --test-threads=1
crates/dns-enforcement/harness/blocky-env.sh probe-isolation
crates/dns-enforcement/harness/blocky-env.sh down
```

`tests/blocky_protocol.rs` prints a `SKIP` line and does nothing when
`OPENSESAME_BLOCKY_API` is unset. `tests/family_blocky.rs` always runs: it
starts the harness itself and either measures the resolver or asserts that the
harness recorded why it could not start. `--test-threads=1` is required because
the protocol tests mutate one instance's state.

## Related

- [`docs/validation/dns-enforcement-coverage.md`](../../docs/validation/dns-enforcement-coverage.md)
  — the measurements and what may be claimed from them
- [ADR 0120](../../docs/adr/0120-generalized-hierarchical-authority.md) —
  generalized hierarchical authority
- [`docs/operators/general-authority-support-matrix.md`](../../docs/operators/general-authority-support-matrix.md)
- [`crates/enforcement`](../enforcement) — how a platform's guarantees are
  described
