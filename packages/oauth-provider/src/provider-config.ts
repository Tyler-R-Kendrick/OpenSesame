import { type BoundaryValue, overlapCast } from "@opensesame/os-domain";
import type { OpenSesameProviderBundle } from "./create-provider.js";

/** Bound all metadata purposes supported by the pinned oidc-provider. */
export const METADATA_FETCH_LIMITS = {
  fetchResponseBodyLimits: {
    "client_id metadata document": 5 * 1024,
    jwks_uri: 64 * 1024,
    sector_identifier_uri: 64 * 1024,
  },
};

export function isPkceRequired(
  bundle: OpenSesameProviderBundle,
  ctx: BoundaryValue = {},
  client: BoundaryValue = {},
): boolean {
  const required = bundle.configuration.pkce?.required;
  if (!required) return false;
  return required(overlapCast(ctx), client);
}
