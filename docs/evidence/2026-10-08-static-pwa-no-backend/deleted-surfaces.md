# Deleted surfaces — Host / Identity / daemon (2026-10-08)

Branch: `cursor/delete-host-identity-daemon-b359`.

## Removed paths (`git rm -r`)

| Area | Path |
| --- | --- |
| Daemon API | `crates/daemon/` |
| Worker host | `crates/worker/` |
| Identity API | `packages/control-plane/` |
| Identity worker | `packages/identity-worker/` |
| Identity DB | `packages/database/` |
| Device auth (Identity) | `packages/device-auth/` |
| Host TS client | `packages/api-client/` |
| Webhook signing (Identity delivery) | `packages/webhooks/` |
| Mock upstream IdP | `tools/mock-upstream-idp/` |
| Pages serverless | `apps/pages/api/` |

## Config / ops updates

- Root `Cargo.toml`: removed `crates/daemon`, `crates/worker` workspace members.
- Root `package.json`: relay-oriented dev scripts; dropped Identity DB bootstrap
  and control-plane openapi generation.
- `pnpm-workspace.yaml`: dropped `tools/mock-upstream-idp`.
- `ops/compose/docker-compose.yml`: single `relay` service (`opensesame relay run`).
- `ops/compose/Dockerfile`: relay-only default CMD; documented in header comment.
- `.github/workflows/publish-containers.yml`, `container-build-pr.yml`: relay-only
  naming/comments.
- `docs/operators/publishing.md`: GHCR described as relay-only image.
- `docs/audit/2026-10-static-pwa-inventory.md`: **Deleted planes** section.

## Intentionally kept

- `crates/gateway/` with `src/vault_relay/` (optional durable peer, ADR 0181).
- Client: `packages/app-core/`, `apps/pages/src/`, sealed-store / human-vault /
  vault-core paths unchanged by this deletion slice.
- `@opensesame/oauth-provider` (not Identity-only; still used outside deleted
  packages).

## Follow-up / known blockers

- **`packages/notification-adapters`** still imports deleted `@opensesame/webhooks`;
  remove or inline webhook helpers in a follow-up (Identity delivery stack gone).
- **`packages/mcp-client`**, **`packages/mcp-host`**, **`packages/cli`**
  `host-commands.ts` still reference deleted `@opensesame/api-client` / Host API.
- **Quality baselines** (`tools/quality/*.json`) still list deleted package paths
  until `pnpm quality:gate --update` (or manual ledger shrink) on a green tree.
- **CI** Web Push job (`.github/workflows/ci.yml`) and bundle shards referencing
  `verify:push` need removal or retargeting (Identity API deleted).
- **Docs** under `docs/operators/` that describe control-plane / daemon remain as
  history until rewritten or archived.

## Verification (this PR)

```bash
# Should fail (paths gone):
ls crates/daemon packages/control-plane apps/pages/api

# Should succeed:
test -d crates/gateway/src/vault_relay
```
