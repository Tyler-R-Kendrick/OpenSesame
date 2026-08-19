import { describe, expect, it } from "vitest";
import { createPasskeySeam } from "../passkey.js";
import type { PasskeyAssertion } from "../passkey.js";

const assertion: PasskeyAssertion = {
  credentialId: "cred1",
  clientDataJSON: new Uint8Array([1]),
  authenticatorData: new Uint8Array([2]),
  signature: new Uint8Array([3]),
};

describe("passkey seam without an injected verifier", () => {
  it("fails closed: verify throws instead of accepting anything", async () => {
    const seam = createPasskeySeam();
    await seam.register("prn_1", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 0,
    });
    await expect(seam.verify(assertion)).rejects.toThrow(
      "Passkey verify not configured",
    );
  });

  it("returns ok:false for an unknown credential id", async () => {
    const seam = createPasskeySeam();
    await expect(seam.verify(assertion)).resolves.toEqual({ ok: false });
  });

  it("returns ok:false when the injected verifier rejects", async () => {
    const seam = createPasskeySeam({
      verifyAssertion: async () => false,
    });
    await seam.register("prn_1", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 0,
    });
    await expect(seam.verify(assertion)).resolves.toEqual({ ok: false });
  });

  it("accepts a result object without a new counter (no clone signal)", async () => {
    const seam = createPasskeySeam({
      verifyAssertion: async () => ({ ok: true }),
    });
    await seam.register("prn_1", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 7,
    });
    await expect(seam.verify(assertion)).resolves.toEqual({
      ok: true,
      principalId: "prn_1",
    });
    // Counter is untouched, so a repeat assertion still verifies.
    await expect(seam.verify(assertion)).resolves.toEqual({
      ok: true,
      principalId: "prn_1",
    });
  });

  it("treats a result object with ok:false as a rejection", async () => {
    const seam = createPasskeySeam({
      verifyAssertion: async () => ({ ok: false, newCounter: 99 }),
    });
    await seam.register("prn_1", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 0,
    });
    await expect(seam.verify(assertion)).resolves.toEqual({ ok: false });
  });
});
