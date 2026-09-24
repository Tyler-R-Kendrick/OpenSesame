import type { ControlPlaneConfig } from "../config.js";
import { normalizeIssuer } from "../interactions/registry.js";
import {
  UnsafeUpstreamError,
  assertPublicUpstreamUrl,
} from "../services/guarded-fetch.js";

/**
 * Whether `value` names this deployment itself.
 *
 * Identities this server minted for everybody carry its own issuer. An
 * organization that could claim it as its `ssoIssuer`/`samlIssuer` would have
 * SCIM and back-channel deprovisioning reach principals of every tenant, so
 * the claim is refused outright, dev defaults or not.
 */
function isDeploymentIssuer(
  config: ControlPlaneConfig,
  value: string,
): boolean {
  const claimed = normalizeIssuer(value).toLowerCase();
  return [config.issuer, config.publicUrl].some(
    (own) => normalizeIssuer(own).toLowerCase() === claimed,
  );
}

/**
 * Refuse an issuer this deployment must not dereference or defer to (T21).
 *
 * The submitted value ends up as a server-side discovery fetch, so an owner
 * who could point it at `169.254.169.254` would have turned the org surface
 * into an SSRF gadget. Loopback stays reachable under dev defaults because
 * that is where the reference IdP and the local Keycloak run. The fetch
 * itself is also DNS-fenced (`guardedFetch`); this is the early, literal
 * refusal an owner sees when they save.
 */
export function issuerConfigurationError(
  config: ControlPlaneConfig,
  value: string | null | undefined,
): string | undefined {
  if (!value) return undefined;
  if (isDeploymentIssuer(config, value)) {
    return "An organization cannot claim this deployment's own issuer.";
  }
  if (config.allowDevDefaults) return undefined;
  try {
    assertPublicUpstreamUrl(value);
    return undefined;
  } catch (error) {
    if (error instanceof UnsafeUpstreamError) return error.message;
    throw error;
  }
}
