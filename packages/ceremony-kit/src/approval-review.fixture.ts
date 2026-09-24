/**
 * A fake Identity API for the authorization-request review: a queue of
 * answers in the order the ceremony calls, recording every request so the
 * wire shape and the order are assertable. The shapes and codes are the
 * server's (`packages/control-plane/src/routes/authorization-requests.ts`).
 */
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { vi } from "vitest";
import { createApprovalReview } from "./approval-review.js";
import { createAuthorizationRequestClient } from "./authorization-request-client.js";
import type {
  InteractionAssertion,
  InteractionAuthenticator,
} from "./interaction-approval.js";

/** The comparison value a hostile screen would echo. It must appear nowhere. */
export const SECRET_CODE = "424242";
export const DIGEST = "digest-of-what-was-shown-0001";
export const POLICY = "policy-digest";

export const REQUEST = {
  authReqId: "areq_1",
  status: "pending",
  bindingMessage: "Deploy the billing service",
  requestDigest: DIGEST,
  authorizationDetails: [
    { type: "connector", actions: ["deploy"], locations: ["prod-billing"] },
  ],
  expiresAt: "2030-01-01T00:00:00.000Z",
  requesterRef: "req_opaque_7f3",
  requesterKind: "agent",
};

export const REQUIREMENT = {
  riskClass: "critical",
  policyDigest: POLICY,
  requireTransactionBoundActivation: true,
  requireComparison: true,
  required: [
    "subject_kind:human",
    "phishing_resistance",
    "transaction_bound_activation",
    "comparison",
  ],
  maximumApprovalAgeSeconds: 120,
  arrivedVia: "telegram",
};

export const ASSERTION: InteractionAssertion = {
  credentialId: "cred_1",
  clientDataJSON: "Y2xpZW50",
  authenticatorData: "YXV0aA",
  signature: "c2ln",
};

export function json(body: BoundaryValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function challenge(over: JsonObject = {}): Response {
  return json(
    {
      activationId: "act_9",
      transactionDigest: "tx",
      policyDigest: POLICY,
      expiresAt: "2030-01-01T00:00:00.000Z",
      options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
      ...over,
    },
    201,
  );
}

export function confirmed(activationId = "act_9"): Response {
  return json({ activationId, state: "activated" });
}

/** A review over a queue of answers, and a working (or absent) passkey. */
export function reviewHarness(
  options: { authenticator?: boolean; requirement?: JsonObject } = {},
) {
  const queue: Array<Response | Error> = [];
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? json({ error: "unexpected" }, 500);
  });
  const assert = vi.fn(async (_options: JsonObject) => ASSERTION);
  const authenticator: InteractionAuthenticator = {
    available: () => options.authenticator !== false,
    assert,
  };
  const client = createAuthorizationRequestClient({ fetchImpl });
  const review = createApprovalReview({ client, authenticator }, "areq_1");
  return {
    review,
    assert,
    calls,
    /** Queue the load: the request, then its requirement. */
    seedLoad(requirement: JsonObject = options.requirement ?? REQUIREMENT) {
      queue.push(json(REQUEST), json(requirement));
    },
    answer(...responses: Array<Response | Error>) {
      queue.push(...responses);
    },
    paths: () => calls.map((call) => call.path),
    body(index: number): JsonObject {
      return overlapCast(JSON.parse(String(calls[index]?.init.body ?? "null")));
    },
  };
}
