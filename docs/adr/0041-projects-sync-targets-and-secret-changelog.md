# ADR 0041: Projects, sync targets, and secret changelog

## Status

Accepted

## Context

Operators compare OpenSesame to Doppler-style projects/configs/sync. OpenSesame
already has Host projects, connection `shareability`, sealed-store tombs, and
E2EE vaults — but not a first-class **sync target** fan-out, durable **secret
changelog**, or **default personal project** binding tombs/vault folders.
Agents must remain on ConnectionRef (ADR 0005); vault ciphertext stays
server-blind (ADR 0032).

## Decision

1. **Host Project** is the primary secrets/env scope. Every principal can
   idempotently ensure a **default personal project**.
2. **SecretConfig** scopes named environments under a project
   (`development|staging|production|custom`).
3. **SyncTarget** binds a config to a connection + connector operation for
   Host-mediated fan-out (ConnectionRef → authorize → invoke). Responses never
   return secret values. Agents never receive `getSecret`.
4. **Changelog** events (`secret.config.*`, `secret.value.changed`,
   `sync.target.*`) are durable audit metadata (key names + versions only —
   never values). Sealed-store git history remains local ciphertext history.
5. Catalog provider `doppler` remains a SaaS connector — not this product.

## Consequences

- Pages/CLI grow project picker, sync-target, and changelog surfaces.
- Rotation and TaskBus publishers emit the frozen event names in
  `docs/implementation/one-shot-doppler-nats-prompt.md`.
- L3 materialize stays craft bar / operator-gated (ADR 0006).

## Related

- [ADR 0005](0005-authority-handle-connectionref.md)
- [ADR 0006](0006-env-spec-delivery-modes.md)
- [ADR 0032](0032-connection-broker-service-integrations.md)
- [ADR 0042](0042-nats-taskbus-auth-callout-and-xkeys.md)
