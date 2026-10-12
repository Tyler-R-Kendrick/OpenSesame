/**
 * Becoming a guardian, holding a share, and wrapping it: consent that is
 * proved, shares that reopen, and an envelope that opens for exactly one
 * circle, guardian, key and epoch.
 */
import { describe, expect, it } from "vitest";
import { fromB64url, randomBytes, toB64url, utf8Bytes } from "./bytes.js";
import { deliveryAad } from "./circle.js";
import {
  EnrollmentError,
  acceptEnrollment,
  createInvite,
  enrollGuardian,
} from "./enroll.js";
import {
  GuardianError,
  acceptDelivery,
  parseHolding,
  verifyCustodyReceipt,
} from "./guardian.js";
import { sealBase } from "./hpke.js";
import { generateOwnerKeys, newCircleId } from "./index.js";
import { PolicyError } from "./policy.js";
import {
  KeyRing,
  ORIGIN,
  RP_ID,
  T0,
  buildWorld,
  person,
} from "./world.test-support.js";
import { WrapError, shareCommitment } from "./wrap.js";

const THREE = ["Ada", "Ben", "Cy"] as const;

function invite(owner = generateOwnerKeys()) {
  return {
    owner,
    invite: createInvite({
      circleId: newCircleId(),
      label: "Family",
      rpId: RP_ID,
      origins: [ORIGIN],
      ownerKey: owner.publicKey,
      requireUserVerification: true,
      now: T0,
    }),
  };
}

describe("enrollment is proved consent", () => {
  it("makes a guardian entry only from keys that answered, with a backup key counted as the same guardian", async () => {
    const { invite: inv } = invite();
    const ring = new KeyRing(2);
    const { enrollment } = await enrollGuardian({
      invite: inv,
      currentOrigin: ORIGIN,
      name: "Dee",
      keyLabels: ["Key", "Backup"],
      ceremony: ring.ceremony(),
    });
    const guardian = await acceptEnrollment({
      invite: inv,
      enrollment,
      custodyDomain: "dee-home",
      contactRef: null,
      now: T0,
    });
    expect(guardian.credentials.map((c) => c.label)).toEqual(["Key", "Backup"]);
    expect(guardian.credentials.every((c) => c.prf)).toBe(true);
    expect(new Set(guardian.credentials.map((c) => c.credentialId)).size).toBe(
      2,
    );
  });

  it("refuses to run at an origin the circle does not accept", async () => {
    const { invite: inv } = invite();
    await expect(
      enrollGuardian({
        invite: inv,
        currentOrigin: "https://attacker.example.test",
        name: "Dee",
        keyLabels: ["Key"],
        ceremony: new KeyRing(1).ceremony(),
      }),
    ).rejects.toMatchObject({ code: "origin" });
  });

  it("refuses an enrollment whose receiving key was swapped on the way", async () => {
    const { invite: inv } = invite();
    const { enrollment } = await enrollGuardian({
      invite: inv,
      currentOrigin: ORIGIN,
      name: "Dee",
      keyLabels: ["Key"],
      ceremony: new KeyRing(1).ceremony(),
    });
    const swapped = { ...enrollment, hpkePublicKey: toB64url(randomBytes(32)) };
    await expect(
      acceptEnrollment({
        invite: inv,
        enrollment: swapped,
        custodyDomain: "d",
        contactRef: null,
        now: T0,
      }),
    ).rejects.toMatchObject({ code: "challenge" });
  });

  it("refuses a key that never signed, an expired invite and another invite's answer", async () => {
    const { invite: inv } = invite();
    const ring = new KeyRing(1);
    const { enrollment } = await enrollGuardian({
      invite: inv,
      currentOrigin: ORIGIN,
      name: "Dee",
      keyLabels: ["Key"],
      ceremony: ring.ceremony(),
    });
    // A different physical key's proof, claimed for this credential.
    const other = await enrollGuardian({
      invite: inv,
      currentOrigin: ORIGIN,
      name: "Eve",
      keyLabels: ["Key"],
      ceremony: new KeyRing(1).ceremony(),
    });
    const stolenProof = {
      ...enrollment,
      credentials: enrollment.credentials.map((c, i) => ({
        ...c,
        proof: other.enrollment.credentials[i]?.proof ?? c.proof,
      })),
    };
    await expect(
      acceptEnrollment({
        invite: inv,
        enrollment: stolenProof,
        custodyDomain: "d",
        contactRef: null,
        now: T0,
      }),
    ).rejects.toBeInstanceOf(EnrollmentError);
    await expect(
      acceptEnrollment({
        invite: inv,
        enrollment,
        custodyDomain: "d",
        contactRef: null,
        now: new Date(T0.getTime() + 8 * 86400_000),
      }),
    ).rejects.toMatchObject({ code: "expired" });
    const { invite: another } = invite();
    await expect(
      acceptEnrollment({
        invite: another,
        enrollment,
        custodyDomain: "d",
        contactRef: null,
        now: T0,
      }),
    ).rejects.toMatchObject({ code: "invite" });
  });

  it("will not build a recovering circle from a guardian whose key has no PRF", async () => {
    const world = buildWorld({
      names: ["Ada", "Ben", "Cy"],
      keyOptions: { Cy: { prf: false } },
      groups: [{ id: "g", threshold: 2, members: THREE }],
      skipDelivery: true,
    });
    await expect(world).rejects.toBeInstanceOf(PolicyError);
    await expect(world).rejects.toMatchObject({ code: "no_prf" });
  });
});

describe("holding a share", () => {
  it("wraps it under every key presented and proves it reopens", async () => {
    const world = await buildWorld({
      names: THREE,
      keys: { Ben: 2 },
      groups: [{ id: "g", threshold: 2, members: THREE }],
    });
    const ben = person(world, "Ben");
    expect(ben.holding?.wrapped.envelopes).toHaveLength(2);
    expect(ben.receipt?.commitment).toBe(
      world.created.signedPolicy.policy.shareCommitments[ben.id],
    );
  });

  it("refuses a delivery meant for another guardian", async () => {
    const world = await buildWorld({
      names: THREE,
      groups: [{ id: "g", threshold: 2, members: THREE }],
      skipDelivery: true,
    });
    const ada = person(world, "Ada");
    const forBen = world.created.deliveries.find(
      (d) => d.guardianId === person(world, "Ben").id,
    );
    await expect(
      acceptDelivery({
        delivery: forBen,
        signedPolicy: world.created.signedPolicy,
        pinnedOwnerKey: world.owner.publicKey,
        guardianId: ada.id,
        hpkeSecretKey: ada.secrets.hpkeSecretKey,
        ceremony: ada.ceremony,
      }),
    ).rejects.toBeInstanceOf(GuardianError);
  });

  it("refuses a delivery whose share is not the one the owner's policy committed to", async () => {
    const world = await buildWorld({
      names: THREE,
      groups: [{ id: "g", threshold: 2, members: THREE }],
      skipDelivery: true,
    });
    const ada = person(world, "Ada");
    // Sealed to Ada's own receiving key, with the right context, but not her share.
    const sealed = sealBase({
      recipientPublicKey: fromB64url(ada.guardian.hpkePublicKey),
      info: utf8Bytes("opensesame:quorum-delivery:v1"),
      aad: deliveryAad(world.circleId, ada.id, 1),
      plaintext: utf8Bytes(Array(33).fill("academic").join(" ")),
    });
    const swapped = {
      v: 1,
      kind: "share-delivery",
      circleId: world.circleId,
      guardianId: ada.id,
      epoch: 1,
      enc: toB64url(sealed.enc),
      ciphertext: toB64url(sealed.ciphertext),
    };
    // The wrong share is refused before the guardian is asked to touch a key.
    let touches = 0;
    const counting = {
      register: ada.ceremony.register,
      assert: (input: Parameters<typeof ada.ceremony.assert>[0]) => {
        touches += 1;
        return ada.ceremony.assert(input);
      },
    };
    await expect(
      acceptDelivery({
        delivery: swapped,
        signedPolicy: world.created.signedPolicy,
        pinnedOwnerKey: world.owner.publicKey,
        guardianId: ada.id,
        hpkeSecretKey: ada.secrets.hpkeSecretKey,
        ceremony: counting,
      }),
    ).rejects.toMatchObject({ code: "commitment" });
    expect(touches).toBe(0);
  });

  it("refuses a policy signed by a key other than the one pinned at the invite", async () => {
    const world = await buildWorld({
      names: THREE,
      groups: [{ id: "g", threshold: 2, members: THREE }],
      skipDelivery: true,
    });
    const ada = person(world, "Ada");
    await expect(
      acceptDelivery({
        delivery: world.created.deliveries.find((d) => d.guardianId === ada.id),
        signedPolicy: world.created.signedPolicy,
        pinnedOwnerKey: generateOwnerKeys().publicKey,
        guardianId: ada.id,
        hpkeSecretKey: ada.secrets.hpkeSecretKey,
        ceremony: ada.ceremony,
      }),
    ).rejects.toMatchObject({ code: "owner_key_changed" });
  });

  it("finds out at hand-over, not in the emergency, that a key's PRF is unstable", async () => {
    const world = await buildWorld({
      names: THREE,
      groups: [{ id: "g", threshold: 2, members: THREE }],
      skipDelivery: true,
    });
    const ada = person(world, "Ada");
    const key = ada.ring.keys[0];
    if (key) key.unstablePrf = true;
    await expect(
      acceptDelivery({
        delivery: world.created.deliveries.find((d) => d.guardianId === ada.id),
        signedPolicy: world.created.signedPolicy,
        pinnedOwnerKey: world.owner.publicKey,
        guardianId: ada.id,
        hpkeSecretKey: ada.secrets.hpkeSecretKey,
        ceremony: ada.ceremony,
      }),
    ).rejects.toBeInstanceOf(WrapError);
  });

  it("gives the owner a receipt only a real reopening can produce", async () => {
    const world = await buildWorld({
      names: THREE,
      groups: [{ id: "g", threshold: 2, members: THREE }],
    });
    const ada = person(world, "Ada");
    const ben = person(world, "Ben");
    expect(ada.receipt).toBeDefined();
    // Ada's receipt, presented as Ben's, does not verify.
    await expect(
      verifyCustodyReceipt(world.created.signedPolicy, {
        ...ada.receipt,
        guardianId: ben.id,
      }),
    ).rejects.toBeInstanceOf(GuardianError);
    // Nor does one for a different commitment.
    await expect(
      verifyCustodyReceipt(world.created.signedPolicy, {
        ...ada.receipt,
        commitment: shareCommitment("x", "y", "z"),
      }),
    ).rejects.toBeInstanceOf(GuardianError);
  });

  it("reads a stored holding back only if its policy still verifies", async () => {
    const world = await buildWorld({
      names: THREE,
      groups: [{ id: "g", threshold: 2, members: THREE }],
    });
    const holding = person(world, "Ada").holding;
    expect(
      parseHolding(holding, world.owner.publicKey).wrapped.guardianId,
    ).toBe(person(world, "Ada").id);
    expect(() => parseHolding(holding, generateOwnerKeys().publicKey)).toThrow(
      PolicyError,
    );
    expect(() =>
      parseHolding(
        {
          ...holding,
          wrapped: {
            ...holding?.wrapped,
            policyDigest: `sha256:${"0".repeat(64)}`,
          },
        },
        world.owner.publicKey,
      ),
    ).toThrow(GuardianError);
  });
});
