---
name: opensesame-apis
description: Install, configure, initialize, and use OpenSesame Identity and Host APIs
---

# OpenSesame APIs (separate)

## Host API — `apps/gateway` (:8787)

```bash
cargo run -p opensesame-gateway -- --listen 127.0.0.1:8787
curl -s http://127.0.0.1:8787/health/live
curl -s http://127.0.0.1:8787/api/v1/connections
# Encrypted sync (ciphertext only)
curl -s -X POST http://127.0.0.1:8787/api/v1/sync/push -H 'content-type: application/json' -d '{"blobs":[]}'
```

Uses **host-core**. ConnectionRef invoke — never SecretRef.

## Identity API — `apps/control-plane` (:8788)

```bash
pnpm --filter @opensesame/mock-upstream-idp start
pnpm --filter @opensesame/control-plane start
curl -s http://127.0.0.1:8788/v1/health/live
curl -s http://127.0.0.1:8788/auth.md
curl -s http://127.0.0.1:8788/.well-known/openid-configuration
```

OIDC issuer, principals, claims, passkeys. Do **not** merge with Host API (ADR 0017).
