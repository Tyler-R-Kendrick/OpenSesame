import {
  type Interaction,
  type InteractionKind,
  type JsonObject,
  canonicalRequestDigest,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../create-app.js";
import { inboxRef, requesterRef } from "./interaction-handles.js";
import {
  SUBJECT_ADAPTERS,
  settleInteractionSubject,
  subjectAdapterFor,
  verifyInteractionBinding,
} from "./subject-adapters.js";

/**
 * Subject adapters and the settlement executor (ADR 0086, ADR 0009).
 *
 * The claims under test: an executor recomputes an approval's binding from the
 * interaction's own fields before it spends anything (T-16), a consumed
 * approval commands a real, digest-bound effect rather than merely flipping a
 * row (F05), and no interaction kind settles another's subject.
 */

const PEPPER = "subject-adapter-test-pepper";
const APPROVER = "prn_approver";
const REQUESTER = "prn_requester";
const EXPIRES = new Date("2026-09-01T00:05:00.000Z");

/** A control plane whose real context supplies the pepper and the repos. */
function plane() {
  return createControlPlane({
    config: {
      port: 0,
      publicUrl: "http://127.0.0.1:8788",
      issuer: "http://127.0.0.1:8788",
      claimPepper: PEPPER,
    },
  });
}

const PAYMENT_DETAIL: JsonObject = {
  type: "payment_initiation",
  amount: { currency: "USD", value: "10.00" },
  payee: { display_name: "AliceCo" },
};

/**
 * A well-formed, approved interaction whose stored digest is exactly the one
 * its fields produce — the shape the create/approve routes leave behind.
 */
function approved(
  kind: InteractionKind,
  subjectId: string,
  overrides: Partial<Interaction> = {},
): Interaction {
  const authorizationDetails = [PAYMENT_DETAIL];
  const bindingMessage = "Pay 10.00 USD to AliceCo";
  const requester = requesterRef(REQUESTER, PEPPER);
  const requestDigest = canonicalRequestDigest({
    kind,
    subject: `${kind}:${subjectId}`,
    approverRef: inboxRef(APPROVER, PEPPER),
    requesterRef: requester,
    authorizationDetails: [
      // The digest canonicalizes AuthorizationDetail; the interaction stores
      // the same object as a JsonObject.
      {
        type: "payment_initiation",
        amount: { currency: "USD", value: "10.00" },
        payee: { display_name: "AliceCo" },
      },
    ],
    bindingMessage,
    expiresAt: EXPIRES.toISOString(),
  });
  return {
    id: `intr_${subjectId}`,
    kind,
    status: "approved",
    subject: { kind, subjectId },
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    expiresAt: EXPIRES,
    requesterRef: requester,
    approverPrincipalId: APPROVER,
    requestDigest,
    bindingMessage,
    authorizationDetails,
    approvalProof: {
      mechanism: "session_reauth",
      boundDigest: requestDigest,
      assurance: "provisional",
      verifiedAt: new Date("2026-09-01T00:01:00.000Z"),
    },
    version: 7,
    ...overrides,
  };
}

describe("the subject adapter registry is exhaustive and typed", () => {
  it("has an adapter for every interaction kind", () => {
    const kinds: InteractionKind[] = [
      "device_authorization",
      "pairing",
      "claim",
      "grant_claim",
      "authorization_request",
      "transaction_authorization",
    ];
    for (const kind of kinds) {
      const adapter = subjectAdapterFor(kind);
      expect(adapter?.kind).toBe(kind);
    }
  });

  it("marks exactly the operation kinds as digest-bound (ADR 0009)", () => {
    const requires = Object.values(SUBJECT_ADAPTERS)
      .filter((adapter) => adapter.requiresDigest)
      .map((adapter) => adapter.kind)
      .sort();
    expect(requires).toEqual([
      "authorization_request",
      "grant_claim",
      "transaction_authorization",
    ]);
  });
});

describe("verifyInteractionBinding recomputes before it trusts (T-16)", () => {
  it("accepts an approval whose stored digest recomputes from its fields", () => {
    const cp = plane();
    expect(
      verifyInteractionBinding(
        cp.ctx,
        approved("transaction_authorization", "txn-1"),
      ),
    ).toEqual({ ok: true });
  });

  it("accepts a session kind carrying a bound digest", () => {
    const cp = plane();
    expect(
      verifyInteractionBinding(
        cp.ctx,
        approved("device_authorization", "dev-1"),
      ),
    ).toEqual({ ok: true });
  });

  it("refuses a proof bound to a different request", () => {
    const cp = plane();
    const row = approved("transaction_authorization", "txn-1", {
      approvalProof: {
        mechanism: "session_reauth",
        boundDigest: "sha256:deadbeef",
        assurance: "provisional",
        verifiedAt: EXPIRES,
      },
    });
    expect(verifyInteractionBinding(cp.ctx, row)).toEqual({
      ok: false,
      reason: "proof_unbound",
    });
  });

  it("refuses when the stored digest does not recompute from the fields", () => {
    const cp = plane();
    // The subject id moved after approval: the payment the approver read was
    // for txn-1, and settling txn-9 with that approval is exactly the
    // approval-transfer the recomputation exists to catch.
    const genuine = approved("transaction_authorization", "txn-1");
    const tampered: Interaction = {
      ...genuine,
      subject: { kind: "transaction_authorization", subjectId: "txn-9" },
    };
    expect(verifyInteractionBinding(cp.ctx, tampered)).toEqual({
      ok: false,
      reason: "digest_recompute_mismatch",
    });
  });

  it("refuses a digest kind with no proof at all", () => {
    const cp = plane();
    const row = approved("grant_claim", "grant-1");
    const { approvalProof: _dropped, ...withoutProof } = row;
    expect(verifyInteractionBinding(cp.ctx, withoutProof)).toEqual({
      ok: false,
      reason: "missing_proof",
    });
  });

  it("refuses a digest kind that reached approval with no digest", () => {
    const cp = plane();
    const row = approved("authorization_request", "areq-1");
    const { requestDigest: _dropped, approvalProof: _p, ...noDigest } = row;
    expect(verifyInteractionBinding(cp.ctx, noDigest)).toEqual({
      ok: false,
      reason: "missing_digest",
    });
  });

  it("refuses a subject with no id", () => {
    const cp = plane();
    const row = approved("device_authorization", "dev-1", {
      subject: { kind: "device_authorization", subjectId: "" },
    });
    expect(verifyInteractionBinding(cp.ctx, row)).toEqual({
      ok: false,
      reason: "subject_unbound",
    });
  });
});

describe("settleInteractionSubject commands a real effect only after binding (F05)", () => {
  it("emits a digest-bound settlement command for the subject's kind", async () => {
    const cp = plane();
    const row = approved("transaction_authorization", "txn-1");
    const result = await cp.ctx.repos.transaction((uow) =>
      settleInteractionSubject(cp.ctx, row, uow),
    );
    expect(result.ok).toBe(true);

    const events = await cp.ctx.repos.outbox.listUnpublished();
    const settle = events.find(
      (event) => event.eventType === "transaction_authorization.settle",
    );
    expect(settle).toBeDefined();
    expect(settle?.payload.interactionId).toBe(row.id);
    expect(settle?.payload.subjectId).toBe("txn-1");
    expect(settle?.payload.requestDigest).toBe(row.requestDigest);
    // Subject id is internal-only; it must never carry the binding message or
    // the authorization details, which quote requester-authored text.
    expect(settle?.payload.bindingMessage).toBeUndefined();
    expect(settle?.payload.authorizationDetails).toBeUndefined();
  });

  it("dispatches nothing when the binding does not hold", async () => {
    const cp = plane();
    const tampered: Interaction = {
      ...approved("transaction_authorization", "txn-1"),
      subject: { kind: "transaction_authorization", subjectId: "txn-9" },
    };
    const result = await cp.ctx.repos.transaction((uow) =>
      settleInteractionSubject(cp.ctx, tampered, uow),
    );
    expect(result).toEqual({ ok: false, reason: "digest_recompute_mismatch" });
    expect(await cp.ctx.repos.outbox.listUnpublished()).toHaveLength(0);
  });
});
