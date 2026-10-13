import { describe, expect, it } from "vitest";
import {
  formatCliAppHumanProof,
  isCliAppHumanProofValid,
  mintCliAppHumanProofFromPasskey,
} from "./human-proof.js";

describe("cli-app-integration human proof", () => {
  it("accepts only oschip1 pin or passkey digests", () => {
    expect(
      isCliAppHumanProofValid(
        formatCliAppHumanProof("passkey", "a".repeat(64)),
      ),
    ).toBe(true);
    expect(isCliAppHumanProofValid("pending-ui-human-proof-placeholder")).toBe(
      false,
    );
    expect(isCliAppHumanProofValid("human-proof-from-test-harness")).toBe(
      false,
    );
  });

  it("binds passkey probe material to the pending row", async () => {
    const probe = {
      credentialIdB64: "cred",
      prfOutput: new Uint8Array([1, 2, 3]).buffer,
    };
    const binding = {
      requestId: "clr_1",
      respondNonce: "nonce-a",
      terminalSessionId: "term-a",
    };
    const proof = await mintCliAppHumanProofFromPasskey(probe, binding);
    expect(proof).toMatch(/^oschip1:passkey:[0-9a-f]{64}$/);
    const again = await mintCliAppHumanProofFromPasskey(probe, binding);
    expect(proof).toBe(again);
  });
});
