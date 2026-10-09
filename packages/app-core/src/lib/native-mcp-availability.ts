/** Configuration is offered only for a complete compiled public-browser MCP route. */
import type { McpInfo } from "./connect-plan.js";
import { nativeBrowserMcpPolicy } from "./native-browser-policy.js";
import { validateNativeMcpOAuthTarget } from "./native-mcp-oauth-target.js";
import { nativeMcpProviderMetadata } from "./native-mcp-profile.js";

function missingPublicRoute(metadata: McpInfo): string | null {
  if (metadata.status !== "ok")
    return "This MCP provider has not published complete authorization metadata for a public browser connection.";
  if (!metadata.tokenAuthMethods.includes("none"))
    return "This MCP authorization server does not advertise public clients without a client secret.";
  if (!metadata.pkce.includes("S256"))
    return "This MCP authorization server does not advertise S256 PKCE for browser consent.";
  if (
    !metadata.resource ||
    !metadata.resourceMetadata ||
    !metadata.discoveryUrl
  )
    return "This MCP provider has not published the complete resource and authorization discovery endpoints required for a browser connection.";
  if (metadata.registration === "dcr" && !metadata.registrationEndpoint)
    return "This MCP provider has not published a public client registration endpoint.";
  return null;
}

function validatePublicMetadata(
  providerId: string,
  metadata: Extract<McpInfo, { status: "ok" }>,
): void {
  validateNativeMcpOAuthTarget({
    binding: {
      providerId,
      fingerprint: "compiled-public-route",
      endpoint: metadata.url,
      resource: metadata.resource ?? metadata.url,
      issuer: metadata.issuer,
      transport: new URL(metadata.url).pathname.endsWith("/sse")
        ? "sse"
        : "streamable-http",
    },
    metadata,
    redirectUri: "https://self-host.example/auth/native-connector.html",
    registration: metadata.registration,
    clientId:
      metadata.registration === "manual" ? "operator-public-client" : undefined,
    clientMetadataUrl:
      metadata.registration === "cimd"
        ? "https://self-host.example/auth/native-client.json"
        : undefined,
    scopes: [],
  });
}

export function nativeMcpMetadataUnavailableReason(
  providerId: string,
  metadata: McpInfo,
): string | null {
  const reason = missingPublicRoute(metadata);
  if (reason) return reason;
  if (metadata.status !== "ok")
    return "This MCP provider has no public browser authorization contract.";
  try {
    validatePublicMetadata(providerId, metadata);
    return null;
  } catch {
    return "This provider has no complete, admitted public browser MCP endpoint contract in this deployment.";
  }
}

export function nativeMcpCompiledUnavailableReason(
  providerId: string,
): string | null {
  try {
    return nativeMcpMetadataUnavailableReason(
      providerId,
      nativeMcpProviderMetadata(providerId),
    );
  } catch {
    return "This provider has no complete, admitted public browser MCP endpoint contract in this deployment.";
  }
}

/** Compiled support remains available for revocation after browser admission changes. */
export function supportsCompiledNativeMcpProvider(providerId: string): boolean {
  return nativeMcpCompiledUnavailableReason(providerId) === null;
}

export function nativeMcpUnavailableReason(providerId: string): string | null {
  return (
    nativeMcpCompiledUnavailableReason(providerId) ??
    nativeBrowserMcpPolicy(providerId).reason
  );
}
