import { describe, expect, it } from "vitest";
import { profilePlan } from "./__tests__/vault-profiles.js";

describe("encrypted search across the capability profiles", () => {
  it("minimal-local proves encrypted search absent: no module, and the stores stay device-sealed", () => {
    const plan = profilePlan("minimal-local");
    const id = "storage.encrypted-search";
    expect(plan.capabilities[id]?.tier).toBe("optional");
    expect(plan.capabilities[id]?.approved).toBe(false);
    expect(plan.approvedModules).not.toContain(`${id}/runtime`);
    // It owns no operation: it routes two core stores and draws no surface.
    expect(plan.capabilities[id]?.dependencyOf ?? []).toEqual([]);
    const rich = profilePlan("rich-explicit");
    expect(rich.approvedModules).toContain(`${id}/runtime`);
  });
});
