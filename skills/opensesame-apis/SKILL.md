---
name: opensesame-apis
description: Install, configure, initialize, and use OpenSesame Host and Identity APIs
---

# OpenSesame APIs

| API | Port | App |
|-----|------|-----|
| Host / Authority | **8787** | `crates/gateway` |
| Identity | **8788** | `packages/control-plane` |
| Daemon (local) | **18790** | `crates/daemon` |

## Install

```bash
cargo build -p opensesame-cli
pnpm install
pnpm --filter @opensesame/control-plane build
```

## Configure

```bash
# Development: sets the mode, loopback URLs and generates the operator token,
# claim pepper, connection key and receipt signing key under
# ~/.local/state/opensesame/development/ (never printed).
source scripts/dev/local-env.sh
```

A bare `opensesame host run` or `daemon run` refuses to start: both need a
deployment mode (`OPENSESAME_ENV` is `development`, `test` or `production`) and
an `OPENSESAME_OPERATOR_TOKEN` of 32 or more characters; the Host also needs
`OPENSESAME_CLAIM_PEPPER` of the same strength and loopback
`OPENSESAME_RESOURCE` / `OPENSESAME_ISSUER` for a local run (the defaults are
non-loopback and trigger the production safeguards). The Identity API needs a
mode and `OPENSESAME_CLAIM_PEPPER`; `OPENSESAME_ALLOW_DEV_DEFAULTS=1` (exactly
`1` or `0`, local-only) stands in for both in development. Production: set
`OPENSESAME_CLAIM_PEPPER` to a unique secret; never `OPENSESAME_ALLOW_PRINCIPAL_BEARER`.

## Init

```bash
pnpm dev:host      # Host API, 127.0.0.1:8787 (sources scripts/dev/local-env.sh)
pnpm dev:daemon    # local agent, 127.0.0.1:18790 (same environment)
# In a shell that has not sourced local-env.sh:
OPENSESAME_ENV=development OPENSESAME_ALLOW_DEV_DEFAULTS=1 \
  pnpm --filter @opensesame/control-plane start   # Identity API, :8788
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
