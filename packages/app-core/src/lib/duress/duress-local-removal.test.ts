import { describe, expect, it } from "vitest";
import {
  assertOwnedPath,
  executeLocalRemoval,
  isUnsupportedDestructiveAction,
} from "./removal/local-remove.js";

describe("local removal", () => {
  it("rejects traversal and unsupported wipes (AT-076/090)", async () => {
    expect(() => assertOwnedPath("vaults/v1/../etc/passwd", "v1")).toThrow();
    expect(isUnsupportedDestructiveAction("device_brick")).toBe(true);
    const receipt = await executeLocalRemoval(
      {
        version: 1,
        incidentId: "i1",
        vaultRef: "v1",
        deviceBindingRef: "d1",
        resources: [
          {
            ref: "c1",
            kind: "compartment_tomb",
            storagePath: "vaults/v1/compartments/c1",
          },
        ],
        preserveSealedOutbox: true,
        acceptUnrecoverability: false,
      },
      {
        async delete() {
          return true;
        },
        async exists() {
          return false;
        },
      },
      { retireDevice: true },
    );
    expect(receipt.assurance).toBe("application_scoped_removal");
    expect(receipt.deviceRetired).toBe(true);
  });
});
