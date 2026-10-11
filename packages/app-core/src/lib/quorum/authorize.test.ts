/**
 * The two shapes a circle takes besides one flat k-of-n:
 * - an action-only circle: no shares, no secret, keys need no PRF; a quorum
 *   approves an action and the enforcing peer acts on `authorized`;
 * - two levels: so many from the family AND so many from friends.
 */
import { describe, expect, it } from "vitest";
import { buildApproval, buildRelease } from "./approve.js";
import { toB64url } from "./bytes.js";
import { generateKeyPair } from "./hpke.js";
import { QuorumLedger } from "./ledger.js";
import { completeRecovery, startRecovery } from "./recover.js";
import { createRequest } from "./request.js";
import type { QuorumRequest } from "./types.js";
import {
  PAYLOAD,
  T0,
  buildWorld,
  holdingOf,
  person,
} from "./world.test-support.js";

function clock() {
  const state = { t: T0.getTime() };
  return {
    now: () => state.t,
    date: () => new Date(state.t),
    at: (seconds: number) => {
      state.t = T0.getTime() + seconds * 1000;
    },
  };
}

describe("an action-only circle", () => {
  const world = () =>
    buildWorld({
      names: ["Ada", "Ben", "Cy"],
      // Cy's key has no PRF: fine here, since no share is ever held.
      keyOptions: { Cy: { prf: false } },
      groups: [{ id: "g", threshold: 2, members: ["Ada", "Ben", "Cy"] }],
      operations: ["grant-access"],
    });

  it("holds no secret: no bundle, no deliveries, no commitments", async () => {
    const w = await world();
    expect(w.created.bundle).toBeNull();
    expect(w.created.deliveries).toEqual([]);
    expect(w.created.signedPolicy.policy.shareCommitments).toEqual({});
    expect(person(w, "Cy").guardian.credentials[0]?.prf).toBe(false);
  });

  it("authorizes an action once a quorum approves and the delay has passed, and releases nothing", async () => {
    const w = await world();
    const c = clock();
    const request = createRequest({
      signedPolicy: w.created.signedPolicy,
      operation: "grant-access",
      grant: {
        principalId: "p-sister",
        resourceKind: "item",
        resourceId: "bank",
        resourceLabel: "Bank login",
        policy: "read",
        durationSeconds: 3600,
      },

      recipientPublicKey: toB64url(generateKeyPair().publicKey),
      recipientLabel: "Tyler's sister",
      now: c.date(),
    });
    expect(request.summary).toContain(
      'Let p-sister read the item "Bank login" for 1 hour(s)',
    );
    const ledger = QuorumLedger.open(w.created.signedPolicy, request, c.now);
    for (const name of ["Ada", "Cy"]) {
      const approval = await buildApproval({
        seat: {
          signedPolicy: w.created.signedPolicy,
          guardianId: person(w, name).id,
        },
        request,
        ceremony: person(w, name).ceremony,
        now: c.date(),
      });
      expect(await ledger.submitApproval(approval)).toEqual({ ok: true });
    }
    expect(ledger.status().state).toBe("waiting");
    c.at(3601);
    expect(ledger.status()).toEqual({
      state: "authorized",
      until: request.expiresAt,
    });
    expect(ledger.approvedGuardians().sort()).toEqual(
      [person(w, "Ada").id, person(w, "Cy").id].sort(),
    );
  });

  it("refuses to release a share it never held", async () => {
    const w = await world();
    const request = createRequest({
      signedPolicy: w.created.signedPolicy,
      operation: "grant-access",
      grant: {
        principalId: "p-sister",
        resourceKind: "item",
        resourceId: "bank",
        resourceLabel: "Bank login",
        policy: "read",
        durationSeconds: 3600,
      },
      recipientPublicKey: toB64url(generateKeyPair().publicKey),
      recipientLabel: "x",
      now: T0,
    });
    const ledger = QuorumLedger.open(
      w.created.signedPolicy,
      request,
      clock().now,
    );
    expect(await ledger.submitRelease({})).toMatchObject({
      code: "no_release",
    });
  });

  it("will not raise a request for an operation the circle does not govern", async () => {
    const w = await world();
    expect(() =>
      createRequest({
        signedPolicy: w.created.signedPolicy,
        operation: "recover-collection",
        recipientPublicKey: toB64url(generateKeyPair().publicKey),
        recipientLabel: "x",
        now: T0,
      }),
    ).toThrow(/does not govern/);
  });
});

describe("two levels: family AND friends", () => {
  const names = ["F1", "F2", "F3", "P1", "P2", "P3", "P4"];
  const world = () =>
    buildWorld({
      names,
      groups: [
        { id: "family", threshold: 2, members: ["F1", "F2", "F3"] },
        { id: "friends", threshold: 2, members: ["P1", "P2", "P3", "P4"] },
      ],
      groupThreshold: 2,
    });

  async function approve(
    w: Awaited<ReturnType<typeof world>>,
    ledger: QuorumLedger,
    who: string[],
    c: ReturnType<typeof clock>,
    request: QuorumRequest,
  ) {
    for (const name of who) {
      const p = person(w, name);
      if (!p.holding) throw new Error("no holding");
      await ledger.submitApproval(
        await buildApproval({
          seat: { signedPolicy: w.created.signedPolicy, guardianId: p.id },
          request,
          ceremony: p.ceremony,
          now: c.date(),
        }),
      );
    }
  }

  it("recovers with two relatives and two friends", async () => {
    const w = await world();
    const c = clock();
    const pending = startRecovery({
      signedPolicy: w.created.signedPolicy,
      recipientLabel: "new phone",
      now: c.date(),
    });
    const ledger = QuorumLedger.open(
      w.created.signedPolicy,
      pending.request,
      c.now,
    );
    const who = ["F1", "F3", "P2", "P4"];
    await approve(w, ledger, who, c, pending.request);
    expect(ledger.quorumMet()).toBe(true);
    c.at(3601);
    for (const name of who) {
      const p = person(w, name);
      const release = await buildRelease({
        holding: holdingOf(p),
        approvals: ledger.approvalList(),
        request: pending.request,
        ceremony: p.ceremony,
        now: c.date(),
      });
      expect(await ledger.submitRelease(release)).toEqual({ ok: true });
    }
    expect(
      await completeRecovery({
        ledger,
        recipientSecretKey: pending.recipient.secretKey,
        bundle: w.created.bundle,
      }),
    ).toEqual(PAYLOAD);
  });

  it("is not met by every relative, nor by every friend, nor by one of each", async () => {
    const w = await world();
    for (const who of [
      ["F1", "F2", "F3"],
      ["P1", "P2", "P3", "P4"],
      ["F1", "P1"],
      ["F1", "F2", "P1"],
    ]) {
      const c = clock();
      const pending = startRecovery({
        signedPolicy: w.created.signedPolicy,
        recipientLabel: "x",
        now: c.date(),
      });
      const ledger = QuorumLedger.open(
        w.created.signedPolicy,
        pending.request,
        c.now,
      );
      await approve(w, ledger, who, c, pending.request);
      expect(ledger.quorumMet()).toBe(false);
    }
  });

  it("combines exactly the shares the standard asks for, even if more were released", async () => {
    const w = await world();
    const c = clock();
    const pending = startRecovery({
      signedPolicy: w.created.signedPolicy,
      recipientLabel: "x",
      now: c.date(),
    });
    const ledger = QuorumLedger.open(
      w.created.signedPolicy,
      pending.request,
      c.now,
    );
    const everyone = names;
    await approve(w, ledger, everyone, c, pending.request);
    c.at(3601);
    for (const name of everyone) {
      const p = person(w, name);
      await ledger.submitRelease(
        await buildRelease({
          holding: holdingOf(p),
          approvals: ledger.approvalList(),
          request: pending.request,
          ceremony: p.ceremony,
          now: c.date(),
        }),
      );
    }
    expect(ledger.releases()).toHaveLength(7);
    expect(ledger.selectForCombine()).toHaveLength(4);
    expect(
      await completeRecovery({
        ledger,
        recipientSecretKey: pending.recipient.secretKey,
        bundle: w.created.bundle,
      }),
    ).toEqual(PAYLOAD);
  });
});
