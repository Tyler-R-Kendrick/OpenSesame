import { describe, expect, it } from "vitest";
import {
  MAX_PIN_LENGTH,
  MIN_PIN_LENGTH,
  PIN_PBKDF2_ITERATIONS,
} from "../../vault/unlock-methods.js";
import {
  createIndependentCompartmentKey,
  openPrfAndCode,
  openProfileSlot,
  sealPrfAndCode,
  sealProfileSlot,
} from "../crypto/slots.js";
import {
  DURESS_PIN_MAX,
  DURESS_PIN_MIN,
  DURESS_PIN_PBKDF2_ITERATIONS,
  assertDuressCodeLength,
  assertDuressKdfIterations,
  assertIndependentIsolation,
  assertNoSilentBypass,
  canBootstrapActivationWithoutProtectedRoot,
  createIndependentNode,
  createSharedRootNode,
  inventoryWrappers,
  survivingAlternateWrappers,
} from "./index.js";

describe("duress PIN floors (KEYS-D)", () => {
  it("matches unlock-methods floors", () => {
    expect(DURESS_PIN_MIN).toBe(MIN_PIN_LENGTH);
    expect(DURESS_PIN_MAX).toBe(MAX_PIN_LENGTH);
    expect(DURESS_PIN_PBKDF2_ITERATIONS).toBe(PIN_PBKDF2_ITERATIONS);
    expect(DURESS_PIN_PBKDF2_ITERATIONS).toBe(1_200_000);
  });

  it("rejects short codes and cheap KDF metadata", () => {
    expect(() => assertDuressCodeLength("1234567")).toThrow(/code length/);
    expect(() => assertDuressKdfIterations(1000)).toThrow(/below PIN floor/);
    expect(() => assertDuressKdfIterations(10_000_001)).toThrow(/unbounded/);
  });
});

describe("compartment topology (KEYS-A/B)", () => {
  it("refuses shared-root isolation claims", () => {
    const indep = createIndependentNode({
      compartmentRef: "c-indep",
      keyEpoch: 1,
    });
    const shared = createSharedRootNode({
      compartmentRef: "c-shared",
      sharedRootRef: "root-1",
      keyEpoch: 1,
    });
    const topology = {
      vaultRef: "v1",
      nodes: [indep.node, shared],
    };
    expect(() => assertIndependentIsolation(topology, ["c-shared"])).toThrow(
      /independent_keys_required/,
    );
    assertIndependentIsolation(topology, ["c-indep"]);
    expect(
      canBootstrapActivationWithoutProtectedRoot(topology, ["c-indep"]),
    ).toBe(true);
    expect(
      canBootstrapActivationWithoutProtectedRoot(topology, ["c-shared"]),
    ).toBe(false);
  });
});

describe("wrapper inventory (KEYS-C)", () => {
  it("discloses surviving alternate wrappers", () => {
    const enrolled = ["password", "pin", "webauthn_prf"] as const;
    expect(inventoryWrappers([...enrolled])).toHaveLength(3);
    const warnings = survivingAlternateWrappers([...enrolled], {
      twoInputRequired: true,
      holdActive: false,
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(() =>
      assertNoSilentBypass([...enrolled], {
        twoInputRequired: true,
        holdActive: false,
      }),
    ).toThrow(/alternate_unlock_bypass/);
  });
});

describe("slot + prf-and-code crypto (KEYS-C/E)", () => {
  it("rejects wrong context and requires both PRF and code", async () => {
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
        presentation: "restricted",
      },
    });
    expect(
      await openProfileSlot("12345678", slot, {
        vaultRef: "other",
        deviceBindingRef: "d1",
        policyRevision: 1,
        keyEpoch: 1,
      }),
    ).toBeNull();
    expect(
      await openProfileSlot("87654321", slot, {
        vaultRef: "v1",
        deviceBindingRef: "d1",
        policyRevision: 1,
        keyEpoch: 1,
      }),
    ).toBeNull();

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
    const wrongPrf = crypto.getRandomValues(new Uint8Array(32));
    expect(
      await openPrfAndCode({
        prfOutput: wrongPrf,
        code: "87654321",
        envelope: env,
      }),
    ).toBeNull();
  });
});
