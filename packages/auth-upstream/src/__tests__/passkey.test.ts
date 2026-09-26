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
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    "refuses malformed counter %s",
    async (counter) => {
      const seam = createPasskeySeam({
        verifyAssertion: async () => ({ ok: true, newCounter: counter }),
      });
      await seam.register("prn_owner", {
        credentialId: "cred1",
        publicKey: new Uint8Array([9]),
        counter: 0,
      });
      expect(await seam.verify(assertion)).toEqual({ ok: false });
    },
  );
  it.each(["prn_owner", "prn_other"])(
    "refuses credential replacement by %s without changing the original",
    async (principalId) => {
      const seam = createPasskeySeam({
        verifyAssertion: async (_assertion, credential) => ({
          ok: credential.publicKey[0] === 9,
          newCounter: 5,
        }),
      });
      await seam.register("prn_owner", {
        credentialId: "cred1",
        publicKey: new Uint8Array([9]),
        counter: 4,
      });
      await expect(
        seam.register(principalId, {
          credentialId: "cred1",
          publicKey: new Uint8Array([8]),
          counter: 0,
        }),
      ).rejects.toThrow("Passkey credential already registered");
      await expect(seam.verify(assertion)).resolves.toEqual({
        ok: true,
        principalId: "prn_owner",
      });
      await expect(seam.verify(assertion)).resolves.toEqual({ ok: false });
    },
  );

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

  it("spends an advancing counter only once across concurrent verifications", async () => {
    const seam = createPasskeySeam({
      verifyAssertion: async () => ({ ok: true, newCounter: 5 }),
    });
    await seam.register("prn_owner", {
      credentialId: "cred1",
      publicKey: new Uint8Array([9]),
      counter: 4,
    });
    const results = await Promise.all([
      seam.verify(assertion),
      seam.verify(assertion),
    ]);
    expect(results).toEqual([
      { ok: true, principalId: "prn_owner" },
      { ok: false },
    ]);
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

  it("lists and removes only the principal's own credentials", async () => {
    const seam = createPasskeySeam({ verifyAssertion: async () => true });
    const key = { publicKey: new Uint8Array([9]), counter: 0 };
    await seam.register("prn_a", { credentialId: "a1", ...key });
    await seam.register("prn_b", { credentialId: "b1", ...key });

    const own = await seam.list("prn_a");
    expect(own.map((c) => c.credentialId)).toEqual(["a1"]);
    expect(own[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await expect(seam.remove("prn_a", "b1")).resolves.toBe(false);
    await expect(seam.remove("prn_a", "zz")).resolves.toBe(false);
    expect(await seam.list("prn_b")).toHaveLength(1);

    await expect(seam.remove("prn_a", "a1")).resolves.toBe(true);
    expect(await seam.list("prn_a")).toEqual([]);
    await expect(
      seam.verify({ ...assertion, credentialId: "a1" }),
    ).resolves.toEqual({ ok: false });
  });
});
