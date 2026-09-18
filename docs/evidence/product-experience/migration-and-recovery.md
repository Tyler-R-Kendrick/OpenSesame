# Migration and recovery

- Vault prefs remain `config/prefs` JSON. Authored YAML is a sidecar (`config/prefs.source.yaml`) when written; absence falls back to a generated document.
- `prefsRevision` stays system-owned. Existing revision-2 idle-lock migration is unchanged.
- Implicit SCIM group-name suffix roles (`owners` → owner) are withdrawn as an authority source. Operators must set explicit group-id mappings. No automatic elevation on migrate.
- Restoring prefs YAML does not resurrect hosted grants or sessions.
- Offline whole-storage rollback against an attacker who controls all local state is not prevented; hosted fencing still applies at hosted boundaries.
- `sealedExportCoverage()` records that `exportSealed` includes tomb header/body and omits prefs YAML, local application registrations, keybindings, and live grants. A missing vault body cannot be reported as a complete backup.
- First-admin enrollment tickets live in `oidc_payloads` under `OpenSesame:EnrollmentTicket`. They are single-use; restoring a backup does not resurrect a spent ticket as a live setup secret unless the whole payload row is rolled back with the database.
- `private_key_jwt` jti records live under `OpenSesame:JwtReplay`. Replicas must share that table.
- Replica SCIM cleanup was proven with shared organization/SCIM stores plus durable sessions. Postgres Groups persistence is `packages/database/drizzle/0027_peaceful_galactus.sql` (`scim_groups` and `scim_group_role_mappings`); `createPostgresScimStores` writes those tables.
- Confidential `private_key_jwt` public JWKS persist on `oauth_clients.token_endpoint_jwks` (`packages/database/drizzle/0028_oauth_client_jwks.sql`). PATCH replaces the JWKS (old keys stop minting). Suspended clients are inadmissible. Replicas must share that column.
