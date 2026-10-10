/**
 * The guards around a new epoch (ADR 0186 §9): a guardian never goes back, a
 * chain of policies must link, the owner may not change what guardians' keys
 * are registered against, and an action-only circle changes epoch without shares.
 */
import { describe, expect, it } from "vitest";
import { generateOwnerKeys } from "./circle.js";
import { applyEpoch, reissueCircle } from "./epoch.js";
import {
  DAY_MS,
  THREE,
  draftAfter,
  nextEpoch,
  twoOfThree,
} from "./epoch.test-support.js";
import { acceptDelivery } from "./guardian.js";
import { PolicyError, signPolicy } from "./policy.js";
import { EpochError, checkSuccession } from "./succession.js";
import { T0, buildWorld, holdingOf, person } from "./world.test-support.js";

describe("a guardian never goes back", () => {
  it("refuses an older delivery before any key is touched", async () => {
    const world = await twoOfThree();
    const { world: next } = await nextEpoch(world);
    const ada = person(next, "Ada");
    const oldDelivery = world.created.deliveries.find(
      (d) => d.guardianId === ada.id,
    );
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
        delivery: oldDelivery,
        signedPolicy: world.created.signedPolicy,
        pinnedOwnerKey: world.owner.publicKey,
        guardianId: ada.id,
        hpkeSecretKey: ada.secrets.hpkeSecretKey,
        ceremony: counting,
        replaces: holdingOf(ada).signedPolicy,
      }),
    ).rejects.toMatchObject({ code: "rollback" });
    expect(touches).toBe(0);
  });

  it("refuses the same epoch again, and another circle's policy", async () => {
    const world = await twoOfThree();
    const held = world.created.signedPolicy;
    const pinned = world.owner.publicKey;
    expect(() => checkSuccession(held, held, pinned)).toThrow(EpochError);
    expect(() => checkSuccession(held, held, pinned)).toThrow(/not newer/);
    // Another owner's policy is not the owner's at all.
    const other = await twoOfThree();
    expect(() =>
      checkSuccession(held, other.created.signedPolicy, pinned),
    ).toThrow(PolicyError);
    // The same owner's policy for a different circle is not this circle's.
    const sibling = signPolicy(
      {
        ...held.policy,
        circleId: "another-circle",
        epoch: 2,
        supersedes: { epoch: 1, digest: held.digest },
        createdAt: new Date(T0.getTime() + DAY_MS).toISOString(),
      },
      world.owner.secretKey,
    );
    expect(() => checkSuccession(held, sibling, pinned)).toThrow(
      /another circle/,
    );
  });

  it("refuses a successor that does not name the policy held", async () => {
    const world = await twoOfThree();
    const held = world.created.signedPolicy;
    const forged = signPolicy(
      {
        ...held.policy,
        epoch: 2,
        supersedes: { epoch: 1, digest: `sha256:${"0".repeat(64)}` },
        createdAt: new Date(T0.getTime() + DAY_MS).toISOString(),
      },
      world.owner.secretKey,
    );
    expect(() => checkSuccession(held, forged, world.owner.publicKey)).toThrow(
      /does not replace/,
    );
  });

  it("accepts a later epoch the guardian was away for, on the owner's signature alone", async () => {
    const world = await twoOfThree();
    const { world: two } = await nextEpoch(world);
    const { world: three } = await nextEpoch(two, {
      now: new Date(T0.getTime() + 2 * DAY_MS),
    });
    const held = world.created.signedPolicy;
    expect(
      checkSuccession(held, three.created.signedPolicy, world.owner.publicKey)
        .policy.epoch,
    ).toBe(3);
    // And the one who took epoch 3 cannot be handed epoch 2.
    expect(() =>
      checkSuccession(
        three.created.signedPolicy,
        two.created.signedPolicy,
        world.owner.publicKey,
      ),
    ).toThrow(/not newer/);
  });

  it("will not let the RP ID of a circle change under its guardians' keys", async () => {
    const world = await twoOfThree();
    const held = world.created.signedPolicy;
    const moved = signPolicy(
      {
        ...held.policy,
        epoch: 2,
        supersedes: { epoch: 1, digest: held.digest },
        rpId: "elsewhere.example.test",
        origins: ["https://elsewhere.example.test"],
        createdAt: new Date(T0.getTime() + DAY_MS).toISOString(),
      },
      world.owner.secretKey,
    );
    expect(() => checkSuccession(held, moved, world.owner.publicKey)).toThrow(
      /RP ID/,
    );
  });
});

describe("what a policy chain requires", () => {
  it("lets epoch 1 replace nothing and requires epoch 2 to name epoch 1", async () => {
    const world = await twoOfThree();
    const { policy } = world.created.signedPolicy;
    expect(() =>
      signPolicy(
        {
          ...policy,
          supersedes: { epoch: 1, digest: `sha256:${"1".repeat(64)}` },
        },
        world.owner.secretKey,
      ),
    ).toThrow(PolicyError);
    expect(() =>
      signPolicy({ ...policy, epoch: 2 }, world.owner.secretKey),
    ).toThrow(/must name the epoch before/);
    expect(() =>
      signPolicy(
        {
          ...policy,
          epoch: 3,
          supersedes: { epoch: 1, digest: `sha256:${"1".repeat(64)}` },
        },
        world.owner.secretKey,
      ),
    ).toThrow(/must name the epoch before/);
  });
});

describe("what the owner may not do in a new epoch", () => {
  it("refuses another owner's key, another circle, another RP ID and a clock that runs backwards", async () => {
    const world = await twoOfThree();
    const draft = draftAfter(world, {});
    const base = {
      previous: world.created.signedPolicy,
      owner: world.owner,
      draft,
      payload: world.payload,
      now: new Date(T0.getTime() + DAY_MS),
    };
    await expect(
      reissueCircle({ ...base, draft: { ...draft, circleId: "another" } }),
    ).rejects.toMatchObject({ code: "circle" });
    // Origins move with the RP ID, so only the circle's own rule can refuse it.
    await expect(
      reissueCircle({
        ...base,
        draft: {
          ...draft,
          rpId: "x.example.test",
          origins: ["https://x.example.test"],
        },
      }),
    ).rejects.toBeInstanceOf(EpochError);
    await expect(
      reissueCircle({ ...base, now: new Date(T0.getTime() - DAY_MS) }),
    ).rejects.toMatchObject({ code: "clock" });
    await expect(
      reissueCircle({ ...base, owner: generateOwnerKeys() }),
    ).rejects.toBeInstanceOf(PolicyError);
  });

  it("refuses to change a staying guardian's receiving key, and a recovering epoch without its payload", async () => {
    const world = await twoOfThree();
    const draft = draftAfter(world, {});
    const first = draft.guardians[0];
    if (!first) throw new Error("no guardian");
    const swapped = {
      ...draft,
      guardians: [
        {
          ...first,
          hpkePublicKey: person(world, "Ben").guardian.hpkePublicKey,
        },
        ...draft.guardians.slice(1),
      ],
    };
    const base = {
      previous: world.created.signedPolicy,
      owner: world.owner,
      now: new Date(T0.getTime() + DAY_MS),
    };
    await expect(
      reissueCircle({ ...base, draft: swapped, payload: world.payload }),
    ).rejects.toMatchObject({ code: "guardian_changed" });
    await expect(reissueCircle({ ...base, draft })).rejects.toThrow(
      /needs a payload/,
    );
  });
});

describe("an action-only circle changes epoch without shares", () => {
  it("is adopted by a guardian on the owner's signature, and old requests are no longer theirs to sign", async () => {
    const world = await buildWorld({
      names: THREE,
      groups: [{ id: "all", threshold: 2, members: THREE }],
      operations: ["grant-access"],
    });
    expect(world.created.bundle).toBeNull();
    const { reissued } = await nextEpoch(world);
    expect(reissued.bundle).toBeNull();
    expect(reissued.deliveries).toEqual([]);
    const ada = person(world, "Ada");
    const outcome = applyEpoch({
      seat: { signedPolicy: world.created.signedPolicy, guardianId: ada.id },
      offered: reissued.signedPolicy,
      pinnedOwnerKey: world.owner.publicKey,
    });
    expect(outcome.state).toBe("adopted");
    if (outcome.state !== "adopted") return;
    expect(outcome.seat.signedPolicy.policy.epoch).toBe(2);
  });
});
