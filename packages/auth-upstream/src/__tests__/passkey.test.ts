import { describe, expect, it } from "vitest";
import { createPasskeySeam } from "../passkey.js";
import type { PasskeyAssertion } from "../passkey.js";

const assertion: PasskeyAssertion = {
  credentialId: "cred1",
  clientDataJSON: new Uint8Array([1]),
  authenticatorData: new Uint8Array([2]),
  signature: new Uint8Array([3]),
};

describe("passkey seam signature counter", () => {
  it("persists an advancing counter across assertions", async () => {
    let counter = 5;
    const seam = createPasskeySeam({
      verifyAssertion: async () => ({ ok: true, newCounter: counter }),
    });
    await seam.register("prn_1", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 4,
    });

    await expect(seam.verify(assertion)).resolves.toEqual({
      ok: true,
      principalId: "prn_1",
    });
    // Same counter again: the authenticator did not advance, so treat it as a
    // clone / replay rather than a fresh assertion.
    await expect(seam.verify(assertion)).resolves.toEqual({ ok: false });

    counter = 6;
    await expect(seam.verify(assertion)).resolves.toEqual({
      ok: true,
      principalId: "prn_1",
    });
  });

  it("rejects a counter that regresses below the stored value", async () => {
    const seam = createPasskeySeam({
      verifyAssertion: async () => ({ ok: true, newCounter: 2 }),
    });
    await seam.register("prn_2", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 10,
    });
    await expect(seam.verify(assertion)).resolves.toEqual({ ok: false });
  });

  it("still accepts authenticators that do not implement a counter", async () => {
    const seam = createPasskeySeam({
      verifyAssertion: async () => ({ ok: true, newCounter: 0 }),
    });
    await seam.register("prn_3", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 0,
    });
    await expect(seam.verify(assertion)).resolves.toEqual({
      ok: true,
      principalId: "prn_3",
    });
    await expect(seam.verify(assertion)).resolves.toEqual({
      ok: true,
      principalId: "prn_3",
    });
  });

  it("accepts a plain boolean verifier (dev/test injection)", async () => {
    const seam = createPasskeySeam({
      verifyAssertion: async (a) => a.signature.byteLength > 0,
    });
    await seam.register("prn_4", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 0,
    });
    await expect(seam.verify(assertion)).resolves.toEqual({
      ok: true,
      principalId: "prn_4",
    });
  });
});
