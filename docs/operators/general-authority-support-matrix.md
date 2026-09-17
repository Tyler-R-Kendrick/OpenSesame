# General authority — enforcement support matrix

Honest capability matrix for the generalized hierarchical authority programme
([ADR 0120](../adr/0120-generalized-hierarchical-authority.md)). A row is
**supported** only when implementation, enforcement, and evidence agree.
Unavailable native/provider paths must refuse at issuance/preflight — never
silently downgrade to a mock success.

| Capability | Status | Evidence / refuse path | Limits |
|---|---|---|---|
| Canonical `Grant` attenuation (time, budget omit, offline, assurance, correlated PermissionEntry) | supported (unit) | `crates/domain` `grant_attenuation`, `ValidatedGrantChain`; fabric GA-V-01… | `grant.rs` ratchet 264 lines (tests in `grant_unit_tests.rs`). Route-level reachability still traced per entry point |
| Host item-fetch expiry vs leftover wrapping keys | supported (unit + crypto) | AT-COPIED-KEY: `SessionGrant::permits` denies after expiry; `encrypt_item`/`decrypt_item` still open copied ciphertext (`crates/human-vault/tests/copied_key_residual.rs`) | TTL does not recall delivered keys |
| Rotation vs leftover provider session | supported (broker) | AT-ROTATION: `execute_connection_rotation` completes `credential.rotation.succeeded`; connection stays Active; leftover login cookie still 200 (`tests::rotation_leftover`) | Rotation is not session termination |
| Reserved issuance vs cohort/template editor | supported (Host issue path) | AT-CONTROL-ROLE: Admin `POST .../grants/{id}/authority` with `credential.export`/`policy.edit` is 403; Owner 201 (`authority_grants_tests`) | `can_configure_integrations` is not `may_issue_reserved_administration` |
| AccessDomain forest (realm-bound, reparent CAS, terminate fence) | supported (storage) | `migrations/0034_general_authority.sql`, `crates/storage` authority domain tests | Host HTTP surface landing separately |
| Cohort snapshot / live eligibility | supported (domain + Host store) | snapshot digest freeze; live trusted-writer envelope (`migrations/0039`, `offers_live`) | Unauthorized writers and class mismatch refuse; not a group token |
| OpenFGA additive `access_domain` | supported (live local PDP) | `authority-additivity.test.ts` against OpenFGA v1.8.12 at `OPENSESAME_OPENFGA_URL`; fabric GA-V-32 pass | Consistency is check-scoped, not a cross-store zookie. Pin matches `deploy/compose` `openfga/openfga:v1.8.12` |
| Ancestor invalidation fence | supported (storage) | migration `0033`/`0034`, `a_revoked_ancestor_denies_a_descendant_on_the_next_read` | Provider cleanup remains reconciliation |
| Budget reservation conservation | supported (storage) | CHECK + concurrent debit test | Active-time metering profiles per template |
| Wasmtime workload isolation profile | supported (local fixture) | `crates/sandbox`; fabric GA-V-60 spawn-path native refuse (`--features wasm-runtime,fixtures --test payloads`) | Not a claim for arbitrary native/OCI binaries; native payloads refuse rather than exec |
| Blocky DNS enforcement | supported (local disposable) or recorded launcher failure; live SaaS unsupported | `crates/dns-enforcement`; fabric GA-V-38 `family_blocky` always runs `harness/blocky-env.sh up` (measures API export or records stderr); GA-V-59 empty-group disable refuses; catalog `blocky-live-saas` refuses | DNS-only local; empty-group disable cannot be built; a launcher failure is evidence, not a mocked allow; remote SaaS must not inherit local claims |
| Discord collab role adapter | contract-tested; live SaaS unsupported | `crates/collab-adapter` HTTP fixture; fabric GA-V-61 apply create-scope-assign; catalog `discord-live` refuses | Live guild is `#[ignore]` opt-in; not an issuance adapter |
| Authority expiry → `lifecycle.*` | in progress | SessionGrant already scanned; AuthorityGrant subject wiring | Must not use `live-stack-test.sh` as false evidence |
| Host invoke dispatch fence | supported (local fixture) | `finish_dispatch` re-checks `find_live_delegation` before `execute_invocation`; fabric AT-REVOKE-QUEUE and GA-V-35 family expiry (`fixture_work == 0`) | Hold/drain is test-only; the re-check is on the production path |
| Apple Family Controls / OS app block / physical locks | unsupported | tested refuse at issuance preflight / catalog Absent | Catalog logos ≠ active enforcer |
| Full live Host+OpenBao stack lifecycle smoke | OpenBao v2.6.2 local; gateway scan publishes AuthorityGrant expiry | `lifecycle::authority_grant_scan::authority_grant_expiry_reaches_lifecycle_feed_via_scan`; fabric GA-V-33b | `live-stack-test.sh` still connections/intents, not this feed |
| Static Pages without Host/Identity | supported | ADR 0090; guest roads; local templates UI | Remote authority not pretended active |

## Operator notes

- Set `OPENSESAME_OPENFGA_URL` (e.g. `http://127.0.0.1:18081`) before
  `pnpm test:authority-fabric` so GA-V-32 can settle.
- Do not claim zero residual exposure for providers that only offer eventual
  role removal.
- Expiry on the authorization path is the deny boundary; lifecycle notifications
  are not revocation (ADR 0074).
