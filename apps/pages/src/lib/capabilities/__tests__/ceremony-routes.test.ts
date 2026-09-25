/** @vitest-environment jsdom */
/**
 * A link a device printed must open on every installation (ADR 0140): under
 * the smallest shipped profile, `minimal-local`, the ceremonies capability is
 * approved with nothing optional beside it, its module is in the plan, and
 * activating that module serves `/device`, `/claim`, `/i/:ref`,
 * `/approve/:ref` and `/invoke/:kind` before unlock — a claim or drop link
 * opens even where drops cannot be sent (ADR 0140 D2), an approval link opens
 * with no vault (D7), and an authenticator hand-off opens with zero optional
 * capabilities approved (plan step 10).
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

  it("resolves every ceremony route from the module the plan approves", async () => {
    const plan = profilePlan("minimal-local");
    expect(approved(plan, "sharing.drops")).toBe(false);
    const t = createTestContext();
    const handle = await capabilityRuntime.activate(t.ctx);
    expect(t.entries("route").map((route) => route.path)).toEqual([
      "/device",
      "/claim",
      "/i/:ref",
      "/approve/:ref",
      "/invoke/:kind",
    ]);
    expect(t.entries("route").every((route) => route.gate === "any")).toBe(
      true,
    );
    // Opening a drop is approved with Drops off (ADR 0140 D2).
    expect(plan.approvedOperations).toContain("identity.drop.open");
    expect(plan.approvedOperations).toContain("identity.claim.accept");
    // Approving before unlock needs nothing optional (ADR 0140 D7).
    for (const operation of [
      "identity.interaction.approve",
      "identity.interaction.deny",
      "identity.approval.activation",
      "identity.approval.comparison",
      "identity.approval.report",
      "identity.authenticator.invoke",
    ]) {
      expect(plan.approvedOperations, operation).toContain(operation);
    }
    await handle.dispose();
  });
});
