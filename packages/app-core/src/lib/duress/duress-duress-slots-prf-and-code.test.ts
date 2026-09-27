import { defined } from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import {
  createIndependentCompartmentKey,
  openPrfAndCode,
  openProfileSlot,
  sealPrfAndCode,
  sealProfileSlot,
} from "./crypto/slots.js";

describe("duress slots + prf-and-code", () => {
  it("round-trips code slot and requires both PRF and code (AT-020..022)", async () => {
    const key = createIndependentCompartmentKey();
    const slot = await sealProfileSlot({
      code: "12345678",
      slotId: "s1",
      profileId: "p1",
      vaultRef: "v1",
      deviceBindingRef: "d1",
      policyRevision: 1,
      keyEpoch: 1,
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "decoy",
      },
    });
    const opened = await openProfileSlot("12345678", slot, {
      vaultRef: "v1",
      deviceBindingRef: "d1",
      policyRevision: 1,
      keyEpoch: 1,
    });
    expect(opened?.presentation).toBe("decoy");

    const prf = crypto.getRandomValues(new Uint8Array(32));
    const env = await sealPrfAndCode({
      prfOutput: prf,
      code: "87654321",
      compartmentKey: key,
      profileId: "p1",
      vaultRef: "v1",
      policyRevision: 1,
      keyEpoch: 1,
    });
    expect(
      await openPrfAndCode({ prfOutput: prf, code: null, envelope: env }),
    ).toBeNull();
    expect(
      await openPrfAndCode({
        prfOutput: null,
        code: "87654321",
        envelope: env,
      }),
    ).toBeNull();
    const both = await openPrfAndCode({
      prfOutput: prf,
      code: "87654321",
      envelope: env,
    });
    expect(both).not.toBeNull();
    expect([...defined(both, "both")]).toEqual([...key]);
  });
});
