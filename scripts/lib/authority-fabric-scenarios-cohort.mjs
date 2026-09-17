/**
 * Cohort and issuance-preflight fabric scenarios (live offer writer gate and
 * absent-platform refusal). Split from `-cross` so that file stays at its
 * recorded 487-line baseline.
 *
 * Registered by authority-fabric-scenarios.mjs.
 */

const cargo = (crate, module, test, extra = {}) => ({
  kind: "cargo",
  crate,
  module,
  test,
  ...extra,
});

/** @type {readonly object[]} */
export const cohortPlaneScenarios = Object.freeze([
  {
    id: "GA-V-56",
    workItem: "COHORT-SNAPSHOT-LIVE",
    area: "COHORT",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "Live offer without a trusted writer is refused",
    target: cargo(
      "opensesame-storage",
      "authority::offers_live",
      "authority::offers_live::live_offer_without_a_trusted_writer_is_refused",
    ),
  },
  {
    id: "GA-V-57",
    workItem: "COHORT-SNAPSHOT-LIVE",
    area: "COHORT",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "Live offer admits a trusted writer and refuses an unauthorized one",
    target: cargo(
      "opensesame-storage",
      "authority::offers_live",
      "authority::offers_live::live_offer_admits_trusted_writer_and_refuses_unauthorized",
    ),
  },
  {
    id: "GA-V-58",
    workItem: "ENF-DESCRIBE",
    area: "ENFORCEMENT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Issuance preflight refuses absent platforms",
    target: cargo(
      "opensesame-authz",
      "issuance",
      "issuance::tests::absent_platforms_are_refused",
    ),
  },
  {
    id: "GA-V-59",
    workItem: "DNS-SCOPE",
    area: "DNS",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Blocky disable cannot be built without groups",
    target: cargo(
      "opensesame-dns-enforcement",
      "blocky::request",
      "blocky::request::tests::a_disable_cannot_be_built_without_groups",
    ),
  },
  {
    id: "GA-V-60",
    workItem: "SBOX-TEST",
    area: "SANDBOX",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "A native payload is refused by the spawn path itself",
    target: cargo(
      "opensesame-sandbox",
      "error",
      "a_native_binary_is_refused_by_the_spawn_path_itself",
      {
        integration: "payloads",
        features: ["wasm-runtime", "fixtures"],
        harness: "crates/sandbox/tests/payloads.rs",
      },
    ),
  },
  {
    id: "GA-V-61",
    workItem: "COL-TEST",
    area: "COLLAB",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "Discord HTTP fixture applies roles in create-scope-assign order",
    target: cargo(
      "opensesame-collab-adapter",
      "apply",
      "apply_creates_scopes_then_assigns_in_that_order",
      {
        integration: "apply",
        harness: "crates/collab-adapter/tests/apply.rs",
      },
    ),
  },
  {
    id: "GA-V-29",
    workItem: "TEST-RACES",
    area: "DOMAIN",
    tier: "integration",
    invariant: "INV-GA-06",
    title: "Evaluation cannot loop under an adversarial interleaving",
    target: {
      kind: "cargo",
      crate: "opensesame-domain",
      module: "shuttle_authority",
      test: "evaluation_cannot_loop_under_adversarial_interleaving",
      features: ["concurrency-test"],
      integration: "shuttle_authority",
    },
  },
  {
    id: "GA-V-62",
    workItem: "DNS-SCOPE",
    area: "DNS",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Opposite unit policies cannot disable each other",
    target: cargo(
      "opensesame-dns-enforcement",
      "topology",
      "topology::tests::opposite_unit_policies_cannot_disable_each_other",
    ),
  },
  {
    id: "GA-V-63",
    workItem: "COHORT-SNAPSHOT-LIVE",
    area: "COHORT",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "A broader unrelated grant cannot be bound to an offer",
    target: cargo(
      "opensesame-storage",
      "authority::offers_live",
      "authority::offers_live::a_broader_unrelated_grant_cannot_be_bound_to_an_offer",
    ),
  },
  {
    id: "GA-V-64",
    workItem: "OPS-GATING",
    area: "ENFORCEMENT",
    tier: "unsupported",
    invariant: "INV-GA-02",
    title: "Live Discord guild and Apple Family Controls are not claimed",
    unsupported: {
      reason:
        "No disposable authorized live Discord guild or Apple Family Controls entitlement in this environment.",
      wouldRequire:
        "An operator-authorized disposable guild/token and a signed Apple enrollment; catalog already refuses discord-live and apple-ios.",
    },
  },
  {
    id: "GA-V-65",
    workItem: "AT-REVOKE-QUEUE",
    area: "BROKER",
    tier: "integration",
    invariant: "INV-GA-07",
    title: "A queued invoke is denied after revoke at the side-effect boundary",
    target: {
      kind: "cargo",
      crate: "opensesame-gateway",
      bin: "opensesame-gateway",
      module: "routes::intents",
      test: "routes::intents::delegated_invoke_tests::at_revoke_queue_queued_invoke_is_denied_after_revoke",
    },
  },
]);
