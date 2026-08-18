# OpenSesame

## What this codebase does

OpenSesame is a dual-plane authorization fabric: a Rust Host/authority plane
(`apps/gateway` :8787, `apps/daemon`, `crates/*`) and a TypeScript Identity
plane (`apps/control-plane` :8788, Better Auth + oidc-provider). Client
surfaces include Pages PWA (`apps/pages`), browser extension, CLIs, and MCP
servers. Secrets stay sealed; agents use ConnectionRef + Intent, never raw
`getSecret()`.

## Auth shape

- Host API: opaque session (`opaque-session:…`), operator bearer
  (`operator:…`), and ConnectionRef / Intent / receipt invoke path
- Identity API: Better Auth sessions + OIDC; principals live in
  `@opensesame/os-domain`, not Better Auth user IDs
- NATS auth callout: shared-secret header; allowlists issuers; never grants
  `opensesame.events.system.>`
- GitHub App webhooks: `X-Hub-Signature-256` HMAC before outbox enqueue
- Sealed store / human vault: xkeys envelopes; never
  `OPENSESAME_CONNECTION_KEY` for TaskBus E2EE

## Threat model

Attackers want: forge Host/Identity sessions, steal sealed vault material,
publish Host-only system bus events, replay webhooks into double side
effects, or escalate Member→Operator. Highest impact is authority bypass
(invoke without grant) and secret/seal-key exfiltration.

## Project-specific patterns to flag

- Any agent-facing API that returns or decrypts vault plaintext / PEM /
  webhook secrets
- Callout or TaskBus ACLs that include `system.>` or `opensesame.events.system`
- Webhook handlers that enqueue before HMAC verify or without atomic
  delivery-id claim
- Production paths that load `OPENSESAME_CONNECTION_KEY` / BrokerConfig seal
  material for xkeys
- Identity↔Host BFF merges or Clerk/Marketplace auth as core

## Known false-positives

- `apps/mock-upstream-idp` and example RPs — intentional insecure fixtures
- `OPENSESAME_ALLOW_DEV_DEFAULTS` / demo bootstrap — gated to development
- In-memory TaskBus and sqlite::memory test harnesses
- Fuzz targets that plant secrets only to assert redaction oracles
- Pages OPFS offline vault ciphertext (E2EE at rest by design)
