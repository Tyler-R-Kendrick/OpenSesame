import { describe, expect, it } from "vitest";
import type { AuthorizationDetail } from "../authorization-details.js";
import {
  type CanonicalApprovalBinding,
  type CanonicalOperation,
  type CanonicalPresentationRequest,
  INTERACTION_DIGEST_VERSION,
  approvalBindingDigest,
  digestEquals,
  operationDigest,
  presentationRequestDigest,
} from "../crypto/interaction-digests.js";

/**
 * Swarm D — T-17, finding F15 (ADR 0086, ADR 0084).
 *
 * F15: one approval rests on three different digests — what the operation is,
 * which decision was made over it under which policy, and which presentation
 * request a holder answered — and the earlier layer exposed them as one
 * undifferentiated `string`. That is the mix-up that turns "approved *this*"
 * back into "approved *something*": a presentation-request digest passed where
 * an operation digest is wanted compares unequal and fails safe, but a value
 * of the wrong *kind* sneaking through a comparison is a real authority
 * confusion. These tests pin (a) that each digest changes when any covered
 * field changes, (b) that the semantic revision is inside the operation
 * digest, and (c) that the canonicalization is versioned.
 */

function payment(
  overrides: Partial<AuthorizationDetail> = {},
): AuthorizationDetail {
  return {
    type: "payment_initiation",
    amount: { currency: "USD", value: "143.72" },
    payee: { display_name: "Example Vendor" },
    ...overrides,
  };
}

function operation(
  overrides: Partial<CanonicalOperation> = {},
): CanonicalOperation {
  return {
    kind: "transaction_authorization",
    subject: "transaction_authorization:txn_1",
    approverRef: "inbox_abc.def",
    requesterRef: "req_xyz",
    authorizationDetails: [payment()],
    bindingMessage: "Pay 143.72 USD to Example Vendor",
    resourceRef: "res_1",
    expiresAt: "2026-08-31T12:05:00.000Z",
    revision: 0,
    ...overrides,
  };
}

describe("operation digest", () => {
  it("is a versioned sha256 and stable across key order", () => {
    const a = operationDigest(operation());
    const b = operationDigest(
      operation({
        authorizationDetails: [
          {
            payee: { display_name: "Example Vendor" },
            amount: { value: "143.72", currency: "USD" },
            type: "payment_initiation",
          },
        ],
      }),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(INTERACTION_DIGEST_VERSION).toBe(1);
  });

  const mutations: ReadonlyArray<[string, Partial<CanonicalOperation>]> = [
    ["the kind", { kind: "authorization_request" }],
    ["the ceremony", { subject: "transaction_authorization:txn_2" }],
    ["the approver", { approverRef: "inbox_other" }],
    ["the requester", { requesterRef: "req_other" }],
    [
      "the amount",
      {
        authorizationDetails: [
          payment({ amount: { currency: "USD", value: "143.73" } }),
        ],
      },
    ],
    ["the message", { bindingMessage: "Confirm your session" }],
    ["the resource", { resourceRef: "res_2" }],
    ["the window", { expiresAt: "2026-08-31T20:05:00.000Z" }],
    ["the semantic revision", { revision: 1 }],
  ];
  for (const [what, patch] of mutations) {
    it(`changes when ${what} changes`, () => {
      expect(operationDigest(operation(patch))).not.toBe(
        operationDigest(operation()),
      );
    });
  }

  it("does not collide when text moves across a field boundary", () => {
    const a = operationDigest(
      operation({ approverRef: "inbox_a", requesterRef: "bc" }),
    );
    const b = operationDigest(
      operation({ approverRef: "inbox_ab", requesterRef: "c" }),
    );
    expect(a).not.toBe(b);
  });

  it("separates a reverted operation from the earlier revision (F15)", () => {
    // Content reverted to a previously approved state still yields a new
    // digest, because it is a later revision. A proof gathered for revision 0
    // does not carry to the revision-2 revert.
    const original = operationDigest(operation({ revision: 0 }));
    const revertedContentLaterRevision = operationDigest(
      operation({ revision: 2 }),
    );
    expect(revertedContentLaterRevision).not.toBe(original);
  });
});

describe("approval-binding digest (ADR 0084)", () => {
  function binding(
    overrides: Partial<CanonicalApprovalBinding> = {},
  ): CanonicalApprovalBinding {
    return {
      operation: operationDigest(operation()),
      verb: "approve",
      policyDigest: "sha256:policy",
      ...overrides,
    };
  }

  it("is a versioned sha256 distinct from its operation digest", () => {
    const d = approvalBindingDigest(binding());
    expect(d).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The binding is not the operation it binds: a value of one kind must not
    // read equal to the other.
    expect(d).not.toBe(operationDigest(operation()));
  });

  const bindingMutations: ReadonlyArray<
    [string, Partial<CanonicalApprovalBinding>]
  > = [
    [
      "the operation",
      { operation: operationDigest(operation({ revision: 1 })) },
    ],
    ["the verb", { verb: "deny" }],
    ["the policy", { policyDigest: "sha256:other-policy" }],
  ];
  for (const [what, patch] of bindingMutations) {
    it(`changes when ${what} changes`, () => {
      expect(approvalBindingDigest(binding(patch))).not.toBe(
        approvalBindingDigest(binding()),
      );
    });
  }
});

describe("presentation-request digest (OpenID4VP)", () => {
  function request(
    overrides: Partial<CanonicalPresentationRequest> = {},
  ): CanonicalPresentationRequest {
    return {
      verifierOrigin: "https://verifier.example",
      clientId: "client_1",
      nonce: "nonce_1",
      responseUri: "https://verifier.example/cb",
      requestedClaims: ["given_name", "family_name"],
      purpose: "Prove you are over 18",
      ...overrides,
    };
  }

  it("is a versioned sha256", () => {
    expect(presentationRequestDigest(request())).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
  });

  const requestMutations: ReadonlyArray<
    [string, Partial<CanonicalPresentationRequest>]
  > = [
    ["the verifier origin", { verifierOrigin: "https://evil.example" }],
    ["the client id", { clientId: "client_2" }],
    ["the nonce", { nonce: "nonce_2" }],
    ["the response uri", { responseUri: "https://verifier.example/other" }],
    ["the requested claims", { requestedClaims: ["given_name"] }],
    ["the purpose", { purpose: "Prove your address" }],
    ["the bound operation", { operation: operationDigest(operation()) }],
  ];
  for (const [what, patch] of requestMutations) {
    it(`changes when ${what} changes`, () => {
      expect(presentationRequestDigest(request(patch))).not.toBe(
        presentationRequestDigest(request()),
      );
    });
  }

  it("reorders requested claims into a different digest", () => {
    const forward = presentationRequestDigest(
      request({ requestedClaims: ["a", "b"] }),
    );
    const backward = presentationRequestDigest(
      request({ requestedClaims: ["b", "a"] }),
    );
    expect(forward).not.toBe(backward);
  });
});

describe("digestEquals", () => {
  it("matches only an identical digest of the same brand", () => {
    const d = operationDigest(operation());
    expect(digestEquals(d, d)).toBe(true);
    const other = operationDigest(operation({ revision: 9 }));
    expect(digestEquals(d, other)).toBe(false);
  });
});
