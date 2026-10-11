/**
 * Changing a circle (ADR 0187 §9): a new epoch refreshes every share, can
 * replace a guardian, and never lets a guardian go back. The tests pin what a
 * new epoch does and, as plainly, what it does not.
 */
import { describe, expect, it } from "vitest";
import { buildApproval, seatOf } from "./approve.js";
import { openBundle } from "./circle.js";
import { applyEpoch } from "./epoch.js";
import {
  DAY_MS,
  enrollNewcomer,
  mnemonicOf,
  nextEpoch,
  twoOfThree,
} from "./epoch.test-support.js";
import { approve, clockAt, raise, release } from "./protocol.test-support.js";
import { completeRecovery } from "./recover.js";
import { combineMnemonics } from "./slip39/index.js";
import { PAYLOAD, holdingOf, person } from "./world.test-support.js";

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
