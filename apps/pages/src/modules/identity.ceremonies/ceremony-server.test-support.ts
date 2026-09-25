/**
 * A stand-in Identity API for the `/i/:ref` and `/approve/:ref` route tests
 * that binds an activation the way the authority does (ADR 0084 §5, ADR 0086
 * §4): each activation records the request digest, the decision verb and the
 * effective policy digest it was minted under, and a settle is refused when
 * the request, the verb or the policy is not that one — the same codes
 * `packages/control-plane` answers with. A test moves the request or the
 * policy under the ceremony and reads what the screen does about it.
 */
import type { ApprovalTransport } from "@opensesame/app-core/lib/approvals.js";
import type {
  InteractionAuthenticator,
  InteractionTransport,
} from "@opensesame/app-core/lib/interactions.js";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
} from "@opensesame/os-domain";
import { vi } from "vitest";

export const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";
export const AREQ = "areq_evidence0000000000001";
export const DIGEST = "v2:digest-of-what-was-shown";
export const OTHER_DIGEST = "v2:digest-of-something-else";
export const POLICY = "v1:policy-shown";
export const OTHER_POLICY = "v1:policy-tightened";

type Decision = "approved" | "denied";
type Activation = { digest: string; decision: Decision; policy: string };

function json(status: number, body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function bodyOf(init: RequestInit): JsonObject {
  const parsed: BoundaryValue = JSON.parse(String(init.body ?? "{}"));
  return isJsonObject(parsed) ? parsed : {};
}

function newState() {
  return {
    digest: DIGEST,
    policy: POLICY,
    /** The verb the next activation is recorded under, when a test forges one. */
    forgeDecision: null as Decision | null,
    /** Runs after an activation is verified: move the request or policy here. */
    afterActivation: () => {},
    signedIn: true,
    comparison: "123456",
    requireActivation: true,
    requireComparison: true,
  };
}

type Server = {
  state: ReturnType<typeof newState>;
  activations: Map<string, Activation>;
  minted: number;
};

function detail(server: Server, status = "pending") {
  return {
    kind: "authorization_request",
    status,
    expiresAt: "2030-01-01T00:00:00.000Z",
    requiresApprover: true,
    id: "int_1",
    createdAt: "2026-09-25T00:00:00.000Z",
    requesterRef: "inbox_9f2",
    bindingMessage: "Match 42",
    requestDigest: server.state.digest,
    authorizationDetails: [],
  };
}

function request(server: Server, status = "pending") {
  const { state } = server;
  return {
    authReqId: AREQ,
    status,
    bindingMessage: "Deploy the billing service",
    requestDigest: state.digest,
    authorizationDetails: [
      { type: "connector", actions: ["deploy"], locations: ["prod-billing"] },
    ],
    expiresAt: "2030-01-01T00:00:00.000Z",
    requesterRef: "req_opaque_7f3",
    requesterKind: "agent",
    approval: {
      riskClass: "high",
      requireTransactionBoundActivation: state.requireActivation,
      requireComparison: state.requireComparison,
      required: ["phishing_resistance", "transaction_bound_activation"],
    },
  };
}

function mint(server: Server, body: JsonObject): Response {
  const { state } = server;
  if (body.requestDigest !== state.digest) {
    return json(409, { error: "digest_mismatch" });
  }
  const id = `act_${++server.minted}`;
  const asked = body.decision === "denied" ? "denied" : "approved";
  const decision = state.forgeDecision ?? asked;
  server.activations.set(id, {
    digest: state.digest,
    decision,
    policy: state.policy,
  });
  return json(201, {
    activationId: id,
    transactionDigest: `tx:${id}`,
    policyDigest: state.policy,
    expiresAt: "2030-01-01T00:00:00.000Z",
    options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
  });
}

function complete(server: Server, body: JsonObject): Response {
  const id = String(body.activationId ?? "");
  if (!server.activations.has(id)) {
    return json(404, { error: "activation_not_found" });
  }
  server.state.afterActivation();
  return json(200, { activationId: id, state: "activated" });
}

/** Which of digest, verb and policy an activation fails, if any. */
function unusableBy(
  server: Server,
  activation: Activation,
  verb: Decision,
): string | null {
  if (activation.digest !== server.state.digest) return "digest_mismatch";
  if (activation.decision !== verb) return "activation_wrong_decision";
  if (activation.policy !== server.state.policy) {
    return "activation_policy_changed";
  }
  return null;
}

/**
 * The authority's settle check: this request, this verb, this policy. The
 * interaction route answers every unusable activation `proof_required`
 * (`interaction-activation-spend.ts`); the authorization-request route names
 * the refusal (`activation_wrong_decision`, `activation_policy_changed`).
 */
function spend(
  server: Server,
  body: JsonObject,
  verb: Decision,
  named: boolean,
): Response | null {
  if (body.requestDigest !== server.state.digest) {
    return json(409, { error: "digest_mismatch" });
  }
  if (body.activationId === undefined) return null;
  const id = String(body.activationId);
  const activation = server.activations.get(id);
  if (!activation) return json(401, { error: "activation_not_found" });
  server.activations.delete(id);
  const refused = unusableBy(server, activation, verb);
  if (refused === null) return null;
  if (refused === "digest_mismatch" || named) {
    return json(409, { error: refused });
  }
  return json(401, { error: "proof_required" });
}

function interaction(
  server: Server,
  method: string,
  path: string,
  body: JsonObject,
): Response | null {
  const api = `/v1/interactions/${REF}`;
  if (method === "GET" && (path === `/i/${REF}` || path === api)) {
    return json(200, detail(server));
  }
  if (path === `${api}/activation`) return mint(server, body);
  if (path === `${api}/activation/complete`) return complete(server, body);
  if (path === `${api}/approve`) {
    if (body.activationId === undefined) {
      return json(401, { error: "proof_required" });
    }
    const refused = spend(server, body, "approved", false);
    return refused ?? json(200, detail(server, "approved"));
  }
  if (path === `${api}/deny`) {
    const refused = spend(server, body, "denied", false);
    return refused ?? json(200, detail(server, "denied"));
  }
  return null;
}

function settleRequest(
  server: Server,
  body: JsonObject,
  decision: Decision,
): Response {
  const { state } = server;
  if (state.requireActivation && body.activationId === undefined) {
    return json(401, { error: "activation_required" });
  }
  if (state.requireComparison && body.comparisonValue !== state.comparison) {
    return json(409, { error: "comparison_mismatch" });
  }
  return (
    spend(server, body, decision, true) ?? json(200, request(server, decision))
  );
}

function review(
  server: Server,
  method: string,
  path: string,
  body: JsonObject,
): Response | null {
  const at = `/v1/authorization-requests/${AREQ}`;
  const get = method === "GET";
  if (get && path === "/v1/authorization-requests?status=pending") {
    return json(200, { requests: [request(server)] });
  }
  if (get && path === at) return json(200, request(server));
  if (get && path === `${at}/requirement`) {
    return json(200, {
      ...request(server).approval,
      policyDigest: server.state.policy,
      maximumApprovalAgeSeconds: 120,
      arrivedVia: "telegram",
    });
  }
  if (path === `${at}/activation`) return mint(server, body);
  if (path === `${at}/activation/complete`) return complete(server, body);
  if (path === `${at}/report`) return json(200, request(server, "denied"));
  if (path === `${at}/approve`) return settleRequest(server, body, "approved");
  if (path === `${at}/deny`) return settleRequest(server, body, "denied");
  return null;
}

function answer(
  server: Server,
  method: string,
  path: string,
  body: JsonObject,
) {
  if (!server.state.signedIn && !path.startsWith("/i/")) {
    return json(401, { error: "unauthorized" });
  }
  return (
    interaction(server, method, path, body) ??
    review(server, method, path, body) ??
    json(404, { error: "not_found" })
  );
}

function testAuthenticator() {
  const assert = vi.fn(async (_options: JsonObject) => ({
    credentialId: "cred_1",
    clientDataJSON: "Y2xpZW50",
    authenticatorData: "YXV0aA",
    signature: "c2ln",
  }));
  const authenticator: InteractionAuthenticator = {
    available: () => true,
    assert,
  };
  return { assert, authenticator };
}

export function ceremonyServer() {
  const server: Server = {
    state: newState(),
    activations: new Map(),
    minted: 0,
  };
  const { state } = server;
  const calls: Array<{ method: string; path: string; body: JsonObject }> = [];
  const fetch = vi.fn(async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = method === "GET" ? {} : bodyOf(init);
    calls.push({ method, path, body });
    return answer(server, method, path, body);
  });
  const interactionTransport: InteractionTransport = {
    fetch: (path, init) => fetch(path, init),
    anonymous: (path, init) => fetch(path, init),
    signedIn: () => state.signedIn,
  };
  const approvalTransport: ApprovalTransport = {
    fetch: (path, init) => fetch(path, init),
    signedIn: () => state.signedIn,
  };
  return {
    state,
    calls,
    fetch,
    ...testAuthenticator(),
    interactionTransport,
    approvalTransport,
    /** The paths called, in order. */
    paths: () => calls.map((call) => `${call.method} ${call.path}`),
  };
}
