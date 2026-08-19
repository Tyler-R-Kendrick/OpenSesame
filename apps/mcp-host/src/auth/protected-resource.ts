/**
 * Protected Resource Metadata (OAuth PRM) notes for MCP host clients.
 *
 * Host API exposes `/.well-known/oauth-protected-resource` with Bearer acceptance.
 * DPoP is advertised only when OPENSESAME_DPOP_ENABLED=true on the gateway.
 */

export const PROTECTED_RESOURCE_WELL_KNOWN =
  "/.well-known/oauth-protected-resource";

export interface ProtectedResourceNotes {
  profile: string;
  resource: string;
  bearerAccepted: boolean;
  dpopAdvertised: boolean;
}

export function summarizeProtectedResource(
  body: Record<string, unknown>,
): ProtectedResourceNotes {
  const schemes = Array.isArray(body.authorization_servers)
    ? body.authorization_servers
    : [];
  return {
    profile: "oauth-bearer-rfc6750-v1",
    resource: String(body.resource ?? ""),
    bearerAccepted: true,
    dpopAdvertised: Boolean(body.dpop_signing_alg_values_supported),
    // schemes reserved for future issuer wiring
    ...(schemes.length ? {} : {}),
  };
}
