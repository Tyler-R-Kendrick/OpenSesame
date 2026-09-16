# General authority — enforcement support matrix

Honest capability matrix for the generalized hierarchical authority programme
([ADR 0120](../adr/0120-generalized-hierarchical-authority.md)). A row is
**supported** only when implementation, enforcement, and evidence agree.
Unavailable native/provider paths must refuse at issuance/preflight — never
silently downgrade to a mock success.

| Capability | Status | Evidence / refuse path | Limits |
|---|---|---|---|
| Canonical `Grant` attenuation (time, budget omit, offline, assurance, correlated PermissionEntry) | supported (unit) | `crates/domain` `grant_attenuation`, `ValidatedGrantChain`; fabric GA-V-01… | Route-level reachability still traced per entry point |
| AccessDomain forest (realm-bound, reparent CAS, terminate fence) | supported (storage) | `migrations/0034_general_authority.sql`, `crates/storage` authority domain tests | Host HTTP surface landing separately |
| Cohort snapshot / live eligibility | supported (domain + storage offers) | domain cohort modules; `grant_offers` activation caps | OpenFGA `cohort` additive; live writer ceiling tests ongoing |
| OpenFGA additive `access_domain` | supported (provider) | `policy/openfga/model.fga` + `authority-additivity` with `OPENSESAME_OPENFGA_URL` (GA-V-32) | Consistency is check-scoped, not cross-store zookie |
| Ancestor invalidation fence | supported (storage) | migration `0033`/`0034`, `a_revoked_ancestor_denies_a_descendant_on_the_next_read` | Provider cleanup remains reconciliation |
| Budget reservation conservation | supported (storage) | CHECK + concurrent debit test | Active-time metering profiles per template |
| Wasmtime workload isolation profile | supported (local fixture) | `crates/sandbox` | Not a claim for arbitrary native/OCI binaries |
| Blocky DNS enforcement | supported (local disposable); live SaaS unsupported | `crates/dns-enforcement`; catalog `blocky-live-saas` refuses | DNS-only local; remote SaaS must not inherit local claims |
| Discord collab role adapter | contract-tested; live SaaS unsupported | `crates/collab-adapter` fixture; catalog `discord-live` refuses | Live guild is `#[ignore]` opt-in; not an issuance adapter |
| Authority expiry → `lifecycle.*` | in progress | SessionGrant already scanned; AuthorityGrant subject wiring | Must not use `live-stack-test.sh` as false evidence |
| Apple Family Controls / OS app block / physical locks | unsupported | tested refuse at preflight / template | Catalog logos ≠ active enforcer |
| Full live Host+OpenBao stack lifecycle smoke | OpenBao installed (arm64 v2.6.2); live AuthorityGrant→feed assertion still missing | unit INV-GA-05 via `authority_grant_expiry`; `live-stack-test.sh` ≠ lifecycle | GA-V-33b unsupported until gateway feed harness exists |
| Static Pages without Host/Identity | supported | ADR 0090; guest roads; local templates UI | Remote authority not pretended active |

## Operator notes

- Set `OPENSESAME_OPENFGA_URL` (e.g. `http://127.0.0.1:18081`) before
  `pnpm test:authority-fabric` so GA-V-32 can settle.
- Do not claim zero residual exposure for providers that only offer eventual
  role removal.
- Expiry on the authorization path is the deny boundary; lifecycle notifications
  are not revocation (ADR 0074).
