/**
 * The join road's calls, each scoped to the endpoint the ceremony names
 * (ADR 0044, ADR 0079 §7, ADR 0136).
 *
 * Three rules shape every function here:
 *
 * - **The endpoint is the ceremony's, never the app's.** Nothing here reads
 *   or writes `settings.hostApi`; every call takes the endpoint the person
 *   confirmed, and authority is asked of that endpoint alone.
 * - **Nothing is spent where it cannot be finished.** A deployment that may
 *   not hold endpoint authority (a shared-origin demo) presents no invite,
 *   and neither does a browser the endpoint has not approved and verified:
 *   presenting spends the offer's one presentation, and a second present
 *   burns it for everyone.
 * - **Authority is short and dropped.** Joining needs this browser approved
 *   by the endpoint's operator (a pairing) and the person verified by
 *   passkey; the grant lives in memory, expires in minutes, and the
 *   ceremony ends it as it closes. Joining does not leave a standing grant.
 */

import { type JsonObject, isString } from "@opensesame/os-domain";
import { readBoundedObject } from "../bounded-response.js";
import {
  BrowserPairingError,
  type PairingPrompt,
  beginBrowserPairing,
  clearBrowserPairing,
  currentBrowserGrant,
  pairedHostFetch,
  pollBrowserPairing,
} from "../browser-pairing.js";
import { mayPairLocalAuthority } from "../deployment-profile.js";
import { authorizeHost } from "../host-authorization.js";
import { remoteIdentityApi } from "../identity.js";
import { loadSettings } from "../settings.js";
import { normalizeApiBase } from "../urls.js";
import {
  NOTE_MAX,
  isInviteToken,
  normalizeInviteCode,
  normalizeSessionId,
  noteLength,
} from "./invite.js";
import {
  type JoinOffer,
  type JoinReceipt,
  type OpenSession,
  readClaimed,
  readOffer,
  readOpenSessions,
  readReceipt,
} from "./wire.js";

export type JoinErrorCode =
  | "unavailable_here"
  | "bad_endpoint"
  | "bad_invite"
  | "leaked_invite"
  | "unreachable"
  | "invite_unknown"
  | "invite_spent"
  | "invite_expired"
  | "invite_elsewhere"
  | "invite_presented"
  | "code_format"
  | "code_mismatch"
  | "claim_refused"
  | "approval_failed"
  | "approval_expired"
  | "verify_needs_identity"
  | "verify_failed"
  | "note_too_long"
  | "no_session"
  | "already_member"
  | "already_asked"
  | "invalid_response";

export class JoinError extends Error {
  constructor(readonly code: JoinErrorCode) {
    super(code);
    this.name = "JoinError";
  }
}

const BODY_BYTES = 65_536;
const BODY_MS = 8000;

export const joinSeams = {
  eligible: mayPairLocalAuthority,
  pairedFetch: pairedHostFetch,
  beginPairing: beginBrowserPairing,
  pollPairing: pollBrowserPairing,
  clearPairing: clearBrowserPairing,
  grant: currentBrowserGrant,
  authorize: authorizeHost,
  identityApi: remoteIdentityApi,
  configuredEndpoint: (): string => loadSettings().hostApi,
};

/** May this deployment finish a join at all? Asked before anything is spent. */
export function joinAvailable(): boolean {
  return joinSeams.eligible();
}

/** The deployment's own endpoint, normalized, or "" when it has none. */
export function configuredEndpoint(): string {
  return normalizeApiBase(joinSeams.configuredEndpoint()) ?? "";
}

export function resolveEndpoint(raw: string): string {
  const base = normalizeApiBase(raw.trim());
  if (!base) throw new JoinError("bad_endpoint");
  return base;
}

function requireAvailable(): void {
  if (!joinAvailable()) throw new JoinError("unavailable_here");
}

async function body(response: Response): Promise<JsonObject> {
  try {
    return await readBoundedObject(response, BODY_BYTES, BODY_MS);
  } catch {
    throw new JoinError("invalid_response");
  }
}

async function errorCode(response: Response): Promise<string> {
  try {
    const value = await body(response);
    return isString(value.error) ? value.error : "";
  } catch {
    return "";
  }
}

/** A thrown value, as the transport error it stands for. */
function transport(thrown: Error | string): JoinError {
  const error = thrown instanceof Error ? thrown : new Error(thrown);
  if (error instanceof JoinError) return error;
  if (error instanceof BrowserPairingError) {
    return new JoinError(
      error.code === "pairing_expired" || error.code === "pairing_required"
        ? "approval_expired"
        : "approval_failed",
    );
  }
  return new JoinError("unreachable");
}

async function authorized(
  endpoint: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  requireAvailable();
  try {
    return await joinSeams.pairedFetch(endpoint, path, init);
  } catch (error) {
    throw transport(error instanceof Error ? error : String(error));
  }
}

/**
 * Look an invite up: `POST /api/v1/delegations/present`.
 *
 * Spends the offer's one presentation, so it runs once per invite per tab —
 * the caller keeps the answer (see `stash.ts`) instead of asking again. The
 * endpoint answers a browser only under an approved, verified grant, so an
 * invite is never spent by a page that could not go on to accept it.
 */
export async function presentInvite(
  endpoint: string,
  token: string,
): Promise<JoinOffer> {
  const base = resolveEndpoint(endpoint);
  if (!isInviteToken(token)) throw new JoinError("bad_invite");
  const response = await authorized(base, "/api/v1/delegations/present", {
    method: "POST",
    body: JSON.stringify({ claim_token: token }),
  });
  if (response.status === 401 || response.status === 403)
    throw new JoinError("verify_failed");
  if (response.status === 404) throw new JoinError("invite_unknown");
  if (response.status === 409) throw new JoinError("invite_spent");
  if (response.status === 410) throw new JoinError("invite_expired");
  if (!response.ok) throw new JoinError("invalid_response");
  try {
    return readOffer(await body(response));
  } catch {
    throw new JoinError("invalid_response");
  }
}

/**
 * Ask the endpoint's operator to approve this browser. The prompt's code is
 * what the person reads to them; it authorizes nothing by itself.
 */
export async function beginApproval(endpoint: string): Promise<PairingPrompt> {
  requireAvailable();
  const base = resolveEndpoint(endpoint);
  try {
    // Paired to join: after the passkey check this grant reaches the join
    // routes and nothing else a verified browser could (ADR 0136).
    return await joinSeams.beginPairing(base, "join");
  } catch (error) {
    throw transport(error instanceof Error ? error : String(error));
  }
}

/** One poll; true once the operator approved. */
export async function pollApproval(): Promise<boolean> {
  requireAvailable();
  try {
    return (await joinSeams.pollPairing()) !== null;
  } catch (error) {
    throw transport(error instanceof Error ? error : String(error));
  }
}

/**
 * Prove the person behind the approved browser, by passkey, in the Identity
 * window — without it the endpoint grants a browser no join routes at all.
 * Call from the press itself: the verification window is a popup.
 */
export async function verifyAt(
  endpoint: string,
  signal: AbortSignal,
): Promise<void> {
  requireAvailable();
  const base = resolveEndpoint(endpoint);
  if (!joinSeams.identityApi().trim())
    throw new JoinError("verify_needs_identity");
  const grant = joinSeams.grant(base);
  if (!grant) throw new JoinError("approval_expired");
  try {
    await joinSeams.authorize(
      {
        operation: "browser.authenticate",
        target_id: grant.clientId,
        transition: null,
      },
      signal,
      (path, init) => joinSeams.pairedFetch(base, path, init),
    );
  } catch (error) {
    if (error instanceof BrowserPairingError) throw transport(error);
    // A refused check (401) also ends the grant; say which one it was, so
    // the person knows whether to verify again or ask for approval again.
    throw new JoinError(
      joinSeams.grant(base) ? "verify_failed" : "approval_expired",
    );
  }
}

/** Accept the chosen items: `POST /api/v1/delegations/claim`. */
export async function claimInvite(
  endpoint: string,
  input: Readonly<{
    token: string;
    code: string;
    acceptedItemIds: readonly string[];
  }>,
): Promise<number> {
  const base = resolveEndpoint(endpoint);
  if (!isInviteToken(input.token)) throw new JoinError("bad_invite");
  const code = normalizeInviteCode(input.code);
  if (!code) throw new JoinError("code_format");
  const response = await authorized(base, "/api/v1/delegations/claim", {
    method: "POST",
    body: JSON.stringify({
      claim_token: input.token,
      user_code: code,
      accepted_item_ids: [...input.acceptedItemIds],
    }),
  });
  if (response.ok) {
    try {
      return readClaimed(await body(response));
    } catch {
      throw new JoinError("invalid_response");
    }
  }
  if (response.status === 401 || response.status === 403)
    throw new JoinError("verify_failed");
  if (response.status === 409) throw new JoinError("invite_spent");
  if (response.status === 410) throw new JoinError("invite_expired");
  if (response.status === 404) throw new JoinError("invite_unknown");
  const detail = await errorDetail(response);
  throw new JoinError(
    /user code/i.test(detail) ? "code_mismatch" : "claim_refused",
  );
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const value = await body(response);
    return isString(value.detail) ? value.detail : "";
  } catch {
    return "";
  }
}

/** Public sessions at the endpoint — names and ids, never contents. */
export async function listOpenSessions(
  endpoint: string,
): Promise<OpenSession[]> {
  const base = resolveEndpoint(endpoint);
  const response = await authorized(
    base,
    "/api/v1/shared-sessions?visibility=public",
  );
  if (response.status === 401 || response.status === 403)
    throw new JoinError("verify_failed");
  if (!response.ok) throw new JoinError("invalid_response");
  try {
    return readOpenSessions(await body(response));
  } catch {
    throw new JoinError("invalid_response");
  }
}

/**
 * Ask into a public session. Asking seats nobody: the operator admits or
 * refuses, and the answer is whatever the endpoint says it is.
 */
export async function askToJoin(
  endpoint: string,
  rawSessionId: string,
  rawNote: string,
): Promise<JoinReceipt> {
  const base = resolveEndpoint(endpoint);
  const sessionId = normalizeSessionId(rawSessionId);
  if (!sessionId) throw new JoinError("no_session");
  const note = rawNote.trim();
  if (noteLength(note) > NOTE_MAX) throw new JoinError("note_too_long");
  const response = await authorized(
    base,
    `/api/v1/shared-sessions/${sessionId}/join-requests`,
    { method: "POST", body: JSON.stringify(note ? { note } : {}) },
  );
  if (response.ok) {
    try {
      return readReceipt(await body(response));
    } catch {
      throw new JoinError("invalid_response");
    }
  }
  if (response.status === 401 || response.status === 403)
    throw new JoinError("verify_failed");
  if (response.status === 404) throw new JoinError("no_session");
  const code = await errorCode(response);
  if (code === "join_request_pending") throw new JoinError("already_asked");
  if (code === "already_in_session") throw new JoinError("already_member");
  throw new JoinError("claim_refused");
}

/** Drop the join's authority. Every exit from the ceremony calls this. */
export function endJoinAuthority(): void {
  joinSeams.clearPairing();
}
