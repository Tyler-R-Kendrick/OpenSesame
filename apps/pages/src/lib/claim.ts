import {
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Claim-side delegation client (Host plane) — presenting an offered grant
 * before accepting it (ADR 0044, ADR 0061).
 *
 * `POST /api/v1/delegations/present` spends the offer's one presentation and
 * returns the offered scope; the claim itself goes through `claimDelegation`
 * in `lib/access.ts`, whose seams this client deliberately does not
 * duplicate. Holding the claim token is the credential being spent — no
 * session is required to present, and nothing here ever sees a credential.
 */

import {
  AccessError,
  type DelegationOffer,
  type DelegationOfferItem,
} from "./access.js";
import { hostBase, hostFetch } from "./identity.js";

/* ----------------------------------------------------------- wire mapping */

function obj(value: BoundaryValue): JsonObject {
  return value && isTypeofObject(value) ? overlapCast(value) : {};
}

function list(value: BoundaryValue): BoundaryValue[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: BoundaryValue): string[] {
  return list(value).filter((entry): entry is string => isString(entry));
}

function toOfferItem(value: BoundaryValue): DelegationOfferItem {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    connectionId: String(raw.connection_id ?? ""),
    providerId: String(raw.provider_id ?? ""),
    displayName: String(raw.display_name ?? ""),
    actions: strings(raw.actions),
    resources: strings(raw.resources),
    expiresInSeconds: isNumber(raw.expires_in_seconds)
      ? raw.expires_in_seconds
      : 0,
    executionMode: String(raw.execution_mode ?? "broker"),
    required: Boolean(raw.required),
    dependencies: strings(raw.dependencies),
  };
}

function toOffer(value: BoundaryValue): DelegationOffer {
  const raw = obj(value);
  return {
    id: String(raw.id ?? ""),
    state: String(raw.state ?? ""),
    manifestDigest: String(raw.manifest_digest ?? ""),
    expiresAt: String(raw.expires_at ?? ""),
    items: list(raw.items).map(toOfferItem),
  };
}

/* --------------------------------------------------------------- requests */

/**
 * Present an offered grant by its claim token. Every failure collapses to
 * one line: the broker answers 404/409/410 for unknown, spent, and expired
 * offers alike, and the ceremony should not say which.
 */
async function presentOfferDefault(
  claimToken: string,
): Promise<DelegationOffer> {
  let res: Response;
  try {
    res = await hostFetch("/api/v1/delegations/present", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ claim_token: claimToken }),
    });
  } catch (error) {
    if (error instanceof Error && !(error instanceof TypeError)) throw error;
    throw new AccessError(
      0,
      "unreachable",
      `Host API unreachable at ${hostBase()}. Start the Host, or point at a running one under Settings.`,
    );
  }
  if (!res.ok) {
    const body = obj(await res.json().catch(() => null));
    const code = isString(body.error) ? body.error : "unknown_error";
    throw new AccessError(
      res.status,
      code,
      "That offer is unknown, spent, or expired — ask the owner for a fresh code.",
    );
  }
  return toOffer(obj(obj(await res.json()).offer));
}

export const claimSeams = {
  presentOffer: presentOfferDefault,
};

export function presentOffer(claimToken: string): Promise<DelegationOffer> {
  return claimSeams.presentOffer(claimToken);
}
