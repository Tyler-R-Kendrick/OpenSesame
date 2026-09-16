/**
 * Host-plane scenarios: the narrowing algebra, the depth bound, the authorization
 * boundary, budget inheritance, and the enforcement descriptor. Every one of
 * these is a single compiled Rust module asserting one contract.
 *
 * Registered by authority-fabric-scenarios.mjs; see that file for the rule these
 * all obey — a name here is never satisfied by being written down.
 */

const cargo = (crate, module, test) => ({ kind: "cargo", crate, module, test });

/** @type {readonly object[]} */
export const hostPlaneScenarios = Object.freeze([
  // ---- GRANT: the narrowing algebra (INV-GA-01) -------------------------
  {
    id: "GA-V-01",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "An offline-capability upgrade is refused, not clamped",
    target: cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::offline_upgrade_fails",
    ),
  },
  {
    id: "GA-V-02",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Omitting a parent's budget counts as widening it",
    target: cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::budget_omission_is_expansion",
    ),
  },
  {
    id: "GA-V-03",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "A child may not weaken the assurance its parent required",
    target: cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::assurance_weakening_fails",
    ),
  },
  {
    id: "GA-V-04",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Dropping not-before under a parent that set one is refused",
    target: cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::not_before_omission_under_parent_fails",
    ),
  },
  {
    id: "GA-V-05",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Narrowing a wildcard parent to a subtree is allowed",
    target: cargo(
      "opensesame-domain",
      "grant_attenuation",
      "grant_attenuation::tests::subtree_resource_may_narrow_under_wildcard_parent",
    ),
  },
  {
    id: "GA-V-06",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "A parent pointer is not a validated chain on its own",
    target: cargo(
      "opensesame-domain",
      "validated_grant_chain",
      "validated_grant_chain::tests::raw_parent_pointer_alone_is_not_a_validated_chain",
    ),
  },
  {
    id: "GA-V-07",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Read-A plus write-B never becomes write-A",
    target: cargo(
      "opensesame-domain",
      "permission_entry",
      "permission_entry::tests::read_a_and_write_b_does_not_permit_write_a",
    ),
  },
  {
    id: "GA-V-08",
    workItem: "TEST-SCENARIOS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "A derived grant cannot expand its parent's budget",
    target: cargo(
      "opensesame-domain",
      "grant_adversarial",
      "grant_adversarial::tests::cannot_expand_budget",
    ),
  },

  // ---- DOMAIN: depth bound and cycles (INV-GA-06) -----------------------
  {
    id: "GA-V-09",
    workItem: "TEST-SCENARIOS",
    area: "DOMAIN",
    tier: "unit",
    invariant: "INV-GA-06",
    title: "A chain past the depth bound is refused",
    target: cargo(
      "opensesame-domain",
      "delegation_chain",
      "delegation_chain::tests::rejects_depth",
    ),
  },
  {
    id: "GA-V-10",
    workItem: "TEST-SCENARIOS",
    area: "DOMAIN",
    tier: "unit",
    invariant: "INV-GA-06",
    title:
      "A cycle is refused when the chain is validated, not survived at read time",
    target: cargo(
      "opensesame-domain",
      "delegation_chain",
      "delegation_chain::tests::rejects_cycle",
    ),
  },
  {
    id: "GA-V-11",
    workItem: "TEST-SCENARIOS",
    area: "DOMAIN",
    tier: "unit",
    invariant: "INV-GA-04",
    title: "The hierarchy terminates at a project; an organization is optional",
    target: cargo(
      "opensesame-domain",
      "access_domain::realm",
      "access_domain::realm::tests::a_hierarchy_terminates_at_a_project_without_an_organization",
    ),
  },

  // ---- AUTHZ: no secret escapes the authority boundary (INV-GA-02) ------
  {
    id: "GA-V-12",
    workItem: "TEST-SCENARIOS",
    area: "AUTHZ",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "Knowing a ConnectionRef does not authorize export",
    target: cargo(
      "opensesame-authz",
      "authority_use_contract",
      "authority_use_contract::connection_ref_knowledge_does_not_export",
    ),
  },
  {
    id: "GA-V-13",
    workItem: "TEST-SCENARIOS",
    area: "AUTHZ",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "An action the grant does not list is denied",
    target: cargo(
      "opensesame-authz",
      "authority_use_contract",
      "authority_use_contract::an_action_the_grant_does_not_list_is_denied",
    ),
  },
  {
    id: "GA-V-14",
    workItem: "TEST-SCENARIOS",
    area: "AUTHZ",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "A redirect across authorities is denied",
    target: cargo(
      "opensesame-authz",
      "authority_use_contract",
      "authority_use_contract::redirect_cross_authority_denied",
    ),
  },
  {
    id: "GA-V-15",
    workItem: "TEST-SCENARIOS",
    area: "AUTHZ",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "Reveal is denied without an explicit export grant",
    target: cargo(
      "opensesame-authz",
      "authority_use_contract",
      "authority_use_contract::level3_denied_without_export_grant",
    ),
  },

  // ---- BUDGET: caps narrow down the chain (INV-GA-01) -------------------
  {
    id: "GA-V-16",
    workItem: "TEST-SCENARIOS",
    area: "BUDGET",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "A child cannot raise a cap it inherited",
    target: cargo(
      "opensesame-domain",
      "budget::limits",
      "budget::limits::tests::a_child_cannot_raise_a_cap",
    ),
  },
  {
    id: "GA-V-17",
    workItem: "TEST-SCENARIOS",
    area: "BUDGET",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "A child that states nothing inherits every parent limit",
    target: cargo(
      "opensesame-domain",
      "budget::limits",
      "budget::limits::tests::a_silent_child_inherits_every_parent_limit",
    ),
  },
  {
    id: "GA-V-18",
    workItem: "TEST-SCENARIOS",
    area: "BUDGET",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Budget periods are epoch-aligned, not first-use aligned",
    target: cargo(
      "opensesame-domain",
      "budget::window",
      "budget::window::tests::periods_are_epoch_aligned_not_first_use_aligned",
    ),
  },
  {
    id: "GA-V-19",
    workItem: "TEST-SCENARIOS",
    area: "BUDGET",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Budget arithmetic fails closed at both ends",
    target: cargo(
      "opensesame-domain",
      "budget::amount",
      "budget::amount::tests::arithmetic_fails_closed_at_both_ends",
    ),
  },

  // ---- ENFORCER: a guarantee nobody holds may not be claimed -----------
  {
    id: "GA-V-20",
    workItem: "TEST-SCENARIOS",
    area: "ENFORCER",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "A token lifetime cannot be offered as a termination story",
    target: cargo(
      "opensesame-enforcement",
      "guarantee",
      "guarantee::tests::a_token_lifetime_is_not_a_termination_story",
    ),
  },
  {
    id: "GA-V-21",
    workItem: "TEST-SCENARIOS",
    area: "ENFORCER",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "A value that never left the host cannot excuse an unsupported axis",
    target: cargo(
      "opensesame-enforcement",
      "conformance",
      "conformance::tests::a_value_that_never_left_cannot_be_why_a_dimension_is_unsupported",
    ),
  },
  {
    id: "GA-V-22",
    workItem: "TEST-SCENARIOS",
    area: "ENFORCER",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "A dimension left unanswered is not a descriptor",
    target: cargo(
      "opensesame-enforcement",
      "descriptor",
      "descriptor::tests::a_dimension_left_out_is_not_a_descriptor",
    ),
  },
]);
