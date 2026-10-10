/**
 * Changing a circle (ADR 0186 §9): a new epoch refreshes every share, can
 * replace a guardian, and never lets a guardian go back. The tests pin what a
 * new epoch does and, as plainly, what it does not.
 */
import { describe, expect, it } from "vitest";
import { buildApproval, seatOf } from "./approve.js";
import { generateOwnerKeys, openBundle } from "./circle.js";
import { applyEpoch, reissueCircle } from "./epoch.js";
import {
  DAY_MS,
  draftAfter,
  enrollNewcomer,
  nextEpoch,
} from "./epoch.test-support.js";
import { acceptDelivery } from "./guardian.js";
import { PolicyError, signPolicy } from "./policy.js";
import { approve, clockAt, raise, release } from "./protocol.test-support.js";
import { completeRecovery } from "./recover.js";
import { combineMnemonics } from "./slip39/index.js";
import { EpochError, checkSuccession } from "./succession.js";
import {
  PAYLOAD,
  T0,
  buildWorld,
  holdingOf,
  person,
} from "./world.test-support.js";
import { prfInput, unwrapShare } from "./wrap.js";

const THREE = ["Ada", "Ben", "Cy"] as const;

const twoOfThree = () =>
  buildWorld({
    names: THREE,
    groups: [{ id: "all", threshold: 2, members: THREE }],
  });

/** A guardian's share as text, taken out of their wrapped holding with their key. */
async function mnemonicOf(
  world: Awaited<ReturnType<typeof twoOfThree>>,
  name: string,
) {
  const who = person(world, name);
  const holding = holdingOf(who);
  const policy = holding.signedPolicy.policy;
  const asserted = await who.ceremony.assert({
    rpId: policy.rpId,
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    allowCredentialIds: holding.wrapped.envelopes.map((e) => e.credentialId),
    requireUserVerification: true,
    prfInput: prfInput(policy.circleId, who.id),
  });
  const envelope = holding.wrapped.envelopes.find(
    (e) => e.credentialId === asserted.credentialId,
  );
  if (!envelope || !asserted.prfOutput) throw new Error("no share");
  return unwrapShare(
    envelope,
    {
      circleId: policy.circleId,
      guardianId: who.id,
      credentialId: asserted.credentialId,
      epoch: policy.epoch,
    },
    asserted.prfOutput,
  );
}

describe("refreshing the shares", () => {
  it("makes epoch 2 name the epoch it replaces, deals every guardian a new share and keeps the roster", async () => {
    const world = await twoOfThree();
    const { world: next, reissued } = await nextEpoch(world);
    const was = world.created.signedPolicy;
    const now = reissued.signedPolicy.policy;
    expect(now.epoch).toBe(2);
    expect(now.supersedes).toEqual({ epoch: 1, digest: was.digest });
    expect([...reissued.kept].sort()).toEqual(["g-ada", "g-ben", "g-cy"]);
    expect(reissued.retired).toEqual([]);
    expect(reissued.joined).toEqual([]);
    expect(reissued.deliveries).toHaveLength(3);
    for (const who of next.people.values()) {
      expect(who.holding?.wrapped.epoch).toBe(2);
      expect(who.holding?.signedPolicy.digest).toBe(
        reissued.signedPolicy.digest,
      );
    }
    // Every commitment is new: the shares are, too.
    for (const id of ["g-ada", "g-ben", "g-cy"]) {
      expect(now.shareCommitments[id]).not.toBe(
        was.policy.shareCommitments[id],
      );
    }
  });

  it("recovers at epoch 2 with the ordinary ceremony", async () => {
    const world = await twoOfThree();
    const { world: next } = await nextEpoch(world);
    const clock = clockAt(DAY_MS / 1000);
    const r = await raise(next, clock);
    for (const name of ["Ada", "Cy"]) {
      expect((await approve(next, name, r)).outcome).toEqual({ ok: true });
    }
    clock.advanceTo(DAY_MS / 1000 + 3601);
    for (const name of ["Ada", "Cy"]) {
      expect((await release(next, name, r)).outcome).toEqual({ ok: true });
    }
    expect(
      await completeRecovery({
        ledger: r.ledger,
        recipientSecretKey: r.pending.recipient.secretKey,
        bundle: next.created.bundle,
      }),
    ).toEqual(PAYLOAD);
  });

  it("makes old shares useless against the new bundle, alone or mixed with new ones", async () => {
    const world = await twoOfThree();
    const oldShares = [
      await mnemonicOf(world, "Ada"),
      await mnemonicOf(world, "Ben"),
    ];
    const { world: next } = await nextEpoch(world);
    const newShares = [
      await mnemonicOf(next, "Ada"),
      await mnemonicOf(next, "Ben"),
    ];
    const oldSecret = await combineMnemonics(oldShares);
    expect(() => openBundle(next.created.bundle, oldSecret)).toThrow(
      /does not open/,
    );
    // A share of each epoch does not even recombine.
    await expect(
      combineMnemonics([oldShares[0] ?? "", newShares[1] ?? ""]),
    ).rejects.toThrow();
    // The new shares open the new bundle.
    const newSecret = await combineMnemonics(newShares);
    expect(openBundle(next.created.bundle, newSecret)).toEqual(PAYLOAD);
  });

  it("does not take back the old bundle: old shares still open it (the stated limit)", async () => {
    const world = await twoOfThree();
    const oldShares = [
      await mnemonicOf(world, "Ada"),
      await mnemonicOf(world, "Cy"),
    ];
    await nextEpoch(world);
    const secret = await combineMnemonics(oldShares);
    expect(openBundle(world.created.bundle, secret)).toEqual(PAYLOAD);
  });
});

describe("replacing a guardian", () => {
  it("retires the one who left, deals the newcomer a share, and recovers without the old guardian", async () => {
    const world = await twoOfThree();
    const dee = await enrollNewcomer(world, "Dee");
    const { world: next, reissued } = await nextEpoch(world, {
      drop: ["Cy"],
      add: [dee],
    });
    expect(reissued.retired).toEqual(["g-cy"]);
    expect(reissued.joined).toEqual(["g-dee"]);
    expect([...reissued.kept].sort()).toEqual(["g-ada", "g-ben"]);
    expect(reissued.deliveries.map((d) => d.guardianId).sort()).toEqual([
      "g-ada",
      "g-ben",
      "g-dee",
    ]);
    expect(next.people.has("Cy")).toBe(false);

    const clock = clockAt(DAY_MS / 1000);
    const r = await raise(next, clock);
    for (const name of ["Ada", "Dee"]) {
      expect((await approve(next, name, r)).outcome).toEqual({ ok: true });
    }
    clock.advanceTo(DAY_MS / 1000 + 3601);
    for (const name of ["Ada", "Dee"]) {
      expect((await release(next, name, r)).outcome).toEqual({ ok: true });
    }
    expect(
      await completeRecovery({
        ledger: r.ledger,
        recipientSecretKey: r.pending.recipient.secretKey,
        bundle: next.created.bundle,
      }),
    ).toEqual(PAYLOAD);
  });

  it("tells the retired guardian to drop their share, and the stayers to wait for a new one", async () => {
    const world = await twoOfThree();
    const dee = await enrollNewcomer(world, "Dee");
    const { reissued } = await nextEpoch(world, { drop: ["Cy"], add: [dee] });
    const pinned = world.owner.publicKey;
    const offered = reissued.signedPolicy;
    expect(
      applyEpoch({
        seat: seatOf(holdingOf(person(world, "Cy"))),
        offered,
        pinnedOwnerKey: pinned,
      }),
    ).toEqual({ state: "retired" });
    expect(
      applyEpoch({
        seat: seatOf(holdingOf(person(world, "Ada"))),
        offered,
        pinnedOwnerKey: pinned,
      }),
    ).toEqual({ state: "awaiting_share", signedPolicy: offered });
  });

  it("leaves the retired guardian unable to take part in the new epoch", async () => {
    const world = await twoOfThree();
    const dee = await enrollNewcomer(world, "Dee");
    const { world: next } = await nextEpoch(world, {
      drop: ["Cy"],
      add: [dee],
    });
    const clock = clockAt(DAY_MS / 1000);
    const r = await raise(next, clock);
    const cy = person(world, "Cy");
    // Cy still holds epoch 1: a request for epoch 2 is not one their device will sign.
    await expect(
      buildApproval({
        seat: seatOf(holdingOf(cy)),
        request: r.pending.request,
        ceremony: cy.ceremony,
        now: clock.date(),
      }),
    ).rejects.toThrow();
    // And the epoch-2 ledger has never heard of them.
    expect(
      await r.ledger.submitApproval({
        v: 1,
        kind: "approval",
        requestDigest: r.ledger.digest,
        guardianId: "g-cy",
        credentialId: cy.guardian.credentials[0]?.credentialId ?? "",
        assertion: {
          clientDataJSON: "AA",
          authenticatorData: "AA",
          signature: "AA",
        },
      }),
    ).toMatchObject({ ok: false, code: "unknown_credential" });
  });
});

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
