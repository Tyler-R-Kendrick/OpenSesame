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

/** The tenant claim fence also applies to native, non-dereferenced entityIDs. */
export function issuerClaimConfigurationError(
  config: ControlPlaneConfig,
  value: string | null | undefined,
): string | undefined {
  return value && isDeploymentIssuer(config, value)
    ? "An organization cannot claim this deployment's own issuer."
    : undefined;
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
  const claimError = issuerClaimConfigurationError(config, value);
  if (claimError) return claimError;
  if (config.allowDevDefaults) return undefined;
  try {
    assertPublicUpstreamUrl(value);
    return undefined;
  } catch (error) {
    if (error instanceof UnsafeUpstreamError) return error.message;
    throw error;
  }
}

/** Validate the merged native metadata or legacy OIDC-broker configuration. */
export function samlConfigurationError(
  config: ControlPlaneConfig,
  upstream: {
    issuer: string | undefined;
    metadataUrl: string | undefined;
    metadataXml: string | undefined;
  },
):
  | { error: "validation_error" | "unsafe_issuer"; message: string }
  | undefined {
  if (upstream.metadataUrl && upstream.metadataXml) {
    return {
      error: "validation_error",
      message: "samlMetadataUrl and samlMetadataXml are mutually exclusive",
    };
  }
  const native = Boolean(upstream.metadataUrl || upstream.metadataXml);
  if (!native && upstream.issuer?.toLowerCase().startsWith("urn:")) {
    return {
      error: "validation_error",
      message:
        "A SAML entity URN requires IdP metadata. Legacy SAML brokers must use an http(s) issuer.",
    };
  }
  const unsafe =
    (native
      ? issuerClaimConfigurationError(config, upstream.issuer)
      : issuerConfigurationError(config, upstream.issuer)) ??
    issuerConfigurationError(config, upstream.metadataUrl);
  return unsafe ? { error: "unsafe_issuer", message: unsafe } : undefined;
}
