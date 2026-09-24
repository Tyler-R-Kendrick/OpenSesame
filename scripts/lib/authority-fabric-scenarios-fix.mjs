/**
 * FIX-* fabric rows retargeted onto shipped enforcers: Blocky, Wasmtime,
 * Discord HTTP, and the owned invoke path. Algebra tests remain in-tree
 * as unit coverage; they are not the FIX-* evidence.
 */

const cargo = (crate, module, test, extra = {}) => ({
  kind: "cargo",
  crate,
  module,
  test,
  ...extra,
});

const row = (id, workItem, area, title, target, extra = {}) => ({
  id,
  workItem,
  area,
  tier: extra.tier ?? "unit",
  invariant: extra.invariant ?? "INV-GA-01",
  title,
  target,
});

/** @type {readonly object[]} */
export const fixPlaneScenarios = Object.freeze([
  row(
    "GA-V-35",
    "FIX-FAMILY",
    "BROKER",
    "FIX-FAMILY: expiry stops owned fixture work at the side-effect fence",
    cargo(
      "opensesame-gateway",
      "routes::intents",
      "routes::intents::delegated_invoke_tests::family_expiry_stops_queued_fixture_work",
    ),
    { tier: "integration", invariant: "INV-GA-05" },
  ),
  row(
    "GA-V-36",
    "FIX-FAMILY",
    "DNS",
    "FIX-FAMILY: screen-time accounting is refused with a mechanical reason",
    cargo(
      "opensesame-dns-enforcement",
      "coverage",
      "coverage::tests::screen_time_is_refused_with_a_mechanical_reason",
    ),
  ),
  row(
    "GA-V-37",
    "FIX-FAMILY",
    "DNS",
    "FIX-FAMILY: Blocky disable cannot be built without groups",
    cargo(
      "opensesame-dns-enforcement",
      "blocky::request",
      "blocky::request::tests::a_disable_cannot_be_built_without_groups",
    ),
  ),
  row(
    "GA-V-38",
    "FIX-FAMILY",
    "DNS",
    "FIX-FAMILY: Blocky DNS is measured or the launcher failure is recorded",
    cargo(
      "opensesame-dns-enforcement",
      "family_blocky",
      "family_blocky_dns_is_measured_or_the_launcher_failure_is_recorded",
      {
        integration: "family_blocky",
        harness: "crates/dns-enforcement/tests/family_blocky.rs",
      },
    ),
    { tier: "integration" },
  ),
  row(
    "GA-V-39",
    "FIX-FAMILY",
    "DNS",
    "FIX-FAMILY: usage and egress claims are refused, not reported active",
    cargo(
      "opensesame-dns-enforcement",
      "coverage",
      "coverage::tests::every_usage_and_egress_claim_is_refused",
    ),
  ),
  row(
    "GA-V-40",
    "FIX-CONTRACTOR",
    "ENFORCEMENT",
    "FIX-CONTRACTOR: issuance preflight refuses absent platforms",
    cargo(
      "opensesame-authz",
      "issuance",
      "issuance::tests::absent_platforms_are_refused",
    ),
  ),
  row(
    "GA-V-41",
    "FIX-CONTRACTOR",
    "BROKER",
    "FIX-CONTRACTOR: an action outside the child grant is refused at invoke",
    cargo(
      "opensesame-gateway",
      "routes::intents",
      "routes::intents::delegated_invoke_tests::adversarial_an_action_outside_the_child_grant_is_refused",
    ),
    { tier: "integration", invariant: "INV-GA-02" },
  ),
  row(
    "GA-V-42",
    "FIX-CONTRACTOR",
    "BROKER",
    "FIX-CONTRACTOR: revocation ends delegated exercise without a new side effect",
    cargo(
      "opensesame-gateway",
      "routes::intents",
      "routes::intents::delegated_invoke_tests::contract_revocation_ends_delegated_exercise",
    ),
    { tier: "integration", invariant: "INV-GA-07" },
  ),
  row(
    "GA-V-43",
    "FIX-CONTRACTOR",
    "COLLAB",
    "FIX-CONTRACTOR: a live independent authority survives reconciliation",
    cargo(
      "opensesame-collab-adapter",
      "reconcile",
      "a_live_authority_survives_reconciliation",
      {
        integration: "reconcile",
        harness: "crates/collab-adapter/tests/reconcile.rs",
      },
    ),
    { tier: "integration" },
  ),
  row(
    "GA-V-44",
    "FIX-RAID",
    "COLLAB",
    "FIX-RAID: Discord HTTP apply creates scopes then assigns",
    cargo(
      "opensesame-collab-adapter",
      "apply",
      "apply_creates_scopes_then_assigns_in_that_order",
      {
        integration: "apply",
        harness: "crates/collab-adapter/tests/apply.rs",
      },
    ),
    { tier: "integration" },
  ),
  row(
    "GA-V-45",
    "FIX-RAID",
    "COLLAB",
    "FIX-RAID: reconcile removes only roles OpenSesame created",
    cargo(
      "opensesame-collab-adapter",
      "reconcile",
      "reconcile_removes_only_what_it_created",
      {
        integration: "reconcile",
        harness: "crates/collab-adapter/tests/reconcile.rs",
      },
    ),
    { tier: "integration" },
  ),
  row(
    "GA-V-46",
    "FIX-RAID",
    "COLLAB",
    "FIX-RAID: a rate-limited create is retried once and creates one role",
    cargo(
      "opensesame-collab-adapter",
      "rate_limit",
      "a_rate_limited_create_is_retried_once_and_creates_one_role",
      {
        integration: "rate_limit",
        harness: "crates/collab-adapter/tests/rate_limit.rs",
      },
    ),
    { tier: "integration" },
  ),
  row(
    "GA-V-47",
    "FIX-WORKCELL",
    "SANDBOX",
    "FIX-WORKCELL: a native binary is refused by the spawn path itself",
    cargo(
      "opensesame-sandbox",
      "error",
      "a_native_binary_is_refused_by_the_spawn_path_itself",
      {
        integration: "payloads",
        features: ["wasm-runtime", "fixtures"],
        harness: "crates/sandbox/tests/payloads.rs",
      },
    ),
    { tier: "integration" },
  ),
  row(
    "GA-V-48",
    "FIX-WORKCELL",
    "SANDBOX",
    "FIX-WORKCELL: a looping guest runs out of fuel",
    cargo(
      "opensesame-sandbox",
      "error",
      "a_guest_that_loops_forever_runs_out_of_fuel",
      {
        integration: "guests",
        features: ["wasm-runtime", "fixtures"],
        harness: "crates/sandbox/tests/guests.rs",
      },
    ),
    { tier: "integration" },
  ),
  row(
    "GA-V-49",
    "FIX-WORKCELL",
    "SANDBOX",
    "FIX-WORKCELL: every ambient WASI module is refused by name",
    cargo(
      "opensesame-sandbox",
      "boundary",
      "boundary::tests::every_ambient_module_is_refused_and_named",
    ),
  ),
]);
