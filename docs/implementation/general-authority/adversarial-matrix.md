# Adversarial acceptance matrix (AT-*)

Mapping from the general-authority mandate's AT-* IDs to named executable
regressions. A row is **covered** only when a named test exists and the command
below has been run green in this worktree. External SaaS (Discord / Blocky) rows
stay **still-open** unless a local refusal/uncertainty path is named.

Reproduce a single domain AT:

```bash
cargo +1.88.0 test -p opensesame-domain --lib -- authority_adversarial_matrix::
```

Reproduce storage AT wrappers:

```bash
cargo +1.88.0 test -p opensesame-storage --test authority_adversarial_matrix
```

## Priority local coverage

| Test ID | Status | file::test | Command |
|---|---|---|---|
| AT-REALM-ID | **new** | `authority_adversarial_matrix::at_realm_id_cross_realm_domain_refused` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_realm_id_cross_realm_domain_refused` |
| AT-REALM-ID (storage) | **new** | `authority_adversarial_matrix::at_realm_id_cross_realm_domain_parent_refused` | `cargo +1.88.0 test -p opensesame-storage --test authority_adversarial_matrix -- --exact at_realm_id_cross_realm_domain_parent_refused` |
| AT-NOT-BEFORE | **new** | `authority_adversarial_matrix::at_not_before_parent_start_bypass_refused` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_not_before_parent_start_bypass_refused` |
| AT-PARAMETERS | **new** | `authority_adversarial_matrix::at_parameters_digest_and_frozen_intent_refused` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_parameters_digest_and_frozen_intent_refused` |
| AT-ROLE-EDIT | **new** | `authority_adversarial_matrix::at_role_edit_envelope_does_not_expand` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_role_edit_envelope_does_not_expand` |
| AT-SNAPSHOT-ADD | **new** | `authority_adversarial_matrix::at_snapshot_add_unreviewed_principal_gets_nothing` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_snapshot_add_unreviewed_principal_gets_nothing` |
| AT-SNAPSHOT-REMOVE | **new** | `authority_adversarial_matrix::at_snapshot_remove_then_readd_does_not_resurrect` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_snapshot_remove_then_readd_does_not_resurrect` |
| AT-COHORT-CYCLE | **new** | `authority_adversarial_matrix::at_cohort_cycle_refused` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_cohort_cycle_refused` |
| AT-COHORT-CYCLE (storage) | **new** | `authority_adversarial_matrix::at_cohort_cycle_domain_reparent_refused` | `cargo +1.88.0 test -p opensesame-storage --test authority_adversarial_matrix -- --exact at_cohort_cycle_domain_reparent_refused` |
| AT-CROSS-GRANT | **new** | `authority_adversarial_matrix::at_cross_grant_action_resource_recombination_refused` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_cross_grant_action_resource_recombination_refused` |
| AT-APPROVAL-STALE | **new** | `authority_adversarial_matrix::at_approval_stale_intent_digest_refused` + `evidence::tests::at_approval_stale_bound_digest_mismatch` | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_approval_stale_intent_digest_refused` / `cargo +1.88.0 test -p opensesame-authz --lib -- --exact evidence::tests::at_approval_stale_bound_digest_mismatch` |
| AT-UNKNOWN-FIELD | **new** | `authority_adversarial_matrix::at_unknown_field_schema_refused` (`GrantConstraints` now `deny_unknown_fields`) | `cargo +1.88.0 test -p opensesame-domain --lib -- --exact authority_adversarial_matrix::at_unknown_field_schema_refused` |
| AT-STATE-RESTORE | **new** | `authority_adversarial_matrix::at_state_restore_generation_fence` | `cargo +1.88.0 test -p opensesame-storage --test authority_adversarial_matrix -- --exact at_state_restore_generation_fence` |
| AT-MULTIWRITER | **new** | `authority_adversarial_matrix::at_multiwriter_lease_fence` | `cargo +1.88.0 test -p opensesame-storage --test authority_adversarial_matrix -- --exact at_multiwriter_lease_fence` |

## Already covered (named behavior; AT aliases where added)

| Test ID | Status | Existing / alias |
|---|---|---|
| AT-OFFLINE | **covered** (+ alias) | `grant_attenuation::tests::offline_upgrade_fails`; `authority_adversarial_matrix::at_offline_and_budget_omit_refused` |
| AT-BUDGET-OMIT | **covered** (+ alias) | `grant_attenuation::tests::budget_omission_is_expansion`; alias above |
| AT-BUDGET-FANOUT | **covered** (+ alias) | `authority::tests::concurrent_debits_cannot_exceed_a_window_cap`; `authority_adversarial_matrix::at_budget_fanout_cannot_exceed_cap` |
| AT-BUDGET-RETRY | **covered** | `crates/storage/tests/authority_atomic.rs::a_retry_holds_the_same_capacity_once` |
| AT-RAW-PARENT | **covered** (+ alias) | `validated_grant_chain::tests::raw_parent_pointer_alone_is_not_a_validated_chain`; `engine_contract` AT-RAW-PARENT comment; alias `at_raw_parent_forged_pointer_not_validated_chain` |
| AT-CORRELATED | **covered** (+ alias) | `permission::adversarial::*`; alias `at_correlated_write_a_never_authorized` |
| AT-NOT-BEFORE | **covered** (prior) | `grant_attenuation::tests::not_before_omission_under_parent_fails`; `grant_lineage_adversarial::not_before_cannot_be_dropped_or_moved_earlier` |
| AT-PARAMETERS | **covered** (prior) | `grant_lineage_adversarial::parameter_rules_cannot_be_swapped_or_dropped` |
| AT-SELECTOR | **covered** | `grant_lineage_adversarial::resource_scope_narrows_by_bounded_containment_only`; permission adversarial bare-prefix |
| AT-ROLE-EDIT | **covered** (prior) | `permission::role::tests::a_role_cannot_be_redefined_in_place` |
| AT-COHORT-CYCLE | **covered** (prior) | `cohort_adversarial::a_cycle_is_refused_however_the_walk_arrives_at_it` |
| AT-SNAPSHOT-ADD/REMOVE | **covered** (prior) | `cohort_admission_adversarial::*` |
| AT-FGA-STALE / additivity | **covered** (conditional) | `packages/policy` `authority-additivity` (live OpenFGA when configured) |
| AT-REVOKE-ISSUE | **covered** | `authority::tests::a_revoked_ancestor_denies_a_descendant_on_the_next_read`; fence suites |
| AT-PROVIDER-LATE | **covered** | `authority_atomic::a_late_provider_observation_cannot_overwrite_a_newer_revoke` |

## Still open (local SaaS / surface / product gaps)

| Test ID | Why still open |
|---|---|
| AT-CROSS-TRUST | Needs configured foreign IdP mapping fixture beyond unit isolation |
| AT-CONTROL-ROLE / AT-LIVE-WRITER / AT-COHORT-TOKEN | Partial unit coverage exists; full product control-plane ceremony not named AT-* |
| AT-APPROVAL-QUORUM | Race/quorum suite elsewhere; not AT-named here |
| AT-PROMPT-INJECT / AT-CEILING / AT-SPAWN / AT-SANDBOX / AT-RESOURCE-EXHAUST | Sandbox/runtime surfaces |
| AT-DNS-GLOBAL / AT-DNS-BYPASS | Blocky live / honest-unsupported |
| AT-SESSION-* / AT-CHANNEL / AT-PRIVACY / AT-STATIC / AT-LEGACY / AT-NEW-AUDIENCE | Product-surface journeys |
| AT-ROTATION / AT-COPIED-KEY / AT-PREEXISTING / AT-PROVIDER-PARTIAL | Provider adapter honesty |
| AT-CLOCK / AT-SSRF / AT-REVOKE-QUEUE / AT-POLICY-ERROR | Dedicated harnesses not AT-named yet |

## Fabric note

Host-plane GA-V-* scenarios in `scripts/lib/authority-fabric-scenarios-host.mjs`
already settle several attenuation contracts (offline, budget omit, assurance,
not-before, raw parent, correlated). This matrix is the AT-* ID index; it does
not duplicate every GA-V row.
