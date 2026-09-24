/**
 * A fake Identity API for the interaction ceremony: answers by path, not by
 * call order, and records every request so the wire shape is assertable. The
 * shapes and codes are the server's
 * (`packages/control-plane/src/routes/interaction-handoff.ts`,
 * `interaction-activation.ts`).
 */
import type { BoundaryValue, JsonObject } from "@opensesame/os-domain";
import {
  type InteractionAssertion,
  type InteractionAuthenticator,
  createInteractionApproval,
} from "./interaction-approval.js";
import { createInteractionClient } from "./interaction-client.js";

/** Shaped exactly as `isInteractionRef` requires: `i_<base64url>.<tag>`. */
export const REF = "i_AbCdEfGhIjKlMnOpQr.0123456789abcdef";
export const BASE = "https://id.example";
/** The canonical short link: unauthenticated, the URL a camera resolves. */
export const LINK = `${BASE}/i/${REF}`;
/** The versioned API: the approver's view and the two decisions. */
export const API = `${BASE}/v1/interactions/${REF}`;
export const DIGEST = "sha256:8f14e45fceea167a5a36dedd4bea2543";
export const OTHER_DIGEST = "sha256:c4ca4238a0b923820dcc509a6f75849b";
export const ACTIVATION_ID = "apac_test_activation";

export function json(status: number, body: BoundaryValue): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function summaryBody(over: JsonObject = {}): JsonObject {
  return {
    kind: "device_authorization",
    status: "pending",
    expiresAt: "2026-09-01T00:00:00.000Z",
    requiresApprover: true,
    ...over,
  };
}

export function detailBody(over: JsonObject = {}): JsonObject {
  return {
    ...summaryBody(),
    id: "int_1",
    createdAt: "2026-08-31T23:55:00.000Z",
    requesterRef: "inbox_9f2",
    resourceRef: "acme/paperwork",
    bindingMessage: "Match 42",
    requestDigest: DIGEST,
    authorizationDetails: [],
    ...over,
  };
}

export function activationBegin(over: JsonObject = {}): Response {
  return json(201, {
    activationId: ACTIVATION_ID,
    transactionDigest: "td",
    policyDigest: "pd",
    expiresAt: "2026-09-01T00:00:00.000Z",
    options: { challenge: "aGk" },
    ...over,
  });
}

export function activationDone(over: JsonObject = {}): Response {
  return json(200, {
    activationId: ACTIVATION_ID,
    state: "activated",
    activatedAt: "2026-08-31T23:59:00.000Z",
    ...over,
  });
}

/** One answer per route; a function answers afresh on every call. */
export type Routes = Partial<
  Record<
    "resolve" | "detail" | "activation" | "complete" | "approve" | "deny",
    Response | (() => Response)
  >
>;

export type Call = { url: string; init: RequestInit; through: string };

function route(url: string): keyof Routes | null {
  if (url === LINK) return "resolve";
  if (url === API) return "detail";
  if (url.endsWith("/activation/complete")) return "complete";
  if (url.endsWith("/activation")) return "activation";
  if (url.endsWith("/approve")) return "approve";
  if (url.endsWith("/deny")) return "deny";
  return null;
}

export const ASSERTION: InteractionAssertion = {
  credentialId: "cred-1",
  clientDataJSON: "Y2Q",
  authenticatorData: "YWQ",
  signature: "c2ln",
};

/** A fake authenticator: present or not, answering or throwing. */
export function authenticator(
  available = true,
  assert: (options: JsonObject) => Promise<InteractionAssertion> = async () =>
    ASSERTION,
) {
  const seen: JsonObject[] = [];
  const port: InteractionAuthenticator = {
    available: () => available,
    assert: (options) => {
      seen.push(options);
      return assert(options);
    },
  };
  return { port, seen };
}

export type CeremonyOptions = {
  signedIn?: boolean;
  port?: InteractionAuthenticator;
};

/** A ceremony over the real client, a fake wire and a fake authenticator. */
export function ceremony(routes: Routes, options: CeremonyOptions = {}) {
  const calls: Call[] = [];
  let signedIn = options.signedIn ?? false;
  const answer =
    (through: string): typeof fetch =>
    async (input, init) => {
      const url = String(input);
      calls.push({ url, init: init ?? {}, through });
      const name = route(url);
      const found = name === null ? undefined : routes[name];
      if (found === undefined) return json(500, {});
      return found instanceof Response ? found.clone() : found();
    };
  const client = createInteractionClient({
    baseUrl: BASE,
    fetchImpl: answer("session"),
    resolveFetch: answer("anonymous"),
    bearer: () => (signedIn ? "pst_test_token" : null),
  });
  const approval = createInteractionApproval(
    {
      client,
      authenticator: options.port ?? authenticator().port,
      signedIn: () => signedIn,
    },
    REF,
  );
  const signIn = () => {
    signedIn = true;
  };
  const bodyOf = (suffix: string): JsonObject => {
    const call = calls.find(({ url }) => url.endsWith(suffix));
    if (!call) throw new Error(`no call to ${suffix}`);
    return JSON.parse(String(call.init.body));
  };
  return { approval, calls, signIn, bodyOf };
}
