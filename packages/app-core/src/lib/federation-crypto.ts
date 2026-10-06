import type { JsonObject } from "@opensesame/os-domain";
import {
  decodeJwtEnvelope,
  randomString,
  sha256Base64Url,
} from "@opensesame/sdk-browser";
import { FederationError } from "./federation-error.js";

export function decodeJwtClaims(token: string): JsonObject {
  const payload = token.split(".")[1];
  if (!payload) throw new FederationError("invalid_token", "Not a JWT.");
  try {
    return decodeJwtEnvelope(token).claims;
  } catch {
    throw new FederationError("invalid_token", "Token payload is not JSON.");
  }
}

/**
 * The subject a relying party at `origin` derives for itself, per
 * docs/architecture/federated-signin.md §3. Computed the same way here only so
 * the consent screen can show what an origin will learn.
 */
export async function derivedSubjectFor(
  pairwiseSub: string,
  origin: string,
): Promise<string> {
  return sha256Base64Url(`${pairwiseSub}:${origin}`);
}

type Pkce = { verifier: string; challenge: string };

export async function createPkce(): Promise<Pkce> {
  const verifier = randomString(32);
  return { verifier, challenge: await sha256Base64Url(verifier) };
}
