/**
 * Defense in depth around a release. A recipient's ledger is the recipient's
 * own, so the checks that matter run on each guardian's device; the ledger's
 * are the same rules a second time. And a release can be damaged on the way,
 * since a signature cannot cover the share sealed after the touch.
 */
import { describe, expect, it } from "vitest";
import { RELEASE_HPKE_INFO, buildRelease, releaseAad } from "./approve.js";
import { toB64url, utf8Bytes } from "./bytes.js";
import { sealBase } from "./hpke.js";
import { QuorumLedger } from "./ledger.js";
import { PolicyError } from "./policy.js";
import {
  approve,
  clockAt,
  raise,
  release,
  threeOfFive,
} from "./protocol.test-support.js";
import { completeRecovery } from "./recover.js";
import type { Release } from "./types.js";
import { PAYLOAD, holdingOf, person } from "./world.test-support.js";

type Raised = Awaited<ReturnType<typeof raise>>;

async function readyToRelease(who: string[]) {
  const world = await threeOfFive();
  const r = await raise(world);
  for (const name of who) await approve(world, name, r);
  r.clock.advanceTo(3601);
  return { world, r };
}

async function honestRelease(
  world: Awaited<ReturnType<typeof threeOfFive>>,
  name: string,
  r: Raised,
): Promise<Release> {
  const p = person(world, name);
  return buildRelease({
    holding: holdingOf(p),
    approvals: r.ledger.approvalList(),
    request: r.pending.request,
    ceremony: p.ceremony,
    now: r.clock.date(),
  });
}

/** The release with its sealed share swapped for well-formed words that are not that guardian's. */
function damaged(real: Release, r: Raised): Release {
  const bogus = sealBase({
    recipientPublicKey: r.pending.recipient.publicKey,
    info: utf8Bytes(RELEASE_HPKE_INFO),
    aad: releaseAad(real.requestDigest, real.guardianId),
    plaintext: utf8Bytes(Array(33).fill("academic").join(" ")),
  });
  return {
    ...real,
    sealed: {
      enc: toB64url(bogus.enc),
      ciphertext: toB64url(bogus.ciphertext),
    },
  };
}

describe("a guardian's device checks the quorum itself", () => {
  it("will not release on approvals that do not satisfy the policy", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben"]);
    await expect(honestRelease(world, "Ada", r)).rejects.toMatchObject({
      code: "quorum",
    });
  });

  it("will not release a share its guardian did not approve, whatever others did", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben", "Cy"]);
    await expect(honestRelease(world, "Dee", r)).rejects.toMatchObject({
      code: "not_approved",
    });
  });

  it("does not count an approval that has been tampered with", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben", "Cy"]);
    const approvals = r.ledger.approvalList().map((a) => {
      if (a.guardianId !== person(world, "Cy").id) return a;
      const signature = a.assertion.signature;
      const flipped = signature.startsWith("A")
        ? `B${signature.slice(1)}`
        : `A${signature.slice(1)}`;
      return { ...a, assertion: { ...a.assertion, signature: flipped } };
    });
    const ada = person(world, "Ada");
    await expect(
      buildRelease({
        holding: holdingOf(ada),
        approvals,
        request: r.pending.request,
        ceremony: ada.ceremony,
        now: r.clock.date(),
      }),
    ).rejects.toMatchObject({ code: "quorum" });
  });

  it("does not count approvals given for another request", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben", "Cy"]);
    const other = await raise(world, clockAt(0));
    other.clock.advanceTo(3601);
    const ada = person(world, "Ada");
    // Ada has approved `r`, not `other`; its approvals are the wrong request's.
    await expect(
      buildRelease({
        holding: holdingOf(ada),
        approvals: r.ledger.approvalList(),
        request: other.pending.request,
        ceremony: ada.ceremony,
        now: other.clock.date(),
      }),
    ).rejects.toMatchObject({ code: "not_approved" });
  });
});

describe("the ledger says the same, a second time", () => {
  it("refuses a release before any quorum has approved", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben", "Cy"]);
    const real = await honestRelease(world, "Ada", r);
    const bare = QuorumLedger.open(
      world.created.signedPolicy,
      r.pending.request,
      r.clock.now,
    );
    expect(await bare.submitRelease(real)).toMatchObject({ code: "quorum" });
  });

  it("refuses a release from a guardian whose approval this ledger never saw", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben", "Cy", "Dee"]);
    // Ada's device saw all four approvals and released honestly.
    const real = await honestRelease(world, "Ada", r);
    // This ledger saw only three others: a quorum, but without Ada.
    const now = { t: new Date(r.pending.request.createdAt).getTime() };
    const elsewhere = QuorumLedger.open(
      world.created.signedPolicy,
      r.pending.request,
      () => now.t,
    );
    const ada = person(world, "Ada").id;
    for (const approval of r.ledger.approvalList()) {
      if (approval.guardianId !== ada) {
        expect(await elsewhere.submitApproval(approval)).toEqual({ ok: true });
      }
    }
    expect(elsewhere.quorumMet()).toBe(true);
    now.t = new Date(r.pending.request.releaseNotBefore).getTime() + 1000;
    expect(await elsewhere.submitRelease(real)).toMatchObject({
      code: "not_approved",
    });
  });

  it("opens only a policy the owner signed", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    const edited = {
      ...world.created.signedPolicy,
      policy: { ...world.created.signedPolicy.policy, label: "Mine now" },
    };
    expect(() =>
      QuorumLedger.open(edited, r.pending.request, r.clock.now),
    ).toThrow(PolicyError);
  });
});

describe("a release damaged on the way does not stall the recovery", () => {
  it("is dropped and the spare shares are used", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben", "Cy", "Dee"]);
    // Cy's release is damaged between Cy's device and the ledger; the other
    // three are fine, which is a quorum of 3 without Cy.
    await release(world, "Ada", r);
    await release(world, "Dee", r);
    const cy = await honestRelease(world, "Cy", r);
    expect(await r.ledger.submitRelease(damaged(cy, r))).toEqual({ ok: true });
    await release(world, "Ben", r);
    expect(r.ledger.releases()).toHaveLength(4);
    expect(
      await completeRecovery({
        ledger: r.ledger,
        recipientSecretKey: r.pending.recipient.secretKey,
        bundle: world.created.bundle,
      }),
    ).toEqual(PAYLOAD);
    expect(r.ledger.releases().map((x) => x.guardianId)).not.toContain(
      person(world, "Cy").id,
    );
  });

  it("names the guardian to ask again, who can then release afresh", async () => {
    const { world, r } = await readyToRelease(["Ada", "Ben", "Cy"]);
    await release(world, "Ada", r);
    await release(world, "Ben", r);
    const cy = await honestRelease(world, "Cy", r);
    expect(await r.ledger.submitRelease(damaged(cy, r))).toEqual({ ok: true });
    const failure = await completeRecovery({
      ledger: r.ledger,
      recipientSecretKey: r.pending.recipient.secretKey,
      bundle: world.created.bundle,
    }).catch((e) => e);
    expect(failure).toMatchObject({
      code: "bad_release",
      guardianIds: [person(world, "Cy").id],
    });
    // Cy's slot was freed: a fresh ceremony releases, and the recovery completes.
    expect((await release(world, "Cy", r)).outcome).toEqual({ ok: true });
    expect(
      await completeRecovery({
        ledger: r.ledger,
        recipientSecretKey: r.pending.recipient.secretKey,
        bundle: world.created.bundle,
      }),
    ).toEqual(PAYLOAD);
  });
});
