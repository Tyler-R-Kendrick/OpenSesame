import { describe, expect, it } from "vitest";
import { assertContextAllows, issueAccessContext } from "./access/context.js";

describe("context operation checks", () => {
  it("enforces ceiling in restricted sessions", () => {
    const ctx = issueAccessContext({
      principalRef: "p1",
      tenantRef: null,
      vaultRef: "v1",
      compartmentRefs: ["c1"],
      deviceBindingRef: "d1",
      presentation: "restricted",
      authorizationCeiling: ["read_item"],
      denyOperations: [],
      policyRevision: 1,
      incidentEpoch: 2,
      keyEpoch: 3,
      sessionGeneration: 4,
      profileId: "p",
      evidenceDigest: "digestdigestdigest1",
    });
    expect(() =>
      assertContextAllows(ctx, "export_root", {
        policyRevision: 1,
        incidentEpoch: 2,
        keyEpoch: 3,
        sessionGeneration: 4,
      }),
    ).toThrow(/ceiling/);
  });
});
