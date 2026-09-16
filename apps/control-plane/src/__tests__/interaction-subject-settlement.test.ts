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
    },
  });
}

async function principal(cp: Plane): Promise<{ accessToken: string }> {
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
  requesterToken: string,
  approverRef: string,
  kind: InteractionKind,
  subjectId: string,
  authorizationDetails: JsonObject[],
): Promise<{ ref: string; requestDigest: string }> {
  const res = await cp.app.request("/v1/interactions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${requesterToken}`,
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
      requester.accessToken,
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
    expect(settle).toHaveLength(1);
    expect(settle[0]?.payload.subjectId).toBe("dev-session-1");
  });

  it("emits a digest-bound settlement command for an operation kind", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const { ref, requestDigest } = await create(
      cp,
      requester.accessToken,
      await inboxRefOf(cp, approver.accessToken),
      "transaction_authorization",
      "txn-77",
      [PAYMENT],
    );
    await stageApproval(cp, ref, requestDigest);

    expect((await consume(cp, ref, requester.accessToken)).status).toBe(200);

    const settle = (await cp.ctx.repos.outbox.listUnpublished()).find(
      (event) => event.eventType === "transaction_authorization.settle",
    );
    expect(settle?.payload.subjectId).toBe("txn-77");
    expect(settle?.payload.requestDigest).toBe(requestDigest);
  });

  it("spends the approval and its effect exactly once", async () => {
    const cp = plane();
    const approver = await principal(cp);
    const requester = await principal(cp);
    const { ref, requestDigest } = await create(
      cp,
      requester.accessToken,
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

    // One consumption, one effect — a second attempt commands nothing more.
    const settle = (await cp.ctx.repos.outbox.listUnpublished()).filter(
      (event) => event.eventType === "device_authorization.settle",
    );
    expect(settle).toHaveLength(1);
  });
});
