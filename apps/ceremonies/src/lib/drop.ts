import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
/**
 * Secret drop acceptance (ADR 0062) — the recipient side.
 *
 * A drop link is `/claim#token=osc_clm_…&key=…`: the claim bearer and the
 * drop key both ride the fragment, so neither reaches a server log. The
 * recipient enters the user code (the out-of-band second factor), the page
 * presents `{token, userCode}` — the code is verified server-side before the
 * single-use CAS — and the present response, the only projection that carries
 * it, returns the sealed manifest. Decryption happens here, with the
 * fragment key, and the reveal exists only in memory.
 *
 * The drop format itself — the AES-GCM + SHA-256 layout, the manifest guard,
 * the decryption — is `@opensesame/vault-core`'s, the same code the vault
 * seals with; this page adds only the fragment and the presentation.
 */

import {
  type DropRefusalCode,
  dropRefusal,
  readClaimLink,
} from "@opensesame/ceremony-kit";
import {
  DropFormatError,
  type DropManifest,
  type DropPayload,
  guardManifest,
  openDrop as openDropFormat,
} from "@opensesame/vault-core";
import { issuer } from "./issuer.js";

export type {
  DropFilePayload,
  DropPayload,
  DropTextPayload,
} from "@opensesame/vault-core";

export type DropAcceptanceErrorCode = DropRefusalCode | "tampered";

export class DropAcceptanceError extends Error {
  constructor(
    readonly code: DropAcceptanceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DropAcceptanceError";
  }
}

/**
 * The drop fragment carries token *and* key; a bare token is a normal claim.
 * The dispatch is ceremony-kit's `readClaimLink`, the one Pages makes too.
 */
export function readDropFragment(
  hash: string,
): { token: string; key: string } | null {
  const link = readClaimLink(hash);
  return link?.kind === "drop" ? { token: link.token, key: link.key } : null;
}

/* -------------------------------------------------------------- opening */

/** The format's refusal, in this page's terms: unreadable, or altered. */
function asAcceptanceError(error: Error): never {
  if (!(error instanceof DropFormatError)) throw error;
  throw new DropAcceptanceError(
    error.code === "tampered" ? "tampered" : "invalid",
    error.message,
  );
}

/** Guard the server-returned manifest before anything is decoded from it. */
export function guardDropManifest(value: BoundaryValue): DropManifest {
  try {
    return guardManifest(value);
  } catch (error) {
    if (error instanceof Error) asAcceptanceError(error);
    throw error;
  }
}

/** Decrypt and digest-verify a presented drop manifest. */
export function openDrop(
  value: BoundaryValue,
  fragmentKey: string,
): Promise<DropPayload> {
  return openDropFormat(value, fragmentKey).catch(asAcceptanceError);
}

function obj(value: BoundaryValue): JsonObject {
  return isJsonObject(value) ? value : {};
}

async function fetchFnDefault(
  url: string,
  init: RequestInit,
): Promise<Response> {
  return fetch(url, init);
}

export const dropSeams = {
  fetchFn: fetchFnDefault,
};

/**
 * Present the claim with its user code and return the sealed manifest. The
 * code is verified server-side before the single-use transition, so a wrong
 * code does not burn the drop — but a successful present does, exactly once.
 */
export async function presentDrop(
  token: string,
  userCode: string,
): Promise<BoundaryValue> {
  let res: Response;
  try {
    res = await dropSeams.fetchFn(`${issuer}/v1/claims/present`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ token, userCode }),
    });
  } catch {
    throw new DropAcceptanceError(
      "unreachable",
      "The Identity API is not reachable from here.",
    );
  }
  const body: BoundaryValue = await res.json().catch(() => null);
  if (!res.ok) {
    // One wording for every surface that opens a drop: ceremony-kit's.
    const code = obj(body).error;
    const refused = dropRefusal(isString(code) ? code : "", res.status);
    throw new DropAcceptanceError(refused.code, refused.words);
  }
  if (!isJsonObject(body) || body.targetManifest === undefined) {
    throw new DropAcceptanceError(
      "invalid",
      "The drop's payload was missing from the answer.",
    );
  }
  return body.targetManifest;
}
