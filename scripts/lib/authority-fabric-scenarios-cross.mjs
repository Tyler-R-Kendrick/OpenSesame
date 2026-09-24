/**
 * Scenarios that reach past one Rust module: the guest roads that must not move,
 * the races, the surface-parity and single-ledger sweeps, and the provider, live
 * and unsupported tiers.
 *
 * Registered by authority-fabric-scenarios.mjs.
 */

const cargo = (crate, module, test) => ({ kind: "cargo", crate, module, test });
const vitest = (pkg, file, test) => ({ kind: "vitest", pkg, file, test });

/** @type {readonly object[]} */
export const crossPlaneScenarios = Object.freeze([
  // ---- Guest roads stay where they are (INV-GA-11) ----------------------
  {
    id: "GA-V-23",
    workItem: "TEST-SCENARIOS",
    area: "CLIENT",
    tier: "unit",
    invariant: "INV-GA-11",
    title: "A guest is isolated whenever any vault on the device is sealed",
    target: vitest(
      "@opensesame/pages",
      "src/lib/vault/store.test.ts",
      "isolates a guest whenever any vault on the device is sealed",
    ),
  },
  {
    id: "GA-V-24",
    workItem: "TEST-SCENARIOS",
    area: "CLIENT",
    tier: "unit",
    invariant: "INV-GA-11",
    title:
      "A guest beside a sealed vault runs in its own tomb and hands it back",
    target: vitest(
      "@opensesame/pages",
      "src/lib/vault/store.test.ts",
      "runs a guest beside a sealed vault in its own tomb and hands the vault back on lock",
    ),
  },

  // ---- TEST-RACES: concurrency, not sequence ---------------------------
  {
    id: "GA-V-25",
    workItem: "TEST-RACES",
    area: "DOMAIN",
    tier: "integration",
    invariant: "INV-GA-07",
    title:
      "A revoked ancestor makes every derived authority unusable on the next read",
    target: cargo(
      "opensesame-storage",
      "authority",
      "authority::tests::a_revoked_ancestor_denies_a_descendant_on_the_next_read",
    ),
  },
  {
    id: "GA-V-26",
    workItem: "TEST-RACES",
    area: "BUDGET",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "Concurrent debits against one window cannot double-spend a cap",
    target: cargo(
      "opensesame-storage",
      "authority",
      "authority::tests::concurrent_debits_cannot_exceed_a_window_cap",
    ),
  },
  {
    id: "GA-V-27",
    workItem: "TEST-RACES",
    area: "DOMAIN",
    tier: "integration",
    invariant: "INV-GA-06",
    title: "Two concurrent chain writes cannot combine into a cycle",
    target: cargo(
      "opensesame-storage",
      "authority",
      "authority::tests::interleaved_chain_writes_cannot_create_a_cycle",
    ),
  },
  {
    id: "GA-V-28",
    workItem: "TEST-RACES",
    area: "IDENTITY",
    tier: "integration",
    invariant: "INV-GA-09",
    title:
      "An approval of an authority change is spent once under concurrent settlement",
    target: vitest(
      "@opensesame/control-plane",
      "src/__tests__/interaction-handoff.test.ts",
      "adversarial: one approval is spent exactly once under a real race",
    ),
  },
  // ---- TEST-PARITY: surfaces and the single ledger ---------------------
  {
    id: "GA-V-30",
    workItem: "TEST-PARITY",
    area: "PARITY",
    tier: "unit",
    invariant: "INV-GA-12",
    title:
      "Every authority capability maps or ADR-excludes all four agent surfaces",
    target: {
      kind: "registry-sweep",
      prefixes: ["authority.", "authority_", "general_authority."],
      pkg: "@opensesame/capability-registry",
      sweep: "src/registry.test.ts",
      test: "Every authority capability maps or ADR-excludes all four agent surfaces",
    },
  },
  {
    id: "GA-V-31",
    workItem: "TEST-PARITY",
    area: "PARITY",
    tier: "unit",
    invariant: "INV-GA-10",
    title: "apps/pages keeps one local authority ledger, not two",
    target: {
      kind: "ledger-inventory",
      canonical: "packages/app-core/src/lib/local-share-grants.ts",
      directory: "packages/app-core/src/lib",
      inventory:
        "docs/implementation/general-authority/local-ledger-inventory.json",
    },
  },

  // ---- Provider and live tiers ----------------------------------------
  {
    id: "GA-V-32",
    workItem: "TEST-PARITY",
    area: "AUTHZ",
    tier: "provider",
    invariant: "INV-GA-03",
    title:
      "No check true against the baseline OpenFGA model returns false against the delta",
    target: {
      kind: "fga-additivity",
      model: "spec/openfga/model.fga",
      harness: "packages/policy/src/__tests__/authority-additivity.test.ts",
      test: "No check true against the baseline OpenFGA model returns false against the delta",
    },
  },
  {
    id: "GA-V-33",
    workItem: "TEST-STACK",
    area: "DOMAIN",
    tier: "unit",
    invariant: "INV-GA-05",
    title:
      "An AuthorityGrant past its deadline publishes lifecycle.expiry.expired",
    target: cargo(
      "opensesame-lifecycle",
      "authority_grant_expiry",
      "authority_grant_expiry::authority_grant_expiry_reaches_the_lifecycle_feed",
    ),
  },
  {
    id: "GA-V-34",
    workItem: "TEST-REPORT",
    area: "DOMAIN",
    tier: "unit",
    invariant: "INV-GA-08",
    title: "Two product names never become two models or two ledgers",
    target: vitest(
      "@opensesame/os-domain",
      "src/__tests__/authority-naming.test.ts",
      "does not export an AccessLease domain type beside AuthorityGrant",
    ),
  },

  {
    id: "GA-V-50",
    workItem: "FIX-GENERALITY",
    area: "CLIENT",
    tier: "unit",
    invariant: "INV-GA-08",
    title:
      "FIX-GENERALITY: load declarative templates without audience engine branches",
    target: vitest(
      "@opensesame/os-domain",
      "src/__tests__/authority-templates.test.ts",
      "loads declarative templates without audience-specific engine branches",
    ),
  },

  // ---- AT-* named adversarial matrix (SEC-REGRESS) -----------------------
  {
    id: "GA-V-51",
    workItem: "SEC-REGRESS",
    area: "DOMAIN",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "AT-REALM-ID: cross-realm domain parent refused",
    target: cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_realm_id_cross_realm_domain_refused",
    ),
  },
  {
    id: "GA-V-52",
    workItem: "SEC-REGRESS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "AT-RAW-PARENT: forged parent pointer is not a validated chain",
    target: cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_raw_parent_forged_pointer_not_validated_chain",
    ),
  },
  {
    id: "GA-V-53",
    workItem: "SEC-REGRESS",
    area: "RESOURCE",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "AT-CROSS-GRANT: action/resource recombination refused",
    target: cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_cross_grant_action_resource_recombination_refused",
    ),
  },
  {
    id: "GA-V-54",
    workItem: "SEC-REGRESS",
    area: "COHORT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "AT-SNAPSHOT-ADD: unreviewed principal gets nothing",
    target: cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_snapshot_add_unreviewed_principal_gets_nothing",
    ),
  },
  {
    id: "GA-V-55",
    workItem: "SEC-REGRESS",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "AT-UNKNOWN-FIELD: unknown constraint fields denied",
    target: cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_unknown_field_schema_refused",
    ),
  },
]);
