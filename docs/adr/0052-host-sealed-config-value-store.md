# ADR 0052: Host-sealed project-config value store

## Status

Accepted

## Context

ADR 0041 accepted Projects, SecretConfig, SyncTarget, and the secret changelog,
and the sync-target fan-out landed — but with no store behind it: production
hardcoded `EmptySecretSource`, so every sync pushed zero keys. Sync, rotation,
and operator materialize all need config values readable **on the Host** at
egress time, which the server-blind E2EE human vault (ADR 0032) can never
provide. The broker already holds connection credentials host-sealed at rest
under the deployment seal key; config values destined for third-party sync are
plaintext at the provider anyway, so server-blindness for them is theater.

## Decision

1. Project-config secret values are a **Host-authority store**, sealed at rest
   with the broker deployment `sealing_key()` (XChaCha20-Poly1305 via
   `crypto::seal_with_ad`), in `config_secret_values` /
   `config_secret_value_versions` beside `secret_configs`.
2. The AAD binds the full scope: `org|{o}|project|{p}|config|{c}|key|{k}|v|{n}`.
   Ciphertext transplanted across keys, configs, tenants, or version slots does
   not open. Rollback therefore **re-seals** the old plaintext as a new head
   version; old bytes are never copied into a new slot, and version numbers are
   never reused (tombstones included).
3. The value API is **write-only**: `PUT` accepts values; every read surface
   returns key names + version metadata only. Decryption happens exclusively
   in-process for sync fan-out, rotation, and operator-gated materialize
   (ADR 0006/0049). Agent-scoped tokens are denied on the whole route group;
   there is no agent `getSecret`, ever (ADR 0005).
4. Every mutation appends, in the same transaction: an immutable versions row,
   a `sync.config.dirty` wake in the dedicated `config_sync_outbox` table, and
   a backup outbox event. The sync queue is deliberately separate from
   `outbox_events`, which the backup actor drains without an event-type filter.
5. Team sharing of these values is an authorization concern (org-role tiers on
   the Host: Owner/Admin mutate; Member reads metadata and triggers sync).
   Per-project role claims on Host sessions are future work, not invented here.
   The E2EE human vault and sealed store remain untouched by this ADR.

## Consequences

- `SyncSecretSource` gains its first production implementation; sync targets
  push real key sets.
- `secret.config.*` / `secret.value.changed` changelog events gain emitters
  (key names only — never values).
- Versioning, rollback, and config compare become metadata queries plus an
  in-process re-seal, without weakening anti-rollback counters elsewhere.
- The deployment seal key's blast radius now includes config values; key
  rotation procedures (ADR 0032 §7) apply unchanged.

## Related

- [ADR 0005](0005-authority-handle-connectionref.md)
- [ADR 0006](0006-env-spec-delivery-modes.md)
- [ADR 0032](0032-connection-broker-service-integrations.md)
- [ADR 0039](0039-event-driven-github-backup.md)
- [ADR 0041](0041-projects-sync-targets-and-secret-changelog.md)
