/**
 * AT-* fabric rows. Existing named regressions plus the remaining mandate
 * attacks mapped onto shipped tests (or an explicit unsupported refusal).
 */

const cargo = (crate, module, test, extra = {}) => ({
  kind: "cargo",
  crate,
  module,
  test,
  ...extra,
});

const vitest = (pkg, file, test) => ({ kind: "vitest", pkg, file, test });

/** @type {readonly object[]} */
export const atPlaneScenarios = Object.freeze([
  {
    id: "AT-LIVE-WRITER",
    workItem: "AT-LIVE-WRITER",
    area: "COHORT",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "Unauthorized live writer cannot expand a privileged cohort",
    target: cargo(
      "opensesame-storage",
      "authority::offers_live",
      "authority::offers_live::live_offer_admits_trusted_writer_and_refuses_unauthorized",
    ),
  },
  {
    id: "AT-COHORT-TOKEN",
    workItem: "AT-COHORT-TOKEN",
    area: "COHORT",
    tier: "integration",
    invariant: "INV-GA-01",
    title: "An offer admits each person once; it is not a shared token",
    target: cargo(
      "opensesame-storage",
      "authority",
      "an_offer_admits_each_person_once_and_no_more_than_its_cap",
      {
        integration: "authority_offers",
        harness: "crates/storage/tests/authority_offers.rs",
      },
    ),
  },
  {
    id: "AT-DNS-GLOBAL",
    workItem: "AT-DNS-GLOBAL",
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
    id: "AT-SANDBOX",
    workItem: "AT-SANDBOX",
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
    id: "AT-PREEXISTING",
    workItem: "AT-PREEXISTING",
    area: "COLLAB",
    tier: "integration",
    invariant: "INV-GA-02",
    title: "Reconcile removes only roles OpenSesame created",
    target: cargo(
      "opensesame-collab-adapter",
      "reconcile",
      "reconcile_removes_only_what_it_created",
      {
        integration: "reconcile",
        harness: "crates/collab-adapter/tests/reconcile.rs",
      },
    ),
  },
  {
    id: "AT-REVOKE-QUEUE",
    workItem: "AT-REVOKE-QUEUE",
    area: "BROKER",
    tier: "integration",
    invariant: "INV-GA-07",
    title: "A queued invoke is denied after revoke",
    target: {
      kind: "cargo",
      crate: "opensesame-gateway",
      bin: "opensesame-gateway",
      module: "routes::intents",
      test: "routes::intents::delegated_invoke_tests::at_revoke_queue_queued_invoke_is_denied_after_revoke",
    },
  },
  {
    id: "AT-CLOCK",
    workItem: "AT-CLOCK",
    area: "BUDGET",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "A clock that runs backwards is refused",
    target: cargo(
      "opensesame-domain",
      "budget::ledger::conservation",
      "budget::ledger::conservation::a_clock_that_runs_backwards_is_refused",
    ),
  },
  {
    id: "AT-SSRF",
    workItem: "AT-SSRF",
    area: "BROKER",
    tier: "unit",
    invariant: "INV-GA-02",
    title: "SSRF via URL parameter is blocked",
    target: cargo(
      "opensesame-connector-host",
      "manifest",
      "tests::ssrf_via_url_parameter_blocked",
    ),
  },
  {
    id: "AT-APPROVAL-QUORUM",
    workItem: "AT-APPROVAL-QUORUM",
    area: "IDENTITY",
    tier: "integration",
    invariant: "INV-GA-09",
    title: "One approval is spent exactly once under a real race",
    target: vitest(
      "@opensesame/control-plane",
      "src/__tests__/interaction-handoff.test.ts",
      "adversarial: one approval is spent exactly once under a real race",
    ),
  },
  {
    id: "AT-RAW-PARENT",
    workItem: "AT-RAW-PARENT",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "A forged parent pointer is not a validated chain",
    target: cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_raw_parent_forged_pointer_not_validated_chain",
    ),
  },
  {
    id: "AT-CORRELATED",
    workItem: "AT-CORRELATED",
    area: "GRANT",
    tier: "unit",
    invariant: "INV-GA-01",
    title: "Read-A plus write-B never becomes write-A",
    target: cargo(
      "opensesame-domain",
      "authority_adversarial_matrix",
      "authority_adversarial_matrix::at_correlated_write_a_never_authorized",
    ),
  },
  {
    id: "AT-FGA-STALE",
    workItem: "AT-FGA-STALE",
    area: "AUTHORIZATION",
    tier: "integration",
    invariant: "INV-GA-07",
    title: "A stale OpenFGA projection cannot authorize dispatch",
    target: {
      kind: "cargo",
      crate: "opensesame-gateway",
      bin: "opensesame-gateway",
      module: "routes::intents_projection",
      test: "routes::intents_projection::tests::at_fga_stale_freshness_fence_denies_before_dispatch",
    },
  },
  {
    id: "AT-STATE-RESTORE",
    workItem: "AT-STATE-RESTORE",
    area: "STORAGE",
    tier: "integration",
    invariant: "INV-GA-07",
    title: "Restore generation fence refuses resurrected authority",
    target: cargo(
      "opensesame-storage",
      "authority",
      "at_state_restore_generation_fence",
      {
        integration: "authority_adversarial_matrix",
        harness: "crates/storage/tests/authority_adversarial_matrix.rs",
      },
    ),
  },
]);
