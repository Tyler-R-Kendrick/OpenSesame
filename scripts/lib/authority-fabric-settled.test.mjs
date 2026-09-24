import { describe, expect, it } from "vitest";

import { scenarios } from "./authority-fabric.mjs";

/** Settled mandate rows must keep their enforceable targets. */
const PINS = [
  {
    id: "GA-V-33",
    tier: "unit",
    kind: "cargo",
    crate: "opensesame-lifecycle",
    testIncludes: "authority_grant_expiry",
  },
  {
    id: "GA-V-34",
    tier: "unit",
    kind: "vitest",
    pkg: "@opensesame/os-domain",
    testIncludes: "AccessLease",
  },
  {
    id: "GA-V-33b",
    tier: "integration",
    kind: "cargo",
    crate: "opensesame-gateway",
    testIncludes: "authority_grant_expiry_reaches_lifecycle_feed_via_scan",
  },
  {
    id: "GA-V-59",
    crate: "opensesame-dns-enforcement",
    module: "blocky::request",
    test: "blocky::request::tests::a_disable_cannot_be_built_without_groups",
  },
  {
    id: "GA-V-60",
    crate: "opensesame-sandbox",
    integration: "payloads",
    features: ["wasm-runtime", "fixtures"],
    test: "a_native_binary_is_refused_by_the_spawn_path_itself",
  },
  {
    id: "GA-V-61",
    crate: "opensesame-collab-adapter",
    integration: "apply",
    test: "apply_creates_scopes_then_assigns_in_that_order",
  },
];

describe("settled mandate pins", () => {
  it("keeps each settled row on its enforceable target", () => {
    for (const pin of PINS) {
      const row = scenarios.find((scenario) => scenario.id === pin.id);
      expect(row, pin.id).toBeDefined();
      if (pin.tier) expect(row.tier).toBe(pin.tier);
      if (pin.kind) expect(row.target.kind).toBe(pin.kind);
      if (pin.crate) expect(row.target.crate).toBe(pin.crate);
      if (pin.pkg) expect(row.target.pkg).toBe(pin.pkg);
      if (pin.bin) expect(row.target.bin).toBe(pin.bin);
      if (pin.module) expect(row.target.module).toBe(pin.module);
      if (pin.integration) expect(row.target.integration).toBe(pin.integration);
      if (pin.features) expect(row.target.features).toEqual(pin.features);
      if (pin.test) expect(row.target.test).toBe(pin.test);
      if (pin.testIncludes) expect(row.target.test).toContain(pin.testIncludes);
    }
  });
});
