import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import type {
  ApprovalProof,
  Interaction,
  InteractionStatus,
} from "../interaction.js";
import {
  approve,
  awaitApproval,
  canTransition,
  consume,
  deny,
  isTerminal,
  maybeExpire,
  present,
  revoke,
} from "../machines/interaction.js";

const T0 = new Date("2026-08-31T12:00:00Z");
const LATER = new Date("2026-08-31T12:04:00Z");
const AFTER_EXPIRY = new Date("2026-08-31T12:06:00Z");

const DIGEST = "sha256:aa".padEnd(20, "b");

function base(overrides: Partial<Interaction> = {}): Interaction {
  return {
    id: "int_test",
    kind: "authorization_request",
    status: "pending",
    subject: { kind: "authorization_request", subjectId: "areq_1" },
    createdAt: T0,
    expiresAt: new Date(T0.getTime() + 5 * 60_000),
    authorizationDetails: [{ type: "connection_invoke" }],
    requestDigest: DIGEST,
    version: 1,
    ...overrides,
  };
}

/**
 * An interaction that authorizes a session rather than an operation, so it
 * carries no digest at all.
 *
 * Built by omitting the key rather than by assigning `undefined`: the domain
 * type distinguishes "absent" from "present and undefined", and the machine's
 * refusal to accept an unbindable proof depends on telling those apart.
 */
function withoutDigest(overrides: Partial<Interaction> = {}): Interaction {
  const { requestDigest: _absent, ...rest } = base(overrides);
  return rest;
}

function proof(overrides: Partial<ApprovalProof> = {}): ApprovalProof {
  return {
    mechanism: "webauthn",
    boundDigest: DIGEST,
    assurance: "phishing_resistant",
    verifiedAt: LATER,
    ...overrides,
  };
}

const ALL: InteractionStatus[] = [
  "pending",
  "presented",
  "awaiting_approval",
  "approved",
  "denied",
  "consumed",
  "expired",
  "revoked",
];

describe("interaction transitions", () => {
  it("declares exactly four terminal states", () => {
    expect(ALL.filter(isTerminal)).toEqual([
      "denied",
      "consumed",
      "expired",
      "revoked",
    ]);
  });

  it("never reopens a terminal state", () => {
    for (const from of ALL.filter(isTerminal)) {
      for (const to of ALL) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it("only reaches consumed from approved", () => {
    for (const from of ALL) {
      expect(canTransition(from, "consumed")).toBe(from === "approved");
    }
  });

  it("presents idempotently so a rescanned QR is not a second event", () => {
    const once = present(base(), LATER);
    const twice = present(once, LATER);
    expect(once.status).toBe("presented");
    expect(twice).toBe(once);
    expect(twice.version).toBe(once.version);
  });

  it("refuses every transition once the clock has run out", () => {
    const live = awaitApproval(base(), "prn_a", LATER);
    expect(() =>
      approve(live, {
        approverPrincipalId: "prn_a",
        proof: proof(),
        now: AFTER_EXPIRY,
      }),
    ).toThrow(DomainError);
    expect(() => deny(live, "prn_a", AFTER_EXPIRY)).toThrow(DomainError);
    expect(() => present(base(), AFTER_EXPIRY)).toThrow(DomainError);
  });

  it("treats an unreadable expiry as lapsed, not as endless", () => {
    // NaN loses every comparison, so `now >= expiresAt` on an Invalid Date
    // answers "not expired" and the window never closes. The same shape
    // switched off two time checks in the OpenID4VP verifier; here the two
    // halves would also have disagreed — assertLive saying live while
    // maybeExpire said expired.
    const unreadable = base({ expiresAt: new Date(Number.NaN) });
    expect(() => present(unreadable, LATER)).toThrow(/expired/);
    expect(maybeExpire(unreadable, LATER).status).toBe("expired");
  });

  it("projects a lapsed interaction as expired on read", () => {
    expect(maybeExpire(base(), AFTER_EXPIRY).status).toBe("expired");
    expect(maybeExpire(base(), LATER).status).toBe("pending");
    const consumed = base({ status: "consumed" });
    expect(maybeExpire(consumed, AFTER_EXPIRY)).toBe(consumed);
  });
});

describe("digest binding", () => {
  it("accepts a proof bound to this request", () => {
    const live = awaitApproval(base(), "prn_a", LATER);
    const done = approve(live, {
      approverPrincipalId: "prn_a",
      proof: proof(),
      now: LATER,
    });
    expect(done.status).toBe("approved");
    expect(done.approvalProof?.boundDigest).toBe(DIGEST);
  });

  it("refuses a proof minted for a different request", () => {
    const live = awaitApproval(base(), "prn_a", LATER);
    expect(() =>
      approve(live, {
        approverPrincipalId: "prn_a",
        proof: proof({ boundDigest: "sha256:someone-elses-request" }),
        now: LATER,
      }),
    ).toThrow(/bound to a different request/);
  });

  it("refuses a digest-bearing proof when the interaction has no digest", () => {
    // A session kind, so the stricter operation-kind rule is not what refuses
    // this: the point here is that a proof claiming a binding the interaction
    // cannot corroborate is not accepted as if it had been checked.
    const live = awaitApproval(
      withoutDigest({ kind: "device_authorization" }),
      "prn_a",
      LATER,
    );
    expect(() =>
      approve(live, {
        approverPrincipalId: "prn_a",
        proof: proof(),
        now: LATER,
      }),
    ).toThrow(/no digest to bind/);
  });

  it("refuses to approve an operation-authorizing kind with no digest", () => {
    // request_digest is nullable in storage, because half the kinds
    // legitimately have none. So the machine is the only thing standing
    // between a payment with no digest and an approval bound to nothing.
    for (const kind of [
      "authorization_request",
      "transaction_authorization",
      "grant_claim",
    ] as const) {
      const live = awaitApproval(withoutDigest({ kind }), "prn_a", LATER);
      expect(() =>
        approve(live, {
          approverPrincipalId: "prn_a",
          proof: proof({ boundDigest: "", mechanism: "session_reauth" }),
          now: LATER,
        }),
      ).toThrow(/cannot be approved without a request digest/);
    }
  });

  it("admits a digest-free proof for a session-only interaction", () => {
    const live = awaitApproval(
      withoutDigest({ kind: "device_authorization" }),
      "prn_a",
      LATER,
    );
    const done = approve(live, {
      approverPrincipalId: "prn_a",
      proof: proof({ boundDigest: "", mechanism: "session_reauth" }),
      now: LATER,
    });
    expect(done.status).toBe("approved");
  });
});

describe("consumption and revocation", () => {
  it("spends an approval exactly once", () => {
    const approved = approve(awaitApproval(base(), "prn_a", LATER), {
      approverPrincipalId: "prn_a",
      proof: proof(),
      now: LATER,
    });
    const spent = consume(approved, LATER);
    expect(spent.status).toBe("consumed");
    expect(spent.consumedAt).toEqual(LATER);
    expect(() => consume(spent, LATER)).toThrow(DomainError);
  });

  it("refuses to consume an interaction that was never approved", () => {
    expect(() => consume(base({ status: "presented" }), LATER)).toThrow(
      /cannot be consumed from presented/,
    );
  });

  it("lets an approver withdraw an approval before it is spent", () => {
    const approved = approve(awaitApproval(base(), "prn_a", LATER), {
      approverPrincipalId: "prn_a",
      proof: proof(),
      now: LATER,
    });
    const gone = revoke(approved, LATER);
    expect(gone.status).toBe("revoked");
    expect(() => consume(gone, LATER)).toThrow(DomainError);
  });

  it("refuses to revoke something already terminal", () => {
    expect(() => revoke(base({ status: "consumed" }), LATER)).toThrow(
      DomainError,
    );
  });
});
