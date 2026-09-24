/**
 * The ownership claim's four Identity API calls (ADR 0045):
 * `POST /v1/claims/present`, `GET /v1/claims/:id`,
 * `POST /v1/claims/:id/complete` and, for a guest, the provisional principal
 * `POST /v1/principals/provisional` mints.
 *
 * The transport is injected. Pages passes its Identity transport
 * (`identityFetch` — the bearer, the base, the timeouts) exactly as
 * `directory.ts` does for device approval; a test passes a fake. Failures are
 * worded by ceremony-kit's `claimRefusal`, keyed on the body's error code.
 *
 * The bearer travels in the JSON body or the `x-claim-token` header, never in
 * a query string, and nothing here logs or keeps it.
 */

import { claimRefusal } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  readString,
} from "@opensesame/os-domain";
import {
  connectProvisional,
  currentSession,
  identityFetch,
} from "../identity.js";
import {
  type ClaimCompletion,
  ClaimError,
  type ClaimReview,
  toClaimReview,
} from "./review.js";

export interface ClaimTransport {
  /** An Identity API request; `path` is relative to the configured base. */
  fetch(path: string, init: RequestInit): Promise<Response>;
  /** The principal the Identity session belongs to, or null. */
  principal(): string | null;
  /** Mint a provisional principal in place and return its id. */
  provisional(): Promise<string>;
}

const UNREACHABLE =
  "The sign-in service could not be reached. Check the connection and try again.";

async function readBody(res: Response): Promise<JsonObject | null> {
  try {
    const body: BoundaryValue = await res.json();
    return isJsonObject(body) ? body : null;
  } catch {
    return null;
  }
}

/** Send one claim call; a refusal becomes a worded `ClaimError`. */
async function send(
  transport: ClaimTransport,
  path: string,
  init: RequestInit,
): Promise<JsonObject | null> {
  let res: Response;
  try {
    res = await transport.fetch(path, init);
  } catch {
    // Nothing reached the server, so nothing was spent.
    throw new ClaimError("unreachable", UNREACHABLE, false);
  }
  const body = await readBody(res);
  if (res.ok) return body;
  const detail = readString(body?.message) ?? readString(body?.hint) ?? null;
  const refused = claimRefusal(
    readString(body?.error) ?? "",
    res.status,
    detail,
  );
  throw new ClaimError(refused.kind, refused.words, refused.spent, res.status);
}

const JSON_HEADERS = {
  "content-type": "application/json",
  accept: "application/json",
};

/** Present an unspent bearer: the single-use transition. */
export async function presentClaim(
  transport: ClaimTransport,
  token: string,
): Promise<ClaimReview> {
  const body = await send(transport, "/v1/claims/present", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ token }),
  });
  return toClaimReview(body);
}

/** Read a presented claim back: presenting twice is refused. */
export async function readClaim(
  transport: ClaimTransport,
  claimId: string,
  token: string,
): Promise<ClaimReview> {
  const body = await send(
    transport,
    `/v1/claims/${encodeURIComponent(claimId)}`,
    { headers: { accept: "application/json", "x-claim-token": token } },
  );
  return toClaimReview(body);
}

/** Accept the claim for the signed-in principal. */
export async function completeClaim(
  transport: ClaimTransport,
  claimId: string,
  completion: ClaimCompletion,
): Promise<void> {
  await send(transport, `/v1/claims/${encodeURIComponent(claimId)}/complete`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-claim-token": completion.claimToken },
    body: JSON.stringify(completion),
  });
}

/** Pages' Identity transport: the same bearer and base every directory call uses. */
export const identityClaimTransport: ClaimTransport = {
  fetch: (path, init) => identityFetch(path, init),
  principal: () => currentSession()?.principalId ?? null,
  provisional: async () => (await connectProvisional()).principalId,
};
