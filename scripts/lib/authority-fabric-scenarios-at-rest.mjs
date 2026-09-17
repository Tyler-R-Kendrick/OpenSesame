/** Remaining mandate AT-* rows. Compact so this file stays under 400. */
const cargo = (crate, module, test, extra = {}) => ({
  kind: "cargo",
  crate,
  module,
  test,
  ...extra,
});
const vitest = (pkg, file, test) => ({ kind: "vitest", pkg, file, test });
const integ = (integration, harness) => ({ integration, harness });
const row = (id, area, title, target, extra = {}) => ({
  id,
  workItem: id,
  area,
  tier: extra.tier ?? "unit",
  invariant: extra.invariant ?? "INV-GA-01",
  title,
  target,
});
const storageAdv = integ(
  "authority_adversarial_matrix",
  "crates/storage/tests/authority_adversarial_matrix.rs",
);

/** @type {readonly object[]} */
export const atRestPlaneScenarios = Object.freeze([
  row(
    "AT-REALM-ID",
    "DOMAIN",
    "Cross-realm domain parent refused",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_realm_id_cross_realm_domain_refused",
    ),
  ),
  row(
    "AT-CROSS-TRUST",
    "IDENTITY",
    "Foreign issuer with the same subject is a different principal",
    vitest(
      "@opensesame/auth-upstream",
      "src/__tests__/mapping-store.test.ts",
      "keeps upstream keys distinct per provider for the same subject",
    ),
  ),
  row(
    "AT-NOT-BEFORE",
    "GRANT",
    "Child cannot start before the parent",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_not_before_parent_start_bypass_refused",
    ),
  ),
  row(
    "AT-EXPIRY",
    "GRANT",
    "Expiry is exclusive at the check, not a scanner",
    cargo(
      "opensesame-domain",
      "shared_session_adversarial",
      "shared_session_adversarial::tests::expiry_is_enforced_by_the_check_not_by_a_scanner",
    ),
  ),
  row(
    "AT-ASSURANCE",
    "GRANT",
    "A child may not weaken required assurance",
    cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::assurance_weakening_fails",
    ),
  ),
  row(
    "AT-NETWORK",
    "GRANT",
    "Allowed networks cannot be widened or cleared",
    cargo(
      "opensesame-domain",
      "grant_lineage_adversarial",
      "grant_lineage_adversarial::allowed_networks_cannot_be_widened_or_cleared",
    ),
  ),
  row(
    "AT-OFFLINE",
    "GRANT",
    "Forbidden offline use cannot upgrade",
    cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::offline_upgrade_fails",
    ),
  ),
  row(
    "AT-BUDGET-OMIT",
    "GRANT",
    "Omitting a parent budget is expansion",
    cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::budget_omission_is_expansion",
    ),
  ),
  row(
    "AT-BUDGET-FANOUT",
    "BUDGET",
    "Concurrent children cannot exceed root capacity",
    cargo(
      "opensesame-storage",
      "authority",
      "at_budget_fanout_cannot_exceed_cap",
      storageAdv,
    ),
    { tier: "integration" },
  ),
  row(
    "AT-BUDGET-RETRY",
    "BUDGET",
    "A second spend after the cap is denied",
    cargo(
      "opensesame-gateway",
      "routes::intents",
      "routes::intents::delegated_invoke_tests::property_budgets_deny_when_spent",
      { bin: "opensesame-gateway" },
    ),
    { tier: "integration" },
  ),
  row(
    "AT-PARAMETERS",
    "GRANT",
    "Frozen intent and parameter digest cannot be swapped",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_parameters_digest_and_frozen_intent_refused",
    ),
  ),
  row(
    "AT-SELECTOR",
    "RESOURCE",
    "A wildcard parent may narrow to a subtree, not widen",
    cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::subtree_resource_may_narrow_under_wildcard_parent",
    ),
  ),
  row(
    "AT-ROLE-EDIT",
    "RESOURCE",
    "Editing a role does not expand an issued envelope",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_role_edit_envelope_does_not_expand",
    ),
  ),
  row(
    "AT-CONTROL-ROLE",
    "AUTHZ",
    "A cohort editor cannot mint export or policy admin",
    cargo(
      "opensesame-gateway",
      "routes::local_authority_routes::authority_grants",
      "routes::local_authority_routes::authority_grants::tests::at_control_role_admin_cannot_issue_export_or_policy_edit",
      { bin: "opensesame-gateway" },
    ),
  ),
  row(
    "AT-COHORT-CYCLE",
    "COHORT",
    "A cohort cycle is refused transactionally",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_cohort_cycle_refused",
    ),
  ),
  row(
    "AT-SNAPSHOT-ADD",
    "COHORT",
    "Unreviewed principal added after snapshot gets nothing",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_snapshot_add_unreviewed_principal_gets_nothing",
    ),
  ),
  row(
    "AT-SNAPSHOT-REMOVE",
    "COHORT",
    "Remove then re-add does not resurrect a revoked grant",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_snapshot_remove_then_readd_does_not_resurrect",
    ),
  ),
  row(
    "AT-APPROVAL-STALE",
    "APPROVAL",
    "A digest minted for one intent cannot settle another",
    cargo(
      "opensesame-authz",
      "evidence",
      "evidence::tests::at_approval_stale_bound_digest_mismatch",
    ),
  ),
  row(
    "AT-PROMPT-INJECT",
    "SESSION",
    "A join note cannot authorize or decide admission",
    cargo(
      "opensesame-domain",
      "honest_attacks",
      "honest_attacks::at_prompt_inject_join_note_cannot_authorize",
    ),
  ),
  row(
    "AT-CEILING",
    "POLICY",
    "A task ceiling cannot be widened after start",
    cargo(
      "opensesame-task-access",
      "tests",
      "tests::ceiling_immutability_after_start",
    ),
  ),
  row(
    "AT-REVOKE-ISSUE",
    "LIFECYCLE",
    "A revoked ancestor denies a descendant on the next read",
    cargo(
      "opensesame-storage",
      "authority",
      "authority::tests::a_revoked_ancestor_denies_a_descendant_on_the_next_read",
    ),
    { tier: "integration" },
  ),
  row(
    "AT-POLICY-ERROR",
    "POLICY",
    "Unknown kind or assurance is a fault, not a skip-to-allow default",
    cargo(
      "opensesame-authz",
      "condition",
      "condition::tests::an_unknown_kind_or_assurance_is_a_fault_not_a_default",
    ),
  ),
  row(
    "AT-UNKNOWN-FIELD",
    "GRANT",
    "Unknown constraint fields are refused",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_unknown_field_schema_refused",
    ),
  ),
  row(
    "AT-CROSS-GRANT",
    "GRANT",
    "Action from one grant and resource from another cannot combine",
    cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_cross_grant_action_resource_recombination_refused",
    ),
  ),
  row(
    "AT-SESSION-OBSERVER",
    "SESSION",
    "An observer is in the room and never hears about an item",
    cargo(
      "opensesame-gateway",
      "session_channel",
      "session_channel::tests::an_observer_is_in_the_room_and_never_hears_about_an_item",
      { bin: "opensesame-gateway" },
    ),
    { tier: "integration" },
  ),
  row(
    "AT-SESSION-END",
    "SESSION",
    "Only lifecycle-bound reach ends with the session",
    cargo(
      "opensesame-domain",
      "session_link_adversarial",
      "session_link_adversarial::tests::only_lifecycle_bound_reach_ends_with_the_session",
    ),
  ),
  row(
    "AT-CHANNEL",
    "SESSION",
    "A lapsed grant stops item events on the live channel",
    cargo(
      "opensesame-gateway",
      "session_channel",
      "session_channel::tests::a_lapsed_grant_stops_the_item_events_and_leaves_the_person_in_the_room",
      { bin: "opensesame-gateway" },
    ),
    { tier: "integration" },
  ),
  row(
    "AT-PROVIDER-LATE",
    "ENFORCEMENT",
    "A profile minted at an older generation is stale before it starts",
    cargo(
      "opensesame-sandbox",
      "revoke",
      "revoke::tests::a_profile_minted_at_an_older_generation_is_stale_before_it_starts",
    ),
  ),
  row(
    "AT-PROVIDER-PARTIAL",
    "COLLAB",
    "An unrelenting rate limit is surfaced, not completed",
    cargo(
      "opensesame-collab-adapter",
      "rate_limit",
      "an_unrelenting_rate_limit_is_surfaced",
      integ("rate_limit", "crates/collab-adapter/tests/rate_limit.rs"),
    ),
    { tier: "integration" },
  ),
  row(
    "AT-ROTATION",
    "BROKER",
    "Rotation completes while leftover provider session stays",
    cargo(
      "opensesame-connection-broker",
      "tests::rotation_leftover",
      "tests::rotation_leftover::rotation_leaves_leftover_provider_session",
    ),
  ),
  row(
    "AT-COPIED-KEY",
    "CRYPTO",
    "Expiry denies new fetches; copied wrapping keys still decrypt",
    cargo(
      "opensesame-human-vault",
      "copied_key_residual",
      "expiry_denies_fetch_copied_key_still_decrypts",
      integ(
        "copied_key_residual",
        "crates/human-vault/tests/copied_key_residual.rs",
      ),
    ),
    { tier: "integration" },
  ),
  row(
    "AT-DNS-BYPASS",
    "DNS",
    "Every DNS attestation names its uncovered bypasses",
    cargo(
      "opensesame-dns-enforcement",
      "coverage",
      "coverage::tests::no_attestation_is_ever_unconditional",
    ),
  ),
]);
