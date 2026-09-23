import { describe, expect, it } from "vitest";
import { assessWorkerRootKeyIsolation } from "./wallet-isolation-claims.js";

describe("assessWorkerRootKeyIsolation (WAL-B07)", () => {
  it("does not claim an independent origin boundary for same-origin Workers", () => {
    const claim = assessWorkerRootKeyIsolation();
    expect(claim.mechanism).toBe("same_origin_worker");
    expect(claim.claimsIndependentOriginBoundary).toBe(false);
    expect(claim.claimsRootKeyIsolation).toBe(false);
  });
});
