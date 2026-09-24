import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import type {
  ApprovalAssurance,
  AuthorizationDetailView,
} from "./approval-copy.js";
import {
  ApprovalError,
  approvalRefusal,
  approvalWords,
} from "./approval-words.js";
import type { InteractionAssertion } from "./interaction-approval.js";

/**
 * The authorization-request routes a person decides from (ADR 0046, ADR
 * 0084): the pending list, one request, its requirement, the activation's
 * begin and complete, the two settle verbs and the "I don't recognize this"
 * report. Moved out of `apps/ceremonies/src/lib/approvals.ts` (ADR 0140 plan
 * step 6).
 *
 * The transport is injected, so each surface brings its own session: Pages
 * passes `identityFetch`, which attaches the bearer itself. Nothing here holds
 * a credential, and none rides in a URL — a path carries a request id and a
 * list filter, nothing else.
 *
 * Each response is read into a view field by field. A body that grew a field
 * — a provider subject id, a token, a comparison value echoed by a careless
 * server — has nowhere to go: the view has no slot for it, so no surface can
 * render it.
 */

export type ApprovalVerb = "approve" | "deny";

/** One waiting request, as the inbox and the review both read it. */
export interface AuthorizationRequestView {
  authReqId: string;
  status: string;
  bindingMessage: string;
  requestDigest: string;
  authorizationDetails: AuthorizationDetailView[];
  expiresAt: string;
  /** Opaque handle for whoever is asking. Never a raw principal id. */
  requesterRef?: string;
  requesterKind?: string;
  /** What settling will take, when the server summarized it; else `null`. */
  assurance: ApprovalAssurance | null;
}

/** What the approver must do (`ApprovalRequirementResponseSchema`). */
export interface ApprovalRequirement extends ApprovalAssurance {
  riskClass: string;
  policyDigest: string;
  maximumApprovalAgeSeconds: number;
  /** Which channel brought the approver here, when one did. */
  arrivedVia?: string;
}

/** `BeginApprovalActivationResponseSchema`: the challenge, never a proof. */
export interface ApprovalActivationChallenge {
  activationId: string;
  transactionDigest: string;
  policyDigest: string;
  expiresAt: string;
  /** The authority's WebAuthn request options, passed on unaltered. */
  options: JsonObject;
}

export interface SettleInput {
  requestDigest: string;
  /** Names an activation the server already verified; never re-proves it. */
  activationId?: string;
  /** Submitted here and nowhere else; never read back. */
  comparisonValue?: string;
}

export interface AuthorizationRequestClientOptions {
  /** A same-plane request; `path` is relative to the Identity API base. */
  fetchImpl(path: string, init: RequestInit): Promise<Response>;
}

const str = (value: BoundaryValue | undefined): string | undefined =>
  isString(value) ? value : undefined;

function strings(value: BoundaryValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const read: string[] = [];
  for (const entry of value) if (isString(entry)) read.push(entry);
  return read;
}

function detailOf(value: BoundaryValue): AuthorizationDetailView | null {
  if (!isJsonObject(value) || !isString(value.type)) return null;
  const actions = strings(value.actions);
  const locations = strings(value.locations);
  const identifier = str(value.identifier);
  return {
    type: value.type,
    ...(actions ? { actions } : undefined),
    ...(locations ? { locations } : undefined),
    ...(identifier ? { identifier } : undefined),
  };
}

function assuranceFrom(source: JsonObject): ApprovalAssurance | null {
  const activation = source.requireTransactionBoundActivation;
  const comparison = source.requireComparison;
  if (typeof activation !== "boolean" || typeof comparison !== "boolean") {
    return null;
  }
  const riskClass = str(source.riskClass);
  return {
    ...(riskClass ? { riskClass } : undefined),
    requireTransactionBoundActivation: activation,
    requireComparison: comparison,
    required:
      strings(source.required) ?? strings(source.requiredAssurance) ?? [],
  };
}

/**
 * The server's summary sits under `approval` (`toResponse`); an older shape
 * put it on the row itself. Either is read, and a row with neither says so
 * (`null`) rather than being taken to need nothing.
 */
function assuranceOf(body: JsonObject): ApprovalAssurance | null {
  const nested = body.approval;
  return (
    (isJsonObject(nested) ? assuranceFrom(nested) : null) ?? assuranceFrom(body)
  );
}

export function readAuthorizationRequest(
  value: BoundaryValue,
): AuthorizationRequestView | null {
  if (!isJsonObject(value)) return null;
  const { authReqId, requestDigest, bindingMessage, expiresAt } = value;
  if (!isString(authReqId) || !isString(requestDigest)) return null;
  const details = Array.isArray(value.authorizationDetails)
    ? value.authorizationDetails.map(detailOf)
    : [];
  const requesterRef = str(value.requesterRef);
  const requesterKind = str(value.requesterKind);
  return {
    authReqId,
    status: str(value.status) ?? "pending",
    bindingMessage: isString(bindingMessage) ? bindingMessage : "",
    requestDigest,
    authorizationDetails: details.filter((d) => d !== null),
    expiresAt: isString(expiresAt) ? expiresAt : "",
    ...(requesterRef ? { requesterRef } : undefined),
    ...(requesterKind ? { requesterKind } : undefined),
    assurance: assuranceOf(value),
  };
}

function readRequirement(value: JsonObject): ApprovalRequirement | null {
  const assurance = assuranceFrom(value);
  const policyDigest = str(value.policyDigest);
  if (!assurance || !policyDigest) return null;
  const age = value.maximumApprovalAgeSeconds;
  const arrivedVia = str(value.arrivedVia);
  return {
    ...assurance,
    riskClass: assurance.riskClass ?? "high",
    policyDigest,
    maximumApprovalAgeSeconds: typeof age === "number" ? age : 0,
    ...(arrivedVia ? { arrivedVia } : undefined),
  };
}

function readChallenge(value: JsonObject): ApprovalActivationChallenge | null {
  const { activationId, transactionDigest, policyDigest, options } = value;
  if (
    !isString(activationId) ||
    !isString(policyDigest) ||
    !isJsonObject(options)
  ) {
    return null;
  }
  return {
    activationId,
    transactionDigest: str(transactionDigest) ?? "",
    policyDigest,
    expiresAt: str(value.expiresAt) ?? "",
    options,
  };
}

/** An answer the client could not read: nothing may be assumed from it. */
function malformed(): ApprovalError {
  return new ApprovalError(approvalWords("failed"));
}

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
};

export function createAuthorizationRequestClient(
  options: AuthorizationRequestClientOptions,
) {
  async function call(path: string, init: RequestInit): Promise<JsonObject> {
    let res: Response;
    try {
      res = await options.fetchImpl(path, {
        ...init,
        headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
      });
    } catch {
      throw new ApprovalError(approvalWords("unreachable"));
    }
    const body: BoundaryValue = await res.json().catch(() => null);
    const read = isJsonObject(body) ? body : {};
    if (res.ok) return read;
    const code = str(read.error) ?? "";
    throw new ApprovalError(
      approvalRefusal(code, res.status),
      res.status,
      code,
    );
  }

  const at = (id: string, tail = "") =>
    `/v1/authorization-requests/${encodeURIComponent(id)}${tail}`;
  const post = (body: JsonObject): RequestInit => ({
    method: "POST",
    body: JSON.stringify(body),
  });

  return {
    async listPending(): Promise<AuthorizationRequestView[]> {
      const body = await call("/v1/authorization-requests?status=pending", {
        method: "GET",
      });
      const rows = Array.isArray(body.requests) ? body.requests : [];
      return rows.map(readAuthorizationRequest).filter((row) => row !== null);
    },
    async read(id: string): Promise<AuthorizationRequestView> {
      const view = readAuthorizationRequest(
        await call(at(id), { method: "GET" }),
      );
      if (!view) throw malformed();
      return view;
    },
    async requirement(id: string): Promise<ApprovalRequirement> {
      const body = await call(at(id, "/requirement"), { method: "GET" });
      const requirement = readRequirement(body);
      if (!requirement) throw malformed();
      return requirement;
    },
    /** Mint an activation bound to the digest shown and the verb. */
    async beginActivation(
      id: string,
      verb: ApprovalVerb,
      requestDigest: string,
    ): Promise<ApprovalActivationChallenge> {
      const decision = verb === "approve" ? "approved" : "denied";
      const body = await call(
        at(id, "/activation"),
        post({ decision, requestDigest }),
      );
      const challenge = readChallenge(body);
      if (!challenge) throw malformed();
      return challenge;
    },
    /** Hand the raw assertion in for verification; answers the activation id. */
    async completeActivation(
      id: string,
      activationId: string,
      assertion: InteractionAssertion,
    ): Promise<string | null> {
      const body = await call(
        at(id, "/activation/complete"),
        post({ activationId, ...assertion }),
      );
      return str(body.activationId) ?? null;
    },
    /** Settle, naming the activation rather than re-proving it. */
    async settle(
      id: string,
      verb: ApprovalVerb,
      input: SettleInput,
    ): Promise<AuthorizationRequestView | null> {
      const body = await call(at(id, `/${verb}`), post({ ...input }));
      return readAuthorizationRequest(body);
    },
    /** "I don't recognize this": refuses the request and raises an event. */
    async report(id: string, requestDigest: string): Promise<void> {
      await call(
        at(id, "/report"),
        post({ requestDigest, reason: "not_recognized" }),
      );
    },
  };
}

export type AuthorizationRequestClient = ReturnType<
  typeof createAuthorizationRequestClient
>;
