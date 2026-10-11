/**
 * The interaction follows the quorum ledger and nothing else (ADR 0187,
 * ADR 0086): what each verdict does to it, what it refuses, and that the
 * envelope never carries a share or a secret.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { toB64url, toHex } from "./bytes.js";
import { requestToInteraction } from "./interaction.js";
import {
  type Harness,
  type Rig,
  ZERO,
  codeOf,
  harness,
} from "./interaction.test-support.js";
import {
  approve as approveRecovery,
  raise,
  release,
} from "./protocol.test-support.js";
import { person } from "./world.test-support.js";
import { prfInput, unwrapShare } from "./wrap.js";

let h: Harness;

beforeAll(async () => {
  h = await harness();
});

const circle = () => `quorum-circle:${h.world.circleId}`;

describe("the interaction follows the ledger", () => {
  it("goes pending, awaiting, awaiting through the delay, approved, then consumed", async () => {
    const o = h.open();
    let i = h.settle(o, o.interaction);
    expect(i).toBe(o.interaction);
    await h.approveOne(o, "Ada");
    i = h.settle(o, i);
    expect(i).toMatchObject({
      status: "awaiting_approval",
      approverPrincipalId: circle(),
    });
    await h.approveOne(o, "Cy");
    expect(o.ledger.status().state).toBe("waiting");
    i = h.settle(o, i);
    expect(i.status).toBe("awaiting_approval");
    expect(i.approvalProof).toBeUndefined();
    o.at.advanceTo(3601);
    expect(o.ledger.status().state).toBe("authorized");
    i = h.settle(o, i);
    expect(i).toMatchObject({
      status: "approved",
      decidedAt: o.at.date(),
      approverPrincipalId: circle(),
    });
    expect(i.approvalProof).toEqual({
      mechanism: "webauthn",
      boundDigest: i.requestDigest,
      assurance: "phishing_resistant",
      verifiedAt: o.at.date(),
    });
    expect(h.wire(i).status).toBe("approved");
    expect(o.ledger.claimExecution()).toBe(true);
    i = h.settle(o, i);
    expect(i).toMatchObject({ status: "consumed", consumedAt: o.at.date() });
    expect(h.settle(o, i)).toBe(i);
  });

  it("calls a recovery approved once releasable, and leaves it approved when the shares are in", async () => {
    const r = await raise(h.world);
    const rig: Rig = {
      signedPolicy: h.world.created.signedPolicy,
      request: r.pending.request,
      ledger: r.ledger,
      at: r.clock,
    };
    const first = requestToInteraction({
      signedPolicy: rig.signedPolicy,
      request: rig.request,
    });
    await approveRecovery(h.world, "Ada", r);
    await approveRecovery(h.world, "Cy", r);
    r.clock.advanceTo(3601);
    expect(r.ledger.status().state).toBe("releasable");
    const i = h.settle(rig, first);
    expect(i.status).toBe("approved");
    await release(h.world, "Ada", r);
    await release(h.world, "Cy", r);
    expect(r.ledger.status().state).toBe("complete");
    expect(h.settle(rig, i)).toBe(i);
  });

  it.each(["pending", "awaiting_approval", "approved"])(
    "revokes one that was %s when the owner cancels",
    async (stage) => {
      const o = h.open();
      let i = o.interaction;
      if (stage !== "pending") {
        await h.approveWith(o, ["Ada", "Cy"]);
        i = h.settle(o, i);
      }
      if (stage === "approved") {
        o.at.advanceTo(3601);
        i = h.settle(o, i);
      }
      expect(i.status).toBe(stage);
      expect(h.cancel(o)).toEqual({ ok: true });
      expect(h.settle(o, i)).toMatchObject({
        status: "revoked",
        revokedAt: o.at.date(),
      });
    },
  );

  it("expires when approvals close short of a quorum, even before the request lapses", async () => {
    const o = h.open();
    await h.approveOne(o, "Ada");
    o.at.advanceTo(601);
    expect(o.ledger.status().state).toBe("approval_closed");
    const i = h.settle(o, h.settle(o, o.interaction));
    expect(i.status).toBe("expired");
    expect(o.at.date().getTime()).toBeLessThan(i.expiresAt.getTime());
  });

  it("expires a lapsed interaction whatever a stale verdict says, approved or not", async () => {
    const o = h.open();
    await h.approveWith(o, ["Ada", "Cy"]);
    o.at.advanceTo(3601);
    const stale = o.ledger.verdict();
    expect(stale.state).toBe("authorized");
    const approved = h.settle(o, o.interaction);
    o.at.advanceTo(86401);
    expect(o.ledger.status().state).toBe("expired");
    expect(h.settle(o, approved, stale).status).toBe("expired");
    expect(h.settle(o, o.interaction, stale).status).toBe("expired");
    expect(h.settle(o, o.interaction).status).toBe("expired");
  });

  it("never reopens a terminal interaction and never lets one fall behind its ledger", async () => {
    const o = h.open();
    const early = o.ledger.verdict();
    await h.approveWith(o, ["Ada", "Cy"]);
    o.at.advanceTo(3601);
    const approved = h.settle(o, o.interaction);
    expect(codeOf(() => h.settle(o, approved, early))).toBe("regress");
    const closed = { ...early, state: "approval_closed" as const };
    expect(codeOf(() => h.settle(o, approved, closed))).toBe("regress");
    o.ledger.claimExecution();
    const consumed = h.settle(o, approved);
    expect(consumed.status).toBe("consumed");
    h.cancel(o);
    expect(h.settle(o, consumed)).toBe(consumed);
  });

  it("will not call it approved on a verdict that does not hold up", () => {
    const o = h.open();
    const v = o.ledger.verdict();
    const both = ["g-ada", "g-cy"];
    const claim = (approvedBy: string[]) => ({
      ...v,
      state: "authorized" as const,
      approvedBy,
    });
    o.at.advanceTo(3601);
    for (const approvedBy of [[], ["g-ada"], ["g-ada", "g-zed"]]) {
      expect(codeOf(() => h.settle(o, o.interaction, claim(approvedBy)))).toBe(
        "quorum",
      );
    }
    o.at.advanceTo(10);
    expect(codeOf(() => h.settle(o, o.interaction, claim(both)))).toBe(
      "too_early",
    );
    o.at.advanceTo(3601);
    expect(h.settle(o, o.interaction, claim(both)).status).toBe("approved");
    const later = new Date(Date.parse(v.validUntil) + 1000).toISOString();
    const elsewhere = [
      { circleId: "other" },
      { operation: "export-items" as const },
      { requestDigest: ZERO },
      { validUntil: later },
    ];
    for (const other of elsewhere) {
      const verdict = { ...claim(both), ...other };
      expect(codeOf(() => h.settle(o, o.interaction, verdict))).toBe("verdict");
    }
  });

  it("leaves the interaction it was given untouched", async () => {
    const o = h.open();
    await h.approveWith(o, ["Ada", "Cy"]);
    o.at.advanceTo(3601);
    const before = JSON.stringify(o.interaction);
    const next = h.settle(o, o.interaction);
    expect(next).not.toBe(o.interaction);
    expect(JSON.stringify(o.interaction)).toBe(before);
    expect(next.version).toBeGreaterThan(o.interaction.version);
  });
});

describe("no secret rides in the envelope", () => {
  it("carries no share, wrapped key, recipient secret or mnemonic, even for a finished recovery", async () => {
    const { world } = h;
    const r = await raise(world);
    const rig: Rig = {
      signedPolicy: world.created.signedPolicy,
      request: r.pending.request,
      ledger: r.ledger,
      at: r.clock,
    };
    for (const name of ["Ada", "Cy"]) await approveRecovery(world, name, r);
    r.clock.advanceTo(3601);
    const released = [];
    for (const name of ["Ada", "Cy"]) {
      released.push((await release(world, name, r)).rel);
    }
    expect(r.ledger.status().state).toBe("complete");

    const ada = person(world, "Ada");
    const holding = ada.holding;
    if (!holding) throw new Error("no holding");
    const asserted = await ada.ceremony.assert({
      rpId: holding.signedPolicy.policy.rpId,
      challenge: new Uint8Array(32),
      allowCredentialIds: holding.wrapped.envelopes.map((e) => e.credentialId),
      requireUserVerification: true,
      prfInput: prfInput(world.circleId, ada.id),
    });
    const envelope = holding.wrapped.envelopes.find(
      (e) => e.credentialId === asserted.credentialId,
    );
    if (!envelope || !asserted.prfOutput) throw new Error("no output");
    const mnemonic = unwrapShare(
      envelope,
      {
        circleId: world.circleId,
        guardianId: ada.id,
        credentialId: asserted.credentialId,
        epoch: 1,
      },
      asserted.prfOutput,
    );
    const words = mnemonic.split(" ");
    expect(words.length).toBe(33);

    const forbidden = [
      mnemonic,
      ...Array.from({ length: words.length - 3 }, (_, k) =>
        words.slice(k, k + 4).join(" "),
      ),
      toB64url(r.pending.recipient.secretKey),
      toHex(r.pending.recipient.secretKey),
      toB64url(world.owner.secretKey),
      toB64url(ada.secrets.hpkeSecretKey),
      "correct horse battery staple",
      ...holding.wrapped.envelopes.flatMap((e) => [e.ciphertext, e.nonce]),
      ...released.flatMap((rel) => [rel.sealed.ciphertext, rel.sealed.enc]),
    ];
    const pending = requestToInteraction({
      signedPolicy: rig.signedPolicy,
      request: rig.request,
    });
    const approved = h.settle(rig, pending);
    expect(approved.status).toBe("approved");
    const text = JSON.stringify([pending, approved]);
    for (const secret of forbidden) expect(text).not.toContain(secret);
    // The scan can see: the same values are plain in the packets themselves.
    expect(JSON.stringify(released)).toContain(released[0]?.sealed.ciphertext);
    expect(JSON.stringify(holding)).toContain(
      holding.wrapped.envelopes[0]?.ciphertext,
    );

    expect(Object.keys(approved.authorizationDetails[0] ?? {}).sort()).toEqual([
      "actions",
      "approveBy",
      "circleId",
      "epoch",
      "identifier",
      "policyDigest",
      "quorumRequestDigest",
      "releaseNotBefore",
      "releaseRule",
      "requestId",
      "summary",
      "type",
    ]);
    expect(approved.authorizationDetails[0]).toMatchObject({
      releaseRule: "guardian-devices-after-delay",
    });
  });
});
