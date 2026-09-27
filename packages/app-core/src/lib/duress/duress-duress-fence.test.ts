import { describe, expect, it } from "vitest";
import { DuressSessionFence } from "./session/fence.js";

describe("duress fence", () => {
  it("rejects stale resolution (AT-040)", () => {
    const fence = new DuressSessionFence("test-fence");
    fence.activate({
      incidentId: "i1",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["export_root"],
      admittedCompartmentRefs: ["c1"],
    });
    const epoch = fence.readFence().incidentEpoch;
    fence.activate({
      incidentId: "i2",
      policyRevision: 1,
      keyEpoch: 1,
      denyOperations: ["mint_grant"],
      admittedCompartmentRefs: ["c1"],
    });
    expect(fence.rejectStaleResolution(epoch)).toBe(true);
  });
});
