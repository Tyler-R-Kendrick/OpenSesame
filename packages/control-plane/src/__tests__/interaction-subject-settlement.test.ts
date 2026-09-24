import {
  type Interaction,
  type InteractionKind,
  type JsonObject,
  interactionMachine,
  overlapCast,
  resolveInteractionRef,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { resetInteractionLinkBudget } from "../routes/interaction-handoff.js";
import {
  activateInteraction,
  enrolPasskey,
} from "./interaction-webauthn-fixture.js";
import { seedOwnedCeremony } from "./seed-ceremony-subject.js";

/**
 * Consuming an approval settles the real ceremony (ADR 0086; F05, T-16).
 *
 * These drive the actual `/consume` route. The approval itself is staged
 * through the interaction machine and the store rather than the evolving
 * approve ceremony, so the test proves what consuming does — that it verifies
 * the binding and emits the bound settlement command — without coupling to how
 * the approval was gathered.
 */

type Plane = ReturnType<typeof createControlPlane>;

function plane(): Plane {
  resetInteractionLinkBudget();
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      operatorToken: "",
    },
  });
}

async function principal(
  cp: Plane,
): Promise<{ accessToken: string; principalId: string }> {
  const res = await cp.app.request("/v1/principals/provisional", {
    method: "POST",
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

async function inboxRefOf(cp: Plane, token: string): Promise<string> {
  const res = await cp.app.request("/v1/authorization-requests/inbox-ref", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return overlapCast<unknown, { approverRef: string }>(await res.json())
    .approverRef;
}

let seq = 0;
async function create(
  cp: Plane,
  requester: { accessToken: string; principalId: string },
  approverRef: string,
  kind: InteractionKind,
  subjectId: string,
  authorizationDetails: JsonObject[],
): Promise<{ ref: string; requestDigest: string }> {
  seedOwnedCeremony(cp, kind, subjectId, requester.principalId);
  const res = await cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requester.accessToken}`,
      "content-type": "application/json",
      "idempotency-key": `settle-${++seq}`,
    },
    body: JSON.stringify({
      kind,
      subject: { kind, subjectId },
      approverRef,
      authorizationDetails,
      ttlSeconds: 300,
    }),
  });
  expect(res.status).toBe(201);
  return overlapCast(await res.json());
}

/**
 * Stage an approval directly on the store: identify the approver, move the row
 * through the machine, and persist the bound proof — the state a completed
 * approve ceremony leaves behind.
 */
async function stageApproval(
  cp: Plane,
  ref: string,
  requestDigest: string,
): Promise<Interaction> {
  const id = resolveInteractionRef(ref, cp.ctx.config.claimPepper);
  expect(id).not.toBeNull();
  const row = await cp.ctx.repos.interactions.getById(id ?? "");
  expect(row).not.toBeNull();
  if (!row?.approverPrincipalId) throw new Error("no approver on row");
  const now = cp.ctx.clock();
  const approved = interactionMachine.approve(
    interactionMachine.awaitApproval(row, row.approverPrincipalId, now),
    {
      approverPrincipalId: row.approverPrincipalId,
      proof: {
        mechanism: "session_reauth",
        boundDigest: requestDigest,
        assurance: "provisional",
        verifiedAt: now,
      },
      now,
    },
  );
  return cp.ctx.repos.interactions.updateWithVersion(row.id, row.version, {
    status: "approved",
    approverPrincipalId: row.approverPrincipalId,
    ...(approved.approvalProof
      ? { approvalProof: approved.approvalProof }
      : undefined),
    decidedAt: now,
  });
}

function consume(cp: Plane, ref: string, token: string) {
  return cp.app.request(`/v1/interactions/${ref}/consume`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

const DELEGATION: JsonObject = {
  type: "connection_delegation",
  actions: ["repository.read"],
  locations: ["repo:acme/catalog"],
};

const PAYMENT: JsonObject = {
  type: "payment_initiation",
  amount: { currency: "USD", value: "143.72" },
  payee: { display_name: "AliceCo" },
};

describe("consuming an approval settles the fronted subject", () => {
  it("emits a bound settlement command for a session kind", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const { ref, requestDigest } = await create(
      cp,
      requester,
      await inboxRefOf(cp, approver.accessToken),
      "device_authorization",
      "dev-session-1",
      [DELEGATION],
    );
    await stageApproval(cp, ref, requestDigest);

    const spent = await consume(cp, ref, requester.accessToken);
    expect(spent.status).toBe(200);
    expect(overlapCast(await spent.json()).status).toBe("consumed");

    const events = await cp.ctx.repos.outbox.listUnpublished();
    const settle = events.filter(
      (event) => event.eventType === "device_authorization.settle",
    );
    expect(settle).toHaveLength(0);
    const applied = (await cp.ctx.repos.auditEvents.list({ limit: 500 })).find(
      (event) => event.eventType === "interaction_subject.applied",
    );
    expect(applied?.metadata?.subjectKind).toBe("device_authorization");
    expect(applied?.metadata?.subjectId).toBeUndefined();
    expect(applied?.metadata?.execution).toBe("succeeded");
    expect(
      cp.ctx.stores.ceremonySubjects.getDevice("dev-session-1")?.session.state,
    ).toBe("consumed");
  });

  it("emits a digest-bound settlement command for an operation kind", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const { ref, requestDigest } = await create(
      cp,
      requester,
      await inboxRefOf(cp, approver.accessToken),
      "transaction_authorization",
      "txn-77",
      [PAYMENT],
    );
    await cp.app.request(`/v1/interactions/${ref}`, {
      headers: { authorization: `Bearer ${approver.accessToken}` },
    });
    const credentialId = await enrolPasskey(cp, approver.principalId);
    const activationId = await activateInteraction(
      cp,
      approver.accessToken,
      ref,
      requestDigest,
      credentialId,
    );
    expect(
      (
        await cp.app.request(`/v1/interactions/${ref}/approve`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${approver.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ requestDigest, activationId }),
        })
      ).status,
    ).toBe(200);

    expect((await consume(cp, ref, requester.accessToken)).status).toBe(200);

    const settle = (await cp.ctx.repos.outbox.listUnpublished()).find(
      (event) => event.eventType === "transaction_authorization.settle",
    );
    expect(settle).toBeUndefined();
    const applied = (await cp.ctx.repos.auditEvents.list({ limit: 500 })).find(
      (event) => event.eventType === "interaction_subject.applied",
    );
    expect(applied?.metadata?.subjectKind).toBe("transaction_authorization");
    expect(applied?.metadata?.requestDigest).toBe(requestDigest);
    expect(applied?.metadata?.subjectId).toBeUndefined();
    expect(applied?.metadata?.execution).toBe("succeeded");
    expect(cp.ctx.stores.ceremonySubjects.getTransaction("txn-77")?.state).toBe(
      "authorized",
    );
  });

  it("spends the approval and its effect exactly once", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const { ref, requestDigest } = await create(
      cp,
      requester,
      await inboxRefOf(cp, approver.accessToken),
      "device_authorization",
      "dev-session-2",
      [DELEGATION],
    );
    await stageApproval(cp, ref, requestDigest);

    expect((await consume(cp, ref, requester.accessToken)).status).toBe(200);
    const again = await consume(cp, ref, requester.accessToken);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "interaction_consumed" });

    const settle = (await cp.ctx.repos.outbox.listUnpublished()).filter(
      (event) => event.eventType === "device_authorization.settle",
    );
    expect(settle).toHaveLength(0);
    const applied = (
      await cp.ctx.repos.auditEvents.list({ limit: 500 })
    ).filter((event) => event.eventType === "interaction_subject.applied");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.metadata?.subjectKind).toBe("device_authorization");
  });

  it("settles a pairing subject to paired", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const { ref, requestDigest } = await create(
      cp,
      requester,
      await inboxRefOf(cp, approver.accessToken),
      "pairing",
      "pair-1",
      [DELEGATION],
    );
    await stageApproval(cp, ref, requestDigest);
    expect((await consume(cp, ref, requester.accessToken)).status).toBe(200);
    expect(cp.ctx.stores.ceremonySubjects.getPairing("pair-1")?.state).toBe(
      "paired",
    );
  });

  it("refuses consume after the ceremony subject expires", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const { ref, requestDigest } = await create(
      cp,
      requester,
      await inboxRefOf(cp, approver.accessToken),
      "device_authorization",
      "dev-expired",
      [DELEGATION],
    );
    await stageApproval(cp, ref, requestDigest);
    const owned = cp.ctx.stores.ceremonySubjects.getDevice("dev-expired");
    if (!owned) throw new Error("missing seeded device");
    cp.ctx.stores.ceremonySubjects.putDevice({
      ownerPrincipalId: owned.ownerPrincipalId,
      session: { ...owned.session, expiresAt: new Date(0) },
    });
    const spent = await consume(cp, ref, requester.accessToken);
    expect(spent.status).toBeGreaterThanOrEqual(400);
    const id = resolveInteractionRef(ref, cp.ctx.config.claimPepper);
    expect((await cp.ctx.repos.interactions.getById(id ?? ""))?.status).toBe(
      "approved",
    );
    expect(
      cp.ctx.stores.ceremonySubjects.getDevice("dev-expired")?.session.state,
    ).not.toBe("consumed");
  });
});
