/**
 * Opening a drop — the recipient's side (ADR 0062; ADR 0140 D2).
 *
 * A drop link (`/claim#token=…&key=…`) opens on every installation: the
 * `/claim` route is the always-on `identity.ceremonies`, and so is this.
 * Sending a drop — sealing and creating the claim session — is the
 * always-on `sharing.drops` (`vault/drop.ts`). A legacy drop record still
 * sweeps from there. Both build on the errors defined here.
 *
 * A remote drop presents to the Identity API; a legacy device-local drop uses
 * its strict single-use claim store; a portable drop opens its fragment packet
 * here without a server. The manifest key never leaves this function's caller.
 */

import {
  dropRefusal,
  isClaimToken,
  isPortableDropToken,
} from "@opensesame/ceremony-kit";
import {
  type BoundaryObject,
  type BoundaryValue,
  type JsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";
import {
  DropFormatError,
  type DropManifest,
  type DropPayload,
  guardManifest as guardManifestFormat,
  openDrop as openDropFormat,
} from "@opensesame/vault-core";
import {
  isDeviceIdentityMode,
  isRemoteIdentityConfigured,
} from "../device-identity.js";
import { identityBase, identityFetch } from "../identity.js";
import { noteDropOpened, noteDropRefused } from "../sharing-receipts.js";
import {
  LocalDropClaimError,
  presentLocalDropClaim,
} from "../vault/local-drop-claims.js";
import { claimIdFromBearer } from "../vault/local-drop-codec.js";
import { noteOutboundDropConsumed } from "../vault/outbound-drops.js";
import {
  DropError,
  DropTransportError,
  type DropTransportErrorCode,
} from "./drop-errors.js";

export {
  DropError,
  type DropErrorCode,
  DropTransportError,
  type DropTransportErrorCode,
} from "./drop-errors.js";

export type DropTransportPresented = { targetManifest: JsonObject };

export type PresentedDrop = { targetManifest: DropManifest };

export type { DropPayload } from "@opensesame/vault-core";

/** A format refusal, restated as this side's error; anything else as is. */
export function asDropError(error: Error): never {
  if (error instanceof DropFormatError)
    throw new DropError(error.code, error.message);
  throw error;
}

/** A transport failure as a `DropError`, keeping the reason it gave. */
export function mapTransportError(error: Error): DropError {
  if (error instanceof DropError) return error;
  if (error instanceof DropTransportError) {
    return new DropError(error.code, error.message, error.attemptsLeft);
  }
  return new DropError("unreachable", error.message);
}

/** Guard the server-returned manifest before anything is decoded from it. */
export function guardManifest(value: BoundaryValue): DropManifest {
  try {
    return guardManifestFormat(value);
  } catch (error) {
    if (error instanceof Error) asDropError(error);
    throw error;
  }
}

/** Decrypt and digest-verify a presented drop manifest. */
export function openDrop(
  value: BoundaryValue,
  fragmentKey: string,
): Promise<DropPayload> {
  return openDropFormat(value, fragmentKey).catch(asDropError);
}

function obj(value: BoundaryValue): Record<string, BoundaryValue> {
  if (isTypeofObject(value) && !Array.isArray(value)) {
    return overlapCast(value);
  }
  return {};
}

async function presentLocal(
  bearerToken: string,
  userCode: string,
): Promise<DropTransportPresented> {
  try {
    return await presentLocalDropClaim(bearerToken, userCode);
  } catch (error) {
    if (!(error instanceof LocalDropClaimError)) throw error;
    if (error.code === "unreachable") {
      throw new DropTransportError("unreachable", error.message);
    }
    const refused = dropRefusal(error.wire, 401, error.message);
    throw new DropTransportError(
      refused.code,
      refused.words,
      error.attemptsLeft,
    );
  }
}

function portableFailureCode(code: string): DropTransportErrorCode | null {
  switch (code) {
    case "invalid_token":
    case "tampered":
    case "expired":
    case "locked_out":
    case "invalid_code":
      return code;
    default:
      return null;
  }
}

/** An object's own fields; anything else has none. */
function ownFields(value: BoundaryValue): BoundaryObject | null {
  if (value === null || !isTypeofObject(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

/** Map a portable opener failure without a static import of that module. */
function rethrowPortableFailure(error: Error): void {
  if (error.name !== "PortableDropFailure") return;
  const fields = ownFields(error);
  if (fields === null || !isString(fields.code)) return;
  const code = portableFailureCode(fields.code);
  if (code === null) return;
  const attemptsLeft = isNumber(fields.attemptsLeft)
    ? fields.attemptsLeft
    : undefined;
  throw new DropTransportError(code, error.message, attemptsLeft);
}

async function presentClaimDefault(
  bearerToken: string,
  userCode: string,
  pkt?: string,
): Promise<DropTransportPresented> {
  if (isPortableDropToken(bearerToken) || pkt !== undefined) {
    try {
      const { openPortableDropBundle } = await import(
        "../vault/portable-drop.js"
      );
      const targetManifest = await openPortableDropBundle(
        pkt ?? "",
        bearerToken,
        userCode,
      );
      return { targetManifest };
    } catch (error) {
      if (error instanceof Error) rethrowPortableFailure(error);
      throw error;
    }
  }
  if (
    isDeviceIdentityMode() &&
    !isRemoteIdentityConfigured() &&
    isClaimToken(bearerToken)
  ) {
    return presentLocal(bearerToken, userCode);
  }
  let res: Response;
  try {
    res = await identityFetch("/v1/claims/present", {
      method: "POST",
      body: JSON.stringify({ token: bearerToken, userCode }),
    });
  } catch {
    throw new DropTransportError(
      "unreachable",
      `The Identity plane at ${identityBase()} could not be reached.`,
    );
  }
  if (!res.ok) {
    // The body's code says why, in the one wording every surface that opens
    // a drop shares (ceremony-kit); a wrong code must read as "try again".
    const detail = obj(await res.json().catch(() => null));
    const refused = dropRefusal(
      isString(detail.error) ? detail.error : "",
      res.status,
      isString(detail.hint) ? detail.hint : null,
    );
    throw new DropTransportError(
      refused.code,
      refused.words,
      isNumber(detail.attemptsLeft) ? detail.attemptsLeft : undefined,
    );
  }
  const body = obj(await res.json());
  const manifest = body.targetManifest;
  if (!isTypeofObject(manifest) || Array.isArray(manifest)) {
    throw new DropTransportError(
      "refused",
      "The Identity plane did not return a sealed drop manifest.",
    );
  }
  return { targetManifest: overlapCast(manifest) };
}

/** The one presentation step of opening; a test substitutes it. */
export const dropOpenSeams = { presentClaim: presentClaimDefault };

function dropPresentFailedForGood(error: DropError): boolean {
  return error.code !== "invalid_code" && error.code !== "unreachable";
}

/** Open a drop's sealed manifest with its bearer, code and optional packet. */
export async function presentDrop(
  bearerToken: string,
  userCode: string,
  pkt?: string,
): Promise<PresentedDrop> {
  const claimId = claimIdFromBearer(bearerToken);
  try {
    const presented =
      pkt === undefined
        ? await dropOpenSeams.presentClaim(bearerToken, userCode)
        : await dropOpenSeams.presentClaim(bearerToken, userCode, pkt);
    if (claimId) noteOutboundDropConsumed(claimId);
    if (claimId) noteDropOpened(claimId);
    return { targetManifest: guardManifest(presented.targetManifest) };
  } catch (error) {
    if (claimId) {
      const mapped =
        error instanceof DropError
          ? error
          : error instanceof DropTransportError
            ? mapTransportError(error)
            : null;
      if (mapped && dropPresentFailedForGood(mapped)) noteDropRefused(claimId);
    }
    throw mapTransportError(
      error instanceof Error ? error : new Error("drop claim present failed"),
    );
  }
}
