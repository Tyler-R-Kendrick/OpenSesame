import {
  ApprovalRequirementResponseSchema,
  AuthorizationRequestResponseSchema,
  ComparisonChallengeResponseSchema,
  type CreateAuthorizationRequest,
  CreateAuthorizationRequestSchema,
} from "@opensesame/contracts";
import { isJsonObject, isString } from "@opensesame/os-domain";
import { call } from "./directory.js";
import { validateIdentityUrl } from "./host-authorization.js";
import { identityBase } from "./identity.js";

export type AccessRequest = ReturnType<
  typeof AuthorizationRequestResponseSchema.parse
>;
const root = "/v1/authorization-requests";
const path = (id: string) => `${root}/${encodeURIComponent(id)}`;

export function listAccessRequests() {
  return call(root, {}, (body) => {
    if (!isJsonObject(body) || !Array.isArray(body.requests))
      throw new Error("Identity returned an invalid approval inbox.");
    return body.requests.map((row) =>
      AuthorizationRequestResponseSchema.parse(row),
    );
  });
}
export function createAccessRequest(input: CreateAuthorizationRequest) {
  const body = CreateAuthorizationRequestSchema.parse(input);
  return call(root, { method: "POST", body: JSON.stringify(body) }, (value) =>
    AuthorizationRequestResponseSchema.parse(value),
  );
}
export function getAccessRequest(id: string, signal?: AbortSignal) {
  return call(path(id), { signal }, (value) =>
    AuthorizationRequestResponseSchema.parse(value),
  );
}
export function getRequestComparison(id: string) {
  return call(`${path(id)}/comparison`, {}, (value) =>
    ComparisonChallengeResponseSchema.parse(value),
  );
}
export function getInboxRef() {
  return call(`${root}/inbox-ref`, {}, (value) => {
    if (!isJsonObject(value) || !isString(value.approverRef))
      throw new Error("Identity returned an invalid inbox address.");
    return value.approverRef;
  });
}
export function getApprovalRequirement(id: string) {
  return call(`${path(id)}/requirement`, {}, (value) =>
    ApprovalRequirementResponseSchema.parse(value),
  );
}

export const accessApprovalSeams = {
  open: (url: string) =>
    window.open(url, "_blank", "popup,width=540,height=680"),
};

/** Re-resolve policy, then bind authenticator evidence to the reviewed digest. */
export async function decideAccessRequest(
  request: AccessRequest,
  decision: "approve" | "deny",
  comparisonValue: string,
  signal?: AbortSignal,
  hosted = false,
) {
  signal?.throwIfAborted();
  // Open synchronously in the click handler, before any await consumes user activation.
  if (hosted) return hostedDecision(request, decision, signal);
  const requirement = await getApprovalRequirement(request.authReqId);
  signal?.throwIfAborted();
  if (requirement.requireComparison && !/^\d{6}$/.test(comparisonValue))
    throw new Error("Enter the six-digit comparison code from the requester.");
  if (requirement.requireTransactionBoundActivation)
    throw new Error(
      "Approval policy requires an Identity passkey; reload the request and review again.",
    );
  signal?.throwIfAborted();
  return call(
    `${path(request.authReqId)}/${decision}`,
    {
      method: "POST",
      signal,
      body: JSON.stringify({
        requestDigest: request.requestDigest,
        comparisonValue: requirement.requireComparison
          ? comparisonValue
          : undefined,
      }),
    },
    (value) => AuthorizationRequestResponseSchema.parse(value),
  );
}

async function hostedDecision(
  request: AccessRequest,
  decision: "approve" | "deny",
  cancellation?: AbortSignal,
) {
  const identity = new URL(identityBase());
  validateIdentityUrl(identity);
  const remaining = Math.min(
    300000,
    Date.parse(request.expiresAt) - Date.now(),
  );
  if (!Number.isFinite(remaining) || remaining <= 0)
    throw new Error("This request expired.");
  const signal = AbortSignal.any([
    ...(cancellation ? [cancellation] : []),
    AbortSignal.timeout(remaining),
  ]);
  const url = new URL(
    `${identity.href.replace(/\/$/, "")}/v1/approval/ceremony`,
  );
  url.searchParams.set("request", request.authReqId);
  url.searchParams.set("digest", request.requestDigest);
  url.searchParams.set("decision", decision);
  const popup = accessApprovalSeams.open(url.href);
  if (!popup)
    throw new Error("Allow the Identity approval window and try again.");
  try {
    for (;;) {
      signal.throwIfAborted();
      const current = await getAccessRequest(request.authReqId, signal);
      signal.throwIfAborted();
      if (
        current.authReqId !== request.authReqId ||
        current.requestDigest !== request.requestDigest
      )
        throw new Error("The request changed; reload and review again.");
      if (current.status !== "pending") return current;
      if (popup.closed)
        throw new Error(
          "The approval window closed; reload to check the decision.",
        );
      await waitForDecision(signal);
    }
  } finally {
    popup.close();
  }
}

function waitForDecision(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}
