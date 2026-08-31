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
 * The approval review ceremony's data layer (ADR 0081).
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
 * Failure vocabulary
 * ------------------------------------------------------------------ */

export type ApprovalErrorCode =
  | "signin"
  | "not_found"
  | "expired"
  | "changed"
  | "revoked"
  | "already_decided"
  | "activation_expired"
  | "activation_unavailable"
  | "comparison_mismatch"
  | "comparison_exhausted"
  | "unreachable"
  | "failed";

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
const TERMINAL: readonly ApprovalErrorCode[] = [
  "not_found",
  "expired",
  "changed",
  "revoked",
  "already_decided",
];

export function isTerminal(code: ApprovalErrorCode): boolean {
  return TERMINAL.includes(code);
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
 * Turn a refusal into wording a person can act on.
 *
 * Every branch says what happened to the *request*, because "nothing was
 * decided" is the fact somebody standing at this screen needs, and a bare
 * status code does not carry it.
 */
export function refusalFor(status: number, body: JsonObject): ApprovalError {
  const code = errorCode(body);
  if (code === "comparison_mismatch") {
    return new ApprovalError("comparison_mismatch", COMPARISON_MISMATCH);
  }
  if (code === "comparison_exhausted") {
    return new ApprovalError(
      "comparison_exhausted",
      "Too many wrong codes, so this request is locked and nothing was decided. Ask whoever started it to begin again.",
    );
  }
  if (code === "activation_expired" || code === "activation_not_found") {
    return new ApprovalError(
      "activation_expired",
      "Your authenticator touch took too long, so it was not accepted and nothing was decided. Read the request again and touch your passkey once more.",
    );
  }
  if (code === "binding_revoked" || code === "binding_not_usable") {
    return new ApprovalError(
      "revoked",
      "The destination this request was sent to has been revoked, so it can no longer be decided from that link. Nothing was decided.",
    );
  }
  if (status === 401) {
    return new ApprovalError(
      "signin",
      "Sign in to decide requests addressed to you.",
    );
  }
  if (status === 403) {
    return new ApprovalError(
      "failed",
      "This request is not addressed to you, so it is not yours to decide.",
    );
  }
  if (status === 404) {
    return new ApprovalError(
      "not_found",
      "This link does not point at a request we can find. It may have been withdrawn. Ask whoever sent it for a fresh one.",
    );
  }
  if (status === 409) {
    return new ApprovalError(
      "changed",
      "This request changed since it was shown, so nothing was decided. Reload it and read the new version before deciding.",
    );
  }
  if (status === 410) {
    return new ApprovalError(
      "expired",
      "This request expired before it was decided. Nothing was approved — whoever asked will have to ask again.",
    );
  }
  if (status === 422 || code === "request_not_pending") {
    return new ApprovalError(
      "already_decided",
      "This request was already decided. Nothing changed just now.",
    );
  }
  return new ApprovalError("failed", `That did not go through (${status}).`);
}

/** The comparison-mismatch wording. A security signal, not a form error. */
export const COMPARISON_MISMATCH =
  "That code doesn't match. Someone else may have started this request. Do not approve it — check with whoever you think asked, and deny it if nobody did.";

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
 * Copy — reason codes and channels as sentences
 * ------------------------------------------------------------------ */

/**
 * The reason codes minted by `requiredReasonCodes()` in
 * `@opensesame/trust-broker`, as sentences.
 *
 * A screen that prints `phishing_resistance` has told the person nothing.
 * Worse, a screen that prints "HIGH" has told them something they cannot
 * check: a scalar is a label somebody chose, while these each name a thing
 * that will actually happen in the next ten seconds.
 */
const REASON_SENTENCES = new Map<string, string>(
  Object.entries({
    "subject_kind:human":
      "A person has to decide this. An agent cannot approve it on your behalf.",
    "subject_kind:agent": "This is decided by an agent, not by a person.",
    "subject_kind:workload":
      "This is decided by a workload identity, not by a person.",
    user_verification:
      "Your authenticator has to check that it is you — a fingerprint, a face, or a PIN — not just that the device is nearby.",
    phishing_resistance:
      "This asks for access that a typed code could never safely approve, so it needs a passkey bound to this site. Nothing you could copy out of a message counts.",
    verifier_name_binding:
      "The passkey has to be one registered with OpenSesame itself, so an approval made here cannot be replayed against another site.",
    identity_proofing:
      "Your identity has to have been checked to the standard your operator set before this can be approved.",
    device_binding:
      "The key has to live on a device rather than move between them.",
    key_protection:
      "The key has to be held in hardware your browser cannot export.",
    authentication_freshness:
      "You have to have signed in recently. An old session is not enough for this one.",
    acr: "Your sign-in has to have met the authentication level your operator named for this kind of request.",
    transaction_bound_activation:
      "You have to touch your authenticator for this exact request, so a touch you gave to something else cannot be spent here.",
    comparison:
      "You have to type the six-digit code shown where the request started, so the thing you approve is the thing you started.",
  }),
);

/** Anything the server adds later still reads as a sentence, not a token. */
export function requirementSentence(code: string): string {
  const known = REASON_SENTENCES.get(code);
  if (known) return known;
  return `Your operator requires "${code.replaceAll("_", " ")}" for this request.`;
}

export function requirementSentences(required: readonly string[]): string[] {
  return required.map(requirementSentence);
}

const RISK_SENTENCES = new Map<string, string>(
  Object.entries({
    low: "This is a routine request. It still needs you, but not extra proof.",
    moderate:
      "This one carries real consequences, so it asks for more than a click.",
    high: "This reaches something sensitive, so approving it takes a fresh, deliberate proof that it is you.",
    critical:
      "This is the most sensitive kind of request there is here. Everything below has to line up before it can go through.",
  }),
);

export function riskSentence(riskClass: string): string {
  return (
    RISK_SENTENCES.get(riskClass) ??
    "Your operator has classed this request as needing extra proof."
  );
}

const CHANNEL_LABELS = new Map<string, string>(
  Object.entries({
    in_app: "the OpenSesame inbox",
    native_push: "a push notification on one of your devices",
    slack: "Slack",
    teams: "Microsoft Teams",
    telegram: "Telegram",
    wechat: "WeChat",
    sms: "a text message",
    webhook: "a webhook",
  }),
);

export function channelLabel(kind: string): string {
  return CHANNEL_LABELS.get(kind) ?? kind.replaceAll("_", " ");
}

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

export function describeDetail(detail: AuthorizationDetail): string {
  const actions = detail.actions?.length ? detail.actions.join(", ") : "use";
  const where = detail.locations?.length
    ? detail.locations.join(", ")
    : (detail.identifier ?? detail.type);
  return `${actions} — ${where}`;
}

/** Why this browser cannot run the ceremony, said out loud rather than skipped. */
export const NO_CREDENTIALS_API =
  "This browser cannot run a passkey ceremony on this page — the credential API is missing, which usually means the page was not loaded over HTTPS, or the browser is too old. This request needs a passkey touch, so it cannot be decided here. Nothing has been approved. Open the same link on a device where passkeys work.";
