# One-shot prompt: Doppler capability parity — subagent swarm edition

> Instruction prompt for an LLM coding-agent swarm. Self-contained: every fact a
> subagent needs is in this file or at a cited repo path. Subagents must not
> assume access to any prior conversation. This document supersedes the
> remaining unfinished rows of
> `docs/implementation/one-shot-doppler-nats-prompt.md` (WP-B/C/D/E were
> partially landed; the gaps are enumerated below).
>
> Execution model: **work packages (WPs), not phases.** Every WP is atomic and
> independently completable because all shared contracts (SQL DDL, trait and
> function signatures, route paths, wire types, event names) are frozen in §4.
> Subagents code against the frozen contracts, never against each other's
> in-flight work. A single **Integrator** agent (WP-INT) merges the few
> mechanical shared-file touch points and runs the global gates. Maximum
> parallelism: every WP except WP-INT may run concurrently.

---

## 1. Mission

Finish OpenSesame's Doppler capability parity (ADR 0041, `docs/competitors/doppler.md`):

1. **Real secret sync** — sync targets currently push **zero keys** because the
   production secret source is hardcoded empty. Land the missing
   project-config authority store and connect it.
2. **Projects-first** — persist the complete-but-in-memory projects API;
   auto-ensure a default personal project.
3. **Automatic change logging** — durable on both planes (today: host log is an
   in-memory ring buffer; the durable identity path has zero callers).
4. **Automated rotation** — durable policies, a real scheduler, and the
   currently-dead verify-before-revoke state machine wired into the live path.
5. **Team-shared project secrets** — identity-plane memberships persisted +
   host-side role tiering; per-member vault crypto for the E2EE store.
6. **Encrypted offline cache** — CLI fallback cache for Host-held config
   (Pages already has one).
7. **Borrowed extras** — .env import, branch configs, versioning/rollback,
   config compare, webhooks on change, secret referencing.

## 2. Non-negotiables (locked product stance — violating any of these fails the whole run)

- **Capability parity, not a clone** (`docs/competitors/doppler.md`). Agents
  never get `getSecret`. The agent contract is ConnectionRef → authorize →
  invoke → receipt (ADR 0005). Never clone `doppler run` as the agent API.
- **Materialize is operator-gated** (ADR 0006/0049). `--agent` mode and
  agent-scoped tokens are denied on every value-revealing surface, hard-coded,
  fail-closed.
- **Identity API (`apps/control-plane`, :8788) and Host API (`apps/gateway`,
  :8787) stay separate** (ADR 0017). No BFF merge. No cross-plane DB reads.
  Each plane logs its own mutations.
- **API responses are value-blind.** Every new gateway response passes
  `assert_no_secret_fields` (pattern: `apps/gateway/src/routes/sync_targets.rs:117`).
  Changelog entries carry key **names** and version numbers, never values, never
  reversible digests of values.
- **The changelog event vocabulary is frozen** in four files simultaneously:
  `packages/audit/src/changelog.ts`, `crates/connection-broker/src/changelog_hook.rs`,
  `packages/os-domain/src/types.ts` (union near line 573), and
  `apps/pages/src/lib/changelog.ts`. The 11 existing names:
  `project.personal.ensured`, `secret.config.created|updated|deleted`,
  `secret.value.changed`, `sync.target.created|synced|failed`,
  `credential.rotation.requested|succeeded|failed`.
  This run adds exactly one name — `secret.value.rolled_back` — added to all
  four files **in one commit** with the freeze tests updated together. Outbox
  and bus event kinds (`sync.config.dirty`, `rotation.due`) are a **different
  namespace** — do not add them to the changelog vocabulary.
- **`@opensesame/os-domain` must not import** Better Auth, oidc-provider, Hono,
  Drizzle, or React.
- **No CI**: never create `.github/`. Verification is local (§6).
- **No `sudo`.** Never commit live secrets. Rust is pinned: `cargo +1.88.0`.
- Numbering: new ADRs start at **0052** (0051 is the current max). New host
  SQLite migrations start at **`migrations/0011_*.sql`** (0010 is the current
  max). Identity-plane schema changes go through Drizzle in `packages/database`
  (`pnpm db:generate`, never hand-write files under `packages/database/drizzle/`).

## 3. Repo facts (read once; cite paths, don't rediscover)

Toolchain and commands: root `AGENTS.md` §2–§3. Verify gate: `pnpm verify`
(changed-file lint + typecheck + test + integration +
`cargo +1.88.0 test --workspace --all-targets` + `./scripts/battle-test.sh`).

**Sync engine (exists, hollow):**
- `crates/connection-broker/src/sync_target.rs` — `SyncTargetView`,
  `CreateSyncTarget`, `SyncOutcome`, `SyncTargetStatus{Idle,Syncing,Ready,Error}`;
  trait `SyncSecretSource` (§4.3); `sync_vercel`, `sync_railway`,
  `sync_all_for_config`; `env_sync_provider_supported()` (line ~605) fail-closed
  allowlist `vercel|railway` with a pact test asserting doppler/infisical/vault/
  aws/github are refused; `content_version_for(target_id, key_names)` (line
  ~609) hashes key **names only** — see the fix frozen in §4.6.
- `apps/gateway/src/routes/sync_targets.rs` — route file to pattern-clone:
  `authorize()` via `resolve_caller` + `can_configure_integrations()` (line 24),
  `caller_organization()` + `organization_or_return!` (lines 41–90),
  `assert_no_secret_fields` (line 117), `publish_sync_bus` (line 140), and the
  stub to remove: `secret_source_from_body` → `EmptySecretSource` (lines 161–165,
  stale comment at 107–109).
- Provider catalog: `crates/connection-broker/src/catalog.json` (85 providers;
  only `vercel` and `railway` carry `env.set`/`secrets.sync` ops).

**Broker internals:**
- `crates/connection-broker/src/lib.rs` — `ConnectionBroker { pool: SqlitePool, config, http, … }`,
  `ConnectionBroker::new(pool, config)` (line ~184), private
  `fn sealing_key(&self) -> Result<&[u8; 32]>` (line ~299; errors
  `SealUnavailable` when `OPENSESAME_CONNECTION_KEY` unset).
- `crates/connection-broker/src/crypto.rs` — `SealedBlob { ciphertext, nonce, aad_digest }`,
  `seal()`/`open()` (XChaCha20-Poly1305, AAD-bound). This is the sealing
  precedent for the new config value store.
- `crates/connection-broker/src/store.rs` — SQLite store fns + `ensure_*_schema`
  pattern; `append_backup_outbox()` (line ~506) shows transactional outbox
  append inside the same transaction as a credential mutation.
- `crates/connection-broker/src/changelog_hook.rs` —
  `record_secret_changelog(RecordSecretChangelog) -> ChangelogEntry`,
  `list_secret_changelog(org, project, limit)`, `is_allowed_changelog_event_type`,
  `deny_metadata_key` redaction, `CHANGELOG_EVENT_TYPES`; backing store is a
  `static OnceLock<Mutex<HashMap<String, VecDeque<ChangelogEntry>>>>`,
  `MAX_ENTRIES_PER_ORG = 512` — lost on restart. That in-memory store becomes a
  cache in front of the durable table (§5 WP-7).
- `crates/connection-broker/src/rotation.rs` — `RotationTarget::{Connection,StorePath}`,
  `RotationPolicy` (+`parse_interval`), `RotationJob` + `public_view()`,
  `RotationRegistry` (**in-memory `Mutex<Vec>`**; gateway holds it in a
  `static OnceLock` at `apps/gateway/src/routes/rotation.rs:24`),
  `request_rotation`, `execute_connection_rotation` (= OAuth `broker.refresh()`
  only), `consume_rotation_events`, `policy_due_at()` — **currently uncalled**.

**Outbox / actor template (ADR 0039) — reuse, don't reinvent:**
- `crates/storage/src/lib.rs` lines ~662–780: `append_outbox`,
  `append_outbox_tx` (line ~1005), `claim_outbox_batch` (leased),
  `mark_outbox_published`, `park_outbox`, `dead_letter_outbox`,
  `count_unpublished_outbox`.
- `apps/gateway/src/backup.rs` — actor loop `run()` (select on notify vs tick),
  `pass()` (claim → auth → snapshot → commit), `StepError::{Suspend,Retry}`,
  `compensate_suspend`/`compensate_retry` (exponential backoff, `MAX_ATTEMPTS`
  → dead-letter). Design property: **events are triggers, state is the source
  of truth** — each pass is a complete idempotent snapshot.
- `apps/gateway/src/backup_bus.rs` — `publish_backup_wake()`,
  `run_system_wake_consumer()` (durable JetStream consumer when the TaskBus
  backend is NATS; in-memory otherwise).

**Rotation state machine (exists, dead):** `crates/rotation/src/lib.rs` —
`RotationState` 15 variants (`Scheduled → Discovering → CandidateGenerated →
CandidateInstalled → CandidateVerified → CandidateActivated →
DependentsUpdated → Observing → PreviousRevoked → RevocationVerified →
Completed` + `RollbackStarted/Completed/Failed`, `ReconciliationRequired`),
`can_transition`/`transition`, `RotationError::{InvalidTransition, Indeterminate}`.
Zero production dependents today.

**Audit / changelog:**
- Identity durable path: `packages/audit/src/chain.ts` (hash chain),
  `redact.ts` (`AUDIT_METADATA_ALLOWLIST`), `changelog.ts`
  (`recordSecretChangelog()` — **zero production callers**);
  `audit_events` table at `packages/database/src/schema/index.ts:732`
  (previousDigest/digest chain, `bigserial seq`); read API
  `GET /v1/audit/events?scope=changelog` in `apps/control-plane/src/routes/audit.ts`.
- Host routes: `apps/gateway/src/routes/changelog.rs`
  (`GET /api/v1/projects/{project_id}/changelog`, `POST /api/v1/changelog`).

**Projects:**
- Drizzle tables are complete: `projects` (`packages/database/src/schema/index.ts:158`,
  kind `personal|standard|temporary`, `sealed_store_tomb_name`,
  `pages_vault_folder_id`, partial unique `projects_personal_owner_uidx`),
  `project_memberships` (line ~201, role `owner|admin|member`).
- Routes are complete: `apps/control-plane/src/routes/projects.ts` (966 lines;
  `POST /personal/ensure`, membership CRUD, last-owner guard) — **but persist
  to in-memory Maps** (`apps/control-plane/src/state.ts:34`). No project
  repository exists in `packages/database/src/repos/interfaces.ts`.
- Host sessions carry an **org-level** role only
  (`apps/gateway/src/middleware/auth.rs:230` — `Caller::Session { role, .. }`
  with `OrganizationRole::{Owner,Admin,Member}`); there is **no per-project
  role on the Host**. See §5 WP-8 scope note.

**CLI / delivery modes:**
- `apps/cli/src/main.rs` (single large file + `certs.rs`, `connect.rs`,
  `github.rs`, `store.rs`) — `DevCmd::Run` at ~line 1192 spawns child with env
  from `.env.schema` resolution; `PassCmd` verbs Init/Insert/Generate/Show/Ls/
  Find/Rm/Cp/Mv/Git/Seal/Backup/Otp/Update/Tomb.
- `crates/env-spec/src/lib.rs:195` `resolve_for_delivery` — ADR 0006
  `CredentialDeliveryMode::{Materialize,Placeholder,Handle,Native}`;
  `DevDeliveryPolicy::agent_default()` **denies materialize**.

**Sealed store / vaults:**
- `crates/sealed-store` — pass-parity; `store.rs` revision counters
  (`.opensesame-revisions.json` + AEAD AD binding — tests
  `rejects_an_older_revision`, `rejects_ciphertext_moved_to_another_entry`);
  `git.rs` `auto_commit`/`push_backup`; `update.rs`
  `apply_secret_update`/`rotate_secret_entry`; `recipients.rs` is **inert**
  (writes `.opensesame-recipients`, never consumed by the seal path);
  `tomb_registry.rs` maps `Project.sealedStoreTombName` → store root
  (`PERSONAL_PROJECT_TOMB_NAME = "personal"`).
- `crates/human-vault/src/lib.rs` — `AssociatedData { envelope_version,
  item_id, organization_id, project_id, collection_id, key_id, revision }`,
  `EncryptedEnvelope`, `VaultRootKey`, Argon2id wrap, WebAuthn PRF KEK.
- `crates/xkeys/src/lib.rs` — X25519 `seal(plaintext, recipient: &PublicKey)`.
- `encrypted_item_revisions` table (`migrations/0001_init.sql:147`;
  `crates/storage/src/lib.rs:471` `insert_encrypted_item`) — right shape
  `UNIQUE(vault_id, item_id, revision)`, **no production writer** (only
  `apps/gateway/src/backup.rs:299` reads).
- Pages offline: `apps/pages/src/lib/vault/offline-backup.ts` (ciphertext
  snapshot cache + 64-deep mutation queue), `store-sync.ts`
  (`storePathToSyncBlobId` → `project:{id}:{path}`), `sync_blobs.rs` gateway
  routes with `FORBIDDEN_PLAINTEXT_KEYS` guard.

**Egress:** `crates/invoke-through` — allowlist-before-connect, **no redirect
following**, `SecretString` tokens, capped bodies (`egress.rs` `EGRESS_RULES`,
`invoke.rs` `Invoker`). Sync currently bypasses it with hand-rolled reqwest.

## 4. Frozen contracts (all subagents code against these; changing them requires stopping and reporting)

### 4.1 Host SQLite DDL

`migrations/0011_secret_configs.sql` (owner: WP-2):

```sql
CREATE TABLE IF NOT EXISTS secret_configs (
  id               TEXT PRIMARY KEY,
  organization_id  TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  slug             TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  environment      TEXT NOT NULL CHECK (environment IN
                     ('development','staging','production','custom')),
  parent_config_id TEXT NULL REFERENCES secret_configs(id),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (organization_id, project_id, slug)
);
CREATE INDEX IF NOT EXISTS secret_configs_org_project_idx
  ON secret_configs (organization_id, project_id);

CREATE TABLE IF NOT EXISTS config_secret_values (
  organization_id TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  config_id       TEXT NOT NULL REFERENCES secret_configs(id),
  key_name        TEXT NOT NULL,
  ciphertext      BLOB NOT NULL,
  nonce           BLOB NOT NULL,
  aad_digest      TEXT NOT NULL,
  version         INTEGER NOT NULL,
  updated_by      TEXT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (config_id, key_name)
);

CREATE TABLE IF NOT EXISTS config_secret_value_versions (
  config_id  TEXT NOT NULL,
  key_name   TEXT NOT NULL,
  version    INTEGER NOT NULL,
  ciphertext BLOB NOT NULL,
  nonce      BLOB NOT NULL,
  aad_digest TEXT NOT NULL,
  deleted    INTEGER NOT NULL DEFAULT 0,
  actor_id   TEXT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (config_id, key_name, version)
);
```

`migrations/0012_secret_changelog.sql` (owner: WP-2): append-only
`secret_changelog(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT
NULL, organization_id, project_id, config_id NULL, event_type, actor_id NULL,
environment NULL, key_names_json, version_id NULL, target_id NULL,
content_version NULL, metadata_json, created_at)` + indexes
`(organization_id, created_at)` and `(organization_id, config_id)`. No UPDATE
or DELETE code path may exist for this table.

`migrations/0013_rotation.sql` (owner: WP-2):
`rotation_policies(id TEXT PK, organization_id, target_kind TEXT CHECK
(target_kind IN ('connection','store_path')), target_id, interval_seconds
INTEGER, last_rotated_at NULL, enabled INTEGER, created_at, updated_at)`;
`rotation_jobs(id TEXT PK, policy_id NULL, organization_id, target_kind,
target_id, state TEXT, detail NULL, created_at, updated_at)`.

`migrations/0014_webhook_targets.sql` (owner: WP-2):
`webhook_targets(id TEXT PK, organization_id, project_id, config_id NULL,
url TEXT, secret_ciphertext BLOB, secret_nonce BLOB, secret_aad_digest TEXT,
enabled INTEGER, created_at, updated_at)`;
`webhook_deliveries(id TEXT PK, webhook_id, event_type, status TEXT,
attempts INTEGER, last_error NULL, created_at, updated_at)`.

### 4.2 Sealing AAD for config values (all sealing/opening code)

AAD is the canonical byte string
`org|{organization_id}|project|{project_id}|config|{config_id}|key|{key_name}|v|{version}`.
Binding **key_name and version** is mandatory — ciphertext transplanted to a
different key or version slot must fail AEAD open (repo precedent:
`crates/sealed-store` test `rejects_ciphertext_moved_to_another_entry`).
Consequence: **rollback re-seals.** Restoring version N decrypts the old row
in-process and re-seals the plaintext under the new head version's AAD. Old
ciphertext bytes are never copied to a new version slot.

### 4.3 Broker store + module signatures

`crates/connection-broker/src/store.rs` (owner: WP-2) exports:

```rust
pub async fn ensure_secret_configs_schema(pool: &SqlitePool) -> Result<()>;
pub async fn insert_secret_config(pool: &SqlitePool, row: &SecretConfigRow) -> Result<()>;
pub async fn list_secret_configs(pool: &SqlitePool, org: &str, project: &str) -> Result<Vec<SecretConfigRow>>;
pub async fn get_secret_config(pool: &SqlitePool, org: &str, config_id: &str) -> Result<Option<SecretConfigRow>>;
pub async fn delete_secret_config(pool: &SqlitePool, org: &str, config_id: &str) -> Result<bool>;
/// Seals plaintext, bumps head version, appends a versions row AND a
/// `sync.config.dirty` outbox event in ONE transaction.
pub async fn upsert_config_value(pool: &SqlitePool, key: &[u8; 32], p: UpsertConfigValue) -> Result<u64>; // returns new version
pub async fn delete_config_value(pool: &SqlitePool, org: &str, config_id: &str, key_name: &str, actor: Option<&str>) -> Result<bool>; // tombstone version row + outbox event, one tx
pub async fn list_config_key_meta(pool: &SqlitePool, org: &str, config_id: &str) -> Result<Vec<ConfigKeyMetaRow>>; // key_name, version, updated_at — no ciphertext
pub async fn load_config_values_sealed(pool: &SqlitePool, org: &str, config_id: &str) -> Result<Vec<ConfigValueRow>>; // ciphertext rows for in-process open
pub async fn list_config_value_versions(pool: &SqlitePool, org: &str, config_id: &str, key_name: &str) -> Result<Vec<ConfigValueVersionMetaRow>>; // metadata only
pub async fn get_config_value_version_sealed(pool: &SqlitePool, org: &str, config_id: &str, key_name: &str, version: u64) -> Result<Option<ConfigValueRow>>;
```

`crates/connection-broker/src/secret_config.rs` (owner: WP-3) exports:
`SecretConfigView`, `CreateSecretConfig`, `ConfigKeyMeta`, and
`StoreSecretSource { pool: SqlitePool, key: [u8; 32] }` implementing the
existing trait verbatim:

```rust
#[async_trait::async_trait]
pub trait SyncSecretSource: Send + Sync {
    async fn load_config_secrets(&self, organization_id: &str, project_id: &str, config_id: &str)
        -> Result<BTreeMap<String, String>>;
}
```

`StoreSecretSource::load_config_secrets` resolution order (all in-process,
nothing returned to clients):
1. Load parent config values if `parent_config_id` set (one level; reject
   deeper chains and cycles at config-create time — WP-4 validates, WP-3
   re-checks defensively).
2. Overlay child values (child wins).
3. Resolve secret references (§4.7).

`ConnectionBroker` (`lib.rs`, owner: WP-3 for this block) gains:
`create_secret_config`, `list_secret_configs`, `get_secret_config`,
`delete_secret_config`, `put_config_secrets(org, config_id, BTreeMap<String,
secrecy::SecretString>, actor)`, `delete_config_secret`, `config_key_meta`,
`config_value_versions`, `rollback_config_secret(org, config_id, key, to_version, actor)`,
`sync_secret_source(&self) -> Arc<dyn SyncSecretSource>`. Every mutation calls
`changelog_hook::record_secret_changelog` with the appropriate frozen event
type (names only, `deny_metadata_key`-redacted).

### 4.4 Gateway route table (Host, :8787)

All handlers follow the `sync_targets.rs` pattern (§3): `resolve_caller`,
org scoping via `organization_or_return!`, `assert_no_secret_fields` on every
response body, bus publish via `publish_sync_bus`-style helper.

| Method + path | Auth tier | Notes |
|---|---|---|
| `GET/POST /api/v1/projects/:project_id/configs` | GET: any org session; POST: `can_configure_integrations()` | create validates parent (same org+project, no cycle, depth 1) |
| `GET /api/v1/configs/:id` | any org session | metadata only |
| `DELETE /api/v1/configs/:id` | `can_configure_integrations()` | refuses while sync targets reference it |
| `PUT /api/v1/configs/:id/secrets` | `can_configure_integrations()`; **agent tokens 403** | body `{"secrets": {"KEY": "value"}}` — the ONLY value-accepting intake; response = names + versions only |
| `DELETE /api/v1/configs/:id/secrets/:key` | `can_configure_integrations()` | tombstone |
| `GET /api/v1/configs/:id/secrets` | any org session | `{keys:[{key_name,version,updated_at}]}` — never values |
| `GET /api/v1/configs/:id/secrets/:key/versions` | any org session | metadata only |
| `POST /api/v1/configs/:id/secrets/:key/rollback` | `can_configure_integrations()` | `{"to_version": n}`; re-seal per §4.2; emits `secret.value.rolled_back` |
| `GET /api/v1/configs/:a/compare/:b` | any org session | per-key `only_in_a/only_in_b/differs/same` via (version, aad_digest) — no values |
| `POST /api/v1/configs/:id/branch` | `can_configure_integrations()` | creates child config (`parent_config_id = :id`), slug suffix from body |
| `POST /api/v1/configs/:id/materialize` | **Operator caller only** (`Caller::Operator`); sessions AND agent tokens 403 | returns values once; receipt-logged + changelog-logged (names); `assert_no_secret_fields` is intentionally skipped for exactly this handler — compensate with an explicit operator-audit receipt |
| `GET/PUT /api/v1/rotation/policies`, `GET /api/v1/rotation/jobs`, `POST /api/v1/rotation/run` | `can_configure_integrations()` | WP-9 |
| `GET/POST /api/v1/webhooks`, `DELETE /api/v1/webhooks/:id`, `GET /api/v1/webhooks/:id/deliveries` | `can_configure_integrations()` | WP-11 |

Sync-target changes (owner: WP-5): `POST …/sync` and `…/sync-all` use
`broker.sync_secret_source()`; `SyncBody.key_names` becomes an optional
intersection filter; `EmptySecretSource` stays exported for tests but has no
production call site; stale comment at `sync_targets.rs:107-109` rewritten.

**Team-sharing tier (scope decision, final):** the Host knows org roles only
(§3). Mutation = Owner/Admin (`can_configure_integrations()`); read metadata +
trigger sync = any authenticated session in the org, including Member.
Per-project role enforcement on the Host requires project claims in the
session surface — **explicitly out of scope**; record as "future work" in ADR
0052 §Consequences. Do not invent cross-plane claim plumbing.

### 4.5 Event names (non-changelog namespaces)

- Outbox kinds (host, `crates/storage` outbox): `sync.config.dirty`
  (payload: org, project_id, config_id), `rotation.due` (payload: org,
  policy_id, target_kind, target_id), `webhook.deliver` (payload: org,
  webhook_id, event_type, project_id, config_id, key_names, content_version).
- TaskBus event types: reuse the existing frozen `sync.target.*` /
  `credential.rotation.*` names; no new bus types.

### 4.6 `content_version` v2 (owner: WP-6)

`content_version_for` currently hashes target id + key names, so value changes
are invisible to it and any actor that skips "unchanged" content would skip
real updates. New definition (still value-blind):
SHA-256 over `target_id | (key_name, head_version)*` sorted by key_name,
rendered `cv2_{hex}`. Update the existing pact test; grep every consumer of
`content_version` and update expectations (`crates/connection-broker`,
`packages/contracts/src/sync-targets.ts`, Pages sync-targets lib).

### 4.7 Secret referencing (owner: WP-3)

Syntax inside a stored value: `${KEY}` (same config, post-inheritance) and
`${config:<slug>.KEY}` (same project only). Resolution is host-side, inside
`StoreSecretSource::load_config_secrets`, after inheritance overlay:
- Missing reference → hard error (`BrokerError::…`, sync target records
  `Error` status). Fail closed.
- Cycle detection across the reference graph → hard error.
- **Cross-environment guard (exfiltration):** a reference from config A to
  config B where `B.environment == "production"` and
  `A.environment != "production"` is refused at write time (PUT validates) and
  again at resolve time. Rationale: otherwise a dev-config sync target
  exfiltrates prod values to a dev deployment.
- Escape: `$${KEY}` renders a literal `${KEY}`.

### 4.8 TS wire surface (owner: WP-12)

`packages/contracts/src/secret-configs.ts` mirrors
`packages/contracts/src/sync-targets.ts` style: `SecretConfigView`,
`CreateSecretConfigBody`, `PutConfigSecretsBody` (values allowed on the
request type ONLY; response types must not contain a value field),
`ConfigKeyMeta`, `ConfigCompareEntry`, plus token-leak rejection mirroring the
existing pact. `packages/api-client` gains matching methods next to the
sync-target methods. The os-domain `SecretConfig`/`SecretConfigEnvironment`
types at `packages/os-domain/src/types.ts:164-181` are the field-name source
of truth (camelCase TS ↔ snake_case wire, same as sync targets).

### 4.9 CLI surface (owner: WP-10; exclusive owner of `apps/cli/**`)

```
opensesame config ls|create|keys|diff <a> <b>|branch <id>
opensesame config set <KEY> [--config <id>]      # value via stdin/hidden prompt, never argv, never echoed
opensesame config unset <KEY> --config <id>
opensesame config import <file.env> --config <id> # dotenv → PUT; local parse via crates/env-spec
opensesame config history <KEY> --config <id>     # version metadata
opensesame config rollback <KEY> --to <n> --config <id>
opensesame dev run --project <p> --config <c> [--fallback[=only|if-missing]] [--max-fallback-age <dur>] -- <cmd>
opensesame pass history <path>
opensesame pass restore <path> --rev <sha>
opensesame rotation policy set|ls ; opensesame rotation run <target> ; opensesame rotation jobs
```

`dev run` host-fetch goes through `POST /api/v1/configs/:id/materialize`
(operator credentials) and feeds entries through the existing
`DevDeliveryPolicy` / `resolve_for_delivery` — **`--agent` continues to deny
materialize and must never read the fallback cache**. Fallback cache: sealed
`crates/human-vault` envelope keyed by a 0600 operator-local keyfile, path
`~/.local/state/opensesame/fallback/<org>/<project>/<config>.sealed`, default
`--max-fallback-age 24h` (not infinite), decrypt only when offline or
`--fallback` given.

### 4.10 ADRs (owner: WP-1)

- `0052-host-sealed-config-value-store.md` — decisions a–e: broker-key sealing
  posture; write-only value API; in-process-only decryption (sync, rotation,
  operator materialize); AAD per §4.2; version-table design; the team-sharing
  tier scope note from §4.4.
- `0053-per-member-vault-recipients.md` — per-member VRK wrapping via
  `crates/xkeys` X25519; re-key (not just unwrap-removal) on membership
  change; `principal_keys` registration.
- `0054-cli-encrypted-fallback-cache.md` — TTL, key custody, hard agent
  denial, threat model of operator-disk caching.

## 5. Work packages

Every WP: work only inside OWNS; read anything; if a frozen contract is
impossible as specified, stop and report rather than improvising a different
contract. Shared files each have exactly one owner; WP-INT performs the four
mechanical merges listed in its spec. Each WP lands its own tests and runs its
own Verify block before declaring done.

---

### WP-1 — ADRs + docs (no code)
**OWNS:** `docs/adr/0052|0053|0054-*.md`, `docs/competitors/doppler.md`
(status/mapping updates), `docs/implementation/one-shot-doppler-nats-prompt.md`
(mark WP-B/C/D/E rows superseded-by-this-doc where this run replaces them),
`docs/architecture/` additions if needed.
**Spec:** write the three ADRs per §4.10 in the repo's existing ADR format
(Status/Context/Decision/Consequences/Related; see ADR 0041 for shape).
**Verify:** `pnpm lint` (docs pass Biome's markdown handling untouched — no
code gate). **Done when:** ADRs cite the real file paths from §3.

### WP-2 — Host store layer (migrations + store.rs)
**OWNS:** `migrations/0011..0014_*.sql`, `crates/connection-broker/src/store.rs`
(new fns + `SecretConfigRow`/`ConfigKeyMetaRow`/`ConfigValueRow`/
`ConfigValueVersionMetaRow`/`UpsertConfigValue` row types), store-level tests.
**READS:** §4.1, §4.3 signatures (verbatim), `append_backup_outbox` precedent.
**Spec:** implement §4.3 exactly. `upsert_config_value` performs seal (§4.2
AAD), head upsert, versions append, and `sync.config.dirty` outbox append in
one transaction (`append_outbox_tx`). Version numbering starts at 1 and is
strictly increasing per (config_id, key_name); tombstones append a versions
row with `deleted=1` and remove the head row.
**Must not:** expose plaintext in any return type except via
`load_config_values_sealed` consumers opening in-process; add UPDATE/DELETE
paths on `secret_changelog` or `config_secret_value_versions`.
**Verify:** `cargo +1.88.0 test -p opensesame-connection-broker --lib store`
plus new tests: version monotonicity, tombstone, outbox row in same tx
(inject failure between writes and assert atomicity), AAD transplant rejection.

### WP-3 — Config domain module + broker methods + referencing
**OWNS:** `crates/connection-broker/src/secret_config.rs` (new),
the `// SECRET_CONFIG` marked block in `crates/connection-broker/src/lib.rs`
(broker methods + `pub mod secret_config;` export), its tests.
**READS:** §4.2, §4.3, §4.7; `changelog_hook.rs`; `crypto.rs`.
**Spec:** `StoreSecretSource` (inheritance → overlay → references, per §4.7 incl.
cross-environment guard and `$${}` escape); broker methods per §4.3 with
changelog emission (`secret.config.created|updated|deleted`,
`secret.value.changed`, `secret.value.rolled_back`) — key names only.
`rollback_config_secret` re-seals per §4.2.
**Must not:** log or return plaintext; emit any event name outside the frozen
vocabulary; follow `parent_config_id` more than one level.
**Verify:** `cargo +1.88.0 test -p opensesame-connection-broker --lib secret_config`
covering: overlay wins, reference resolution, cycle error, missing-ref error,
prod-to-dev reference refusal, escape rendering, rollback produces new head
version with distinct AAD.

### WP-4 — Gateway config routes
**OWNS:** `apps/gateway/src/routes/secret_configs.rs` (new) + its tests.
**READS:** §4.4 route table; `sync_targets.rs` patterns (§3); `receipts.rs`
for the materialize receipt.
**Spec:** all `/configs` rows of §4.4. Materialize: `Caller::Operator` only,
per-call receipt via the existing receipt store, changelog event with key
names, values returned exactly once in the response body (no caching
server-side). Compare/versions/branch per table. Config create validates
parent (same org+project, depth 1, no cycle).
**Must not:** mount routes (WP-INT does); return values anywhere except the
materialize handler; accept values anywhere except `PUT …/secrets`.
**Verify:** `cargo +1.88.0 test -p opensesame-gateway secret_configs` — pact
tests: every non-materialize response passes `assert_no_secret_fields`; agent
token 403 on PUT and materialize; session (non-operator) 403 on materialize;
Member session can GET metadata but not PUT.

### WP-5 — Sync-on-write actor + EmptySecretSource removal
**OWNS:** `apps/gateway/src/sync_actor.rs` (new), `apps/gateway/src/sync_bus.rs`
(new; may generalize `backup_bus.rs` by copy, not by editing it),
`apps/gateway/src/routes/sync_targets.rs` (the stub swap + comment fix), tests.
**READS:** §3 outbox/actor template; §4.5 outbox kinds; §4.3
`sync_secret_source()`.
**Spec:** actor loop clones `backup.rs` structure: wake on notify or tick,
`claim_outbox_batch` for `sync.config.dirty`, each pass runs
`sync_all_for_config` (full-snapshot, idempotent), `StepError::{Suspend,Retry}`
compensations, park → dead-letter at `MAX_ATTEMPTS`. Skip only when
`content_version` (v2, §4.6) is unchanged. Replace `secret_source_from_body`
per §4.4.
**Must not:** start the actor in `main.rs` (WP-INT wires spawn); alter
`backup.rs`/`backup_bus.rs`.
**Verify:** `cargo +1.88.0 test -p opensesame-gateway sync_actor` — retry,
park, dead-letter, idempotent re-pass, end-to-end: seeded config value →
outbox row → pass → mock provider receives the key set; the existing pact
asserting doppler/infisical/vault/aws refusal stays green.

### WP-6 — Sync providers + content_version v2 + invoke-through egress
**OWNS:** `crates/connection-broker/src/sync_target.rs`,
`crates/connection-broker/src/catalog.json`, provider fixtures/tests,
`packages/contracts/src/sync-targets.ts` + Pages sync-targets lib **only** for
the `cv2_` expectation change.
**READS:** §4.6; `crates/invoke-through` (`EgressRule`, `Invoker`); existing
`sync_vercel`/`sync_railway`.
**Spec:** implement `content_version` v2. Add `env.set` sync for **netlify,
render, fly, cloudflare** (REST, following the vercel/railway template) and
extend `env_sync_provider_supported()` accordingly (still fail-closed).
**GitHub Actions secrets sync is feature-gated** behind a cargo feature
`github-actions-sync` because it needs libsodium sealed-box (`crypto_box`
crate — new crypto dependency; keep it out of the default feature set and note
it in the PR description for human review). Route new providers' egress
through `crates/invoke-through` (add hosts to `EGRESS_RULES`); migrate
vercel/railway egress too if the diff stays mechanical, otherwise leave a
`// TODO(invoke-through)` with rationale.
**Must not:** weaken `env_sync_provider_supported` to a pass-through; invent
sync for catalog stubs without an honest egress path; follow redirects.
**Verify:** `cargo +1.88.0 test -p opensesame-connection-broker --lib sync_target`
per-provider pact fixtures (URL, auth header shape, payload shape, no values
in logs), cv2 test, refusal pact still green.

### WP-7 — Durable host changelog
**OWNS:** `crates/connection-broker/src/changelog_hook.rs`,
`apps/gateway/src/routes/changelog.rs`, their tests.
**READS:** §4.1 migration 0012 DDL; existing `is_allowed_changelog_event_type`,
`deny_metadata_key`.
**Spec:** `record()` write-through to `secret_changelog` (pool injected at
broker construction; ring buffer remains a hot cache and the fallback when no
pool is configured); reject non-frozen event types before insert (fail
closed). `GET …/changelog` reads the table with cursor pagination by `seq`.
Add `secret.value.rolled_back` to `CHANGELOG_EVENT_TYPES` **and, in the same
commit, to** `packages/audit/src/changelog.ts`,
`packages/os-domain/src/types.ts`, `apps/pages/src/lib/changelog.ts`, updating
all vocabulary-freeze tests (WP-7 owns those four vocabulary edits — the one
sanctioned cross-package touch, because the freeze demands one commit).
**Must not:** write values or reversible digests; add UPDATE/DELETE on the table.
**Verify:** durability across pool reopen; unknown-name rejection; freeze
tests green in all four packages
(`cargo +1.88.0 test -p opensesame-connection-broker --lib changelog`,
`pnpm --filter @opensesame/audit test`,
`pnpm --filter @opensesame/os-domain test`,
`pnpm --filter @opensesame/pages test`).

### WP-8 — Identity plane: persistent projects + auto personal + audit wiring
**OWNS:** `packages/database/src/repos/**` (new project/membership stores),
`apps/control-plane/src/state.ts`, `apps/control-plane/src/routes/projects.ts`
(persistence swap only — route contracts stay byte-identical), the control-plane
session-establishment hook for `ensurePersonal`, their tests.
**READS:** Drizzle tables (already complete — **no schema change, no
`pnpm db:generate`**); `packages/audit/src/changelog.ts`.
**Spec:** `ProjectStore`/`ProjectMembershipStore` interfaces + memory + postgres
implementations; `ensurePersonal(principalId, organizationId)` as one upsert
honoring `projects_personal_owner_uidx`; call it on first authenticated
session per principal, emitting `project.personal.ensured` through
`recordSecretChangelog` — its first production caller — into the hash-chained
`audit_events`. Membership mutations also record through the audit chain.
**Must not:** alter route request/response shapes; import Drizzle into
os-domain; touch the Host plane.
**Verify:** existing projects route suites pass against BOTH store impls;
`pnpm --filter @opensesame/control-plane test`,
`pnpm --filter @opensesame/database test`; audit chain verification test
(`verifyAuditChain`) over a mutation sequence.

### WP-9 — Rotation: durable policies, scheduler, state machine
**OWNS:** `crates/connection-broker/src/rotation.rs`,
`apps/gateway/src/routes/rotation.rs`, the `// ROTATION` marked block in
`apps/gateway/src/bootstrap.rs` (scheduler spawn defined here, wired by
WP-INT), `apps/worker/src/main.ts` + `apps/worker/src/rotation.ts` (start the
existing consumer), `crates/rotation/Cargo.toml` dependents, tests.
**READS:** §4.1 migration 0013; `crates/rotation` state machine; §4.5
`rotation.due`; store outbox API.
**Spec:** replace the in-memory `RotationRegistry` (and the gateway
`static OnceLock` at `routes/rotation.rs:24`) with pool-backed persistence.
Drive `RotationJob.state` through `opensesame-rotation`'s
`RotationState`/`transition`, persisting every transition. OAuth connections:
candidate = `broker.refresh()`; verify = authorized no-op invoke **where the
provider catalog exposes one, else skip to activation and record
`verify_skipped` in job detail** (never fabricate a verify); on
`RotationError::Indeterminate` → `ReconciliationRequired`, job parks for
operator attention (no silent retry-forever). Activation promotes the new
`connection_credentials` row (existing `version` CAS column = two-secret
blue/green); dependents-updated = append `sync.config.dirty` for configs whose
sync targets use the connection; revoke = drop old row. StorePath targets:
regenerate via `crates/sealed-store` update path, revision bump. Scheduler:
tokio interval (60s) → `list_policies` → `policy_due_at()` (first real caller)
→ `rotation.due` outbox event; a rotation actor pass executes claimed events.
Routes + emission of `credential.rotation.requested|succeeded|failed` to the
durable changelog.
**Must not:** delete the old credential before the machine reaches
`PreviousRevoked` legally; implement per-provider API-key rotation (framework
slot only — record as future work); touch `backup.rs`.
**Verify:** `cargo +1.88.0 test -p opensesame-rotation` (still green),
`cargo +1.88.0 test -p opensesame-connection-broker --lib rotation`: happy
path, verify-fail → rollback states, revoke-fail → `ReconciliationRequired`,
restart-resume from persisted state, due-time math, `pnpm --filter
@opensesame/worker test`.

### WP-10 — CLI (exclusive owner of `apps/cli/**`) + sealed-store history
**OWNS:** `apps/cli/**`, `crates/sealed-store/src/history.rs` (new) + the
`// HISTORY` marked export block in `crates/sealed-store/src/lib.rs`, tests.
**READS:** §4.9 surface; `resolve_for_delivery` / `DevDeliveryPolicy`;
`crates/human-vault` envelope API; materialize endpoint contract (§4.4);
`git.rs` auto-commit format (`Add|Edit|Remove {name}`).
**Spec:** implement §4.9 verbatim. `pass history` walks the store's git log
for the entry's file; `pass restore` writes the old ciphertext as a **new**
commit with a revision-counter bump (anti-rollback counters stay monotonic —
never decrement `.opensesame-revisions.json`). `dev run` fallback per §4.9;
`--agent` never fetches host values and never reads fallback (test-enforced).
Values for `config set` come from stdin or a hidden prompt only.
**Must not:** print secret values except `pass show --reveal`-equivalent
human-TTY paths that already exist; write plaintext to disk outside the sealed
fallback envelope; touch gateway or broker code.
**Verify:** `cargo +1.88.0 test -p opensesame-cli` + integration tests against
a mock gateway: online fetch, offline + fallback hit, fallback expired,
`--agent` denial, fallback file contains no plaintext substrings
(`pnpm audit:gitleaks` on the workspace stays green).

### WP-11 — Webhooks on change
**OWNS:** `apps/gateway/src/routes/webhooks.rs` (new),
`apps/gateway/src/webhook_actor.rs` (new), tests.
**READS:** §4.1 migration 0014; §4.5 `webhook.deliver`; §3 actor template;
`crates/invoke-through`.
**Spec:** CRUD per §4.4; webhook secrets sealed with the broker key (§4.2-style
AAD with `webhook|{id}` scope). The sync/config mutation outbox fan-in: on
`sync.config.dirty` the actor also enqueues `webhook.deliver` for matching
webhook targets (org/project/config filter). Delivery: HMAC-SHA256 signature
header over the canonical JSON payload `{event_type, project_id, config_id,
key_names, content_version, occurred_at}` — **never values**; egress through
`invoke-through` (allowlist the registered host at create time; refuse
redirects); retries with backoff → dead-letter, recorded in
`webhook_deliveries`.
**Must not:** deliver values; follow redirects; retry forever.
**Verify:** `cargo +1.88.0 test -p opensesame-gateway webhook` — signature
verification fixture, retry/dead-letter, payload pact (no value-shaped fields).

### WP-12 — TS surface: contracts, api-client, Pages panels
**OWNS:** `packages/contracts/src/secret-configs.ts` (new),
`packages/api-client/src/**` (new methods), `apps/pages/src/lib/secret-configs.ts`
(+ tests), `apps/pages/src/sections/settings/SecretConfigsPanel.tsx` (new),
`ChangelogPanel.tsx` pagination params, `SyncTargetsPanel.tsx`
last-synced/status-detail display, their tests.
**READS:** §4.8; existing `sync-targets.ts` contract + panel patterns.
**Spec:** per §4.8. Panels: list configs, key metadata, set/unset (masked
input, cleared after submit), version history + rollback button, compare view,
changelog pagination. No plaintext display anywhere; the set-input is
write-only UI.
**Must not:** add any response type with a value field; call materialize from
Pages.
**Verify:** `pnpm --filter @opensesame/contracts test`,
`pnpm --filter @opensesame/api-client test`,
`pnpm --filter @opensesame/pages test` (+ token-leak pact mirrored from
sync-targets).

### WP-13 — Per-member vault recipients (crypto track)
**OWNS:** `crates/sealed-store/src/recipients.rs` (activation),
the `// RECIPIENTS` marked block in `crates/sealed-store/src/envelope.rs` and
`lib.rs`, `packages/database/src/schema/index.ts` (`principal_keys` table —
sole owner of this file in this run) + `pnpm db:generate` output,
`apps/control-plane/src/routes/principal-keys.ts` (new), re-wrap hooks in the
membership mutation path (coordinate signature with WP-8: WP-8 exposes an
`onMembershipChanged` hook interface; WP-13 implements the re-wrap subscriber),
tests.
**READS:** ADR 0053 (WP-1); `crates/xkeys`; `human-vault` VRK wrap API.
**Spec:** `principal_keys(principal_id, public_key, algo, created_at)` +
register/list endpoints; seal path for **project tombs** (not the personal
tomb) wraps the VRK to every member public key listed in
`.opensesame-recipients`; membership change triggers re-key (fresh VRK,
re-wrap all current members, re-seal store key material — removal is re-key,
never just dropping a wrap).
**Must not:** touch the personal-tomb single-passphrase path; weaken Argon2id
bounds; store private keys server-side.
**Verify:** `cargo +1.88.0 test -p opensesame-sealed-store recipients` —
wrap/unwrap per member, removed member cannot unwrap post-re-key;
`pnpm --filter @opensesame/control-plane test`; run `pnpm audit:kani` and
`pnpm audit:miri` scoped to the touched crates; full audit gate set (§6).

### WP-14 — Pages vault revisions writer
**OWNS:** `apps/gateway/src/routes/sync_blobs.rs` (revision write-through),
`apps/pages/src/lib/vault/revisions.ts` (new, client-side restore helpers),
tests.
**READS:** `encrypted_item_revisions` DDL (`migrations/0001_init.sql:147`),
`crates/storage/src/lib.rs:471` `insert_encrypted_item`,
`backup.rs:299` reader.
**Spec:** blob upsert also appends an `encrypted_item_revisions` row
(ciphertext only — the server stays blind); `GET` endpoint lists revision
metadata for an owned blob; Pages restore = client-side decrypt of a fetched
old revision into the vault (new local edit, new epoch — never a server-side
rollback).
**Must not:** decrypt server-side; break the `FORBIDDEN_PLAINTEXT_KEYS` guard.
**Verify:** `cargo +1.88.0 test -p opensesame-gateway sync_blobs`,
`pnpm --filter @opensesame/pages test`.

### WP-INT — Integrator (runs after all WPs; the only sequenced agent)
**OWNS:** the four mechanical merge points —
`apps/gateway/src/routes/mod.rs` (mount every new route group),
`apps/gateway/src/main.rs`/`bootstrap.rs`/`app_state.rs` (spawn sync/rotation/
webhook actors, inject pools/sources), `crates/connection-broker/src/lib.rs`
(merge the `// SECRET_CONFIG` block and module exports),
`crates/sealed-store/src/lib.rs` (merge `// HISTORY` and `// RECIPIENTS`
export blocks) — plus `Cargo.toml`/`package.json` dependency merges and any
cross-WP compile drift.
**Spec:** merge, build, then run the full gate suite (§6) and the end-to-end
smoke (§6). Fix integration-level breakage only; a defect inside one WP's
scope goes back to that WP's owner (re-run that subagent with the failure
attached).
**Done when:** §6 is fully green and the smoke transcript is attached to the
PR description.

## 6. Global verification (WP-INT; the run's definition of done)

```bash
pnpm verify                       # lint + typecheck + test + integration
                                  # + cargo +1.88.0 test --workspace --all-targets
                                  # + ./scripts/battle-test.sh
pnpm audit:clippy && pnpm audit:ast-grep && pnpm audit:semgrep && pnpm audit:gitleaks
pnpm audit:cargo-audit            # new deps (crypto_box behind feature flag)
pnpm test:security && pnpm test:redteam
```

End-to-end smoke (scriptable against debug builds, mock providers):
1. Start gateway with `OPENSESAME_CONNECTION_KEY` set; create project config;
   `opensesame config set API_KEY` (stdin); assert `GET …/secrets` returns
   name+version only.
2. Create a sync target against a mocked Vercel endpoint; assert the mock
   receives the key set; assert `secret.value.changed` and
   `sync.target.synced` rows exist in `secret_changelog` and survive a gateway
   restart.
3. Mutate the value; assert the outbox-driven actor re-syncs without an
   explicit sync call and `cv2_` changed.
4. Create a rotation policy at `30s`; assert a job runs through the state
   machine to `Completed` and a dependent re-sync fires.
5. `opensesame dev run --project … --config … -- env` (operator) shows the
   key; kill the gateway; re-run with `--fallback` — still works; re-run with
   `--agent` — denied.
6. Rollback a key to version 1; assert `secret.value.rolled_back` in the
   changelog and a **new** head version.

## 7. Explicit non-goals (do not build, do not "helpfully" add)

Service tokens (conflicts with the agents-never-read-values stance — needs its
own ADR debate); change requests / approval workflows; Doppler Share links;
automatic app restart on change; per-provider managed API-key rotation
(framework only); Kubernetes operator; SCIM/SAML; cross-plane project-role
claims on Host sessions (recorded as future work in ADR 0052); any `.github/`
directory; any new always-on crypto dependency outside the
`github-actions-sync` feature flag.
