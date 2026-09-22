import { describe, expect, it } from "vitest";
import { defined } from "../defined.js";
import { overlapCast } from "../json-boundary.js";
import { DuressKdfError } from "../keys/pin-floors.js";
import {
  type SealedSlot,
  createIndependentCompartmentKey,
  openPrfAndCode,
  openProfileSlot,
  sealPrfAndCode,
  sealPrfAndCodeWithDisclosure,
  sealProfileSlot,
} from "./slots.js";

const expectCtx = {
  vaultRef: "v1",
  deviceBindingRef: "d1",
  policyRevision: 1,
  keyEpoch: 1,
} as const;

describe("KEYS-B/E profile slots", () => {
  it("round-trips with domain binding", async () => {
    const key = createIndependentCompartmentKey();
    const slot = await sealProfileSlot({
      code: "12345678",
      slotId: "s1",
      profileId: "p1",
      ...expectCtx,
      plaintext: {
        compartmentKey: key,
        actionCapability: new Uint8Array([9, 8, 7]),
        presentation: "restricted",
      },
    });
    const opened = await openProfileSlot("12345678", slot, expectCtx);
    expect(opened?.presentation).toBe("restricted");
    const openedSlot = defined(opened, "opened");
    expect([...openedSlot.compartmentKey]).toEqual([...key]);
    expect([...defined(openedSlot.actionCapability, "cap")]).toEqual([9, 8, 7]);
  });

  it("rejects wrong code, context, and version (KEYS-E)", async () => {
    const key = createIndependentCompartmentKey();
    const slot = await sealProfileSlot({
      code: "12345678",
      slotId: "s1",
      profileId: "p1",
      ...expectCtx,
      plaintext: {
        compartmentKey: key,
        actionCapability: null,
        presentation: "decoy",
      },
    });
    expect(await openProfileSlot("87654321", slot, expectCtx)).toBeNull();
    expect(
      await openProfileSlot("12345678", slot, {
        ...expectCtx,
        vaultRef: "other",
      }),
    ).toBeNull();
    expect(
      await openProfileSlot("12345678", slot, {
        ...expectCtx,
        keyEpoch: 99,
      }),
    ).toBeNull();
    const mutated = { ...slot, version: 2 };
    const badVersion = overlapCast<typeof mutated, SealedSlot>(mutated);
    expect(await openProfileSlot("12345678", badVersion, expectCtx)).toBeNull();
  });

  it("rejects malicious KDF metadata without treating as wrong code", async () => {
    const slot: SealedSlot = {
      version: 1,
      slotId: "s1",
      profileId: "p1",
      vaultRef: "v1",
      deviceBindingRef: "d1",
      policyRevision: 1,
      keyEpoch: 1,
      saltB64: btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
      ),
      ivB64: btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(12))),
      ),
      ciphertextB64: btoa("not-real-ciphertext"),
      iterations: 1000,
    };
    await expect(openProfileSlot("12345678", slot, expectCtx)).rejects.toThrow(
      DuressKdfError,
    );
  });

  it("rejects seal with below-floor iterations", async () => {
    const key = createIndependentCompartmentKey();
    await expect(
      sealProfileSlot({
        code: "12345678",
        slotId: "s1",
        profileId: "p1",
        ...expectCtx,
        iterations: 600_000,
        plaintext: {
          compartmentKey: key,
          actionCapability: null,
          presentation: "decoy",
        },
      }),
    ).rejects.toThrow(DuressKdfError);
  });
});

describe("KEYS-C PRF-and-code envelopes", () => {
  it("requires both PRF and code; discloses alternate wrappers", async () => {
    const key = createIndependentCompartmentKey();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const sealed = await sealPrfAndCodeWithDisclosure({
      prfOutput: prf,
      code: "87654321",
      compartmentKey: key,
      profileId: "p1",
      vaultRef: "v1",
      policyRevision: 1,
      keyEpoch: 1,
      enrolledWrappers: ["password", "age"],
    });
    expect(sealed.survivingAlternateWrappers.length).toBe(2);

    const env = sealed.envelope;
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
    expect(
      await openPrfAndCode({
        prfOutput: crypto.getRandomValues(new Uint8Array(32)),
        code: "87654321",
        envelope: env,
      }),
    ).toBeNull();
    expect(
      await openPrfAndCode({
        prfOutput: prf,
        code: "12345678",
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

  it("rejects malformed envelopes and short PRF", async () => {
    const key = createIndependentCompartmentKey();
    await expect(
      sealPrfAndCode({
        prfOutput: new Uint8Array(16),
        code: "87654321",
        compartmentKey: key,
        profileId: "p1",
        vaultRef: "v1",
        policyRevision: 1,
        keyEpoch: 1,
      }),
    ).rejects.toThrow(/PRF output too short/);

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
    const mangled = { ...env, outerCtB64: btoa("xxxx") };
    expect(
      await openPrfAndCode({
        prfOutput: prf,
        code: "87654321",
        envelope: mangled,
      }),
    ).toBeNull();
    await expect(
      openPrfAndCode({
        prfOutput: prf,
        code: "87654321",
        envelope: { ...env, iterations: 10 },
      }),
    ).rejects.toThrow(DuressKdfError);
  });
});
