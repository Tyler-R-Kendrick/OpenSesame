/**
 * The whole protocol, end to end, through the real ceremony adapter and
 * virtual security keys: enroll, create, deliver, wrap, request, approve,
 * wait, release, recombine. The attacks are in `protocol.abuse.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { openBundle } from "./circle.js";
import {
  approve,
  raise,
  release,
  threeOfFive,
} from "./protocol.test-support.js";
import { RecoveryError, completeRecovery } from "./recover.js";
import { combineMnemonics } from "./slip39/index.js";
import { PAYLOAD, person } from "./world.test-support.js";

describe("3-of-5 circle: the happy path", () => {
  it("recovers the collection after a quorum approves, the delay passes and shares are released", async () => {
    const world = await threeOfFive();
    const r = await raise(world);

    for (const name of ["Ada", "Cy", "Eli"]) {
      expect((await approve(world, name, r)).outcome).toEqual({ ok: true });
    }
    expect(r.ledger.quorumMet()).toBe(true);
    expect(r.ledger.status().state).toBe("waiting");

    r.clock.advanceTo(3601);
    expect(r.ledger.status().state).toBe("releasable");
    for (const name of ["Ada", "Cy", "Eli"]) {
      expect((await release(world, name, r)).outcome).toEqual({ ok: true });
    }
    expect(r.ledger.status().state).toBe("complete");

    const recovered = await completeRecovery({
      ledger: r.ledger,
      recipientSecretKey: r.pending.recipient.secretKey,
      bundle: world.created.bundle,
    });
    expect(recovered).toEqual(PAYLOAD);
  });

  it("holds a custody receipt from every guardian before anything is armed", async () => {
    const world = await threeOfFive();
    for (const p of world.people.values()) {
      expect(p.receipt?.guardianId).toBe(p.id);
      expect(p.receipt?.wrappedCredentialIds.length).toBe(p.ring.keys.length);
    }
  });

  it("can be recombined by any SLIP-0039 tool from the shares alone (the exit door)", async () => {
    const world = await threeOfFive();
    // Take three guardians' shares out of their wrapped holdings, as a person
    // with their keys and a generic tool would, and recombine.
    const { unwrapShare, prfInput } = await import("./wrap.js");
    const mnemonics: string[] = [];
    for (const name of ["Ben", "Dee", "Eli"]) {
      const p = person(world, name);
      const holding = p.holding;
      if (!holding) throw new Error("no holding");
      const asserted = await p.ceremony.assert({
        rpId: holding.signedPolicy.policy.rpId,
        challenge: new Uint8Array(32),
        allowCredentialIds: holding.wrapped.envelopes.map(
          (e) => e.credentialId,
        ),
        requireUserVerification: true,
        prfInput: prfInput(world.circleId, p.id),
      });
      const envelope = holding.wrapped.envelopes.find(
        (e) => e.credentialId === asserted.credentialId,
      );
      if (!envelope || !asserted.prfOutput) throw new Error("no output");
      mnemonics.push(
        unwrapShare(
          envelope,
          {
            circleId: world.circleId,
            guardianId: p.id,
            credentialId: asserted.credentialId,
            epoch: 1,
          },
          asserted.prfOutput,
        ),
      );
    }
    expect(mnemonics.every((m) => m.split(" ").length === 33)).toBe(true);
    const secret = await combineMnemonics(mnemonics);
    expect(openBundle(world.created.bundle, secret)).toEqual(PAYLOAD);
  });
});

describe("a guardian is one vote, however many keys", () => {
  it("counts Dee once when she approves with her key and then her backup", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    const dee = person(world, "Dee");
    expect((await approve(world, "Dee", r)).outcome).toEqual({ ok: true });
    dee.ring.unplug(0);
    const again = await approve(world, "Dee", r);
    expect(again.outcome).toMatchObject({
      ok: false,
      code: "duplicate_guardian",
    });
    expect(r.ledger.approvedGuardians()).toEqual([dee.id]);
    expect(r.ledger.quorumMet()).toBe(false);
  });

  it("lets the backup key release the same share when the main key is gone", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    person(world, "Dee").ring.unplug(0);
    for (const name of ["Dee", "Ben", "Cy"]) await approve(world, name, r);
    r.clock.advanceTo(3601);
    for (const name of ["Dee", "Ben", "Cy"]) {
      expect((await release(world, name, r)).outcome).toEqual({ ok: true });
    }
    const recovered = await completeRecovery({
      ledger: r.ledger,
      recipientSecretKey: r.pending.recipient.secretKey,
      bundle: world.created.bundle,
    });
    expect(recovered).toEqual(PAYLOAD);
  });
});

describe("below the threshold, nothing", () => {
  it("does not meet quorum on two of five and refuses their releases", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    await approve(world, "Ada", r);
    await approve(world, "Ben", r);
    expect(r.ledger.quorumMet()).toBe(false);
    r.clock.advanceTo(3601);
    // Ada's own device will not release on two approvals of three needed.
    await expect(release(world, "Ada", r)).rejects.toMatchObject({
      code: "quorum",
    });
    await expect(
      completeRecovery({
        ledger: r.ledger,
        recipientSecretKey: r.pending.recipient.secretKey,
        bundle: world.created.bundle,
      }),
    ).rejects.toThrow(RecoveryError);
  });

  it("refuses a release from a guardian who never approved", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    r.clock.advanceTo(3601);
    // Eli's own device will not release a share Eli did not approve.
    await expect(release(world, "Eli", r)).rejects.toMatchObject({
      code: "not_approved",
    });
  });
});
