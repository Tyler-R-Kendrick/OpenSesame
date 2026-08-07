# Current implementation audit — task-scoped authority

**Baseline commit:** `8c27f0afe861aab065f5f3e0d874dfe1bdf6fb9f`  
**Audit date:** 2026-08-07

## Summary

This slice adds pure Rust domain types for **task-scoped authority** in `crates/domain`, the Trust Ratchet engine in `crates/task-access`, DPoP validation in `crates/proof`, and protocol profile adapters for MCP (Bearer) and experimental AAuth (draft-10).

## New modules

| Module / crate | Purpose |
|----------------|---------|
| `capability.rs` | Capability algebra (Exact/Enumerated selectors), fail-closed attenuation |
| `authority_context.rs` | Single-principal and conservative common-grant modes |
| `task.rs` | Task template/run lifecycle, ceiling compilation, ratchet transitions |
| `delegation_chain.rs` | Ordered delegation hops with cycle/depth validation |
| `proof.rs` | Proof keys, purposes, bindings |
| `protocol_profile.rs` | Built-in profile constants (DPoP, Bearer, MCP, etc.) |
| `protected_resource.rs` | Protected resources and external capability mappings |
| `authorization_requirement.rs` | Derived authorization requirements |
| `mediation.rs` | Mediation points and enforcement acknowledgements |
| `verification_evidence.rs` | Evidence records for validation and ratchet commits |
| `frozen_intent.rs` | `FrozenIntentV2` with domain-separated digest |
| `crates/task-access` | Trust Ratchet engine, credential metadata, result buffers |
| `crates/proof` | RFC 9449 DPoP validation and constrained key custody |
| `crates/protocol-mcp` | MCP 2026-07-28 Bearer profile; audience/resource validation; passthrough rejection |
| `crates/protocol-aauth` | Feature-gated (`experimental-aauth`) AAuth draft-10 lossless mappings |

## Legacy compatibility

- `Intent` remains V1; `Intent::compatibility_notes()` marks non-task-secured legacy intents.
- `FrozenIntentV2::from_legacy` migrates explicitly; digest computed over `b"OpenSesame/FrozenIntent/v2\0" || canonical bytes`.

## Wired in this slice

- `Broker::invoke_frozen` — authorize/execute from frozen digest only (no second parameter map)
- Gateway `POST /api/v1/tasks`, `GET /api/v1/tasks/{id}`, `POST /api/v1/tasks/intents`
- Protected-resource metadata: DPoP advertised only when `OPENSESAME_DPOP_ENABLED=true`
- Receipt schema v2 optional task binding fields (legacy v1 still verifies)

## Residual / next

- Live Postgres multi-node fence E2E against `OPENSESAME_TEST_DATABASE_URL` (in-memory CAS/fence covered; ignored integration test present)
- CLI `opensesame task *` commands; console ratchet UI
- HTTP Message Signatures validator (profile registered, crypto not yet)
- Public AAuth endpoints (adapter only; feature-gated)

## ADRs (this slice)

- ADR 0018–0031 — standing grants, immutable ceiling, trust ratchet, frozen intent, proof custody, MCP Bearer, credential issuer, AAuth experimental, mission vs task policy, one effective authority, enforcement fencing, protocol token identity, verification evidence, SQLite vs Postgres task store

## Verification

```bash
./scripts/task-security-battle-test.sh
```
