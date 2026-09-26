/**
 * Drop claim transport — Identity plane (remote or device-native, ADR 0118):
 * the sender's side, creating and polling a drop's claim session. Opening
 * one — the recipient's side — is `claims/drop-open.ts`, always-on under
 * `identity.ceremonies` (ADR 0140 D2), and so are the errors both share.
 *
 * Deliberately avoids value imports from `drop.ts` (that module consumes
 * `dropSeams` from here).
 */

import {
  type BoundaryValue,
  type JsonObject,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import { DropTransportError } from "../claims/drop-open.js";
import {
  ensureIdentitySession,
  identityBase,
  identityFetch,
} from "../identity.js";
import { pagesClaimBase, pagesClaimUrl } from "./local-drop-claims.js";

const DROP_CLAIM_TYPE = "resource_bundle";

export type DropTransportSession = {
  claimId: string;
  bearerToken: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: string;
};

export type DropTransportState = "pending" | "consumed" | "expired";

export {
  DropTransportError,
  type DropTransportErrorCode,
  type DropTransportPresented,
} from "../claims/drop-open.js";

function obj(value: BoundaryValue): Record<string, BoundaryValue> {
  if (isTypeofObject(value) && !Array.isArray(value)) {
    return overlapCast(value);
  }
  return {};
}

async function createClaimDefault(
  manifest: JsonObject,
  ttlMs: number,
): Promise<DropTransportSession> {
  try {
    await ensureIdentitySession();
  } catch {
    throw new DropTransportError(
      "unreachable",
      `The Identity plane at ${identityBase()} could not mint a session for this drop.`,
    );
  }
  let res: Response;
  try {
    res = await identityFetch("/v1/claims", {
      method: "POST",
      body: JSON.stringify({
        type: DROP_CLAIM_TYPE,
        targetManifest: manifest,
        ttlSeconds: Math.max(1, Math.round(ttlMs / 1000)),
      }),
    });
  } catch {
    throw new DropTransportError(
      "unreachable",
      `The Identity plane at ${identityBase()} could not be reached. Connect and try again.`,
    );
  }
  if (!res.ok) {
    const detail = obj(await res.json().catch(() => null));
    throw new DropTransportError(
      "refused",
      isString(detail.hint)
        ? detail.hint
        : res.status === 401 || res.status === 403
          ? "The Identity plane refused the drop session. Try again in a moment."
          : `The Identity plane answered ${res.status} — the drop was not created.`,
    );
  }
  const body = obj(await res.json());
  const claimId = body.claimId;
  const bearerToken = body.claimToken;
  const userCode = body.userCode;
  const expiresAt = body.expiresAt;
  if (
    !isString(claimId) ||
    !isString(bearerToken) ||
    !isString(userCode) ||
    !isString(expiresAt)
  ) {
    throw new DropTransportError(
      "refused",
      "The Identity plane's answer did not look like a claim session.",
    );
  }
  return {
    claimId,
    bearerToken,
    userCode,
    verifyUrl: pagesClaimUrl(dropSeams.claimBase()),
    expiresAt,
  };
}

async function pollClaimDefault(
  claimId: string,
  bearerToken: string,
): Promise<string> {
  let res: Response;
  try {
    res = await identityFetch(
      `/v1/claims/${encodeURIComponent(claimId)}/poll`,
      { headers: { "x-claim-token": bearerToken } },
    );
  } catch {
    throw new DropTransportError(
      "unreachable",
      `The Identity plane at ${identityBase()} could not be reached.`,
    );
  }
  if (res.status === 401) {
    throw new DropTransportError(
      "refused",
      "The Identity plane refused this drop's claim token.",
    );
  }
  const body = obj(await res.json().catch(() => null));
  const nested = obj(body.claim).state;
  const status = isString(body.status)
    ? body.status
    : isString(nested)
      ? nested
      : null;
  if (status === null) {
    throw new DropTransportError(
      "refused",
      "The Identity plane's poll answer did not name a claim state.",
    );
  }
  return status;
}

export const dropSeams = {
  createClaim: createClaimDefault,
  pollClaim: pollClaimDefault,
  /** The claim host a drop's link names: this Pages deployment, always. */
  claimBase: (): string => pagesClaimBase(),
};
