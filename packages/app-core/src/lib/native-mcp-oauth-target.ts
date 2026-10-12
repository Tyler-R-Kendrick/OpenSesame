/** Vetted OAuth endpoints remain separate from the MCP resource bearer target. */
import type { McpInfo } from "./connect-plan.js";
import {
  type NativeMcpBinding,
  nativeMcpUrl,
  validateNativeMcpBinding,
} from "./native-mcp-target.js";

export class NativeMcpAuthError extends Error {
  readonly name = "NativeMcpAuthError";
  constructor(
    readonly code:
      | "public-client"
      | "metadata"
      | "pending"
      | "authorization"
      | "storage",
    readonly oauthError?: "invalid_grant" | "invalid_client",
  ) {
    const messages = {
      "public-client":
        "This MCP provider has no verified public browser authorization route for this configuration. Check its public-client documentation.",
      metadata:
        "The MCP authorization metadata does not match the selected provider.",
      pending:
        "This authorization callback expired or belongs to another connector. Authorize again.",
      authorization:
        "The MCP provider did not complete public browser authorization.",
      storage:
        "The new authorization could not be sealed. Cleanup is required before continuing.",
    };
    super(messages[code]);
  }
}

export type NativeMcpOAuthTarget = {
  binding: NativeMcpBinding;
  metadata: Extract<McpInfo, { status: "ok" }>;
  redirectUri: string;
  registration: "manual" | "dcr" | "cimd";
  /** Public client IDs are provided by a real registration or HTTPS CIMD document. */
  clientId?: string;
  clientMetadataUrl?: string;
  scopes: readonly string[];
};

function assertPublishedPublicRoute(target: NativeMcpOAuthTarget): void {
  const { metadata, binding } = target;
  if (
    !binding.issuer ||
    metadata.issuer !== binding.issuer ||
    metadata.resource !== binding.resource ||
    !metadata.resourceMetadata ||
    !metadata.discoveryUrl ||
    !metadata.pkce.includes("S256") ||
    !metadata.tokenAuthMethods.includes("none")
  )
    throw new NativeMcpAuthError("public-client");
  for (const endpoint of [
    metadata.authorizationEndpoint,
    metadata.tokenEndpoint,
    metadata.resourceMetadata,
    metadata.discoveryUrl,
  ])
    nativeMcpUrl(endpoint);
}

function assertRegistrationTarget(target: NativeMcpOAuthTarget): void {
  const { metadata } = target;
  if (target.registration === "dcr" && !metadata.registrationEndpoint)
    throw new NativeMcpAuthError("public-client");
  if (target.registration === "manual" && !target.clientId)
    throw new NativeMcpAuthError("public-client");
  if (target.registration === "cimd") {
    if (metadata.registration !== "cimd" || !target.clientMetadataUrl)
      throw new NativeMcpAuthError("public-client");
    if (nativeMcpUrl(target.clientMetadataUrl).pathname === "/")
      throw new NativeMcpAuthError("public-client");
  }
}

function assertRedirect(redirectUri: string): void {
  const redirect = new URL(redirectUri);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    redirect.hostname,
  );
  if (
    (redirect.protocol !== "https:" &&
      !(redirect.protocol === "http:" && loopback)) ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  )
    throw new NativeMcpAuthError("public-client");
}

export function validateNativeMcpOAuthTarget(
  target: NativeMcpOAuthTarget,
): void {
  validateNativeMcpBinding(target.binding);
  assertPublishedPublicRoute(target);
  assertRegistrationTarget(target);
  assertRedirect(target.redirectUri);
  if (target.scopes.some((scope) => !target.metadata.scopes.includes(scope)))
    throw new NativeMcpAuthError("public-client");
}
