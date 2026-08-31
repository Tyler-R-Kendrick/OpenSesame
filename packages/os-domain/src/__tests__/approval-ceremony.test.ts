import { describe, expect, it } from "vitest";
import {
  type ApprovalActivation,
  type ComparisonChallenge,
  approvalPolicyDigest,
  approvalTransactionDigest,
  authorizationRequestDigest,
  digestsEqual,
  evaluateActivation,
  evaluateComparison,
} from "../approval-ceremony.js";
import type { JsonObject } from "../json.js";

const NOW = new Date("2026-08-31T12:00:00Z");

function baseDigestInput() {
  return {
    principalId: "prn_approver",
    requesterRef: "req_abc",
    authorizationDetails: [
      { type: "connection_delegation", actions: ["read"], locations: ["a"] },
    ] as JsonObject[],
    bindingMessage: "Deploy to production",
  };
}

describe("authorization request digest", () => {
  it("property: key order in authorization details cannot change the digest", () => {
    // The reason v1 was replaced. An executor recomputes this digest from the
    // details it is about to act on; if serialization order mattered, the
    // check ADR 0046 promises could never actually run.
    const a = authorizationRequestDigest({
      ...baseDigestInput(),
      authorizationDetails: [
        { type: "x", actions: ["read"], identifier: "i" },
      ],
    });
    const b = authorizationRequestDigest({
      ...baseDigestInput(),
      authorizationDetails: [
        { identifier: "i", actions: ["read"], type: "x" },
      ],
    });
    expect(a).toBe(b);
  });

  it("property: array order in authorization details DOES change the digest", () => {
    // Arrays are ordered in RFC 9396; "read then write" is not "write then
    // read", and canonicalization must not flatten that distinction.
    const a = authorizationRequestDigest({
      ...baseDigestInput(),
      authorizationDetails: [{ type: "x", actions: ["read", "write"] }],
    });
    const b = authorizationRequestDigest({
      ...baseDigestInput(),
      authorizationDetails: [{ type: "x", actions: ["write", "read"] }],
    });
    expect(a).not.toBe(b);
  });

  it("adversarial: text cannot be moved across a field boundary", () => {
    // Length prefixes. Without them, a binding message ending where a
    // connection id begins would collide with the reverse split.
    const a = authorizationRequestDigest({
      ...baseDigestInput(),
      bindingMessage: "abc",
      connectionId: "def",
    });
    const b = authorizationRequestDigest({
      ...baseDigestInput(),
      bindingMessage: "abcdef",
      connectionId: "",
    });
    expect(a).not.toBe(b);
  });

  it("property: changing any single input changes the digest", () => {
    const base = authorizationRequestDigest(baseDigestInput());
    const mutations = [
      { ...baseDigestInput(), principalId: "prn_other" },
      { ...baseDigestInput(), requesterRef: "req_other" },
      { ...baseDigestInput(), bindingMessage: "Deploy to staging" },
      { ...baseDigestInput(), connectionId: "conn_1" },
      { ...baseDigestInput(), delegationId: "dlg_1" },
      {
        ...baseDigestInput(),
        authorizationDetails: [{ type: "other" }] as JsonObject[],
      },
    ];
    for (const mutation of mutations) {
      expect(authorizationRequestDigest(mutation)).not.toBe(base);
    }
  });

  it("contract: the digest names its version", () => {
    expect(authorizationRequestDigest(baseDigestInput())).toMatch(/^v2:[0-9a-f]{64}$/);
  });
});

describe("approval transaction digest", () => {
  const tx = {
    authReqId: "areq_1",
    requestDigest: "v2:abc",
    approverPrincipalId: "prn_approver",
    decision: "approved" as const,
    policyDigest: "v1:policy",
    channelKind: "in_app" as const,
  };

  it("adversarial: an activation for deny cannot be spent as approve", () => {
    // The decision is in the signed transcript. Without it, the person proved
    // presence and the server would supply the verb.
    expect(approvalTransactionDigest(tx)).not.toBe(
      approvalTransactionDigest({ ...tx, decision: "denied" }),
    );
  });

  it("adversarial: an activation for one request cannot authorize another", () => {
    expect(approvalTransactionDigest(tx)).not.toBe(
      approvalTransactionDigest({ ...tx, authReqId: "areq_2" }),
    );
    expect(approvalTransactionDigest(tx)).not.toBe(
      approvalTransactionDigest({ ...tx, requestDigest: "v2:different" }),
    );
  });

  it("adversarial: a tightened policy invalidates an activation minted under the old one", () => {
    expect(approvalTransactionDigest(tx)).not.toBe(
      approvalTransactionDigest({ ...tx, policyDigest: "v1:stricter" }),
    );
  });

  it("adversarial: one principal's activation cannot settle another's request", () => {
    expect(approvalTransactionDigest(tx)).not.toBe(
      approvalTransactionDigest({ ...tx, approverPrincipalId: "prn_other" }),
    );
  });

  it("property: the policy digest is stable under key reordering", () => {
    const a: JsonObject = { requireComparison: true, riskClass: "high" };
    const b: JsonObject = { riskClass: "high", requireComparison: true };
    expect(approvalPolicyDigest(a)).toBe(approvalPolicyDigest(b));
  });

  it("contract: digestsEqual rejects unequal lengths without throwing", () => {
    expect(digestsEqual("short", "much longer value")).toBe(false);
    expect(digestsEqual("same", "same")).toBe(true);
  });
});

describe("activation", () => {
  function activation(
    overrides: Partial<ApprovalActivation> = {},
  ): ApprovalActivation {
    return {
      id: "act_1",
      authReqId: "areq_1",
      principalId: "prn_approver",
      transactionDigest: "v1:tx",
      decision: "approved",
      policyDigest: "v1:policy",
      channelKind: "in_app",
      challengeDigest: "sha256:chal",
      state: "activated",
      createdAt: new Date(NOW.getTime() - 30_000),
      activatedAt: new Date(NOW.getTime() - 10_000),
      expiresAt: new Date(NOW.getTime() + 60_000),
      version: 1,
      ...overrides,
    };
  }

  const check = {
    authReqId: "areq_1",
    principalId: "prn_approver",
    decision: "approved" as const,
    expectedTransactionDigest: "v1:tx",
    expectedPolicyDigest: "v1:policy",
    maximumApprovalAgeSeconds: 300,
    now: NOW,
  };

  it("contract: a fresh, matching, activated activation may be spent", () => {
    expect(
      evaluateActivation({ ...check, activation: activation() }).permitted,
    ).toBe(true);
  });

  it("adversarial: a missing activation fails closed", () => {
    const result = evaluateActivation(check);
    expect(result.permitted).toBe(false);
    expect(result.refusals).toContain("activation_not_found");
  });

  it("property: every single mismatch refuses, one at a time", () => {
    const cases: { name: string; activation: ApprovalActivation }[] = [
      { name: "request", activation: activation({ authReqId: "areq_2" }) },
      { name: "principal", activation: activation({ principalId: "prn_x" }) },
      { name: "decision", activation: activation({ decision: "denied" }) },
      { name: "transaction", activation: activation({ transactionDigest: "v1:other" }) },
      { name: "policy", activation: activation({ policyDigest: "v1:other" }) },
      { name: "unactivated", activation: activation({ state: "pending" }) },
      { name: "consumed", activation: activation({ state: "consumed" }) },
      {
        name: "expired",
        activation: activation({ expiresAt: new Date(NOW.getTime() - 1) }),
      },
    ];
    for (const c of cases) {
      const result = evaluateActivation({ ...check, activation: c.activation });
      expect(result.permitted, c.name).toBe(false);
    }
  });

  it("adversarial: a spent activation cannot be spent again", () => {
    const result = evaluateActivation({
      ...check,
      activation: activation({ state: "consumed", consumedAt: NOW }),
    });
    expect(result.refusals).toContain("activation_already_consumed");
  });

  it("adversarial: freshness is measured from the proof, not from the row", () => {
    // Created long ago but answered a moment ago: fresh. Answered long ago
    // and presented now: stale. The clock that matters is the person's.
    const answeredLongAgo = activation({
      createdAt: new Date(NOW.getTime() - 10_000),
      activatedAt: new Date(NOW.getTime() - 600_000),
      expiresAt: new Date(NOW.getTime() + 60_000),
    });
    expect(
      evaluateActivation({ ...check, activation: answeredLongAgo }).refusals,
    ).toContain("activation_expired");

    const answeredJustNow = activation({
      createdAt: new Date(NOW.getTime() - 600_000),
      activatedAt: new Date(NOW.getTime() - 1_000),
    });
    expect(
      evaluateActivation({ ...check, activation: answeredJustNow }).permitted,
    ).toBe(true);
  });
});

describe("comparison", () => {
  function challenge(
    overrides: Partial<ComparisonChallenge> = {},
  ): ComparisonChallenge {
    return {
      id: "cmp_1",
      authReqId: "areq_1",
      valueDigest: "hmac:correct",
      attempts: 0,
      maxAttempts: 5,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 120_000),
      version: 1,
      ...overrides,
    };
  }

  it("contract: the right value satisfies it", () => {
    expect(
      evaluateComparison({
        challenge: challenge(),
        presentedDigest: "hmac:correct",
        now: NOW,
      }).satisfied,
    ).toBe(true);
  });

  it("adversarial: a wrong value does not satisfy it", () => {
    const result = evaluateComparison({
      challenge: challenge(),
      presentedDigest: "hmac:wrong--",
      now: NOW,
    });
    expect(result.satisfied).toBe(false);
    expect(result.refusal).toBe("comparison_mismatch");
  });

  it("adversarial: an exhausted budget refuses before comparing", () => {
    // The budget is checked first on purpose: a comparison that still runs
    // after the budget is spent is an oracle with unlimited tries.
    const result = evaluateComparison({
      challenge: challenge({ attempts: 5 }),
      presentedDigest: "hmac:correct",
      now: NOW,
    });
    expect(result.satisfied).toBe(false);
    expect(result.refusal).toBe("comparison_exhausted");
  });

  it("adversarial: an expired challenge refuses even with the right value", () => {
    expect(
      evaluateComparison({
        challenge: challenge({ expiresAt: new Date(NOW.getTime() - 1) }),
        presentedDigest: "hmac:correct",
        now: NOW,
      }).refusal,
    ).toBe("comparison_expired");
  });

  it("adversarial: a satisfied challenge cannot be replayed", () => {
    expect(
      evaluateComparison({
        challenge: challenge({ satisfiedAt: NOW }),
        presentedDigest: "hmac:correct",
        now: NOW,
      }).refusal,
    ).toBe("comparison_already_satisfied");
  });

  it("adversarial: a missing challenge fails closed", () => {
    expect(
      evaluateComparison({ presentedDigest: "hmac:correct", now: NOW }).refusal,
    ).toBe("comparison_not_found");
  });
});
