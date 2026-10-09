import { endpointBelongsToIssuer } from "./federation-endpoint-origin.js";
import { FederationError } from "./federation-error.js";
import type { PendingAuth } from "./federation-pending.js";

/**
 * Compiled broker fields this module is allowed to prefer over a pending
 * record. Structural on purpose: the catalog stays in `federation.ts`.
 */
type CompiledUpstream = {
  issuer: string;
  tokenEndpoint?: string;
  jwksUri?: string;
  sessionCheckEndpoint?: string | undefined;
};

export type PinnedEndpoints = {
  tokenEndpoint: string;
  jwksUri: string;
  sessionCheckEndpoint: string | undefined;
};

function trimSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Compiled brokers match with or without a trailing slash. A pending record
 * is shared storage, so lookup here must not miss Shoo because of punctuation.
 */
function compiledUpstream(
  issuer: string,
  upstreams: readonly CompiledUpstream[],
): CompiledUpstream | undefined {
  const trimmed = trimSlashes(issuer);
  return upstreams.find((upstream) => trimSlashes(upstream.issuer) === trimmed);
}

export { endpointBelongsToIssuer } from "./federation-endpoint-origin.js";

function refuseForeignEndpoint(kind: string): never {
  throw new FederationError("untrusted_issuer", `${kind} is not the issuer.`);
}

function pinStoredUrl(
  kind: string,
  stored: string,
  issuer: string,
  compiled: string | undefined,
): string {
  if (compiled) return compiled;
  if (!endpointBelongsToIssuer(stored, issuer)) refuseForeignEndpoint(kind);
  return stored;
}

/**
 * Where the authorization code and PKCE verifier may be posted, and which
 * JWKS may be saved with the session.
 *
 * A compiled issuer's endpoints win over the pending record. Shared origin
 * storage can rewrite that record, and the code is not in storage until this
 * POST. An operator or org issuer has no compiled endpoint, so the stored URL
 * is accepted only when its origin is the issuer origin. The session check is
 * the compiled URL only: the pending record must not choose where the id
 * token is presented.
 */
export function resolvePinnedEndpoints(
  pending: PendingAuth,
  upstreams: readonly CompiledUpstream[],
): PinnedEndpoints {
  const compiled = compiledUpstream(pending.issuer, upstreams);
  return {
    tokenEndpoint: pinStoredUrl(
      "Token endpoint",
      pending.tokenEndpoint,
      pending.issuer,
      compiled?.tokenEndpoint,
    ),
    jwksUri: pinStoredUrl(
      "JWKS",
      pending.jwksUri,
      pending.issuer,
      compiled?.jwksUri,
    ),
    sessionCheckEndpoint: compiled?.sessionCheckEndpoint,
  };
}
