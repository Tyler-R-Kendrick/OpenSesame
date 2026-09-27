import { describe, expect, it } from "vitest";
import { createIndependentCompartmentKey } from "./crypto/slots.js";
import {
  createEmptyEnrollmentState,
  enrollTrigger,
  selectTrigger,
} from "./trigger/enrollment.js";

describe("trigger enrollment", () => {
  it("selects exactly one profile and preserves leading zeros", async () => {
    let state = createEmptyEnrollmentState({
      vaultRef: "v1",
      deviceBindingRef: "d1",
      policyRevision: 1,
      keyEpoch: 1,
    });
    state = { ...state, ownerConsent: true, rehearsalPassed: true };
    const key = createIndependentCompartmentKey();
    state = await enrollTrigger({
      state,
      code: "01234567",
      profileId: "decoy",
      triggerKind: "application_code",
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "decoy",
      },
    });
    const miss = await selectTrigger("1234567", state);
    expect(miss.status).toBe("none");
    const hit = await selectTrigger("01234567", state);
    expect(hit.status).toBe("matched");
    if (hit.status === "matched") expect(hit.profileId).toBe("decoy");
  });
});
