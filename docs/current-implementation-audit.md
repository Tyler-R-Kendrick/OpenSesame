# Current implementation audit — task-scoped authority

**Baseline commit:** `8c27f0afe861aab065f5f3e0d874dfe1bdf6fb9f`  
**Branch:** `feat/task-access-model`  
**Audit date:** 2026-08-07

## Summary

Task-scoped authority is integrated end-to-end: domain algebra, Trust Ratchet engine, durable SQLite CAS store, Postgres distributed store + readiness, DPoP + HTTP Message Signatures proof profiles, MCP Bearer adapter, experimental AAuth HTTP (env-gated), gateway modular Host API, WIT contracts, MCP-host tools, CLI, and console ratchet UI.

## Crates / surfaces

| Area | Status |
|------|--------|
| `opensesame-domain` task/capability/frozen intent | Done |
| `opensesame-task-access` ratchet + credentials | Done |
| `SqliteTaskStore` durable CAS (mandatory tests) | Done |
| `PostgresTaskStore` + `distributed_task_authority` | Done (`postgres-integration` feature for live URL) |
| `opensesame-proof` DPoP + HMS Ed25519 subset | Done |
| `opensesame-protocol-mcp` Bearer / no passthrough | Done |
| `opensesame-protocol-aauth` + gateway `/experimental/aauth/v1/*` | Done (requires `OPENSESAME_AAUTH_EXPERIMENTAL=true`) |
| Gateway modular routes + bootstrap gate | Done (`OPENSESAME_DEV_BOOTSTRAP`) |
| Broker `invoke_frozen` | Done |
| WIT `task` / `proof` / `mediation` @1.0.0 | Done (host@1.0.0 preserved) |
| MCP host task tools | Done |
| CLI `task` / `intent` | Done |
| Console TaskAccessPanel | Done |
| ADRs 0018–0031 | Done |

## Residuals

None for this slice. Live Postgres multi-node against a real cluster is exercised when `OPENSESAME_TEST_DATABASE_URL` is set with `--features postgres-integration`; mandatory CI uses SQLite CAS + in-memory multi-node fence tests.

## Verification

```bash
./scripts/task-security-battle-test.sh
pnpm --filter @opensesame/mcp-host test
pnpm --filter @opensesame/console test
pnpm --filter @opensesame/control-plane test
```
