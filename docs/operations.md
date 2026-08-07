# Operations (identity + dual-plane)

## Health
- Liveness: `GET /v1/health/live`
- Readiness: `GET /v1/health/ready` (DB/signing/config; does not probe external IdPs continuously)

## Local ports
| Service | Port |
|---------|------|
| Identity control-plane | 8788 |
| Mock upstream IdP | 9090 |
| Authority gateway | 8787 |
| Console / RP examples | Vite defaults (see `pnpm dev`) |

## Backup / restore
- PostgreSQL logical dump is the identity store backup.
- Back up issuer signing material and claim-token pepper separately.
- Claim bearer secrets cannot be reconstructed from digests after catastrophic loss; in-flight claims must be re-issued.
- Issuer URL changes break RP trust; treat issuer as sticky.

## Key rotation
Overlap active/retiring signing keys in JWKS until max token lifetime elapses. Pairwise subjects must not change when signing keys rotate (ADR 0011).

## Compose
```bash
docker compose -f deploy/compose/docker-compose.yml up
# Keycloak is already in the default compose file for optional enterprise OIDC brokering.
```

Identity-plane apps can run via `pnpm dev` without Docker when using memory/local Postgres.
