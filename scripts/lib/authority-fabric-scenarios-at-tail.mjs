/** Tail of the mandate AT-* rows, split so at-rest stays under 400. */
const cargo = (crate, module, test, extra = {}) => ({
  kind: "cargo",
  crate,
  module,
  test,
  ...extra,
});
const vitest = (pkg, file, test) => ({ kind: "vitest", pkg, file, test });
const integ = (integration, harness) => ({ integration, harness });
const wasm = { features: ["wasm-runtime", "fixtures"] };
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
export const atTailPlaneScenarios = Object.freeze([
  row(
    "AT-SPAWN",
    "SANDBOX",
    "A chain past the depth bound is refused",
    cargo(
      "opensesame-domain",
      "delegation_chain",
      "delegation_chain::tests::rejects_depth",
    ),
  ),
  row(
    "AT-RESOURCE-EXHAUST",
    "SANDBOX",
    "A guest that loops forever runs out of fuel",
    cargo(
      "opensesame-sandbox",
      "error",
      "a_guest_that_loops_forever_runs_out_of_fuel",
      {
        integration: "guests",
        harness: "crates/sandbox/tests/guests.rs",
        ...wasm,
      },
    ),
    { tier: "integration" },
  ),
  row(
    "AT-MULTIWRITER",
    "STORAGE",
    "A competing writer is refused by the lease fence",
    cargo(
      "opensesame-storage",
      "authority",
      "at_multiwriter_lease_fence",
      storageAdv,
    ),
    { tier: "integration" },
  ),
  row(
    "AT-PRIVACY",
    "AUDIT",
    "Bearer tokens and JSON keys are redacted",
    cargo(
      "opensesame-redaction",
      "privacy",
      "privacy::redacts_bearer_and_json_keys",
    ),
  ),
  row(
    "AT-STATIC",
    "CLIENT",
    "A guest stays usable without Host or Identity",
    vitest(
      "@opensesame/pages",
      "src/lib/vault/store.test.ts",
      "isolates a guest whenever any vault on the device is sealed",
    ),
  ),
  row(
    "AT-LEGACY",
    "BROKER",
    "A legacy connection is pinned before authorization",
    cargo(
      "opensesame-connection-broker",
      "tests::legacy_connections",
      "tests::legacy_connections::legacy_connection_is_pinned_before_authorization",
    ),
  ),
  row(
    "AT-NEW-AUDIENCE",
    "CLIENT",
    "A new declarative template loads without engine branches",
    vitest(
      "@opensesame/os-domain",
      "src/__tests__/authority-templates.test.ts",
      "loads declarative templates without audience-specific engine branches",
    ),
  ),
]);
