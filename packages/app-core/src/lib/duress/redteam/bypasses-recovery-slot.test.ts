/**
 * REDTEAM-B: Bypass attempts against live duress modules.
 * Failures are intentional findings — do not force-pass.
 */

import { defined } from "@opensesame/contracts";
import { describe, expect, it } from "vitest";
import {
  createIndependentCompartmentKey,
  openProfileSlot,
  sealProfileSlot,
} from "../crypto/slots.js";
import {
  combineRecoveryShares,
  roleAllows,
  splitRecoverySecret,
} from "../recovery/custody.js";

describe("REDTEAM-B bypass: recovery role / share mutation", () => {
  it("alert recipient cannot release shares; MAC rejects tampered share", async () => {
    expect(
      roleAllows(
        {
          principalRef: "a",
          role: "alert_recipient",
          custodyDomain: "phone",
          scopeRef: "c1",
          generation: 1,
        },
        "release_share",
      ),
    ).toBe(false);

    const secret = crypto.getRandomValues(new Uint8Array(16));
    const macKey = crypto.getRandomValues(new Uint8Array(32));
    const shares = await splitRecoverySecret({
      secret,
      threshold: 2,
      total: 3,
      generation: 1,
      vaultRef: "v1",
      compartmentRef: "c1",
      policyRevision: 1,
      keyEpoch: 1,
      macKey,
    });
    const tampered = {
      ...defined(shares[0], "share0"),
      shareB64: btoa("tampered-share-bytes!!"),
    };
    await expect(
      combineRecoveryShares({
        shares: [tampered, defined(shares[1], "share1")],
        macKey,
        expect: {
          generation: 1,
          vaultRef: "v1",
          compartmentRef: "c1",
          policyRevision: 1,
          keyEpoch: 1,
          threshold: 2,
        },
      }),
    ).rejects.toThrow(/tampered/);
  });

  it("stale policyRevision on share combine fails closed", async () => {
    const secret = crypto.getRandomValues(new Uint8Array(8));
    const macKey = crypto.getRandomValues(new Uint8Array(32));
    const shares = await splitRecoverySecret({
      secret,
      threshold: 2,
      total: 2,
      generation: 1,
      vaultRef: "v1",
      compartmentRef: "c1",
      policyRevision: 1,
      keyEpoch: 1,
      macKey,
    });
    await expect(
      combineRecoveryShares({
        shares,
        macKey,
        expect: {
          generation: 1,
          vaultRef: "v1",
          compartmentRef: "c1",
          policyRevision: 99,
          keyEpoch: 1,
          threshold: 2,
        },
      }),
    ).rejects.toThrow(/stale_policy/);
  });
});

describe("REDTEAM-B bypass: slot binding / cross-vault open", () => {
  it("wrong vault or epoch cannot open slot", async () => {
    const key = createIndependentCompartmentKey();
    const slot = await sealProfileSlot({
      code: "55667788",
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
    expect(
      await openProfileSlot("55667788", slot, {
        vaultRef: "other",
        deviceBindingRef: "d1",
        policyRevision: 1,
        keyEpoch: 1,
      }),
    ).toBeNull();
    expect(
      await openProfileSlot("55667788", slot, {
        vaultRef: "v1",
        deviceBindingRef: "d1",
        policyRevision: 1,
        keyEpoch: 2,
      }),
    ).toBeNull();
  });
});
