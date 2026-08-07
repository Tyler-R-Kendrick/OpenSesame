---
name: opensesame-apis
description: Install, configure, initialize, and use OpenSesame Host and Identity APIs
---

# OpenSesame APIs

| API | Port | App |
|-----|------|-----|
| Host / Authority | **8787** | `apps/gateway` |
| Identity | **8788** | `apps/control-plane` |
| Daemon (local) | **18790** | `apps/daemon` |

## Install

```bash
cargo build -p opensesame-gateway -p opensesame-daemon
pnpm install
pnpm --filter @opensesame/control-plane build
```

## Configure

```bash
export OPENSESAME_LISTEN=127.0.0.1:8787
export OPENSESAME_ENV=development
# Production: set OPENSESAME_CLAIM_PEPPER to a unique secret; never ALLOW_PRINCIPAL_BEARER
```

## Init

```bash
./target/debug/opensesame-gateway --listen 127.0.0.1:8787
OPENSESAME_ENV=development pnpm --filter @opensesame/control-plane start
./target/debug/opensesame-daemon --listen 127.0.0.1:18790
```

## Use

```bash
curl -s http://127.0.0.1:8787/health/live
curl -s http://127.0.0.1:8788/v1/health/live
curl -s http://127.0.0.1:18790/health

# Host: ConnectionRef invoke (L1) — never getSecret
# Identity: claims, principals, MFA /v1/mfa/*
# Sync: POST /api/v1/sync/push|pull with Bearer opaque-session:… (ciphertext only)
```

Agent-facing surface is ConnectionRef + Intent (ADR 0005). No public materialize / `getSecret`.
