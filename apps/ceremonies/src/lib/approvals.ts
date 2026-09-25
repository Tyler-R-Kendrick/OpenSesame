import {
  APPROVAL_WORDS,
  type ApprovalRefusalKind,
  COMPARISON_MISMATCH,
  approvalRefusal,
  approvalWords,
  channelLabel,
  describeDetail,
  requirementSentence,
  requirementSentences,
  riskSentence,
} from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { createOpenSesame } from "@opensesame/sdk-browser";
import { issuer } from "./issuer.js";

/**
 * The approval review ceremony's data layer (ADR 0084).
 *
 * An external notification can only ever say "something is waiting". It hands
 * over an opaque rendezvous reference and nothing else — no principal, no
 * detail, no bearer. Everything a person needs in order to decide is fetched
 * here, from the Identity API, against their own session.
 *
 * Two things are deliberately kept out of this module's vocabulary:
 *
 * - The comparison value is *submitted* and never read back. It exists in a
 *   form field and in one request body, and nowhere else.
 * - A provider subject id never appears. It is the authority-bearing half of
 *   a channel binding, and a screen that shows it back hands anyone reading
 *   over the shoulder the value a forged callback would need.
 */

/* ------------------------------------------------------------------ *
 * Wire shapes
 * ------------------------------------------------------------------ */

/** Mirrors `NotificationChannelKindSchema` in `@opensesame/contracts`. */
export type ChannelKind =
  | "in_app"
  | "native_push"
  | "slack"
  | "teams"
  | "telegram"
  | "wechat"
  | "sms"
  | "webhook";

export interface AuthorizationDetail {
  type: string;
  locations?: string[];
  actions?: string[];
  identifier?: string;
}

/**
 * One waiting request, as the inbox and the review page both read it.
 *
 * The assurance fields are optional because a deployment that has not yet
 * grown the notification layer still answers the older shape; absent means
 * "nothing extra is demanded", which is exactly what the inline approve path
 * in the inbox already assumed.
 */
export interface AuthorizationRequestView {
  authReqId: string;
  status: string;
  bindingMessage: string;
  requestDigest: string;
  authorizationDetails: AuthorizationDetail[];
  expiresAt: string;
  /** Opaque handle for whoever is asking. Never a raw principal id. */
  requesterRef?: string;
  requesterKind?: string;
  connectionId?: string;
  decidedByKind?: string;
  /** Assurance summary, when the server computes one for a list row. */
  requiredAssurance?: string[];
  requireTransactionBoundActivation?: boolean;
  requireComparison?: boolean;
}

/** Mirrors `ApprovalRequirementResponseSchema`. */
export interface ApprovalRequirement {
  riskClass: string;
  policyDigest: string;
  requireTransactionBoundActivation: boolean;
  requireComparison: boolean;
  /** Reason codes, not a scalar level. Rendered as sentences, never raw. */
  required: string[];
  maximumApprovalAgeSeconds: number;
  arrivedVia?: ChannelKind;
}

/** Mirrors `BeginApprovalActivationResponseSchema`. */
export interface ApprovalActivationChallenge {
  activationId: string;
  transactionDigest: string;
  policyDigest: string;
  expiresAt: string;
  options: JsonObject;
}

/** Mirrors `assertionPayload()` from `@opensesame/sdk-browser`. */
export interface ActivationAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
}

export type ApprovalDecision = "approve" | "deny";

/* ------------------------------------------------------------------ *
 * Failure vocabulary — ceremony-kit's, so Pages words a refusal the same way
 * ------------------------------------------------------------------ */

export type ApprovalErrorCode = ApprovalRefusalKind;

export class ApprovalError extends Error {
  constructor(
    readonly code: ApprovalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApprovalError";
  }
}

/**
 * Codes that end the page. There is nothing left to try, so the screen stops
 * offering buttons and says plainly what happened to the request.
 */
export function isTerminal(code: ApprovalErrorCode): boolean {
  return approvalWords(code).ends;
}

/* ------------------------------------------------------------------ *
 * Seams
 * ------------------------------------------------------------------ */

async function fetchFnDefault(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(url, init);
}

async function getAccessTokenDefault(): Promise<string | null> {
  const session = await createOpenSesame({ issuer }).getSession();
  return session ? session.accessToken : null;
}

/**
 * The browser's credential store, or nothing.
 *
 * A non-secure context and an old browser both leave `navigator.credentials`
 * undefined, and the type says otherwise. Returning `null` rather than
 * throwing lets the page say *why* the ceremony cannot run here, which is the
 * whole point: an activation that cannot happen must never be skipped
 * quietly.
 */
function credentialsApiDefault(): CredentialsContainer | null {
  const nav: { credentials?: CredentialsContainer } = overlapCast(navigator);
  return nav.credentials ?? null;
}

export const approvalSeams = {
  fetchFn: fetchFnDefault,
  getAccessToken: getAccessTokenDefault,
  credentialsApi: credentialsApiDefault,
};

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

const base = issuer.replace(/\/$/, "");

function obj(value: BoundaryValue): JsonObject {
  return isJsonObject(value) ? value : {};
}

function errorCode(body: JsonObject): string {
  const code = body.error;
  return isString(code) ? code : "";
}

/**
 * Turn a refusal into wording a person can act on: ceremony-kit's
 * `approvalRefusal`, keyed on the body's error code first and the status
 * only when it names none.
 */
export function refusalFor(status: number, body: JsonObject): ApprovalError {
  const refusal = approvalRefusal(errorCode(body), status);
  return new ApprovalError(refusal.kind, refusal.words);
}

export { COMPARISON_MISMATCH };

/**
 * One authorized call to the Identity API.
 *
 * Exported because the notification-settings screen talks to the same API
 * with the same session and the same refusal vocabulary, and two transports
 * is how one of them quietly stops sending the bearer.
 */
export async function identityCall(
  path: string,
  init?: RequestInit,
): Promise<JsonObject> {
  const token = await approvalSeams.getAccessToken();
  if (!token) {
    throw new ApprovalError(
      "signin",
      "Sign in to decide requests addressed to you.",
    );
  }
  let res: Response;
  try {
    res = await approvalSeams.fetchFn(`${base}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new ApprovalError(
      "unreachable",
      "The Identity API is not reachable from here. Nothing was decided.",
    );
  }
  const body = obj(await res.json().catch(() => null));
  if (!res.ok) throw refusalFor(res.status, body);
  return body;
}

const ref = (value: string) => encodeURIComponent(value);

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export async function listPending(): Promise<AuthorizationRequestView[]> {
  const body = await identityCall("/v1/authorization-requests?status=pending");
  const requests = body.requests;
  return Array.isArray(requests) ? overlapCast(requests) : [];
}

export async function loadRequest(
  id: string,
): Promise<AuthorizationRequestView> {
  return overlapCast(
    await identityCall(`/v1/authorization-requests/${ref(id)}`),
  );
}

export async function loadRequirement(
  id: string,
): Promise<ApprovalRequirement> {
  return overlapCast(
    await identityCall(`/v1/authorization-requests/${ref(id)}/requirement`),
  );
}

/* ------------------------------------------------------------------ *
 * The ceremony
 * ------------------------------------------------------------------ */

/**
 * Step 1 — mint an activation against the digest that was displayed.
 *
 * The digest travels with the request for the activation, not just with the
 * settle: an activation is bound to the request the person actually read, so
 * a request that changed in between cannot be signed for at all.
 */
export async function beginActivation(
  id: string,
  decision: ApprovalDecision,
  requestDigest: string,
): Promise<ApprovalActivationChallenge> {
  const body = await identityCall(
    `/v1/authorization-requests/${ref(id)}/activation`,
    {
      method: "POST",
      body: JSON.stringify({
        decision: decision === "approve" ? "approved" : "denied",
        requestDigest,
      }),
    },
  );
  return overlapCast(body);
}

/** Step 2 — hand the authenticator's assertion back for verification. */
export async function completeActivation(
  id: string,
  activationId: string,
  assertion: ActivationAssertion,
): Promise<void> {
  await identityCall(
    `/v1/authorization-requests/${ref(id)}/activation/complete`,
    {
      method: "POST",
      body: JSON.stringify({ activationId, ...assertion }),
    },
  );
}

export interface SettleInput {
  requestDigest: string;
  activationId?: string;
  comparisonValue?: string;
}

/**
 * Step 3 — settle.
 *
 * The activation is named, not re-proved: the server already verified the
 * assertion and holds it. The comparison value is carried here and nowhere
 * else, and never comes back.
 */
export async function settle(
  id: string,
  decision: ApprovalDecision,
  input: SettleInput,
): Promise<JsonObject> {
  return identityCall(`/v1/authorization-requests/${ref(id)}/${decision}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/**
 * "I don't recognize this."
 *
 * Deliberately not a denial. A denial is a decision about a request the
 * person understood; this is a report that the request should not exist, and
 * an operator needs to be able to tell the two apart afterwards.
 */
export async function reportUnrecognized(
  id: string,
  requestDigest: string,
): Promise<void> {
  await identityCall(`/v1/authorization-requests/${ref(id)}/report`, {
    method: "POST",
    body: JSON.stringify({ requestDigest, reason: "not_recognized" }),
  });
}

/* ------------------------------------------------------------------ *
 * Copy — ceremony-kit's, so Pages reads a request the same way
 * ------------------------------------------------------------------ */

export {
  channelLabel,
  describeDetail,
  requirementSentence,
  requirementSentences,
  riskSentence,
};

/**
 * A short "what this will take" line, for a list row.
 *
 * The inbox shows this so a person can see, before opening anything, which
 * requests are going to ask for their authenticator.
 */
export function assuranceSummary(item: AuthorizationRequestView): string {
  const needs: string[] = [];
  if (item.requireTransactionBoundActivation) {
    needs.push("a passkey touch for this exact request");
  }
  if (item.requireComparison)
    needs.push("the six-digit code from where it started");
  if (needs.length === 0) {
    const count = item.requiredAssurance?.length ?? 0;
    return count > 0
      ? "Needs you signed in as yourself — nothing extra."
      : "Needs your decision — nothing extra.";
  }
  return `Needs ${needs.join(" and ")}.`;
}

/** Does this request have to go through the full review ceremony? */
export function needsCeremony(item: AuthorizationRequestView): boolean {
  return (
    item.requireTransactionBoundActivation === true ||
    item.requireComparison === true
  );
}

/** Why this browser cannot run the ceremony, said out loud rather than skipped. */
export const NO_CREDENTIALS_API = APPROVAL_WORDS.noCredentialsApi;
