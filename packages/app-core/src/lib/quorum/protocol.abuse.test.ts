/**
 * The attacks on the protocol: the clocks, cancellation, binding of approvals
 * to one request and one phase, requests that lie, and forged shares. Each
 * test changes one thing and pins one refusal.
 */
import { describe, expect, it } from "vitest";
import {
  RELEASE_HPKE_INFO,
  buildApproval,
  buildRelease,
  releaseAad,
  seatOf,
} from "./approve.js";
import { toB64url, utf8Bytes } from "./bytes.js";
import { generateOwnerKeys } from "./circle.js";
import type { GuardianError } from "./guardian.js";
import { sealBase } from "./hpke.js";
import { signCancellation } from "./ledger.js";
import {
  approve,
  raise,
  release,
  threeOfFive,
} from "./protocol.test-support.js";
import { completeRecovery } from "./recover.js";
import { T0, holdingOf, person } from "./world.test-support.js";

describe("the two clocks", () => {
  it("keeps the delay on the guardian's device: no release before it", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    r.clock.advanceTo(3599);
    const ada = person(world, "Ada");
    await expect(
      buildRelease({
        holding: holdingOf(ada),
        approvals: r.ledger.approvalList(),
        request: r.pending.request,
        ceremony: ada.ceremony,
        now: r.clock.date(),
      }),
    ).rejects.toMatchObject({ code: "too_early" });
  });

  it("keeps the delay in the ledger too, for a device that would not wait", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    // Build the release honestly, late, then submit it to a ledger whose clock is early.
    r.clock.advanceTo(3601);
    const ada = person(world, "Ada");
    const rel = await buildRelease({
      holding: holdingOf(ada),
      approvals: r.ledger.approvalList(),
      request: r.pending.request,
      ceremony: ada.ceremony,
      now: r.clock.date(),
    });
    r.clock.advanceTo(3000);
    expect(await r.ledger.submitRelease(rel)).toMatchObject({
      code: "too_early",
    });
  });

  it("closes the approval window", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    r.clock.advanceTo(601);
    const ada = person(world, "Ada");
    await expect(
      buildApproval({
        seat: seatOf(holdingOf(ada)),
        request: r.pending.request,
        ceremony: ada.ceremony,
        now: r.clock.date(),
      }),
    ).rejects.toMatchObject({ code: "window" });
  });

  it("lets the request lapse", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    r.clock.advanceTo(86401);
    expect(r.ledger.status().state).toBe("expired");
    expect(
      await release(world, "Ada", r).catch((e: GuardianError) => e.code),
    ).toBe("expired");
  });
});

describe("the owner can cancel during the delay", () => {
  it("stops a request with a signed cancellation, and nothing else can", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    const when = new Date(T0.getTime() + 60_000);
    const forged = signCancellation({
      circleId: world.circleId,
      requestDigest: r.ledger.digest,
      ownerSecretKey: generateOwnerKeys().secretKey,
      now: when,
    });
    expect(r.ledger.cancel(forged)).toMatchObject({
      ok: false,
      code: "bad_signature",
    });
    expect(r.ledger.status().state).not.toBe("cancelled");

    const genuine = signCancellation({
      circleId: world.circleId,
      requestDigest: r.ledger.digest,
      ownerSecretKey: world.owner.secretKey,
      now: when,
    });
    expect(r.ledger.cancel(genuine)).toEqual({ ok: true });
    expect(r.ledger.status().state).toBe("cancelled");
    r.clock.advanceTo(3601);
    expect(
      (await release(world, "Ada", r).catch((e) => e)).outcome,
    ).toMatchObject({
      code: "cancelled",
    });
  });

  it("makes a guardian's own device refuse once it has heard of the cancellation", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    const ada = person(world, "Ada");
    await expect(
      buildApproval({
        seat: seatOf(holdingOf(ada)),
        request: r.pending.request,
        ceremony: ada.ceremony,
        now: r.clock.date(),
        isCancelled: (digest) => digest === r.ledger.digest,
      }),
    ).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("approvals are bound to one request and one phase", () => {
  it("does not count an approval for another request", async () => {
    const world = await threeOfFive();
    const a = await raise(world);
    const b = await raise(world);
    const ada = person(world, "Ada");
    const approval = await buildApproval({
      seat: seatOf(holdingOf(ada)),
      request: a.pending.request,
      ceremony: ada.ceremony,
      now: a.clock.date(),
    });
    expect(await b.ledger.submitApproval(approval)).toMatchObject({
      code: "digest",
    });
    // Even relabelled with the other request's digest, the signature is over the first.
    const relabelled = { ...approval, requestDigest: b.ledger.digest };
    expect(await b.ledger.submitApproval(relabelled)).toMatchObject({
      code: "challenge",
    });
  });

  it("does not take an approval assertion as a release", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    r.clock.advanceTo(3601);
    const ada = person(world, "Ada");
    const approval = await buildApproval({
      seat: seatOf(holdingOf(ada)),
      request: r.pending.request,
      ceremony: ada.ceremony,
      now: new Date(T0.getTime() + 60_000),
    });
    const sealed = sealBase({
      recipientPublicKey: r.pending.recipient.publicKey,
      info: utf8Bytes(RELEASE_HPKE_INFO),
      aad: releaseAad(r.ledger.digest, ada.id),
      plaintext: utf8Bytes("whatever"),
    });
    const fake = {
      ...approval,
      kind: "release" as const,
      sealed: {
        enc: toB64url(sealed.enc),
        ciphertext: toB64url(sealed.ciphertext),
      },
    };
    expect(await r.ledger.submitRelease(fake)).toMatchObject({
      code: "challenge",
    });
  });

  it("refuses an assertion from another origin and one with no user verification", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    const ada = person(world, "Ada");
    ada.ring.keys[0]?.setOrigin("https://attacker.example.test");
    const phished = await buildApproval({
      seat: seatOf(holdingOf(ada)),
      request: r.pending.request,
      ceremony: ada.ceremony,
      now: r.clock.date(),
    });
    expect(await r.ledger.submitApproval(phished)).toMatchObject({
      code: "origin",
    });
    ada.ring.keys[0]?.setOrigin("https://vault.example.test");
    ada.ring.keys[0]?.setUserVerified(false);
    const touchOnly = await buildApproval({
      seat: seatOf(holdingOf(ada)),
      request: r.pending.request,
      ceremony: ada.ceremony,
      now: r.clock.date(),
    });
    expect(await r.ledger.submitApproval(touchOnly)).toMatchObject({
      code: "user_verification",
    });
  });
});

describe("a request cannot lie to a guardian", () => {
  it("is refused when its recipient, delay or sentence differ from the policy's", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    const ada = person(world, "Ada");
    const base = { ceremony: ada.ceremony, now: r.clock.date() };
    const swapped = {
      ...r.pending.request,
      recipient: {
        ...r.pending.request.recipient,
        hpkePublicKey: toB64url(new Uint8Array(32).fill(7)),
      },
    };
    const seat = seatOf(holdingOf(ada));
    await expect(
      buildApproval({ ...base, seat, request: swapped }),
    ).rejects.toMatchObject({
      code: "summary",
    });
    const hurried = {
      ...r.pending.request,
      releaseNotBefore: r.pending.request.createdAt,
    };
    await expect(
      buildApproval({ ...base, seat, request: hurried }),
    ).rejects.toMatchObject({
      code: "timing",
    });
    const elsewhere = { ...r.pending.request, circleId: "c-other" };
    await expect(
      buildApproval({ ...base, seat, request: elsewhere }),
    ).rejects.toMatchObject({
      code: "circle",
    });
  });
});

describe("a released share is for one recipient and one request", () => {
  it("does not open for anyone but the recipient the request named", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    r.clock.advanceTo(3601);
    for (const name of ["Ada", "Ben", "Cy"]) await release(world, name, r);
    const { generateKeyPair } = await import("./hpke.js");
    await expect(
      completeRecovery({
        ledger: r.ledger,
        recipientSecretKey: generateKeyPair().secretKey,
        bundle: world.created.bundle,
      }),
    ).rejects.toMatchObject({ code: "bad_release" });
  });

  it("catches a forged share by its commitment, and says whose", async () => {
    const world = await threeOfFive();
    const r = await raise(world);
    for (const name of ["Ada", "Ben", "Cy"]) await approve(world, name, r);
    r.clock.advanceTo(3601);
    await release(world, "Ada", r);
    await release(world, "Ben", r);
    // Cy's genuine, validly-signed release has its payload swapped on the wire
    // for a different share sealed to the same recipient.
    const cy = person(world, "Cy");
    const real = await buildRelease({
      holding: holdingOf(cy),
      approvals: r.ledger.approvalList(),
      request: r.pending.request,
      ceremony: cy.ceremony,
      now: r.clock.date(),
    });
    // Well-formed text, well-formed words, but not the share Cy was given.
    const bogus = sealBase({
      recipientPublicKey: r.pending.recipient.publicKey,
      info: utf8Bytes(RELEASE_HPKE_INFO),
      aad: releaseAad(r.ledger.digest, cy.id),
      plaintext: utf8Bytes(Array(33).fill("academic").join(" ")),
    });
    const swapped = {
      ...real,
      sealed: {
        enc: toB64url(bogus.enc),
        ciphertext: toB64url(bogus.ciphertext),
      },
    };
    expect(await r.ledger.submitRelease(swapped)).toEqual({ ok: true });
    await expect(
      completeRecovery({
        ledger: r.ledger,
        recipientSecretKey: r.pending.recipient.secretKey,
        bundle: world.created.bundle,
      }),
    ).rejects.toMatchObject({ code: "bad_release", guardianIds: [cy.id] });
  });
});
