import { describe, expect, it } from "vitest";
import { profilePlan } from "./__tests__/vault-profiles.js";

const ID = "sharing.trusted-contacts";
const OPERATIONS = [
  "quorum.circle.manage",
  "quorum.share.ask",
  "quorum.guardian.hold",
  "quorum.request.approve",
  "quorum.recover",
];

describe("trusted contacts across the capability profiles", () => {
  it("minimal-local proves trusted contacts absent: no module, no operation", () => {
    const plan = profilePlan("minimal-local");
    expect(plan.capabilities[ID]?.tier).toBe("optional");
    expect(plan.capabilities[ID]?.approved).toBe(false);
    expect(plan.approvedModules).not.toContain(`${ID}/runtime`);
    for (const operation of OPERATIONS)
      expect(plan.approvedOperations).not.toContain(operation);
  });

  it("rich-explicit, which selects it with consent, resolves its module and every operation", () => {
    const rich = profilePlan("rich-explicit");
    expect(rich.capabilities[ID]?.approved).toBe(true);
    expect(rich.approvedModules).toContain(`${ID}/runtime`);
    for (const operation of OPERATIONS)
      expect(rich.approvedOperations).toContain(operation);
  });
});
