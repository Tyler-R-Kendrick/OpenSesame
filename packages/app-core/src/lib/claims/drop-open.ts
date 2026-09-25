/**
 * Opening a drop — the recipient's side (ADR 0062; ADR 0140 D2).
 *
 * A drop link (`/claim#token=…&key=…`) opens on every installation: the
 * `/claim` route is the always-on `identity.ceremonies`, and so is this.
 * Sending a drop — sealing, creating and polling the claim session, the
 * vault's drop records — stays in the optional `sharing.drops`
 * (`vault/drop.ts`, `vault/drop-transport.ts`), which builds on the errors
 * defined here.
 *
 * Opening is two steps: present the bearer with the user code the sender
 * shared out of band (`POST /v1/claims/present`, single-use on the server),
 * then decrypt the returned manifest under the key the link carried. The key
 * never leaves this function's caller: it is not sent, stored or logged.
 */

import { type DropRefusalCode, dropRefusal } from "@opensesame/ceremony-kit";
import {
  type BoundaryValue,
  type JsonObject,
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
import { identityBase, identityFetch } from "../identity.js";

/**
 * What went wrong on the claim plane. Creating and polling a drop fail as
 * `refused`; opening one says why, in ceremony-kit's recipient terms
 * (`DropRefusalCode`): a wrong code, already opened, expired, or a link that
 * is not valid.
 */
export type DropTransportErrorCode =
  | DropRefusalCode
  | "refused"
  | "limit_exceeded"
  | "corrupt";

export class DropTransportError extends Error {
  readonly code: DropTransportErrorCode;
  constructor(code: DropTransportErrorCode, message: string) {
    super(message);
    this.name = "DropTransportError";
    this.code = code;
  }
}

/**
 * Sealing and opening refusals from the format (`payload_too_large` …
 * `tampered`), and the transport's.
 */
export type DropErrorCode =
  | "payload_too_large"
  | "invalid_manifest"
  | "invalid_key"
  | "tampered"
  | DropTransportErrorCode;

export class DropError extends Error {
  constructor(
    readonly code: DropErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DropError";
  }
}

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
    return new DropError(error.code, error.message);
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

async function presentClaimDefault(
  bearerToken: string,
  userCode: string,
): Promise<DropTransportPresented> {
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
    throw new DropTransportError(refused.code, refused.words);
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

/** The one network step of opening; a test substitutes it. */
export const dropOpenSeams = { presentClaim: presentClaimDefault };

/** Open a drop once — user code + bearer; returns the sealed manifest. */
export async function presentDrop(
  bearerToken: string,
  userCode: string,
): Promise<PresentedDrop> {
  try {
    const presented = await dropOpenSeams.presentClaim(bearerToken, userCode);
    return { targetManifest: guardManifest(presented.targetManifest) };
  } catch (error) {
    throw mapTransportError(
      error instanceof Error ? error : new Error("drop claim present failed"),
    );
  }
}
