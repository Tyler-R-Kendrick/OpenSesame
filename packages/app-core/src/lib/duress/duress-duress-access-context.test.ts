import { describe, expect, it } from "vitest";
import {
  intersectCompartments,
  isAccessContext,
  issueAccessContext,
  publicAccessMetadata,
} from "./access/context.js";
import { overlapCast } from "./json-boundary.js";

describe("duress access context", () => {
  it("rejects forged JSON copies (AT-032)", () => {
    const ctx = issueAccessContext({
      principalRef: "p1",
      tenantRef: null,
      vaultRef: "v1",
      compartmentRefs: ["c1"],
      deviceBindingRef: "d1",
      presentation: "restricted",
      authorizationCeiling: ["read_item"],
      denyOperations: ["export_root"],
      policyRevision: 1,
      incidentEpoch: 1,
      keyEpoch: 1,
      sessionGeneration: 1,
      profileId: "prof",
      evidenceDigest: "abc123abc123abc1",
    });
    expect(isAccessContext(ctx)).toBe(true);
    const copy = { ...publicAccessMetadata(ctx), claims: ctx.claims };
    expect(
      isAccessContext(
        overlapCast<import("./access/context.js").AccessContextProbe>(copy),
      ),
    ).toBe(false);
  });

  it("intersects compartments across incidents (AT-039)", () => {
    expect(
      intersectCompartments([
        ["a", "b"],
        ["b", "c"],
      ]),
    ).toEqual(["b"]);
  });
});
