import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  canTransition,
  maybeExpire,
  settle,
} from "../machines/authorization-request.js";
import type {
  AuthorizationRequest,
  AuthorizationRequestStatus,
} from "../types.js";

const T0 = new Date("2026-08-19T12:00:00Z");
const LATER = new Date("2026-08-19T12:04:00Z");
const AFTER_EXPIRY = new Date("2026-08-19T12:06:00Z");

function pending(
  overrides: Partial<AuthorizationRequest> = {},
): AuthorizationRequest {
  return {
    id: "areq_1",
    principalId: "prn_approver",
    requesterRef: "req_opaque",
    authorizationDetails: [{ type: "connection_delegation" }],
    requestDigest: "a".repeat(64),
    bindingMessage: "Read acme/catalog issues",
    status: "pending",
    intervalSeconds: 5,
    createdAt: T0,
    expiresAt: new Date(T0.getTime() + 5 * 60_000),
    version: 1,
    ...overrides,
  };
}

const TERMINAL: AuthorizationRequestStatus[] = [
  "approved",
  "denied",
  "expired",
  "cancelled",
];

describe("authorization request transitions", () => {
  it("property: pending reaches every outcome and terminals reach none", () => {
    for (const to of TERMINAL) {
      expect(canTransition("pending", to)).toBe(true);
    }
    for (const from of TERMINAL) {
      for (const to of TERMINAL) {
        expect(canTransition(from, to)).toBe(false);
      }
      expect(canTransition(from, "pending")).toBe(false);
    }
  });

  it("contract: settling records who decided and how, and bumps the version", () => {
    const settled = settle(pending(), {
      status: "approved",
      decidedByPrincipalId: "prn_approver",
      decidedByKind: "human",
      now: LATER,
    });
    expect(settled.status).toBe("approved");
    expect(settled.decidedAt).toEqual(LATER);
    expect(settled.decidedByPrincipalId).toBe("prn_approver");
    // An agent-settled decision must never be indistinguishable from a
    // person's, so the kind is stored rather than inferred.
    expect(settled.decidedByKind).toBe("human");
    expect(settled.version).toBe(2);
  });

  it("adversarial: a decided request cannot be decided again", () => {
    const approved = settle(pending(), {
      status: "approved",
      decidedByPrincipalId: "prn_approver",
      decidedByKind: "human",
      now: LATER,
    });
    expect(() =>
      settle(approved, {
        status: "denied",
        decidedByPrincipalId: "prn_approver",
        decidedByKind: "human",
        now: LATER,
      }),
    ).toThrow(DomainError);
  });

  it("adversarial: a lapsed request cannot be approved between sweeps", () => {
    // Expiry is enforced on the transition, not only by a reaper, so a late
    // approval cannot slip through while the sweeper is idle.
    expect(() =>
      settle(pending(), {
        status: "approved",
        decidedByPrincipalId: "prn_approver",
        decidedByKind: "human",
        now: AFTER_EXPIRY,
      }),
    ).toThrow(/expired/i);
  });

  it("chaos: lazy expiry is idempotent and never reopens a decision", () => {
    const lapsed = maybeExpire(pending(), AFTER_EXPIRY);
    expect(lapsed.status).toBe("expired");
    // Re-reading an already-expired row must not keep bumping its version.
    expect(maybeExpire(lapsed, AFTER_EXPIRY)).toEqual(lapsed);

    const approved = settle(pending(), {
      status: "approved",
      decidedByPrincipalId: "prn_approver",
      decidedByKind: "human",
      now: LATER,
    });
    // A request that was answered is not the same as one that lapsed, and a
    // reviewer must be able to tell them apart afterwards.
    expect(maybeExpire(approved, AFTER_EXPIRY).status).toBe("approved");
  });

  it("property: a request read before its deadline is untouched", () => {
    const live = pending();
    expect(maybeExpire(live, LATER)).toEqual(live);
  });
});
