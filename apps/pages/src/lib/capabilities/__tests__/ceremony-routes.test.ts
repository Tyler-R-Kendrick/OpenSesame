/** @vitest-environment jsdom */
/**
 * A link a device printed must open on every installation (ADR 0140): under
 * the smallest shipped profile, `minimal-local`, the ceremonies capability is
 * approved with nothing optional beside it, its module is in the plan, and
 * activating that module serves `/device`.
 */

import {
  coreCapabilityIds,
  optionalCapabilityIds,
} from "@opensesame/app-core/lib/capabilities/catalog.js";
import { runtimeModule } from "@opensesame/app-core/lib/capabilities/descriptor.js";
import { describe, expect, it } from "vitest";
import { capabilityRuntime } from "../../../modules/identity.ceremonies/runtime.js";
import { createTestContext } from "../../../modules/test-context.js";
import { MODULE_OWNERSHIP } from "../ownership.js";
import { approved, profilePlan } from "./vault-profiles.js";

describe("minimal-local serves the ceremony routes", () => {
  it("approves identity.ceremonies with no optional capability beside it", () => {
    const plan = profilePlan("minimal-local");
    expect(coreCapabilityIds()).toContain("identity.ceremonies");
    expect(approved(plan, "identity.ceremonies")).toBe(true);
    for (const id of optionalCapabilityIds()) {
      expect(approved(plan, id), id).toBe(false);
    }
    const module = runtimeModule("identity.ceremonies");
    expect(plan.approvedModules).toContain(module);
    expect(MODULE_OWNERSHIP[module]?.entry).toBe(
      "src/modules/identity.ceremonies/runtime.ts",
    );
  });

  it("resolves /device from the module the plan approves", async () => {
    const t = createTestContext();
    const handle = await capabilityRuntime.activate(t.ctx);
    expect(t.entries("route").map((route) => route.path)).toEqual(["/device"]);
    await handle.dispose();
  });
});
